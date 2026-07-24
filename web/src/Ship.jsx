// SHIP GATE — production ship requests, and the prod lock's countdown.
//
// Two things live here, both human-only:
//   1. A zee has asked to ship to PRODUCTION. Approving is the single most consequential click in
//      this app, so the card shows exactly what commit ships and from where.
//   2. After a ship, the queenzee holds prod and counts down to auto-release. Silence must mean
//      "let it go" — an unattended hold blocks every other xell. HOLD stops the clock for a human
//      who is actively verifying.
import React, { useState, useEffect, useRef } from 'react';
import { decideShip, dismissShip, deferShip, resumeShip, unlockAndShip, holdProdLock, forceReleaseProdLock, getSites, bundleDeferredShips } from './api.js';
import { showAlert, showConfirm } from './Dialog.jsx';

const short = (s) => (s ? String(s).slice(0, 8) : '—');

// ONE force-release path, shared by the padlock badge and the countdown bar's "Release now".
// Same act → same words. Two different confirmations for one consequential click is how a human
// learns to skim past the one that matters. The warning escalates when the lock is HELD: a
// countdown release only skips a wait that was going to happen anyway, but releasing a HELD lock
// cuts off a human who deliberately stopped the clock to verify prod.
function confirmForceRelease(lock) {
  return showConfirm(
    `Force-release the production lock from ${lock.xell_slug}?\n\n`
    + `${lock.held ? 'It is being HELD open by a human — someone may be verifying prod right now.\n\n' : ''}`
    + `Prod becomes free for another xell to ship immediately.`,
    { variant: 'danger', okLabel: 'Force-release' });
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

function ShipCard({ req, live, prodSites, prodLock, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // A DEFERRED ship is still 'pending' server-side, but a human set it aside for a combined ship.
  // It shows a quiet "deferred" card with Resume, not the loud approve/reject actions.
  const deferred = req.status === 'pending' && !!req.deferred_at;
  // A folded RIDER: still a set-aside pending ship, but bundled into a carrier — it does not act on
  // its own (no Resume/Reject); it waits for the carrier's one deploy and shares its verdict.
  const bundledRider = deferred && !!req.bundled_into;
  const pending = req.status === 'pending' && !deferred;
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
  // Is PRODUCTION locked for the site THIS ship targets? A ship takes the prod lock keyed to its
  // site ('prod' for the default, 'prod@<key>' otherwise); while that lock is held by someone else
  // (a prior ship's verification countdown, or a hold) this ship cannot be approved — it would only
  // queue behind the holder. So approving is disabled, and "Unlock & ship" is offered instead.
  const shipLockKey = chosen && chosen.is_default === false ? `prod@${chosen.key}` : 'prod';
  const prodLocked = !!prodLock && prodLock.container === shipLockKey;

  const decide = async (decision) => {
    if (decision === 'approve' && !(await showConfirm(
      `Ship ${short(req.commit)} to PRODUCTION${siteName ? ` @ ${siteName}` : ''}?\n\n`
      + `The queenzee will take the prod lock and deploy it from main — this is real production.\n\n`
      + `Requested by: ${req.xell_slug}\n${req.reason ? `Reason: ${req.reason}\n` : ''}`,
      { variant: 'danger', okLabel: 'Ship to prod' }))) return;
    if (decision === 'reject' && !(await showConfirm(`Reject this ship request from ${req.xell_slug}?`, { variant: 'danger', okLabel: 'Reject' }))) return;
    setBusy(true); setErr(null);
    try { await decideShip(req.id, decision, undefined, decision === 'approve' ? siteId || undefined : undefined); onDone?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // DEFER: set the ship aside without rejecting it, so other xells' landings can pile up on main
  // and one combined ship carries them all. RESUME re-aims it at the current main tip.
  const defer = async () => {
    if (!(await showConfirm(
      `Defer this ship from ${req.xell_slug}?\n\n`
      + `It is set aside — NOT rejected — and stops asking for approval, so landings from other `
      + `xells can accumulate on main. Resume it later to ship everything at once (it re-aims at `
      + `the current main tip when you do).`,
      { okLabel: 'Defer' }))) return;
    setBusy(true); setErr(null);
    try { await deferShip(req.id); onDone?.(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const resume = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await resumeShip(req.id);
      if (r && r.ok === false) setErr(r.reason || 'could not resume'); else onDone?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  // UNLOCK & SHIP: production is locked by someone else, but this ship should go now — force-release
  // that lock and approve+ship in one step. Loud confirm, because it can cut off a human mid-verify.
  const unlockShip = async () => {
    if (!(await showConfirm(
      `Production is locked by ${prodLock?.xell_slug || 'another xell'}${prodLock?.held ? ' (held open)' : ''}.\n\n`
      + `Force-release that lock and ship ${short(req.commit)}${siteName ? ` @ ${siteName}` : ''} to PRODUCTION now?\n\n`
      + `Whoever holds prod loses it immediately — if they are mid-verification, that is cut off. The `
      + `queenzee then deploys this from main — real production.`,
      { variant: 'danger', okLabel: 'Unlock & ship' }))) return;
    setBusy(true); setErr(null);
    try { await unlockAndShip(req.id, siteId || undefined); onDone?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className={`ship-card s-${req.status}${deferred ? ' deferred' : ''}`}>
      <div className="land-head">
        <span className="land-what">
          <b>{req.xell_slug}</b> wants to ship <b>{short(req.commit)}</b> to{' '}
          <b>PRODUCTION{!pending && siteName ? ` @ ${siteName}` : ''}</b>
        </span>
        <span className="land-meta">{deferred ? 'deferred' : req.status}</span>
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
      {deferred && !bundledRider && (
        <div className="ship-deferred" data-testid="ship-deferred">
          ⏸ deferred{req.deferred_by ? ` by ${req.deferred_by}` : ''} — set aside so other xells' landings
          collect on main. Resume to ship the combined result (it re-aims at the current main tip).
        </div>
      )}
      {bundledRider && (
        <div className="ship-deferred bundled" data-testid="ship-bundled-rider">
          🧺 bundled — riding one combined deploy. This xell's landed work is in the main tip the
          bundle builds, so it ships (or fails) with the carrier, without a build of its own.
        </div>
      )}
      <ShipResults results={req.containers} />
      {err && <div className="land-err">{err}</div>}
      {pending && prodLocked && (
        <div className="ship-locked-note" data-testid="ship-locked-note">
          🔒 production is locked by <b>{prodLock.xell_slug}</b>
          {prodLock.held ? ' (held open)' : ''} — approving is disabled until it releases. Use
          “Unlock &amp; ship” to take prod now.
        </div>
      )}
      {pending && (
        <div className="land-actions">
          <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          {/* Defer: not now — keep it, let landings accumulate, ship once (see deferShip). */}
          <button className="ship-defer" data-testid="ship-defer" disabled={busy} onClick={defer}
                  title="Set aside without rejecting — resume later for one combined ship">
            Defer
          </button>
          {prodLocked ? (
            // Prod is locked — the plain approve would only queue behind the holder, so disable it
            // and offer the deliberate "release the lock, then ship this" action instead.
            <>
              <button className="ship-approve" disabled data-testid="ship-approve-locked"
                      title={`Production is locked by ${prodLock.xell_slug} — release it first, or use Unlock & ship`}>
                Approve → ship to prod
              </button>
              <button className="ship-approve unlock-ship" data-testid="ship-unlock"
                      disabled={busy} onClick={unlockShip}>
                {busy ? '…' : '🔓 Unlock & ship'}
              </button>
            </>
          ) : (
            <button className="ship-approve" disabled={busy} onClick={() => decide('approve')}>
              {busy ? '…' : 'Approve → ship to prod'}
            </button>
          )}
        </div>
      )}
      {deferred && !bundledRider && (
        <div className="land-actions">
          <button className="land-reject" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          <button className="ship-approve" data-testid="ship-resume" disabled={busy} onClick={resume}>
            {busy ? '…' : 'Resume → awaiting approval'}
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
    if (!(await confirmForceRelease(lock))) return;
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
  // Deferred ships are still 'pending' server-side but a human set them aside, so they do NOT count
  // toward the loud "awaiting your approval" alarm — they render as quiet deferred cards.
  const pending = open.filter((s) => s.status === 'pending' && !s.deferred_at).length;
  const deferred = open.filter((s) => s.status === 'pending' && s.deferred_at).length;
  // The set-aside ships a bundle would act on: deferred, and not already folded into a carrier.
  // Two or more is where "ship them all as one deploy" beats resuming each (which is a deploy each).
  const bundleable = open.filter((s) => s.status === 'pending' && s.deferred_at && !s.bundled_into).length;
  return (
    <section className={`ship-panel${pending ? ' urgent' : ''}`}>
      <div className="ship-title">
        {pending
          ? `⚠ ${pending} PRODUCTION ship${pending === 1 ? '' : 's'} awaiting your approval`
          : deferred
            ? `⏸ ${deferred} ship${deferred === 1 ? '' : 's'} deferred — bundle them into one combined ship`
            : '⇪ production'}
      </div>
      <LockCountdown lock={prodLock} projectId={projectId} onChanged={onDecided} />
      {bundleable >= 2 && (
        <BundleBar count={bundleable} projectId={projectId} onDone={onDecided} />
      )}
      {open.map((s) => <ShipCard key={s.id} req={s} live={shipLogs?.[s.id]} prodSites={prodSites}
                                 prodLock={prodLock} onDone={onDecided} />)}
    </section>
  );
}

// One click that gathers every deferred request into ONE combined deploy (per prod site): the
// queenzee elects a carrier, re-aims it at the current main tip, and folds the rest to ride it —
// like "Resume", but for all of them at once. The carrier lands as a normal awaiting-approval ship
// (the human still approves that one loud click before prod). This is the payoff of deferring —
// many small landings pile up on main, then ONE ship carries them all, not a deploy per commit.
function BundleBar({ count, projectId, onDone }) {
  const [busy, setBusy] = useState(false);
  const bundle = async () => {
    if (!(await showConfirm(
      `Bundle all ${count} deferred ships into one combined production deploy?\n\n`
      + `The queenzee picks one as the carrier, re-aims it at the current main tip and ships it — `
      + `the rest ride that single build (their landed work is already in main). This still needs `
      + `your approval on the carrier before it deploys.`,
      { okLabel: 'Bundle & queue' }))) return;
    setBusy(true);
    try {
      const r = await bundleDeferredShips(projectId);
      if (r && r.ok === false) showAlert(r.reason || 'nothing to bundle', { variant: 'error' });
      else if (r?.skipped?.length) {
        showAlert(`Bundled ${r.bundles?.length || 0} deploy(s). Left out: `
          + r.skipped.map((s) => `${s.slug} (${s.reason})`).join('; '), { variant: 'info' });
      }
      onDone?.();
    } catch (e) { showAlert(e.message, { variant: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <div className="ship-bundle-bar" data-testid="ship-bundle-bar">
      🧺 <b>{count}</b> deferred ships can go as one — bundle them into a single production deploy
      instead of {count} separate ones.
      <button className="ship-bundle-btn" data-testid="ship-bundle" disabled={busy} onClick={bundle}>
        {busy ? '…' : `Bundle all ${count} into one ship`}
      </button>
    </div>
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
    if (!(await confirmForceRelease(lock))) return;
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
