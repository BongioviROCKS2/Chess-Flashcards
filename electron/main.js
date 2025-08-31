// electron/main.js  (ESM)
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const isDev = !app.isPackaged;
const ROOT = process.cwd();

// Prefer preload.cjs; fall back to .mjs/.js if needed (for debugging)
const PRELOAD_CJS = path.resolve(__dirname, 'preload.cjs');
const PRELOAD_MJS = path.resolve(__dirname, 'preload.mjs');
const PRELOAD_JS  = path.resolve(__dirname, 'preload.js');
const PRELOAD = [PRELOAD_CJS, PRELOAD_MJS, PRELOAD_JS].find(p => fs.existsSync(p)) || PRELOAD_CJS;

const CARDS_PATH  = path.resolve(ROOT, 'src', 'data', 'cards.json');
const CONFIG_PATH = path.resolve(ROOT, 'src', 'data', 'cardgen.config.json');

function createWindow() {
  console.log('[main] preload path:', PRELOAD, 'exists=', fs.existsSync(PRELOAD));

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    show: true,
  });

  if (isDev) {
    win.loadURL('http://localhost:5173/');
    // win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function loadCardsArray() {
  try {
    const raw = fs.readFileSync(CARDS_PATH, 'utf-8').trim();
    if (raw === '') return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.cards)) return parsed.cards; // legacy
    return [];
  } catch (e) {
    console.error('[cards] load failed:', e);
    return [];
  }
}
function saveCardsArray(arr) {
  fs.mkdirSync(path.dirname(CARDS_PATH), { recursive: true });
  fs.writeFileSync(CARDS_PATH, JSON.stringify(arr, null, 2) + '\n', 'utf-8');
}

function registerIpc() {
  // Save Stockfish cardgen defaults from Settings
  ipcMain.handle('cardgen:save-config', async (_evt, cfg) => {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      return true;
    } catch (e) {
      console.error('[cardgen:save-config] failed:', e);
      return false;
    }
  });

  // Run scripts/make-card.js with args from the renderer (Stockfish Assisted create)
  ipcMain.handle('cardgen:make-card', async (_evt, payload) => {
    try {
      const script = path.resolve(ROOT, 'scripts', 'make-card.js');
      const args = [script];

      if (payload?.moves)   { args.push('--moves', String(payload.moves)); }
      if (payload?.pgn)     { args.push('--pgn', String(payload.pgn)); }
      if (payload?.fen)     { args.push('--fen', String(payload.fen)); }

      const cfg = payload?.config || {};
      if (typeof cfg.otherAnswersAcceptance === 'number') args.push('--accept', String(cfg.otherAnswersAcceptance));
      if (typeof cfg.maxOtherAnswerCount   === 'number') args.push('--moac',   String(cfg.maxOtherAnswerCount));
      if (typeof cfg.depth                 === 'number') args.push('--depth',  String(cfg.depth));
      if (typeof cfg.threads               === 'number') args.push('--threads',String(cfg.threads));
      if (typeof cfg.hash                  === 'number') args.push('--hash',   String(cfg.hash));

      // Use user's Node on PATH; fallback message if not found
      const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';

      return await new Promise((resolve) => {
        const child = spawn(nodeCmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', (code) => {
          if (code === 0) {
            resolve({ ok: true, message: stdout.trim() || 'Card created.' });
          } else {
            resolve({ ok: false, message: (stderr.trim() || `make-card exited with code ${code}`) });
          }
        });
        child.on('error', (err) => {
          resolve({ ok: false, message: `Failed to start Node: ${err?.message || String(err)}` });
        });
      });
    } catch (e) {
      console.error('[cardgen:make-card] failed:', e);
      return { ok: false, message: e?.message || 'Unknown error' };
    }
  });

  // Cards file I/O: read/update/create
  ipcMain.handle('cards:readOne', async (_evt, id) => {
    try {
      const arr = loadCardsArray();
      return arr.find(x => x && x.id === id) || null;
    } catch (e) {
      console.error('[cards:readOne] failed:', e);
      return null;
    }
  });

  ipcMain.handle('cards:update', async (_evt, updated) => {
    try {
      const arr = loadCardsArray();
      const idx = arr.findIndex(x => x && x.id === updated.id);
      if (idx === -1) {
        console.warn('[cards:update] id not found:', updated?.id);
        return false;
      }
      arr[idx] = updated;
      saveCardsArray(arr);
      return true;
    } catch (e) {
      console.error('[cards:update] failed:', e);
      return false;
    }
  });

  ipcMain.handle('cards:create', async (_evt, card) => {
    try {
      const arr = loadCardsArray();
      if (arr.some(x => x && x.id === card?.id)) {
        console.warn('[cards:create] duplicate id:', card?.id);
        return false;
      }
      arr.push(card);
      saveCardsArray(arr);
      return true;
    } catch (e) {
      console.error('[cards:create] failed:', e);
      return false;
    }
  });

  console.log('[main] IPC handlers registered: cardgen:save-config, cardgen:make-card, cards:readOne, cards:update, cards:create');
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
