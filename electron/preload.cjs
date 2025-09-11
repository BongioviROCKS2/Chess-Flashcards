// electron/preload.cjs  (CommonJS; safe in Electron)
const { contextBridge, ipcRenderer, webFrame } = require('electron');

try {
  contextBridge.exposeInMainWorld('api', {});

  // Save Cardgen config + run make-card
  contextBridge.exposeInMainWorld('cardgen', {
    saveConfig: (cfg) => ipcRenderer.invoke('cardgen:save-config', cfg),
    makeCard:  (args) => ipcRenderer.invoke('cardgen:make-card', args),
    cancel:    () => ipcRenderer.send('cardgen:cancel'),
  });

  // Auto-generation from historical games (Chess.com)
  contextBridge.exposeInMainWorld('autogen', {
    scanChessCom: (opts) => ipcRenderer.invoke('autogen:scan-chesscom', opts || {}),
    cancel: () => ipcRenderer.send('autogen:cancel'),
    onProgress: (cb) => {
      const fn = (_evt, payload) => { try { cb(payload); } catch { /* no-op */ } };
      ipcRenderer.on('autogen:progress', fn);
      return () => ipcRenderer.removeListener('autogen:progress', fn);
    },
    onDone: (cb) => {
      const fn = (_evt, payload) => { try { cb(payload); } catch { /* no-op */ } };
      ipcRenderer.on('autogen:done', fn);
      return () => ipcRenderer.removeListener('autogen:done', fn);
    },
  });

  // Cards file I/O
  contextBridge.exposeInMainWorld('cards', {
    readAll: () => ipcRenderer.invoke('cards:readAll'),
    readOne: (id)   => ipcRenderer.invoke('cards:readOne', id),
    update:  (card) => ipcRenderer.invoke('cards:update', card),
    create:  (card) => ipcRenderer.invoke('cards:create', card),
    setDue:  (id, due) => ipcRenderer.invoke('cards:setDue', { id, due }),
    exportToDownloads: () => ipcRenderer.invoke('cards:exportToDownloads'),
    exportJsonToDownloads: (cards, name) => ipcRenderer.invoke('cards:exportJsonToDownloads', { cards, name }),
  });

  // Forced Answers (override map of FEN -> SAN)
  contextBridge.exposeInMainWorld('answers', {
    readAll: () => ipcRenderer.invoke('answers:readAll'),
    saveAll: (map) => ipcRenderer.invoke('answers:saveAll', map),
  });

  // Deck limits I/O (per-deck pacing settings)
  contextBridge.exposeInMainWorld('decks', {
    getLimits: () => ipcRenderer.invoke('decks:getLimits'),
    setLimits: (storeObj) => ipcRenderer.invoke('decks:setLimits', storeObj),
  });

  // Zoom controls
  contextBridge.exposeInMainWorld('zoom', {
    getFactor: () => { try { return webFrame.getZoomFactor(); } catch { return 1; } },
    setFactor: (f) => {
      try {
        const MIN = 0.5, MAX = 3.0;
        const clamped = Math.max(MIN, Math.min(MAX, Number(f) || 1));
        webFrame.setZoomFactor(clamped);
        return clamped;
      } catch { return 1; }
    },
    in: (step = 0.1) => {
      try {
        const f = webFrame.getZoomFactor() + step;
        const clamped = Math.max(0.5, Math.min(3.0, f));
        webFrame.setZoomFactor(clamped);
        return clamped;
      } catch { return 1; }
    },
    out: (step = 0.1) => {
      try {
        const f = webFrame.getZoomFactor() - step;
        const clamped = Math.max(0.5, Math.min(3.0, f));
        webFrame.setZoomFactor(clamped);
        return clamped;
      } catch { return 1; }
    },
    reset: () => { try { webFrame.setZoomFactor(1); return 1; } catch { return 1; } },
  });
} catch (err) {
  console.error('[preload] Failed to expose bridges:', err);
}
