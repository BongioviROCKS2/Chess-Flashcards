import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Card } from '../data/types';
import cardsRaw from '../data/cards.json?raw';
import { Chess } from 'chess.js';
import BoardPlayer from '../components/BoardPlayer';
import { useBackKeybind } from '../hooks/useBackKeybind';
import {
  Deck,
  getRootDecks,
  getChildrenOf,
  getDescendantDeckIds,
} from '../decks';

declare global {
  interface Window {
    cards?: {
      readOne?: (id: string) => Promise<Card | null>;
      update?: (card: Card) => Promise<boolean>;
      create?: (card: Card) => Promise<boolean>;
    };
  }
}

/* =========================
   Local helpers / utilities
   ========================= */

function safeParseCards(raw: string): Card[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeText(s: unknown): string {
  return (s ?? '').toString().toLowerCase();
}

function fmtDue(due: Card['due']): string {
  if (!due) return '';
  if (due === 'new') return 'New';
  const d = new Date(due);
  return isNaN(d.getTime()) ? String(due) : d.toLocaleString();
}

function fmtEval(card: Card): string {
  const e = (card as any)?.fields?.eval;
  if (!e) return '';
  if (e.kind === 'mate') return `#${e.value}${e.depth ? ` (d${e.depth})` : ''}`;
  if (e.kind === 'cp') return `${(e.value / 100).toFixed(2)}${e.depth ? ` (d${e.depth})` : ''}`;
  return '';
}

function uniqueSorted<T>(arr: T[]): T[] {
  return Array.from(new Set(arr)).sort((a, b) => String(a).localeCompare(String(b)));
}

function cardToSearchHaystack(c: Card): string {
  const chunks: string[] = [];
  chunks.push(c.id ?? '');
  chunks.push(c.deck ?? '');
  chunks.push((c.tags ?? []).join(' '));
  chunks.push((c.fields as any)?.moveSequence ?? '');
  chunks.push((c.fields as any)?.answer ?? '');
  chunks.push((c.fields as any)?.fen ?? '');
  chunks.push((c.fields as any)?.answerFen ?? '');
  chunks.push(((c.fields as any)?.exampleLine ?? []).join(' '));
  chunks.push(((c.fields as any)?.otherAnswers ?? []).join(' '));
  chunks.push(fmtEval(c));
  return normalizeText(chunks.join(' | '));
}

/* =========================
   Filters / columns
   ========================= */

type DueFilter = 'all' | 'new' | 'overdue' | 'notDue' | 'dueBy';

interface Filters {
  deckIds: Set<string>;
  tags: Set<string>;
  due: DueFilter;
  dueBy?: string; // ISO yyyy-mm-dd
}

const initialFilters: Filters = {
  deckIds: new Set<string>(),
  tags: new Set<string>(),
  due: 'all',
};

type ColumnKey =
  | 'deck'
  | 'due'
  | 'depth'
  | 'pgn'
  | 'id'
  | 'tags'
  | 'answer'
  | 'eval'
  | 'fen'
  | 'answerFen'
  | 'exampleLine'
  | 'otherAnswers'
  | 'parent'
  | 'children'
  | 'descendants';

const ALL_COLUMNS: Record<ColumnKey, { label: string; width?: number }> = {
  deck: { label: 'Deck', width: 200 },
  due: { label: 'Due Date', width: 160 },
  depth: { label: 'Depth', width: 90 },
  pgn: { label: 'PGN', width: 360 },
  id: { label: 'ID', width: 220 },
  tags: { label: 'Tags', width: 220 },
  answer: { label: 'Answer', width: 160 },
  eval: { label: 'Eval', width: 140 },
  fen: { label: 'FEN', width: 320 },
  answerFen: { label: 'Answer FEN', width: 320 },
  exampleLine: { label: 'Example Line', width: 320 },
  otherAnswers: { label: 'Other Answers', width: 260 },
  parent: { label: 'Parent', width: 220 },
  children: { label: 'Children', width: 160 },
  descendants: { label: 'Descendants', width: 160 },
};

const DEFAULT_COLUMNS: ColumnKey[] = ['deck', 'due', 'depth', 'pgn'];

/* =========================
   Right editor (EditCardPage parity)
   ========================= */

type EvalKind = 'cp' | 'mate';
type Draft = {
  id: string;
  deck: string;
  tags: string; // comma-separated
  due: string; // 'new' | ISO | ''
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
    depth: string;
    parent: string;
  };
  roChildren: string;
  roDescendants: string;
};

