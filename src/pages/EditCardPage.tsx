import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useBackKeybind } from '../hooks/useBackKeybind';
import type { Card } from '../data/types';

declare global {
  interface Window {
    cards?: {
      readOne?: (id: string) => Promise<Card | null>;
      update?: (card: Card) => Promise<boolean>;
      create?: (card: Card) => Promise<boolean>;
    };
  }
}

type EvalKind = 'cp' | 'mate';

type Draft = {
  id: string;
  deck: string;
  tags: string; // comma-separated
  due: string;  // 'new' | ISO | ''
  fields: {
    moveSequence: string;
    fen: string;
    answer: string;
    answerFen: string;
    evalKind: EvalKind;
    evalValue: string; // keep as string for text input
    evalDepth: string; // keep as string
    exampleLine: string; // space-separated SAN
    otherAnswers: string; // space-separated SAN
    siblingAnswers: string; // space-separated SAN
    depth: string;  // required in model; default to computed/0 when blank
    parent: string; // optional
    // children/descendants are shown read-only
  };
  roChildren: string;     // display-only (space-separated ids)
  roDescendants: string;  // display-only (space-separated ids)
};

function arrToLine(a?: string[] | null): string {
  return (a ?? []).join(' ');
}

function lineToArr(s: string): string[] {
  return s
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function tagsToLine(tags?: string[]): string {
  return (tags ?? []).join(', ');
}

function lineToTags(s: string): string[] {
  return s
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

function toDraft(c: Card): Draft {
  return {
    id: c.id,
    deck: c.deck,
    tags: tagsToLine(c.tags),
    due: (c as any).due ?? '',
    fields: {
      moveSequence: c.fields.moveSequence || '',
      fen: c.fields.fen || '',
      answer: c.fields.answer || '',
      answerFen: c.fields.answerFen || '',
      evalKind: ((c.fields as any).eval?.kind ?? 'cp') as EvalKind,
      evalValue: String((c.fields as any).eval?.value ?? ''),
      evalDepth: String((c.fields as any).eval?.depth ?? ''),
      exampleLine: arrToLine(c.fields.exampleLine),
      otherAnswers: arrToLine(c.fields.otherAnswers),
      siblingAnswers: arrToLine((c.fields as any).siblingAnswers),
      depth: String((c.fields as any).depth ?? ''), // may be '', we coerce on save
      parent: (c.fields as any).parent ?? '',
    },
    roChildren: (c.fields.children ?? []).join(' '),
    roDescendants: (c.fields.descendants ?? []).join(' '),
  };
}

export default function EditCardPage() {
  const { cardId } = useParams<{ cardId: string }>();
  const navigate = useNavigate();
  const location = useLocation() as any;

  const [card, setCard] = useState<Card | null>(location?.state?.card ?? null);
  const [draft, setDraft] = useState<Draft | null>(() => {
    const c: Card | null = location?.state?.card ?? null;
    return c ? toDraft(c) : null;
  });
  const [loading, setLoading] = useState(!card);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back keybind
  const goBack = () => {
    if (location?.state?.from) navigate(-1);
    else navigate('/');
  };
  useBackKeybind(goBack, true);

  // Load card if not provided via navigation state
  useEffect(() => {
    let active = true;
    async function fetchCard() {
      if (card || !cardId) return;
      try {
        const c = await window.cards?.readOne?.(cardId);
        if (active) {
          setCard(c || null);
          setDraft(c ? toDraft(c) : null);
          setLoading(false);
        }
      } catch (e: any) {
        if (active) {
          setError(e?.message || 'Failed to load card');
          setLoading(false);
        }
      }
    }
    fetchCard();
    return () => { active = false; };
  }, [card, cardId]);

  const ready = useMemo(() => !!draft, [draft]);

  // Helpers to update draft safely
  const setRoot = (patch: Partial<Omit<Draft, 'fields'>>) => {
    setDraft(prev => (prev ? { ...prev, ...patch } : prev));
    setSaved(false);
  };
  const setField = <K extends keyof Draft['fields']>(key: K, value: string) => {
    setDraft(prev => (prev ? { ...prev, fields: { ...prev.fields, [key]: value } } : prev));
    setSaved(false);
  };

  async function handleSave() {
    if (!ready || !draft) return;
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const depthNum = (() => {
        const raw = (draft.fields.depth ?? '').trim();
        const n = Number(raw);
        return Number.isFinite(n) ? n : 0;
      })();

      const evalField =
        draft.fields.evalValue !== ''
          ? {
              kind: draft.fields.evalKind,
              value: Number(draft.fields.evalValue),
              ...(draft.fields.evalDepth !== '' ? { depth: Number(draft.fields.evalDepth) } : {}),
            }
          : undefined;

      const updated: Card = {
        id: draft.id,
        deck: draft.deck,
        tags: lineToTags(draft.tags),
        fields: {
          moveSequence: draft.fields.moveSequence,
          fen: draft.fields.fen,
          answer: draft.fields.answer,
          answerFen: draft.fields.answerFen || undefined,
          eval: evalField as any,
          exampleLine: lineToArr(draft.fields.exampleLine),
          otherAnswers: lineToArr(draft.fields.otherAnswers),
          siblingAnswers: lineToArr(draft.fields.siblingAnswers),
          depth: depthNum,
          parent: draft.fields.parent || undefined,
          children: card?.fields.children,
          descendants: card?.fields.descendants,
        },
        ...(draft.due === '' ? {} : { due: draft.due as any }),
      };

      const ok = (await window.cards?.update?.(updated)) ?? false;
      if (!ok) throw new Error('Write failed');

      // Keep editor in sync
      setCard(updated);
      setDraft(toDraft(updated));
      setSaved(true);

      navigate(location.pathname, {
        replace: true,
        state: { ...(location.state || {}), card: updated },
      });
    } catch (e: any) {
      setError(e?.message || 'Failed to save card');
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key?.toLowerCase?.() || '';
      if (k === 's') {
        e.preventDefault();
        if (!saving) handleSave();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as any);
  }, [saving, ready, draft]);

  if (loading || !ready || !draft) {
    return (
      <div className="container">
        <div className="card grid">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Edit Card</h2>
            <button className="button secondary" onClick={goBack}>Back</button>
          </div>
          <div className="sub">{error ? `Error: ${error}` : 'Loading…'}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card grid" style={{ gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Edit Card</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {saved && <div className="sub" aria-live="polite">Saved</div>}
            <button className="button secondary" onClick={goBack}>Back</button>
            <button className="button" onClick={handleSave} disabled={saving} title="Save (Ctrl+S)">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {/* ID (read-only) */}
        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>ID</div>
          <input
            className="no-native-spin"
            type="text"
            value={draft.id}
            readOnly
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
          />
        </div>

        {/* Deck */}
        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>Deck</div>
          <input
            type="text"
            value={draft.deck}
            onChange={e => { const v = e.currentTarget.value; setRoot({ deck: v }); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
          />
        </div>

        {/* Tags (comma separated) */}
        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>Tags</div>
          <input
            type="text"
            value={draft.tags}
            onChange={e => { const v = e.currentTarget.value; setRoot({ tags: v }); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            placeholder="comma,separated,tags"
          />
        </div>

        {/* Due ('new' or ISO) */}
        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>Due</div>
          <input
            type="text"
            value={draft.due}
            onChange={e => { const v = e.currentTarget.value; setRoot({ due: v }); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            placeholder="new or 2025-01-01T00:00:00.000Z"
          />
        </div>

        {/* Fields */}
        <div style={{ fontWeight: 600, fontSize: 18, opacity: 0.95, marginTop: 8 }}>
          Fields
        </div>

        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
          <div>Move Sequence (PGN)</div>
          <textarea
            value={draft.fields.moveSequence}
            onChange={e => { const v = e.currentTarget.value; setField('moveSequence', v); }}
            rows={3}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }}
          />
        </div>

        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>Review FEN</div>
          <input
            type="text"
            value={draft.fields.fen}
            onChange={e => { const v = e.currentTarget.value; setField('fen', v); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
          />
        </div>

        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>Answer (SAN)</div>
          <input
            type="text"
            value={draft.fields.answer}
            onChange={e => { const v = e.currentTarget.value; setField('answer', v); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
          />
        </div>

        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>Answer FEN</div>
          <input
            type="text"
            value={draft.fields.answerFen}
            onChange={e => { const v = e.currentTarget.value; setField('answerFen', v); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            placeholder="optional"
          />
        </div>

        {/* Eval */}
        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr 1fr', gap: 12, alignItems: 'center' }}>
          <div>Eval</div>
          <select
            value={draft.fields.evalKind}
            onChange={e => { const v = e.currentTarget.value as EvalKind; setField('evalKind', v); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
          >
            <option value="cp">cp</option>
            <option value="mate">mate</option>
          </select>
          <input
            type="text"
            inputMode="numeric"
            placeholder="value"
            value={draft.fields.evalValue}
            onChange={e => { const v = e.currentTarget.value; setField('evalValue', v); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
          />
          <input
            type="text"
            inputMode="numeric"
            placeholder="depth"
            value={draft.fields.evalDepth}
            onChange={e => { const v = e.currentTarget.value; setField('evalDepth', v); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
          />
        </div>

        {/* exampleLine & otherAnswers as space-separated SAN */}
        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
          <div>Example Line (SAN)</div>
          <textarea
            value={draft.fields.exampleLine}
            onChange={e => { const v = e.currentTarget.value; setField('exampleLine', v); }}
            rows={2}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }}
            placeholder="e4 e5 Nf3 Nc6 ..."
          />
        </div>

        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
          <div>Other Answers (SAN)</div>
          <textarea
            value={draft.fields.otherAnswers}
            onChange={e => { const v = e.currentTarget.value; setField('otherAnswers', v); }}
            rows={2}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }}
            placeholder="Nf3 c4 g3"
          />
        </div>

        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
          <div>Sibling Answers (SAN)</div>
          <textarea
            value={draft.fields.siblingAnswers}
            onChange={e => { const v = e.currentTarget.value; setField('siblingAnswers', v); }}
            rows={2}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }}
            placeholder="SAN moves treated equivalent to best"
          />
        </div>

        {/* Lineage */}
        <div style={{ fontWeight: 600, fontSize: 18, opacity: 0.95, marginTop: 8 }}>
          Lineage
        </div>

        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>depth</div>
          <input
            type="text"
            inputMode="numeric"
            value={draft.fields.depth}
            onChange={e => { const v = e.currentTarget.value; setField('depth', v); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            placeholder="required int (usually computed)"
          />
        </div>

        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>parent</div>
          <input
            type="text"
            value={draft.fields.parent}
            onChange={e => { const v = e.currentTarget.value; setField('parent', v); }}
            style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            placeholder="optional"
          />
        </div>

        {/* Read-only visibility */}
        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>children</div>
          <input
            type="text"
            value={draft.roChildren}
            readOnly
            style={{ backgroundColor: '#eaeaea', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            title="Immediate children IDs (read-only)"
          />
        </div>
        <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
          <div>descendants</div>
          <input
            type="text"
            value={draft.roDescendants}
            readOnly
            style={{ backgroundColor: '#eaeaea', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            title="All descendant IDs (read-only)"
          />
        </div>
      </div>
    </div>
  );
}
