import { useNavigate } from 'react-router-dom';
import { useBackKeybind } from '../hooks/useBackKeybind';
import { useKeybinds, formatActionKeys } from '../context/KeybindsProvider';
import React, { useMemo, useState } from 'react';
import { allCards } from '../data/cardStore';
import { decks, getDeckPathNames, getDescendantDeckIds } from '../decks';

type Grade = 'again' | 'hard' | 'good' | 'easy';
type Entry = {
  id: string;
  grade: Grade;
  ts: number;
  deck?: string;
  prevInt?: number; // minutes
  newInt?: number;  // minutes
  wasNew?: boolean;
  newDueISO?: string;
  durationMs?: number;
};
const LOG_KEY = 'chessflashcards.reviewLog.v1';
const SNAP_KEY = 'chessflashcards.statsSnapshots.v1';

function loadLog(): Entry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as Entry[]) : [];
  } catch { return []; }
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export default function StatsPage() {
  const navigate = useNavigate();
  const onBack = () => navigate(-1);
  useBackKeybind(onBack, true);
  const { binds } = useKeybinds();
  const backKeys = formatActionKeys(binds, 'app.back');

  const [_, setBump] = useState(0);
  const bump = () => setBump(v => v + 1);

  const log = useMemo(() => loadLog(), [_]);

  // --- Filters ---
  const deckOptions = useMemo(() => [{ id: 'ALL', name: 'All Decks' }, ...decks.map(d => ({ id: d.id, name: getDeckPathNames(d.id).join(' / ') || d.name }))], []);
  const [deckFilter, setDeckFilter] = useState<string>('ALL');
  const [includeDesc, setIncludeDesc] = useState<boolean>(true);
  const [range, setRange] = useState<'today' | '7d' | '30d' | '90d' | '365d' | 'all'>('30d');

  const sinceTs = useMemo(() => {
    const now = new Date();
    now.setHours(0,0,0,0);
    const todayStart = now.getTime();
    switch (range) {
      case 'today': return todayStart;
      case '7d': return todayStart - 6 * 86400000;
      case '30d': return todayStart - 29 * 86400000;
      case '90d': return todayStart - 89 * 86400000;
      case '365d': return todayStart - 364 * 86400000;
      case 'all': default: return 0;
    }
  }, [range]);

  // Card -> deck map for legacy entries
  const idToDeck = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of allCards()) m.set(c.id, c.deck);
    return m;
  }, []);

  const deckPass = (deckId?: string) => {
    if (deckFilter === 'ALL') return true;
    const selected = deckFilter;
    if (!selected) return true;
    if (!deckId) return false;
    if (deckId === selected) return true;
    if (!includeDesc) return false;
    const kids = getDescendantDeckIds(selected);
    return kids.includes(deckId);
  };

  const filtered = useMemo(() => {
    const out: Entry[] = [];
    for (const e of log) {
      const deckId = e.deck || idToDeck.get(e.id);
      if (e.ts < sinceTs) continue;
      if (!deckPass(deckId)) continue;
      out.push({ ...e, deck: deckId });
    }
    return out;
  }, [log, sinceTs, deckFilter, includeDesc, idToDeck]);

  const totals = useMemo(() => {
    const byDay = new Map<string, number>();
    const byGrade: Record<Grade, number> = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const e of filtered) {
      const k = dayKey(e.ts);
      byDay.set(k, (byDay.get(k) || 0) + 1);
      byGrade[e.grade]++;
    }
    // Build continuous day series within range (up to 365 days for perf)
    const days: [string, number][] = [];
    const minTs = sinceTs;
    const maxTs = Date.now();
    const d = new Date(minTs || Date.now());
    if (minTs) d.setHours(0,0,0,0);
    else {
      // If all-time, start at first day in data
      const first = Array.from(byDay.keys()).sort()[0];
      if (first) d.setTime(Date.parse(first)); else d.setTime(Date.now());
    }
    d.setHours(0,0,0,0);
    while (d.getTime() <= maxTs) {
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      days.push([key, byDay.get(key) || 0]);
      d.setDate(d.getDate() + 1);
      if (days.length > 370) break;
    }
    return { byDay: days, byGrade };
  }, [filtered, sinceTs]);

  // Accuracy & durations
  const accuracy = useMemo(() => {
    let correct = 0, incorrect = 0;
    let durSum = 0, durCount = 0;
    let newCorrect = 0, newTotal = 0;
    let matureCorrect = 0, matureTotal = 0;
    for (const e of filtered) {
      if (e.durationMs && Number.isFinite(e.durationMs)) {
        durSum += e.durationMs!;
        durCount++;
      }
      const isCorrect = e.grade !== 'again';
      if (isCorrect) correct++; else incorrect++;
      // Approx classification: rely on wasNew/newInt if present; else infer from prevInt
      const wasNew = typeof e.wasNew === 'boolean' ? e.wasNew : undefined;
      const prevDays = (e.prevInt ?? 0) / (60 * 24);
      const mature = (e.prevInt ?? 0) >= (21 * 24 * 60); // 21d threshold
      if (wasNew === true || (e.prevInt != null && e.prevInt <= 0)) {
        newTotal++; if (isCorrect) newCorrect++;
      } else if (mature || e.prevInt != null) {
        matureTotal++; if (isCorrect) matureCorrect++;
      }
    }
    return {
      correct,
      incorrect,
      rate: (correct + incorrect) ? (correct / (correct + incorrect)) : 0,
      avgDurationMs: durCount ? durSum / durCount : 0,
      newRate: newTotal ? (newCorrect / newTotal) : undefined,
      matureRate: matureTotal ? (matureCorrect / matureTotal) : undefined,
      counts: { newTotal, matureTotal },
    };
  }, [filtered]);

  // Per-deck accuracy (in current filter window)
  const perDeck = useMemo(() => {
    const map = new Map<string, { name: string; total: number; correct: number }>();
    for (const e of filtered) {
      const did = e.deck || idToDeck.get(e.id) || 'unknown';
      const name = did === 'unknown' ? 'Unknown' : (getDeckPathNames(did).join(' / ') || did);
      const cur = map.get(did) || { name, total: 0, correct: 0 };
      cur.total++;
      if (e.grade !== 'again') cur.correct++;
      map.set(did, cur);
    }
    return Array.from(map.entries()).sort((a,b) => b[1].total - a[1].total);
  }, [filtered, idToDeck]);

  // Daily streaks (activity days)
  const { currentStreak, longestStreak } = useMemo(() => {
    const days = new Set(totals.byDay.filter(([_, n]) => n > 0).map(([d]) => d));
    // Build from entire log for longest streak
    const allCounts = new Map<string, number>();
    for (const e of log) {
      const k = dayKey(e.ts);
      allCounts.set(k, (allCounts.get(k) || 0) + 1);
    }
    const allDaysSorted = Array.from(allCounts.keys()).sort();
    let longest = 0, cur = 0, last: string | null = null;
    for (const k of allDaysSorted) {
      if (!last) { cur = 1; longest = 1; last = k; continue; }
      const prev = new Date(last); const curd = new Date(k);
      const delta = Math.round((curd.getTime() - prev.getTime()) / 86400000);
      if (delta === 1) cur++; else if (allCounts.get(k)! > 0) cur = 1; else cur = 0;
      if (cur > longest) longest = cur;
      last = k;
    }
    // Current streak up to today
    let curStreak = 0;
    const today = new Date(); today.setHours(0,0,0,0);
    for (let i = 0; i < 400; i++) {
      const key = dayKey(today.getTime() - i * 86400000);
      if (days.has(key)) curStreak++; else break;
    }
    return { currentStreak: curStreak, longestStreak: longest };
  }, [totals.byDay, log]);

  // Interval distribution (from events that include newInt)
  const intervals = useMemo(() => {
    const vals: number[] = [];
    for (const e of filtered) {
      if (typeof e.newInt === 'number' && e.newInt >= 0) vals.push(e.newInt);
    }
    vals.sort((a,b) => a - b);
    const toLabel = (m: number) => {
      if (m < 60) return `${m}m`;
      const h = Math.round(m/60);
      if (h < 24) return `${h}h`;
      const d = Math.round(h/24);
      return `${d}d`;
    };
    // Simple 8 bins across quantiles
    const bins: { label: string; count: number }[] = [];
    if (vals.length === 0) return { bins, avgNextDays: 0 };
    const parts = 8;
    for (let i = 0; i < parts; i++) {
      const idx = Math.min(vals.length - 1, Math.floor((i+1) * vals.length / parts) - 1);
      const label = toLabel(vals[idx]);
      bins.push({ label, count: 0 });
    }
    for (const v of vals) {
      // Find first bin whose threshold label corresponds >= v
      let bi = bins.findIndex((b, i) => v <= vals[Math.min(vals.length - 1, Math.floor((i+1) * vals.length / parts) - 1)]);
      if (bi < 0) bi = bins.length - 1;
      bins[bi].count++;
    }
    const avgNextDays = vals.length ? (vals.reduce((a,b)=>a+b,0) / vals.length) / (60*24) : 0;
    return { bins, avgNextDays };
  }, [filtered]);

  // Per-card breakdown
  const breakdown = useMemo(() => {
    const map = new Map<string, { total: number; again: number; deck?: string }>();
    const growth = new Map<string, { lastInt?: number; maxJump: number }>();
    for (const e of filtered) {
      const m = map.get(e.id) || { total: 0, again: 0, deck: e.deck };
      m.total++; if (e.grade === 'again') m.again++;
      map.set(e.id, m);
      if (typeof e.newInt === 'number') {
        const g = growth.get(e.id) || { lastInt: undefined, maxJump: 0 };
        if (typeof g.lastInt === 'number') {
          g.maxJump = Math.max(g.maxJump, e.newInt - g.lastInt);
        }
        g.lastInt = e.newInt;
        growth.set(e.id, g);
      }
    }
    const worst = Array.from(map.entries())
      .filter(([,m]) => m.total >= 3) // require a few reviews
      .map(([id, m]) => ({ id, deck: m.deck, pct: m.again / m.total, again: m.again, total: m.total }))
      .sort((a,b) => b.pct - a.pct)
      .slice(0, 5);
    const fastest = Array.from(growth.entries())
      .map(([id,g]) => ({ id, jump: g.maxJump || 0, deck: (map.get(id)?.deck) }))
      .filter(x => x.jump > 0)
      .sort((a,b) => b.jump - a.jump)
      .slice(0, 5);
    return { worst, fastest };
  }, [filtered]);

  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const selectedHistory = useMemo(() => {
    if (!selectedCard) return [] as Entry[];
    return filtered.filter(e => e.id === selectedCard).sort((a,b) => a.ts - b.ts);
  }, [filtered, selectedCard]);

  const clear = () => {
    try {
      if (window.confirm('Clear all review stats? This cannot be undone.')) {
        localStorage.removeItem(LOG_KEY);
        bump();
      }
    } catch {
      // If confirm fails for any reason, do nothing
    }
  };

  // Export helpers
  const download = (name: string, type: string, data: string) => {
    const blob = new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  const exportCsv = () => {
    const header = ['id','deck','ts','date','grade','durationMs','newIntMin'];
    const rows = filtered.map(e => [
      e.id,
      e.deck || (idToDeck.get(e.id) || ''),
      String(e.ts),
      new Date(e.ts).toISOString(),
      e.grade,
      (e.durationMs ?? ''),
      (e.newInt ?? ''),
    ]);
    const csv = [header.join(','), ...rows.map(r => r.map(x => typeof x === 'string' && x.includes(',') ? JSON.stringify(x) : String(x)).join(','))].join('\n');
    download('reviews.csv', 'text/csv', csv);
  };

  const exportJson = () => {
    const data = {
      filters: { deck: deckFilter, includeDesc, range },
      totals,
      accuracy,
      perDeck,
      intervals,
      count: filtered.length,
    };
    download('stats.json', 'application/json', JSON.stringify(data, null, 2));
  };

  // Snapshots
  type Snapshot = { ts: number; filters: any; totals: typeof totals; accuracy: typeof accuracy; intervals: typeof intervals };
  const loadSnaps = (): Snapshot[] => {
    try {
      const raw = localStorage.getItem(SNAP_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  };
  const [snaps, setSnaps] = useState<Snapshot[]>(() => loadSnaps());
  const saveSnaps = (s: Snapshot[]) => { try { localStorage.setItem(SNAP_KEY, JSON.stringify(s)); } catch {}; setSnaps(s); };
  const addSnapshot = () => {
    const snap: Snapshot = { ts: Date.now(), filters: { deck: deckFilter, includeDesc, range }, totals, accuracy, intervals } as any;
    const s = [...snaps, snap];
    saveSnaps(s);
  };
  const deleteSnapshot = (ts: number) => { const s = snaps.filter(x => x.ts !== ts); saveSnaps(s); };

  return (
    <div className="container">
      <div className="card grid">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Stats</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="button secondary" onClick={exportCsv} title="Export filtered reviews to CSV">Export CSV</button>
            <button className="button secondary" onClick={exportJson} title="Export current stats as JSON">Export JSON</button>
            <button className="button secondary" onClick={addSnapshot} title="Store snapshot for later comparison">Snapshot</button>
            <button className="button secondary" onClick={clear} title="Clear review log">Clear</button>
            <button className="button secondary" onClick={onBack} title={`Back${backKeys ? ` (${backKeys})` : ''}`}>Back</button>
          </div>
        </div>

        <div className="grid" style={{ padding: 8, gap: 16 }}>
          {/* Filters */}
          <div className="section" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="sub" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              Deck:
              <select value={deckFilter} onChange={(e) => setDeckFilter(e.target.value)}>
                {deckOptions.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
            <label className="sub" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={includeDesc} onChange={(e) => setIncludeDesc(e.target.checked)} /> Include descendants
            </label>
            <label className="sub" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              Range:
              <select value={range} onChange={(e) => setRange(e.target.value as any)}>
                <option value="today">Today</option>
                <option value="7d">7 days</option>
                <option value="30d">30 days</option>
                <option value="90d">90 days</option>
                <option value="365d">1 year</option>
                <option value="all">All time</option>
              </select>
            </label>
            <div className="sub">Total: <strong>{filtered.length}</strong></div>
          </div>

          {/* Activity */}
          <div className="section">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Daily Reviews</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', overflowX: 'auto', paddingBottom: 4 }}>
              {totals.byDay.length === 0 ? (
                <div className="sub">No reviews yet.</div>
              ) : (
                totals.byDay.map(([day, count]) => (
                  <div key={day} style={{ textAlign: 'center' }} title={`${day}: ${count}`}>
                    <div style={{ background: count > 0 ? 'var(--accent)' : 'var(--muted)', width: 10, height: Math.max(4, count * 6), borderRadius: 3, opacity: count > 0 ? 1 : 0.4 }} />
                  </div>
                ))
              )}
            </div>
            <div className="sub" style={{ marginTop: 4 }}>Current streak: <strong>{currentStreak}</strong> days • Longest: <strong>{longestStreak}</strong> days</div>
          </div>

          {/* Accuracy */}
          <div className="section">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Accuracy</div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>Correct: <strong>{accuracy.correct}</strong></div>
              <div>Incorrect: <strong>{accuracy.incorrect}</strong></div>
              <div>Rate: <strong>{(accuracy.rate * 100).toFixed(1)}%</strong></div>
              <div title="Mean time from showing answer to grading">Avg answer time: <strong>{accuracy.avgDurationMs ? (accuracy.avgDurationMs/1000).toFixed(1) + 's' : '—'}</strong></div>
            </div>
            <div className="sub" style={{ marginTop: 6 }}>
              New cards: {accuracy.counts.newTotal || 0} • {typeof accuracy.newRate === 'number' ? `${(accuracy.newRate*100).toFixed(1)}%` : '—'} &nbsp; | &nbsp;
              Mature cards: {accuracy.counts.matureTotal || 0} • {typeof accuracy.matureRate === 'number' ? `${(accuracy.matureRate*100).toFixed(1)}%` : '—'}
            </div>
          </div>

          {/* By Grade raw counts */}
          <div className="section">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>By Grade</div>
            <div style={{ display: 'flex', gap: 12 }}>
              {(['again','hard','good','easy'] as Grade[]).map(g => (
                <div key={g} className="row" style={{ display: 'flex', gap: 8 }}>
                  <div style={{ textTransform: 'capitalize' }}>{g}</div>
                  <div style={{ fontWeight: 700 }}>{totals.byGrade[g]}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Per-deck */}
          <div className="section">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Per Deck (filtered window)</div>
            {perDeck.length === 0 ? (
              <div className="sub">No data.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 4, maxWidth: 700 }}>
                <div className="sub" style={{ fontWeight: 600 }}>Deck</div>
                <div className="sub" style={{ textAlign: 'right', fontWeight: 600 }}>Total</div>
                <div className="sub" style={{ textAlign: 'right', fontWeight: 600 }}>Correct</div>
                <div className="sub" style={{ textAlign: 'right', fontWeight: 600 }}>Rate</div>
                {perDeck.map(([id, d]) => (
                  <React.Fragment key={id}>
                    <div className="sub">{d.name}</div>
                    <div className="sub" style={{ textAlign: 'right' }}>{d.total}</div>
                    <div className="sub" style={{ textAlign: 'right' }}>{d.correct}</div>
                    <div className="sub" style={{ textAlign: 'right' }}>{d.total ? ((d.correct/d.total)*100).toFixed(0)+'%' : '—'}</div>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>

          {/* Interval & scheduling insights */}
          <div className="section">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Interval Distribution</div>
            {intervals.bins.length === 0 ? (
              <div className="sub">No interval data yet. Complete some reviews to populate this.</div>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                {intervals.bins.map((b, i) => (
                  <div key={i} style={{ textAlign: 'center' }} title={`≤ ${b.label}: ${b.count}`}>
                    <div style={{ background: 'var(--accent)', width: 20, height: Math.max(4, b.count * 6), borderRadius: 4 }} />
                    <div className="sub" style={{ marginTop: 2 }}>{b.label}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="sub" style={{ marginTop: 4 }}>Avg next interval: <strong>{intervals.avgNextDays ? intervals.avgNextDays.toFixed(1) : '—'}</strong> days</div>
          </div>

          {/* Card performance breakdown */}
          <div className="section">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Card Performance</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div className="sub" style={{ fontWeight: 600, marginBottom: 4 }}>Highest lapse rate</div>
                {breakdown.worst.length === 0 ? <div className="sub">No data.</div> : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 6 }}>
                    {breakdown.worst.map(w => (
                      <React.Fragment key={w.id}>
                        <div className="sub" title={w.id}>#{w.id.slice(0,6)}</div>
                        <div className="sub">{(getDeckPathNames(w.deck || '').join(' / ') || w.deck || 'Deck')}</div>
                        <div className="sub">{(w.pct*100).toFixed(0)}% ({w.again}/{w.total})</div>
                        <div><button className="button secondary" onClick={() => setSelectedCard(w.id)}>History</button></div>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="sub" style={{ fontWeight: 600, marginBottom: 4 }}>Fastest growth</div>
                {breakdown.fastest.length === 0 ? <div className="sub">No data.</div> : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 6 }}>
                    {breakdown.fastest.map(f => (
                      <React.Fragment key={f.id}>
                        <div className="sub" title={f.id}>#{f.id.slice(0,6)}</div>
                        <div className="sub">{(getDeckPathNames(f.deck || '').join(' / ') || f.deck || 'Deck')}</div>
                        <div className="sub">+{Math.round((f.jump||0)/(60*24))}d</div>
                        <div><button className="button secondary" onClick={() => setSelectedCard(f.id)}>History</button></div>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Per-card history */}
          {selectedCard && (
            <div className="section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontWeight: 600 }}>History for #{selectedCard.slice(0,8)}</div>
                <button className="button secondary" onClick={() => setSelectedCard(null)}>Close</button>
              </div>
              {selectedHistory.length === 0 ? (
                <div className="sub" style={{ marginTop: 6 }}>No entries in current filter. Try expanding the range.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto auto', gap: 6, marginTop: 6 }}>
                  <div className="sub" style={{ fontWeight: 600 }}>Date</div>
                  <div className="sub" style={{ fontWeight: 600 }}>Grade</div>
                  <div className="sub" style={{ fontWeight: 600 }}>Next interval</div>
                  <div className="sub" style={{ fontWeight: 600 }}>Answer time</div>
                  {selectedHistory.map(e => (
                    <React.Fragment key={String(e.ts)+e.grade}>
                      <div className="sub">{new Date(e.ts).toLocaleString()}</div>
                      <div className="sub" style={{ textTransform: 'capitalize' }}>{e.grade}</div>
                      <div className="sub">{typeof e.newInt === 'number' ? `${Math.round((e.newInt)/(60*24))}d` : '—'}</div>
                      <div className="sub">{typeof e.durationMs === 'number' ? `${(e.durationMs/1000).toFixed(1)}s` : '—'}</div>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Snapshots */}
          <div className="section">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Snapshots</div>
            {snaps.length === 0 ? (
              <div className="sub">No snapshots saved.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 6 }}>
                <div className="sub" style={{ fontWeight: 600 }}>When</div>
                <div className="sub" style={{ fontWeight: 600, textAlign: 'right' }}>Accuracy</div>
                <div className="sub" style={{ fontWeight: 600, textAlign: 'right' }}>Total</div>
                <div></div>
                {snaps.map(s => (
                  <React.Fragment key={s.ts}>
                    <div className="sub">{new Date(s.ts).toLocaleString()} ({s.filters.range})</div>
                    <div className="sub" style={{ textAlign: 'right' }}>{(s.accuracy.rate * 100).toFixed(1)}%</div>
                    <div className="sub" style={{ textAlign: 'right' }}>{s.totals.byDay.reduce((a, [,n]) => a + n, 0)}</div>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="button secondary" onClick={() => download(`snapshot-${s.ts}.json`, 'application/json', JSON.stringify(s, null, 2))}>Export</button>
                      <button className="button secondary" onClick={() => deleteSnapshot(s.ts)}>Delete</button>
                    </div>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
