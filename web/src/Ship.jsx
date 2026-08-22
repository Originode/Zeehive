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
import { shipFailureReport, shipHasFailureOutput } from './shipFailure.js';

const short = (s) => (s ? String(s).slice(0, 8) : '—');

// WHO READ THIS COMMIT (ticket #56) — the review records attached to the sha a ship carries, so a
// human approving a PRODUCTION deploy sees whether anyone actually read the code, and what they
// concluded. A record, never a gate: its absence never blocks a ship, and its presence is the
// information the ticket said the system was missing — a review happened and nobody could see it.
export function ShipReviewNote({ req }) {
  const reviews = Array.isArray(req.reviews) ? req.reviews : [];
  if (!reviews.length) return null;
  return (
    <div className="land-reviews" data-testid="ship-reviews">
      {reviews.map((r, i) => (
        <span key={i} className={`review-chip review-${r.verdict}`}
              title={r.report || `${r.reviewer}'s review of ${short(req.commit)}`}>
          {r.verdict === 'clean' ? '✓' : '⚠'} reviewed by {r.reviewer} — {r.verdict.replace('_', '-')}
          {Number(r.findings_count) > 0 ? ` · ${r.findings_count} finding${Number(r.findings_count) === 1 ? '' : 's'}` : ''}
        </span>
      ))}
    </div>
  );
}

// The schema half of the approve confirmation, in one line per set. Exported for the same reason
// ShipSchema is: the "UNKNOWN, never none" rule is a contract, so it is read from real output.
export function schemaConfirmLine(req) {
  const deploy = Array.isArray(req?.migrations) ? req.migrations.length : 0;
  const boot = req?.boot_migrations && typeof req.boot_migrations === 'object' ? req.boot_migrations : null;
  const parts = [`${deploy} migration(s) at deploy time`];
  if (boot?.applicable) {
    parts.push(boot.ok
      ? `${boot.pending.length} at boot (${boot.dir}, applied by the server as it restarts)`
      : `an UNKNOWN number at boot (${boot.dir} — the ledger could not be read)`);
  }
  return `Schema: ${parts.join('; ')}.\n\n`;
}

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

