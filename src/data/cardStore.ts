import { Card } from './types';
import { getChildrenOf } from '../decks';
import jsonRaw from './cards.json?raw';

// ---------- Parse cards.json (array-only; supports 0-byte) ----------
let cards: Card[] = [];
try {
  const text = (jsonRaw ?? '').trim();
  if (text === '') {
    cards = [];
  } else {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('cards.json must be a JSON array of Card objects');
    }
    cards = parsed as Card[];
  }
} catch (e) {
  console.warn('[cardStore] Failed to parse cards.json as an array; using empty set.', e);
  cards = [];
}

const byId = new Map<string, Card>(cards.map(c => [c.id, c]));

// ---------- Local overrides (persist due changes for testing) ----------
const OV_KEY = 'chessflashcards.cardOverrides.v1';

type Overrides = Record<string, { due?: string | 'new' }>;

function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(OV_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveOverrides(ov: Overrides) {
  try {
    localStorage.setItem(OV_KEY, JSON.stringify(ov));
  } catch {
    /* ignore */
  }
}

// apply overrides to in-memory cards
(function applyOverrides() {
  const ov = loadOverrides();
  for (const c of cards) {
    const o = ov[c.id];
    if (o && 'due' in o) {
      (c as any).due = o.due;
    }
  }
})();

// ---------- Helpers ----------
function isDueCard(c: Card, now = new Date()): boolean {
  if (!('due' in c) || (c as any).due == null) return false;
  const due = (c as any).due as string | 'new';
  if (due === 'new') return true;
  const t = Date.parse(due);
  return Number.isFinite(t) && t <= now.getTime();
}

export function allCards(): Card[] {
  return cards;
}

export function cardsByDeck(deckId: string): Card[] {
  return cards.filter(c => c.deck === deckId);
}

// ---------- Compute relations (children + descendants) ----------
export function computeChildren() {
  // 1) Rebuild children from parent pointers to keep data consistent.
  const childrenMap = new Map<string, string[]>();
  for (const c of cards) {
    const p = c.fields.parent;
    if (!p) continue;
    const arr = childrenMap.get(p) || [];
    arr.push(c.id);
    childrenMap.set(p, arr);
  }
  for (const c of cards) {
    c.fields.children = childrenMap.get(c.id) || [];
  }

  // 2) Compute descendants via DFS over children.
  const idToCard = new Map<string, Card>(cards.map(c => [c.id, c]));
  for (const c of cards) {
    const desc: string[] = [];
    const stack = [...(c.fields.children || [])];
    const seen = new Set<string>();
    while (stack.length) {
      const cid = stack.pop()!;
      if (seen.has(cid)) continue;
      seen.add(cid);
      desc.push(cid);
      const cc = idToCard.get(cid);
      if (cc && cc.fields.children && cc.fields.children.length) {
        for (const gcid of cc.fields.children) {
          stack.push(gcid);
        }
      }
    }
    c.fields.descendants = desc;
  }
}

export function getDueCountForDeck(deckId: string, includeDesc = true): number {
  const ids = new Set<string>([deckId]);
  if (includeDesc) {
    const q = [deckId];
    while (q.length) {
      const cur = q.pop()!;
      for (const ch of getChildrenOf(cur)) {
        if (!ids.has(ch.id)) {
          ids.add(ch.id);
          q.push(ch.id);
        }
      }
    }
  }
  return cards.filter(c => ids.has(c.deck) && isDueCard(c)).length;
}

export function getDueCardsForDeck(deckId: string): Card[] {
  const matches = new Set<string>([deckId]);
  const q = [deckId];
  while (q.length) {
    const cur = q.pop()!;
    for (const ch of getChildrenOf(cur)) {
      if (!matches.has(ch.id)) {
        matches.add(ch.id);
        q.push(ch.id);
      }
    }
  }
  return cards.filter(c => matches.has(c.deck) && isDueCard(c));
}

// ---------- Review updates (testing) ----------

/** Read the current in-memory due value. */
export function getCardDue(cardId: string): string | 'new' | undefined {
  const c = byId.get(cardId);
  return c ? ((c as any).due as any) : undefined;
}

/** Set or clear due. If due is undefined, remove override and clear in-memory due. */
export function setCardDueFlexible(cardId: string, due: string | 'new' | undefined): boolean {
  const card = byId.get(cardId);
  if (!card) return false;

  const ov = loadOverrides();

  if (typeof due === 'undefined') {
    delete (card as any).due;
    if (ov[cardId]) {
      delete ov[cardId].due;
      if (Object.keys(ov[cardId]).length === 0) {
        delete ov[cardId];
      }
    }
    saveOverrides(ov);
    return true;
  }

  (card as any).due = due;
  ov[cardId] = { ...(ov[cardId] || {}), due };
  saveOverrides(ov);
  return true;
}

/** Set exact ISO due (or 'new') for a card and persist to localStorage overrides. */
export function setCardDue(cardId: string, due: string | 'new'): boolean {
  return setCardDueFlexible(cardId, due);
}

/** Push due time forward by N minutes from now (testing). */
export function pushCardDueMinutes(cardId: string, minutes: number): boolean {
  const dueISO = new Date(Date.now() + minutes * 60_000).toISOString();
  return setCardDue(cardId, dueISO);
}

// Initialize relations (safe with zero cards)
computeChildren();
