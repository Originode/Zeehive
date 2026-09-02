import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getMedic, retireMedic, messageMedic } from './api.js';
import { hexCorners } from './hive/hex.js';
import { showConfirm } from './Dialog.jsx';

// ── THE MEDIC BAY — the medics' OWN surface (docs/medic-meta-plane-plan.md §5, DR-7) ─────────────
//
// A medic is NOT a xell: it has no worktree, no cage, no containers — so it has no place in the
// honeycomb, which renders xell rows. This pane is where medics live instead: one hexagon per live
// medic (the fleet's visual language, its own strip), and a detail panel with the three things a
// human needs about an agent that writes the meta-DB directly:
//
//   • the ACTION LEDGER — every write, verbatim SQL, rows affected (medic_action; the medic's own
//     role holds no grant on that table, so what you read here is the driver's record, not the
//     agent's account of itself);
//   • the TRANSCRIPT — the conversation, replayed from zee_conversation keyed by medic;
//   • the ASK — an awaiting-human medic's one-line reason, with the reply box that resumes it.
//
// The pane hides itself when there are no medic rows: most of the time there is nothing to say,
// and an empty always-on strip would train eyes to skip it.
//
// The medics LIST arrives as a prop (App owns it, refreshed on 'medic'/'medic-action' stream
// events); the DETAIL is fetched here on expand and re-fetched while open on the same events via
// `bump` — the transcript of a running turn grows in the background.

const STATUS_ART = {
  'diagnosing': { color: '#d9a514', label: 'diagnosing', title: 'reading the evidence' },
  'acting': { color: '#3f8cd8', label: 'acting', title: 'writing config fixes' },
  'awaiting-human': { color: '#e05252', label: 'needs you', title: 'asked a human a question — open to answer' },
  'worker-dispatched': { color: '#9a6fd8', label: 'worker out', title: 'dispatched a Zeehive worker for a code fault' },
  'converged': { color: '#4caf7d', label: 'converged', title: 'the pair proves green' },
  'retired': { color: '#8a8f98', label: 'retired', title: 'retired — the ledger remains' },
  'errored': { color: '#b23c3c', label: 'errored', title: 'its turn errored — open for the stop reason' },
};

function MedicHex({ medic, active, onClick }) {
  const size = 26;
  const cx = 30; const cy = 30;
  const art = STATUS_ART[medic.status] || STATUS_ART.diagnosing;
  const pts = hexCorners(cx, cy, size).map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <svg width="60" height="60" className={`medic-hex ${active ? 'active' : ''} ${medic.status === 'awaiting-human' ? 'pulse' : ''}`}
         role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => e.key === 'Enter' && onClick()}
         title={`⛑ medic on ${medic.target_project_name} — ${art.label} (${art.title})`}
         data-testid="medic-hex">
      <polygon points={pts} fill={art.color} fillOpacity="0.22" stroke={art.color} strokeWidth="2" />
      <text x={cx} y={cy - 3} textAnchor="middle" fontSize="16">⛑</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="8" fill="currentColor" opacity="0.8">
        {String(medic.target_project_name || '').slice(0, 9)}
      </text>
    </svg>
  );
}

