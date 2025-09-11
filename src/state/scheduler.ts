import { setCardDueFlexible, getCardDue, allCards } from '../data/cardStore';
import { getSchedulerConfig, PresetName, setSchedulerConfig } from './schedulerConfig';
import { getChildrenOf } from '../decks';

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export type StudyState = 'new' | 'learning' | 'relearning' | 'graduated';

type Meta = {
  state: StudyState;
  ease: number;            // ease factor (2.3 default)
  stability: number;       // rough memory stability (days)
  intervalMin: number;     // last scheduled interval in minutes
  reps: number;            // total reviews
  lapses: number;          // total lapses ('again' on graduated)
  last?: Grade;            // last grade
  reviewedAtISO?: string;  // last review timestamp
  dueISO?: string;         // cached last due (derived)
};

type Store = Record<string, Meta>;

const KEY = 'chessflashcards.scheduler.v2';
const LOG_KEY = 'chessflashcards.reviewLog.v1';

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Store : {};
  } catch {
    return {};
  }
}

function save(s: Store) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

type ReviewLogEntry = {
  id: string;
  grade: Grade;
  ts: number;
  deck?: string;
  prevInt?: number; // minutes
  newInt?: number;  // minutes
  wasNew?: boolean;
  newDueISO?: string;
  durationMs?: number;
  state?: StudyState;
  ease?: number;
  stabilityDays?: number;
};
function appendLog(e: ReviewLogEntry) {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const arr: ReviewLogEntry[] = raw ? (JSON.parse(raw) || []) : [];
    arr.push(e);
    localStorage.setItem(LOG_KEY, JSON.stringify(arr));
  } catch {}
}

export function getMeta(cardId: string): Meta | undefined {
  const s = load();
  return s[cardId];
}

