import { Card } from '../data/types';
import { allCards, getDueCardsForDeck } from '../data/cardStore';
import { getChildrenOf } from '../decks';
import { getMeta } from './scheduler';

export type DeckLimits = {
  new: { enabled: boolean; limit: number };
  mature: { enabled: boolean; limit: number };
  leech: { enabled: boolean; limit: number };
  cumulativeLimit: number;
  matureThresholdDays: number; // interval >= this => mature
  leechIncorrectThreshold: number; // incorrect reviews >= this => leech
};

export type DeckLimitsOverrides = Partial<DeckLimits>;

const DEFAULTS: DeckLimits = {
  new:    { enabled: true, limit: 10 },
  mature: { enabled: true, limit: 100 },
  leech:  { enabled: true, limit: 200 },
  cumulativeLimit: 1000,
  matureThresholdDays: 21,
  leechIncorrectThreshold: 10,
};

const LS_KEY = 'chessflashcards.deckLimits.v1';
const LOG_KEY = 'chessflashcards.reviewLog.v1';

type Store = Record<string, DeckLimitsOverrides>;

function loadLocalStore(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function saveLocalStore(s: Store) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

export function getDeckLimits(deckId?: string | null): DeckLimits {
  if (!deckId) return DEFAULTS;
  const s = loadLocalStore();
  const ov = s[deckId] || {};
  // Deep merge of nested objects with defaults
  return {
    new:    { ...(DEFAULTS.new),    ...(ov.new    || {}) },
    mature: { ...(DEFAULTS.mature), ...(ov.mature || {}) },
    leech:  { ...(DEFAULTS.leech),  ...(ov.leech  || {}) },
    cumulativeLimit: (ov.cumulativeLimit ?? DEFAULTS.cumulativeLimit),
    matureThresholdDays: (ov.matureThresholdDays ?? DEFAULTS.matureThresholdDays),
    leechIncorrectThreshold: (ov.leechIncorrectThreshold ?? DEFAULTS.leechIncorrectThreshold),
  };
}

export function setDeckLimits(deckId: string, patch: DeckLimitsOverrides | null): void {
  const s = loadLocalStore();
  if (!patch) {
    delete s[deckId];
  } else {
    const cur = s[deckId] || {};
    s[deckId] = { ...cur, ...patch };
  }
  saveLocalStore(s);
  // Best-effort persist to deckSettings.json via Electron bridge
  try { (window as any).decks?.setLimits?.(s).catch(() => {}); } catch {}
}

export function copyDeckLimits(fromDeckId: string, toDeckId: string): void {
  const s = loadLocalStore();
  const ov = s[fromDeckId];
  if (!ov) return; // nothing to copy
  s[toDeckId] = { ...ov };
  saveLocalStore(s);
  try { (window as any).decks?.setLimits?.(s).catch(() => {}); } catch {}
}

export function loadDeckLimitsFromFileIfAvailable(): void {
  try {
    const api = (window as any).decks;
    if (!api?.getLimits) return;
    api.getLimits().then((fileStore: Store) => {
      if (!fileStore || typeof fileStore !== 'object') return;
      // Merge fileStore atop local
      const cur = loadLocalStore();
      const merged: Store = { ...cur, ...fileStore };
      saveLocalStore(merged);
    }).catch(() => {});
  } catch {}
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.getTime();
}

function getAncestorsAndSelfIds(deckId: string): Set<string> {
  // Just self + all descendants for filtering review log by deck
  const ids = new Set<string>([deckId]);
  const stack: string[] = [deckId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ch of getChildrenOf(cur)) {
      if (!ids.has(ch.id)) {
        ids.add(ch.id);
        stack.push(ch.id);
      }
    }
  }
  return ids;
}

export type CardType = 'new' | 'mature' | 'leech' | 'young';

function getIncorrectCount(cardId: string): number {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return 0;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const r of arr) {
      if (r && r.id === cardId && r.grade === 'again') n++;
    }
    return n;
  } catch { return 0; }
}

