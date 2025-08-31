// scripts/validate-cards.mjs
// Validate src/data/cards.json for structural and chess legality issues.
//
// Usage:
//   node scripts/validate-cards.mjs
//
// Exit codes:
//   0 = no errors (warnings may exist)
//   1 = one or more errors found
//
// Notes:
// - Accepts either `[{...}]` or `{ "cards": [{...}] }` as the cards.json root.
// - Compares only the first 4 FEN fields when checking PGN end vs review FEN.
// - Tries multiple chess.js import styles for maximum compatibility.
// - IMPORTANT: exampleLine is validated FROM THE REVIEW FEN (not after the answer).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------- resilient chess.js import ----------
let ChessCtor = null;
let validateFenFn = null;

async function loadChess() {
  // Try the common ESM shapes first
  const mod = await import('chess.js').catch(() => null);
  if (mod) {
    // chess.js v1.x ESM usually exports named { Chess, validateFen }
    if (typeof mod.Chess === 'function') ChessCtor = mod.Chess;
    if (typeof mod.validateFen === 'function') validateFenFn = mod.validateFen;

    // Some bundlers expose default as the ctor
    if (!ChessCtor && typeof mod.default === 'function') ChessCtor = mod.default;

    // Some expose default as an object { Chess, validateFen }
    if (!ChessCtor && mod.default && typeof mod.default.Chess === 'function') {
      ChessCtor = mod.default.Chess;
    }
    if (!validateFenFn && mod.default && typeof mod.default.validateFen === 'function') {
      validateFenFn = mod.default.validateFen;
    }
  }

  if (!ChessCtor) {
    throw new Error(
      'Failed to import chess.js. Make sure it is installed (npm i chess.js).'
    );
  }
}

// ---------- paths ----------
const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename)); // project root
const CARDS_PATH = resolve(ROOT, 'src', 'data', 'cards.json');

// ---------- helpers ----------
function fenCore(fen) {
  return String(fen).trim().split(/\s+/).slice(0, 4).join(' ');
}

function isIsoDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function isStringArray(arr) {
  return Array.isArray(arr) && arr.every((x) => typeof x === 'string');
}

function fmtCard(card) {
  return `${card?.id ?? '(no id)'} [deck: ${card?.deck ?? 'unknown'}]`;
}

async function loadCards() {
  const raw = await readFile(CARDS_PATH, 'utf8').catch((e) => {
    if (e && e.code === 'ENOENT') return '';
    throw e;
  });
  if (!raw || raw.trim() === '') return [];

  const parsed = JSON.parse(raw);

  // Accept either array or { cards: [...] }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.cards)) return parsed.cards;

  throw new Error('cards.json root must be an array or an object with a "cards" array');
}

function validateEval(evalObj) {
  if (!evalObj || typeof evalObj !== 'object') {
    return 'fields.eval is missing';
  }
  const { kind, value, depth } = evalObj;
  if (kind !== 'cp' && kind !== 'mate') {
    return 'fields.eval.kind must be "cp" or "mate"';
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'fields.eval.value must be a finite number';
  }
  if (depth != null && (typeof depth !== 'number' || depth < 0)) {
    return 'fields.eval.depth must be a non-negative number if present';
  }
  return null;
}

function validateDue(due) {
  if (due == null) return null;
  if (due === 'new') return null;
  if (isIsoDate(due)) return null;
  return 'due must be "new" or an ISO datetime string';
}

function tryLoadFen(fen) {
  // Prefer constructor-based load (supported in newer chess.js),
  // then fall back to load(fen).
  try {
    const ch1 = new ChessCtor(fen);
    // If constructor accepted fen, we’re good.
    return ch1;
  } catch {
    // Fall back to manual load
    try {
      const ch2 = new ChessCtor();
      const ok = ch2.load(fen);
      return ok ? ch2 : null;
    } catch {
      return null;
    }
  }
}

function getFenError(fen) {
  if (typeof validateFenFn === 'function') {
    try {
      const res = validateFenFn(fen);
      if (res && res.valid === false) return res.error || 'invalid FEN';
    } catch {
      // ignore
    }
  }
  return 'invalid or unsupported FEN';
}

function tryLoadPgn(pgn) {
  try {
    const ch = new ChessCtor();
    const ok = ch.loadPgn(pgn ?? '', { sloppy: true });
    return ok ? ch : null;
  } catch {
    return null;
  }
}

function trySanMove(ch, san) {
  try {
    const move = ch.move(san, { sloppy: true });
    return !!move;
  } catch {
    return false;
  }
}

