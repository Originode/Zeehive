// SHIP GATE — production ship requests, and the prod lock's countdown.
//
// Two things live here, both human-only:
//   1. A zee has asked to ship to PRODUCTION. Approving is the single most consequential click in
//      this app, so the card shows exactly what commit ships and from where.
//   2. After a ship, the queenzee holds prod and counts down to auto-release. Silence must mean
//      "let it go" — an unattended hold blocks every other xell. HOLD stops the clock for a human
//      who is actively verifying.
import React, { useState, useEffect } from 'react';
import { decideShip, holdProdLock, forceReleaseProdLock } from './api.js';

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

function ShipCard({ req, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pending = req.status === 'pending';

  const decide = async (decision) => {
    if (decision === 'approve' && !confirm(
      `Ship ${short(req.commit)} to PRODUCTION?\n\n`
      + `The queenzee will take the prod lock and deploy it from main — this is real production.\n\n`
      + `Requested by: ${req.xell_slug}\n${req.reason ? `Reason: ${req.reason}\n` : ''}`)) return;
    if (decision === 'reject' && !confirm(`Reject this ship request from ${req.xell_slug}?`)) return;
    setBusy(true); setErr(null);
    try { await decideShip(req.id, decision); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className={`ship-card s-${req.status}`}>
      <div className="land-head">
        <span className="land-what">
          <b>{req.xell_slug}</b> wants to ship <b>{short(req.commit)}</b> to <b>PRODUCTION</b>
        </span>
        <span className="land-meta">{req.status}</span>
      </div>
      {req.reason && <div className="ship-reason">“{req.reason}”</div>}
      {/* Names the sha, not just "main". This line used to promise "builds from main in the xource"
          while the build took whatever that shared checkout was parked at — for a long while, 542
          commits behind. What it names now is exactly what ship-prod.sh checks out. */}
      <div className="land-stat">
        builds local <b>main</b> @ <b>{short(req.commit)}</b> — not the xell's worktree, not origin
      </div>
      {req.status === 'shipping' && <div className="ship-progress">⟳ queenzee is deploying — it holds the prod lock</div>}
      {req.status === 'approved' && <div className="ship-progress">✓ approved — queenzee is taking the prod lock…</div>}
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
    try { await holdProdLock(projectId); onChanged?.(); } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  // Release now — the other half of the decision the countdown poses. Without it the only options
  // were "wait out the clock" or "go hunt for the padlock on the xell's card", which is the same
  // act two screens away from where it is being asked about.
  const release = async () => {
    if (!confirmForceRelease(lock)) return;
    setBusy(true);
    try { await forceReleaseProdLock(projectId); onChanged?.(); } catch (e) { alert(e.message); }
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

export default function ShipPanel({ shipping, prodLock, projectId, onDecided }) {
  const open = shipping || [];
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
      {open.map((s) => <ShipCard key={s.id} req={s} onDone={onDecided} />)}
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
    try { await forceReleaseProdLock(projectId); onChanged?.(); } catch (err) { alert(err.message); }
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
