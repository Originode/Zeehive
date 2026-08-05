import React, { useCallback, useEffect, useState } from 'react';
import { getXellMessages, fetchCrew } from './api.js';
import { isManagerXell } from './hive/crew.js';

// MANAGER DIRECTIVES — the directive a manager was GIVEN, and the manager⇄worker conversation.
//
// The thing that tells one manager apart from another is its DIRECTIVE — the programme/brief a
// human typed when adding it (or the default manager brief). It is stored as the manager's task
// text (`xell.task_text` in the fleet read model) and read back here in full. Underneath sits the
// conversation around it: the directives the manager sends its workers (`zee say`, kind='directive')
// and the reports they send back (`zee report`, kind='report'/'reflection').
//
// For a MANAGER the panel also carries its CREW (CrewBody below) — one row per worker, and what
// that worker has actually PRODUCED. This is the human's copy of the read model the manager itself
// reads with `zee zees`, so the two never tell different stories about the same crew.
//
// It is READ-ONLY and marks NOTHING read. The agent's own `zee inbox` is the receipt; a human
// looking at the history must not clear an agent's unread flags. And it is an AUDIT, not a chat:
// there is no composer here — a human already talks to a zee through the flower's 📨 button.
const KIND_LABEL = {
  directive: '🐝 directive',
  report: '✉ report',
  reflection: '🪞 reflection',
  message: '✉ message',
};

const name = (slug) => slug || '(console)';

// The xell's OWN directive — what IT was told to do (for a manager, its programme; for a worker,
// the brief it was dispatched with). Full text, read-only.
export function DirectiveBlock({ directive }) {
  if (!directive || !String(directive).trim()) {
    return (
      <div className="dir-none" data-testid="dir-none">
        No directive on record — this xell has no task brief.
      </div>
    );
  }
  return (
    <div className="dir-directive" data-testid="dir-directive">{String(directive)}</div>
  );
}

// The pure conversation list — extracted so a test can render the rows without an effect (the fetch
// lives in the parent, exactly the split Board.jsx makes for its card). `xellId` marks which side of
// each row is THIS xell so direction (→ out / ← in) reads correctly.
export function DirectivesBody({ msgs, xellId }) {
  const list = msgs || [];
  const outgoing = new Set(list.filter((m) => m.from_xell_id === xellId).map((m) => m.id));
  if (list.length === 0) {
    return (
      <div className="disp-note" data-testid="dir-empty">
        No messages yet. A manager's <b>directives</b> to its workers (via <code>zee say</code>) and the
        workers' reports back (via <code>zee report</code>) appear here.
      </div>
    );
  }
  return (
    <ul className="dir-list" data-testid="dir-list">
      {list.map((m) => (
        <li key={m.id} className={`dir-row${outgoing.has(m.id) ? ' out' : ' in'}`}>
          <div className="dir-meta">
            <span className={`dir-kind dir-${m.kind}`} title={m.kind}>
              {KIND_LABEL[m.kind] || m.kind}
            </span>
            <span className="dir-dir" title={`${name(m.from)} → ${name(m.to)}`}>
              {outgoing.has(m.id) ? '→' : '←'} {outgoing.has(m.id) ? name(m.to) : name(m.from)}
            </span>
            <span className="dir-at" title={new Date(m.at).toISOString()}>
              {new Date(m.at).toLocaleString()}
            </span>
            {m.delivered
              ? <span className="dir-delivered" title="delivered into the recipient's live session">✓ delivered</span>
              : <span className="dir-undelivered" title="stored in the inbox, not delivered to a live session">stored</span>}
            {m.read_at && <span className="dir-read" title={`read by its zee at ${new Date(m.read_at).toLocaleString()}`}>read</span>}
          </div>
          <div className="dir-body">{m.body}</div>
        </li>
      ))}
    </ul>
  );
}

