import { setCardDueFlexible } from '../data/cardStore';

export type ReviewUndoStep = {
  cardId: string;
  /** Previous due value before the review action; undefined means no due field present */
  prevDue: string | 'new' | undefined;
  /** New due value that was set by the review action */
  newDue: string | 'new';
  /** Optional deck context (not required for undo but useful for debugging) */
  deckId?: string;
  /** Timestamp for ordering/debugging (set when pushed) */
  ts: number;
  /** Optional scheduler snapshots for undo */
  prevSched?: any;
  newSched?: any;
};

const KEY = 'chessflashcards.reviewHistory.v1'; // session-scoped
const LOG_KEY = 'chessflashcards.reviewLog.v1'; // persistent review log used by Stats

function load(): ReviewUndoStep[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr as ReviewUndoStep[] : [];
  } catch {
    return [];
  }
}

function save(steps: ReviewUndoStep[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(steps));
  } catch {
    /* ignore */
  }
}

/** Push a review operation onto the session undo stack. */
export function pushReviewUndoStep(step: Omit<ReviewUndoStep, 'ts'>): void {
  const steps = load();
  steps.push({ ...step, ts: Date.now() });
  save(steps);
}

/** Whether there is something to undo in this session. */
export function canUndo(): boolean {
  return load().length > 0;
}

/**
 * Undo the most recent review in this session.
 * Restores the prior due value via the local overrides layer.
 * Returns the undone step (or null if nothing to undo).
 */
export function undoLast(): ReviewUndoStep | null {
  const steps = load();
  const step = steps.pop();
  if (!step) return null;
  // Restore previous due: undefined → clears override; 'new' or ISO string → sets it
  setCardDueFlexible(step.cardId, step.prevDue);
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        let removed = false;
        for (let i = arr.length - 1; i >= 0; i--) {
          const rec = arr[i];
          if (rec && rec.id === step.cardId) {
            arr.splice(i, 1);
            removed = true;
            break;
          }
        }
        if (!removed) arr.pop();
        localStorage.setItem(LOG_KEY, JSON.stringify(arr));
      }
    }
  } catch {}
  save(steps);
  return step;
}

/** Inspect current session history (read-only snapshot). */
export function getReviewHistory(): readonly ReviewUndoStep[] {
  return load();
}

/** Clear all session undo history. */
export function clearReviewHistory(): void {
  save([]);
}

/** Back-compat alias. */
export function clearHistory(): void {
  clearReviewHistory();
}
