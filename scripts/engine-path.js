// Resolves the Stockfish binary path with sane defaults and overrides.
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allow overriding with env var
const ENV_PATH = process.env.STOCKFISH_PATH;

// Map platform/arch -> default binary path (dev-time)
function defaultDevPath() {
  const root = path.join(__dirname, '..');
  const plat = process.platform;   // 'win32' | 'darwin' | 'linux'
  const arch = process.arch;       // 'x64' | 'arm64' | ...
  if (plat === 'win32' && arch === 'x64') {
    return path.join(root, 'engines', 'win-x64', 'stockfish.exe');
  }
  if (plat === 'darwin' && arch === 'arm64') {
    return path.join(root, 'engines', 'mac-arm64', 'stockfish');
  }
  if (plat === 'linux' && arch === 'x64') {
    return path.join(root, 'engines', 'linux-x64', 'stockfish');
  }
  // Fallback (adjust as you add more bins)
  return path.join(root, 'engines', 'win-x64', 'stockfish.exe');
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

  // In packaged builds, we recommend copying engines under resources/engines/
  // (see package.json > build.extraResources) so we can resolve relative to resources.
  const plat = process.platform;
  const arch = process.arch;
  const mapping = (p, a) => {
    if (p === 'win32' && a === 'x64') return ['engines', 'win-x64', 'stockfish.exe'];
    if (p === 'darwin' && a === 'arm64') return ['engines', 'mac-arm64', 'stockfish'];
    if (p === 'linux' && a === 'x64') return ['engines', 'linux-x64', 'stockfish'];
    return ['engines', 'win-x64', 'stockfish.exe'];
  };

  const rel = mapping(plat, arch);
  const candidate = packaged
    ? path.join(baseDir, ...rel)                      // e.g., resources/engines/...
    : defaultDevPath();                               // dev layout

  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Stockfish not found at: ${candidate}\n` +
      `Set STOCKFISH_PATH or place the binary under /engines/<platform-arch>/`
    );
  }
  return candidate;
}
