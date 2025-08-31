import { useState } from 'react';
import { Deck, getChildrenOf, getDeckById } from '../decks';
import { useNavigate } from 'react-router-dom';
import { getDueCountForDeck } from '../data/cardStore';

type Props = { rootId: string };

export default function DeckTree({ rootId }: Props) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const NodeRow = ({ deck, depth = 0 }: { deck: Deck; depth?: number }) => {
    const kids = getChildrenOf(deck.id);
    const isBranch = kids.length > 0;
    const isOpen = expanded.has(deck.id);
    const due = getDueCountForDeck(deck.id, true);

    return (
      <div className="grid" style={{ paddingLeft: 12 + depth * 18 }}>
        <div
          className="row"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingRight: 16, gap: 16 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
            {isBranch ? (
              <button className="icon-btn" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => toggle(deck.id)} title={isOpen ? 'Collapse' : 'Expand'}>
                {isOpen ? '▾' : '▸'}
              </button>
            ) : (
              <span style={{ width: 24 }} />
            )}
            <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deck.name}</div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span title="Cards due today" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 28, height: 28, padding: '0 8px', borderRadius: 999, fontWeight: 700, fontSize: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: 'var(--text)' }}>
              {due}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="button" onClick={() => navigate(`/review/${deck.id}`)}>Review</button>
              {/* Changed to primary style to match Review button */}
              <button className="button" onClick={() => alert('Manage (coming soon)')}>Manage</button>
            </div>
          </div>
        </div>

        {isBranch && isOpen && (
          <div className="grid">
            {kids.map(child => (
              <NodeRow key={child.id} deck={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const root = getDeckById(rootId);
  if (!root) return <div className="sub">Deck not found: {rootId}</div>;
  return <NodeRow deck={root} depth={0} />;
}
