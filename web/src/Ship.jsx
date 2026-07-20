// SHIP GATE — production ship requests, and the prod lock's countdown.
//
// Two things live here, both human-only:
//   1. A zee has asked to ship to PRODUCTION. Approving is the single most consequential click in
//      this app, so the card shows exactly what commit ships and from where.
//   2. After a ship, the queenzee holds prod and counts down to auto-release. Silence must mean
//      "let it go" — an unattended hold blocks every other xell. HOLD stops the clock for a human
//      who is actively verifying.
import React, { useState, useEffect, useRef } from 'react';
import { decideShip, dismissShip, holdProdLock, forceReleaseProdLock, getSites } from './api.js';
import { showAlert } from './Dialog.jsx';

const short = (s) => (s ? String(s).slice(0, 8) : '—');

// ONE force-release path, shared by the padlock badge and the countdown bar's "Release now".
// Same act → same words. Two different confirmations for one consequential click is how a human
// learns to skim past the one that matters. The warning escalates when the lock is HELD: a
// countdown release only skips a wait that was going to happen anyway, but releasing a HELD lock
// cuts off a human who deliberately stopped the clock to verify prod.
function confirmForceRelease(lock) {
  return confirm(
    `Force-release the production lock from ${lock.xell_slug}?\n\n`
    + `${lock.held ? 'It is being HELD open by a human — someone may be verifying prod right now.\n\n' : ''}`
    + `Prod becomes free for another xell to ship immediately.`);
}
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// What the ship actually DID, step by step — migrations first, then each container build — with
// the captured build log behind a disclosure. This is the human's post-hoc window: the live feed
// scrolls by in the ▚ terminal, but the record here survives (15 min on the card, forever on the
// ship_request row).
function ShipResults({ results }) {
  if (!Array.isArray(results) || !results.length) return null;
  return (
    <div className="ship-results">
      {results.map((r, i) => (
        <div key={i} className={`ship-step ${r.ok ? 'ok' : 'bad'}`}>
          <span className="ship-step-head">
            {r.ok ? '✓' : '✗'} {r.role || r.container || 'step'}
            {r.method ? <span className="ship-step-meta"> · {r.method}</span> : null}
            {r.applied?.length ? <span className="ship-step-meta"> · applied {r.applied.join(', ')}</span> : null}
          </span>
          {r.error && <div className="land-err">{r.error}</div>}
          {r.log && (
            <details className="ship-log">
              <summary>build log ({Math.max(1, Math.round(r.log.length / 1024))} KB)</summary>
              <pre>{r.log}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

// The ship's OWN build feed, live while it deploys — its lane, not the shared terminal's
// firehose. Follows the tail unless the human scrolls up to read something.
function LiveBuildLog({ lines }) {
  const boxRef = useRef(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = boxRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  if (!lines?.length) return null;
  const onScroll = () => {
    const el = boxRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return (
    <pre className="ship-live" ref={boxRef} onScroll={onScroll} data-testid="ship-live-log">
      {lines.map((l) => `[${l.role}] ${l.line}`).join('\n')}
    </pre>
  );
}

function ShipCard({ req, live, prodSites, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pending = req.status === 'pending';
  // WHERE this ship deploys. One production → nothing to choose, it ships there (the recorded
  // site). More than one → a human picks in THIS dialog, defaulting to the request's recorded
  // site (the project default) — approving with a different pick re-aims the ship, and the server
  // re-resolves its migrations against the chosen site's ledger.
  const sites = prodSites || [];
  const defaultSiteId = req.site_id || sites.find((s) => s.is_default)?.id || sites[0]?.id || null;
  const [siteId, setSiteId] = useState(defaultSiteId);
  useEffect(() => { setSiteId(defaultSiteId); }, [defaultSiteId]);
  const chosen = sites.find((s) => s.id === siteId) || null;
  const siteName = chosen?.key || req.site_key || null;

  const decide = async (decision) => {
    if (decision === 'approve' && !confirm(
      `Ship ${short(req.commit)} to PRODUCTION${siteName ? ` @ ${siteName}` : ''}?\n\n`
      + `The queenzee will take the prod lock and deploy it from main — this is real production.\n\n`
      + `Requested by: ${req.xell_slug}\n${req.reason ? `Reason: ${req.reason}\n` : ''}`)) return;
    if (decision === 'reject' && !confirm(`Reject this ship request from ${req.xell_slug}?`)) return;
    setBusy(true); setErr(null);
    try { await decideShip(req.id, decision, undefined, decision === 'approve' ? siteId || undefined : undefined); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className={`ship-card s-${req.status}`}>
      <div className="land-head">
        <span className="land-what">
          <b>{req.xell_slug}</b> wants to ship <b>{short(req.commit)}</b> to{' '}
          <b>PRODUCTION{!pending && siteName ? ` @ ${siteName}` : ''}</b>
        </span>
        <span className="land-meta">{req.status}</span>
        {(req.status === 'shipped' || req.status === 'failed') && (
          <button className="drawer-close ship-dismiss" title="Dismiss this notification"
                  onClick={async () => { await dismissShip(req.id); onDone?.(); }}>✕</button>
        )}
      </div>
      {pending && sites.length > 1 && (
        <div className="ship-target" data-testid="ship-target">
          <span className="k">deploy to:</span>
          <select value={siteId || ''} disabled={busy} onChange={(e) => setSiteId(e.target.value)}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.key}{s.is_default ? ' (default)' : ''} — {s.docker_ctx}{s.host ? ` @ ${s.host}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {req.reason && <div className="ship-reason">“{req.reason}”</div>}
      {/* Names the sha, not just "main". This line used to promise "builds from main in the xource"
          while the build took whatever that shared checkout was parked at — for a long while, 542
          commits behind. What it names now is exactly what ship-prod.sh checks out. */}
      <div className="land-stat">
        builds local <b>main</b> @ <b>{short(req.commit)}</b> — not the xell's worktree, not origin
      </div>
      {/* DB scope + the zee's drift assessment — the human approves the SCOPE and the REASONING,
          not a bare green tick. A code-only ship says what it deliberately will not run. */}
      {req.skip_migrations && (
        <div className="ship-dbscope" data-testid="ship-dbscope">
          ⚠ db scope: code only — {Array.isArray(req.migrations) && req.migrations.length
            ? `${req.migrations.length} pending sql file(s) will NOT be applied`
            : 'pending sql files (if any) will NOT be applied'}
        </div>
      )}
      {req.db_note && (
        <div className="ship-dbnote" data-testid="ship-dbnote"
             title="The zee diagnosed its schema drift against the drift detail and judged it non-breaking — this is its reasoning.">
          zee's drift assessment: “{req.db_note}”
        </div>
      )}
      {req.status === 'shipping' && (
        <div className="ship-progress">
          ⟳ queenzee is deploying — it holds the prod lock.
          {!live?.length && ' Build output appears here as it streams.'}
        </div>
      )}
      {req.status === 'shipping' && <LiveBuildLog lines={live} />}
      {req.status === 'approved' && <div className="ship-progress">✓ approved — queenzee is taking the prod lock…</div>}
      {req.status === 'shipped' && <div className="ship-progress done">★ LIVE — shipped {req.finished_at ? `at ${new Date(req.finished_at).toLocaleTimeString()}` : ''}</div>}
      {req.status === 'failed' && <div className="land-err">✗ ship FAILED{req.error ? `: ${req.error}` : ''}</div>}
      <ShipResults results={req.containers} />
      {err && <div className="land-err">{err}</div>}
      {pending && (
        <div className="land-actions">
          <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          <button className="ship-approve" disabled={busy} onClick={() => decide('approve')}>
            {busy ? '…' : 'Approve → ship to prod'}
          </button>
        </div>
      )}
    </div>
  );
}

// The countdown + Hold prompt. Ticks locally off auto_release_at; the queenzee is the one that
// actually releases (this is a view of its timer, not the timer itself).
function LockCountdown({ lock, projectId, onChanged }) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!lock?.auto_release_at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lock?.auto_release_at]);

  if (!lock) return null;
  const left = lock.auto_release_at ? new Date(lock.auto_release_at).getTime() - now : null;

  const hold = async () => {
    setBusy(true);
    try { await holdProdLock(projectId); onChanged?.(); } catch (e) { showAlert(e.message, { variant: 'error' }); }
    finally { setBusy(false); }
  };

  // Release now — the other half of the decision the countdown poses. Without it the only options
  // were "wait out the clock" or "go hunt for the padlock on the xell's card", which is the same
  // act two screens away from where it is being asked about.
  const release = async () => {
    if (!confirmForceRelease(lock)) return;
    setBusy(true);
    try { await forceReleaseProdLock(projectId); onChanged?.(); } catch (e) { showAlert(e.message, { variant: 'error' }); }
    finally { setBusy(false); }
  };

  if (lock.held) {
    // A HELD lock has no countdown to wait out — it blocks every other xell until someone acts.
    // So this is the state that most needs the button, not the one that least needs it.
    return (
      <div className="lock-bar held">
        🔒 <b>{lock.xell_slug}</b> is holding the production lock — countdown cancelled, it will not
        auto-release.
        <button className="lock-release" data-testid="lock-release-held"
                disabled={busy} onClick={release}>{busy ? '…' : 'Release now'}</button>
      </div>
    );
  }
  if (left == null) return null;
  return (
    <div className="lock-bar">
      🔒 <b>{lock.xell_slug}</b> holds production · releasing in <b className="lock-clock">{mmss(left)}</b>
      <span className="lock-q"> — still verifying? Hold it and the countdown stops.</span>
      <button className="lock-hold" disabled={busy} onClick={hold}>{busy ? '…' : 'Hold the lock'}</button>
      <button className="lock-release" data-testid="lock-release"
              disabled={busy} onClick={release}>{busy ? '…' : 'Release now'}</button>
    </div>
  );
}

export default function ShipPanel({ shipping, prodLock, shipLogs, projectId, onDecided }) {
  const open = shipping || [];
  // The project's prod sites — the approve dialog's target choices. Loaded once per project and
  // only while something is actually open (no ships → no fetch).
  const [prodSites, setProdSites] = useState([]);
  useEffect(() => {
    if (!open.length || !projectId) return;
    let live = true;
    getSites(projectId).then((ss) => { if (live) setProdSites((ss || []).filter((s) => s.tier === 'prod')); })
      .catch(() => { /* picker simply doesn't render */ });
    return () => { live = false; };
  }, [projectId, open.length]);
  if (!open.length && !prodLock) return null;
  const pending = open.filter((s) => s.status === 'pending').length;
  return (
    <section className={`ship-panel${pending ? ' urgent' : ''}`}>
      <div className="ship-title">
        {pending
          ? `⚠ ${pending} PRODUCTION ship${pending === 1 ? '' : 's'} awaiting your approval`
          : '⇪ production'}
      </div>
      <LockCountdown lock={prodLock} projectId={projectId} onChanged={onDecided} />
      {open.map((s) => <ShipCard key={s.id} req={s} live={shipLogs?.[s.id]} prodSites={prodSites} onDone={onDecided} />)}
    </section>
  );
}

// The padlock badge on whichever xell holds prod. Hover swaps to an unlock icon; clicking asks
// before taking prod back — a force release while a human is mid-verification is disruptive.
export function LockBadge({ lock, projectId, onChanged }) {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!lock) return null;

  const release = async (e) => {
    e.stopPropagation();
    if (!confirmForceRelease(lock)) return;
    setBusy(true);
    try { await forceReleaseProdLock(projectId); onChanged?.(); } catch (err) { showAlert(err.message, { variant: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <button
      className={`lock-badge${lock.held ? ' held' : ''}`}
      data-testid="lock-badge"
      disabled={busy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={release}
      title={lock.held
        ? 'Holds the PRODUCTION lock (held open — no auto-release). Click to force-release.'
        : 'Holds the PRODUCTION lock. Click to force-release.'}
    >
      {busy ? '…' : (hover ? '🔓' : '🔒')}
    </button>
  );
}
