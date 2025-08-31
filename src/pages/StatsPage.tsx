import { useNavigate } from 'react-router-dom';
import { useBackKeybind } from '../hooks/useBackKeybind';
import React, { useMemo, useState } from 'react';

type Grade = 'again' | 'hard' | 'good' | 'easy';
type Entry = { id: string; grade: Grade; ts: number };
const LOG_KEY = 'chessflashcards.reviewLog.v1';

function loadLog(): Entry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr as Entry[] : [];
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

  const [_, setBump] = useState(0);
  const bump = () => setBump(v => v + 1);

  const log = useMemo(() => loadLog(), [_]);

  const totals = useMemo(() => {
    const byDay = new Map<string, number>();
    const byGrade: Record<Grade, number> = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const e of log) {
      const k = dayKey(e.ts);
      byDay.set(k, (byDay.get(k) || 0) + 1);
      byGrade[e.grade]++;
    }
    const recent = Array.from(byDay.entries())
      .sort((a,b) => a[0].localeCompare(b[0]))
      .slice(-7);
    return { byDay: recent, byGrade };
  }, [log]);

  const clear = () => { try { localStorage.removeItem(LOG_KEY); } catch {}; bump(); };

  return (
    <div className="container">
      <div className="card grid">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Stats</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="button secondary" onClick={clear} title="Clear review log">Clear</button>
            <button className="button secondary" onClick={onBack}>Back</button>
          </div>
        </div>

        <div className="grid" style={{ padding: 8, gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Last 7 Days</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              {totals.byDay.length === 0 ? (
                <div className="sub">No reviews yet.</div>
              ) : (
                totals.byDay.map(([day, count]) => (
                  <div key={day} style={{ textAlign: 'center' }}>
                    <div style={{ background: 'var(--accent)', width: 24, height: Math.max(4, count * 6), borderRadius: 4 }} />
                    <div className="sub" style={{ marginTop: 4, whiteSpace: 'nowrap' }}>{day}</div>
                    <div className="sub">{count}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
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
        </div>
      </div>
    </div>
  );
}
