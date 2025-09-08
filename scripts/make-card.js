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
 *
 * NEW (packaging-safe):
 * - Export `createCard({ movesSAN, moves, pgn, fen, resolveEngine })` to call from Electron without spawning Node.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';
import { resolveEnginePath } from './engine-path.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const CARDS_PATH = path.resolve(ROOT, 'src', 'data', 'cards.json');
const CONFIG_PATH = path.resolve(ROOT, 'src', 'data', 'cardgen.config.json');
const ANS_OVR_PATH = path.resolve(ROOT, 'src', 'data', 'answer-overrides.json');

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
const FEN_RAW   = args['--fen'];
// Per-run overrides (from Electron dev spawn)
const DEPTH_ARG   = args['--depth'];
const THREADS_ARG = args['--threads'];
const HASH_ARG    = args['--hash'];
const ACCEPT_ARG  = args['--accept'];
const MOAC_ARG    = args['--moac'];

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
// Custom JSON formatter for cards.json
function inlineJsonObject(obj) {
  // Inline object with spaces after ':' and ',' for readability
  const raw = JSON.stringify(obj);
  return raw.replace(/:/g, ': ').replace(/,/g, ', ');
}
function formatValue(val, indent = 0, keyCtx = '') {
  const sp = ' '.repeat(indent);
  if (val === null) return 'null';
  const t = typeof val;
  if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(val);
  if (Array.isArray(val)) {
    if (keyCtx === 'exampleLine') {
      // Single-line array for exampleLine
      return '[' + val.map(v => JSON.stringify(v)).join(', ') + ']';
    }
    if (keyCtx === 'otherAnswers') {
      // One item per line, each item inline
      const items = val.map((it) => {
        const s = (it && typeof it === 'object') ? inlineJsonObject(it) : JSON.stringify(it);
        return sp + '  ' + s;
      });
      return '[\n' + items.join(',\n') + '\n' + sp + ']';
    }
    const items = val.map((it) => sp + '  ' + formatValue(it, indent + 2, ''));
    return '[\n' + items.join(',\n') + '\n' + sp + ']';
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    const lines = keys.map((k) => {
      const v = val[k];
      const vStr = formatValue(v, indent + 2, k);
      return sp + '  ' + JSON.stringify(k) + ': ' + vStr;
    });
    return '{\n' + lines.join(',\n') + '\n' + sp + '}';
  }
  return JSON.stringify(val);
}
function formatCardsJson(arr) {
  return formatValue(arr, 0, '') + '\n';
}
function saveCardsArray(arr) {
  fs.mkdirSync(path.dirname(CARDS_PATH), { recursive: true });
  const out = formatCardsJson(arr);
  fs.writeFileSync(CARDS_PATH, out, 'utf-8');
}

// ---------- Forced Answers (FEN -> SAN) ----------
function loadAnswerOverrides() {
  try {
    if (!fs.existsSync(ANS_OVR_PATH)) return {};
    const raw = fs.readFileSync(ANS_OVR_PATH, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}
const OVR = loadAnswerOverrides();

// ---------- PGN / moves ----------
function pgnToSANArray(pgn) {
  const s = String(pgn || '');
  if (!s.trim()) return [];
  try {
    const c = new Chess();
    if (c.loadPgn(s, { sloppy: true })) {
      return c.history();
    }
  } catch {}
  const stripped = s
    .replace(/^\s*\[[^\]]*]\s*$/gm, '')
    .replace(/;[^\n\r]*/g, '')
    .replace(/\{[^}]*}/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\$\d+/g, '')
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .trim();
  return stripped.split(/\s+/).filter(Boolean);
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
function startEngine(resolveOpts = {}) {
  const exe = resolveEnginePath(resolveOpts);
  if (!fs.existsSync(exe)) throw new Error(`Stockfish not found at: ${exe}`);
  // Run Stockfish fully in the background. On Windows, windowsHide prevents a new console window.
  const child = spawn(exe, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: false,
  });
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
async function analyzeWithStockfish(fen, { depth, threads, hash, multipv }, resolveOpts = {}) {
  return await new Promise((resolve, reject) => {
    const child = startEngine(resolveOpts);
    const pvMap = new Map(); // multipv -> latest info
    let settled = false;

    const finish = (ok = true) => {
      if (settled) return; settled = true;
      try { child.stdin.end(); child.kill(); } catch {}
      const keys = [...pvMap.keys()].sort((a, b) => a - b);
      if (ok && keys.length) return resolve(keys.map(k => pvMap.get(k)));
      if (ok) return resolve([]);
      return reject(new Error('engine failed'));
    };

    // Safety timeout to avoid hangs (per-position)
    const TIMEOUT_MS = 28800000;
    const timer = setTimeout(() => { finish(true); }, TIMEOUT_MS);

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
          clearTimeout(timer);
          finish(true);
        }
      }
    });

    // Log engine errors without surfacing a console window
    try {
      child.stderr.on('data', (buf) => {
        const s = String(buf).trim();
        if (s) console.warn('[stockfish:stderr]', s);
      });
    } catch {}

    child.once('error', () => { clearTimeout(timer); finish(false); });

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

