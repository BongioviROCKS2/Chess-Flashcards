// src/pages/ManualAddPage.tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBackKeybind } from '../hooks/useBackKeybind';
import { useKeybinds, formatActionKeys } from '../context/KeybindsProvider';
import { useSettings } from '../state/settings';
import type { Card } from '../data/types';
import { Chess } from 'chess.js';

type EvalKind = 'cp' | 'mate';

type ManualDraft = {
  id: string;
  deck: string;
  tags: string;
  due: string;
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

function newId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function lineToArr(s: string): string[] {
  return s.split(/\s+/).map(t => t.trim()).filter(Boolean);
}
function lineToTags(s: string): string[] {
  return s.split(',').map(t => t.trim()).filter(Boolean);
}

type CardgenConfig = {
  otherAnswersAcceptance: number;
  maxOtherAnswerCount: number;
  depth: number;
  threads: number;
  hash: number;
};
type CardgenBridge = {
  saveConfig?: (cfg: CardgenConfig) => Promise<boolean>;
  makeCard?: (args: {
    // IMPORTANT: programmatic API prefers movesSAN (string[])
    movesSAN?: string[];
    // PGN or FEN are also valid
    pgn?: string;
    fen?: string;
    // (legacy/bridge calls sometimes send moves as a string; our code converts)
    moves?: string;
    config?: CardgenConfig;
    duplicateStrategy?: 'skip' | 'overwrite' | 'prompt';
  }) => Promise<{ ok: boolean; message?: string }>;
};
type CardsBridge = {
  readAll?: () => Promise<Card[]>;
  readOne?: (id: string) => Promise<Card | null>;
  update?: (card: Card) => Promise<boolean>;
  create?: (card: Card) => Promise<boolean>;
};
const getCardgen = (): CardgenBridge | undefined => (window as any).cardgen as CardgenBridge | undefined;
const getCards   = (): CardsBridge   | undefined => (window as any).cards   as CardsBridge   | undefined;

const LABEL_COL = 200;
const contentShellStyle: React.CSSProperties = { width: '100%', maxWidth: 'none', margin: '0 auto' };

const clampInt = (v: number, min: number, max?: number) => {
  if (!Number.isFinite(v)) return min;
  v = Math.floor(v);
  if (v < min) v = min;
  if (typeof max === 'number' && v > max) v = max;
  return v;
};

export default function ManualAddPage() {
  const navigate = useNavigate();
  useBackKeybind(() => navigate(-1), true);
  const { binds } = useKeybinds();
  const backKeys = formatActionKeys(binds, 'app.back');

  const { settings } = useSettings();

  const [mode, setMode] = useState<'stockfish' | 'full'>('stockfish');

  // --- Stockfish Assisted ---
  const [inputKind, setInputKind] = useState<'moves' | 'pgn' | 'fen'>('moves');
  const [moves, setMoves] = useState('');
  const [pgn, setPgn] = useState('');
  const [fen, setFen] = useState('');

  const [acc, setAcc] = useState<number>(Number(settings.otherAnswersAcceptance ?? 0.2));
  const [moac, setMoac] = useState<number>(Number(settings.maxOtherAnswerCount ?? 4));
  const [depth, setDepth] = useState<number>(Number(settings.stockfishDepth ?? 25));
  const [threads, setThreads] = useState<number>(Number(settings.stockfishThreads ?? 1));
  const [hash, setHash] = useState<number>(Number(settings.stockfishHash ?? 1024));

  const [sfBusy, setSfBusy] = useState(false);
  const [sfMsg, setSfMsg] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);

  // Duplicate-prompt state + UX
  const [dupPrompt, setDupPrompt] = useState<null | {
    mode: 'stockfish' | 'full';
    existingCardId: string;
    existingCard?: Card;
    existingDetails: any;
    candidateDetails: any;
    // For stockfish overwrite
    payload?: any;
    // For full overwrite
    newCard?: Card;
  }>(null);
  const [dupWorking, setDupWorking] = useState(false);
  const [dupErr, setDupErr] = useState<string | null>(null);

  // --- Full Manual Add ---
  const blankManual: ManualDraft = useMemo(
    () => ({
      id: newId(),
      deck: 'openings',
      tags: '',
      due: 'new',
      fields: {
        moveSequence: '',
        fen: '',
        answer: '',
        answerFen: '',
        evalKind: 'cp',
        evalValue: '',
        evalDepth: '',
        exampleLine: '',
        otherAnswers: '',
        siblingAnswers: '',
        depth: '',
        parent: '',
      },
    }),
    []
  );
  const [draft, setDraft] = useState<ManualDraft>(blankManual);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Ctrl+S to Create (both modes)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key?.toLowerCase() === 's') {
        e.preventDefault();
        if (mode === 'stockfish' && !sfBusy) {
          void runStockfish();
        } else if (mode === 'full' && !saving) {
          void handleManualSave();
        }
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as any);
  }, [mode, sfBusy, saving, moves, pgn, fen, acc, moac, depth, threads, hash, draft]);

  const hwThreads = Math.max(1, (navigator as any).hardwareConcurrency || 1);

  const goBack = () => navigate(-1);

  // Steppers (match Settings UI)
  const acceptanceStr = acc.toFixed(2);
  const STEP_ACC = 0.01;
  const incAcc = () => setAcc(Number((acc + STEP_ACC).toFixed(2)));
  const decAcc = () => setAcc(Number((acc - STEP_ACC).toFixed(2)));
  const onAccKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incAcc(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decAcc(); }
  };
  const onAccBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
    const num = parseFloat(e.currentTarget.value);
    const rounded = Number.isFinite(num) ? Math.round(num * 100) / 100 : acc;
    setAcc(rounded < 0 ? 0 : rounded);
  };

  const incMoac = () => setMoac(clampInt(moac + 1, 0, 50));
  const decMoac = () => setMoac(clampInt(moac - 1, 0, 50));
  const onMoacKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incMoac(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decMoac(); }
  };
  const onMoacBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
    const v = parseInt(e.currentTarget.value, 10);
    setMoac(clampInt(Number.isFinite(v) ? v : moac, 0, 50));
  };

  const incDepth = () => setDepth(clampInt(depth + 1, 1, 99));
  const decDepth = () => setDepth(clampInt(depth - 1, 1, 99));
  const onDepthKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incDepth(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decDepth(); }
  };
  const onDepthBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
    const v = parseInt(e.currentTarget.value, 10);
    setDepth(clampInt(Number.isFinite(v) ? v : depth, 1, 99));
  };

  const incThreads = () => setThreads(clampInt(threads + 1, 1, hwThreads));
  const decThreads = () => setThreads(clampInt(threads - 1, 1, hwThreads));
  const onThreadsKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incThreads(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decThreads(); }
  };
  const onThreadsBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
    const v = parseInt(e.currentTarget.value, 10);
    setThreads(clampInt(Number.isFinite(v) ? v : threads, 1, hwThreads));
  };

  const incHash = () => setHash(clampInt(hash + 64, 32));
  const decHash = () => setHash(clampInt(hash - 64, 32));
  const onHashKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incHash(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decHash(); }
  };
  const onHashBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
    const v = parseInt(e.currentTarget.value, 10);
    setHash(clampInt(Number.isFinite(v) ? v : hash, 32));
  };

  function computeReviewFromInput(): { ok: boolean; reason?: string; sans: string[]; reviewFEN: string; deckId: string; pathKey: string } {
    try {
      if (inputKind === 'fen') {
        const f = fen.trim();
        if (!f) return { ok: false, reason: 'Enter a FEN.' } as any;
        const parts = f.split(/\s+/);
        const stm = parts[1] || 'w';
        const deckId = stm === 'w' ? 'white-other' : 'black-other';
        return { ok: true, sans: [], reviewFEN: f, deckId, pathKey: '' } as any;
      }
      let sans: string[] = [];
      const c = new Chess();
      if (inputKind === 'moves') {
        sans = moves.trim().split(/\s+/).filter(Boolean);
        for (const s of sans) { const mv = c.move(s); if (!mv) throw new Error(`Invalid SAN: ${s}`); }
      } else {
        // pgn
        const s = pgn.trim();
        if (!s) return { ok: false, reason: 'Enter a PGN.' } as any;
        const ok = (c as any).loadPgn(s, { sloppy: true });
        if (!ok) throw new Error('Invalid PGN');
        sans = c.history();
      }
      const fenNow = c.fen();
      const deckId = (fenNow.split(' ')[1] === 'w') ? 'white-other' : 'black-other';
      const pathKey = sans.join(' ');
      return { ok: true, sans, reviewFEN: fenNow, deckId, pathKey } as any;
    } catch (e: any) {
      return { ok: false, reason: e?.message || 'Invalid input', sans: [], reviewFEN: '', deckId: 'white-other', pathKey: '' } as any;
    }
  }

  /** Build args for cardgen.makeCard(). Always include the move sequence when available. */
  function buildCardgenArgsForInput(
    inputKind: 'moves' | 'pgn' | 'fen',
    review: { sans: string[] },
    opts: {
      duplicateStrategy: 'skip' | 'overwrite' | 'prompt',
      acc: number,
      moac: number,
      depth: number,
      threads: number,
      hash: number,
      hwThreads: number,
      pgn: string,
      fen: string,
    }
  ) {
    const base = {
      config: {
        otherAnswersAcceptance: opts.acc,
        maxOtherAnswerCount: opts.moac,
        depth: opts.depth,
        threads: Math.max(1, Math.min(opts.hwThreads, opts.threads)),
        hash: Math.max(32, opts.hash),
      },
      duplicateStrategy: opts.duplicateStrategy,
    } as any;

    if (inputKind === 'fen') {
      return { ...base, fen: opts.fen.trim() };
    }

    // For moves/PGN: include BOTH the array and a string version of the SAN sequence.
    const sanList = review.sans || [];
    const movesStr = sanList.join(' ');
    const seq = { movesSAN: sanList, moves: movesStr };

    if (inputKind === 'pgn') {
      return { ...base, ...seq, pgn: opts.pgn.trim() };
    }
    // inputKind === 'moves'
    return { ...base, ...seq };
  }

  async function runStockfish() {
    setSfMsg('');
    setErr(null);
    setSaved(false);

    if (!moves.trim() && !pgn.trim() && !fen.trim()) {
      setErr('Enter Moves, PGN, or FEN.');
      return;
    }

    const review = computeReviewFromInput();
    if (!review.ok) { setErr(review.reason || 'Invalid input'); return; }

    const cardsApi = getCards();
    if (!cardsApi?.readAll) { setErr('Backend not available: window.cards.readAll missing.'); return; }

    const arr = await cardsApi.readAll?.();
    const dup = Array.isArray(arr)
      ? arr.find(c => c?.deck === review.deckId && (c?.fields?.moveSequence || '') === review.pathKey)
      : undefined;

    const argsSkip = buildCardgenArgsForInput(inputKind, review, {
      duplicateStrategy: 'skip',
      acc, moac, depth, threads, hash,
      hwThreads,
      pgn, fen,
    });

    const argsOverwrite = buildCardgenArgsForInput(inputKind, review, {
      duplicateStrategy: 'overwrite',
      acc, moac, depth, threads, hash,
      hwThreads,
      pgn, fen,
    });

    if (dup) {
      // Show prompt with an overwrite payload that already includes the move sequence.
      const existingDetails = dup?.fields?.creationCriteria || {
        fallback: true,
        fieldsSummary: {
          moveSequence: dup?.fields?.moveSequence,
          fen: dup?.fields?.fen,
          answer: dup?.fields?.answer,
          otherAnswers: dup?.fields?.otherAnswers,
          eval: dup?.fields?.eval,
        },
      };
      const candidateDetails = {
        input: { movesSAN: review.sans.slice(), pgn: (pgn || ''), fen: review.reviewFEN },
        configUsed: { otherAnswersAcceptance: acc, maxOtherAnswerCount: moac, depth, threads, hash, multipv: 1 + Math.max(0, moac) },
      };
      setDupErr(null);
      setDupPrompt({
        mode: 'stockfish',
        existingCardId: dup.id,
        existingCard: dup,
        existingDetails,
        candidateDetails,
        payload: argsOverwrite,
      });
      return;
    }

    const cardgen = getCardgen();
    if (!cardgen?.makeCard) {
      setErr('Backend not available: window.cardgen.makeCard missing.');
      return;
    }

    setSfBusy(true);
    try {
      const res = await cardgen.makeCard(argsSkip);
      if (!res?.ok) {
        const msg = String(res?.message || '').toLowerCase();
        if (msg.includes('cancel')) setSfMsg('Cancelled');
        else setErr(res?.message || 'Failed to create card.');
      }
      else setSfMsg(res.message || 'Created.');
    } catch (e: any) {
      const m = String(e?.message || '').toLowerCase();
      if (m.includes('cancel')) setSfMsg('Cancelled');
      else setErr(e?.message || 'Failed to create card.');
    } finally {
      setSfBusy(false);
    }
  }

  const cancelStockfish = useCallback(() => {
    try { (window as any).cardgen?.cancel?.(); } catch {}
    setErr(null);
    setSfMsg('Cancelled');
    setSfBusy(false);
    setDupWorking(false);
  }, []);

  const setRoot = (patch: Partial<ManualDraft>) => {
    setDraft(prev => ({ ...prev, ...patch }));
    setSaved(false);
  };
  const setField = <K extends keyof ManualDraft['fields']>(key: K, value: string) => {
    setDraft(prev => ({ ...prev, fields: { ...prev.fields, [key]: value } }));
    setSaved(false);
  };

  async function handleManualSave() {
    setErr(null);
    setSaved(false);

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

    const card: Card = {
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
        depth: depthNum,
        parent: draft.fields.parent || undefined,
      },
      ...(draft.due === '' ? {} : { due: draft.due as any }),
    };

    const cardsApi = getCards();
    if (!cardsApi?.create) {
      setErr('Backend not available: window.cards.create missing.');
      return;
    }
    // Duplicate detection for Full Manual Add (by deck + moveSequence)
    try {
      const arr = await (getCards()?.readAll?.() || Promise.resolve([]));
      const dup = Array.isArray(arr) ? arr.find(c => c?.deck === card.deck && (c?.fields?.moveSequence || '') === (card.fields.moveSequence || '')) : undefined;
      if (dup) {
        const existingDetails = dup?.fields?.creationCriteria || {
          fallback: true,
          fieldsSummary: {
            moveSequence: dup?.fields?.moveSequence,
            fen: dup?.fields?.fen,
            answer: dup?.fields?.answer,
            otherAnswers: dup?.fields?.otherAnswers,
            eval: dup?.fields?.eval,
          },
        };
        const candidateDetails = {
          input: { manual: true },
          fieldsSummary: card.fields,
        };
        setDupErr(null);
        setDupPrompt({
          mode: 'full',
          existingCardId: dup.id,
          existingCard: dup,
          existingDetails,
          candidateDetails,
          newCard: { ...card, id: dup.id },
        });
        return; // wait for user choice
      }
    } catch {}

    setSaving(true);
    try {
      const ok = await cardsApi.create(card);
      if (!ok) throw new Error('Write failed');
      setSaved(true);
      setRoot({ id: newId() }); // keep the form but refresh ID
    } catch (e: any) {
      setErr(e?.message || 'Failed to save card');
    } finally {
      setSaving(false);
    }
  }

  // Stable handler for the overwrite button (prevents any inline/hoisting oddities)
  const confirmOverwrite = useCallback(async () => {
    if (!dupPrompt) return;
    setDupErr(null);
    setDupWorking(true);
    try {
      if (dupPrompt.mode === 'stockfish') {
        const cardgen = getCardgen();
        if (!cardgen?.makeCard) {
          setDupErr('Backend not available: window.cardgen.makeCard missing.');
          return;
        }
        setSfBusy(true);
        // no-op
        const res = await cardgen.makeCard(dupPrompt.payload);
        if (!res?.ok) {
          const msg = String(res?.message || '').toLowerCase();
          if (msg.includes('cancel')) setDupErr('Cancelled');
          else setDupErr(res?.message || 'Failed to overwrite.');
          return;
        }
        setSfMsg(res.message || 'Overwrote card.');
        setDupPrompt(null);
      } else {
        const cardsApi = getCards();
        if (!cardsApi?.update) {
          setDupErr('Backend not available: window.cards.update missing.');
          return;
        }
        setSaving(true);
        // no-op
        const ok = await cardsApi.update(dupPrompt.newCard!);
        if (!ok) {
          setDupErr('Failed to overwrite card.');
          return;
        }
        setSaved(true);
        setRoot({ id: newId() });
        setDupPrompt(null);
      }
    } catch (e: any) {
      const m = String(e?.message || '').toLowerCase();
      if (m.includes('cancel')) setDupErr('Cancelled');
      else setDupErr(e?.message || 'Unexpected error while overwriting.');
    } finally {
      setSfBusy(false);
      setSaving(false);
      setDupWorking(false);
    }
  }, [dupPrompt]);

  return (
    <div className="container">
      <div className="card grid" style={{ gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center,', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Manual Add</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            {saved && <div className="sub" aria-live="polite">Saved</div>}
            {mode === 'full' && (
              <button type="button" className="button" onClick={handleManualSave} disabled={saving} title="Create (Ctrl+S)">
                {saving ? 'Creating…' : 'Create'}
              </button>
            )}
            {mode === 'stockfish' && (
              <>
                <button type="button" className="button" onClick={runStockfish} disabled={sfBusy} title="Create (Ctrl+S)">
                  {sfBusy ? 'Creating…' : 'Create'}
                </button>
                {sfBusy && (
                  <button type="button" className="button secondary" onClick={cancelStockfish} title="Cancel run">Cancel</button>
                )}
              </>
            )}
            <button type="button" className="button secondary" onClick={goBack} title={`Back${backKeys ? ` (${backKeys})` : ''}`}>Back</button>
          </div>
        </div>

        {/* Mode selector */}
        <div style={contentShellStyle}>
          <div className="row" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                checked={mode === 'stockfish'}
                onChange={() => setMode('stockfish')}
              />
              Stockfish Assisted
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                checked={mode === 'full'}
                onChange={() => setMode('full')}
              />
              Full Manual Add
            </label>
          </div>
        </div>

        {mode === 'stockfish' ? (
          <div style={contentShellStyle}>
            {/* Input kind */}
            <div className="row" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div>Input</div>
              <select
                value={inputKind}
                onChange={e => setInputKind(e.currentTarget.value as any)}
                style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 10px' }}
              >
                <option value="moves">Moves</option>
                <option value="pgn">PGN</option>
                <option value="fen">FEN</option>
              </select>
            </div>

            {inputKind === 'moves' && (
              <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
                <div>Moves</div>
                <input
                  type="text"
                  value={moves}
                  onChange={e => setMoves(e.currentTarget.value)}
                  placeholder='e4 e5 Nf3'
                  style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                />
              </div>
            )}
            {inputKind === 'pgn' && (
              <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12 }}>
                <div>PGN</div>
                <textarea
                  rows={4}
                  value={pgn}
                  onChange={e => setPgn(e.currentTarget.value)}
                  placeholder='1. e4 e5 2. Nf3 Nc6 ...'
                  style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                />
              </div>
            )}
            {inputKind === 'fen' && (
              <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
                <div>FEN</div>
                <input
                  type="text"
                  value={fen}
                  onChange={e => setFen(e.currentTarget.value)}
                  placeholder='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
                  style={{ background: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                />
              </div>
            )}

            {/* Card Creation (defaults from Settings) */}
            <div style={{ fontWeight: 600, fontSize: 18, opacity: 0.95, marginTop: 6 }}>Card Creation</div>

            {/* Other Answers Acceptance */}
            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px auto`, gap: 12, alignItems: 'center' }}>
              <div>Other Answers Acceptance</div>
              <div className="num-wrap">
                <input
                  className="num-accept no-native-spin"
                  type="text"
                  inputMode="decimal"
                  value={acceptanceStr}
                  onChange={e => {
                    const num = parseFloat(e.currentTarget.value);
                    if (Number.isFinite(num)) setAcc(num);
                  }}
                  onKeyDown={onAccKeyDown}
                  onBlur={onAccBlur}
                  style={{
                    backgroundColor: '#ffffff',
                    color: '#000000',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 8,
                    padding: '6px 8px',
                    width: 60,
                    minWidth: 'unset',
                    maxWidth: 60,
                    display: 'inline-block',
                    textAlign: 'right',
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                  title="Accept other answers within this pawn value of the best move (e.g., 0.20 = 20 centipawns)."
                />
                <div className="num-stepper" aria-hidden="false">
                  <button type="button" className="step up" onClick={incAcc} title="Increase by 0.01" aria-label="Increase">▲</button>
                  <button type="button" className="step down" onClick={decAcc} title="Decrease by 0.01" aria-label="Decrease">▼</button>
                </div>
              </div>
            </div>

            {/* Max Other Answer Count */}
            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px auto`, gap: 12, alignItems: 'center' }}>
              <div>Max Other Answer Count</div>
              <div className="num-wrap">
                <input
                  className="no-native-spin"
                  type="text"
                  inputMode="numeric"
                  value={String(moac)}
                  onChange={e => {
                    const v = parseInt(e.currentTarget.value, 10);
                    if (Number.isFinite(v)) setMoac(v);
                  }}
                  onKeyDown={onMoacKeyDown}
                  onBlur={onMoacBlur}
                  style={{
                    backgroundColor: '#ffffff',
                    color: '#000000',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 8,
                    padding: '6px 8px',
                    width: 70,
                    minWidth: 'unset',
                    maxWidth: 80,
                    display: 'inline-block',
                    textAlign: 'right',
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                  title="Number of alternative moves to consider; script uses MultiPV = 1 + this."
                />
                <div className="num-stepper" aria-hidden="false">
                  <button type="button" className="step up" onClick={incMoac} title="Increase by 1" aria-label="Increase">▲</button>
                  <button type="button" className="step down" onClick={decMoac} title="Decrease by 1" aria-label="Decrease">▼</button>
                </div>
              </div>
            </div>

            {/* Engine Depth */}
            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px auto`, gap: 12, alignItems: 'center' }}>
              <div>Engine Depth</div>
              <div className="num-wrap">
                <input
                  className="no-native-spin"
                  type="text"
                  inputMode="numeric"
                  value={String(depth)}
                  onChange={e => {
                    const v = parseInt(e.currentTarget.value, 10);
                    if (Number.isFinite(v)) setDepth(v);
                  }}
                  onKeyDown={onDepthKeyDown}
                  onBlur={onDepthBlur}
                  style={{
                    backgroundColor: '#ffffff',
                    color: '#000000',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 8,
                    padding: '6px 8px',
                    width: 70,
                    minWidth: 'unset',
                    maxWidth: 80,
                    display: 'inline-block',
                    textAlign: 'right',
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                  title="Engine depth (higher = stronger and slower)."
                />
                <div className="num-stepper" aria-hidden="false">
                  <button type="button" className="step up" onClick={incDepth} title="Increase by 1" aria-label="Increase">▲</button>
                  <button type="button" className="step down" onClick={decDepth} title="Decrease by 1" aria-label="Decrease">▼</button>
                </div>
              </div>
            </div>

            {/* Threads */}
            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px auto`, gap: 12, alignItems: 'center' }}>
              <div>Threads</div>
              <div className="num-wrap">
                <input
                  className="no-native-spin"
                  type="text"
                  inputMode="numeric"
                  value={String(threads)}
                  onChange={e => {
                    const v = parseInt(e.currentTarget.value, 10);
                    if (Number.isFinite(v)) setThreads(v);
                  }}
                  onKeyDown={onThreadsKeyDown}
                  onBlur={onThreadsBlur}
                  style={{
                    backgroundColor: '#ffffff',
                    color: '#000000',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 8,
                    padding: '6px 8px',
                    width: 70,
                    minWidth: 'unset',
                    maxWidth: 80,
                    display: 'inline-block',
                    textAlign: 'right',
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                  title={`Stockfish threads. Max suggested: ${hwThreads} (logical CPUs).`}
                />
                <div className="num-stepper" aria-hidden="false">
                  <button type="button" className="step up" onClick={incThreads} title="Increase by 1" aria-label="Increase">▲</button>
                  <button type="button" className="step down" onClick={decThreads} title="Decrease by 1" aria-label="Decrease">▼</button>
                </div>
              </div>
              <div className="sub">Max suggested: {hwThreads}</div>
            </div>

            {/* Hash (MB) */}
            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px auto`, gap: 12, alignItems: 'center' }}>
              <div>Hash (MB)</div>
              <div className="num-wrap">
                <input
                  className="no-native-spin"
                  type="text"
                  inputMode="numeric"
                  value={String(hash)}
                  onChange={e => {
                    const v = parseInt(e.currentTarget.value, 10);
                    if (Number.isFinite(v)) setHash(v);
                  }}
                  onKeyDown={onHashKeyDown}
                  onBlur={onHashBlur}
                  style={{
                    backgroundColor: '#ffffff',
                    color: '#000000',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 8,
                    padding: '6px 8px',
                    width: 90,
                    minWidth: 'unset',
                    maxWidth: 120,
                    display: 'inline-block',
                    textAlign: 'right',
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                  }}
                  title="Transposition table size in MB."
                />
                <div className="num-stepper" aria-hidden="false">
                  <button type="button" className="step up" onClick={incHash} title="Increase by 64" aria-label="Increase">▲</button>
                  <button type="button" className="step down" onClick={decHash} title="Decrease by 64" aria-label="Decrease">▼</button>
                </div>
              </div>
            </div>

            {(err || sfMsg) && (
              <div className="sub" style={{ color: err ? 'var(--danger, #ff6b6b)' : undefined, whiteSpace: 'pre-wrap' }}>
                {err || sfMsg}
              </div>
            )}
          </div>
        ) : (
          <div style={contentShellStyle}>
            {/* FULL MANUAL ADD */}
            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>ID</div>
              <input
                type="text"
                value={draft.id}
                readOnly
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
                title="New unique id is pre-filled"
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>Deck</div>
              <input
                type="text"
                value={draft.deck}
                onChange={e => setRoot({ deck: e.currentTarget.value })}
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>Tags</div>
              <input
                type="text"
                value={draft.tags}
                onChange={e => setRoot({ tags: e.currentTarget.value })}
                placeholder="comma,separated,tags"
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>Due</div>
              <input
                type="text"
                value={draft.due}
                onChange={e => setRoot({ due: e.currentTarget.value })}
                placeholder='new or 2025-01-01T00:00:00.000Z'
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div style={{ fontWeight: 600, fontSize: 18, opacity: 0.95, marginTop: 6 }}>Fields</div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12 }}>
              <div>Move Sequence (PGN)</div>
              <textarea
                rows={3}
                value={draft.fields.moveSequence}
                onChange={e => setField('moveSequence', e.currentTarget.value)}
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>Review FEN</div>
              <input
                type="text"
                value={draft.fields.fen}
                onChange={e => setField('fen', e.currentTarget.value)}
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>Answer (SAN)</div>
              <input
                type="text"
                value={draft.fields.answer}
                onChange={e => setField('answer', e.currentTarget.value)}
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>Answer FEN</div>
              <input
                type="text"
                value={draft.fields.answerFen}
                onChange={e => setField('answerFen', e.currentTarget.value)}
                placeholder="optional"
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            {/* Eval */}
            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr 1fr 1fr`, gap: 12, alignItems: 'center' }}>
              <div>Eval</div>
              <select
                value={draft.fields.evalKind}
                onChange={e => setField('evalKind', e.currentTarget.value as EvalKind)}
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              >
                <option value="cp">cp</option>
                <option value="mate">mate</option>
              </select>
              <input
                type="text"
                inputMode="numeric"
                value={draft.fields.evalValue}
                onChange={e => setField('evalValue', e.currentTarget.value)}
                placeholder="value"
                style={{
                  background: '#ffffff',
                  color: '#000',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  width: 90,
                  minWidth: 90,
                  justifySelf: 'start'
                }}
              />
              <input
                type="text"
                inputMode="numeric"
                value={draft.fields.evalDepth}
                onChange={e => setField('evalDepth', e.currentTarget.value)}
                placeholder="depth"
                style={{
                  background: '#ffffff',
                  color: '#000',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  width: 70,
                  minWidth: 70,
                  justifySelf: 'start'
                }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12 }}>
              <div>Example Line (SAN)</div>
              <textarea
                rows={2}
                value={draft.fields.exampleLine}
                onChange={e => setField('exampleLine', e.currentTarget.value)}
                placeholder="e4 e5 Nf3 Nc6 ..."
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12 }}>
              <div>Other Answers (SAN)</div>
              <textarea
                rows={2}
                value={draft.fields.otherAnswers}
                onChange={e => setField('otherAnswers', e.currentTarget.value)}
                placeholder="Nf3 c4 g3"
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12 }}>
              <div>Sibling Answers (SAN)</div>
              <textarea
                rows={2}
                value={draft.fields.siblingAnswers}
                onChange={e => setField('siblingAnswers', e.currentTarget.value)}
                placeholder="moves treated equivalent to best"
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div style={{ fontWeight: 600, fontSize: 18, opacity: 0.95, marginTop: 6 }}>
              Lineage
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>depth</div>
              <input
                type="text"
                inputMode="numeric"
                value={draft.fields.depth}
                onChange={e => setField('depth', e.currentTarget.value)}
                placeholder="required int (move number)"
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            <div className="row" style={{ display: 'grid', gridTemplateColumns: `${LABEL_COL}px 1fr`, gap: 12, alignItems: 'center' }}>
              <div>parent</div>
              <input
                type="text"
                value={draft.fields.parent}
                onChange={e => setField('parent', e.currentTarget.value)}
                placeholder="optional (card id)"
                style={{ background: '#ffffff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              />
            </div>

            {err && <div className="sub" style={{ color: 'var(--danger, #ff6b6b)' }}>{err}</div>}
          </div>
        )}
      </div>

      {/* Duplicate overwrite prompt */}
      {dupPrompt && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          role="dialog"
          aria-modal="true"
          aria-label="Overwrite existing card confirmation"
        >
          <div style={{ background: '#fff', color: '#000', borderRadius: 8, width: 'min(900px, 92vw)', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 10px 24px rgba(0,0,0,0.25)', padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>A card already exists for this PGN. Overwrite?</h3>
              <button type="button" className="button secondary" onClick={() => setDupPrompt(null)}>Close</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Existing</div>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f7f7f7', border: '1px solid #ddd', borderRadius: 6, padding: 8 }}>
{JSON.stringify(dupPrompt.existingDetails, null, 2)}
                </pre>
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>New</div>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f7f7f7', border: '1px solid #ddd', borderRadius: 6, padding: 8 }}>
{JSON.stringify(dupPrompt.candidateDetails, null, 2)}
                </pre>
              </div>
            </div>
            {dupErr && (
              <div className="sub" style={{ color: 'var(--danger, #d33)', marginTop: 8 }} aria-live="polite">{dupErr}</div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="button secondary" onClick={() => setDupPrompt(null)} disabled={dupWorking}>Cancel</button>
              {dupPrompt.mode === 'stockfish' && dupWorking && (
                <button type="button" className="button secondary" onClick={cancelStockfish}>
                  Cancel Run
                </button>
              )}
              <button type="button" className="button" onClick={confirmOverwrite} disabled={dupWorking}>
                {dupWorking ? 'Overwriting…' : 'Overwrite'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
