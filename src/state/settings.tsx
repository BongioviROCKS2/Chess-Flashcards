import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

type Theme = 'dark' | 'light';

export type Settings = {
  theme: Theme;
  frontStartAtReview: boolean;

  // Card creation settings
  otherAnswersAcceptance: number; // pawns
  maxOtherAnswerCount: number;
  stockfishDepth: number;
  stockfishThreads: number;
  stockfishHash: number;
  // Accounts
  chessComUser?: string;
  lichessUser?: string;
};

const DEFAULTS: Settings = {
  theme: 'dark',
  frontStartAtReview: false,

  otherAnswersAcceptance: 0.20,
  maxOtherAnswerCount: 4,
  stockfishDepth: 25,
  stockfishThreads: 1,
  stockfishHash: 1024,
  chessComUser: '',
  lichessUser: '',
};

const KEY = 'chessflashcards.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function save(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

const Ctx = createContext<{
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}>({
  settings: DEFAULTS,
  update: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => load());

  // Apply theme immediately on mount and whenever it changes
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  const update = (patch: Partial<Settings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  };

  const value = useMemo(() => ({ settings, update }), [settings]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings() {
  return useContext(Ctx);
}