// ---------- main ----------
async function main() {
  await loadChess();
  const cards = await loadCards();

  let errors = 0;
  let warnings = 0;

  console.log(`\nValidating ${cards.length} cards from src/data/cards.json\n`);

  for (const card of cards) {
    const errs = [];
    const warns = [];

    // Basic shape
    if (!card || typeof card !== 'object') {
      errors++;
      console.error(`- [ERROR] Malformed card object: ${fmtCard(card)}`);
      continue;
    }
    if (typeof card.id !== 'string' || card.id.trim() === '') {
      errs.push('id is required (string, non-empty)');
    }
    if (typeof card.deck !== 'string' || card.deck.trim() === '') {
      errs.push('deck is required (string, non-empty)');
    }
    if (!Array.isArray(card.tags)) {
      errs.push('tags must be an array');
    } else if (!isStringArray(card.tags)) {
      errs.push('tags must be an array of strings');
    }

    const dueErr = validateDue(card.due);
    if (dueErr) errs.push(dueErr);

    // fields presence
    const f = card.fields;
    if (!f || typeof f !== 'object') {
      errs.push('fields is required (object)');
    } else {
      // Front inputs
      if (typeof f.fen !== 'string' || f.fen.trim() === '') {
        errs.push('fields.fen is required (string, non-empty)');
      }
      if (typeof f.moveSequence !== 'string') {
        errs.push('fields.moveSequence must be a string (can be empty)');
      }

      // Back inputs
      if (typeof f.answer !== 'string' || f.answer.trim() === '') {
        errs.push('fields.answer is required (SAN string)');
      }
      const evalErr = validateEval(f.eval);
      if (evalErr) errs.push(evalErr);

      if (f.exampleLine != null && !isStringArray(f.exampleLine)) {
        errs.push('fields.exampleLine must be an array of SAN strings if present');
      }
      if (f.otherAnswers != null && !isStringArray(f.otherAnswers)) {
        errs.push('fields.otherAnswers must be an array of SAN strings if present');
      }
    }

    // Short-circuit if structural errors
    if (errs.length === 0 && f) {
      // Validate review FEN legality (robust)
      const reviewPos = tryLoadFen(f.fen);
      if (!reviewPos) {
        errs.push(
          `fields.fen is not a legal position: "${f.fen}" (${getFenError(f.fen)})`
        );
      }

      // Validate PGN reaches (approximately) the review FEN
      if (typeof f.moveSequence === 'string' && f.moveSequence.trim() !== '') {
        const pgnPos = tryLoadPgn(f.moveSequence);
        if (!pgnPos) {
          errs.push('fields.moveSequence PGN failed to parse/replay (sloppy mode)');
        } else if (reviewPos) {
          const corePGN = fenCore(pgnPos.fen());
          const coreReview = fenCore(reviewPos.fen());
          if (corePGN !== coreReview) {
            warns.push(
              `PGN end position != review FEN (core mismatch)\n    PGN:    ${corePGN}\n    Review: ${coreReview}`
            );
          }
        }
      } else if (!f.fen) {
        errs.push('Either a review FEN or a moveSequence leading to it is required');
      }

      // Validate answer legality FROM review FEN
      if (reviewPos && typeof f.answer === 'string') {
        const chForAnswer = tryLoadFen(f.fen);
        if (!chForAnswer) {
          errs.push('Could not re-load review FEN to validate answer move');
        } else {
          const ok = trySanMove(chForAnswer, f.answer);
          if (!ok) {
            errs.push(`fields.answer "${f.answer}" is not legal from review FEN`);
          } else {
            const computedAnswerFen = chForAnswer.fen();
            if (typeof f.answerFen === 'string' && f.answerFen.trim() !== '') {
              const answerOk = fenCore(computedAnswerFen) === fenCore(f.answerFen);
              if (!answerOk) {
                warns.push(
                  `answerFen mismatch with actual post-answer position\n    Given:   ${fenCore(
                    f.answerFen
                  )}\n    Actual:  ${fenCore(computedAnswerFen)}`
                );
              }
            }
          }
        }
      }

      // Validate exampleLine legality FROM review FEN (NOT after the answer)
      if (reviewPos && Array.isArray(f.exampleLine)) {
        const chForLine = tryLoadFen(f.fen);
        if (!chForLine) {
          errs.push('Could not re-load review FEN to validate exampleLine');
        } else {
          for (let i = 0; i < f.exampleLine.length; i++) {
            const san = f.exampleLine[i];
            const ok2 = trySanMove(chForLine, san);
            if (!ok2) {
              errs.push(
                `exampleLine move ${i + 1} "${san}" is not legal from the review FEN`
              );
              break;
            }
          }
        }
      }
    }

    // Report per card
    if (errs.length) {
      errors += errs.length;
      console.error(`- ${fmtCard(card)}\n  ERRORS:`);
      errs.forEach((e) => console.error(`   • ${e}`));
      if (warns.length) {
        warnings += warns.length;
        console.warn(`  WARNINGS:`);
        warns.forEach((w) => console.warn(`   • ${w}`));
      }
    } else if (warns.length) {
      warnings += warns.length;
      console.warn(`- ${fmtCard(card)}\n  WARNINGS:`);
      warns.forEach((w) => console.warn(`   • ${w}`));
    } else {
      console.log(`- ${fmtCard(card)} ✓ OK`);
    }
  }

  // Summary
  if (cards.length > 0) {
    console.log(`\nSummary: ${cards.length} cards, ${errors} errors, ${warnings} warnings.\n`);
  } else {
    console.log('cards.json is empty (0 cards). Nothing to validate.\n');
  }

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\nValidator crashed: ', e);
  process.exit(1);
});
