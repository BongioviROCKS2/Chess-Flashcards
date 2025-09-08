import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allCards } from '../data/cardStore';
import type { Card } from '../data/types';
import BoardPlayer from '../components/BoardPlayer';
import { Deck, getChildrenOf, getDeckById, getRootDecks, getDeckPath } from '../decks';
import { useNavigate } from 'react-router-dom';
import { useBackKeybind } from '../hooks/useBackKeybind';
import { useKeybinds, formatActionKeys } from '../context/KeybindsProvider';
import { Chess } from 'chess.js';

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
    evalValue: string;
    evalDepth: string;
    exampleLine: string;
    otherAnswers: string;
    siblingAnswers: string;
    depth: string;
    parent: string;
  };
};

function arrToLine(a?: (string | { move?: string })[] | null): string {
  if (!Array.isArray(a) || a.length === 0) return '';
  const out: string[] = [];
  for (const it of a) {
    if (typeof it === 'string') out.push(it);
    else if (it && typeof it === 'object' && typeof (it as any).move === 'string') out.push((it as any).move);
  }
  return out.join(' ');
}
function lineToArr(s: string): string[] { return s.split(/\s+/).map(t => t.trim()).filter(Boolean); }
function tagsToLine(tags?: string[]): string { return (tags ?? []).join(', '); }
function lineToTags(s: string): string[] { return s.split(',').map(t => t.trim()).filter(Boolean); }

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
      depth: String((c.fields as any).depth ?? ''),
      parent: (c.fields as any).parent ?? '',
    },
  };
}

function fromDraft(d: Draft): Card {
  const evalField = d.fields.evalValue !== ''
    ? {
        kind: d.fields.evalKind,
        value: Number(d.fields.evalValue),
        ...(d.fields.evalDepth !== '' ? { depth: Number(d.fields.evalDepth) } : {}),
      }
    : undefined;
  const depthNum = (() => {
    const raw = (d.fields.depth ?? '').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  })();
  const card: Card = {
    id: d.id,
    deck: d.deck,
    tags: lineToTags(d.tags),
    fields: {
      moveSequence: d.fields.moveSequence,
      fen: d.fields.fen,
      answer: d.fields.answer,
      answerFen: d.fields.answerFen || undefined,
      eval: evalField as any,
      exampleLine: lineToArr(d.fields.exampleLine),
      otherAnswers: lineToArr(d.fields.otherAnswers),
      siblingAnswers: lineToArr(d.fields.siblingAnswers),
      depth: depthNum,
      parent: d.fields.parent || undefined,
    },
    ...(d.due === '' ? {} : { due: d.due as any }),
  };
  return card;
}

function sideToMoveFromFen(fen?: string): 'w' | 'b' {
  if (!fen) return 'w';
  const parts = fen.split(' ');
  return (parts[1] as 'w' | 'b') || 'w';
}

function formatEvalWhiteCentric(
  e?: { kind: 'cp' | 'mate'; value: number; depth?: number },
  fen?: string
) {
  if (!e) return '';
  const stm = sideToMoveFromFen(fen);
  const signAdjust = stm === 'w' ? 1 : -1;
  if (e.kind === 'mate') {
    const val = e.value * signAdjust;
    const sgn = val >= 0 ? '+' : '-';
    return `${sgn}M${Math.abs(val)}`;
  } else {
    const pawns = (e.value * signAdjust) / 100;
    const abs = Math.abs(pawns);
    const shown = abs >= 1 ? pawns.toFixed(1) : pawns.toFixed(2);
    const sgn = pawns >= 0 ? '+' : '';
    return `${sgn}${shown}`;
  }
}

function isBlackDeckId(deckId?: string) {
  if (!deckId) return false;
  const id = deckId.toLowerCase();
  return id === 'black' || id.startsWith('black-');
}

type CardState = 'new' | 'due' | 'scheduled' | 'none';
function getCardState(c: Card, now = Date.now()): CardState {
  const due: any = (c as any).due;
  if (due === 'new') return 'new';
  if (typeof due === 'string') {
    const t = Date.parse(due);
    if (Number.isFinite(t)) return t <= now ? 'due' : 'scheduled';
  }
  return 'none';
}

