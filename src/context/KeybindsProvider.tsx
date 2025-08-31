import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type KeyAction =
  // App / Navigation
  | 'app.back'
  // Board navigation
  | 'board.first'
  | 'board.prev'
  | 'board.next'
  | 'board.last'
  // Review actions
  | 'review.showAnswer'
  | 'review.again'
  | 'review.hard'
  | 'review.good'
  | 'review.easy'
  | 'review.undo';

/** Each action can have up to two bindings. Empty strings mean “unassigned”. */
export type KeybindMap = Record<KeyAction, [string, string]>;

type KeybindsContextValue = {
  binds: KeybindMap;
  /** Returns the FIRST action bound to the event (legacy callers). */
  getActionForEvent: (e: KeyboardEvent) => KeyAction | null;
  /** Returns ALL actions bound to the event (context-aware callers). */
  getActionsForEvent: (e: KeyboardEvent) => KeyAction[];
  /** Set a binding (slot 0 or 1) to a canonical key string like "ArrowLeft" or "Ctrl+Shift+K". */
  setBinding: (action: KeyAction, slot: 0 | 1, keyString: string) => void;
  /** Reset all bindings to the defaults. */
  resetDefaults: () => void;
};

const KeybindsContext = createContext<KeybindsContextValue | null>(null);

// Defaults (Board: Arrows + WASD; Review: actions + Undo; App: Back)
const DEFAULT_BINDS: KeybindMap = {
  // App / Navigation
  'app.back': ['Backspace', ''],

  // Board
  'board.first': ['ArrowDown', 'S'],
  'board.prev':  ['ArrowLeft', 'A'],
  'board.next':  ['ArrowRight', 'D'],
  'board.last':  ['ArrowUp', 'W'],

  // Review
  'review.showAnswer': ['Space', 'Enter'],
  'review.again':      ['1', ''],
  'review.hard':       ['2', ''],
  'review.good':       ['3', 'Space'],
  'review.easy':       ['4', ''],
  'review.undo':       ['Ctrl+Z', ''],
};

// Storage key (migration fills defaults for any NEW actions)
const LS_KEY = 'chessflashcards.keybinds.v4';

function normalizeKeyName(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function eventToKeyString(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey)  mods.push('Ctrl');
  if (e.altKey)   mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey)  mods.push('Meta');

  const key = normalizeKeyName(e.key);
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return '';
  return mods.length ? `${mods.join('+')}+${key}` : key;
}

/** Load + migrate: new actions get defaults; keep user choices for existing actions. */
function loadFromStorage(): KeybindMap | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) || {};
    const out: Partial<KeybindMap> = {};

    (Object.keys(DEFAULT_BINDS) as (keyof typeof DEFAULT_BINDS)[]).forEach((action) => {
      if (Object.prototype.hasOwnProperty.call(parsed, action)) {
        // Existing action in saved data — preserve (including intentional empty slots)
        const val = Array.isArray(parsed[action]) ? parsed[action] : [];
        const k0 = typeof val[0] === 'string' ? val[0] : '';
        const k1 = typeof val[1] === 'string' ? val[1] : '';
        out[action] = [k0, k1];
      } else {
        // Brand-new action — seed with defaults
        out[action] = [...DEFAULT_BINDS[action]];
      }
    });

    // Safety: if Undo exists but both slots are empty (legacy glitch), seed default
    const undo = out['review.undo'];
    if (undo && undo[0] === '' && undo[1] === '') {
      out['review.undo'] = [...DEFAULT_BINDS['review.undo']];
    }

    // Safety: if Back exists but both slots are empty, seed default
    const back = out['app.back'];
    if (back && back[0] === '' && back[1] === '') {
      out['app.back'] = [...DEFAULT_BINDS['app.back']];
    }

    return out as KeybindMap;
  } catch {
    return null;
  }
}

function saveToStorage(binds: KeybindMap) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(binds));
  } catch {
    // ignore
  }
}

export const KeybindsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [binds, setBinds] = useState<KeybindMap>(() => loadFromStorage() ?? DEFAULT_BINDS);

  useEffect(() => {
    saveToStorage(binds);
  }, [binds]);

  const getActionsForEvent = useCallback((e: KeyboardEvent): KeyAction[] => {
    const keyString = eventToKeyString(e);
    if (!keyString) return [];
    const hits: KeyAction[] = [];
    for (const action of Object.keys(binds) as (keyof typeof binds)[]) {
      const [k0, k1] = binds[action];
      if (keyString === k0 || keyString === k1) hits.push(action as KeyAction);
    }
    return hits;
  }, [binds]);

  const getActionForEvent = useCallback((e: KeyboardEvent): KeyAction | null => {
    const actions = getActionsForEvent(e);
    return actions.length ? actions[0] : null;
  }, [getActionsForEvent]);

  const setBinding = useCallback((action: KeyAction, slot: 0 | 1, keyString: string) => {
    setBinds(prev => {
      const next: KeybindMap = { ...prev };
      const updated: [string, string] = [...next[action]] as [string, string];
      updated[slot] = keyString;
      next[action] = updated;
      return next;
    });
  }, []);

  const resetDefaults = useCallback(() => {
    setBinds(DEFAULT_BINDS);
  }, []);

  const value = useMemo(
    () => ({ binds, getActionForEvent, getActionsForEvent, setBinding, resetDefaults }),
    [binds, getActionForEvent, getActionsForEvent, setBinding, resetDefaults]
  );

  return (
    <KeybindsContext.Provider value={value}>
      {children}
    </KeybindsContext.Provider>
  );
};

export function useKeybinds() {
  const ctx = useContext(KeybindsContext);
  if (!ctx) throw new Error('useKeybinds must be used within KeybindsProvider');
  return ctx;
}

export function makeKeyStringFromEvent(e: KeyboardEvent): string {
  return eventToKeyString(e);
}
