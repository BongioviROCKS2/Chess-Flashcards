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
import { useEffect } from 'react';

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

  const handleAutoAdd = () => {
    console.log('[Auto Add] trigger clicked');
  };

  const linkStyle = { textDecoration: 'none' as const };

  return (
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
  );
}

function useZoomShortcuts() {
  useEffect(() => {
    if (!window.zoom) return;

    const STEP = 0.1, MIN = 0.5, MAX = 3.0;
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
