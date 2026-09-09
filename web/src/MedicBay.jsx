import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getMedic, retireMedic, messageMedic } from './api.js';
import { hexCorners } from './hive/hex.js';
import { showConfirm } from './Dialog.jsx';

// ── THE MEDIC BAY — the medics' OWN surface (docs/medic-meta-plane-plan.md §5, DR-7) ─────────────
//
// A medic is NOT a xell: no worktree, no cage, no containers — so it has no place in the honeycomb,
// which renders xell rows. This strip is where medics live instead: one hexagon per medic (the
// fleet's visual language, its own row), and an expandable panel with the three things a human
// needs about an agent that writes the meta-DB directly:
//
//   • the ACTION LEDGER — every write, verbatim SQL, rows affected (medic_action; the medic's own
//     postgres role holds no grant on that table, so what you read here is the driver's record,
//     not the agent's account of itself);
//   • the TRANSCRIPT — the conversation, replayed from zee_conversation keyed by medic (245);
//   • the ASK — an awaiting-human medic's one-line reason, with the reply box that resumes it.
//
// The pane hides itself when there are no medic rows: most of the time there is nothing to say,
// and an empty always-on strip would train eyes to skip it.
//
// The LIST arrives as a prop (App owns it, refreshed on 'medic'/'medic-action' stream events); the
// DETAIL is fetched here on expand and re-fetched while open via `bump` — the ledger and
// transcript of a background turn grow while you watch.

// The hexes are painted from data — this palette is the whole meaning of a medic's colour
// (styles.css only carries the chrome). awaiting-human is the loudest: it is the one state that
// exists to be seen.
export const MEDIC_COLORS = {
  'diagnosing':        { fill: '#e0a53a', label: 'diagnosing',    why: 'reading the evidence' },
  'acting':            { fill: '#4aa3df', label: 'acting',        why: 'writing config fixes on its GRANT-scoped role' },
  'awaiting-human':    { fill: '#e5554e', label: 'needs you',     why: 'asked a human a question — open to answer it' },
  'worker-dispatched': { fill: '#9a6fd8', label: 'worker out',    why: 'dispatched a Zeehive worker for a code fault' },
  'converged':         { fill: '#39b876', label: 'converged',     why: 'the pair proves green again' },
  'retired':           { fill: '#8a8f98', label: 'retired',       why: 'retired — the ledger remains' },
  'errored':           { fill: '#b23c3c', label: 'errored',       why: 'its turn errored — open for the stop reason' },
};
const artOf = (m) => MEDIC_COLORS[m?.status] || MEDIC_COLORS.diagnosing;

function MedicHex({ medic, active, onClick }) {
  const size = 26; const cx = 30; const cy = 32;
  const art = artOf(medic);
  const pts = hexCorners(cx, cy, size).map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <svg width="60" height="64" className="medic-hex" role="button" tabIndex={0}
         style={{ cursor: 'pointer' }} data-testid="medic-hex"
         onClick={onClick} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <title>{`⛑ medic on ${medic.target_project_name || '?'} — ${art.label} (${art.why})`}</title>
      <polygon points={pts} fill={art.fill} fillOpacity={active ? 0.85 : 0.55}
               stroke={art.fill} strokeWidth={active ? 3 : 2} />
      <text className="medic-hex-t" x={cx} y={cy - 1} textAnchor="middle">⛑</text>
      <text className="medic-hex-s" x={cx} y={cy + 14} textAnchor="middle">
        {String(medic.target_project_name || '').slice(0, 9)}
      </text>
    </svg>
  );
}

