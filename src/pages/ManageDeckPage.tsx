import React, { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDeckById, getChildrenOf, getDeckPath } from '../decks';
import { allCards } from '../data/cardStore';

function gatherDeckAndDescendants(deckId: string): string[] {
  const acc = new Set<string>();
  const stack = [deckId];
  while (stack.length) {
    const id = stack.pop()!;
    acc.add(id);
    for (const ch of getChildrenOf(id)) stack.push(ch.id);
  }
  return Array.from(acc);
}

export default function ManageDeckPage() {
  const { deckId } = useParams<{ deckId: string }>();
  const navigate = useNavigate();
  const back = () => navigate('/');

  const deck = getDeckById(deckId);
  const path = useMemo(() => getDeckPath(deckId), [deckId]);
  const ids = useMemo(() => (deckId ? gatherDeckAndDescendants(deckId) : []), [deckId]);
  const cards = useMemo(() => allCards().filter(c => ids.includes(c.deck)), [ids]);

  const now = Date.now();
  const counts = useMemo(() => {
    let total = cards.length, newCnt = 0, due = 0, overdue = 0;
    for (const c of cards) {
      const d: any = (c as any).due;
      if (d === 'new') { newCnt++; continue; }
      if (typeof d === 'string') {
        const t = Date.parse(d);
        if (Number.isFinite(t)) {
          if (t <= now) { due++; overdue += (t < now) ? 1 : 0; }
        }
      }
    }
    return { total, newCnt, due, overdue };
  }, [cards, now]);

  const exportDeck = async () => {
    const base = path.map(p => p.name).join('-') || 'deck';
    // Always include cards from this deck and all its descendants
    const arr = cards;
    const res = await (window as any).cards?.exportJsonToDownloads?.(arr, base);
    if (res?.ok) {
      const loc = res?.path ? `\nSaved to: ${res.path}` : '';
      alert(`Export complete.${loc}`);
    } else {
      alert('Export failed: ' + (res?.message || 'Unknown'));
    }
  };

  if (!deck) {
    return (
      <div className="container">
        <div className="card grid">
          <h2 style={{ margin: 0 }}>Manage Deck</h2>
          <div className="sub">Deck not found: {deckId}</div>
          <button className="button secondary" onClick={back}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card grid">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>Manage Deck</h2>
            <div className="sub" style={{ marginTop: 2 }}>
              {path.map((d, i) => (<span key={d.id}>{i>0?' / ':''}{d.name}</span>))}
            </div>
          </div>
          <button className="button secondary" onClick={back}>Back</button>
        </div>

        <div className="grid" style={{ gap: 12 }}>
          <div className="row" style={{ display: 'flex', gap: 20 }}>
            <div>Total: <strong>{counts.total}</strong></div>
            <div>New: <strong>{counts.newCnt}</strong></div>
            <div>Due: <strong>{counts.due}</strong></div>
            <div>Overdue: <strong>{counts.overdue}</strong></div>
          </div>

          <div className="row" style={{ display: 'flex', gap: 12 }}>
            <button className="button" onClick={() => exportDeck()}>Export this deck</button>
          </div>
        </div>
      </div>
    </div>
  );
}