export function classifyCard(c: Card, limits: DeckLimits): CardType {
  // Leech takes precedence
  const incorrect = getIncorrectCount(c.id);
  if (incorrect >= Math.max(1, limits.leechIncorrectThreshold)) return 'leech';
  const due = (c as any).due as string | 'new' | undefined;
  if (due === 'new') return 'new';
  const meta = getMeta(c.id);
  const minPerDay = (meta?.intervalMin ?? 0) / (60 * 24);
  if (minPerDay >= limits.matureThresholdDays) return 'mature';
  return 'young';
}

export type ReviewedTodayCounts = { new: number; mature: number; leech: number; young: number; total: number };

export function getReviewedTodayCounts(deckId: string, limits?: DeckLimits): ReviewedTodayCounts {
  const ids = getAncestorsAndSelfIds(deckId);
  let counts: ReviewedTodayCounts = { new: 0, mature: 0, leech: 0, young: 0, total: 0 };
  const since = startOfToday();
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return counts;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return counts;
    // Build set of cardIds in this deck for faster lookup
    const inDeck = new Set(allCards().filter(c => ids.has(c.deck)).map(c => c.id));
    const lim = limits || getDeckLimits(deckId);
    for (const r of arr) {
      if (!r || typeof r.ts !== 'number' || r.ts < since) continue;
      const cid = r.id;
      if (!inDeck.has(cid)) continue;
      // Classify using current lens; approximation is fine
      const card = allCards().find(cc => cc.id === cid);
      if (!card) continue;
      const t = classifyCard(card, lim);
      if (t === 'new') counts.new++;
      else if (t === 'leech') counts.leech++;
      else if (t === 'mature') counts.mature++;
      else counts.young++;
      counts.total++;
    }
  } catch {}
  return counts;
}

export type QueuePlan = {
  ids: string[];
  byType: { new: number; mature: number; leech: number; young: number };
  remainingByType: { new: number; mature: number; leech: number };
  total: number;
};

export function planQueueForDeck(deckId: string): QueuePlan {
  const due = getDueCardsForDeck(deckId);
  const limits = getDeckLimits(deckId);
  const already = getReviewedTodayCounts(deckId, limits);
  const outIds: string[] = [];
  const byType = { new: 0, mature: 0, leech: 0, young: 0 } as const;
  const included: { new: number; mature: number; leech: number; young: number; total: number } = { new: 0, mature: 0, leech: 0, young: 0, total: 0 };

  const typeLimitLeft = (type: 'new' | 'mature' | 'leech') => {
    const conf = limits[type];
    const used = already[type] + (included as any)[type];
    const left = conf.enabled ? Math.max(0, conf.limit - used) : Number.POSITIVE_INFINITY;
    return left;
  };

  const cumulativeLeft = () => Math.max(0, limits.cumulativeLimit - (already.total + included.total));

  for (const c of due) {
    const t = classifyCard(c, limits);
    // Respect per-type limits if enabled
    let typeAllowed = true;
    if (t === 'new') typeAllowed = typeLimitLeft('new') > 0;
    else if (t === 'leech') typeAllowed = typeLimitLeft('leech') > 0;
    else if (t === 'mature') typeAllowed = typeLimitLeft('mature') > 0; // young is not limited per-type

    if (!typeAllowed) continue;
    if (cumulativeLeft() <= 0) break; // stop entirely if we hit cumulative limit

    outIds.push(c.id);
    (included as any)[t]++;
    included.total++;
  }

  return {
    ids: outIds,
    byType: { new: included.new, mature: included.mature, leech: included.leech, young: included.young },
    remainingByType: {
      new: Math.max(0, limits.new.limit - (limits.new.enabled ? (already.new + included.new) : 0)),
      mature: Math.max(0, limits.mature.limit - (limits.mature.enabled ? (already.mature + included.mature) : 0)),
      leech: Math.max(0, limits.leech.limit - (limits.leech.enabled ? (already.leech + included.leech) : 0)),
    },
    total: outIds.length,
  };
}

export function getDueTypeCounts(deckId: string): { new: number; mature: number; leech: number; young: number; total: number } {
  const due = getDueCardsForDeck(deckId);
  const lim = getDeckLimits(deckId);
  const counts = { new: 0, mature: 0, leech: 0, young: 0, total: 0 };
  for (const c of due) {
    const t = classifyCard(c, lim);
    (counts as any)[t]++;
    counts.total++;
  }
  return counts;
}

export const DeckLimitsDefaults = DEFAULTS;

