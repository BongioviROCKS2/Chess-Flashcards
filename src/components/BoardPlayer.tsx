import React, { useMemo, useState, useCallback, useEffect } from 'react';
import Board from './Board';
import { Chess } from 'chess.js';
import './boardplayer.css'; // nav button styles
import { useBoardKeybinds } from '../hooks/useBoardKeybinds';
import { useKeybinds, formatActionKeys } from '../context/KeybindsProvider';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

type LastMove = { from: string; to: string; san: string } | null;

type PgnMode = {
  mode: 'pgn';
  pgn: string;
  targetFen?: string;
  includeInitialFrame?: boolean;
};

type SanMode = {
  mode: 'san';
  initialFen: string;
  sanMoves: string[];
};

type FramesMode = {
  mode: 'frames';
  frames: string[];           // precomputed FEN frames
  startIndex?: number;        // optional explicit starting index
  /** optional last-move metadata aligned to frames (null for initial) */
  frameMoves?: LastMove[];    // length should equal frames.length
};

type Base = {
  size?: number;
  startAt?: 'first' | 'last'; // ignored if startIndex provided
  orientation?: 'white' | 'black';
  /** show the current move label under the board (default true) */
  showMoveLabel?: boolean;
  /** optional custom label for the current index */
  labelForIndex?: (idx: number, moveSan: string | null) => React.ReactNode;
  /** notify external listeners when index changes */
  onIndexChange?: (idx: number) => void;
};

export type BoardPlayerProps = (PgnMode | SanMode | FramesMode) & Base;
type WithFlip = { onFlip?: () => void };

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

/** Inline, solid SVG icons (consistent across platforms) */
function Icon({ name }: { name: 'first' | 'prev' | 'next' | 'last' }) {
  if (name === 'prev') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
      </svg>
    );
  }
  if (name === 'next') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m8.59 16.59 1.41 1.41L16 12l-5.99-6-1.42 1.41L13.17 12z" />
      </svg>
    );
  }
  if (name === 'first') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 6h2v12H7zM17.41 7.41 16 6l-6 6 6 6 1.41-1.41L12.83 12z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 6h2v12h-2zM6.59 7.41 8 6l6 6-6 6-1.41-1.41L11.17 12z" />
    </svg>
  );
}