function buildReviewFromFEN(fenInput) {
  const fen = String(fenInput || '').trim();
  if (!fen) throw new Error('FEN input is empty');
  const parts = fen.split(/\s+/);
  const stm = parts[1] || 'w';
  const fullmove = parseInt(parts[5], 10);
  const depthMove = Number.isFinite(fullmove) ? fullmove : 0;
  const deckId = stm === 'w' ? 'white-other' : 'black-other';
  return { fen, stm, sans: [], depthMove, deckId };
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

// ---------- Programmatic API (exported) ----------
export async function createCard({
  movesSAN = [],
  moves = '',           // NEW: string alias accepted programmatically
  pgn = '',
  fen = '',
  config = undefined,
  resolveEngine = {},
  duplicateStrategy = 'skip'
} = {}) {
  // Build SAN list
  let sans = [];
  if (typeof fen === 'string' && fen.trim()) {
    sans = []; // explicit FEN mode, ignore moves/pgn
  } else if (Array.isArray(movesSAN) && movesSAN.length) {
    sans = movesSAN.slice();
  } else if (typeof moves === 'string' && moves.trim()) {
    // NEW: accept moves as a space/comma separated string
    sans = movesToSANArray(moves);
  } else if (typeof pgn === 'string' && pgn.trim()) {
    sans = pgnToSANArray(pgn);
  } else {
    sans = []; // start position
  }

  // Review info
  const review = (typeof fen === 'string' && fen.trim())
    ? buildReviewFromFEN(fen)
    : buildReviewFromSANs(sans);
  const { fen: reviewFEN, deckId, depthMove } = review;

  // Load cards and compute path key (duplicate handling occurs after config is loaded)
  const arr = loadCardsArray();
  const pathKey = sans.join(' ');

  // Stockfish config
  const baseCfg = CFG;
  const runCfg = {
    otherAnswersAcceptance: Number((config && config.otherAnswersAcceptance) ?? baseCfg.otherAnswersAcceptance),
    maxOtherAnswerCount:   Number((config && config.maxOtherAnswerCount)   ?? baseCfg.maxOtherAnswerCount),
    depth:                 Number((config && config.depth)                 ?? baseCfg.depth),
    threads:               Number((config && config.threads)               ?? baseCfg.threads),
    hash:                  Number((config && config.hash)                  ?? baseCfg.hash),
  };
  const multipv = 1 + Math.max(0, Number(runCfg.maxOtherAnswerCount) || 0);
  const depth = Math.max(1, Number(runCfg.depth) || 25);
  const threads = Math.max(1, Number(runCfg.threads) || 1);
  const hash = Math.max(32, Number(runCfg.hash) || 1024);

  // Duplicate handling (by exact move sequence for this deck)
  console.log(`[make-card] createCard: deck=${deckId} pathKey='${pathKey}' dupStrategy='${duplicateStrategy}'`);
  let overwriteId = null;
  const dupPath = arr.find(c => c?.fields?.moveSequence === pathKey && c?.deck === deckId);
  if (dupPath) {
    const mode = String(duplicateStrategy || 'skip');
    if (mode === 'skip') {
      console.log(`[make-card] duplicate detected (card ${dupPath.id}) -> skip`);
      return { ok: true, skipped: true, deckId, existingId: dupPath.id };
    } else if (mode === 'overwrite') {
      overwriteId = dupPath.id;
      console.log(`[make-card] duplicate detected (card ${dupPath.id}) -> overwrite in-place`);
    } else {
      console.log(`[make-card] duplicate detected (card ${dupPath.id}) -> unsupported mode '${mode}', default to skip`);
      return { ok: true, skipped: true, deckId, existingId: dupPath.id };
    }
  }

  // Transposition-aware; run engine only if needed or forced
  const key4 = (() => { try { return reviewFEN.split(/\s+/).slice(0,4).join(' '); } catch { return reviewFEN; } })();
  const sameFenCards = arr.filter(c => c?.deck === deckId && typeof c?.fields?.fen === 'string' && c.fields.fen.split(/\s+/).slice(0,4).join(' ') === key4);
  const forceEntry = OVR[key4] ?? OVR[reviewFEN];
  const forcedSAN = (typeof forceEntry === 'string') ? String(forceEntry) : (forceEntry && typeof forceEntry === 'object' ? String(forceEntry.move || '') : undefined);
  let infos = [];
  let engineMs = 0;
  const shouldRunEngine = !!overwriteId || !sameFenCards.length || !!forcedSAN;
  if (shouldRunEngine) {
    const t0 = Date.now();
    infos = await analyzeWithStockfish(reviewFEN, { depth, threads, hash, multipv }, resolveEngine);
    engineMs = Date.now() - t0;
    if (!infos.length && !sameFenCards.length && !forcedSAN && !overwriteId) {
      // If this is not an overwrite and we have no anchor and no forced answer, treat as failure
      throw new Error('Engine returned no PVs.');
    }
  }

  // Best line
  let bestInfo, bestSanLine, bestAnswerSAN, bestEval;
  if (infos.length) {
    bestInfo = infos.find(o => (o?.multipv || 1) === 1) || infos[0];
    bestSanLine = uciToSanLine(reviewFEN, bestInfo.pv);
    bestAnswerSAN = bestSanLine[0] || '';
    bestEval = bestInfo.score
      ? { kind: bestInfo.score.kind, value: bestInfo.score.value, depth: bestInfo.depth }
      : undefined;
  } else if (sameFenCards.length) {
    bestSanLine = sameFenCards[0]?.fields?.exampleLine || [];
    bestAnswerSAN = sameFenCards[0]?.fields?.answer || '';
    bestEval = sameFenCards[0]?.fields?.eval;
  }

  // Other answers (unique SAN, within acceptance window)
  const cpWindow = Math.round(100 * (Number(runCfg.otherAnswersAcceptance) || 0.2)); // in centipawns
  const others = [];
  const seen = new Set([bestAnswerSAN]);

  for (const it of infos) {
    const idx = it?.multipv || 1;
    if (idx === 1) continue;
    if (!it.score || !it.pv?.length) continue;

    const sanLine = uciToSanLine(reviewFEN, it.pv);
    const ans = sanLine[0];
    if (!ans || seen.has(ans)) continue;

    let keep = false;
    if (bestInfo?.score?.kind === 'cp' && it.score.kind === 'cp') {
      const delta = bestInfo.score.value - it.score.value; // ≥ 0 for worse or equal
      if (delta <= cpWindow) keep = true;
    } else if (bestInfo?.score?.kind === 'mate' && it.score.kind === 'mate') {
      const sameSign =
        (bestInfo.score.value >= 0 && it.score.value >= 0) ||
        (bestInfo.score.value < 0 && it.score.value < 0);
      if (sameSign && Math.abs(it.score.value) >= Math.abs(bestInfo.score.value)) keep = true;
    }

    if (keep) {
      seen.add(ans);
      others.push(ans);
      if (others.length >= runCfg.maxOtherAnswerCount) break;
    }
  }

  // If we didn't run engine (reused transposition anchor), reuse otherAnswers too
  if ((!infos || infos.length === 0) && sameFenCards.length) {
    const anchor = sameFenCards[0];
    if (Array.isArray(anchor?.fields?.otherAnswers)) {
      for (const x of anchor.fields.otherAnswers) {
        if (!seen.has(x)) others.push(x);
        if (others.length >= runCfg.maxOtherAnswerCount) break;
      }
    }
  }

  // Normalize otherAnswers to objects with evals and ensure at least one option
  try {
    // Build a SAN -> eval map from engine infos for alternatives
    const altEvalMap = new Map();
    for (const it of infos || []) {
      const idx = it?.multipv || 1;
      if (idx === 1 || !it.pv || !it.pv.length) continue;
      const sanLine = uciToSanLine(reviewFEN, it.pv);
      const ans = sanLine[0];
      if (!ans) continue;
      altEvalMap.set(ans, it.score ? { kind: it.score.kind, value: it.score.value, depth: it.depth } : undefined);
    }

    // Convert legacy string list into [{move, eval}] form
    let othersObjs = [];
    for (const item of others) {
      if (typeof item === 'string') {
        const ev = altEvalMap.get(item);
        othersObjs.push({ move: item, eval: ev });
      } else if (item && typeof item === 'object' && item.move) {
        othersObjs.push(item);
      }
    }

    // Ensure at least one other answer exists (only when MultiPV > 1)
    if (othersObjs.length === 0 && multipv > 1 && infos && infos.length) {
      const alt = infos.find(o => (o?.multipv || 1) > 1);
      if (alt && alt.pv && alt.pv.length) {
        const sanLine = uciToSanLine(reviewFEN, alt.pv);
        const ans = sanLine[0];
        if (ans) othersObjs.push({ move: ans, eval: alt.score ? { kind: alt.score.kind, value: alt.score.value, depth: alt.depth } : undefined });
      }
    }

    // Replace others with normalized
    others.length = 0;
    for (const o of othersObjs) others.push(o);
  } catch {}

  // Example line = best PV (as SAN)
  const exampleLine = bestSanLine || [];

  // Answer FEN (apply best move)
  let answerFen;
  if (bestAnswerSAN) {
    const chess = new Chess(reviewFEN);
    const mv = chess.move(bestAnswerSAN);
    if (mv) answerFen = chess.fen();
  }

  // Determine parent
  let parentId;
  if (sans.length >= 2) {
    const parent = findParentForPath(arr, sans);
    if (parent) parentId = parent.id;
  }

  // Capture creation criteria for reproducibility
  const creationCriteria = (() => {
    const criteria = {
      createdAt: new Date().toISOString(),
      input: {
        movesSAN: Array.isArray(sans) ? sans.slice() : [],
        pgn: (typeof pgn === 'string' ? pgn : ''),
        fen: reviewFEN,
      },
      configUsed: {
        otherAnswersAcceptance: runCfg.otherAnswersAcceptance,
        maxOtherAnswerCount: runCfg.maxOtherAnswerCount,
        depth,
        threads,
        hash,
        multipv,
        acceptanceCpWindow: cpWindow,
      },
      engineTimeMs: engineMs,
      engineBest: bestAnswerSAN ? { move: bestAnswerSAN, eval: bestEval } : undefined,
      forced: (() => {
        const v = OVR[key4] ?? OVR[reviewFEN];
        if (!v) return undefined;
        const move = (typeof v === 'string') ? v : (v && v.move) ? v.move : undefined;
        return move ? { move } : undefined;
      })(),
    };
    try {
      criteria.enginePath = resolveEnginePath(resolveEngine);
    } catch {}
    return criteria;
  })();

  // Build fields
  const fields = {
    moveSequence: sans.join(' '),
    fen: reviewFEN,
    answer: bestAnswerSAN,
    answerFen,
    eval: bestEval,
    exampleLine,
    otherAnswers: others,
    depth: depthMove,
    engineTimeMs: engineMs,
    creationCriteria,
    ...(parentId ? { parent: parentId } : {}),
  };

  // New card (or overwrite existing)
  let id = overwriteId || `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const card = { id, deck: deckId, tags: [], fields, due: 'new' };

  // Apply forced/anchor answer selection and transposition rules
  try {
    const chosenForced = (() => { const v = OVR[key4] ?? OVR[reviewFEN]; if (!v) return ''; if (typeof v === 'string') return v; if (typeof v === 'object') return v.move || ''; return ''; })();
    const chosen = ( chosenForced || (sameFenCards[0]?.fields?.answer) || bestAnswerSAN || '' ).trim();
    if (chosen && card.fields.answer !== chosen) {
      card.fields.answer = chosen;
      try {
        const chessX = new Chess(reviewFEN);
        const mvX = chessX.move(chosen, { sloppy: true });
        if (mvX) card.fields.answerFen = chessX.fen();
      } catch {}
    }
    // If a forced answer is applied and it's not the engine's best, include the best in otherAnswers
    if (chosenForced && bestAnswerSAN && chosen !== bestAnswerSAN) {
      const list = Array.isArray(card.fields.otherAnswers) ? card.fields.otherAnswers : [];
      const alreadyHasBest = list.some(o => (typeof o === 'string' ? o : o?.move) === bestAnswerSAN);
      if (!alreadyHasBest) {
        card.fields.otherAnswers = [{ move: bestAnswerSAN, eval: bestEval }, ...list];
      }
    }
    if ((!infos || !infos.length) && sameFenCards.length) {
      const anchor = sameFenCards[0];
      if (Array.isArray(anchor?.fields?.otherAnswers)) {
        card.fields.otherAnswers = anchor.fields.otherAnswers.map(x => (typeof x === 'string') ? { move: x, eval: undefined } : x);
      }
      if (!card.fields.eval && anchor?.fields?.eval) card.fields.eval = anchor.fields.eval;
      if ((!card.fields.exampleLine || !card.fields.exampleLine.length) && Array.isArray(anchor?.fields?.exampleLine)) {
        card.fields.exampleLine = [...anchor.fields.exampleLine];
      }
    }
    if (sameFenCards.length) {
      let mutated = false;
      for (const c of sameFenCards) {
        if (c?.fields?.answer !== card.fields.answer) {
          c.fields.answer = card.fields.answer;
          try {
            const chessY = new Chess(c.fields.fen || reviewFEN);
            const mvY = chessY.move(card.fields.answer, { sloppy: true });
            if (mvY) c.fields.answerFen = chessY.fen();
          } catch {}
          mutated = true;
        }
      }
      if (mutated) saveCardsArray(arr);
    }
  } catch {}

  // If we found a parent, add this card id to its children (dedup)
  if (parentId) {
    const p = arr.find(c => c.id === parentId);
    if (p) {
      const next = new Set([...(p.fields.children || []), id]);
      p.fields.children = [...next];
    }
  }

  // Append or overwrite in cards.json
  if (overwriteId) {
    const idx = arr.findIndex(c => c.id === overwriteId);
    console.log(`[make-card] overwrite path: overwriteId=${overwriteId} idx=${idx}`);
    if (idx >= 0) {
      // Overwrite entirely (do not preserve tags or due)
      const prev = arr[idx];
      const next = { id: prev.id, deck: deckId, tags: [], fields: card.fields, due: 'new' };
      arr[idx] = next;
      console.log(`[make-card] overwrote existing card id=${prev.id}`);
    } else {
      console.log(`[make-card] overwriteId not found; pushing as new card id=${id}`);
      arr.push(card);
    }
  } else {
    arr.push(card);
    console.log(`[make-card] appended new card id=${id}`);
  }
  saveCardsArray(arr);

  // Console output summary
  console.log(`${overwriteId ? '[make-card] Overwrote card' : '[make-card] Added card'} ${id} to ${path.relative(ROOT, CARDS_PATH)}`);
  console.log(`  Deck: ${deckId}`);
  console.log(`  Review FEN: ${reviewFEN}`);
  console.log(`  Depth (move number): ${depthMove}`);
  console.log(`  Parent: ${parentId || '(none)'}`);
  console.log(`  Answer: ${card.fields.answer}`);
  console.log(`  Example line: ${exampleLine.join(' ') || '(none)'}`);
  try {
    const othersOut = (Array.isArray(others) && others.length)
      ? others.map(o => {
          if (typeof o === 'string') return o;
          const mv = o?.move || '';
          const ev = o?.eval ? ` ${formatEvalDisplay(o.eval)}` : '';
          return `${mv}${ev}`.trim();
        }).join(', ')
      : '(none)';
    console.log(`  Other answers: ${othersOut}`);
  } catch {
    console.log(`  Other answers: (unavailable)`);
  }
  try {
    const secs = (engineMs / 1000).toFixed(engineMs >= 10000 ? 0 : 1);
    console.log(`  Engine time: ${secs}s`);
  } catch {}

  if (Array.isArray(exampleLine) && exampleLine.length) {
    console.log(`  Options: ${exampleLine[0]} (best)`);
  }

  return { ok: true, id, deckId };
}

// ---------- CLI runner ----------
async function main() {
  const movesSAN = typeof MOVES_RAW !== 'undefined' ? movesToSANArray(MOVES_RAW) : [];
  const pgn = (movesSAN.length ? '' : (PGN_RAW || ''));
  const fen = (typeof FEN_RAW === 'string' ? FEN_RAW : '');
  // Build per-run config overrides (if provided via CLI)
  const cfgOverride = {};
  if (typeof ACCEPT_ARG  !== 'undefined') cfgOverride.otherAnswersAcceptance = Number(ACCEPT_ARG);
  if (typeof MOAC_ARG    !== 'undefined') cfgOverride.maxOtherAnswerCount   = Number(MOAC_ARG);
  if (typeof DEPTH_ARG   !== 'undefined') cfgOverride.depth                 = Number(DEPTH_ARG);
  if (typeof THREADS_ARG !== 'undefined') cfgOverride.threads               = Number(THREADS_ARG);
  if (typeof HASH_ARG    !== 'undefined') cfgOverride.hash                  = Number(HASH_ARG);
  // CLI path is for development only; duplicates are always skipped.
  await createCard({ movesSAN, pgn, fen, config: cfgOverride, duplicateStrategy: 'skip' });
}

const isCli = (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url);
if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
