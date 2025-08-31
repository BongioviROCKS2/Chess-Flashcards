import { useParams, useNavigate } from 'react-router-dom';
import { getDeckById } from '../decks';
import { getDueCardsForDeck, pushCardDueMinutes, getCardDue } from '../data/cardStore';
import { useMemo, useState } from 'react';
import BoardPlayer from '../components/BoardPlayer';
import { Chess } from 'chess.js';
import { useSettings } from '../state/settings';
import { useReviewKeybinds } from '../hooks/useReviewKeybinds';
import { pushReviewUndoStep, undoLast, canUndo } from '../state/reviewHistory';
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
  const title = deck ? deck.name : deckId;

  const { settings } = useSettings();

  // force re-render after marking a card reviewed or undoing
  const [, setBump] = useState(0);
  const bump = () => setBump(v => v + 1);

  const dueCards = deckId ? getDueCardsForDeck(deckId) : [];
  const [showBack, setShowBack] = useState(false);
  const current = dueCards[0];

  // Orientation based on the *card* deck (so Openings mixes flip per card)
  const orientation: 'white' | 'black' = useMemo(() => {
    if (!current) return 'white';
    return isBlackDeckId(current.deck) ? 'black' : 'white';
  }, [current]);

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

  const completeReview = (grade: 'again' | 'hard' | 'good' | 'easy') => {
    if (!current) return;
    // Capture previous due before modifying
    const prevDue = getCardDue(current.id);
    // For testing: push due 1 minute forward
    pushCardDueMinutes(current.id, 1);
    const newDue = getCardDue(current.id) as string; // ISO we just set

    // Record undo step in session history
    pushReviewUndoStep({
      cardId: current.id,
      prevDue,
      newDue,
      deckId,
    });

    setShowBack(false);
    bump(); // re-query due cards and show next
  };

  const performUndo = () => {
    const step = undoLast();
    if (!step) return;
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

  return (
    <div className="container">
      <div className="card grid">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="button"
              onClick={performUndo}
              disabled={!canUndo()}
              title="Undo last review (Ctrl+Z)"
            >
              Undo
            </button>
            <button className="button secondary" onClick={handleBack}>Back</button>
          </div>
        </div>

        <div className="grid" style={{ padding: 8 }}>
          {dueCards.length === 0 ? (
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
                    <button className="button secondary" onClick={handleShowAnswer}>
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
                    <button className="button" onClick={() => completeReview('again')}>Again</button>
                    <button className="button" onClick={() => completeReview('hard')}>Hard</button>
                    <button className="button" onClick={() => completeReview('good')}>Good</button>
                    <button className="button" onClick={() => completeReview('easy')}>Easy</button>
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