// ── WHAT EACH WORKER HAS PRODUCED ────────────────────────────────────────────
// The crew read model (`GET /api/xells/:id/crew`, the same rows `zee zees` hands the manager), for
// the human reading over the manager's shoulder. Status alone was misleading in exactly the way that
// costs an evening: a crew row's status and cost come from the `zee` row, written at TURN
// BOUNDARIES, so a worker mid-turn shows what it was doing last time. LANDINGS and the DIFF are
// measured when the row is read, so they are the two columns worth scanning.
//
// Pure, like DirectivesBody — the fetch lives in the parent, so this is rendered and read back in a
// test rather than eyeballed.
export function CrewBody({ crew }) {
  const rows = crew || [];
  if (!rows.length) {
    return (
      <div className="disp-note" data-testid="crew-empty">
        No live crew. A manager dispatches workers with <code>zee dispatch</code>; reaped ones are not listed.
      </div>
    );
  }
  return (
    <ul className="crew-list" data-testid="crew-list">
      {rows.map((c) => (
        <li key={c.xell_id} className="crew-row" data-testid="crew-row">
          <div className="crew-meta">
            <span className="crew-slug">{c.slug}</span>
            <span className="crew-status">{c.hive_status_label || c.status}</span>
            {c.branch && <span className="crew-branch">{c.branch}</span>}
          </div>
          <div className="crew-produced">
            {c.landings?.count
              ? (
                <span className="crew-landed" data-testid="crew-landed"
                      title={c.landings.landed_at ? `last landed ${new Date(c.landings.landed_at).toLocaleString()}` : ''}>
                  ⬆ landed {c.landings.count} × · last {String(c.landings.last_sha || '').slice(0, 8)}
                </span>
              )
              : <span className="crew-unlanded-none" data-testid="crew-nothing-landed">nothing landed yet</span>}
            {/* null diff = could not be measured (no worktree on disk, cxell unreachable). It must
                never render as 0/0, which reads as "it has produced nothing". */}
            {c.diff
              ? (
                <span className={`crew-diff${c.diff.ahead > 0 ? ' unlanded' : ''}`} data-testid="crew-diff">
                  ↑{c.diff.ahead} unlanded · {c.diff.dirty} dirty · +{c.diff.insertions}/−{c.diff.deletions}
                  <span className="crew-src"> ({c.diff.source})</span>
                </span>
              )
              : <span className="crew-diff-unknown" data-testid="crew-diff-unknown">diff not measurable</span>}
          </div>
          {c.waiting_on_human?.length > 0 && (
            <div className="crew-waiting" data-testid="crew-waiting">⚑ {c.waiting_on_human.join('; ')}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function Directives({ xell, onClose }) {
  const [msgs, setMsgs] = useState(null);   // null = loading
  const [crew, setCrew] = useState(null);   // null = loading / not a manager
  const [err, setErr] = useState(null);
  const manager = isManagerXell(xell);

  const load = useCallback(() => {
    setErr(null);
    getXellMessages(xell.id).then(setMsgs).catch((e) => setErr(e?.message || String(e)));
    // Only a manager HAS a crew — asking for a worker's would always answer [] and cost a git read
    // per worker on the server for nothing.
    if (manager) fetchCrew(xell.id).then(setCrew).catch((e) => setErr(e?.message || String(e)));
  }, [xell.id, manager]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // the directive is the xell's own task brief, carried on the fleet read model row (`task_text`)
  const directive = xell?.task_text || null;

  return (
    <div className="disp-overlay" onClick={onClose}>
      <div className="disp directives" role="dialog" aria-label="Manager directive"
           onClick={(e) => e.stopPropagation()}>
        <div className="disp-head">
          <span className="disp-title">🐝 {xell.slug} — directive</span>
          <button className="disp-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="disp-body">
          {err && <div className="disp-err" data-testid="dir-err">{err}</div>}

          <div className="disp-label">its directive — what this xell was told to do</div>
          <DirectiveBlock directive={directive} />

          {manager && (
            <>
              <div className="disp-label">crew — what each worker has PRODUCED</div>
              {!crew && !err && <div className="disp-note">reading the crew…</div>}
              {crew && <CrewBody crew={crew} />}
            </>
          )}

          <div className="disp-label">conversation — directives sent &amp; reports back</div>
          {!msgs && !err && <div className="disp-note">reading the conversation…</div>}
          {msgs && <DirectivesBody msgs={msgs} xellId={xell.id} />}
        </div>

        <div className="disp-foot">
          <span className="disp-hint">Read-only audit — this marks nothing read. Only the zee's own <code>zee inbox</code> clears its unread flags.</span>
          <button className="disp-cancel" data-testid="dir-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