type Criterion = { key?: string; value: string };
function parseSearch(input: string): Criterion[] {
  const tokens: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(ch)) { if (cur) { tokens.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens.map(t => {
    const idx = t.indexOf(':');
    if (idx > 0) return { key: t.slice(0, idx).trim().toLowerCase(), value: t.slice(idx + 1).trim().toLowerCase() };
    return { value: t.trim().toLowerCase() };
  }).filter(c => c.value.length > 0);
}

function cardMatchesSearch(c: Card, crits: Criterion[]): boolean {
  if (!crits.length) return true;
  const get = (key: string): string => {
    switch (key) {
      case 'id': return c.id.toLowerCase();
      case 'deck': return (c.deck || '').toLowerCase();
      case 'tags': return (c.tags || []).join(' ').toLowerCase();
      case 'due': return String((c as any).due ?? '').toLowerCase();
      case 'movesequence':
      case 'move':
      case 'pgn': return (c.fields.moveSequence || '').toLowerCase();
      case 'fen': return (c.fields.fen || '').toLowerCase();
      case 'answer': return (c.fields.answer || '').toLowerCase();
      case 'answerfen': return (c.fields.answerFen || '').toLowerCase();
      case 'otheranswers': {
        const s = arrToLine(c.fields.otherAnswers);
        return s.toLowerCase();
      }
      case 'siblinganswers': return (c.fields.siblingAnswers || []).join(' ').toLowerCase();
      case 'exampleline': return (c.fields.exampleLine || []).join(' ').toLowerCase();
      case 'depth': return String((c.fields as any).depth ?? '').toLowerCase();
      case 'evalkind': return String((c.fields as any).eval?.kind ?? '').toLowerCase();
      case 'evalvalue': return String((c.fields as any).eval?.value ?? '').toLowerCase();
      case 'evaldepth': return String((c.fields as any).eval?.depth ?? '').toLowerCase();
      case 'state': return getCardState(c);
      default:
        const other = arrToLine(c.fields.otherAnswers);
        return [
          c.id,
          c.deck,
          (c.tags || []).join(' '),
          c.fields.moveSequence,
          c.fields.fen,
          c.fields.answer,
          other,
          (c.fields.exampleLine || []).join(' '),
        ].join(' ').toLowerCase();
      }
  };
  return crits.every(cr => {
    if (cr.key) return String(get(cr.key)).includes(cr.value);
    return String(get('')).includes(cr.value);
  });
}

function pgnToSanArray(pgn: string): string[] {
  if (!pgn?.trim()) return [];
  return pgn
    .replace(/\{[^}]*\}/g, '')
    .replace(/\$\d+/g, '')
    .replace(/\d+\.(\.\.)?/g, '')
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function gatherDescendantIds(deckId: string): string[] {
  const out: string[] = [];
  const stack = [deckId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const ch of getChildrenOf(cur)) stack.push(ch.id);
  }
  return out;
}

