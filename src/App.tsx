import { HashRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import DecksPage from './pages/DecksPage';
import ReviewPage from './pages/ReviewPage';
import SettingsPage from './pages/SettingsPage';
import KeybindsPage from './pages/KeybindsPage';
import { SettingsProvider } from './state/settings';
import { KeybindsProvider } from './context/KeybindsProvider';
import './styles.css';
import logo from '../assets/logo.png';
import ErrorBoundary from './components/ErrorBoundary';

import StatsPage from './pages/StatsPage';
import CollectionPage from './pages/CollectionPage';
import ManualAddPage from './pages/ManualAddPage';
import EditCardPage from './pages/EditCardPage'; // <-- NEW
import ManageDeckPage from './pages/ManageDeckPage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettings } from './state/settings';
import { replaceCards } from './data/cardStore';
import ForcedAnswersPage from './pages/ForcedAnswersPage';

declare global {
  interface Window {
    zoom?: {
      getFactor: () => number;
      setFactor: (f: number) => number;
      in: (step?: number) => number;
      out: (step?: number) => number;
      reset: () => number;
    };
  }
}

function Header() {
  const location = useLocation();
  const { settings } = useSettings();
  const [showAuto, setShowAuto] = useState(false);
  const [progress, setProgress] = useState<{ phase?: string; index?: number; total?: number; url?: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cleanupRef = useRef<{ offProg?: () => void; offDone?: () => void }>({});

  const handleAutoAdd = () => {
    if (!settings.chessComUser) {
      setStatus('Set Chess.com username in Settings first.');
      setShowAuto(true);
      return;
    }
    setStatus(null);
    setProgress(null);
    setShowAuto(true);
    setBusy(true);
    try {
      // Subscribe to progress/done events
      cleanupRef.current.offProg = window.autogen?.onProgress?.((p: { phase?: string; index?: number; total?: number; url?: string }) => {
        try { console.log('[AutoAdd] progress', p); } catch {}
        setProgress(p || null);
      }) || undefined;
      cleanupRef.current.offDone = window.autogen?.onDone?.(async (res: { ok?: boolean; message?: string; scanned?: number; created?: number; cancelled?: boolean }) => {
        try { console.log('[AutoAdd] done', res); } catch {}
        setBusy(false);
        setStatus(res?.message || (res?.ok ? 'Done.' : 'Finished'));
        // Reload cards.json from disk into in-memory store
        try {
          const arr = await (window as any).cards?.readAll?.();
          if (arr) replaceCards(arr as any);
        } catch {}
      }) || undefined;

      // Limit to recent 5 games for testing
      try { console.log('[AutoAdd] start', { user: settings.chessComUser, limit: 5 }); } catch {}
      void window.autogen?.scanChessCom?.({ username: settings.chessComUser, limit: 5 });
    } catch (e) {
      setBusy(false);
      setStatus((e as any)?.message || 'Failed to start scan.');
    }
  };

  const linkStyle = { textDecoration: 'none' as const };

  return (
    <>
    <header className="header">
      <img
        src={logo}
        alt="Chess Flashcards logo"
        style={{ width: 45, height: 45, borderRadius: 4 }}
      />
      <div className="brand">Chess Flashcards</div>
      <div style={{ flex: 1 }} />
      <nav className="header-actions">
        <Link to="/" className="button secondary" style={linkStyle}>Home</Link>
        <Link to="/stats" className="button secondary" style={linkStyle}>Stats</Link>
        <Link to="/collection" className="button secondary" style={linkStyle}>Collection</Link>
        <Link
          to={location.pathname || '/'}
          onClick={(e) => { e.preventDefault(); handleAutoAdd(); }}
          className="button secondary" style={linkStyle}
        >
          Auto Add
        </Link>
        <Link to="/manual-add" className="button secondary" style={linkStyle}>Manual Add</Link>
        <Link to="/settings" state={{ from: location }} className="button secondary" style={linkStyle}>Settings</Link>
      </nav>
    </header>
    {showAuto && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
        <div className="card" style={{ width: 520, maxWidth: '90%', padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Auto Add from Chess.com</h3>
            <button
              className="button secondary"
              onClick={async () => {
                // Cancel ongoing scan if busy
                if (busy) {
                  try { console.log('[AutoAdd] cancel clicked'); window.autogen?.cancel?.(); } catch {}
                }
                // Always attempt a final reload of cards
                try {
                  const arr = await (window as any).cards?.readAll?.();
                  if (arr) replaceCards(arr as any);
                } catch {}
                setBusy(false);
                setShowAuto(false);
                // Cleanup listeners
                try { cleanupRef.current.offProg?.(); } catch {}
                try { cleanupRef.current.offDone?.(); } catch {}
              }}
            >
              {busy ? 'Cancel' : 'Close'}
            </button>
          </div>

          <div style={{ marginTop: 14, marginBottom: 10, fontSize: 14 }}>
            {status || (busy ? 'Scanning…' : 'Ready')}
          </div>

          {/* Progress bar */}
          <div style={{ height: 10, background: 'var(--border)', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
            {(() => {
              const total = Math.max(1, progress?.total || 0);
              const index = Math.min(total, (progress?.index || 0));
              // Show progress of current item as well
              const pct = total > 0 ? Math.round(((busy ? index : total) / total) * 100) : 0;
              return (
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent, #36f)' }} />
              );
            })()}
          </div>

          {progress?.url && (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
              {progress?.url}
            </div>
          )}

          {!settings.chessComUser && (
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--danger, #d33)' }}>
              Tip: set your Chess.com username in Settings first.
            </div>
          )}
        </div>
      </div>
    )}
    </>
  );
}

function useZoomShortcuts() {
  useEffect(() => {
    if (!window.zoom) return;

    const STEP = 0.05, MIN = 0.25, MAX = 5.0;
    const clamp = (f: number) => Math.max(MIN, Math.min(MAX, f));
    const set = (f: number) => window.zoom!.setFactor(clamp(f));
    const get = () => window.zoom!.getFactor();

    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const isZoomIn = e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd';
      const isZoomOut = e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract';
      const isReset = e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0';
      if (isZoomIn) { e.preventDefault(); set(get() + STEP); }
      else if (isZoomOut) { e.preventDefault(); set(get() - STEP); }
      else if (isReset) { e.preventDefault(); window.zoom!.reset(); }
    };

    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      set(get() + dir * STEP);
    };
    const onMouseWheel = (e: any) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const dir = e.wheelDelta > 0 ? 1 : -1;
      set(get() + dir * STEP);
    };

    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousewheel', onMouseWheel as any, { passive: false });
    document.addEventListener('mousewheel', onMouseWheel as any, { passive: false });

    return () => {
      window.removeEventListener('keydown', onKey, { capture: true } as any);
      window.removeEventListener('wheel', onWheel as any);
      document.removeEventListener('wheel', onWheel as any);
      window.removeEventListener('mousewheel', onMouseWheel as any);
      document.removeEventListener('mousewheel', onMouseWheel as any);
    };
  }, []);
}

export default function App() {
  useZoomShortcuts();

  // Global text sanitization to fix mojibake from smart quotes/ellipses
  useEffect(() => {
    const map: Record<string, string> = {
      'â€™': "'",
      'â€˜': "'",
      'â€œ': '"',
      'â€': '"',
      'â€': '"',
      'â€“': '-',
      'â€”': '--',
      'â€¦': '...',
    } as any;
    const many = Object.keys(map);
    const fixNode = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        let t = (node.textContent || '');
        for (const k of many) { if (t.includes(k)) t = t.split(k).join(map[k]); }
        if (t !== node.textContent) node.textContent = t;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) fixNode(child);
      }
    };
    try { fixNode(document.body); } catch {}
  }, []);

  // Keep a CSS var of the app header height for sticky page titles
  useEffect(() => {
    const updateVar = () => {
      const header = document.querySelector('.header') as HTMLElement | null;
      const h = header ? header.getBoundingClientRect().height : 0;
      document.documentElement.style.setProperty('--app-header-offset', `${Math.round(h)}px`);
    };
    updateVar();
    window.addEventListener('resize', updateVar);
    return () => window.removeEventListener('resize', updateVar);
  }, []);

  return (
    <SettingsProvider>
      <KeybindsProvider>
        <HashRouter>
          <div className="app">
            <Header />
            <ErrorBoundary>
              <Routes>
                <Route path="/" element={<DecksPage />} />
                <Route path="/review/:deckId" element={<ReviewPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/keybinds" element={<KeybindsPage />} />
                <Route path="/settings/forced-answers" element={<ForcedAnswersPage />} />
                <Route path="/stats" element={<StatsPage />} />
                <Route path="/collection" element={<CollectionPage />} />
                <Route path="/manual-add" element={<ManualAddPage />} />
                <Route path="/edit/:cardId" element={<EditCardPage />} /> {/* NEW */}
                <Route path="/manage/:deckId" element={<ManageDeckPage />} />
              </Routes>
            </ErrorBoundary>
          </div>
        </HashRouter>
      </KeybindsProvider>
    </SettingsProvider>
  );
}
