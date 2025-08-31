#!/usr/bin/env node
/**
 * scripts/make-card.js  (ESM)
 *
 * Creates a new card and appends it to src/data/cards.json (array format).
 * Inputs:
 *   --moves "e4 e5"   OR  --moves e4,e5
 *   --pgn   "1. e4 e5"
 *
 * Behavior:
 * - Computes depth from PGN plies:
 *     plies even → depth = plies/2 + 1  (white to move)
 *     plies odd  → depth = (plies+1)/2  (black to move)
 * - Populates fields.moveSequence with sanitized SAN tokens (space-separated).
 * - Detects duplicates by (deck, review FEN) and SKIPS engine if already present.
 * - Uses Stockfish (MultiPV = 1 + MOAC) to evaluate the review FEN.
 * - Produces: answer, answerFen, eval, exampleLine (SAN[]), otherAnswers (unique SAN within window).
 * - Deck from side-to-move: "white-other" or "black-other".
 * - NEW: Removes `last`; fills `parent` when possible; also updates the parent’s `children` list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';
import { resolveEnginePath } from './engine-path.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const CARDS_PATH = path.resolve(ROOT, 'src', 'data', 'cards.json');
const CONFIG_PATH = path.resolve(ROOT, 'src', 'data', 'cardgen.config.json');

// Engine path resolution is shared via scripts/engine-path.js

// ---------- CLI ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      if (typeof v !== 'undefined') out[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    }
  }
  return out;
}
const args = parseArgs(process.argv);
const MOVES_RAW = args['--moves'];
const PGN_RAW   = args['--pgn'];

// ---------- Config ----------
function loadConfig() {
  const def = {
    otherAnswersAcceptance: 0.20, // pawns
    maxOtherAnswerCount: 4,
    depth: 25,
    threads: 1,
    hash: 1024,
  };
  try {
    const txt = fs.readFileSync(CONFIG_PATH, 'utf-8').trim();
    if (!txt) return def;
    const cfg = JSON.parse(txt);
    return {
      otherAnswersAcceptance: Number(cfg.otherAnswersAcceptance ?? def.otherAnswersAcceptance),
      maxOtherAnswerCount: Number(cfg.maxOtherAnswerCount ?? def.maxOtherAnswerCount),
      depth: Number(cfg.depth ?? def.depth),
      threads: Number(cfg.threads ?? def.threads),
      hash: Number(cfg.hash ?? def.hash),
    };
  } catch {
    return def;
  }
}
const CFG = loadConfig();

// ---------- Cards I/O ----------
function loadCardsArray() {
  try {
    if (!fs.existsSync(CARDS_PATH)) return [];
    const raw = fs.readFileSync(CARDS_PATH, 'utf-8').trim();
    if (raw === '') return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.cards)) return parsed.cards; // legacy
    return [];
  } catch {
    return [];
  }
}
function saveCardsArray(arr) {
  fs.mkdirSync(path.dirname(CARDS_PATH), { recursive: true });
  fs.writeFileSync(CARDS_PATH, JSON.stringify(arr, null, 2) + '\n', 'utf-8');
}

// ---------- PGN / moves ----------
function pgnToSANArray(pgn) {
  if (!pgn || !String(pgn).trim()) return [];
  return String(pgn)
    .replace(/\{[^}]*\}/g, '')
    .replace(/\$\d+/g, '')
    .replace(/\d+\.(\.\.)?/g, '')
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
function movesToSANArray(moves) {
  if (!moves || !String(moves).trim()) return [];
  return String(moves).replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
}
function computeDepthFromPlies(plies) {
  if (!Number.isFinite(plies) || plies < 0) plies = 0;
  return (plies % 2 === 0) ? (plies / 2 + 1) : ((plies + 1) / 2);
}

// ---------- Engine ----------
function startEngine() {
  const exe = resolveEnginePath();
  if (!fs.existsSync(exe)) throw new Error(`Stockfish not found at: ${exe}`);
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.setDefaultEncoding('utf-8');
  return child;
}
function send(child, line) { child.stdin.write(line + '\n'); }
function parseInfo(line) {
  // "info depth 25 ... multipv 2 score cp 12 pv e2e4 e7e5 ..."
  const o = { multipv: 1, depth: undefined, score: null, pv: [] };
  const t = line.trim().split(/\s+/);
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (w === 'depth' && i + 1 < t.length) o.depth = parseInt(t[++i], 10);
    else if (w === 'multipv' && i + 1 < t.length) o.multipv = parseInt(t[++i], 10);
    else if (w === 'score' && i + 2 < t.length) {
      const kind = t[++i]; // cp|mate
      const valStr = t[++i];
      const val = parseInt(valStr, 10);
      if (!Number.isNaN(val)) o.score = { kind, value: val };
    } else if (w === 'pv') {
      o.pv = t.slice(i + 1);
      break;
    }
  }
  return o;
}
function uciToSanLine(initialFen, uciMoves) {
  const chess = new Chess(initialFen);
  const out = [];
  for (const uci of uciMoves || []) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uci)) break;
    const mv = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: (uci.slice(4, 5) || '').toLowerCase() || undefined,
    });
    if (!mv) break;
    out.push(mv.san);
  }
  return out;
}
async function analyzeWithStockfish(fen, { depth, threads, hash, multipv }) {
  return await new Promise((resolve, reject) => {
    const child = startEngine();
    const pvMap = new Map(); // multipv -> latest info

    child.stdout.on('data', (buf) => {
      const chunk = String(buf);
      for (const ln of chunk.split(/\r?\n/)) {
        if (!ln) continue;
        if (ln.startsWith('info ') && ln.includes(' pv ')) {
          const info = parseInfo(ln);
          if (info.score && info.pv && info.pv.length) {
            pvMap.set(info.multipv || 1, info);
          }
        } else if (ln.startsWith('bestmove')) {
          try { child.stdin.end(); child.kill(); } catch {}
          const keys = [...pvMap.keys()].sort((a, b) => a - b);
          resolve(keys.map(k => pvMap.get(k)));
        }
      }
    });

    child.once('error', reject);

    // Correct MultiPV flow: set via setoption, NOT in "go" command.
    send(child, 'uci');
    send(child, `setoption name Threads value ${threads}`);
    send(child, `setoption name Hash value ${hash}`);
    send(child, `setoption name MultiPV value ${multipv}`);
    send(child, 'isready');
    send(child, 'ucinewgame');
    send(child, `position fen ${fen}`);
    send(child, `go depth ${depth}`);
  });
}

// ---------- Review position & lineage helpers ----------
function buildReviewFromSANs(sans) {
  const chess = new Chess(); // startpos
  for (const san of sans) {
    const mv = chess.move(san);
    if (!mv) throw new Error(`Invalid move in moves/PGN: ${san}`);
  }
  const fen = chess.fen();
  const stm = fen.split(' ')[1]; // 'w' or 'b'
  const plies = sans.length;
  const depthMove = computeDepthFromPlies(plies);
  const deckId = stm === 'w' ? 'white-other' : 'black-other';
  return { fen, stm, sans, depthMove, deckId };
}

/**
 * Find a parent for the given SAN path:
 * Parent must have moveSequence == childSans[0..-3] and its answer == childSans[-2].
 * (i.e., parent best move was played, then opponent replied → child position)
 */