function DeckFilterTree({ selected, onToggle }: { selected: Set<string>; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggleOpen = (id: string) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const Node = ({ d, depth = 0 }: { d: Deck; depth?: number }) => {
    const kids = getChildrenOf(d.id);
    const isBranch = kids.length > 0;
    const isOpen = open.has(d.id);
    const isChecked = selected.has(d.id);
    return (
      <div style={{ paddingLeft: 8 + depth * 14 }}>
        <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px' }}>
          {isBranch ? (
            <button className="icon-btn" onClick={() => toggleOpen(d.id)} aria-label={isOpen ? 'Collapse' : 'Expand'} title={isOpen ? 'Collapse' : 'Expand'}>
              {isOpen ? '−' : '+'}
            </button>
          ) : <span style={{ width: 24 }} />}
          <input type="checkbox" checked={isChecked} onChange={() => onToggle(d.id)} />
          <div style={{ fontWeight: 600 }}>{d.name}</div>
        </div>
        {isBranch && isOpen && (
          <div>
            {kids.map(k => <Node key={k.id} d={k} depth={(depth ?? 0) + 1} />)}
          </div>
        )}
      </div>
    );
  };
  return <div>{getRootDecks().map(r => <Node key={r.id} d={r} depth={0} />)}</div>;
}

type Column = { key: string; label: string; width: number; render: (c: Card) => React.ReactNode };
const MIN_SECTION = 180;
const RESIZER_W = 6;

export default function CollectionPage() {
  const navigate = useNavigate();
  useBackKeybind(() => navigate(-1), true);
  const { binds } = useKeybinds();
  const backKeys = formatActionKeys(binds, 'app.back');

  // --- Section widths ---
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [leftW, setLeftW] = useState<number>(() => {
    const n = Number(localStorage.getItem('collection.leftW') || '260');
    return Number.isFinite(n) ? Math.max(MIN_SECTION, n) : 260;
  });
  const [centerW, setCenterW] = useState<number>(() => {
    const n = Number(localStorage.getItem('collection.centerW') || '560');
    return Number.isFinite(n) ? Math.max(MIN_SECTION, n) : 560;
  });
  useEffect(() => { localStorage.setItem('collection.leftW', String(leftW)); }, [leftW]);
  useEffect(() => { localStorage.setItem('collection.centerW', String(centerW)); }, [centerW]);
  const [dragging, setDragging] = useState<null | 'left' | 'center'>(null);
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging || !shellRef.current) return;
      const rect = shellRef.current.getBoundingClientRect();
      const total = rect.width;
      const x = e.clientX - rect.left;
      const rightMin = MIN_SECTION;
      if (dragging === 'left') {
        const max = total - RESIZER_W * 2 - rightMin - Math.max(MIN_SECTION, centerW);
        const v = Math.max(MIN_SECTION, Math.min(x, Math.max(MIN_SECTION, max)));
        setLeftW(v);
      } else {
        const raw = x - leftW - RESIZER_W;
        const min = MIN_SECTION;
        const max = total - RESIZER_W * 2 - leftW - rightMin;
        const v = Math.max(min, Math.min(raw, Math.max(min, max)));
        setCenterW(v);
      }
    }
    function onUp() { setDragging(null); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging, leftW, centerW]);

  // --- Filters ---
  const all = allCards();
  const [search, setSearch] = useState<string>('');
  const [selectedDecks, setSelectedDecks] = useState<Set<string>>(new Set());
  const [tagSel, setTagSel] = useState<Set<string>>(new Set());
  const [stateSel, setStateSel] = useState<Set<CardState>>(new Set());
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const c of all) for (const t of (c.tags || [])) s.add(t);
    // Always include special tag for filtering archived cards
    s.add('Archived');
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [all]);
  const selectedDecksExpanded = useMemo(() => {
    if (!selectedDecks.size) return new Set<string>();
    const s = new Set<string>();
    for (const id of selectedDecks) for (const d of gatherDescendantIds(id)) s.add(d);
    return s;
  }, [selectedDecks]);
  const criteria = useMemo(() => parseSearch(search), [search]);
  const filtered = useMemo(() => {
    const now = Date.now();
    return all.filter(c => {
      if (selectedDecksExpanded.size && !selectedDecksExpanded.has(c.deck)) return false;
      if (tagSel.size) {
        const ct = new Set(c.tags || []);
        let ok = false; for (const t of tagSel) { if (ct.has(t)) { ok = true; break; } }
        if (!ok) return false;
      }
      if (stateSel.size) {
        const st = getCardState(c, now);
        if (!stateSel.has(st)) return false;
      }
      if (!cardMatchesSearch(c, criteria)) return false;
      return true;
    });
  }, [all, selectedDecksExpanded, tagSel, stateSel, criteria]);

  // --- Table columns ---
  const allColumns: Column[] = useMemo(() => [
    { key: 'id', label: 'ID', width: 200, render: c => c.id },
    { key: 'deck', label: 'Deck', width: 220, render: c => {
      const path = getDeckPath(c.deck);
      return path.length ? path.map(d => d.name).join(' / ') : (getDeckById(c.deck)?.name || c.deck);
    } },
    { key: 'state', label: 'State', width: 100, render: c => getCardState(c) },
    { key: 'due', label: 'Due', width: 200, render: c => String((c as any).due ?? '') },
    { key: 'tags', label: 'Tags', width: 160, render: c => (c.tags || []).join(', ') },
    { key: 'answer', label: 'Answer', width: 140, render: c => c.fields.answer },
    { key: 'other', label: 'Other Answers', width: 180, render: c => arrToLine(c.fields.otherAnswers) },
    { key: 'pgn', label: 'Moves (PGN)', width: 220, render: c => c.fields.moveSequence },
    { key: 'fen', label: 'Review FEN', width: 340, render: c => c.fields.fen },
    { key: 'depth', label: 'Depth', width: 80, render: c => String((c.fields as any).depth ?? '') },
  ], []);
  const [colW, setColW] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem('collection.colW') || '{}') || {}; } catch { return {}; } });
  useEffect(() => { localStorage.setItem('collection.colW', JSON.stringify(colW)); }, [colW]);

  // Visible + order persistence
  const allKeys = useMemo(() => allColumns.map(c => c.key), [allColumns]);
  const [colOrder, setColOrder] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('collection.colOrder') || 'null');
      const arr = Array.isArray(raw) ? raw.filter((k: any) => typeof k === 'string') : null;
      return arr && arr.length ? arr : allKeys;
    } catch { return allKeys; }
  });
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('collection.colVisible') || 'null');
      const arr = Array.isArray(raw) ? raw.filter((k: any) => typeof k === 'string') : null;
      return new Set(arr && arr.length ? arr : allKeys);
    } catch { return new Set(allKeys); }
  });
  useEffect(() => { localStorage.setItem('collection.colOrder', JSON.stringify(colOrder)); }, [colOrder]);
  useEffect(() => { localStorage.setItem('collection.colVisible', JSON.stringify(Array.from(visibleKeys))); }, [visibleKeys]);

  const allByKey = useMemo(() => new Map(allColumns.map(c => [c.key, c] as const)), [allColumns]);
  const visibleColumns = useMemo(() => colOrder.filter(k => visibleKeys.has(k)).map(k => allByKey.get(k)!).filter(Boolean), [colOrder, visibleKeys, allByKey]);
  const colTemplate = useMemo(() => visibleColumns.map(c => `${Math.max(60, colW[c.key] ?? c.width)}px`).join(' '), [visibleColumns, colW]);
  const [colDrag, setColDrag] = useState<{ key: string; startX: number; startW: number } | null>(null);
  const [orderDrag, setOrderDrag] = useState<{ key: string; overKey: string; x?: number; y?: number; w?: number; h?: number } | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (colDrag) {
        const dx = e.clientX - colDrag.startX;
        const w = Math.max(60, colDrag.startW + dx);
        setColW(prev => ({ ...prev, [colDrag.key]: w }));
      }
      if (orderDrag) {
        setOrderDrag(prev => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev));
      }
    }
    function onUp() {
      setColDrag(null);
      if (orderDrag) {
        const draggingKey = orderDrag.key;
        const overKey = orderDrag.overKey;
        if (draggingKey && overKey && draggingKey !== overKey) {
          setColOrder(prev => {
            const cur = prev.filter(k => k !== draggingKey);
            const idx = cur.indexOf(overKey);
            if (idx === -1) { cur.push(draggingKey); return cur; }
            cur.splice(idx, 0, draggingKey);
            return cur;
          });
        }
        setOrderDrag(null);
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [colDrag, orderDrag]);

  // Context menu for column toggles
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('mousedown', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('mousedown', close); };
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => (selectedId ? all.find(c => c.id === selectedId) || null : null), [all, selectedId]);

  // --- Draft + save ---
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { setDraft(selected ? toDraft(selected) : null); }, [selectedId]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function handleSave() {
    if (!draft) return;
    setSaving(true); setErr(null); setSaved(false);
    try {
      const card: Card = fromDraft(draft);
      const ok = await (window as any).cards?.update?.(card);
      if (!ok) throw new Error('Write failed');
      setSaved(true);
    } catch (e: any) { setErr(e?.message || 'Failed to save'); } finally { setSaving(false); }
  }

  const layoutHeight = 'calc(100vh - var(--app-header-offset, 64px) - 120px)';

  return (
    <div className="container">
      <div className="card grid" style={{ gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>Collection</h2>
            <div className="sub" style={{ marginTop: 2 }}>{filtered.length} / {all.length} cards</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="button secondary" onClick={() => navigate(-1)} title={`Back${backKeys ? ` (${backKeys})` : ''}`}>Back</button>
          </div>
        </div>

        <div
          ref={shellRef}
          style={{ display: 'flex', alignItems: 'stretch', position: 'relative', height: layoutHeight, minHeight: 360, overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 10 }}
        >
          {/* Left: Filters */}
          <div style={{ width: leftW, minWidth: MIN_SECTION, height: '100%', overflow: 'auto', background: 'var(--surface-1)', borderRight: '1px solid var(--border)' }}>
            <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="text" value={search} onChange={e => setSearch(e.currentTarget.value)} placeholder="Search (e.g. answer: e4, otherAnswers: d4)" style={{ flex: 1, background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
              {search && <button className="button secondary" onClick={() => setSearch('')}>Clear</button>}
            </div>

            <div className="row" style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 700 }}>Decks</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="button secondary" onClick={() => setSelectedDecks(new Set())}>Clear</button>
              </div>
              <div style={{ maxHeight: 360, overflow: 'auto', border: '1px dashed var(--border)', borderRadius: 8 }}>
                <DeckFilterTree selected={selectedDecks} onToggle={(id) => setSelectedDecks(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
              </div>
            </div>

            <div className="row" style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 700 }}>Tags</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {allTags.length === 0 && <div className="sub">No tags</div>}
                {allTags.map(t => (
                  <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 8, padding: '4px 8px' }}>
                    <input type="checkbox" checked={tagSel.has(t)} onChange={() => setTagSel(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; })} />
                    <span>{t}</span>
                  </label>
                ))}
              </div>
              {tagSel.size > 0 && (
                <div>
                  <button className="button secondary" onClick={() => setTagSel(new Set())}>Clear Tags</button>
                </div>
              )}
            </div>

            <div className="row" style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontWeight: 700 }}>States</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(['new','due','scheduled','none'] as CardState[]).map(s => (
                  <label key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 8, padding: '4px 8px' }}>
                    <input type="checkbox" checked={stateSel.has(s)} onChange={() => setStateSel(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; })} />
                    <span>{s}</span>
                  </label>
                ))}
              </div>
              {stateSel.size > 0 && (
                <div>
                  <button className="button secondary" onClick={() => setStateSel(new Set())}>Clear States</button>
                </div>
              )}
            </div>
          </div>

          {/* Resizer 1 */}
          <div onMouseDown={() => setDragging('left')} style={{ width: RESIZER_W, cursor: 'col-resize', height: '100%', background: 'transparent' }} title="Resize filters" />

          {/* Center: Table */}
          <div style={{ width: centerW, minWidth: MIN_SECTION, height: '100%', overflow: 'auto', borderRight: '1px solid var(--border)' }}>
            <div style={{ minWidth: '100%', overflow: 'auto' }}>
              {/* Header with context menu and drag-reorder */}
              {/* Sticky header with full-width divider */}
              <div
                onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
                style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--panel)' }}
              >
                <div style={{ display: 'inline-block' }}>
                  <div
                    ref={headerRef}
                    style={{ display: 'grid', gridTemplateColumns: colTemplate }}
                  >
                    {visibleColumns.map((col, i) => (
                      <div
                        key={col.key}
                        data-colkey={col.key}
                        onMouseEnter={() => { if (orderDrag) setOrderDrag(prev => prev ? { ...prev, overKey: col.key } : prev); }}
                        style={{ position: 'relative', padding: '8px 8px', fontWeight: 700, userSelect: 'none', borderRight: i < visibleColumns.length - 1 ? '1px solid var(--border)' : undefined, borderLeft: (orderDrag && orderDrag.overKey === col.key) ? '2px solid var(--accent)' : undefined }}
                      >
                        <span
                          className="col-label"
                          onMouseDown={(e) => {
                            if (e.button === 0) {
                              const el = e.currentTarget as HTMLElement;
                              setOrderDrag({ key: col.key, overKey: col.key, x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight });
                            }
                          }}
                          title="Drag to reorder"
                          style={{ cursor: 'grab' }}
                        >
                          {col.label}
                        </span>
                        {i < visibleColumns.length - 1 && (
                          <div
                            onMouseDown={e => { e.stopPropagation(); setColDrag({ key: col.key, startX: e.clientX, startW: (colW[col.key] ?? col.width) }); }}
                            style={{ position: 'absolute', top: 0, right: -3, width: 6, height: '100%', cursor: 'col-resize' }}
                            title={`Resize ${col.label}`}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Drag ghost */}
              {orderDrag && typeof orderDrag.x === 'number' && typeof orderDrag.y === 'number' && (
                <div style={{ position: 'fixed', left: orderDrag.x + 8, top: orderDrag.y + 8, pointerEvents: 'none', background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', boxShadow: '0 6px 16px rgba(0,0,0,0.25)', opacity: 0.9 }}>
                  <div style={{ fontWeight: 700 }}>{allByKey.get(orderDrag.key)?.label || orderDrag.key}</div>
                </div>
              )}

              {/* Body */}
              <div>
                {filtered.map(c => (
                  <div key={c.id} onClick={() => setSelectedId(c.id)} style={{ display: 'grid', gridTemplateColumns: colTemplate, background: selectedId === c.id ? 'rgba(91,140,255,0.12)' : 'transparent', cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                    {visibleColumns.map((col, i) => (
                      <div key={col.key} style={{ padding: '8px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRight: i < visibleColumns.length - 1 ? '1px solid var(--border)' : undefined }}>{col.render(c)}</div>
                    ))}
                  </div>
                ))}
                {filtered.length === 0 && <div className="sub" style={{ padding: 12 }}>No matching cards.</div>}
              </div>
            </div>

            {/* Context menu */}
            {menu && (
              <div style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 10, background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 8, boxShadow: '0 6px 16px rgba(0,0,0,0.25)' }} onMouseDown={e => e.stopPropagation()}>
                <div className="sub" style={{ marginBottom: 6 }}>Columns</div>
                {allColumns.map(c => {
                  const checked = visibleKeys.has(c.key);
                  return (
                    <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setVisibleKeys(prev => {
                            const next = new Set(prev);
                            if (next.has(c.key)) {
                              if (next.size <= 1) return next; // keep at least one column
                              next.delete(c.key);
                            } else next.add(c.key);
                            return next;
                          });
                        }}
                      />
                      <span>{c.label}</span>
                    </label>
                  );
                })}
                <div style={{ height: 8 }} />
                <button className="button secondary" onClick={() => { setVisibleKeys(new Set(allKeys)); setColOrder(allKeys); setMenu(null); }}>Reset</button>
              </div>
            )}
          </div>

          {/* Resizer 2 */}
          <div onMouseDown={() => setDragging('center')} style={{ width: RESIZER_W, cursor: 'col-resize', height: '100%', background: 'transparent' }} title="Resize table" />

          {/* Right: Preview */}
          <div style={{ flex: 1, minWidth: MIN_SECTION, height: '100%', overflow: 'auto' }}>
            {!selected ? (
              <div className="sub" style={{ padding: 12 }}>Select a card to preview and edit.</div>
            ) : (
              <div className="grid" style={{ padding: 8 }}>
                <div className="row" style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontWeight: 700 }}>Preview</div>
                  <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
                    {(() => {
                      // Build frames: initial -> moveSequence -> review FEN -> exampleLine
                      const seqSans = pgnToSanArray(selected.fields.moveSequence);
                      const seqChess = new Chess();
                      const frames: string[] = [seqChess.fen()];
                      const moves: any[] = [null];
                      for (const san of seqSans) {
                        const mv = seqChess.move(san);
                        if (!mv) break;
                        frames.push(seqChess.fen());
                        moves.push({ from: mv.from, to: mv.to, san: mv.san });
                      }
                      // Ensure review FEN is present
                      let reviewIndex = frames.findIndex(f => f === selected.fields.fen);
                      if (reviewIndex === -1) {
                        frames.push(selected.fields.fen);
                        moves.push(null);
                        reviewIndex = frames.length - 1;
                      }
                      // Append example line from review position
                      const exChess = new Chess(selected.fields.fen);
                      for (const san of (selected.fields.exampleLine || [])) {
                        const mv = exChess.move(san);
                        if (!mv) break;
                        frames.push(exChess.fen());
                        moves.push({ from: mv.from, to: mv.to, san: mv.san });
                      }

                      const answerSan = selected.fields.answer;
                      const labelForIndex = (idx: number, moveSan: string | null) => {
                        if (idx === 0) return 'Initial Position';
                        if (idx < reviewIndex) return moveSan ? `Move Sequence - Move: ${moveSan}` : '';
                        if (idx === reviewIndex) return moveSan ? `Review Position - Move: ${moveSan}` : 'Review Position';
                        if (moveSan && moveSan === answerSan) return `Answer - Move: ${moveSan}`;
                        return moveSan ? `Example Line - Move: ${moveSan}` : '';
                      };
                      return (
                        <BoardPlayer
                          key={`preview-${selected.id}`}
                          mode="frames"
                          frames={frames}
                          frameMoves={moves}
                          startIndex={reviewIndex}
                          size={360}
                          orientation={isBlackDeckId(selected.deck) ? 'black' : 'white'}
                          showMoveLabel={true}
                          labelForIndex={labelForIndex}
                        />
                      );
                    })()}
                  </div>
                  <div className="sub" style={{ textAlign: 'center' }}>
                    Best: <strong>{selected.fields.answer || '(unknown)'}</strong>
                    {selected.fields.eval ? (<><span> </span>•<span> </span>Eval: <strong>{formatEvalWhiteCentric(selected.fields.eval as any, selected.fields.fen)}</strong></>) : null}
                  </div>
                </div>

                {draft && (
                  <div className="row" style={{ display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ fontWeight: 700 }}>Edit Fields</div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {saved && <div className="sub" aria-live="polite">Saved</div>}
                        {err && <div className="sub" style={{ color: 'var(--danger, #ff6b6b)' }}>{err}</div>}
                        <button className="button secondary" onClick={() => setDraft(toDraft(selected))}>Revert</button>
                        <button className="button" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                        <button className="button secondary" onClick={() => navigate(`/edit/${selected.id}`, { state: { card: selected } })}>Open Full Editor</button>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>ID</div>
                      <input type="text" readOnly value={draft.id} style={{ background: '#eaeaea', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>Deck</div>
                      <input type="text" value={draft.deck} onChange={e => setDraft(p => ({ ...p!, deck: e.currentTarget.value }))} style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>Tags</div>
                      <input type="text" value={draft.tags} onChange={e => setDraft(p => ({ ...p!, tags: e.currentTarget.value }))} placeholder="comma,separated,tags" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>Due</div>
                      <input type="text" value={draft.due} onChange={e => setDraft(p => ({ ...p!, due: e.currentTarget.value }))} placeholder="new or 2025-01-01T00:00:00.000Z" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>

                    <div style={{ fontWeight: 700, marginTop: 4 }}>Fields</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10 }}>
                      <div>Move Sequence (PGN)</div>
                      <textarea rows={2} value={draft.fields.moveSequence} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, moveSequence: e.currentTarget.value } }))} style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>Review FEN</div>
                      <input type="text" value={draft.fields.fen} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, fen: e.currentTarget.value } }))} style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>Answer (SAN)</div>
                      <input type="text" value={draft.fields.answer} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, answer: e.currentTarget.value } }))} style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>Answer FEN</div>
                      <input type="text" value={draft.fields.answerFen} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, answerFen: e.currentTarget.value } }))} placeholder="optional" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr 1fr', gap: 10, alignItems: 'center' }}>
                      <div>Eval</div>
                      <select value={draft.fields.evalKind} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, evalKind: e.currentTarget.value as EvalKind } }))} style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}>
                        <option value="cp">cp</option>
                        <option value="mate">mate</option>
                      </select>
                      <input type="text" inputMode="numeric" value={draft.fields.evalValue} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, evalValue: e.currentTarget.value } }))} placeholder="value" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', minWidth: '70px' }} />
                      <input type="text" inputMode="numeric" value={draft.fields.evalDepth} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, evalDepth: e.currentTarget.value } }))} placeholder="depth" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', minWidth: '70px' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10 }}>
                      <div>Example Line (SAN)</div>
                      <textarea rows={2} value={draft.fields.exampleLine} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, exampleLine: e.currentTarget.value } }))} placeholder="e4 e5 Nf3 Nc6 ..." style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10 }}>
                      <div>Other Answers (SAN)</div>
                      <textarea rows={2} value={draft.fields.otherAnswers} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, otherAnswers: e.currentTarget.value } }))} placeholder="Nf3 c4 g3" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10 }}>
                      <div>Sibling Answers (SAN)</div>
                      <textarea rows={2} value={draft.fields.siblingAnswers} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, siblingAnswers: e.currentTarget.value } }))} placeholder="moves equivalent to best" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }} />
                    </div>
                    <div style={{ fontWeight: 700 }}>Lineage</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>depth</div>
                      <input type="text" inputMode="numeric" value={draft.fields.depth} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, depth: e.currentTarget.value } }))} placeholder="required int (move number)" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                      <div>parent</div>
                      <input type="text" value={draft.fields.parent} onChange={e => setDraft(p => ({ ...p!, fields: { ...p!.fields, parent: e.currentTarget.value } }))} placeholder="optional (card id)" style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