function arrToLine(a?: string[] | null): string {
  return (a ?? []).join(' ');
}
function lineToArr(s: string): string[] {
  return s.split(/\s+/).map(t => t.trim()).filter(Boolean);
}
function tagsToLine(tags?: string[]): string {
  return (tags ?? []).join(', ');
}
function lineToTags(s: string): string[] {
  return s.split(',').map(t => t.trim()).filter(Boolean);
}
function toDraft(c: Card): Draft {
  const f: any = c.fields || {};
  return {
    id: c.id,
    deck: c.deck,
    tags: tagsToLine(c.tags),
    due: (c as any).due ?? '',
    fields: {
      moveSequence: f.moveSequence || '',
      fen: f.fen || '',
      answer: f.answer || '',
      answerFen: f.answerFen || '',
      evalKind: (f.eval?.kind ?? 'cp') as EvalKind,
      evalValue: String(f.eval?.value ?? ''),
      evalDepth: String(f.eval?.depth ?? ''),
      exampleLine: arrToLine(f.exampleLine),
      otherAnswers: arrToLine(f.otherAnswers),
      depth: String(f.depth ?? ''),
      parent: f.parent ?? '',
    },
    roChildren: (f.children ?? []).join(' '),
    roDescendants: (f.descendants ?? []).join(' '),
  };
}
function fromDraft(d: Draft, base: Card | null): Card {
  const depthNum = (() => {
    const raw = (d.fields.depth ?? '').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  })();
  const evalField =
    d.fields.evalValue !== ''
      ? {
          kind: d.fields.evalKind,
          value: Number(d.fields.evalValue),
          ...(d.fields.evalDepth !== '' ? { depth: Number(d.fields.evalDepth) } : {}),
        }
      : undefined;
  const fbase: any = base?.fields || {};
  const updated: Card = {
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
      depth: depthNum,
      parent: d.fields.parent || undefined,
      children: fbase.children,
      descendants: fbase.descendants,
    },
    ...(d.due === '' ? {} : { due: d.due as any }),
  };
  return updated;
}

/* =========================
   Component
   ========================= */

