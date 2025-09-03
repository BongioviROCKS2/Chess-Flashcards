import { useParams, useNavigate, Link } from 'react-router-dom';
import { getDeckById, getDeckPath, getDeckPathNames } from '../decks';
import { getDueCardsForDeck, getCardDue, allCards } from '../data/cardStore';
import { planQueueForDeck } from '../state/deckLimits';
import { useEffect, useMemo, useState } from 'react';
import { useKeybinds, KeyAction } from '../context/KeybindsProvider';
import BoardPlayer from '../components/BoardPlayer';
import { Chess } from 'chess.js';
import { useSettings } from '../state/settings';
import { useReviewKeybinds } from '../hooks/useReviewKeybinds';
import { pushReviewUndoStep, undoLast, canUndo } from '../state/reviewHistory';
import { schedule, getMeta, restore as restoreSchedule } from '../state/scheduler';
import { useBackKeybind } from '../hooks/useBackKeybind';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

function sideToMoveFromFen(fen?: string): 'w' | 'b' {
  if (!fen) return 'w';
  const parts = fen.split(' ');
  return (parts[1] as 'w' | 'b') || 'w';
}

/** White-centric eval: + => White advantage, - => Black advantage (cp & mate) */
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

type LastMove = { from: string; to: string; san: string } | null;

