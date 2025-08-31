import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useKeybinds } from '../context/KeybindsProvider';
import { useBackKeybind } from '../hooks/useBackKeybind';

type Row = {
  action:
    | 'app.back'
    | 'board.first' | 'board.prev' | 'board.next' | 'board.last'
    | 'review.showAnswer' | 'review.again' | 'review.hard' | 'review.good' | 'review.easy' | 'review.undo';
  label: string;
};

const NAV_ROWS: Row[] = [
  { action: 'app.back', label: 'Back' },
];

const BOARD_ROWS: Row[] = [
  { action: 'board.first', label: 'First Position' },
  { action: 'board.prev',  label: 'Previous' },
  { action: 'board.next',  label: 'Next' },
  { action: 'board.last',  label: 'Last Position' },
  { action: 'board.flip',  label: 'Flip Board' },
];

const REVIEW_ROWS: Row[] = [
  { action: 'review.showAnswer', label: 'Show Answer' },
  { action: 'review.again',      label: 'Again' },
  { action: 'review.hard',       label: 'Hard' },
  { action: 'review.good',       label: 'Good' },
  { action: 'review.easy',       label: 'Easy' },
  { action: 'review.undo',       label: 'Undo' },
];

// Fixed widths
const LABEL_W  = 72;
const VALUE_W  = 100;
const BUTTON_W = 80;
const RESET_W  = 136;

// Build row grid with a fixed name column width
function rowGridStyle(nameW: number): React.CSSProperties {
  return {
    display: 'grid',
    alignItems: 'center',
    gridTemplateColumns: `${nameW}px ${LABEL_W}px ${VALUE_W}px ${BUTTON_W}px ${LABEL_W}px ${VALUE_W}px ${BUTTON_W}px`,
    columnGap: 8,
    width: '100%',
  };
}

const valueCellStyle: React.CSSProperties = {
  opacity: 0.9,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const sectionTitleStyle: React.CSSProperties = {
  marginTop: 10,
  fontWeight: 600,
  fontSize: 18,
  opacity: 0.95,
};

export default function KeybindsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { binds, setBinding, resetDefaults } = useKeybinds();

  const [capturing, setCapturing] = useState<null | { action: Row['action']; slot: 0 | 1 }>(null);

  // Measure labels and set fixed name column to HALF of max label width
  const nameRefs = useRef<Record<Row['action'], HTMLDivElement | null>>({} as any);
  const setNameRef = (action: Row['action']) => (el: HTMLDivElement | null) => {
    nameRefs.current[action] = el || null;
  };
  const [nameW, setNameW] = useState<number>(200);

  useLayoutEffect(() => {
    let max = 0;
    for (const row of [...NAV_ROWS, ...BOARD_ROWS, ...REVIEW_ROWS]) {
      const el = nameRefs.current[row.action];
      if (el) max = Math.max(max, Math.ceil(el.offsetWidth));
    }
    if (max > 0) {
      const half = Math.ceil(max / 2);
      if (half !== nameW) setNameW(half);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBack = () => {
    const hasFrom = !!(location.state as any)?.from;
    if (hasFrom || window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  // Enable Back keybind on this page (but disable while capturing a key)
  useBackKeybind(handleBack, !capturing);

  const startCapture = (action: Row['action'], slot: 0 | 1) => setCapturing({ action, slot });
  const stopCapture  = () => setCapturing(null);

  const onKeyDownCapture = useCallback((e: KeyboardEvent) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      setCapturing(null);
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey)  parts.push('Meta');

    const key = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return;

    const combo = parts.length ? `${parts.join('+')}+${key}` : key;
    setBinding(capturing.action as any, (capturing.slot as 0 | 1), combo);
    setCapturing(null);
  }, [capturing, setBinding]);

  useEffect(() => {
    if (!capturing) return;
    window.addEventListener('keydown', onKeyDownCapture, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDownCapture, { capture: true });
  }, [capturing, onKeyDownCapture]);

  const renderRow = (row: Row) => {
    // Defensive: tolerate missing keys during a hot-reload by falling back to blanks
    const pair = (binds as any)[row.action] as [string, string] | undefined;
    const [key1, key2] = pair ?? ['', ''];
    const capturingThis = capturing && capturing.action === row.action ? capturing.slot : null;

    const key1ButtonCommon = {
      className: capturingThis === 0 ? 'button secondary' : 'button',
      style: { width: BUTTON_W },
      onClick: () => (capturingThis === 0 ? stopCapture() : startCapture(row.action, 0)),
      children: capturingThis === 0 ? 'Cancel' : 'Change',
    } as const;

    const key2ButtonCommon = {
      className: capturingThis === 1 ? 'button secondary' : 'button',
      style: { width: BUTTON_W },
      onClick: () => (capturingThis === 1 ? stopCapture() : startCapture(row.action, 1)),
      children: capturingThis === 1 ? 'Cancel' : 'Change',
    } as const;

    return (
      <div key={row.action} style={rowGridStyle(nameW)}>
        {/* Name */}
        <div ref={setNameRef(row.action)} style={{ minWidth: 0 }}>{row.label}</div>

        {/* Key 1 */}
        <span className="sub" style={{ textAlign: 'right', width: LABEL_W }}>Key 1:</span>
        <div style={{ ...valueCellStyle, width: VALUE_W }}>
          {capturingThis === 0 ? <span className="sub">Press any key… (Esc to cancel)</span> : <code>{key1 || '—'}</code>}
        </div>
        <button {...key1ButtonCommon} />

        {/* Key 2 */}
        <span className="sub" style={{ textAlign: 'right', width: LABEL_W }}>Key 2:</span>
        <div style={{ ...valueCellStyle, width: VALUE_W }}>
          {capturingThis === 1 ? <span className="sub">Press any key… (Esc to cancel)</span> : <code>{key2 || '—'}</code>}
        </div>
        <button {...key2ButtonCommon} />
      </div>
    );
  };

  return (
    <div className="container">
      <div className="card grid">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Keybinds</h2>
          <button className="button secondary" onClick={handleBack}>Back</button>
        </div>

        {/* NAVIGATION */}
        <div style={sectionTitleStyle}>Navigation</div>
        <div className="grid" style={{ gap: 14 }}>
          {NAV_ROWS.map(renderRow)}
        </div>

        {/* BOARD */}
        <div style={sectionTitleStyle}>Board</div>
        <div className="grid" style={{ gap: 14 }}>
          {BOARD_ROWS.map(renderRow)}
        </div>

        {/* REVIEW */}
        <div style={sectionTitleStyle}>Review</div>
        <div className="grid" style={{ gap: 14 }}>
          {REVIEW_ROWS.map(renderRow)}
        </div>

        {/* Reset aligned fully right */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="button" style={{ width: RESET_W }} onClick={resetDefaults}>
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
