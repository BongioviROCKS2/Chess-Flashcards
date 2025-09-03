import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDeckById, getChildrenOf, getDeckPath, decks } from '../decks';
import { allCards } from '../data/cardStore';
import { DeckLimits, DeckLimitsDefaults, getDeckLimits, setDeckLimits, copyDeckLimits, getReviewedTodayCounts, getDueTypeCounts, planQueueForDeck, loadDeckLimitsFromFileIfAvailable } from '../state/deckLimits';

function gatherDeckAndDescendants(deckId: string): string[] {
  const acc = new Set<string>();
  const stack = [deckId];
  while (stack.length) {
    const id = stack.pop()!;
    acc.add(id);
    for (const ch of getChildrenOf(id)) stack.push(ch.id);
  }
  return Array.from(acc);
}

export default function ManageDeckPage() {
  const { deckId } = useParams<{ deckId: string }>();
  const navigate = useNavigate();
  const back = () => navigate('/');

  const deck = getDeckById(deckId);
  const path = useMemo(() => getDeckPath(deckId), [deckId]);
  const ids = useMemo(() => (deckId ? gatherDeckAndDescendants(deckId) : []), [deckId]);
  const cards = useMemo(() => allCards().filter(c => ids.includes(c.deck)), [ids]);

  const now = Date.now();
  const counts = useMemo(() => {
    let total = cards.length, newCnt = 0, due = 0, overdue = 0;
    for (const c of cards) {
      const d: any = (c as any).due;
      if (d === 'new') { newCnt++; continue; }
      if (typeof d === 'string') {
        const t = Date.parse(d);
        if (Number.isFinite(t)) {
          if (t <= now) { due++; overdue += (t < now) ? 1 : 0; }
        }
      }
    }
    return { total, newCnt, due, overdue };
  }, [cards, now]);

  const exportDeck = async () => {
    const base = path.map(p => p.name).join('-') || 'deck';
    // Always include cards from this deck and all its descendants
    const arr = cards;
    const res = await (window as any).cards?.exportJsonToDownloads?.(arr, base);
    if (res?.ok) {
      const loc = res?.path ? `\nSaved to: ${res.path}` : '';
      alert(`Export complete.${loc}`);
    } else {
      alert('Export failed: ' + (res?.message || 'Unknown'));
    }
  };

  // ---- Deck limits state ----
  const [limits, setLimits] = useState<DeckLimits>(() => getDeckLimits(deckId));
  const [selectedCopyFrom, setSelectedCopyFrom] = useState<string>('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { loadDeckLimitsFromFileIfAvailable(); }, []);
  useEffect(() => { setLimits(getDeckLimits(deckId)); }, [deckId]);

  const reviewedToday = useMemo(() => (deckId ? getReviewedTodayCounts(deckId, limits) : { new: 0, mature: 0, leech: 0, young: 0, total: 0 }), [deckId, limits]);
  const dueTypeCounts = useMemo(() => (deckId ? getDueTypeCounts(deckId) : { new: 0, mature: 0, leech: 0, young: 0, total: 0 }), [deckId, now, limits]);
  const todayPlan = useMemo(() => (deckId ? planQueueForDeck(deckId) : { ids: [], byType: { new: 0, mature: 0, leech: 0, young: 0 }, remainingByType: { new: 0, mature: 0, leech: 0 }, total: 0 }), [deckId, now, limits]);

  const updateNested = (patch: Partial<DeckLimits>) => {
    setLimits(prev => ({
      new:    { ...prev.new,    ...(patch.new    || {}) },
      mature: { ...prev.mature, ...(patch.mature || {}) },
      leech:  { ...prev.leech,  ...(patch.leech  || {}) },
      cumulativeLimit: (patch.cumulativeLimit ?? prev.cumulativeLimit),
      matureThresholdDays: (patch.matureThresholdDays ?? prev.matureThresholdDays),
      leechIncorrectThreshold: (patch.leechIncorrectThreshold ?? prev.leechIncorrectThreshold),
    }));
  };

  const clampInt = (v: number, min: number, max?: number) => {
    if (!Number.isFinite(v)) return min;
    v = Math.floor(v);
    if (v < min) v = min;
    if (typeof max === 'number' && v > max) v = max;
    return v;
  };

  const save = async () => {
    if (!deckId) return;
    setSaving(true);
    try {
      const d = DeckLimitsDefaults;
      const ov: any = {};
      if (limits.new.enabled    !== d.new.enabled   || limits.new.limit    !== d.new.limit)    ov.new    = { enabled: limits.new.enabled,    limit: limits.new.limit };
      if (limits.mature.enabled !== d.mature.enabled|| limits.mature.limit !== d.mature.limit) ov.mature = { enabled: limits.mature.enabled, limit: limits.mature.limit };
      if (limits.leech.enabled  !== d.leech.enabled || limits.leech.limit  !== d.leech.limit)  ov.leech  = { enabled: limits.leech.enabled,  limit: limits.leech.limit };
      if (limits.cumulativeLimit !== d.cumulativeLimit) ov.cumulativeLimit = limits.cumulativeLimit;
      if (limits.matureThresholdDays !== d.matureThresholdDays) ov.matureThresholdDays = limits.matureThresholdDays;
      if (limits.leechIncorrectThreshold !== d.leechIncorrectThreshold) ov.leechIncorrectThreshold = limits.leechIncorrectThreshold;
      setDeckLimits(deckId, Object.keys(ov).length ? ov : null);
      alert('Deck settings saved.');
    } finally { setSaving(false); }
  };

  const resetToDefaults = async () => {
    if (!deckId) return;
    setLimits(DeckLimitsDefaults);
    setDeckLimits(deckId, null);
  };

  const applyCopyFrom = () => {
    if (!deckId || !selectedCopyFrom) return;
    copyDeckLimits(selectedCopyFrom, deckId);
    setLimits(getDeckLimits(deckId));
  };

  const applyToAllDecks = async () => {
    const confirmMsg = 'Apply these settings to all decks? This will overwrite each deck\'s pacing overrides.';
    if (!window.confirm(confirmMsg)) return;
    setSaving(true);
    try {
      const d = DeckLimitsDefaults;
      const ov: any = {};
      if (limits.new.enabled    !== d.new.enabled   || limits.new.limit    !== d.new.limit)    ov.new    = { enabled: limits.new.enabled,    limit: limits.new.limit };
      if (limits.mature.enabled !== d.mature.enabled|| limits.mature.limit !== d.mature.limit) ov.mature = { enabled: limits.mature.enabled, limit: limits.mature.limit };
      if (limits.leech.enabled  !== d.leech.enabled || limits.leech.limit  !== d.leech.limit)  ov.leech  = { enabled: limits.leech.enabled,  limit: limits.leech.limit };
      if (limits.cumulativeLimit !== d.cumulativeLimit) ov.cumulativeLimit = limits.cumulativeLimit;
      if (limits.matureThresholdDays !== d.matureThresholdDays) ov.matureThresholdDays = limits.matureThresholdDays;
      if (limits.leechIncorrectThreshold !== d.leechIncorrectThreshold) ov.leechIncorrectThreshold = limits.leechIncorrectThreshold;

      const patch = Object.keys(ov).length ? ov : null;
      for (const dck of decks) {
        setDeckLimits(dck.id, patch);
      }
      alert('Applied settings to all decks.');
    } finally {
      setSaving(false);
    }
  };

  // Simple validation flags
  const warn = {
    new: limits.new.limit > 100,
    mature: limits.mature.limit > 1000,
    leech: limits.leech.limit > 500,
    cumulative: limits.cumulativeLimit > 5000,
    matureThr: limits.matureThresholdDays < 1 || limits.matureThresholdDays > 120,
    leechThr: limits.leechIncorrectThreshold < 1 || limits.leechIncorrectThreshold > 50,
  } as const;

  if (!deck) {
    return (
      <div className="container">
        <div className="card grid">
          <h2 style={{ margin: 0 }}>Manage Deck</h2>
          <div className="sub">Deck not found: {deckId}</div>
          <button className="button secondary" onClick={back}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card grid">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>Manage Deck</h2>
            <div className="sub" style={{ marginTop: 2 }}>
              {path.map((d, i) => (<span key={d.id}>{i>0?' / ':''}{d.name}</span>))}
            </div>
            {(warn.new || warn.mature || warn.leech || warn.cumulative || warn.matureThr || warn.leechThr) && (
              <div className="sub" style={{ color: '#f87171' }}>
                {warn.new && <span>New limit unusually high; consider ≤ 100. </span>}
                {warn.mature && <span>Mature limit unusually high; consider ≤ 1000. </span>}
                {warn.leech && <span>Leech limit unusually high; consider ≤ 500. </span>}
                {warn.cumulative && <span>Cumulative limit unusually high; consider ≤ 5000. </span>}
                {warn.matureThr && <span>Mature threshold suggested range: 1–120 days. </span>}
                {warn.leechThr && <span>Leech threshold suggested range: 1–50 incorrect. </span>}
              </div>
            )}
          </div>
          <button className="button secondary" onClick={back}>Back</button>
        </div>

        <div className="grid" style={{ gap: 12, gridTemplateColumns: '1fr' }}>
          <div className="row" style={{ display: 'flex', gap: 20 }}>
            <div>Total: <strong>{counts.total}</strong></div>
            <div>New: <strong>{counts.newCnt}</strong></div>
            <div>Due: <strong>{counts.due}</strong></div>
            <div>Overdue: <strong>{counts.overdue}</strong></div>
          </div>

          {/* Limits & thresholds */}
          <div className="row" style={{ display: 'grid', gap: 12, width: '100%', justifyContent: 'stretch' }}>
            <div style={{ fontWeight: 700 }}>Daily Limits</div>
            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center', width: '100%', justifyContent: 'stretch' }}>
              <div title="Cap new cards introduced today in this deck (incl. children)">New</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Enable pacing: When on, caps how many NEW cards you review per day in this deck. Turn off to ignore this cap.">
                  <input type="checkbox" checked={limits.new.enabled} onChange={e => updateNested({ new: { enabled: e.currentTarget.checked } as any })} />
                  <span className="sub">Enable pacing</span>
                </label>
              </div>
              <div className="num-wrap" title="Maximum new cards reviewed per day" style={{ justifySelf: 'end' }}>
                <input className="no-native-spin" type="text" inputMode="numeric" value={String(limits.new.limit)}
                  onChange={e => updateNested({ new: { limit: clampInt(parseInt(e.currentTarget.value, 10), 0, 10000) } as any })}
                  style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 80, textAlign: 'right' }} />
                <div className="num-stepper" aria-hidden="true">
                  <button type="button" className="step up" onClick={() => updateNested({ new: { limit: limits.new.limit + 1 } as any })}>▲</button>
                  <button type="button" className="step down" onClick={() => updateNested({ new: { limit: Math.max(0, limits.new.limit - 1) } as any })}>▼</button>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center', width: '100%', justifyContent: 'stretch' }}>
              <div title="Cap mature reviews per day; maturity based on threshold below">Mature</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Enable pacing: When on, caps how many MATURE cards you review per day in this deck (maturity uses the threshold below). Turn off to ignore this cap.">
                  <input type="checkbox" checked={limits.mature.enabled} onChange={e => updateNested({ mature: { enabled: e.currentTarget.checked } as any })} />
                  <span className="sub">Enable pacing</span>
                </label>
              </div>
              <div className="num-wrap" title="Maximum mature reviews per day" style={{ justifySelf: 'end' }}>
                <input className="no-native-spin" type="text" inputMode="numeric" value={String(limits.mature.limit)}
                  onChange={e => updateNested({ mature: { limit: clampInt(parseInt(e.currentTarget.value, 10), 0, 10000) } as any })}
                  style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 80, textAlign: 'right' }} />
                <div className="num-stepper" aria-hidden="true">
                  <button type="button" className="step up" onClick={() => updateNested({ mature: { limit: limits.mature.limit + 1 } as any })}>▲</button>
                  <button type="button" className="step down" onClick={() => updateNested({ mature: { limit: Math.max(0, limits.mature.limit - 1) } as any })}>▼</button>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center', width: '100%', justifyContent: 'stretch' }}>
              <div title="Cap leech cards (high error count) per day">Leech</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Enable pacing: When on, caps how many LEECH cards (high incorrect count) you review per day in this deck. Turn off to ignore this cap.">
                  <input type="checkbox" checked={limits.leech.enabled} onChange={e => updateNested({ leech: { enabled: e.currentTarget.checked } as any })} />
                  <span className="sub">Enable pacing</span>
                </label>
              </div>
              <div className="num-wrap" title="Maximum leech reviews per day" style={{ justifySelf: 'end' }}>
                <input className="no-native-spin" type="text" inputMode="numeric" value={String(limits.leech.limit)}
                  onChange={e => updateNested({ leech: { limit: clampInt(parseInt(e.currentTarget.value, 10), 0, 10000) } as any })}
                  style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 80, textAlign: 'right' }} />
                <div className="num-stepper" aria-hidden="true">
                  <button type="button" className="step up" onClick={() => updateNested({ leech: { limit: limits.leech.limit + 1 } as any })}>▲</button>
                  <button type="button" className="step down" onClick={() => updateNested({ leech: { limit: Math.max(0, limits.leech.limit - 1) } as any })}>▼</button>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center', width: '100%', justifyContent: 'stretch' }}>
              <div title="Hard cap across all types for this deck per day">Cumulative Limit</div>
              <div />
              <div className="num-wrap" style={{ justifySelf: 'end' }}>
                <input className="no-native-spin" type="text" inputMode="numeric" value={String(limits.cumulativeLimit)}
                  onChange={e => updateNested({ cumulativeLimit: clampInt(parseInt(e.currentTarget.value, 10), 0, 999999) })}
                  style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 100, textAlign: 'right' }} />
                <div className="num-stepper" aria-hidden="true">
                  <button type="button" className="step up" onClick={() => updateNested({ cumulativeLimit: limits.cumulativeLimit + 10 })}>▲</button>
                  <button type="button" className="step down" onClick={() => updateNested({ cumulativeLimit: Math.max(0, limits.cumulativeLimit - 10) })}>▼</button>
                </div>
              </div>
            </div>

            <div style={{ fontWeight: 700, marginTop: 4 }}>Thresholds</div>
            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center', width: '100%', justifyContent: 'stretch' }}>
              <div title="A card is considered mature if its current interval is at least this many days">Mature Threshold (days)</div>
              <div className="sub">Defines which non-new cards count as mature</div>
              <div className="num-wrap" style={{ justifySelf: 'end' }}>
                <input className="no-native-spin" type="text" inputMode="numeric" value={String(limits.matureThresholdDays)}
                  onChange={e => updateNested({ matureThresholdDays: clampInt(parseInt(e.currentTarget.value, 10), 1, 3650) })}
                  style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 100, textAlign: 'right' }} />
                <div className="num-stepper" aria-hidden="true">
                  <button type="button" className="step up" onClick={() => updateNested({ matureThresholdDays: limits.matureThresholdDays + 1 })}>▲</button>
                  <button type="button" className="step down" onClick={() => updateNested({ matureThresholdDays: Math.max(1, limits.matureThresholdDays - 1) })}>▼</button>
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr max-content', gap: 10, alignItems: 'center', width: '100%' }}>
              <div title="A card is considered leech once it has this many 'Again' ratings">Leech Threshold (incorrect)</div>
              <div className="sub">Count of 'Again' reviews</div>
              <div className="num-wrap" style={{ justifySelf: 'end' }}>
                <input className="no-native-spin" type="text" inputMode="numeric" value={String(limits.leechIncorrectThreshold)}
                  onChange={e => updateNested({ leechIncorrectThreshold: clampInt(parseInt(e.currentTarget.value, 10), 1, 9999) })}
                  style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px', width: 100, textAlign: 'right' }} />
                <div className="num-stepper" aria-hidden="true">
                  <button type="button" className="step up" onClick={() => updateNested({ leechIncorrectThreshold: limits.leechIncorrectThreshold + 1 })}>▲</button>
                  <button type="button" className="step down" onClick={() => updateNested({ leechIncorrectThreshold: Math.max(1, limits.leechIncorrectThreshold - 1) })}>▼</button>
                </div>
              </div>
            </div>
          </div>

          {/* Preview & Status */}
          <div className="row" style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontWeight: 700 }}>Preview & Status</div>
            <div className="sub">Due now — New: <strong>{dueTypeCounts.new}</strong>, Mature: <strong>{dueTypeCounts.mature}</strong>, Leeches: <strong>{dueTypeCounts.leech}</strong>, Young: <strong>{dueTypeCounts.young}</strong> (Total {dueTypeCounts.total})</div>
            <div className="sub">Reviewed today — New: <strong>{reviewedToday.new}</strong>, Mature: <strong>{reviewedToday.mature}</strong>, Leeches: <strong>{reviewedToday.leech}</strong>, Young: <strong>{reviewedToday.young}</strong> (Total {reviewedToday.total})</div>
            <div className="sub">Planned for today — New: <strong>{todayPlan.byType.new}</strong>, Mature: <strong>{todayPlan.byType.mature}</strong>, Leeches: <strong>{todayPlan.byType.leech}</strong>, Young: <strong>{todayPlan.byType.young}</strong>, Total: <strong>{todayPlan.total}</strong></div>
            <div className="sub">Remaining allowance — New: <strong>{todayPlan.remainingByType.new}</strong>, Mature: <strong>{todayPlan.remainingByType.mature}</strong>, Leeches: <strong>{todayPlan.remainingByType.leech}</strong></div>
          </div>

          {/* Actions: Save/Reset/Copy/Export */}
          <div className="row" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="button" onClick={save} disabled={saving} title="Save deck settings">{saving ? 'Saving…' : 'Save Settings'}</button>
            <button className="button secondary" onClick={resetToDefaults} title="Reset this deck back to global defaults">Reset to Defaults</button>
            <button className="button secondary" onClick={applyToAllDecks} disabled={saving} title="Apply these settings to every deck">Apply to All Decks</button>

            <div style={{ flex: 1 }} />

            <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <span className="sub">Copy from deck</span>
              <select
                value={selectedCopyFrom}
                onChange={e => setSelectedCopyFrom(e.currentTarget.value)}
                style={{ backgroundColor: '#fff', color: '#000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
              >
                <option value="">(choose)</option>
                {decks.filter(d => d.id !== deckId).map(d => {
                  const pname = getDeckPath(d.id).map(x => x.name).join(' / ');
                  return <option key={d.id} value={d.id}>{pname}</option>;
                })}
              </select>
              <button className="button secondary" onClick={applyCopyFrom} disabled={!selectedCopyFrom}>Copy</button>
            </div>

            <button className="button" onClick={() => exportDeck()} title="Export this deck and its descendants to Downloads">Export Deck</button>
          </div>
        </div>
      </div>
    </div>
  );
}
