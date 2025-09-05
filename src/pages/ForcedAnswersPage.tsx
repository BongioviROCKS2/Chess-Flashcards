import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Chess } from 'chess.js';

declare global {
  interface Window {
    answers?: {
      readAll: () => Promise<Record<string, string | { move: string; pgn?: string }>>;
      saveAll: (map: Record<string, string | { move: string; pgn?: string }>) => Promise<boolean>;
    };
  }
}

type Row = { fen4: string; move: string };

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

function pgnToSanLine(pgn: string): string {
  const tokens = String(pgn || '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\$\d+/g, '')
    .replace(/\d+\.(\.\.)?/g, '')
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.join(' ');
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
  const [map, setMap] = useState<Record<string, string | { move: string; pgn?: string }>>({});
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
    return Object.entries(map).map(([fen4, mv]) => ({ fen4, move: (typeof mv === 'string' ? mv : (mv?.move || '')) }));
  }, [map]);

  const addOverride = async () => {
    setErr(null);
    const fen = fenFromInput(input);
    if (!fen) { setErr('Enter a valid FEN or PGN for the position.'); return; }
    const san = normalizeSAN(fen, move);
    if (!san) { setErr('Enter a legal SAN move from that position.'); return; }
    const fen4 = fen.split(/\s+/).slice(0, 4).join(' ');
    const trimmed = input.trim();
    // Treat as FEN if it looks like FEN (contains '/' ranks and has >= 4 fields); otherwise treat as PGN.
    const looksLikeFen = /\//.test(trimmed) && trimmed.split(/\s+/).length >= 4;
    const payload = looksLikeFen ? { move: san } : { move: san, pgn: pgnToSanLine(trimmed) };
    const next = { ...map, [fen4]: payload };
    setMap(next);
    setSaving(true);
    try { await window.answers?.saveAll?.(next); } catch {}
    setSaving(false);
    setInput('');
    setMove('');
  };

  async function archiveForFen4(fen4: string, includeDesc: boolean) {
    try {
      const all: any[] = (await (window as any).cards?.readAll?.()) || [];
      const fenKey = (fen: string) => (fen || '').split(/\s+/).slice(0,4).join(' ');
      const byId = new Map(all.map(c => [c.id, c]));
      const roots = all.filter(c => fenKey(c?.fields?.fen || '') === fen4);
      const ids: string[] = [];
      for (const r of roots) {
        ids.push(r.id);
        if (includeDesc) {
          const stack = [...(r.fields?.children || [])];
          const seen = new Set<string>();
          while (stack.length) {
            const id = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
            const node = byId.get(id);
            if (node && node.fields && Array.isArray(node.fields.children)) {
              for (const kid of node.fields.children) stack.push(kid);
            }
          }
        }
      }
      for (const id of ids) {
        const c = byId.get(id);
        if (!c) continue;
        const set = new Set([...(c.tags || []), 'Archived']);
        c.tags = Array.from(set);
        await (window as any).cards?.update?.(c);
      }
    } catch {}
  }

  const removeOverride = async (fen4: string, archiveMode: 'none' | 'archive' | 'archive+desc' = 'none') => {
    const next = { ...map } as any;
    delete next[fen4];
    setMap(next);
    setSaving(true);
    try {
      await window.answers?.saveAll?.(next);
      if (archiveMode !== 'none') {
        await archiveForFen4(fen4, archiveMode === 'archive+desc');
      }
    } catch {}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px 90px', gap: 8, padding: 8, background: 'var(--panel, #222)' }}>
              <div style={{ fontWeight: 600 }}>FEN (first 4 fields)</div>
              <div style={{ fontWeight: 600 }}>PGN (optional)</div>
              <div style={{ fontWeight: 600 }}>Move (SAN)</div>
              <div />
            </div>
            {Object.entries(map).map(([fen4, v]) => {
              const mv = (typeof v === 'string') ? v : (v?.move || '');
              const pgn = (typeof v === 'object') ? pgnToSanLine(v?.pgn || '') : '';
              return (
                <div key={fen4} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px 90px', gap: 8, padding: 8, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>{fen4}</div>
                  <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pgn}</div>
                  <div>{mv}</div>
                  <div style={{ position: 'relative' }}>
                    <details>
                      <summary className="button secondary" style={{ cursor: 'pointer' }}>Remove ▾</summary>
                      <div style={{ position: 'absolute', right: 0, background: 'var(--panel, #222)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 6, zIndex: 10, minWidth: 260 }}>
                        <button className="button" style={{ width: '100%', textAlign: 'left' }} disabled={saving} onClick={() => removeOverride(fen4, 'none')}>Remove Forced Answer</button>
                        <button className="button" style={{ width: '100%', textAlign: 'left', marginTop: 6 }} disabled={saving} onClick={() => removeOverride(fen4, 'archive')}>Remove & Archive Forced Answer</button>
                        <button className="button" style={{ width: '100%', textAlign: 'left', marginTop: 6 }} disabled={saving} onClick={() => removeOverride(fen4, 'archive+desc')}>Remove & Archive Forced Answer & Descendants</button>
                      </div>
                    </details>
                  </div>
                </div>
              );
            })}
            {!rows.length && (
              <div style={{ padding: 12, opacity: 0.8 }}>No overrides yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
