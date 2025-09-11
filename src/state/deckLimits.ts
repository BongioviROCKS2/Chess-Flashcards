import { Card } from '../data/types';
import { allCards, getDueCardsForDeck, getCardDue } from '../data/cardStore';
import { getChildrenOf } from '../decks';
import { getMeta } from './scheduler';
import { getSchedulingPrefs } from './schedulingPrefs';

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
  const prefs = getSchedulingPrefs();

  // Utility: classify and helpers
  const dueTime = (cid: string): number => {
    const d = getCardDue(cid) as string | 'new' | undefined;
    if (!d || d === 'new') return Number.POSITIVE_INFINITY; // 'new' has no due time
    const t = Date.parse(d);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const parentIntervalMin = (cid: string): number => {
    const map = new Map(allCards().map(c => [c.id, c]));
    const c = map.get(cid);
    const p = c?.fields.parent;
    if (!p) return 0;
    const m = getMeta(p);
    return Math.max(0, m?.intervalMin ?? 0);
  };
  const createdAtMs = (c: typeof due[number]): number => {
    try {
      const iso = (c?.fields?.creationCriteria?.createdAt) as string | undefined;
      const t = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(t) ? t : 0;
    } catch { return 0; }
  };

  // Partition due into new vs review
  const dueNew = due.filter(c => classifyCard(c, limits) === 'new');
  const dueReview = due.filter(c => classifyCard(c, limits) !== 'new');

  // Sort new cards based on prefs
  let newSorted = [...dueNew];
  if (prefs.newPick === 'random') {
    newSorted.sort(() => Math.random() - 0.5);
  } else if (prefs.newPick === 'newest-created-first') {
    newSorted.sort((a, b) => {
      const d = createdAtMs(b) - createdAtMs(a); // newest first
      if (d !== 0) return d;
      if (prefs.groupByDeck && a.deck !== b.deck) return a.deck.localeCompare(b.deck);
      return a.id.localeCompare(b.id);
    });
  } else /* parent-longest-interval */ {
    newSorted.sort((a, b) => {
      const ai = parentIntervalMin(a.id);
      const bi = parentIntervalMin(b.id);
      const cmp = bi - ai; // longest first
      if (cmp !== 0) return cmp;
      if (prefs.groupByDeck && a.deck !== b.deck) return a.deck.localeCompare(b.deck);
      const ad = a.fields.depth ?? 0;
      const bd = b.fields.depth ?? 0;
      if (ad !== bd) return ad - bd;
      return a.id.localeCompare(b.id);
    });
  }

  // Sort review cards based on prefs
  let reviewSorted: typeof dueReview = [];
  if (prefs.reviewOrder === 'due-date') {
    if (prefs.groupByDeck) {
      // Group by deck, then sort within by due date
      const deckMap = new Map<string, typeof dueReview>();
      for (const c of dueReview) {
        const arr = deckMap.get(c.deck) || [];
        arr.push(c);
        deckMap.set(c.deck, arr);
      }
      const decks = [...deckMap.keys()].sort((a, b) => a.localeCompare(b));
      for (const d of decks) {
        const arr = deckMap.get(d)!;
        arr.sort((a, b) => {
          const dt = dueTime(a.id) - dueTime(b.id);
          if (dt !== 0) return dt;
          const ad = a.fields.depth ?? 0;
          const bd = b.fields.depth ?? 0;
          if (ad !== bd) return ad - bd;
          return a.id.localeCompare(b.id);
        });
        reviewSorted.push(...arr);
      }
    } else {
      reviewSorted = [...dueReview].sort((a, b) => {
        const dt = dueTime(a.id) - dueTime(b.id);
        if (dt !== 0) return dt;
        const ad = a.fields.depth ?? 0;
        const bd = b.fields.depth ?? 0;
        if (ad !== bd) return ad - bd;
        return a.id.localeCompare(b.id);
      });
    }
  } else { // random
    if (prefs.groupByDeck) {
      const deckMap = new Map<string, typeof dueReview>();
      for (const c of dueReview) {
        const arr = deckMap.get(c.deck) || [];
        arr.push(c);
        deckMap.set(c.deck, arr);
      }
      const decks = [...deckMap.keys()].sort((a, b) => a.localeCompare(b));
      for (const d of decks) {
        const arr = deckMap.get(d)!;
        arr.sort(() => Math.random() - 0.5);
        reviewSorted.push(...arr);
      }
    } else {
      reviewSorted = [...dueReview].sort(() => Math.random() - 0.5);
    }
  }

  const typeLimitLeft = (type: 'new' | 'mature' | 'leech') => {
    const conf = limits[type];
    const used = already[type] + (included as any)[type];
    const left = conf.enabled ? Math.max(0, conf.limit - used) : Number.POSITIVE_INFINITY;
    return left;
  };

  const cumulativeLeft = () => Math.max(0, limits.cumulativeLimit - (already.total + included.total));

  // Build final queue honoring ordering prefs and limits
  const takeCard = (c: typeof due[number]) => {
    const t = classifyCard(c, limits);
    let typeAllowed = true;
    if (t === 'new') typeAllowed = typeLimitLeft('new') > 0;
    else if (t === 'leech') typeAllowed = typeLimitLeft('leech') > 0;
    else if (t === 'mature') typeAllowed = typeLimitLeft('mature') > 0; // young has no per-type limit
    if (!typeAllowed) return false;
    if (cumulativeLeft() <= 0) return false;
    outIds.push(c.id);
    (included as any)[t]++;
    included.total++;
    return true;
  };

  const pushByOrder = () => {
    let iNew = 0;
    let iRev = 0;
    const rev = reviewSorted;
    const neu = newSorted;

    if (prefs.newVsReviewOrder === 'new-first') {
      while (iNew < neu.length && cumulativeLeft() > 0) {
        const c = neu[iNew++];
        takeCard(c);
      }
      while (iRev < rev.length && cumulativeLeft() > 0) {
        const c = rev[iRev++];
        takeCard(c);
      }
    } else if (prefs.newVsReviewOrder === 'review-first') {
      while (iRev < rev.length && cumulativeLeft() > 0) {
        const c = rev[iRev++];
        takeCard(c);
      }
      while (iNew < neu.length && cumulativeLeft() > 0) {
        const c = neu[iNew++];
        takeCard(c);
      }
    } else {
      // interleave: 1 new per N reviews
      const N = Math.max(1, prefs.interleaveRatio | 0);
      let nextNew = true;
      let reviewStreak = 0;
      while ((iNew < neu.length || iRev < rev.length) && cumulativeLeft() > 0) {
        if (nextNew && iNew < neu.length) {
          const added = takeCard(neu[iNew]);
          iNew++;
          nextNew = false;
          reviewStreak = 0;
          // if couldn't add due to limits, continue interleaving progression
        } else if (!nextNew && iRev < rev.length) {
          const added = takeCard(rev[iRev]);
          iRev++;
          reviewStreak++;
          if (reviewStreak >= N) { nextNew = true; reviewStreak = 0; }
        } else if (iRev >= rev.length && iNew < neu.length) {
          // only new left
          const added = takeCard(neu[iNew]);
          iNew++;
        } else if (iNew >= neu.length && iRev < rev.length) {
          // only review left
          const added = takeCard(rev[iRev]);
          iRev++;
        } else {
          break;
        }
      }
    }
  };

  pushByOrder();

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