export default function ReviewPage() {
  const { deckId } = useParams<{ deckId: string }>();
  const navigate = useNavigate();
  const deck = getDeckById(deckId);

  const { settings } = useSettings();
  const { binds } = useKeybinds();

  // force re-render after marking a card reviewed or undoing
  const [, setBump] = useState(0);
  const bump = () => setBump(v => v + 1);

  const [queueIds, setQueueIds] = useState<string[]>(() => (deckId ? planQueueForDeck(deckId).ids : []));
  const [currentId, setCurrentId] = useState<string | null>(() => (deckId ? (planQueueForDeck(deckId).ids[0] ?? null) : null));
  const [showBack, setShowBack] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const current = useMemo(() => (currentId ? (allCards().find(c => c.id === currentId) ?? null) : null), [currentId]);

  const deckPathParts = useMemo(() => {
    const idFor = current?.deck || deckId || null;
    return getDeckPath(idFor || undefined);
  }, [current, deckId]);
  const title = useMemo(() => (deckPathParts.length ? deckPathParts[deckPathParts.length - 1].name : (deck ? deck.name : deckId)), [deckPathParts, deck, deckId]);

  // Rebuild queue whenever deck changes or refresh is requested
  useEffect(() => {
    const plan = deckId ? planQueueForDeck(deckId) : { ids: [] } as any;
    setQueueIds(plan.ids);
    setCurrentId(plan.ids[0] ?? null);
    setShowBack(false);
  }, [deckId]);

  // Orientation based on the *card* deck (so Openings mixes flip per card)
  const orientation: 'white' | 'black' = useMemo(() => {
    if (!current) return 'white';
    const base: 'white' | 'black' = isBlackDeckId(current.deck) ? 'black' : 'white';
    if (!flipped) return base;
    return base === 'white' ? 'black' : 'white';
  }, [current, flipped]);

  // Build FRONT start behavior from settings
  const frontStartAt: 'first' | 'last' = settings.frontStartAtReview ? 'last' : 'first';

  // Build BACK frames & lastMoves
  const backFramesInfo = useMemo((): { frames: string[]; startIndex: number; moves: LastMove[] } => {
    if (!current) return { frames: [START_FEN], startIndex: 0, moves: [null] };

    // 1) FRONT PGN frames (with move metadata)
    const frontSans = pgnToSanArray(current.fields.moveSequence);
    const chessFront = new Chess();
    const frontFrames: string[] = [START_FEN];
    const frontMoves: LastMove[] = [null];
    for (const san of frontSans) {
      const mv = chessFront.move(san);
      if (!mv) break;
      frontFrames.push(chessFront.fen());
      frontMoves.push({ from: mv.from, to: mv.to, san: mv.san });
    }
    if (frontFrames[frontFrames.length - 1] !== current.fields.fen) {
      // Ensure the review position is present
      frontFrames.push(current.fields.fen);
      frontMoves.push(null);
    }

    // 2) Answer + example line frames (with move metadata)
    const ans = current.fields.answer || '';
    const pv = current.fields.exampleLine || [];
    const backSan = (pv.length && pv[0] === ans) ? pv : (ans ? [ans, ...pv] : pv);

    const chessBack = new Chess(current.fields.fen);
    const answerAndBeyond: string[] = [];
    const answerMoves: LastMove[] = [];
    for (const san of backSan) {
      const mv = chessBack.move(san);
      if (!mv) break;
      answerAndBeyond.push(chessBack.fen());
      answerMoves.push({ from: mv.from, to: mv.to, san: mv.san });
    }

    const frames = [...frontFrames, ...answerAndBeyond];
    const moves: LastMove[] = [...frontMoves, ...answerMoves];

    const startIndex = answerAndBeyond.length > 0
      ? frontFrames.length
      : Math.max(0, frontFrames.length - 1);

    return { frames, startIndex, moves };
  }, [current]);

  // --- Handlers ---
  const handleBack = () => navigate('/');

  const handleShowAnswer = () => setShowBack(true);
  const handleFlip = () => setFlipped(f => !f);

  const completeReview = (grade: 'again' | 'hard' | 'good' | 'easy') => {
    if (!current) return;
    const prevDue = getCardDue(current.id);
    const prevSched = getMeta(current.id);
    const { newDue, newMeta } = schedule(current.id, grade);

    // Record undo step with scheduler snapshot (cast to tolerate optional fields)
    pushReviewUndoStep({
      cardId: current.id,
      prevDue,
      newDue,
      deckId,
      prevSched: prevSched as any,
      newSched: newMeta as any,
    } as any);

    // Recompute queue after scheduling (and clear back)
    const plan = deckId ? planQueueForDeck(deckId) : { ids: [] } as any;
    setQueueIds(plan.ids);
    setCurrentId(list[0]?.id ?? null);
    setShowBack(false);
    bump();
  };

  const performUndo = () => {
    const step = undoLast();
    if (!step) return;
    // Restore scheduler state if present
    if ((step as any).prevSched) {
      restoreSchedule(step.cardId, (step as any).prevSched, step.prevDue);
    }
    // Rebuild queue and clear back
    const plan = deckId ? planQueueForDeck(deckId) : { ids: [] } as any;
    setQueueIds(plan.ids);
    setCurrentId(list[0]?.id ?? null);
    setShowBack(false);
    bump();
  };

  // --- Keybinds: Review actions (context-aware) ---
  useReviewKeybinds({
    isFront: !showBack,
    enabled: !!current || canUndo(),
    front: {
      showAnswer: handleShowAnswer,
    },
    back: {
      again: () => completeReview('again'),
      hard:  () => completeReview('hard'),
      good:  () => completeReview('good'),
      easy:  () => completeReview('easy'),
    },
    onUndo: performUndo, // Ctrl+Z
  });

  // --- Keybinds: Back (Backspace) ---
  useBackKeybind(handleBack, true);

  // --- Helper: keybind tooltips ---
  const keysFor = (action: KeyAction) => {
    try {
      const pair = binds[action] || ['', ''];
      const both = [pair[0], pair[1]].filter(Boolean).join(' or ');
      return both || '';
    } catch { return ''; }
  };

  return (
    <div className="container">
      <div className="card grid">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>{title}</h2>
            {deckPathParts.length > 0 && (
              <div className="sub" style={{ marginTop: 2 }}>
                {deckPathParts.map((d, i) => (
                  <span key={d.id}>
                    {i > 0 ? ' / ' : ''}
                    <Link to={`/review/${d.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>{d.name}</Link>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className="sub" title="Cards remaining in this deck (incl. descendants)">{queueIds.length} remaining</span>
            <button
              className="button"
              onClick={performUndo}
              disabled={!canUndo()}
              title={`Undo last review${keysFor('review.undo') ? ` (${keysFor('review.undo')})` : ''}`}
            >
              Undo
            </button>
            <button className="button" onClick={handleFlip} title={`Flip board${keysFor('board.flip') ? ` (${keysFor('board.flip')})` : ''}`}>Flip</button>
            <button className="button secondary" onClick={handleBack} title={`Back${keysFor('app.back') ? ` (${keysFor('app.back')})` : ''}`}>Back</button>
          </div>
        </div>

        <div className="grid" style={{ padding: 8 }}>
          {queueIds.length === 0 ? (
            <div className="sub">There are no more cards to review for the day in this deck.</div>
          ) : (
            <>
              {!showBack ? (
                <>
                  {/* FRONT */}
                  <BoardPlayer
                    key={`front-${current!.id}-${frontStartAt}-${orientation}`}
                    mode="pgn"
                    pgn={current!.fields.moveSequence}
                    targetFen={current!.fields.fen}
                    includeInitialFrame={true}
                    size={420}
                    startAt={frontStartAt}
                    orientation={orientation}
                    showMoveLabel={true}
                    onFlip={handleFlip}
                  />

                  {/* Spacer to align Show Answer with back-side grading buttons */}
                  <div
                    className="sub"
                    aria-hidden="true"
                    style={{ textAlign: 'center', minHeight: 0, visibility: 'hidden', marginTop: 0}}
                  >
                    placeholder
                  </div>

                  <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                    <button className="button secondary" onClick={handleShowAnswer} title={`Show Answer${keysFor('review.showAnswer') ? ` (${keysFor('review.showAnswer')})` : ''}`}>
                      Show Answer
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* BACK */}
                  <BoardPlayer
                    key={`back-${current!.id}-${orientation}`}
                    mode="frames"
                    frames={backFramesInfo.frames}
                    startIndex={backFramesInfo.startIndex}
                    frameMoves={backFramesInfo.moves}
                    size={420}
                    orientation={orientation}
                    showMoveLabel={true}
                    onFlip={handleFlip}
                  />
                  <div className="sub" style={{ textAlign: 'center' }}>
                    Best: <strong>{current?.fields.answer || '(unknown)'}</strong>
                    {current?.fields.eval ? (
                      <>
                        &nbsp;•&nbsp; Eval:{' '}
                        <strong>{formatEvalWhiteCentric(current.fields.eval, current.fields.fen)}</strong>
                      </>
                    ) : null}
                  </div>

                  <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                    <button className="button" onClick={() => completeReview('again')} title={`Again${keysFor('review.again') ? ` (${keysFor('review.again')})` : ''}`}>Again</button>
                    <button className="button" onClick={() => completeReview('hard')}  title={`Hard${keysFor('review.hard') ? ` (${keysFor('review.hard')})` : ''}`}>Hard</button>
                    <button className="button" onClick={() => completeReview('good')}  title={`Good${keysFor('review.good') ? ` (${keysFor('review.good')})` : ''}`}>Good</button>
                    <button className="button" onClick={() => completeReview('easy')}  title={`Easy${keysFor('review.easy') ? ` (${keysFor('review.easy')})` : ''}`}>Easy</button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
