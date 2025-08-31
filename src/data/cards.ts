import { getDescendantDeckIds } from '../decks';

export type Card = {
  id: string;
  deckId: string;
  front: { type: 'text'; value: string }; // later: {type:'fen', value:string}
  back: { type: 'text'; value: string };  // later: engine PV/eval, etc.
  dueAt: string; // ISO
};

// --- Seed: first card lives in Openings/White/Other (deckId = 'white-other')
export const cards: Card[] = [
  {
    id: 'c1',
    deckId: 'white-other',
    front: { type: 'text', value: 'White to move: play the principled center move.' },
    back: { type: 'text', value: '1. e4 — (placeholder answer for MVP)' },
    // Make it due today so it shows up
    dueAt: new Date().toISOString()
  }
];

function isDue(dueAtIso: string, now = new Date()): boolean {
  // Due if dueAt <= now
  return new Date(dueAtIso).getTime() <= now.getTime();
}

export function getDueCountForDeck(deckId: string): number {
  const ids = new Set([deckId, ...getDescendantDeckIds(deckId)]);
  return cards.filter(c => ids.has(c.deckId) && isDue(c.dueAt)).length;
}

export function getDueCardsForDeck(deckId: string): Card[] {
  const ids = new Set([deckId, ...getDescendantDeckIds(deckId)]);
  return cards.filter(c => ids.has(c.deckId) && isDue(c.dueAt));
}
