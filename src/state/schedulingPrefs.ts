export type NewVsReviewOrder = 'new-first' | 'review-first' | 'interleave';

export type NewCardPick = 'parent-longest-interval' | 'newest-created-first' | 'random';

export type ReviewOrder = 'due-date' | 'random';

export type CardSchedulingPrefs = {
  newVsReviewOrder: NewVsReviewOrder;
  interleaveRatio: number; // 1 new per N reviews when interleaving
  newPick: NewCardPick;
  reviewOrder: ReviewOrder;
  groupByDeck: boolean;
};

const KEY = 'chessflashcards.cardScheduling.v1';

export const DEFAULT_SCHEDULING_PREFS: CardSchedulingPrefs = {
  // Default 1: review new cards first each day
  newVsReviewOrder: 'new-first',
  interleaveRatio: 3,
  // Default 2: pick new cards whose parent has the longest interval
  newPick: 'parent-longest-interval',
  // Default 3: for non-new cards, order by due date (earliest first)
  reviewOrder: 'due-date',
  groupByDeck: true,
};

export function getSchedulingPrefs(): CardSchedulingPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SCHEDULING_PREFS;
    const parsed = JSON.parse(raw) || {};
    const next = { ...DEFAULT_SCHEDULING_PREFS, ...parsed } as CardSchedulingPrefs;
    // sanitize unknown values from older versions
    const validNew: NewCardPick[] = ['parent-longest-interval','newest-created-first','random'];
    const validRev: ReviewOrder[] = ['due-date','random'];
    if (!validNew.includes(next.newPick as any)) next.newPick = DEFAULT_SCHEDULING_PREFS.newPick;
    if (!validRev.includes(next.reviewOrder as any)) next.reviewOrder = DEFAULT_SCHEDULING_PREFS.reviewOrder;
    return next;
  } catch {
    return DEFAULT_SCHEDULING_PREFS;
  }
}

export function setSchedulingPrefs(patch: Partial<CardSchedulingPrefs>): CardSchedulingPrefs {
  const cur = getSchedulingPrefs();
  const next = { ...cur, ...patch } as CardSchedulingPrefs;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  return next;
}