// WHAT SCHEMA THIS SHIP APPLIES, in the two places it actually applies it. Exported so the contract
// ("a card that cannot read the ledger says UNKNOWN, never none") can be rendered and read in a test.
//
//  • DEPLOY-TIME (`migrations`) — server/sql/migrations|ops, applied by the queenzee to the
//    production database BEFORE the containers build. A failure here stops the ship.
//  • BOOT-TIME (`boot_migrations`) — for a project that migrates itself as the new process starts
//    (Zeehive: db/migrations/*.sql against the meta-DB, via runMigrations()). A failure here happens
//    AFTER the swap, on a server that is already up.
// They are listed separately because that difference is the risk, and a card that merged them would
// misstate both. `boot_migrations.ok === false` means the ledger could not be read: the count is
// unknown, and saying "none" there is exactly the bug this fixes.
export function ShipSchema({ req }) {
  const deploy = Array.isArray(req?.migrations) ? req.migrations : [];
  const deployErr = req?.migrations_error || null;
  const boot = req?.boot_migrations && typeof req.boot_migrations === 'object' ? req.boot_migrations : null;
  const bootOn = !!boot?.applicable;
  // A pendingMigrations() failure at request time makes the DEPLOY-time count unknown — "no
  // migrations ride this ship" would be a lie. Same rule the boot-time set already followed (075).
  if (!deploy.length && !bootOn) {
    return (
      <div className="ship-schema" data-testid="ship-schema">
        <span className="k">schema:</span>{' '}
        {deployErr
          ? <b className="ship-schema-unknown" data-testid="ship-schema-deploy-unknown">UNKNOWN</b>
          : <span className="ship-schema-none">no migrations ride this ship</span>}
        {deployErr && (
          <span className="ship-schema-when"> — the deploy-time migration set could not be read: {deployErr}</span>
        )}
      </div>
    );
  }
  const list = (files) => (
    <ul className="ship-schema-files">
      {files.map((f) => <li key={f}><code>{f}</code></li>)}
    </ul>
  );
  return (
    <div className="ship-schema" data-testid="ship-schema">
      <div className="ship-schema-row" data-testid="ship-schema-deploy">
        <span className="k">at deploy:</span>{' '}
        {deploy.length
          ? <b>{deploy.length} migration(s)</b>
          : deployErr
            ? <b className="ship-schema-unknown" data-testid="ship-schema-deploy-unknown">UNKNOWN</b>
            : <span className="ship-schema-none">none</span>}
        {deployErr && !deploy.length && (
          <span className="ship-schema-when"> — the deploy-time migration set could not be read: {deployErr}</span>
        )}
        <span className="ship-schema-when"> — the queenzee applies these to the production database before the containers build</span>
        {deploy.length > 0 && list(deploy)}
      </div>
      {bootOn && (
        <div className="ship-schema-row" data-testid="ship-schema-boot">
          <span className="k">at boot:</span>{' '}
          {boot.ok
            ? (boot.pending.length
              ? <b>{boot.pending.length} migration(s)</b>
              : <span className="ship-schema-none">none</span>)
            : <b className="ship-schema-unknown" data-testid="ship-schema-unknown">UNKNOWN</b>}
          <span className="ship-schema-when">
            {' '}— the shipped server applies <code>{boot.dir}</code> to its own database when it restarts
          </span>
          {boot.ok && boot.pending.length > 0 && list(boot.pending)}
          {!boot.ok && (
            <div className="ship-schema-err">
              could not read the boot ledger, so this count is not known: {boot.error || 'no reason recorded'}.
              {' '}{boot.pending?.length ? `${boot.pending.length} file(s) exist at this commit; some or all may already be applied.` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// THE PAYLOAD THIS SHIP CARRIES (ticket #65) — the commits between the last SHIPPED commit for the
// same target and the one being deployed, each with who landed it and what it was for. The card
// already warned "every landing on main, not only the requester's" and never said which; this is
// the list. ADVISORY: a payload that could not be read renders as such in words and never blocks
// the ask or the approval — the same degrade-never-block rule as ShipPreflight.
export function ShipPayload({ req }) {
  const p = req?.payload;
  if (!p) return null;
  if (p.ok === false) {
    return (
      <div className="ship-payload" data-testid="ship-payload">
        <span className="k">payload:</span>{' '}
        <span className="ship-payload-unknown" data-testid="ship-payload-unknown">
          could not be read{p.error ? ` — ${p.error}` : ''}
        </span>
      </div>
    );
  }
  if (!p.commits?.length) {
    return (
      <div className="ship-payload" data-testid="ship-payload">
        <span className="k">payload:</span>{' '}
        <span className="ship-payload-note" data-testid="ship-payload-note">{p.note || 'nothing new since the last ship to this target'}</span>
      </div>
    );
  }
  const s = p.summary || {};
  const yours = s.yours > 0 ? `; ${s.yours} ${s.yours === 1 ? 'is' : 'are'} yours` : '';
  return (
    <div className="ship-payload" data-testid="ship-payload">
      <div className="ship-payload-summary" data-testid="ship-payload-summary">
        <span className="k">payload:</span>{' '}
        <b>{s.commits} commit{s.commits === 1 ? '' : 's'} from {s.xells} xell{s.xells === 1 ? '' : 's'}</b>
        {' '}since the last ship to this target{p.from ? ` (${short(p.from)})` : ''}{yours}
      </div>
      <ul className="ship-payload-commits" data-testid="ship-payload-commits">
        {p.commits.map((c, i) => (
          <li key={i} className={`ship-payload-commit${c.unattributed ? ' unattributed' : ''}`} data-testid="ship-payload-commit">
            <code>{short(c.sha)}</code> {c.subject}
            <span className="ship-payload-when">
              {' — '}landed by {c.xell_slug || 'unknown'}{c.landed_at ? ` · ${new Date(c.landed_at).toLocaleDateString()}` : ''}
            </span>
            {(c.ticket || c.work_item) && (
              <span className="ship-payload-work">
                {' · '}{c.ticket?.number ? `#${c.ticket.number} ` : ''}{c.work_item?.title || c.ticket?.title || 'work item'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// THE DEPLOY'S PRECONDITIONS, as probed when the ship was raised (ticket #58). The queenzee runs
// READ-ONLY checks at request time — the migration target db is addressable and inspectable, the
// build targets have build scripts, the docker contexts answer — and this renders the verdict so a
// failing precondition turns the card into "cannot ship, because X" BEFORE a human spends attention
// approving it. The stored checks are rendered as-is (the card never reclassifies), so the record
// and the card cannot disagree.
export function ShipPreflight({ req }) {
  const checks = Array.isArray(req?.preflight) && req.preflight.length ? req.preflight : null;
  if (!checks) return null;
  const failed = checks.filter((c) => !c.ok && !c.unknown && !c.skipped);
  const unknown = checks.filter((c) => c.unknown);
  const passed = checks.filter((c) => c.ok && !c.skipped);
  const skipped = checks.filter((c) => c.skipped);

  if (failed.length) {
    return (
      <div className="ship-preflight bad" data-testid="ship-preflight">
        <div className="ship-preflight-head" data-testid="ship-preflight-bad">⛔ cannot ship, because:</div>
        {failed.map((c) => (
          <div className="ship-preflight-fail" key={c.check} data-testid="ship-preflight-fail">
            <b>{c.check}:</b> {c.detail}
          </div>
        ))}
        {unknown.length > 0 && (
          <div className="ship-preflight-unknown" data-testid="ship-preflight-partial">
            …plus {unknown.length} check{unknown.length === 1 ? '' : 's'} that could not be verified:
            {' '}{unknown.map((c) => c.check).join(', ')}
          </div>
        )}
        {req.preflight_error && (
          <div className="ship-preflight-err" data-testid="ship-preflight-error">{req.preflight_error}</div>
        )}
      </div>
    );
  }
  if (unknown.length) {
    return (
      <div className="ship-preflight unknown" data-testid="ship-preflight">
        <span className="k">pre-flight:</span> could not verify everything —{' '}
        {unknown.map((c) => `${c.check}: ${c.detail}`).join(' · ')}
      </div>
    );
  }
  return (
    <div className="ship-preflight ok" data-testid="ship-preflight">
      <span className="k">pre-flight:</span> ready —
      {' '}{passed.length} precondition{passed.length === 1 ? '' : 's'} verified
      {skipped.length ? ` · ${skipped.length} skipped` : ''}
    </div>
  );
}

function ShipCard({ req, live, prodSites, prodLock, onDone, onForwardToZee }) {
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
  // The cxell-image override, decided HERE and recorded on the request. A ship rebuilds
  // zeehive/zee-agent (the image every cxell zee runs) from the shipped commit, and a failed
  // rebuild FAILS the ship — because a queenzee on new code with a silently stale fleet image is
  // the one failure nobody can see. This tick is the release valve for the human who needs the
  // deploy through anyway: off by default, deliberately a second click, never remembered.
  const [allowStale, setAllowStale] = useState(false);
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
      // A ship is FLEET-WIDE: it deploys the TIP of main, which carries every landing that reached
      // it, not only the requesting xell's work. One deploy went out at a sha 5 commits ahead of the
      // requester's, so work nobody had read reached production under someone else's approval.
      + `This deploys the CURRENT TIP of main (${short(req.commit)}) — every landing on main at this `
      + `moment, not only ${req.xell_slug}'s work.\n\n`
      + schemaConfirmLine(req)
      + `Requested by: ${req.xell_slug}\n${req.reason ? `Reason: ${req.reason}\n` : ''}`
      + (allowStale
        ? `\n⚠ WITH the cxell-image override: if the zee-agent image cannot be rebuilt, this ship `
          + `proceeds anyway and new cxells may run a STALE image. Your choice is recorded on the request.\n`
        : ''),
      { variant: 'danger', okLabel: 'Ship to prod' }))) return;
    if (decision === 'reject' && !(await showConfirm(`Reject this ship request from ${req.xell_slug}?`, { variant: 'danger', okLabel: 'Reject' }))) return;
    setBusy(true); setErr(null);
    try {
      await decideShip(req.id, decision, undefined,
        decision === 'approve' ? siteId || undefined : undefined,
        decision === 'approve' && allowStale);
      onDone?.();
    }
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
    try { await unlockAndShip(req.id, siteId || undefined, allowStale); onDone?.(); }
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
      {/* WHO READ THIS COMMIT (ticket #56) — the reviews recorded against the sha this ship carries,
          so approving a deploy to PRODUCTION is done knowing whether the code was reviewed, and by
          whom. A record, never a gate: its absence never blocks a ship, and its presence is the
          information the ticket said the system was missing. */}
      <ShipReviewNote req={req} />
      {/* THE SCHEMA THIS SHIP CARRIES — both sets, never merged (ticket #12). The card used to show
          nothing at all unless the ship was code-only, and `migrations` is empty for a project that
          migrates itself at BOOT: a Zeehive deploy told the approving human "no migrations" while
          applying five to the live meta-DB, two of which rewrote the manual every zee reads. The
          gate is only as good as what it tells the human. */}
      <ShipSchema req={req} />
      {/* THE DEPLOY'S PRECONDITIONS, probed at request time (ticket #58). A failing precondition
          turns the card into "cannot ship, because X" BEFORE the human spends attention approving.
          The deploy's own guards re-check at deploy time, so an approve after the reason is fixed
          is safe; an approve before it is fixed fails with the SAME named reason on the result. */}
      <ShipPreflight req={req} />
      {/* THE PAYLOAD (ticket #65) — what this ship actually carries: the commits since the last
          shipped commit for this target, with who landed each. Distinct from the schema (above)
          and the pre-flight: those say WHAT the deploy applies and whether its preconditions are
          met; this says WHOSE work is riding along. */}
      <ShipPayload req={req} />
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
      {/* THE CXELL-IMAGE GUARD, and its release valve. Deploying Zeehive rebuilds the zee-agent
          image every cxell zee runs; a failed rebuild fails the ship, because a queenzee on new
          code with a silently stale fleet image is the one outcome nobody can detect. Before this
          existed the only override was an env var on the queenzee's own process — an override that
          needed a queenzee restart, i.e. itself a deploy, exactly when someone is mid-incident. */}
      {req.status === 'pending' && (
        <label className="ship-stale-override" data-testid="ship-stale-override"
               title="A ship rebuilds zeehive/zee-agent from the shipped commit. If that build fails, the ship fails — new cxells would otherwise silently run an image that is not this code. Tick this only to accept that risk for THIS ship; your choice is recorded on the request.">
          <input type="checkbox" checked={allowStale} disabled={busy}
                 onChange={(e) => setAllowStale(e.target.checked)} />
          {' '}ship anyway if the cxell image can’t be rebuilt
          {allowStale && <span className="ship-stale-warn"> — new cxells may run a STALE image</span>}
        </label>
      )}
      {/* After the fact: what the human actually chose, on the row, next to who approved it. */}
      {req.allow_stale_cxell_image && req.status !== 'pending' && (
        <div className="ship-stale-chosen" data-testid="ship-stale-chosen">
          ⚠ approved WITH the cxell-image override{req.decided_by ? ` by ${req.decided_by}` : ''} — a
          failed image rebuild did not fail this ship; new cxells may be running a stale image
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
      {req.status === 'failed' && (
        <>
          {/* The classified cause rides beside the raw log — the card says WHY it failed instead of
              handing out a 400-character tail to scroll (ticket #58). */}
          {req.failure_cause && (
            <div className="ship-cause" data-testid="ship-cause">
              ✗ {req.failure_cause.replaceAll('-', ' ')}
              {req.failure_line && <span className="ship-cause-line" data-testid="ship-cause-line"> — {req.failure_line}</span>}
            </div>
          )}
          <div className="land-err">✗ ship FAILED{req.error ? `: ${req.error}` : ''}</div>
        </>
      )}
      {/* A ship built by the queenzee and failed — hand the zee the exact build output so it can
          fix and re-ship, instead of the operator copy-pasting logs into the message composer by
          hand. Opens the same 📨 composer, pre-filled with the failure report; the human can add a
          note and send. Needs a xell to reach (retired/orphaned ships have no live zee). */}
      {shipHasFailureOutput(req) && req.xell_id && onForwardToZee && (
        <div className="ship-forward-row">
          <button className="ship-forward" data-testid="ship-forward"
                  onClick={() => onForwardToZee({ id: req.xell_id, slug: req.xell_slug }, shipFailureReport(req))}
                  title="Open a message to this xell's zee pre-filled with the ship's build output">
            📨 Forward build output to {req.xell_slug || 'the zee'}
          </button>
        </div>
      )}
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

// Ship asks that were REFUSED — the ones that never became a card, because requestShip refuses a
// ship whose work is not landed and writes no row. That refusal used to exist only in the queenzee
// log, so a zee could ask, be refused, tell its human "it is waiting for your approval", and the
// human would find an empty production panel and no way to tell whether anything had been asked at
// all. These are NOT decisions: there is nothing to approve — that is the point of showing them.
function RefusedAsks({ refused }) {
  if (!refused?.length) return null;
  return (
    <div className="ship-refused" data-testid="ship-refused">
      <div className="ship-refused-head">
        ⃠ {refused.length} ship ask{refused.length === 1 ? '' : 's'} REFUSED — no request was raised,
        so there is nothing here to approve
      </div>
      {refused.map((r) => (
        <div className="ship-refused-row" key={r.xell_id} data-testid="ship-refused-row"
             title={`${r.full || r.reason || 'no reason recorded'}\n\n`
               + 'The zee asked to ship and the gate refused it outright — a ship builds from main, so '
               + 'unlanded or uncommitted work would not be in it. Nothing is pending: it must land first, '
               + 'then ask again. This line clears as soon as it raises a real request.'}>
          <b>{r.xell_slug}</b> asked {r.at ? new Date(r.at).toLocaleTimeString() : ''} — {r.reason || 'no reason recorded'}
        </div>
      ))}
    </div>
  );
}

export default function ShipPanel({ shipping, prodLock, shipLogs, projectId, onDecided, onForwardToZee,
                                    refused = [] }) {
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
  // The panel also renders for refusals alone: "a zee asked and was refused" is exactly the thing
  // that was invisible, so an empty panel must stop being the answer to it.
  if (!open.length && !prodLock && !refused?.length) return null;
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
      <RefusedAsks refused={refused} />
      <LockCountdown lock={prodLock} projectId={projectId} onChanged={onDecided} />
      {bundleable >= 2 && (
        <BundleBar count={bundleable} projectId={projectId} onDone={onDecided} />
      )}
      {open.map((s) => <ShipCard key={s.id} req={s} live={shipLogs?.[s.id]} prodSites={prodSites}
                                 prodLock={prodLock} onDone={onDecided} onForwardToZee={onForwardToZee} />)}
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