function findParentForPath(cards, childSans) {
  if (!Array.isArray(childSans) || childSans.length < 2) return null; // depth-1 white/black => no parent
  const parentSans = childSans.slice(0, -2).join(' ');
  const parentPlayed = childSans[childSans.length - 2]; // parent's best move that child followed
  for (const c of cards) {
    if ((c?.fields?.moveSequence || '') === parentSans && c?.fields?.answer === parentPlayed) {
      return c;
    }
  }
  return null;
}

// ---------- Display helpers ----------
function formatEvalDisplay(score) {
  if (!score) return '';
  if (score.kind === 'mate') {
    const sgn = score.value >= 0 ? '+' : '-';
    return `${sgn}M${Math.abs(score.value)}`;
  }
  const pawns = score.value / 100;
  const abs = Math.abs(pawns);
  const shown = abs >= 1 ? pawns.toFixed(1) : pawns.toFixed(2);
  const sgn = pawns >= 0 ? '+' : '';
  return `${sgn}${shown}`;
}

// ---------- Main ----------
async function main() {
  // Build SAN list from args
  let sans = [];
  if (typeof MOVES_RAW !== 'undefined') {
    sans = movesToSANArray(MOVES_RAW);
  } else if (typeof PGN_RAW !== 'undefined') {
    sans = pgnToSANArray(PGN_RAW);
  } else {
    sans = []; // start position
  }

  // Review info
  const { fen, deckId, depthMove } = buildReviewFromSANs(sans);

  // Duplicate check
  const arr = loadCardsArray();
  const dup = arr.find(c => c?.fields?.fen === fen && c?.deck === deckId);
  if (dup) {
    console.log(`[make-card] Skipped: review position already exists in deck "${deckId}" as card ${dup.id}`);
    console.log(`  FEN: ${fen}`);
    return;
  }

  // Stockfish config
  const multipv = 1 + Math.max(0, Number(CFG.maxOtherAnswerCount) || 0);
  const depth = Math.max(1, Number(CFG.depth) || 25);
  const threads = Math.max(1, Number(CFG.threads) || 1);
  const hash = Math.max(32, Number(CFG.hash) || 1024);

  const infos = await analyzeWithStockfish(fen, { depth, threads, hash, multipv });
  if (!infos.length) throw new Error('Engine returned no PVs.');

  // Best line
  const bestInfo = infos.find(o => (o?.multipv || 1) === 1) || infos[0];
  const bestSanLine = uciToSanLine(fen, bestInfo.pv);
  const bestAnswerSAN = bestSanLine[0] || '';
  const bestEval = bestInfo.score
    ? { kind: bestInfo.score.kind, value: bestInfo.score.value, depth: bestInfo.depth }
    : undefined;

  // Other answers (unique SAN, within acceptance window)
  const cpWindow = Math.round(100 * (Number(CFG.otherAnswersAcceptance) || 0.2)); // in centipawns
  const others = [];
  const seen = new Set([bestAnswerSAN]);

  for (const it of infos) {
    const idx = it?.multipv || 1;
    if (idx === 1) continue;
    if (!it.score || !it.pv?.length) continue;

    const sanLine = uciToSanLine(fen, it.pv);
    const ans = sanLine[0];
    if (!ans || seen.has(ans)) continue;

    let keep = false;
    if (bestInfo.score?.kind === 'cp' && it.score.kind === 'cp') {
      // keep if not worse than cpWindow compared to best
      const delta = bestInfo.score.value - it.score.value; // ≥ 0 for worse or equal
      if (delta <= cpWindow) keep = true;
    } else if (bestInfo.score?.kind === 'mate' && it.score.kind === 'mate') {
      // same sign & longer/equal mate length
      const sameSign =
        (bestInfo.score.value >= 0 && it.score.value >= 0) ||
        (bestInfo.score.value < 0 && it.score.value < 0);
      if (sameSign && Math.abs(it.score.value) >= Math.abs(bestInfo.score.value)) keep = true;
    } else {
      // best=mate but alt=cp, or vice-versa -> skip
      keep = false;
    }

    if (keep) {
      seen.add(ans);
      others.push(ans);
      if (others.length >= CFG.maxOtherAnswerCount) break;
    }
  }

  // Example line = best PV (as SAN)
  const exampleLine = bestSanLine;

  // Answer FEN (apply best move)
  let answerFen;
  if (bestAnswerSAN) {
    const chess = new Chess(fen);
    const mv = chess.move(bestAnswerSAN);
    if (mv) answerFen = chess.fen();
  }

  // Determine parent (per new rule)
  let parentId;
  if (sans.length >= 2) {
    const parent = findParentForPath(arr, sans);
    if (parent) parentId = parent.id;
  }

  // Build fields (no `last`; with computed depth/parent)
  const fields = {
    moveSequence: sans.join(' '),
    fen,
    answer: bestAnswerSAN,
    answerFen,
    eval: bestEval,
    exampleLine,
    otherAnswers: others,
    depth: depthMove,
    ...(parentId ? { parent: parentId } : {}),
    // children/descendants are computed at load or filled when future children are added
  };

  // New card
  const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const card = {
    id,
    deck: deckId,
    tags: [],
    fields,
    due: 'new',
  };

  // If we found a parent, add this card id to its children (dedup)
  if (parentId) {
    const p = arr.find(c => c.id === parentId);
    if (p) {
      const next = new Set([...(p.fields.children || []), id]);
      p.fields.children = [...next];
    }
  }

  // Append to cards.json
  arr.push(card);
  saveCardsArray(arr);

  // Console output summary
  console.log(`[make-card] Added card ${id} to ${path.relative(ROOT, CARDS_PATH)}`);
  console.log(`  Deck: ${deckId}`);
  console.log(`  Review FEN: ${fen}`);
  console.log(`  Depth (move number): ${depthMove}`);
  console.log(`  Parent: ${parentId || '(none)'}`);
  console.log(`  Answer: ${bestAnswerSAN}`);
  console.log(`  Example line: ${exampleLine.join(' ') || '(none)'}`);
  console.log(`  Other answers: ${others.join(', ') || '(none)'}`);

  // Print evaluations for all options
  const optsLine = infos
    .sort((a, b) => (a.multipv || 1) - (b.multipv || 1))
    .map((it) => {
      const san0 = uciToSanLine(fen, it.pv)[0] || '?';
      const evalStr = it.score ? formatEvalDisplay(it.score) : '?';
      return `${san0} ${evalStr}`;
    })
    .join(', ');
  const bestDepth = bestInfo.depth ?? depth;
  console.log(`  Options (d=${bestDepth}): ${optsLine}`);
}

// Run
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
