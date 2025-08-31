export type Deck = {
  id: string;
  name: string;
  parentId?: string | null;
};

export const decks: Deck[] = [
  { id: 'openings', name: 'Openings', parentId: null },
  { id: 'openings-white', name: 'White', parentId: 'openings' },
  { id: 'openings-black', name: 'Black', parentId: 'openings' },

  // White subdecks
  { id: 'white-scotch', name: 'Scotch', parentId: 'openings-white' },
  { id: 'white-caro-kann', name: 'Caro Kann', parentId: 'openings-white' },
  { id: 'white-other', name: 'Other', parentId: 'openings-white' },

  // Black subdecks
  { id: 'black-italian', name: 'Italian', parentId: 'openings-black' },
  { id: 'black-queens-gambit', name: "Queen's Gambit", parentId: 'openings-black' },
  { id: 'black-other', name: 'Other', parentId: 'openings-black' }
];

export function getRootDecks() {
  return decks.filter(d => !d.parentId);
}

export function getChildrenOf(parentId: string) {
  return decks.filter(d => d.parentId === parentId);
}

export function getDeckById(id?: string | null) {
  if (!id) return undefined;
  return decks.find(d => d.id === id);
}

// Collect all descendant deck ids (recursive)
export function getDescendantDeckIds(parentId: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    const kids = getChildrenOf(pid);
    for (const k of kids) {
      out.push(k.id);
      walk(k.id);
    }
  };
  walk(parentId);
  return out;
}
