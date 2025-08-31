// Run: node scripts/analyze-fen.js --fen "<FEN>" --depth=20 --multipv=3 --timeout=30000 [--keepSide true]
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { Chess } from 'chess.js';
import { resolveEnginePath } from './engine-path.js';

function arg(key, def) {
  const i = process.argv.findIndex(a => a === `--${key}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

function maybeNormalizeStartFen(fen, keepSide = false, hasPgn = false) {
  try {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 2) return fen;
    const [placement, stm] = parts;
    if (!keepSide && !hasPgn && placement === START_PLACEMENT && stm === 'b') {
      parts[1] = 'w';
      const normalized = parts.join(' ');
      console.log('ℹ️  Normalized start position FEN from Black-to-move to White-to-move.');
      return normalized;
    }
  } catch {}
  return fen;
}

const fenRaw = arg('fen', null);
const depth = parseInt(arg('depth', '20'), 10);
const multipv = parseInt(arg('multipv', '1'), 10);
const timeoutMs = parseInt(arg('timeout', '30000'), 10);
const keepSide = String(arg('keepSide', 'false')).toLowerCase() === 'true';

if (!fenRaw) {
  console.error('Usage: node scripts/analyze-fen.js --fen "<FEN>" [--depth 20] [--multipv 1] [--timeout 30000] [--keepSide true]');
  process.exit(1);
}

const fen = maybeNormalizeStartFen(fenRaw, keepSide, false);

const enginePath = resolveEnginePath();
const sf = spawn(enginePath, [], { stdio: 'pipe' });
const rl = readline.createInterface({ input: sf.stdout });
const send = (s) => sf.stdin.write(s + '\n');

let gotUciOk = false;
let gotReadyOk = false;
let bestMove = null;
const infos = [];

const timer = setTimeout(() => {
  try { send('stop'); } catch {}
  try { send('quit'); } catch {}
  console.error('Timed out waiting for engine.');
  process.exit(1);
}, timeoutMs);

rl.on('line', (line) => {
  if (!line) return;
  if (line === 'uciok') gotUciOk = true;
  if (line === 'readyok') gotReadyOk = true;
  if (line.startsWith('info depth')) infos.push(line);
  if (line.startsWith('bestmove')) {
    bestMove = line.split(' ')[1] || null;
    clearTimeout(timer);
    try { send('quit'); } catch {}
  }
});

sf.on('spawn', () => { send('uci'); });
sf.stderr.on('data', () => {}); // silence

sf.on('close', () => {
  // Parse infos
  const pvs = {};
  for (const l of infos) {
    const m = l.match(/multipv (\d+).*?score (cp|mate) (-?\d+).*?pv (.+)$/);
    const d = l.match(/^info depth (\d+)/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const kind = m[2];
    const val = parseInt(m[3], 10);
    const pv = m[4].trim().split(/\s+/);
    const dep = d ? parseInt(d[1], 10) : depth;
    pvs[idx] = { score: { kind, value: val, depth: dep }, pvUci: pv };
  }

  // Sanity: ensure bestMove is legal from FEN
  if (bestMove) {
    const chess = new Chess(fen);
    const legal = chess.moves({ verbose: true }).some(m => m.from + m.to + (m.promotion || '') === bestMove);
    if (!legal) {
      console.warn('⚠️  Engine bestmove not legal from FEN; dropping it.');
      bestMove = null;
    }
  }

  console.log(JSON.stringify({ normalizedFen: fen, bestMoveUci: bestMove, multipv, results: pvs }, null, 2));
  process.exit(0);
});

(async function drive() {
  while (!gotUciOk) await new Promise(r => setTimeout(r, 10));
  send(`setoption name MultiPV value ${multipv}`);
  send('isready');
  while (!gotReadyOk) await new Promise(r => setTimeout(r, 10));
  gotReadyOk = false;

  send('ucinewgame');
  send(`position fen ${fen}`);
  send('isready');
  while (!gotReadyOk) await new Promise(r => setTimeout(r, 10));

  send(`go depth ${depth}`);
})();
