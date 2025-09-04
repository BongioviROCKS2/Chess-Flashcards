// electron/main.js  (ESM)
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const isDev = !app.isPackaged;
const ROOT = process.cwd();

// Prefer preload.cjs; fall back to .mjs/.js if needed (for debugging)
const PRELOAD_CJS = path.resolve(__dirname, 'preload.cjs');
const PRELOAD_MJS = path.resolve(__dirname, 'preload.mjs');
const PRELOAD_JS  = path.resolve(__dirname, 'preload.js');
const PRELOAD = [PRELOAD_CJS, PRELOAD_MJS, PRELOAD_JS].find(p => fs.existsSync(p)) || PRELOAD_CJS;

const CARDS_PATH   = path.resolve(ROOT, 'src', 'data', 'cards.json');
const CONFIG_PATH  = path.resolve(ROOT, 'src', 'data', 'cardgen.config.json');
const SCANNED_PATH = path.resolve(ROOT, 'src', 'data', 'chesscom-scanned.json');
const ANS_OVR_PATH = path.resolve(ROOT, 'src', 'data', 'answer-overrides.json');
const DECK_LIMITS_PATH = path.resolve(ROOT, 'src', 'data', 'deckSettings.json');

// -------------------- Answer overrides helpers (moved up: used by IPC) --------------------
function loadAnswerOverrides() {
  try {
    if (!fs.existsSync(ANS_OVR_PATH)) return {};
    const raw = fs.readFileSync(ANS_OVR_PATH, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    console.warn('[answers] failed to read answer-overrides; using empty.', e);
    return {};
  }
}
function saveAnswerOverrides(obj) {
  try {
    fs.mkdirSync(path.dirname(ANS_OVR_PATH), { recursive: true });
    fs.writeFileSync(ANS_OVR_PATH, JSON.stringify(obj || {}, null, 2) + '\n', 'utf-8');
    return true;
  } catch (e) {
    console.error('[answers] failed to write answer-overrides:', e);
    return false;
  }
}

function createWindow() {
  console.log('[main] preload path:', PRELOAD, 'exists=', fs.existsSync(PRELOAD));

  // Resolve a platform-appropriate icon for the app window (title bar)
  const getIconPath = () => {
    const rootAssets = path.resolve(ROOT, 'assets');
    const dirAssets  = path.resolve(__dirname, '..', 'assets');

    /** Build candidate paths in priority order and return the first that exists */
    const pick = (candidates) => candidates.find(p => fs.existsSync(p));

    if (process.platform === 'win32') {
      return pick([
        path.join(rootAssets, 'logo.ico'),
        path.join(dirAssets,  'logo.ico'),
      ]);
    }
    if (process.platform === 'linux') {
      return pick([
        path.join(rootAssets, 'icons', 'png', 'logo-512x512.png'),
        path.join(rootAssets, 'icons', 'png', 'logo-256x256.png'),
        path.join(dirAssets,  'icons', 'png', 'logo-512x512.png'),
        path.join(dirAssets,  'icons', 'png', 'logo-256x256.png'),
        path.join(rootAssets, 'logo.png'),
        path.join(dirAssets,  'logo.png'),
      ]);
    }
    // On macOS the BrowserWindow icon is generally ignored, but set anyway
    return pick([
      path.join(rootAssets, 'logo.png'),
      path.join(dirAssets,  'logo.png'),
    ]);
  };

  const ICON = getIconPath();
  if (ICON) console.log('[main] using window icon:', ICON);
  else console.warn('[main] no window icon found in assets');

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
    icon: ICON,
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
  // -------------------- Helpers (shared) --------------------
  const loadScannedLedger = () => {
    try {
      if (!fs.existsSync(SCANNED_PATH)) return {};
      const raw = fs.readFileSync(SCANNED_PATH, 'utf-8').trim();
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      console.warn('[scan] failed to read scanned ledger; starting new.', e);
      return {};
    }
  };
  const saveScannedLedger = (obj) => {
    try {
      fs.mkdirSync(path.dirname(SCANNED_PATH), { recursive: true });
      fs.writeFileSync(SCANNED_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
      return true;
    } catch (e) {
      console.error('[scan] failed to write scanned ledger:', e);
      return false;
    }
  };

  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  async function fetchJson(url) {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        // Provide a UA per chess.com API guidance
        'User-Agent': 'ChessFlashcards/0.1 (+https://github.com/)'
      },
      cache: 'no-store',
    }).catch((e) => ({ ok: false, status: 0, statusText: e?.message }));
    if (!res || !res.ok) {
      const code = res?.status || 'ERR';
      const msg = res?.statusText || 'network error';
      throw new Error(`HTTP ${code} for ${url} (${msg})`);
    }
    return await res.json();
  }

  function pgnToSANArray(pgn) {
    const s = String(pgn || '');
    if (!s.trim()) return [];
    // Prefer chess.js parser — it handles headers, comments, variations, NAGs.
    try {
      const c = new Chess();
      if (c.loadPgn(s, { sloppy: true })) {
        return c.history(); // array of SAN strings
      }
    } catch {}
    // Fallback (rare): strip headers/comments/variations; then tokenize
    const stripped = s
      .replace(/^\s*\[[^\]]*]\s*$/gm, '') // PGN tag pairs
      .replace(/;[^\n\r]*/g, '')          // ; line comments
      .replace(/\{[^}]*}/g, '')           // { } comments
      .replace(/\([^)]*\)/g, '')          // ( ) variations
      .replace(/\$\d+/g, '')              // NAGs
      .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '') // results
      .replace(/\d+\.(\.\.)?/g, ' ')      // move numbers
      .trim();
    return stripped.split(/\s+/).filter(Boolean);
  }


  const findCardByFenDeck = (arr, fen, deckId) => arr.find(c => c?.fields?.fen === fen && c?.deck === deckId);

  // ---------- Make-card runner (packaging-safe) ----------
  function runMakeCardWithMoves(movesSAN = [], { timeoutMs = 30000 } = {}) {
    // In packaged builds, call the exported API directly (no system Node dependency).
    if (!isDev) {
      return (async () => {
        try {
          const script = path.resolve(ROOT, 'scripts', 'make-card.js');
          const mod = await import(pathToFileURL(script).href);
          if (typeof mod?.createCard !== 'function') {
            throw new Error('createCard export not found in make-card.js');
          }
          await mod.createCard({
            movesSAN,
            resolveEngine: { baseDir: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'), packaged: app.isPackaged }
          });
          return { ok: true, code: 0, stdout: '' };
        } catch (e) {
          console.warn('[scan] programmatic make-card failed:', e?.message || e);
          return { ok: false, code: -1, error: e?.message || String(e) };
        }
      })();
    }

    // In dev, keep spawning Node (with robust error/timeout handling).
    return new Promise((resolve) => {
      try {
        const script = path.resolve(ROOT, 'scripts', 'make-card.js');
        const args = [script, '--moves', movesSAN.join(' ')];
        const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
        console.log(`[scan] make-card spawn moves=${movesSAN.length} first='${(movesSAN[0]||'')}'`);
        const child = spawn(nodeCmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

        let out = '';
        let settled = false;
        const cleanup = (result) => {
          if (settled) return;
          settled = true;
          try { clearTimeout(timer); } catch {}
          try { child.stdout?.removeAllListeners(); } catch {}
          try { child.stderr?.removeAllListeners(); } catch {}
          resolve(result);
        };

        child.stdout.on('data', (buf) => { out += String(buf); });
        child.stderr.on('data', (buf) => { const s = String(buf).trim(); if (s) console.warn('[make-card:stderr]', s); });

        child.once('error', (err) => {
          console.warn('[scan] make-card spawn error:', err?.message || err);
          cleanup({ ok: false, code: -1, error: err?.message || String(err) });
        });

        const timer = setTimeout(() => {
          console.warn('[scan] make-card timeout, killing child');
          try { child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch {}
        }, timeoutMs);

        child.once('close', (code) => {
          if (code === 0) console.log('[scan] make-card ok');
          else console.warn('[scan] make-card exited', code);
          cleanup({ ok: code === 0, stdout: out, code });
        });
      } catch (e) {
        console.error('[scan] make-card spawn error', e);
        resolve({ ok: false, error: e });
      }
    });
  }

  // Count user's to-move review positions in a game (for progress granularity)
  function countUserPositions(sans, userColor) {
    const c = new Chess();
    let total = 0;
    for (let i = 0; i < sans.length; i++) {
      if (c.turn() === userColor) total += 1;
      const mv = c.move(sans[i]);
      if (!mv) break;
    }
    return total || 1;
  }

  async function scanOneGameForUser(game, usernameLC, onPosProgress /* (posIdx, posTotal) => void */) {
    const url = String(game?.url || '').trim();
    const pgn = String(game?.pgn || '').trim();
    if (!url || !pgn) return { skipped: true };
    const whiteUser = String(game?.white?.username || '').toLowerCase();
    const blackUser = String(game?.black?.username || '').toLowerCase();
    const userColor = usernameLC === whiteUser ? 'w' : (usernameLC === blackUser ? 'b' : null);
    if (!userColor) { console.log('[scanGame] skip (not user game):', url); return { skipped: true }; }

    const sans = pgnToSANArray(pgn);
    const chess = new Chess();
    let i = 0;
    let created = 0;
    let posIdx = 0;
    const posTotal = countUserPositions(sans, userColor);

    console.log(`[scanGame] start url=${url} color=${userColor} plies=${sans.length} positions=${posTotal}`);

    while (i < sans.length) {
      const turn = chess.turn(); // 'w' or 'b'
      if (turn !== userColor) {
        // Not user's turn; advance one move from game if available
        const san = sans[i++];
        const mv = chess.move(san);
        if (!mv) { console.warn('[scanGame] invalid move while skipping opp move:', san); break; }
        continue;
      }

      // User review position tick
      posIdx += 1;
      try { onPosProgress?.(posIdx, posTotal); } catch {}

      // Review position for user side
      const fen = chess.fen();
      const deckId = (turn === 'w') ? 'white-other' : 'black-other';

      // Ensure a card exists for this exact PGN path (create if missing)
      let arr = loadCardsArray();
      const pathKey = chess.history().join(' ');
      let card = arr.find(c => c?.deck === deckId && (c?.fields?.moveSequence || '') === pathKey);
      if (!card) {
        const historySans = chess.history(); // SAN[] up to this position
        console.log('[scanGame] creating card for pathKey:', pathKey);
        const res = await runMakeCardWithMoves(historySans);
        if (!res.ok) {
          console.warn('[scanGame] make-card failed for pathKey');
          return { created, stopped: true };
        }
        created += 1;
        // Reload and find new card
        arr = loadCardsArray();
        card = arr.find(c => c?.deck === deckId && (c?.fields?.moveSequence || '') === pathKey);
        if (!card) {
          console.warn('[scanGame] created card not found after reload');
          return { created, stopped: true };
        }
      } else {
        console.log('[scanGame] card exists for pathKey');
      }

      // Compare user's played move to the card's expected answer
      const nextSan = sans[i];
      if (!nextSan) {
        console.log('[scanGame] no user move after position; end of PGN');
        break;
      }

      const expected = String(card?.fields?.answer || '').trim();
      if (expected !== nextSan) {
        console.log('[scanGame] deviation: expected', expected, 'got', nextSan);
        return { created, stopped: true, deviated: true, expected, got: nextSan };
      }

      // Apply user's move
      const mv1 = chess.move(nextSan);
      i += 1;
      if (!mv1) { console.warn('[scanGame] failed to apply expected move:', nextSan); return { created, stopped: true }; }

      // Apply opponent reply if exists, then continue (next user review position)
      if (i < sans.length) {
        const oppSan = sans[i];
        const mv2 = chess.move(oppSan);
        if (!mv2) { console.warn('[scanGame] failed to apply opponent reply:', oppSan); return { created, stopped: true }; }
        i += 1;
        console.log('[scanGame] advanced with user move + opp reply');
      }
    }

    console.log('[scanGame] finished game created=', created);
    return { created, stopped: true };
  }

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

  // Run scripts/make-card.js from the renderer request (dev: spawn; prod: in-process)
  ipcMain.handle('cardgen:make-card', async (_evt, payload) => {
    try {
      const script = path.resolve(ROOT, 'scripts', 'make-card.js');

      if (!isDev) {
        // Packaged: programmatic path
        try {
          const mod = await import(pathToFileURL(script).href);
          const { moves, pgn } = payload || {};
          await mod.createCard({
            movesSAN: typeof moves === 'string' ? moves.trim().split(/\s+/).filter(Boolean) : Array.isArray(moves) ? moves : [],
            pgn: typeof pgn === 'string' ? pgn : '',
            resolveEngine: { baseDir: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'), packaged: app.isPackaged },
          });
          return { ok: true, message: 'Card created.' };
        } catch (e) {
          return { ok: false, message: e?.message || 'Programmatic createCard failed' };
        }
      }

      // Dev: spawn Node (keeps your existing behavior)
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

      const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';

      return await new Promise((resolve) => {
        const child = spawn(nodeCmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve({ ok: true, message: stdout.trim() || 'Card created.' });
          else resolve({ ok: false, message: (stderr.trim() || `make-card exited with code ${code}`) });
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

  // Cards file I/O
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

  ipcMain.handle('cards:readAll', async () => {
    try {
      const arr = loadCardsArray();
      return arr;
    } catch (e) {
      console.error('[cards:readAll] failed:', e);
      return [];
    }
  });

  // Forced Answers I/O (now using top-level helpers)
  ipcMain.handle('answers:readAll', async () => {
    return loadAnswerOverrides();
  });
  ipcMain.handle('answers:saveAll', async (_evt, map) => {
    return saveAnswerOverrides(map && typeof map === 'object' ? map : {});
  });

  // ---- Deck limits (per-deck pacing + thresholds) ----
  function loadDeckLimits() {
    try {
      if (!fs.existsSync(DECK_LIMITS_PATH)) return {};
      const raw = fs.readFileSync(DECK_LIMITS_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      console.error('[decks:getLimits] load failed:', e);
      return {};
    }
  }
  function saveDeckLimits(storeObj) {
    try {
      fs.mkdirSync(path.dirname(DECK_LIMITS_PATH), { recursive: true });
      fs.writeFileSync(DECK_LIMITS_PATH, JSON.stringify(storeObj || {}, null, 2) + '\n', 'utf-8');
      return true;
    } catch (e) {
      console.error('[decks:setLimits] save failed:', e);
      return false;
    }
  }
  ipcMain.handle('decks:getLimits', async () => {
    return loadDeckLimits();
  });

  // -------------------- Chess.com Auto-Scan --------------------
  const cancelFlags = new Map(); // webContentsId -> boolean
  ipcMain.on('autogen:cancel', (evt) => {
    const id = evt.sender.id;
    cancelFlags.set(id, true);
    try { console.log(`[scan] cancel requested from wc=${id}`); } catch {}
  });

  ipcMain.handle('autogen:scan-chesscom', async (evt, payload) => {
    const usernameLC = String(payload?.username || '').trim().toLowerCase();
    if (!usernameLC) {
      // Send done even on early validation errors
      try { evt.sender.send('autogen:done', { ok: false, message: 'Chess.com username is empty.' }); } catch {}
      return { ok: false, message: 'Chess.com username is empty.' };
    }

    const wc = evt.sender;
    const wcId = wc.id;
    let finished = false;
    const finish = (payload) => {
      if (finished) return payload;
      finished = true;
      try { wc.send('autogen:done', payload); } catch {}
      return payload;
    };
    try {
      cancelFlags.set(wcId, false);
      const sendProgress = (p) => { try { wc.send('autogen:progress', p); } catch {} };
      const limit = Math.max(1, Number(payload?.limit) || 5);
      console.log(`[scan] start username=${usernameLC} limit=${limit} wc=${wcId}`);

      const ledger = loadScannedLedger();
      const userKey = `chesscom:${usernameLC}`;
      const scannedMap = new Set(Object.keys(ledger[userKey]?.games || {}));

      // Get monthly archives
      const archUrl = `https://api.chess.com/pub/player/${encodeURIComponent(usernameLC)}/games/archives`;
      const arch = await fetchJson(archUrl);
      const months = Array.isArray(arch?.archives) ? arch.archives.slice().reverse() : []; // newest first
      console.log(`[scan] archives=${months.length}`);
      let scannedCount = 0;
      let createdCount = 0;

      // Collect up to N most recent unscanned games
      const queue = [];
      for (const mUrl of months) {
        if (queue.length >= limit || cancelFlags.get(wcId)) break;
        console.log(`[scan] fetch month: ${mUrl}`);
        let monthData;
        try {
          monthData = await fetchJson(mUrl);
        } catch (e) {
          console.warn('[scan] failed month fetch:', mUrl, e?.message || e);
          continue;
        }
        let games = Array.isArray(monthData?.games) ? monthData.games : [];
        games = games.filter(g => {
          const w = String(g?.white?.username || '').toLowerCase();
          const b = String(g?.black?.username || '').toLowerCase();
          return w === usernameLC || b === usernameLC;
        });
        games.sort((a, b) => (b?.end_time || 0) - (a?.end_time || 0));
        console.log(`[scan] month games: all=${(monthData?.games||[]).length} filtered=${games.length}`);
        for (const g of games) {
          if (queue.length >= limit) break;
          const gameKey = String(g?.url || g?.uuid || '').trim();
          if (!gameKey) continue;
          if (scannedMap.has(gameKey)) continue; // already scanned
          queue.push(g);
        }
        console.log(`[scan] queue size so far=${queue.length}`);
      }

      // Overall progress is per game; per-position progress shows fractional advance within each game
      sendProgress({ phase: 'start', total: queue.length });

      let idx = 0;
      for (const g of queue) {
        if (cancelFlags.get(wcId)) break;
        const gameKey = String(g?.url || g?.uuid || '').trim();
        console.log(`[scan] process ${idx + 1}/${queue.length}: ${gameKey}`);

        // game-start tick
        sendProgress({ phase: 'game', index: idx, total: queue.length, url: gameKey });

        const res = await scanOneGameForUser(g, usernameLC, (posIdx, posTotal) => {
          // Fractional index within the game
          const frac = Math.min(1, Math.max(0, posIdx / Math.max(1, posTotal)));
          sendProgress({ phase: 'position', index: idx + frac, total: queue.length, url: gameKey });
        });

        scannedMap.add(gameKey);
        scannedCount += 1;
        if (res?.created) createdCount += res.created;

        // game-done tick
        sendProgress({ phase: 'game:done', index: idx + 1, total: queue.length, url: gameKey });

        idx += 1;
        await sleep(50);
      }

      // Persist ledger
      const nextMap = {};
      for (const k of scannedMap) nextMap[k] = true;
      ledger[userKey] = { games: nextMap, lastScan: new Date().toISOString() };
      saveScannedLedger(ledger);

      const cancelled = !!cancelFlags.get(wcId);
      const msg = `${cancelled ? 'Scan canceled.' : 'Scan complete.'} Games processed: ${scannedCount}. New cards: ${createdCount}.`;
      const result = { ok: true, message: msg, scanned: scannedCount, created: createdCount, cancelled };
      console.log(`[scan] done wc=${wcId} cancelled=${cancelled} scanned=${scannedCount} created=${createdCount}`);
      return finish(result);
    } catch (e) {
      const msg = e?.message || 'Scan failed.';
      console.error('[scan] fatal error:', msg);
      return finish({ ok: false, message: msg });
    } finally {
      // Optional: reset cancel flag for this wc to avoid stale state
      cancelFlags.set(wcId, false);
    }
  });
  ipcMain.handle('decks:setLimits', async (_evt, storeObj) => {
    return saveDeckLimits(storeObj);
  });

  // Export cards to user's Downloads folder
  ipcMain.handle('cards:exportToDownloads', async () => {
    try {
      const arr = loadCardsArray();
      const dir = app.getPath('downloads');
      const ts = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `chess-cards-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`;
      const outPath = path.join(dir, name);
      fs.writeFileSync(outPath, JSON.stringify(arr, null, 2) + '\n', 'utf-8');
      return { ok: true, path: outPath };
    } catch (e) {
      console.error('[cards:exportToDownloads] failed:', e);
      return { ok: false, message: e?.message || 'Export failed' };
    }
  });

  // Export provided JSON array to Downloads
  ipcMain.handle('cards:exportJsonToDownloads', async (_evt, payload) => {
    try {
      const cards = Array.isArray(payload?.cards) ? payload.cards : [];
      const base = (payload?.name && String(payload.name).trim()) || 'chess-cards';
      const dir = app.getPath('downloads');
      const ts = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `${base}-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`;
      const outPath = path.join(dir, name);
      fs.writeFileSync(outPath, JSON.stringify(cards, null, 2) + '\n', 'utf-8');
      return { ok: true, path: outPath };
    } catch (e) {
      console.error('[cards:exportJsonToDownloads] failed:', e);
      return { ok: false, message: e?.message || 'Export failed' };
    }
  });

  // Update only the 'due' field of a card by id
  ipcMain.handle('cards:setDue', async (_evt, payload) => {
    try {
      const { id, due } = payload || {};
      if (!id || typeof id !== 'string') return false;
      const arr = loadCardsArray();
      const idx = arr.findIndex(x => x && x.id === id);
      if (idx === -1) return false;
      if (typeof due === 'undefined') {
        delete arr[idx].due;
      } else {
        arr[idx].due = due;
      }
      saveCardsArray(arr);
      return true;
    } catch (e) {
      console.error('[cards:setDue] failed:', e);
      return false;
    }
  });

  console.log('[main] IPC handlers registered: cardgen:save-config, cardgen:make-card, autogen:scan-chesscom, cards:readOne, cards:update, cards:create, cards:setDue, cards:exportToDownloads, cards:exportJsonToDownloads, decks:getLimits, decks:setLimits');
}

app.whenReady().then(() => {
  registerIpc();
  // App menu (basic)
  try {
    const isMac = process.platform === 'darwin';
    const template = [
      ...(isMac ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ]
      }] : []),
      {
        label: 'File',
        submenu: [
          ...(isMac ? [] : [{ role: 'quit' }]),
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { role: 'forceReload' },
          { role: 'toggleDevTools' }, { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      {
        role: 'window',
        submenu: [ { role: 'minimize' }, { role: 'close' } ]
      },
      {
        role: 'help',
        submenu: [
          { label: 'Learn More', click: async () => { try { await shell.openExternal('https://www.chess.com/learn'); } catch {} } }
        ]
      }
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  } catch (e) {
    console.warn('[main] menu build failed:', e?.message || e);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
