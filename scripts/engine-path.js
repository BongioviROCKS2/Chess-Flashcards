// Resolves the Stockfish binary path with sane defaults and overrides.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allow overriding with env var
const ENV_PATH = process.env.STOCKFISH_PATH;

// ----- helpers -----
function archDir(plat, arch) {
  if (plat === 'win32' && arch === 'x64') return 'win-x64';
  if (plat === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (plat === 'linux' && arch === 'x64') return 'linux-x64';
  // default to win-x64 layout so at least the path shape is consistent
  return 'win-x64';
}

function list(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** pick a stockfish binary within dir (handles versioned/variant filenames) */
function findEngineInDir(dir, plat) {
  const files = list(dir);
  if (!files.length) return null;

  // candidates: names starting with "stockfish"
  let cands = files.filter(f => /^stockfish.*$/i.test(f));
  if (!cands.length) return null;

  // On Windows require .exe; on *nix prefer no extension (or any file named stockfish)
  if (plat === 'win32') cands = cands.filter(f => /\.exe$/i.test(f));

  // Prefer AVX512/AVX2 if present, then x86-64, then longest/most specific name
  const score = (f) => {
    const s = f.toLowerCase();
    return (
      (s.includes('avx512') ? 4 : 0) +
      (s.includes('avx2')   ? 3 : 0) +
      (s.includes('x86-64') ? 2 : 0) +
      (s.includes('modern') ? 1 : 0) +
      Math.min(1, (s.match(/\d+/g)?.length || 0)) // versioned names get a tiny bump
    );
  };
  cands.sort((a, b) => score(b) - score(a) || b.length - a.length);
  const pick = cands[0];
  const full = path.join(dir, pick);
  return fs.existsSync(full) ? full : null;
}

// Map platform/arch -> default binary path (dev-time)
function defaultDevPath() {
  const root = path.join(__dirname, '..');
  const plat = process.platform;
  const arch = process.arch;
  const dir = path.join(root, 'engines', archDir(plat, arch));

  // try canonical name first
  const first = plat === 'win32'
    ? path.join(dir, 'stockfish.exe')
    : path.join(dir, 'stockfish');

  if (fs.existsSync(first)) return first;

  // otherwise, search for any stockfish* in the dir
  const found = findEngineInDir(dir, plat);
  if (found) return found;

  // fallback (will error later)
  return first;
}

/**
 * Resolve engine path for scripts (dev) OR for packaged app (when used from Electron main).
 * - For scripts you run with `node scripts/...`, app.isPackaged isn't available; we use dev path.
 * - If you reuse this resolver in Electron main, pass `opts.baseDir` as
 *   `process.resourcesPath` and set `opts.packaged = true` so it looks in resources.
 */
export function resolveEnginePath(opts = {}) {
  const baseDir = opts.baseDir || path.join(__dirname, '..');
  const packaged = !!opts.packaged;

  if (ENV_PATH && fs.existsSync(ENV_PATH)) return ENV_PATH;

  const plat = process.platform;
  const arch = process.arch;
  const subdir = archDir(plat, arch);

  if (packaged) {
    // resources/engines/<subdir>/(stockfish[.exe] | any stockfish* variant)
    const enginesDir = path.join(baseDir, 'engines', subdir);
    const canonical = plat === 'win32'
      ? path.join(enginesDir, 'stockfish.exe')
      : path.join(enginesDir, 'stockfish');

    if (fs.existsSync(canonical)) return canonical;

    const found = findEngineInDir(enginesDir, plat);
    if (found) return found;

    throw new Error(
      `Stockfish not found under ${enginesDir}\n` +
      `Set STOCKFISH_PATH or place a binary named like "stockfish" or "stockfish*.exe" in that folder.`
    );
  }

  // dev layout
  const candidate = defaultDevPath();
  if (!fs.existsSync(candidate)) {
    const dir = path.dirname(candidate);
    const found = findEngineInDir(dir, plat);
    if (found) return found;
    throw new Error(
      `Stockfish not found at: ${candidate}\n` +
      `Set STOCKFISH_PATH or place a binary under ${dir} (e.g., stockfish.exe, stockfish17.1.exe, stockfish-windows-x86-64-avx2.exe).`
    );
  }
  return candidate;
}