export function setMeta(cardId: string, meta: Meta | undefined): void {
  const s = load();
  if (meta) s[cardId] = meta; else delete s[cardId];
  save(s);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function toISOFromNow(mins: number): string {
  const t = Date.now() + Math.round(mins * 60_000);
  return new Date(t).toISOString();
}

function minutesToDays(m: number): number { return m / (60 * 24); }
function daysToMinutes(d: number): number { return d * 60 * 24; }

// --- FSRS-like scheduling core ---
function seedMeta(): Meta {
  const cfg = getSchedulerConfig();
  return {
    state: 'new',
    ease: cfg.initialEase,
    stability: cfg.initialStabilityDays,
    intervalMin: 0,
    reps: 0,
    lapses: 0,
  };
}

function applyEarlyLateAdjust(baseDays: number, scheduledISO?: string): number {
  const cfg = getSchedulerConfig();
  if (!scheduledISO) return baseDays;
  const sched = Date.parse(scheduledISO);
  if (!Number.isFinite(sched)) return baseDays;
  const now = Date.now();
  const deltaMin = Math.round((now - sched) / 60_000); // negative if early
  const tol = cfg.tolerantWindowMins;
  if (Math.abs(deltaMin) <= tol) return baseDays; // no penalty within window
  if (deltaMin < -tol) {
    // Early review: shrink interval proportionally
    const earlyRatio = clamp(1 + deltaMin / (cfg.earlyTargetMins || 1440), 0.1, 1);
    return baseDays * (cfg.earlyReviewFactor * earlyRatio);
  }
  // Late review: adjust ease/stability by lateness; here scale interval modestly
  const lateDays = deltaMin / (60 * 24);
  const penalty = 1 + Math.min(lateDays, cfg.maxLateDaysPenalty) * cfg.lateReviewSlope;
  return baseDays * penalty;
}

function nextAfterLearning(meta: Meta, grade: Grade): { days: number; ease: number; stability: number } {
  const cfg = getSchedulerConfig();
  const g = grade;
  let ease = clamp(meta.ease + (g === 'again' ? cfg.easeDelta.again : g === 'hard' ? cfg.easeDelta.hard : g === 'easy' ? cfg.easeDelta.easy : cfg.easeDelta.good), cfg.minEase, cfg.maxEase);
  // Graduating step uses configured multipliers
  let baseDays: number;
  if (meta.state === 'new' || meta.state === 'learning' || meta.state === 'relearning') {
    if (g === 'again') {
      baseDays = cfg.learningStepsMins[0] / (60 * 24); // back to first step (~minutes)
    } else if (g === 'hard') {
      baseDays = cfg.learningStepsMins[0] / (60 * 24);
    } else if (g === 'good') {
      baseDays = cfg.graduateGoodDays;
    } else { // easy
      baseDays = cfg.graduateEasyDays;
    }
  } else {
    // Graduated: FSRS-like growth
    const prev = Math.max(0.1, minutesToDays(meta.intervalMin));
    const mult = (g === 'again') ? cfg.againMultiplier : (g === 'hard') ? cfg.hardMultiplier : (g === 'good') ? cfg.goodMultiplier : cfg.easyMultiplier;
    baseDays = prev * mult * (ease / cfg.initialEase);
  }
  // Stability heuristic: grow with correct answers, shrink on lapses
  let stability = meta.stability;
  if (g === 'again') stability = Math.max(cfg.minStabilityDays, stability * cfg.lapseStabilityDecay);
  else stability = Math.min(cfg.maxStabilityDays, stability * (1 + cfg.stabilityGrowth));
  return { days: baseDays, ease, stability };
}

export function schedule(
  cardId: string,
  grade: Grade,
  opts?: { durationMs?: number }
): { prevMeta: Meta | undefined; newMeta: Meta; prevDue: string | 'new' | undefined; newDue: string } {
  const prevMeta = getMeta(cardId) || seedMeta();
  const prevDue = getCardDue(cardId);
  const cfg = getSchedulerConfig();

  // Determine next state and base interval
  let nextState: StudyState = prevMeta.state;
  if (prevMeta.state === 'new' || prevMeta.state === 'learning') {
    if (grade === 'again') nextState = 'learning';
    else if (grade === 'hard') nextState = 'learning';
    else nextState = 'graduated'; // good/easy graduate
  } else if (prevMeta.state === 'graduated') {
    if (grade === 'again') nextState = 'relearning'; else nextState = 'graduated';
  } else if (prevMeta.state === 'relearning') {
    if (grade === 'again') nextState = 'relearning'; else if (grade === 'hard') nextState = 'learning'; else nextState = 'graduated';
  }

  const { days: rawDays, ease, stability } = nextAfterLearning(prevMeta, grade);
  const adjustedDays = applyEarlyLateAdjust(rawDays, prevMeta.dueISO);
  const intervalMin = Math.max(cfg.minIntervalMin, Math.round(daysToMinutes(adjustedDays) * cfg.intervalMultiplier));
  const dueISO = toISOFromNow(intervalMin);

  const reviewedAtISO = new Date().toISOString();
  const reps = (prevMeta.reps ?? 0) + 1;
  const lapses = (prevMeta.lapses ?? 0) + ((prevMeta.state === 'graduated' && grade === 'again') ? 1 : 0);

  const newMeta: Meta = {
    state: nextState,
    ease,
    stability,
    intervalMin,
    reps,
    lapses,
    last: grade,
    reviewedAtISO,
    dueISO,
  };
  setMeta(cardId, newMeta);
  // Reflect in in-memory cards via overrides so Review queue updates immediately
  setCardDueFlexible(cardId, dueISO);
  // Best-effort persist to cards.json via Electron bridge if available
  try {
    (window as any).cards?.setDue?.(cardId, dueISO).catch(() => {});
  } catch {}
  // Append to review log for stats (extended entry)
  const deckId = (allCards().find(c => c.id === cardId)?.deck) || undefined;
  appendLog({
    id: cardId,
    grade,
    ts: Date.now(),
    deck: deckId,
    prevInt: prevMeta?.intervalMin ?? 0,
    newInt: intervalMin,
    wasNew: prevDue === 'new',
    newDueISO: dueISO,
    durationMs: opts?.durationMs,
    state: newMeta.state,
    ease: newMeta.ease,
    stabilityDays: newMeta.stability,
  });

  return { prevMeta, newMeta, prevDue, newDue: dueISO };
}

/** Restore exact previous meta (for undo). */
export function restore(cardId: string, meta: Meta | undefined, prevDue: string | 'new' | undefined): void {
  setMeta(cardId, meta);
  setCardDueFlexible(cardId, prevDue);
  try {
    (window as any).cards?.setDue?.(cardId, prevDue).catch(() => {});
  } catch {}
}

export type SchedulerMeta = Meta;

// --- Batch tools ---
export function rescheduleCardNow(cardId: string, preset?: PresetName): void {
  if (preset) setSchedulerConfig({ preset });
  const meta = getMeta(cardId) || seedMeta();
  const cfg = getSchedulerConfig();
  // Treat as immediate review with 'good' to seed schedule if new
  const intervalMin = Math.max(cfg.minIntervalMin, Math.round(daysToMinutes(cfg.seedGoodDays) * cfg.intervalMultiplier));
  const dueISO = toISOFromNow(intervalMin);
  const next: Meta = { ...meta, state: 'learning', intervalMin, dueISO, reviewedAtISO: new Date().toISOString(), last: 'good', reps: (meta.reps||0) + 1 };
  setMeta(cardId, next);
  setCardDueFlexible(cardId, dueISO);
}

export function rescheduleCardsInDeck(deckId: string, includeDesc = true): number {
  const ids = new Set<string>([deckId]);
  if (includeDesc) {
    const stack = [deckId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const ch of getChildrenOf(cur)) { if (!ids.has(ch.id)) { ids.add(ch.id); stack.push(ch.id); } }
    }
  }
  const cards = allCards().filter(c => ids.has(c.deck));
  for (const c of cards) rescheduleCardNow(c.id);
  return cards.length;
}
