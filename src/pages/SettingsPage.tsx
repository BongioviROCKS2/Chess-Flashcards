import { useNavigate, useLocation } from 'react-router-dom';
import { useSettings } from '../state/settings';
import { getSchedulerConfig, setSchedulerConfig, getPresets, SchedulerConfig } from '../state/schedulerConfig';
import { useKeybinds, formatActionKeys } from '../context/KeybindsProvider';
import { getSchedulingPrefs, setSchedulingPrefs, CardSchedulingPrefs } from '../state/schedulingPrefs';
import React, { useEffect, useMemo, useRef, useState } from 'react';

type CardgenConfig = {
  otherAnswersAcceptance: number;
  maxOtherAnswerCount: number;
  depth: number;
  threads: number;
  hash: number; // MB
};

declare global {
  interface Window {
    cardgen?: {
      saveConfig: (cfg: CardgenConfig) => Promise<boolean>;
    };
  }
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, update } = useSettings();
  const { binds } = useKeybinds();
  const backKeys = formatActionKeys(binds, 'app.back');

  // ---- Save-on-exit for Card Creation config ----
  const currentCfg: CardgenConfig = useMemo(
    () => ({
      otherAnswersAcceptance: Number(settings.otherAnswersAcceptance ?? 0),
      maxOtherAnswerCount: Number(settings.maxOtherAnswerCount ?? 0),
      depth: Number(settings.stockfishDepth ?? 25),
      threads: Number(settings.stockfishThreads ?? 1),
      hash: Number(settings.stockfishHash ?? 1024),
    }),
    [
      settings.otherAnswersAcceptance,
      settings.maxOtherAnswerCount,
      settings.stockfishDepth,
      settings.stockfishThreads,
      settings.stockfishHash,
    ]
  );

  const initialCfgRef = useRef<CardgenConfig>(currentCfg);

  const cfgDirty = useMemo(() => {
    const a = initialCfgRef.current;
    const b = currentCfg;
    return (
      a.otherAnswersAcceptance !== b.otherAnswersAcceptance ||
      a.maxOtherAnswerCount !== b.maxOtherAnswerCount ||
      a.depth !== b.depth ||
      a.threads !== b.threads ||
      a.hash !== b.hash
    );
  }, [currentCfg]);

  async function saveCardgenConfig(cfg: CardgenConfig) {
    if (window.cardgen?.saveConfig) {
      const ok = await window.cardgen.saveConfig(cfg).catch(() => false);
      return !!ok;
    }
    return false;
  }

  async function maybeSaveCardgenConfig() {
    if (cfgDirty) {
      await saveCardgenConfig(currentCfg);
      initialCfgRef.current = currentCfg;
    }
  }

  const handleBack = async () => {
    await maybeSaveCardgenConfig();
    const hasFrom = !!(location.state as any)?.from;
    if (hasFrom || window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/');
    }
  };

  useEffect(() => {
    return () => {
      if (cfgDirty) saveCardgenConfig(currentCfg);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgDirty, currentCfg]);

  const lightThemeChecked = settings.theme === 'light';

  // ---- Card Scheduling (display ordering) ----
  const [schedPrefs, setSchedPrefs] = useState<CardSchedulingPrefs>(() => getSchedulingPrefs());
  const saveSchedPrefs = (patch: Partial<CardSchedulingPrefs>) => {
    const next = setSchedulingPrefs(patch);
    setSchedPrefs(next);
  };

  // ---- Scheduler settings ----
  const [sched, setSched] = useState<SchedulerConfig>(() => getSchedulerConfig());
  const saveSched = (patch: Partial<SchedulerConfig>) => {
    const next = setSchedulerConfig(patch as any);
    setSched(next);
  };
  const applyPreset = (name: string) => {
    const p = getPresets().find(x => x.name === (name as any));
    if (p) setSched(setSchedulerConfig({ ...p.config }));
  };
  const preview = (() => {
    const daysFmt = (m: number) => (m/(60*24)).toFixed(1)+'d';
    const seedMin = 60*24; // 1d baseline
    const g = {
      again: Math.max(sched.minIntervalMin, Math.round(seedMin * sched.againMultiplier * sched.intervalMultiplier)),
      hard:  Math.max(sched.minIntervalMin, Math.round(seedMin * sched.hardMultiplier  * sched.intervalMultiplier)),
      good:  Math.max(sched.minIntervalMin, Math.round(seedMin * sched.goodMultiplier  * sched.intervalMultiplier)),
      easy:  Math.max(sched.minIntervalMin, Math.round(seedMin * sched.easyMultiplier  * sched.intervalMultiplier)),
    };
    return { daysFmt, g };
  })();

  // ---- Helpers ----
  const clampInt = (v: number, min: number, max?: number) => {
    if (!Number.isFinite(v)) return min;
    v = Math.floor(v);
    if (v < min) v = min;
    if (typeof max === 'number' && v > max) v = max;
    return v;
  };

  const hwThreads = Math.max(1, (navigator as any).hardwareConcurrency || 1);
  const deviceMemGB = (navigator as any).deviceMemory || undefined;

  // ---- Other Answers Acceptance (0.01 step, 2 decimals, custom stepper) ----
  const setAcceptance = (next: number) => {
    if (!Number.isFinite(next) || next < 0) next = 0;
    const rounded = Math.round(next * 100) / 100;
    update({ otherAnswersAcceptance: rounded });
  };
  const acceptance = Number(settings.otherAnswersAcceptance ?? 0);
  const acceptanceStr = acceptance.toFixed(2);
  const STEP_ACC = 0.01;
  const incAcc = () => setAcceptance(acceptance + STEP_ACC);
  const decAcc = () => setAcceptance(acceptance - STEP_ACC);
  const onAccKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incAcc(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decAcc(); }
  };

  // ---- Max Other Answer Count (int, step 1, custom stepper) ----
  const moac = settings.maxOtherAnswerCount;
  const setMoac = (next: number) => {
    update({ maxOtherAnswerCount: clampInt(next, 0, 50) });
  };
  const incMoac = () => setMoac(moac + 1);
  const decMoac = () => setMoac(moac - 1);
  const onMoacKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incMoac(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decMoac(); }
  };

  // ---- Depth (int, step 1, custom stepper) ----
  const depth = settings.stockfishDepth;
  const setDepth = (next: number) => {
    update({ stockfishDepth: clampInt(next, 1, 99) });
  };
  const incDepth = () => setDepth(depth + 1);
  const decDepth = () => setDepth(depth - 1);
  const onDepthKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incDepth(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decDepth(); }
  };

  // ---- Threads (int, step 1, custom stepper) ----
  const threads = settings.stockfishThreads;
  const setThreads = (next: number) => {
    update({ stockfishThreads: clampInt(next, 1, hwThreads) });
  };
  const incThreads = () => setThreads(threads + 1);
  const decThreads = () => setThreads(threads - 1);
  const onThreadsKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incThreads(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decThreads(); }
  };

  // ---- Hash (MB) (int, step 64, min 32, custom stepper) ----
  const hash = settings.stockfishHash;
  const setHash = (next: number) => {
    update({ stockfishHash: clampInt(next, 32, 262144) });
  };
  const incHash = () => setHash(hash + 64);
  const decHash = () => setHash(hash - 64);
  const onHashKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); incHash(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decHash(); }
  };

  return (
    <div className="container">
      <div className="card grid">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Settings</h2>
          <button className="button secondary" onClick={handleBack} title={`Back${backKeys ? ` (${backKeys})` : ''}`}>Back</button>
        </div>

        <div className="grid" style={{ gap: 14 }}>
          {/* Accounts */}
          <div className="section">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Accounts</div>
            <div className="sub" style={{ marginBottom: 8 }}>Link accounts to enable Auto Add and future integrations.</div>

            {/* Chess.com username */}
            <div className="row" title="Used by Auto Add to scan your games" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
              <div>Chess.com Username</div>
              <div className="sub">Optional; used by Auto Add</div>
              <input
                type="text"
                value={settings.chessComUser || ''}
                onChange={e => update({ chessComUser: e.currentTarget.value })}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', justifySelf: 'end', minWidth: 180 }}
                placeholder="username"
              />
            </div>

            {/* Lichess username */}
            <div className="row" title="Reserved for future auto-add support" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
              <div>Lichess Username</div>
              <div className="sub">Optional</div>
              <input
                type="text"
                value={settings.lichessUser || ''}
                onChange={e => update({ lichessUser: e.currentTarget.value })}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', justifySelf: 'end', minWidth: 180 }}
                placeholder="username"
              />
            </div>

            {/* (moved) Keybinds now lives in Preferences section */}
          </div>

          {/* Preferences */}
          <div className="section">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Preferences</div>
            <div className="sub" style={{ marginBottom: 8 }}>Personalize the appâ€™s appearance and review behavior.</div>

            {/* Light Theme toggle */}
            <div className="row" title="Toggle between light and dark themes" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
              <div>Light Theme</div>
              <div className="sub">UI appearance</div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifySelf: 'end' }}>
                <input
                  type="checkbox"
                  checked={lightThemeChecked}
                  onChange={e => update({ theme: e.currentTarget.checked ? 'light' : 'dark' })}
                />
              </label>
            </div>

            {/* Start review position */}
            <div className="row" title="Choose where the front board starts during review" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
              <div>Start Review Withâ€¦</div>
              <div className="sub">Initial or review position</div>
              <select
                value={settings.frontStartAtReview ? 'review' : 'initial'}
                onChange={e => update({ frontStartAtReview: e.currentTarget.value === 'review' })}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 10px', justifySelf: 'end' }}
              >
                <option value="initial" style={{ background: '#ffffff', color: '#000000' }}>Initial Position</option>
                <option value="review" style={{ background: '#ffffff', color: '#000000' }}>Review Position</option>
              </select>
            </div>

            {/* Keybinds */}
            <div className="row" title="Customize keyboard shortcuts for navigation and review" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
              <div>Keybinds</div>
              <div className="sub">Configure app shortcuts</div>
              <button
                className="button"
                onClick={async () => { await maybeSaveCardgenConfig(); navigate('/settings/keybinds', { state: { from: location } }); }}
                style={{ justifySelf: 'end' }}
              >
                Manage
              </button>
            </div>
          </div>

        {/* Card Creation */}
        <div className="section">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Card Creation</div>
          <div className="sub" style={{ marginBottom: 8 }}>Defaults used when analyzing games and creating cards.</div>

          {/* Other Answers Acceptance */}
          <div className="row" title="Accept alternative moves within this pawn value of the best move" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Other Answers Acceptance</div>
            <div className="sub">Centipawn threshold</div>
            <div className="num-wrap" style={{ justifySelf: 'end' }}>
              <input
                className="num-accept no-native-spin"
                type="text"
                inputMode="decimal"
                value={acceptanceStr}
                onChange={e => { const num = parseFloat(e.currentTarget.value); setAcceptance(num); }}
                onKeyDown={onAccKeyDown}
                onBlur={(e) => { const num = parseFloat(e.currentTarget.value); setAcceptance(num); }}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 60, minWidth: 'unset', maxWidth: 60, display: 'inline-block', textAlign: 'right', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}
                title="e.g., 0.20 = 20 centipawns"
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incAcc} title="Increase by 0.01" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decAcc} title="Decrease by 0.01" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Max Other Answer Count */}
          <div className="row" title="Number of alternative moves to keep when creating cards" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Max Other Answer Count</div>
            <div className="sub">MultiPV alternatives</div>
            <div className="num-wrap" style={{ justifySelf: 'end' }}>
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(moac)}
                onChange={e => setMoac(parseInt(e.currentTarget.value, 10))}
                onKeyDown={onMoacKeyDown}
                onBlur={e => setMoac(parseInt(e.currentTarget.value, 10))}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 70, minWidth: 'unset', maxWidth: 80, display: 'inline-block', textAlign: 'right', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace' }}
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incMoac} title="Increase by 1" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decMoac} title="Decrease by 1" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Engine Depth */}
          <div className="row" title="Engine search depth (higher = stronger & slower)" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Engine Depth</div>
            <div className="sub">Stockfish depth</div>
            <div className="num-wrap" style={{ justifySelf: 'end' }}>
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(depth)}
                onChange={e => setDepth(parseInt(e.currentTarget.value, 10))}
                onKeyDown={onDepthKeyDown}
                onBlur={e => setDepth(parseInt(e.currentTarget.value, 10))}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 70, minWidth: 'unset', maxWidth: 80, display: 'inline-block', textAlign: 'right', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incDepth} title="Increase by 1" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decDepth} title="Decrease by 1" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Threads */}
          <div className="row" title={`Engine threads (max suggested: ${hwThreads})`} style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Threads</div>
            <div className="sub">Engine parallelism</div>
            <div className="num-wrap" style={{ justifySelf: 'end' }}>
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(threads)}
                onChange={e => setThreads(parseInt(e.currentTarget.value, 10))}
                onKeyDown={onThreadsKeyDown}
                onBlur={e => setThreads(parseInt(e.currentTarget.value, 10))}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 70, minWidth: 'unset', maxWidth: 80, display: 'inline-block', textAlign: 'right', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace' }}
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incThreads} title="Increase by 1" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decThreads} title="Decrease by 1" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Hash (MB) */}
          <div className="row" title="Transposition table size in MB" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Hash (MB)</div>
            <div className="sub">Memory used by engine</div>
            <div className="num-wrap" style={{ justifySelf: 'end' }}>
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(hash)}
                onChange={e => setHash(parseInt(e.currentTarget.value, 10))}
                onKeyDown={onHashKeyDown}
                onBlur={e => setHash(parseInt(e.currentTarget.value, 10))}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 90, minWidth: 'unset', maxWidth: 120, display: 'inline-block', textAlign: 'right', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}
                title={`${deviceMemGB ? `Device memory ~${deviceMemGB}GB` : 'Adjust to your RAM.'}`}
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incHash} title="Increase by 64" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decHash} title="Decrease by 64" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Forced Answers (moved here) */}
          <div className="row" title="Override engine-best answers per position (per-FEN forced moves)" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Forced Answers</div>
            <div className="sub">Manage per-position overrides</div>
            <button className="button" onClick={async () => { await maybeSaveCardgenConfig(); navigate('/settings/forced-answers', { state: { from: location } }); }} style={{ justifySelf: 'end' }}>Manage</button>
          </div>
        </div>

        {/* Card Ordering */}
        <div className="section">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Card Ordering</div>
          <div className="sub" style={{ marginBottom: 8 }}>Control how cards are ordered for review.</div>

          {/* New vs Review order */}
          <div className="row" title="Decide whether to see new cards or review cards first" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Order: New vs Reviews</div>
            <div className="sub">Default: New cards first</div>
            <select
              value={schedPrefs.newVsReviewOrder}
              onChange={e => saveSchedPrefs({ newVsReviewOrder: e.currentTarget.value as CardSchedulingPrefs['newVsReviewOrder'] })}
              style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 10px', justifySelf: 'end' }}
            >
              <option value="new-first" style={{ background: '#ffffff', color: '#000000' }}>New first</option>
              <option value="review-first" style={{ background: '#ffffff', color: '#000000' }}>Reviews first</option>
              <option value="interleave" style={{ background: '#ffffff', color: '#000000' }}>Interleave</option>
            </select>
          </div>

          {/* Interleave ratio (conditional) */}
          {schedPrefs.newVsReviewOrder === 'interleave' && (
            <div className="row" title="Show 1 new card every N reviews" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
              <div>Interleave Ratio</div>
              <div className="sub">1 new per N reviews</div>
              <input
                type="text"
                inputMode="numeric"
                value={String(schedPrefs.interleaveRatio)}
                onChange={e => {
                  const v = Math.max(1, parseInt(e.currentTarget.value || '1', 10));
                  saveSchedPrefs({ interleaveRatio: v });
                }}
                style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', justifySelf: 'end', width: 120, textAlign: 'right' }}
              />
            </div>
          )}

          {/* New card selection */}
          <div className="row" title="Choose which new cards to introduce first" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>New Card Selection</div>
            <div className="sub">Default: Longest parent interval first</div>
            <select
              value={schedPrefs.newPick}
              onChange={e => saveSchedPrefs({ newPick: e.currentTarget.value as CardSchedulingPrefs['newPick'] })}
              style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 10px', justifySelf: 'end' }}
            >
              <option value="parent-longest-interval" style={{ background: '#ffffff', color: '#000000' }}>Longest Parent Interval First</option>
              <option value="newest-created-first" style={{ background: '#ffffff', color: '#000000' }}>Newest Created First</option>
              <option value="random" style={{ background: '#ffffff', color: '#000000' }}>Random</option>
            </select>
          </div>

          {/* Review ordering */}
          <div className="row" title="Order reviews by due date or random" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Review Ordering</div>
            <div className="sub">Default: By due date</div>
            <select
              value={schedPrefs.reviewOrder}
              onChange={e => saveSchedPrefs({ reviewOrder: e.currentTarget.value as CardSchedulingPrefs['reviewOrder'] })}
              style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 10px', justifySelf: 'end' }}
            >
              <option value="due-date" style={{ background: '#ffffff', color: '#000000' }}>By due date (earliest first)</option>
              <option value="random" style={{ background: '#ffffff', color: '#000000' }}>Random</option>
            </select>
          </div>

          {/* Group by deck toggle */}
          <div className="row" title="Keep cards from the same deck together" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 12, alignItems: 'center' }}>
            <div>Group by Deck</div>
            <div className="sub">Deck-aware ordering</div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifySelf: 'end' }}>
              <input
                type="checkbox"
                checked={!!schedPrefs.groupByDeck}
                onChange={e => saveSchedPrefs({ groupByDeck: e.currentTarget.checked })}
              />
            </label>
          </div>
        </div>

        {/* Scheduler */}
        <div className="section">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Scheduler</div>
          <div className="sub" style={{ marginBottom: 8 }}>FSRS-like spaced repetition with presets and tuning.</div>

          <div className="row" title="Choose a preset configuration" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center' }}>
            <div>Preset</div>
            <div className="sub">Baseline parameters</div>
            <div style={{ justifySelf: 'end' }}>
              <select value={sched.preset} onChange={e => applyPreset(e.currentTarget.value)}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}>
                {getPresets().map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="row" title="Minutes for the initial learning steps before graduation" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center' }}>
            <div>Learning Steps (min)</div>
            <div className="sub">First and second steps</div>
            <div className="num-wrap" style={{ justifySelf: 'end', display: 'flex', gap: 8 }}>
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(sched.learningStepsMins[0])}
                onChange={e => { const v = Math.max(1, parseInt(e.currentTarget.value||'0',10)); const arr = [...sched.learningStepsMins]; arr[0] = v; saveSched({ learningStepsMins: arr }); }}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 80, textAlign: 'right' }} />
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(sched.learningStepsMins[1] ?? 0)}
                onChange={e => { const v = Math.max(1, parseInt(e.currentTarget.value||'0',10)); const arr = [...sched.learningStepsMins]; arr[1] = v; saveSched({ learningStepsMins: arr }); }}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 80, textAlign: 'right' }} />
            </div>
          </div>

          <div className="row" title="Initial days once a card graduates" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center' }}>
            <div>Graduate Days</div>
            <div className="sub">Good / Easy</div>
            <div className="num-wrap" style={{ justifySelf: 'end', display: 'flex', gap: 8 }}>
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(sched.graduateGoodDays)}
                onChange={e => saveSched({ graduateGoodDays: Math.max(1, parseInt(e.currentTarget.value||'0',10)) })}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 80, textAlign: 'right' }} />
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(sched.graduateEasyDays)}
                onChange={e => saveSched({ graduateEasyDays: Math.max(1, parseInt(e.currentTarget.value||'0',10)) })}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 80, textAlign: 'right' }} />
            </div>
          </div>

          <div className="row" title="Change to ease after each grade" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center' }}>
            <div>Ease Deltas</div>
            <div className="sub">again / hard / good / easy</div>
            <div style={{ justifySelf: 'end', display: 'grid', gridTemplateColumns: 'repeat(4, max-content)', gap: 8 }}>
              {(['again','hard','good','easy'] as const).map(k => (
                <input key={k} className="no-native-spin" type="text" inputMode="decimal" value={String(sched.easeDelta[k])}
                  onChange={e => { const val = parseFloat(e.currentTarget.value); const ed: any = { ...sched.easeDelta, [k]: Number.isFinite(val)?val:sched.easeDelta[k] }; saveSched({ easeDelta: ed }); }}
                  style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 70, textAlign: 'right' }} />
              ))}
            </div>
          </div>

          <div className="row" title="Tolerance window and early/late adjustment factors" style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center' }}>
            <div>Early/Late</div>
            <div className="sub">Tolerance (min), Early factor, Late slope</div>
            <div className="num-wrap" style={{ justifySelf: 'end', display: 'flex', gap: 8 }}>
              <input className="no-native-spin" type="text" inputMode="numeric" value={String(sched.tolerantWindowMins)}
                onChange={e => saveSched({ tolerantWindowMins: Math.max(0, parseInt(e.currentTarget.value||'0',10)) })}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 90, textAlign: 'right' }} />
              <input className="no-native-spin" type="text" inputMode="decimal" value={String(sched.earlyReviewFactor)} title="Early review factor"
                onChange={e => saveSched({ earlyReviewFactor: Math.max(0.1, parseFloat(e.currentTarget.value||'0')) })}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 90, textAlign: 'right' }} />
              <input className="no-native-spin" type="text" inputMode="decimal" value={String(sched.lateReviewSlope)} title="Late per-day slope"
                onChange={e => saveSched({ lateReviewSlope: Math.max(0, parseFloat(e.currentTarget.value||'0')) })}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 90, textAlign: 'right' }} />
            </div>
          </div>

          <div className="row" style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontWeight: 600 }}>Preview (from 1 day)</div>
            <div className="sub">Again: <strong>{preview.daysFmt(preview.g.again)}</strong> &nbsp; | &nbsp; Hard: <strong>{preview.daysFmt(preview.g.hard)}</strong> &nbsp; | &nbsp; Good: <strong>{preview.daysFmt(preview.g.good)}</strong> &nbsp; | &nbsp; Easy: <strong>{preview.daysFmt(preview.g.easy)}</strong></div>
          </div>
        </div>

        </div>
      </div>
    </div>
  );
}
