import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Chess } from 'chess.js';

declare global {
  interface Window {
    answers?: {
      readAll: () => Promise<Record<string, string>>;
      saveAll: (map: Record<string, string>) => Promise<boolean>;
    };
  }
}

type Row = { fen: string; move: string };

function normalizeSAN(fen: string, move: string): string | null {
  try {
    const chess = new Chess(fen);
    const mv = chess.move(move, { sloppy: true } as any);
    if (!mv) return null;
    return mv.san; // normalized SAN
  } catch {
    return null;
  }
}

function fenFromInput(input: string): string | null {
  const s = (input || '').trim();
  if (!s) return null;
  // Try FEN first
  if (s.split(' ').length >= 4 && s.includes('/')) {
    try { const chess = new Chess(); chess.load(s); return chess.fen(); } catch {}
  }
  // Try PGN -> FEN
  try {
    const chess = new Chess();
    const tokens = s
      .replace(/\{[^}]*\}/g, '')
      .replace(/\$\d+/g, '')
      .replace(/\d+\.(\.\.)?/g, '')
      .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const t of tokens) {
      const mv = chess.move(t, { sloppy: true } as any);
      if (!mv) return null;
    }
    return chess.fen();
  } catch {
    return null;
  }
}

export default function ForcedAnswersPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [map, setMap] = useState<Record<string, string>>({});
  const [input, setInput] = useState('');
  const [move, setMove] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cur = await window.answers?.readAll?.();
        setMap((cur && typeof cur === 'object') ? cur as any : {});
      } catch {}
    })();
  }, []);

  const rows: Row[] = useMemo(() => {
    return Object.entries(map).map(([fen, mv]) => ({ fen, move: mv }));
  }, [map]);

  const addOverride = async () => {
    setErr(null);
    const fen = fenFromInput(input);
    if (!fen) { setErr('Enter a valid FEN or PGN for the position.'); return; }
    const san = normalizeSAN(fen, move);
    if (!san) { setErr('Enter a legal SAN move from that position.'); return; }
    const next = { ...map, [fen]: san };
    setMap(next);
    setSaving(true);
    try { await window.answers?.saveAll?.(next); } catch {}
    setSaving(false);
    setInput('');
    setMove('');
  };

  const removeOverride = async (fen: string) => {
    const next = { ...map };
    delete next[fen];
    setMap(next);
    setSaving(true);
    try { await window.answers?.saveAll?.(next); } catch {}
    setSaving(false);
  };

  return (
    <div className="container">
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Forced Answers</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="button secondary" onClick={() => navigate(-1)}>
              Back
            </button>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Add or Update</div>
          <div className="row" style={{ display: 'grid', gridTemplateColumns: '1fr 220px 120px', gap: 10, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="FEN or PGN"
              value={input}
              onChange={e => setInput(e.currentTarget.value)}
              style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            />
            <input
              type="text"
              placeholder="Forced move (SAN) e.g., d4"
              value={move}
              onChange={e => setMove(e.currentTarget.value)}
              style={{ backgroundColor: '#ffffff', color: '#000000', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '6px 8px' }}
            />
            <button className="button" onClick={addOverride} disabled={saving}>Save</button>
          </div>
          {err && <div style={{ color: 'var(--danger, #d33)', marginTop: 8 }}>{err}</div>}
        </div>

        <div style={{ marginTop: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Overrides</div>
          <div style={{ maxHeight: 380, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px 90px', gap: 8, padding: 8, background: 'var(--panel, #222)' }}>
              <div style={{ fontWeight: 600 }}>FEN</div>
              <div style={{ fontWeight: 600 }}>Move (SAN)</div>
              <div />
            </div>
            {rows.map((r) => (
              <div key={r.fen} style={{ display: 'grid', gridTemplateColumns: '1fr 200px 90px', gap: 8, padding: 8, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>{r.fen}</div>
                <div>{r.move}</div>
                <div>
                  <button className="button secondary" onClick={() => removeOverride(r.fen)} disabled={saving}>Remove</button>
                </div>
              </div>
            ))}
            {!rows.length && (
              <div style={{ padding: 12, opacity: 0.8 }}>No overrides yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