export default function MedicBay({ medics = [], onChanged, bump = 0, onOpenXell = null }) {
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const openIdRef = useRef(openId);
  openIdRef.current = openId;

  const loadDetail = useCallback(async (id) => {
    if (!id) return setDetail(null);
    try {
      const d = await getMedic(id);
      if (openIdRef.current === id) setDetail(d);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => { loadDetail(openId); }, [openId, bump, loadDetail]);

  if (!medics.length) return null;
  const open = detail?.medic && detail.medic.id === openId ? detail : null;
  const art = open ? (STATUS_ART[open.medic.status] || STATUS_ART.diagnosing) : null;

  const doRetire = async () => {
    if (!open) return;
    if (!(await showConfirm('Retire this medic?\n\nIts loop stops being resumable; the action ledger and '
      + 'transcript are kept. A fresh medic can always be dispatched from the condition.', { okLabel: 'Retire' }))) return;
    setBusy(true);
    try { await retireMedic(open.medic.id); setOpenId(null); onChanged?.(); } finally { setBusy(false); }
  };
  const doReply = async () => {
    const text = reply.trim();
    if (!open || !text) return;
    setBusy(true);
    try { await messageMedic(open.medic.id, text); setReply(''); onChanged?.(); } finally { setBusy(false); }
  };

  return (
    <div className="medic-bay" data-testid="medic-bay">
      <div className="medic-bay-strip">
        <span className="medic-bay-title" title={'The Medic Bay — meta-plane medics. A medic is not a xell: '
          + 'no cage, no containers, no hexagon in the honeycomb. It reads the whole meta-DB, fixes config '
          + 'on its own GRANT-scoped role, and every write lands in the ledger below.'}>⛑ Medic Bay</span>
        {medics.map((m) => (
          <MedicHex key={m.id} medic={m} active={m.id === openId}
                    onClick={() => setOpenId(m.id === openId ? null : m.id)} />
        ))}
      </div>
      {open && (
        <div className="medic-detail" data-testid="medic-detail">
          <div className="medic-detail-head">
            <b>⛑ medic on {open.medic.target_project_name}</b>
            <span className="medic-status" style={{ color: art.color }}> {art.label}</span>
            <button type="button" className="medic-retire" disabled={busy} onClick={doRetire}
                    title="Retire this medic (the ledger and transcript are kept)">retire</button>
            <button type="button" className="medic-close" onClick={() => setOpenId(null)}>×</button>
          </div>
          {open.medic.status === 'awaiting-human' && (
            <div className="medic-ask" data-testid="medic-ask">
              <b>needs you:</b> {open.medic.needs_human_reason || '(no reason recorded)'}
              <div className="medic-reply">
                <input value={reply} onChange={(e) => setReply(e.target.value)} disabled={busy}
                       placeholder="your answer — it becomes the medic's next turn"
                       onKeyDown={(e) => e.key === 'Enter' && doReply()} />
                <button type="button" disabled={busy || !reply.trim()} onClick={doReply}>answer</button>
              </div>
            </div>
          )}
          <details className="medic-brief"><summary>the dispatch brief</summary>
            <pre>{open.medic.brief}</pre>
          </details>
          <div className="medic-columns">
            <div className="medic-actions">
              <div className="medic-col-title" title={'Every write the medic performed, recorded by the driver '
                + 'BEFORE it ran — the medic\'s own role holds no grant on this ledger.'}>
                action ledger ({open.actions.length})</div>
              {open.actions.length === 0 && <div className="sub">no writes yet — reading is free</div>}
              {open.actions.map((a) => (
                <div key={a.id} className="medic-action-row">
                  <span className="medic-action-tool">{a.tool}</span>
                  <code className="medic-action-sql">{a.statement}</code>
                  <span className="sub">{a.rows_affected != null ? `${a.rows_affected} row(s)` : ''}
                    {a.result && a.result.refused ? ' · REFUSED' : ''}</span>
                </div>
              ))}
            </div>
            <div className="medic-transcript">
              <div className="medic-col-title">transcript ({open.transcript.length})</div>
              {open.transcript.map((t) => (
                <div key={t.seq} className={`medic-msg medic-msg-${t.role}`}>
                  <span className="medic-msg-role">{t.role}{t.name ? `:${t.name}` : ''}</span>
                  <span className="medic-msg-text">{t.content}</span>
                </div>
              ))}
            </div>
          </div>
          {open.workers.length > 0 && (
            <div className="medic-workers">
              <div className="medic-col-title">dispatched workers</div>
              {open.workers.map((w) => (
                <div key={w.id} className="sub">
                  {w.title} — {w.status}
                  {w.xell_id ? (
                    // The worker is a REAL xell — the jump opens its hexagon in the honeycomb,
                    // because the worker's life (turns, landing, gates) is a xell story, not a Bay one.
                    <button type="button" className="medic-worker-jump"
                            onClick={() => onOpenXell?.(w.xell_id)}
                            title="Open this worker's hexagon in the honeycomb">
                      · xell {w.xell_slug || String(w.xell_id).slice(0, 8)} ↗
                    </button>
                  ) : ''}
                </div>
              ))}
            </div>
          )}
          {open.cards.length > 0 && (
            <div className="medic-cards">
              <div className="medic-col-title">open human-gated cards on {open.medic.target_project_name}</div>
              {open.cards.map((c) => (
                <div key={c.id} className="sub">{c.kind} — {c.status}{c.reason ? ` · ${c.reason}` : ''}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
