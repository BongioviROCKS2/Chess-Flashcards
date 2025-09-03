import { setCardDueFlexible, getCardDue, allCards } from '../data/cardStore';

export type Grade = 'again' | 'hard' | 'good' | 'easy';

type Meta = {
  streak: number;           // consecutive successes (resets on again)
  intervalMin: number;      // last scheduled interval in minutes
  last?: Grade;             // last grade
  reviewedAtISO?: string;   // last review timestamp
  dueISO?: string;          // cached last due (derived)
};

type Store = Record<string, Meta>;

const KEY = 'chessflashcards.scheduler.v1';
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

/**
 * Simple scheduler:
 * - again: 1 minute; streak -> 0
 * - hard: max(10m, prev*1.2) (seed 10m)
 * - good: if new -> 1d; else prev*2.5
 * - easy: if new -> 3d; else prev*3.5
 */
function nextInterval(prev: Meta | undefined, grade: Grade): number {
  const prevMin = Math.max(0, prev?.intervalMin ?? 0);
  switch (grade) {
    case 'again': return 1; // quick retry
    case 'hard':  return Math.max(10, Math.round(prevMin * 1.2) || 10);
    case 'good':  return prevMin > 0 ? Math.round(prevMin * 2.5) : (24 * 60);
    case 'easy':  return prevMin > 0 ? Math.round(prevMin * 3.5) : (3 * 24 * 60);
  }
}

function nextStreak(prev: Meta | undefined, grade: Grade): number {
  if (grade === 'again') return 0;
  const base = prev?.streak ?? 0;
  return clamp(base + (grade === 'hard' ? 0 : 1), 0, 1000);
}

export function schedule(
  cardId: string,
  grade: Grade,
  opts?: { durationMs?: number }
): { prevMeta: Meta | undefined; newMeta: Meta; prevDue: string | 'new' | undefined; newDue: string } {
  const prevMeta = getMeta(cardId);
  const prevDue = getCardDue(cardId);

  const intervalMin = nextInterval(prevMeta, grade);
  const dueISO = toISOFromNow(intervalMin);
  const reviewedAtISO = new Date().toISOString();
  const streak = nextStreak(prevMeta, grade);

  const newMeta: Meta = { streak, intervalMin, last: grade, reviewedAtISO, dueISO };
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
