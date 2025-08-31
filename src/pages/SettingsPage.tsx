import { useNavigate, useLocation } from 'react-router-dom';
import { useSettings } from '../state/settings';
import React, { useEffect, useMemo, useRef } from 'react';

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
          <button className="button secondary" onClick={handleBack}>Back</button>
        </div>

        <div className="grid" style={{ gap: 14 }}>
          {/* Keybinds (first item) */}
          <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>Keybinds</div>
            <button
              className="button"
              onClick={async () => {
                await maybeSaveCardgenConfig();
                navigate('/settings/keybinds', { state: { from: location } });
              }}
            >
              Manage
            </button>
          </div>

          {/* Preferences subsection title */}
          <div style={{ fontWeight: 600, fontSize: 18, opacity: 0.95, marginTop: 4 }}>
            Preferences
          </div>

          {/* Light Theme toggle */}
          <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>Light Theme</div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={lightThemeChecked}
                onChange={e => update({ theme: e.currentTarget.checked ? 'light' : 'dark' })}
              />
            </label>
          </div>

          {/* Start review position (dropdown) */}
          <div className="row" style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, paddingRight: 20 }}>Start review with...</div>
            <select
              value={settings.frontStartAtReview ? 'review' : 'initial'}
              onChange={e => update({ frontStartAtReview: e.currentTarget.value === 'review' })}
              style={{
                backgroundColor: '#ffffff',
                color: '#000000',
                border: '1px solid var(--border-strong)',
                borderRadius: 8,
                padding: '6px 10px',
                width: 'fit-content',
                minWidth: 'unset',
                maxWidth: '100%',
                display: 'inline-block',
                whiteSpace: 'nowrap',
              }}
            >
              <option value="initial" style={{ background: '#ffffff', color: '#000000' }}>
                Initial Position
              </option>
              <option value="review" style={{ background: '#ffffff', color: '#000000' }}>
                Review Position
              </option>
            </select>
          </div>

          {/* Card Creation subsection title */}
          <div style={{ fontWeight: 600, fontSize: 18, opacity: 0.95, marginTop: 4 }}>
            Card Creation
          </div>

          {/* Other Answers Acceptance (custom right stepper) */}
          <div className="row" style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, paddingRight: 20 }}>Other Answers Acceptance</div>
            <div className="num-wrap">
              <input
                className="num-accept no-native-spin"
                type="text"
                inputMode="decimal"
                value={acceptanceStr}
                onChange={e => {
                  const num = parseFloat(e.currentTarget.value);
                  setAcceptance(num);
                }}
                onKeyDown={onAccKeyDown}
                onBlur={(e) => {
                  const num = parseFloat(e.currentTarget.value);
                  setAcceptance(num);
                }}
                style={{
                  backgroundColor: '#ffffff',
                  color: '#000000',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  width: 60,
                  minWidth: 'unset',
                  maxWidth: 60,
                  display: 'inline-block',
                  textAlign: 'right',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                }}
                title="Accept other answers within this pawn value of the best move (e.g., 0.20 = 20 centipawns)."
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incAcc} title="Increase by 0.01" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decAcc} title="Decrease by 0.01" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Max Other Answer Count (custom right stepper) */}
          <div className="row" style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, paddingRight: 20 }}>Max Other Answer Count</div>
            <div className="num-wrap">
              <input
                className="no-native-spin"
                type="text"
                inputMode="numeric"
                value={String(moac)}
                onChange={e => setMoac(parseInt(e.currentTarget.value, 10))}
                onKeyDown={onMoacKeyDown}
                onBlur={e => setMoac(parseInt(e.currentTarget.value, 10))}
                style={{
                  backgroundColor: '#ffffff',
                  color: '#000000',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  width: 70,
                  minWidth: 'unset',
                  maxWidth: 80,
                  display: 'inline-block',
                  textAlign: 'right',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                }}
                title="Number of alternative moves to consider; script uses MultiPV = 1 + this."
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incMoac} title="Increase by 1" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decMoac} title="Decrease by 1" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Engine Depth (custom right stepper) */}
          <div className="row" style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, paddingRight: 20 }}>Engine Depth</div>
            <div className="num-wrap">
              <input
                className="no-native-spin"
                type="text"
                inputMode="numeric"
                value={String(depth)}
                onChange={e => setDepth(parseInt(e.currentTarget.value, 10))}
                onKeyDown={onDepthKeyDown}
                onBlur={e => setDepth(parseInt(e.currentTarget.value, 10))}
                style={{
                  backgroundColor: '#ffffff',
                  color: '#000000',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  width: 70,
                  minWidth: 'unset',
                  maxWidth: 80,
                  display: 'inline-block',
                  textAlign: 'right',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                }}
                title="Engine depth (higher = stronger and slower). 25 default; 30+ for strong machines."
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incDepth} title="Increase by 1" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decDepth} title="Decrease by 1" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Threads (custom right stepper) */}
          <div className="row" style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, paddingRight: 20 }}>Threads</div>
            <div className="num-wrap">
              <input
                className="no-native-spin"
                type="text"
                inputMode="numeric"
                value={String(threads)}
                onChange={e => setThreads(parseInt(e.currentTarget.value, 10))}
                onKeyDown={onThreadsKeyDown}
                onBlur={e => setThreads(parseInt(e.currentTarget.value, 10))}
                style={{
                  backgroundColor: '#ffffff',
                  color: '#000000',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  width: 70,
                  minWidth: 'unset',
                  maxWidth: 80,
                  display: 'inline-block',
                  textAlign: 'right',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                }}
                title={`Stockfish threads. Max suggested: ${hwThreads} (logical CPUs).`}
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incThreads} title="Increase by 1" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decThreads} title="Decrease by 1" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

          {/* Hash (MB) (custom right stepper) */}
          <div className="row" style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, paddingRight: 20 }}>Hash (MB)</div>
            <div className="num-wrap">
              <input
                className="no-native-spin"
                type="text"
                inputMode="numeric"
                value={String(hash)}
                onChange={e => setHash(parseInt(e.currentTarget.value, 10))}
                onKeyDown={onHashKeyDown}
                onBlur={e => setHash(parseInt(e.currentTarget.value, 10))}
                style={{
                  backgroundColor: '#ffffff',
                  color: '#000000',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  width: 90,
                  minWidth: 'unset',
                  maxWidth: 120,
                  display: 'inline-block',
                  textAlign: 'right',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                }}
                title={`Transposition table size in MB. ${deviceMemGB ? `Device memory ~${deviceMemGB}GB` : 'Adjust to your RAM.'}`}
              />
              <div className="num-stepper" aria-hidden="false">
                <button type="button" className="step up" onClick={incHash} title="Increase by 64" aria-label="Increase">▲</button>
                <button type="button" className="step down" onClick={decHash} title="Decrease by 64" aria-label="Decrease">▼</button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