export default function BoardPlayer(props: BoardPlayerProps & WithFlip) {
  const { size = 360, startAt = 'last', orientation = 'white', showMoveLabel = true } = props;
  const { binds } = useKeybinds();
  const keysFor = useCallback((action: 'board.first'|'board.prev'|'board.next'|'board.last'): string => {
    return formatActionKeys(binds, action as any);
  }, [binds]);

  const { frames, lastMoves } = useMemo(() => {
    // Returns both frames[] and lastMoves[] (per-frame last move)
    if (props.mode === 'frames') {
      const fs = (props.frames && props.frames.length) ? props.frames : [START_FEN];
      const ms: LastMove[] = (() => {
        const given = props.frameMoves || [];
        // normalize length
        if (given.length === fs.length) return given;
        const pad: LastMove[] = new Array(fs.length).fill(null);
        for (let i = 0; i < Math.min(fs.length, given.length); i++) pad[i] = given[i];
        // ensure first is null (initial frame has no last move)
        if (pad.length) pad[0] = null;
        return pad;
      })();
      return { frames: fs, lastMoves: ms };
    }

    if (props.mode === 'pgn') {
      const sans = pgnToSanArray(props.pgn);
      const chess = new Chess(); // standard start
      const fs: string[] = [];
      const ms: LastMove[] = [];

      if (props.includeInitialFrame) {
        fs.push(START_FEN);
        ms.push(null);
      }

      for (const san of sans) {
        const mv = chess.move(san);
        if (!mv) break;
        fs.push(chess.fen());
        ms.push({ from: mv.from, to: mv.to, san: mv.san });
      }

      if (props.targetFen) {
        const last = fs[fs.length - 1];
        if (!last || last !== props.targetFen) {
          fs.push(props.targetFen);
          ms.push(null); // we didn't know the producing move
        }
      }
      if (!fs.length) {
        const only = props.targetFen ? [props.targetFen] : [START_FEN];
        return { frames: only, lastMoves: [null] };
      }
      return { frames: fs, lastMoves: ms.length ? ms : new Array(fs.length).fill(null) };
    }

    // props.mode === 'san'
    const chess = new Chess(props.initialFen);
    const fs: string[] = [props.initialFen];
    const ms: LastMove[] = [null];
    for (const san of props.sanMoves || []) {
      const mv = chess.move(san);
      if (!mv) break;
      fs.push(chess.fen());
      ms.push({ from: mv.from, to: mv.to, san: mv.san });
    }
    return { frames: fs, lastMoves: ms };
  }, [props]);

  const initialIndex = useMemo(() => {
    if (props.mode === 'frames' && typeof props.startIndex === 'number') {
      const i = Math.max(0, Math.min(props.startIndex, frames.length - 1));
      return i;
    }
    return startAt === 'last' ? Math.max(0, frames.length - 1) : 0;
  }, [props, frames, startAt]);

  const [idx, setIdx] = useState(initialIndex);
  // notify on index mount + change
  useEffect(() => { props.onIndexChange?.(idx); }, [idx]);
  const atStart = idx <= 0;
  const atEnd = idx >= frames.length - 1;

  // --- keybind handlers (ArrowDown=first, ArrowLeft=prev, ArrowRight=next, ArrowUp=last) ---
  const goFirst = useCallback(() => setIdx(0), []);
  const goPrev  = useCallback(() => setIdx(i => Math.max(0, i - 1)), []);
  const goNext  = useCallback(() => setIdx(i => Math.min(frames.length - 1, i + 1)), [frames.length]);
  const goLast  = useCallback(() => setIdx(frames.length - 1), [frames.length]);

  // Attach keybinds globally while this component is mounted.
  useBoardKeybinds(
    { first: goFirst, prev: goPrev, next: goNext, last: goLast, flip: props.onFlip },
    true
  );

  const moveNow: LastMove = lastMoves[idx] ?? null;

  return (
    <div className="bp-wrap">
      <Board
        fen={frames[idx]}
        size={size}
        orientation={orientation}
        highlight={moveNow ? { from: moveNow.from, to: moveNow.to } : null}
      />

      {/* Current move label */}
      {showMoveLabel && (
        <div className="bp-move sub" style={{ textAlign: 'center', marginTop: 6, minHeight: 18 }}>
          {props.labelForIndex
            ? (props.labelForIndex(idx, moveNow?.san ?? null) as any)
            : (moveNow?.san ? `Move: ${moveNow.san}` : 'Initial position')}
        </div>
      )}

      <div className="bp-nav">
        <button
          className="btn-icon"
          disabled={atStart}
          onClick={goFirst}
          title={`First${keysFor('board.first') ? ` (${keysFor('board.first')})` : ''}`}
          aria-label="First"
        >
          <Icon name="first" />
        </button>

        <button
          className="btn-icon"
          disabled={atStart}
          onClick={goPrev}
          title={`Previous${keysFor('board.prev') ? ` (${keysFor('board.prev')})` : ''}`}
          aria-label="Previous"
        >
          <Icon name="prev" />
        </button>

        <div className="bp-count sub">{Math.min(idx + 1, frames.length)} / {frames.length}</div>

        <button
          className="btn-icon"
          disabled={atEnd}
          onClick={goNext}
          title={`Next${keysFor('board.next') ? ` (${keysFor('board.next')})` : ''}`}
          aria-label="Next"
        >
          <Icon name="next" />
        </button>

        <button
          className="btn-icon"
          disabled={atEnd}
          onClick={goLast}
          title={`Last${keysFor('board.last') ? ` (${keysFor('board.last')})` : ''}`}
          aria-label="Last"
        >
          <Icon name="last" />
        </button>
      </div>
    </div>
  );
}