export default function CollectionPage() {
  const navigate = useNavigate();
  const goBack = () => navigate('/');
  useBackKeybind(goBack, true);

  const [allCards, setAllCards] = useState<Card[]>(() => safeParseCards(cardsRaw));

  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [columns, setColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [query, setQuery] = useState('');
  // Keep deck tree expand/collapse stable across re-renders (e.g., resizing)
  const [openDeckIds, setOpenDeckIds] = useState<Set<string>>(() => new Set(getRootDecks().map(d => d.id)));
  const isDeckOpen = (id: string) => openDeckIds.has(id);
  const toggleDeckOpen = (id: string, open?: boolean) => {
    setOpenDeckIds(prev => {
      const next = new Set(prev);
      const willOpen = open === undefined ? !next.has(id) : open;
      if (willOpen) next.add(id); else next.delete(id);
      return next;
    });
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedCard = useMemo(
    () => (selectedId ? allCards.find(c => c.id === selectedId) ?? null : null),
    [selectedId, allCards]
  );

  const [draft, setDraft] = useState<Draft | null>(selectedCard ? toDraft(selectedCard) : null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedCard) {
      setDraft(null);
      setSaved(false);
      setError(null);
      return;
    }
    setDraft(toDraft(selectedCard));
    setSaved(false);
    setError(null);
  }, [selectedCard]);

  // Pane sizes (persist)
  const [leftW, setLeftW] = useState(() => Number(localStorage.getItem('collection.leftW') ?? 260));
  const [rightW, setRightW] = useState(() => Number(localStorage.getItem('collection.rightW') ?? 420));
  const [rightTopH, setRightTopH] = useState(() => Number(localStorage.getItem('collection.rightTopH') ?? 340));
  useEffect(() => localStorage.setItem('collection.leftW', String(leftW)), [leftW]);
  useEffect(() => localStorage.setItem('collection.rightW', String(rightW)), [rightW]);
  useEffect(() => localStorage.setItem('collection.rightTopH', String(rightTopH)), [rightTopH]);

  // Keep pane sizes within container bounds on window resize
  useEffect(() => {
    const enforceBounds = () => {
      const containerW = bodyRef.current?.clientWidth ?? window.innerWidth;
      const minLeft = 180;
      const minCenter = 300;
      const minRight = 360;
      const splitters = 12; // two vertical splitters

      // Adjust left/right if they no longer fit
      const maxLeft = Math.max(minLeft, containerW - rightW - minCenter - splitters);
      if (leftW > maxLeft) setLeftW(maxLeft);

      const maxRight = Math.max(minRight, containerW - (leftW) - minCenter - splitters);
      if (rightW > maxRight) setRightW(maxRight);

      const containerH = rightPaneRef.current?.clientHeight ?? (bodyRef.current?.clientHeight ?? window.innerHeight);
      const minTop = 160;
      const minBottom = 240;
      const splitterH = 6;
      const maxTop = Math.max(minTop, containerH - splitterH - minBottom);
      if (rightTopH > maxTop) setRightTopH(maxTop);
    };
    // Run once and on resize
    enforceBounds();
    window.addEventListener('resize', enforceBounds);
    return () => window.removeEventListener('resize', enforceBounds);
  }, [leftW, rightW, rightTopH]);

  /* ============
     Column picker (single)
     ============ */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function openColumnPicker(e: React.MouseEvent) {
    e.preventDefault();
    setPickerPos({ x: e.clientX, y: e.clientY });
    setPickerOpen(true);
  }
  function toggleColumn(col: ColumnKey) {
    setColumns(prev => (prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]));
  }

  /* ============
     Tag / due helpers
     ============ */
  function setTagFilter(tag: string, checked: boolean) {
    setFilters(f => {
      const next = new Set(f.tags);
      if (checked) next.add(tag);
      else next.delete(tag);
      return { ...f, tags: next };
    });
  }
  function setDueFilter(df: DueFilter) {
    setFilters(f => ({ ...f, due: df }));
  }
  function setDueBy(dateStr: string) {
    setFilters(f => ({ ...f, dueBy: dateStr || undefined }));
  }

  // Facets
  const tagOptions = useMemo(() => uniqueSorted(allCards.flatMap(c => c.tags || [])), [allCards]);

  // Deck selection includes descendants
  const expandedSelectedDeckIds = useMemo(() => {
    const out = new Set<string>();
    for (const id of filters.deckIds) {
      out.add(id);
      for (const d of getDescendantDeckIds(id)) out.add(d);
    }
    return out;
  }, [filters.deckIds]);

  const filtered = useMemo(() => {
    const q = normalizeText(query).trim();
    const now = Date.now();
    const dueByMs =
      filters.due === 'dueBy' && filters.dueBy
        ? new Date(filters.dueBy + 'T23:59:59').getTime()
        : null;

    return allCards.filter(c => {
      if (expandedSelectedDeckIds.size) {
        if (!c.deck || !expandedSelectedDeckIds.has(c.deck)) return false;
      }
      if (filters.tags.size) {
        const ct = new Set(c.tags || []);
        for (const t of filters.tags) {
          if (!ct.has(t)) return false;
        }
      }
      if (filters.due !== 'all') {
        if (filters.due === 'new') {
          if (c.due !== 'new') return false;
        } else if (filters.due === 'overdue') {
          if (typeof c.due !== 'string') return false;
          const d = new Date(c.due).getTime();
          if (!(d && d < now)) return false;
        } else if (filters.due === 'notDue') {
          if (typeof c.due !== 'string') return false;
          const d = new Date(c.due).getTime();
          if (!(d && d >= now)) return false;
        } else if (filters.due === 'dueBy') {
          if (!dueByMs || typeof c.due !== 'string') return false;
          const d = new Date(c.due).getTime();
          if (!(d && d <= dueByMs)) return false;
        }
      }
      if (q) {
        const hay = cardToSearchHaystack(c);
        for (const t of q.split(/\s+/).filter(Boolean)) {
          if (!hay.includes(t)) return false;
        }
      }
      return true;
    });
  }, [allCards, filters, query, expandedSelectedDeckIds]);

  /* ============
     Resizers
     ============ */

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);

  type DragKind = 'left' | 'right' | 'rightInner';
  const dragRef = useRef<{
    kind: DragKind;
    startX: number;
    startY: number;
    startLeft: number;
    startRight: number;
    startRightTop: number;
    containerW: number;
    containerH: number;
  } | null>(null);

  function onStartDrag(kind: DragKind, e: React.MouseEvent) {
    e.preventDefault();
    const containerW = bodyRef.current?.clientWidth ?? window.innerWidth;
    const containerH = rightPaneRef.current?.clientHeight ?? (bodyRef.current?.clientHeight ?? window.innerHeight);
    dragRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: leftW,
      startRight: rightW,
      startRightTop: rightTopH,
      containerW,
      containerH,
    };
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', onStopDrag);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = kind === 'rightInner' ? 'row-resize' : 'col-resize';
  }

  function onDrag(e: MouseEvent) {
    const st = dragRef.current;
    if (!st) return;

    if (st.kind === 'left') {
      const delta = e.clientX - st.startX;
      const minLeft = 180;
      const minCenter = 300;
      const splitters = 12; // two vertical splitters
      const maxLeft = Math.max(minLeft, st.containerW - st.startRight - minCenter - splitters);
      const next = Math.max(minLeft, Math.min(st.startLeft + delta, maxLeft));
      setLeftW(next);
    } else if (st.kind === 'right') {
      const delta = st.startX - e.clientX;
      const minRight = 360;
      const minCenter = 300;
      const splitters = 12; // two vertical splitters
      const maxRight = Math.max(minRight, st.containerW - leftW - minCenter - splitters);
      const next = Math.max(minRight, Math.min(st.startRight + delta, maxRight));
      setRightW(next);
    } else if (st.kind === 'rightInner') {
      const deltaY = e.clientY - st.startY;
      const minTop = 160;
      const minBottom = 240;
      const splitterH = 6;
      const maxTop = Math.max(minTop, st.containerH - splitterH - minBottom);
      const next = Math.max(minTop, Math.min(st.startRightTop + deltaY, maxTop));
      setRightTopH(next);
    }
  }

  function onStopDrag() {
    dragRef.current = null;
    window.removeEventListener('mousemove', onDrag);
    window.removeEventListener('mouseup', onStopDrag);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }

  /* ============
     Deck tree filter (canonical)
     ============ */

  function DeckTreeFilter({
    node,
    depth,
  }: {
    node: Deck;
    depth: number;
  }) {
    const children = getChildrenOf(node.id);
    const hasKids = children.length > 0;
    const open = isDeckOpen(node.id);
    const checked = filters.deckIds.has(node.id);

    function onToggle(checkedNow: boolean) {
      setFilters(f => {
        const next = new Set(f.deckIds);
        if (checkedNow) next.add(node.id);
        else next.delete(node.id);
        return { ...f, deckIds: next };
      });
    }

    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', marginLeft: depth * 12 }}>
          {hasKids ? (
            <button
              className="button secondary"
              style={{ padding: '0 6px', height: 20, lineHeight: '18px' }}
              onClick={() => toggleDeckOpen(node.id)}
              title={open ? 'Collapse' : 'Expand'}
            >
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span style={{ display: 'inline-block', width: 18 }} />
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onToggle(e.currentTarget.checked)}
            />
            <span>{node.name}</span>
          </label>
        </div>
        {open && hasKids && (
          <div>
            {children.map(child => (
              <DeckTreeFilter key={child.id} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ============
     Table cell renderer
     ============ */

  function renderCell(col: ColumnKey, c: Card) {
    const f: any = c.fields || {};
    switch (col) {
      case 'deck': return c.deck || '';
      case 'due': return fmtDue((c as any).due);
      case 'depth': return f.depth ?? '';
      case 'pgn': return f.moveSequence ?? '';
      case 'id': return c.id ?? '';
      case 'tags': return (c.tags || []).join(', ');
      case 'answer': return f.answer ?? '';
      case 'eval': return fmtEval(c);
      case 'fen': return f.fen ?? '';
      case 'answerFen': return f.answerFen ?? '';
      case 'exampleLine': return (f.exampleLine || []).join(' ');
      case 'otherAnswers': return (f.otherAnswers || []).join(' ');
      case 'parent': return f.parent ?? '';
      case 'children': return (f.children || []).length ? String((f.children || []).length) : '';
      case 'descendants': return (f.descendants || []).length ? String((f.descendants || []).length) : '';
      default: return '';
    }
  }

  /* ============
     Board preview frames
     ============ */

  const boardData = useMemo(() => {
    if (!selectedCard) return null;
    try {
      const frames: string[] = [];
      const f: any = selectedCard.fields || {};
      const pgn = f.moveSequence || '';

      // Build front frames
      if (pgn?.trim()) {
        const tmp = new Chess();
        tmp.loadPgn(pgn);
        const sans = tmp.history();
        const step = new Chess();
        frames.push(step.fen());
        for (const san of sans) {
          try { step.move(san); frames.push(step.fen()); } catch { /* ignore */ }
        }
      } else {
        const start = new Chess();
        frames.push(start.fen());
      }

      // Ensure review FEN exists
      let reviewIdx = frames.length - 1;
      if (f.fen) {
        const idx = frames.findIndex(F => F === f.fen);
        if (idx >= 0) reviewIdx = idx;
        else { frames.push(f.fen); reviewIdx = frames.length - 1; }
      }

      // Answer + example line
      let startIndex = reviewIdx;
      if (f.answer) {
        const back = new Chess(frames[reviewIdx]);
        try {
          back.move(f.answer);
          frames.splice(reviewIdx + 1, 0, back.fen());
          startIndex = reviewIdx + 1;
          for (const san of (f.exampleLine || []) as string[]) {
            try { back.move(san); frames.push(back.fen()); } catch {}
          }
        } catch {}
      }

      // Orientation rule
      const orientation: 'white' | 'black' =
        /^black($|[-/])/i.test(selectedCard.deck || '') ? 'black' : 'white';

      return { frames, startIndex, orientation };
    } catch {
      return null;
    }
  }, [selectedCard]);

  /* ============
     Save (EditCardPage semantics)
     ============ */

  async function handleSave() {
    if (!draft) return;
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = fromDraft(draft, selectedCard);
      const ok = (await window.cards?.update?.(updated)) ?? false;
      if (!ok) throw new Error('Write failed');

      setAllCards(prev => {
        const copy = prev.slice();
        const idx = copy.findIndex(c => c.id === updated.id);
        if (idx >= 0) copy[idx] = updated;
        return copy;
      });
      setSaved(true);
    } catch (e: any) {
      setError(e?.message || 'Failed to save card');
    } finally {
      setSaving(false);
    }
  }

  /* ============
     Layout styles
     ============ */

  const pageWrap: React.CSSProperties = {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  };
  const headerRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderBottom: '1px solid var(--border, #333)',
    justifyContent: 'space-between'
  };
  const bodyRow: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    alignItems: 'stretch',
    gap: 0,
  };
  const paneCommon: React.CSSProperties = {
    borderRight: '1px solid var(--border, #333)',
    background: 'var(--bg, #0b0f12)',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  };
  const leftPaneStyle: React.CSSProperties = { ...paneCommon, width: leftW, flex: '0 0 auto', borderLeft: '1px solid var(--border, #333)' };
  const centerPaneStyle: React.CSSProperties = { ...paneCommon, flex: 1 };
  const centerScroll: React.CSSProperties = { flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'auto' };
  const rightPaneStyle: React.CSSProperties = { ...paneCommon, width: rightW, flex: '0 0 auto' };
  const vSplitter: React.CSSProperties = {
    width: 6,
    flex: '0 0 6px',
    cursor: 'col-resize',
    background: 'transparent',
    borderRight: '1px solid var(--border, #333)',
  };
  const sectionTitle: React.CSSProperties = {
    padding: 12,
    borderBottom: '1px solid var(--border, #333)',
    fontWeight: 600,
    position: 'sticky',
    top: 0,
    background: 'var(--bg, #0b0f12)',
    zIndex: 1,
  };
  const rightTopStyle: React.CSSProperties = {
    height: rightTopH,
    minHeight: 160,
    flex: '0 0 auto',
    borderBottom: '1px solid var(--border, #333)',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  };
  const hSplitter: React.CSSProperties = {
    height: 6,
    flex: '0 0 6px',
    cursor: 'row-resize',
    borderBottom: '1px solid var(--border, #333)',
    background: 'transparent',
  };
  const rightBottomStyle: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };

  /* ============
     Render
     ============ */

  return (
    <div className="page" style={pageWrap}>
      <div style={headerRow}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Collection</div>
        <button className="button secondary" onClick={goBack}>Back</button>
      </div>

      <div style={bodyRow} ref={bodyRef}>
        {/* LEFT: Filters */}
        <div style={leftPaneStyle}>
          <div style={sectionTitle}>Filters</div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Decks */}
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Decks</div>
              <div>
                {getRootDecks().map(root => (
                  <DeckTreeFilter key={root.id} node={root} depth={0} />
                ))}
              </div>
            </div>

            {/* Tags */}
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Tags</div>
              <div style={{ maxHeight: 220, overflow: 'auto', paddingRight: 6 }}>
                {tagOptions.map(t => (
                  <label key={t} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      type="checkbox"
                      checked={filters.tags.has(t)}
                      onChange={(e) => setTagFilter(t, e.currentTarget.checked)}
                    />
                    <span>{t}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Due */}
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Due</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(['all', 'new', 'overdue', 'notDue', 'dueBy'] as DueFilter[]).map(df => (
                  <label key={df} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="radio"
                      name="dueFilter"
                      checked={filters.due === df}
                      onChange={() => setDueFilter(df)}
                    />
                    <span style={{ textTransform: 'capitalize' }}>{df === 'dueBy' ? 'Due by…' : df}</span>
                  </label>
                ))}
                {filters.due === 'dueBy' && (
                  <input
                    type="date"
                    value={filters.dueBy || ''}
                    onChange={(e) => setDueBy(e.currentTarget.value)}
                    style={{ marginLeft: 24 }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Splitter */}
        <div style={vSplitter} onMouseDown={(e) => onStartDrag('left', e)} />

        {/* CENTER: table */}
        <div style={centerPaneStyle}>
          <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border, #333)', position: 'sticky', top: 0, background: 'var(--bg, #0b0f12)', zIndex: 2 }}>
            <input
              type="text"
              placeholder="Search (deck, tags, PGN, answer, FEN, etc.)"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border, #333)', borderRadius: 6, background: 'transparent', outline: 'none' }}
            />
            <div style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>{filtered.length} / {allCards.length}</div>
          </div>

          <div style={centerScroll}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: columns.map(c => `${ALL_COLUMNS[c].width ?? 200}px`).join(' '),
                borderBottom: '1px solid var(--border, #333)',
                userSelect: 'none',
                fontWeight: 600,
                position: 'sticky',
                top: 0,
                background: 'var(--bg, #0b0f12)',
                zIndex: 1,
              }}
              onContextMenu={openColumnPicker}
              title="Right-click to choose columns"
            >
              {columns.map((c) => (
                <div key={c} style={{ padding: '8px 10px' }}>{ALL_COLUMNS[c].label}</div>
              ))}
            </div>

            <div>
              {filtered.map(c => {
                const selected = c.id === selectedId;
                return (
                  <div
                    key={c.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: columns.map(col => `${ALL_COLUMNS[col].width ?? 200}px`).join(' '),
                      borderBottom: '1px solid var(--border, #222)',
                      background: selected ? 'rgba(100,150,255,0.12)' : 'transparent',
                      cursor: 'pointer',
                    }}
                    onClick={() => setSelectedId(c.id!)}
                    onDoubleClick={() => setSelectedId(c.id!)}
                  >
                    {columns.map(col => (
                      <div key={col} style={{ padding: '6px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {renderCell(col, c)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          {pickerOpen && (
            <div
              ref={pickerRef}
              style={{
                position: 'fixed',
                left: pickerPos.x,
                top: pickerPos.y,
                background: 'var(--bg, #0b0f12)',
                border: '1px solid var(--border, #333)',
                borderRadius: 8,
                padding: 8,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 4,
                zIndex: 9999,
                boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
                minWidth: 360,
              }}
            >
              {(Object.keys(ALL_COLUMNS) as ColumnKey[]).map(col => (
                <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px' }}>
                  <input
                    type="checkbox"
                    checked={columns.includes(col)}
                    onChange={() => toggleColumn(col)}
                  />
                  <span>{ALL_COLUMNS[col].label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Splitter */}
        <div style={vSplitter} onMouseDown={(e) => onStartDrag('right', e)} />

        {/* RIGHT: Preview + Editor */}
        <div style={rightPaneStyle} ref={rightPaneRef}>
          <div style={rightTopStyle}>
            <div style={sectionTitle}>Preview</div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }}>
              {!selectedCard || !boardData ? (
                <div style={{ opacity: 0.7 }}>Select a card to preview its positions.</div>
              ) : (
                <BoardPlayer
                  mode="frames"
                  frames={boardData.frames}
                  startIndex={boardData.startIndex}
                  orientation={boardData.orientation}
                />
              )}
            </div>
          </div>

          <div style={hSplitter} onMouseDown={(e) => onStartDrag('rightInner', e)} />

          <div style={rightBottomStyle}>
            <div style={sectionTitle}>{selectedCard ? 'Edit Card' : 'Details'}</div>
            {!selectedCard || !draft ? (
              <div style={{ padding: 12, opacity: 0.7 }}>Select a card to view and edit its details.</div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <div className="card grid" style={{ gap: 12, border: 0, background: 'transparent', boxShadow: 'none', padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div className="sub" aria-live="polite" style={{ visibility: saved ? 'visible' : 'hidden' }}>
                      Saved
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {error && <div className="sub" style={{ color: 'var(--danger, #ff6b6b)' }}>{error}</div>}
                      <button className="button" onClick={handleSave} disabled={saving} title="Save (Ctrl+S)">
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>

                  {/* ID */}
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
                      onChange={e => setDraft(d => d ? { ...d, deck: e.currentTarget.value } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                    />
                  </div>

                  {/* Tags */}
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
                    <div>Tags</div>
                    <input
                      type="text"
                      value={draft.tags}
                      onChange={e => setDraft(d => d ? { ...d, tags: e.currentTarget.value } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                      placeholder="comma,separated,tags"
                    />
                  </div>

                  {/* Due */}
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
                    <div>Due</div>
                    <input
                      type="text"
                      value={draft.due}
                      onChange={e => setDraft(d => d ? { ...d, due: e.currentTarget.value } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                      placeholder="new or 2025-01-01T00:00:00.000Z"
                    />
                  </div>

                  {/* Fields header */}
                  <div style={{ fontWeight: 600, fontSize: 18, opacity: 0.95, marginTop: 8 }}>
                    Fields
                  </div>

                  {/* Move Sequence */}
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
                    <div>Move Sequence (PGN)</div>
                    <textarea
                      value={draft.fields.moveSequence}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, moveSequence: e.currentTarget.value } } : d)}
                      rows={3}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }}
                    />
                  </div>

                  {/* Review FEN */}
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
                    <div>Review FEN</div>
                    <input
                      type="text"
                      value={draft.fields.fen}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, fen: e.currentTarget.value } } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                    />
                  </div>

                  {/* Answer */}
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
                    <div>Answer (SAN)</div>
                    <input
                      type="text"
                      value={draft.fields.answer}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, answer: e.currentTarget.value } } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                    />
                  </div>

                  {/* Answer FEN */}
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
                    <div>Answer FEN</div>
                    <input
                      type="text"
                      value={draft.fields.answerFen}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, answerFen: e.currentTarget.value } } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                      placeholder="optional"
                    />
                  </div>

                  {/* Eval */}
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr 1fr', gap: 12, alignItems: 'center' }}>
                    <div>Eval</div>
                    <select
                      value={draft.fields.evalKind}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, evalKind: e.currentTarget.value as EvalKind } } : d)}
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
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, evalValue: e.currentTarget.value } } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="depth"
                      value={draft.fields.evalDepth}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, evalDepth: e.currentTarget.value } } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                    />
                  </div>

                  {/* exampleLine & otherAnswers */}
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
                    <div>Example Line (SAN)</div>
                    <textarea
                      value={draft.fields.exampleLine}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, exampleLine: e.currentTarget.value } } : d)}
                      rows={2}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }}
                      placeholder="e4 e5 Nf3 Nc6 ..."
                    />
                  </div>
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
                    <div>Other Answers (SAN)</div>
                    <textarea
                      value={draft.fields.otherAnswers}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, otherAnswers: e.currentTarget.value } } : d)}
                      rows={2}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: '100%' }}
                      placeholder="Nf3 c4 g3"
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
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, depth: e.currentTarget.value } } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                      placeholder="required int (usually computed)"
                    />
                  </div>
                  <div className="row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }}>
                    <div>parent</div>
                    <input
                      type="text"
                      value={draft.fields.parent}
                      onChange={e => setDraft(d => d ? { ...d, fields: { ...d.fields, parent: e.currentTarget.value } } : d)}
                      style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                      placeholder="optional"
                    />
                  </div>

                  {/* Read-only linkage */}
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