export default function MedicBay({ medics = [], onChanged, bump = 0, onOpenXell = null }) {
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('ledger');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const openIdRef = useRef(openId);
  openIdRef.current = openId;

  const loadDetail = useCallback(async (id) => {
    if (!id) return setDetail(null);
    try {
      const d = await getMedic(id);
      if (openIdRef.current === id) { setDetail(d); setErr(null); }
    } catch (e) { if (openIdRef.current === id) setErr(e?.message || String(e)); }
  }, []);
  useEffect(() => { loadDetail(openId); }, [openId, bump, loadDetail]);

  if (!medics.length) return null;
  const asking = medics.filter((m) => m.status === 'awaiting-human').length;
  const open = detail?.medic && detail.medic.id === openId ? detail : null;

  const doRetire = async () => {
    if (!open) return;
    if (!(await showConfirm('Retire this medic?\n\nIts loop stops being resumable; the action ledger '
      + 'and transcript are kept. A fresh medic can always be dispatched from the condition.',
      { okLabel: 'Retire' }))) return;
    setBusy(true);
    try { await retireMedic(open.medic.id); setOpenId(null); onChanged?.(); }
    catch (e) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const doReply = async () => {
    const text = reply.trim();
    if (!open || !text || busy) return;
    setBusy(true);
    try { await messageMedic(open.medic.id, text); setReply(''); onChanged?.(); loadDetail(open.medic.id); }
    catch (e) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="medic-bay" data-testid="medic-bay">
      <div className="medic-bay-head">
        <span className="medic-bay-t">⛑ Medic Bay</span>
        <span className="medic-bay-n">{medics.length} medic{medics.length === 1 ? '' : 's'}</span>
        {asking > 0 && <span className="medic-bay-ask">· {asking} waiting on you</span>}
        <span className="medic-bay-note"
              title={'A medic is not a zee in a xell: it runs on the meta plane (the queenzee\'s own '
                + 'process), reads the whole meta-DB, writes config rows on a GRANT-scoped postgres '
                + 'role, sees the Zeehive source read-only, and dispatches a real worker only when '
                + 'ZEEHIVE CODE must change. That is why there is no hexagon for it in the honeycomb.'}>
          meta plane — not in the honeycomb</span>
      </div>
      <div className="medic-hexes">
        {medics.map((m) => (
          <MedicHex key={m.id} medic={m} active={m.id === openId}
                    onClick={() => { setTab('ledger'); setOpenId(m.id === openId ? null : m.id); }} />
        ))}
      </div>
      {err && openId && <div className="medic-err">{err}</div>}
      {open && (() => {
        const art = artOf(open.medic);
        return (
          <div className="medic-panel" data-testid="medic-panel">
            <div className="medic-panel-head">
              <span className="medic-dot" style={{ background: art.fill }} />
              <b>medic on {open.medic.target_project_name}</b>
              <span className="medic-state" style={{ color: art.fill }}>{art.label}</span>
              <span className="medic-when">{new Date(open.medic.created_at).toLocaleString()}</span>
              {open.medic.status !== 'retired' && (
                <button type="button" className="pill ghost" disabled={busy} onClick={doRetire}
                        title="Retire this medic — the ledger and transcript are kept">retire</button>
              )}
            </div>
            {open.medic.status === 'awaiting-human' && (
              <div className="medic-asking" data-testid="medic-asking">
                <span className="medic-asking-why">
                  <b>needs you:</b> {open.medic.needs_human_reason || '(no reason recorded)'}
                </span>
                <textarea className="medic-reply" rows={2} value={reply} disabled={busy}
                          placeholder="your answer — it becomes the medic's next turn"
                          onChange={(e) => setReply(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doReply(); } }} />
                <button type="button" className="pill" style={{ marginLeft: 0, alignSelf: 'flex-start' }}
                        disabled={busy || !reply.trim()} onClick={doReply}>answer — resume the medic</button>
              </div>
            )}
            <details className="medic-brief"><summary className="medic-note">the dispatch brief</summary>
              <pre>{open.medic.brief}</pre>
            </details>
            <div className="medic-tabs">
              <button type="button" className={`pill ${tab === 'ledger' ? 'on' : 'ghost'}`}
                      onClick={() => setTab('ledger')}
                      title="Every act the medic performed — recorded by the driver BEFORE it ran; the medic's own role holds no grant on this ledger">
                ledger ({open.actions.length})</button>
              <button type="button" className={`pill ${tab === 'transcript' ? 'on' : 'ghost'}`}
                      onClick={() => setTab('transcript')}>transcript ({open.transcript.length})</button>
            </div>
            {tab === 'ledger' && (
              open.actions.length === 0
                ? <div className="medic-empty">no acts yet — reading is free and unrecorded</div>
                : (
                  <ul className="medic-ledger" data-testid="medic-ledger">
                    {open.actions.map((a) => {
                      const refused = a.result && (a.result.refused || a.result.ok === false);
                      return (
                        <li key={a.id} className={`medic-act${refused ? ' refused' : ''}`}>
                          <div className="medic-act-head">
                            <b>{a.tool}</b>
                            {a.tables?.length > 0 && <span className="medic-act-tables"> · {a.tables.join(', ')}</span>}
                            {a.rows_affected != null && <span className="medic-act-rows"> · {a.rows_affected} row(s)</span>}
                            <span className="medic-act-when"> · {new Date(a.created_at).toLocaleTimeString()}</span>
                          </div>
                          <pre className="medic-act-sql">{a.statement}</pre>
                          {refused && <div className="medic-act-refused">REFUSED — {a.result.reason || 'see the result'}</div>}
                        </li>
                      );
                    })}
                  </ul>
                )
            )}
            {tab === 'transcript' && (
              <div className="medic-transcript" data-testid="medic-transcript">
                {open.transcript.length === 0 && <div className="medic-empty">no turns yet</div>}
                {open.transcript.map((t) => (
                  <div key={t.seq} className={`medic-msg ${t.role}`}>
                    <span className="medic-msg-role">{t.role}{t.name ? `:${t.name}` : ''}</span>
                    <span className="medic-msg-text">{t.content}</span>
                  </div>
                ))}
              </div>
            )}
            {open.workers.length > 0 && (
              <div className="medic-workers">
                <span className="medic-note">dispatched workers:</span>
                {open.workers.map((w) => (
                  <span key={w.id} className="medic-card">
                    {w.title} — {w.status}
                    {w.xell_id && (
                      // The worker IS a real xell — the jump opens its hexagon in the honeycomb,
                      // because a worker's life (turns, landing, gates) is a xell story, not a Bay one.
                      <button type="button" className="pill ghost" style={{ marginLeft: 6 }}
                              onClick={() => onOpenXell?.(w.xell_id)}
                              title="Open this worker's hexagon in the honeycomb">
                        {w.xell_slug || String(w.xell_id).slice(0, 8)} ↗</button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {open.cards.length > 0 && (
              <div className="medic-cards">
                <span className="medic-note">human-gated cards on {open.medic.target_project_name}:</span>
                {open.cards.map((c) => (
                  <span key={c.id} className={`medic-card${c.status === 'pending' ? ' pending' : ''}`}>
                    {c.kind} — {c.status}
                    {c.status === 'pending' && <span className="medic-gate"> · a human decides, not the medic</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
