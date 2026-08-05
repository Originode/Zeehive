// SHIPPING TO PRODUCTION — the zee asks, a human decides, the QUEENZEE ships.
//
// Division of labour, and every part of it is deliberate:
//   zee      → may only REQUEST. It never holds the lock and never runs a deploy.
//   human    → approves in the console. Nothing reaches prod without this.
//   queenzee → takes the lock, runs the container's OWN build script (stored on the container
//              row), reports back, and takes the lock away again on a timer.
//
// The build runs from the XOURCE AT MAIN, never a xell worktree, and a ship is refused unless the
// work is already landed. That is what stops band-aid deploys: a zee building prod from its own
// worktree puts code live that main doesn't have, and the next rebuild silently reverts it.
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { cleanGitEnv, headCommit } from '../lib/git.js';
import { resolveBash } from '../lib/bash.js';
import { notifyShipRequest, notifyShipDone } from '../lib/notify.js';
import { pendingMigrations, applyMigrations, pendingBootMigrations } from './shipmigrate.js';
import { materializeEnvFile } from '../lib/environments.js';
import { shouldProcessNow, processPad } from './landingpad.js';
import { setShipRefusal, clearShipRefusal } from '../lib/status.js';
import { nudgeXellForReflection } from './nudge.js';

// Real deploys are gated on a human anyway; SHIP_MODE=simulate exists to verify ZEEHIVE itself.
const MODE = process.env.SHIP_MODE === 'simulate' ? 'simulate' : 'real';
// How long the shipping xell keeps prod before the queenzee takes it back. An unattended hold
// blocks every other xell for as long as the human is away, so silence must NOT mean "keep it".
const AUTO_RELEASE_SEC = Number(process.env.SHIP_LOCK_RELEASE_SEC) || 180;
// A build that outlives this is not slow, it is gone — kill it and fail the ship rather than
// hold prod hostage. Generous on purpose: prod builds cross the mardale link, which has run at
// 68KB/s for days at a time, and a killed-but-legitimate build costs one re-request, while an
// unbounded one cost a whole night of "shipping now" with the site's lock pinned under it.
const BUILD_TIMEOUT_MS = Number(process.env.SHIP_BUILD_TIMEOUT_MS) || 45 * 60 * 1000;
const SHIPPABLE = ['server', 'webapp'];

// Ships whose runShip promise is alive in THIS process. The DB says 'shipping'; only this set
// says "and something is actually doing it". Everything that recovers stranded ships — the tick
// sweep, boot recovery, the reaper's done-path — keys off membership here, because a 'shipping'
// row with no entry has no process behind it and will never finish on its own.
const liveShips = new Set();

// Is this xell's work actually ON main? A ship builds from main, so shipping unlanded work would
// deploy code the zee doesn't have — the request is meaningless, not merely unwise.
function landedState(worktreePath, mainBranch) {
  if (!worktreePath) return { landed: false, reason: 'xell has no worktree' };
  const ahead = gitCount(worktreePath, `${mainBranch}..HEAD`);
  const dirty = gitDirty(worktreePath);
  if (ahead === null) return { landed: false, reason: 'cannot read the worktree' };
  if (ahead > 0) return { landed: false, reason: `${ahead} commit(s) not landed on ${mainBranch} yet — land them first (a ship builds from ${mainBranch}, so unlanded work would NOT be in it)` };
  // NAME the dirty files. "3 uncommitted file(s)" sends a zee hunting through its own worktree for
  // work it may not have done: the queenzee itself writes files in there (generated env, injected
  // harness), and a refusal that will not say WHICH files reads as a mystery rather than an
  // instruction. Naming them costs one line of git output we already have.
  if (dirty.count > 0) {
    return { landed: false, reason: `${dirty.count} uncommitted file(s) — commit and land them first, or `
      + `they will not be in the ship: ${dirty.files.join(', ')}` };
  }
  return { landed: true };
}

function gitCount(cwd, range) {
  const r = spawnSync('git', ['-C', cwd, 'rev-list', '--count', range],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : null;
}
// { count, files } — the count as before, plus up to 6 named paths for the refusal message.
function gitDirty(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) return { count: 0, files: [] };
  const lines = r.stdout.split('\n').filter(Boolean);
  const files = lines.slice(0, 6).map((l) => l.slice(3).trim());
  if (lines.length > files.length) files.push(`… +${lines.length - files.length} more`);
  return { count: lines.length, files };
}

// Which prod SITE a ship (or lock) is about (spec §5). Named key → that site, error if unknown;
// unnamed → the project's default prod site. Returns null only for a pre-sites project (legacy:
// no site rows, behavior unchanged). The DEFAULT site keeps lock key exactly 'prod' so ships and
// /spin:deploy-guard locks (which use 'prod') still mutually exclude; only additional sites get
// their own key — a VPS ship must not block a LAN-prod hotfix.
async function resolveShipSite(projectId, siteKey = null) {
  if (siteKey) {
    const s = await one(
      `SELECT * FROM deploy_site WHERE project_id=$1 AND key=$2 AND tier='prod'`, [projectId, siteKey]);
    if (!s) throw new Error(`no prod deploy site keyed "${siteKey}" for this project`);
    return s;
  }
  return one(
    `SELECT * FROM deploy_site WHERE project_id=$1 AND tier='prod' AND is_default LIMIT 1`, [projectId]);
}
const lockKeyFor = (site) => (site && !site.is_default ? `prod@${site.key}` : 'prod');

// Resolve WHAT a ship will build: the sha at the project's ship_ref (local main by default, a
// fetched remote ref for a remote-integration project) and the migration set pending at that sha
// for the chosen site. Shared by requestShip (decides it once, at request time) and resumeShip (a
// deferred ship re-decides it against the CURRENT main tip, so the combined ship carries every
// landing made while it was set aside). Returns { commit, migrations } or throws with a reason.
async function resolveShipCommit(project, shipSite, main) {
  const shipRef = project.ship_ref || main;
  if (shipRef.includes('/')) {
    const remote = shipRef.split('/')[0];
    const f = spawnSync('git', ['-C', project.repo_root, 'fetch', remote],
      { encoding: 'utf8', timeout: 60000, windowsHide: true, env: cleanGitEnv() });
    if (f.status !== 0) {
      throw new Error(`cannot fetch ${remote} for ship_ref ${shipRef}: ${(f.stderr || '').slice(-200)}`);
    }
  }
  const commit = headCommit(project.repo_root, shipRef);
  if (!commit) throw new Error(`ship_ref "${shipRef}" does not resolve in ${project.repo_root}`);
  const mig = await pendingMigrations(project, commit, shipSite);
  // …and the schema the shipped PROCESS applies at boot, for a project that migrates itself
  // (ticket #12). Best-effort and never throws: an unreadable ledger becomes {ok:false} on the
  // card — "unknown", which is the honest answer — not a silent zero.
  const boot = await pendingBootMigrations(project, commit, shipSite);
  return { commit, migrations: mig.pending || [], bootMigrations: boot };
}

// ── the zee's only prod verb ─────────────────────────────────────────────────
// skipDb: the zee scoped this ship to CODE ONLY — runShip will NOT apply pending migration/ops
// files (recorded on the row; the human approves the scope with the click, the results show the
// skip). dbNote: the zee's drift diagnosis from the /ooney schema gate, shown on the card.
export async function requestShip({ xellId, zeeId = null, reason = null, targets = null, site = null,
                                    skipDb = false, dbNote = null }) {
  // Which roles to rebuild — the zee names them (/ooney webapp|server|both). Silently dropping an
  // unknown role would ship less than the zee asked for and report success, so validate loudly.
  const t = (Array.isArray(targets) && targets.length ? targets : SHIPPABLE).map(String);
  const bad = t.filter((r) => !SHIPPABLE.includes(r));
  if (bad.length) throw new Error(`unshippable target(s): ${bad.join(', ')} — only ${SHIPPABLE.join('/')}`);
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('unknown xell');
  if (xell.is_production) throw new Error('production cannot ship itself');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  const shipSite = await resolveShipSite(project.id, site);
  const main = project.main_branch || 'main';

  // A refusal is the one outcome that leaves NO ship_request row — so it must leave something
  // else, or it leaves nothing at all. refuse() records it on the xell (session_event, latest
  // wins) so the console can show "this zee asked and was refused, here is why" instead of an
  // empty production panel, and hands the caller an unambiguous shape: ok:false + refused:true.
  const refuse = async (why) => {
    logline('ship', `REFUSED ship from ${xell.slug}: ${why}`);
    await setShipRefusal(xellId, why, { zeeId });
    return {
      ok: false, refused: true, reason: why, request: null,
      message: `SHIP REFUSED — NO request was raised, so there is NOTHING for a human to approve: ${why}. `
        + 'Do not report a ship as requested; fix the reason and ask again. The console now shows this '
        + 'refused ask on your xell so your human can see it too.',
    };
  };

  const state = landedState(xell.worktree_path, main);
  if (!state.landed) return refuse(state.reason);

  // Open request already? Note the deliberate absence of a dismissed_at filter here — and the
  // presence of one in every HUMAN-facing view (fleet.js, listShipRequests). That mismatch is how a
  // ship ask became a ghost: a dismissed-but-open request kept answering the zee "you already have
  // an open ship request" while rendering nowhere a human could see it, and the partial unique
  // index made a fresh one impossible. So an open request that was dismissed is UN-dismissed here:
  // if the zee is still asking, the ask is still live, and it belongs back on the screen.
  const existing = await one(
    `SELECT * FROM ship_request WHERE project_id=$1 AND xell_id=$2
       AND status IN ('pending','approved','shipping')`, [project.id, xellId]);
  if (existing) {
    await clearShipRefusal(xellId, { zeeId });
    let row = existing;
    let restored = false;
    if (existing.dismissed_at) {
      row = await one(
        `UPDATE ship_request SET dismissed_at=NULL, dismissed_by=NULL WHERE id=$1 RETURNING *`, [existing.id]);
      restored = true;
      logline('ship', `RESTORED dismissed ship request from ${xell.slug} @ ${String(row.commit).slice(0, 8)}`
        + ' — its zee asked again, so it is back on the console instead of held invisibly');
      broadcast('ship', row);
    }
    return { ok: true, request: row, restored,
      note: row.deferred_at
        ? 'you already have a ship request — a human DEFERRED it to batch it into a combined ship; it will go when they resume it'
        : restored
          ? 'you already had an open ship request that had been dismissed from the console — it is visible to a human again'
          : 'you already have an open ship request' };
  }

  // WHERE the ship's code comes from: local main by default (the anti-band-aid rule); a project
  // whose integration truth is remote (ship_ref like 'origin/main') gets that remote fetched
  // FIRST so the human approves the sha that is actually current, not a stale mirror. What schema
  // rides along is decided NOW too, so the human approves code and migrations as one thing.
  let commit, migrations, bootMigrations;
  try { ({ commit, migrations, bootMigrations } = await resolveShipCommit(project, shipSite, main)); }
  catch (e) { return refuse(e.message); }
  let row;
  try {
    row = await one(
      `INSERT INTO ship_request (project_id, xell_id, zee_id, commit, reason, targets, migrations, site_id,
                                 skip_migrations, db_note, boot_migrations)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb) RETURNING *`,
      [project.id, xellId, zeeId, commit, reason, t, JSON.stringify(migrations), shipSite?.id || null,
       !!skipDb, dbNote, JSON.stringify(bootMigrations)]);
  } catch (e) {
    // ship_request_open_uq (one open ship per xell) — two asks raced, or a row appeared between the
    // check above and here. The zee's ask IS satisfied by the winner, so hand that back rather than
    // a raw postgres constraint name: "duplicate key value violates…" reads like a broken gate.
    if (e.code !== '23505') throw e;
    const won = await one(
      `SELECT * FROM ship_request WHERE project_id=$1 AND xell_id=$2
         AND status IN ('pending','approved','shipping')`, [project.id, xellId]);
    if (!won) throw e;
    return { ok: true, request: won, note: 'you already have an open ship request (raised a moment ago)' };
  }
  // The ask is now a row a human can see, so any earlier refusal on this xell is history.
  await clearShipRefusal(xellId, { zeeId });
  broadcast('ship', row);

  // Operator policy: auto-approve ships for this project → the queenzee approves and deploys with
  // no human in the loop. Still goes through the SAME decideShip → runShip path (lock, build from
  // main, countdown) — nothing about the deploy itself is bypassed, only the human decision. The
  // landed-work refusal above still applies, so an unlanded ship is refused even under auto-approve.
  if (project.auto_approve_ship) {
    logline('ship', `AUTO-APPROVING ship from ${xell.slug} @ ${String(commit).slice(0, 8)}`
      + `${shipSite ? ` → site ${shipSite.key}` : ''} — auto-approve policy (no human review)`);
    const approved = await decideShip(row.id, 'approved', 'auto-approve@policy');
    return { ok: true, request: approved, note: 'auto-approved by policy — deploying' };
  }

  logline('ship', `HELD ship request from ${xell.slug} @ ${String(commit).slice(0, 8)}`
    + `${shipSite ? ` → site ${shipSite.key}` : ''} — awaiting human approval`);
  notifyShipRequest({ project, xell, request: row });
  return { ok: true, request: row };
}

// "Seen it — stop showing me." View-only, like the landing equivalent: a dismissed ship still
// shipped/failed on its own, it just stops rendering in the PRODUCTION panel (fleet.js filters
// dismissed_at IS NULL). Never touches status.
//
// It is a RECEIPT-clearing act, and only that: dismissing a still-OPEN request is refused. Hiding a
// pending ask does not decide it — the zee still holds it (and the partial unique index still
// blocks a replacement), so the only thing that changes is that the human can no longer see what
// the zee is waiting on. An open ship is decided with Reject, or set aside with Defer.
export async function dismissShipRequest(id, by = 'human@console') {
  const open = await one(
    `SELECT status FROM ship_request WHERE id=$1 AND status IN ('pending','approved','shipping')`, [id]);
  if (open) {
    throw new Error(`this ship request is still ${open.status} — dismiss only clears the receipt of a `
      + 'decided ship. Reject it (or Defer it) instead; hiding an open ask leaves the zee waiting on '
      + 'something nobody can see.');
  }
  const row = await one(
    `UPDATE ship_request SET dismissed_at=now(), dismissed_by=$2 WHERE id=$1 RETURNING *`, [id, by]);
  if (!row) throw new Error('no such ship request');
  broadcast('ship', row);
  return row;
}

// ── defer / resume: set a ship aside, then bring it back combined ─────────────
// DEFER a pending ship: it stops nagging as "awaiting approval" and steps out of the landing-pad
// queue, but it is NOT rejected. The request stays 'pending' (keeping the one-open-ship-per-xell
// invariant) with deferred_at set — the "not now, keep it for a combined ship" bucket. Only a
// pending, not-yet-deferred request can be deferred; there is no zee path to this, by design.
export async function deferShip(id, by = 'human@console') {
  const row = await one(
    `UPDATE ship_request SET deferred_at=now(), deferred_by=$2
       WHERE id=$1 AND status='pending' AND deferred_at IS NULL RETURNING *`, [id, by]);
  if (!row) throw new Error('no such pending ship request to defer (already decided or deferred?)');
  broadcast('ship', row);
  logline('ship', `DEFERRED ship ${String(row.commit).slice(0, 8)} from ${by}`
    + ' — set aside so landings can accumulate for one combined ship');
  return row;
}

// RESUME a deferred ship: clear deferred_at so it is a live pending request again — AND re-resolve
// it to the CURRENT main tip. That re-resolution is the whole point of deferring: while the ship
// sat aside, other xells kept landing, so the sha (and the migration set) it was frozen at is now
// stale. Resuming re-aims it at what main is NOW, so approving the resumed ship deploys every
// incremental landing made since — one big shipment for many small landings.
export async function resumeShip(id, by = 'human@console') {
  const deferred = await one(
    `SELECT * FROM ship_request WHERE id=$1 AND status='pending' AND deferred_at IS NOT NULL`, [id]);
  if (!deferred) throw new Error('no such deferred ship request to resume');
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [deferred.xell_id]);
  const project = await one(`SELECT * FROM project WHERE id=$1`, [deferred.project_id]);
  const main = project.main_branch || 'main';
  const site = deferred.site_id ? await one(`SELECT * FROM deploy_site WHERE id=$1`, [deferred.site_id]) : null;

  // The request's own work must still be on main (landings are forward-only, so a ship that was
  // landable when deferred stays landable) — but re-check, because a resume that shipped unlanded
  // work would be exactly the band-aid the ship gate exists to prevent.
  const state = landedState(xell?.worktree_path, main);
  if (!state.landed) {
    logline('ship', `REFUSED resume of ${xell?.slug || deferred.xell_id} ship: ${state.reason}`);
    return { ok: false, reason: state.reason, request: deferred };
  }

  let commit, migrations, bootMigrations;
  try { ({ commit, migrations, bootMigrations } = await resolveShipCommit(project, site, main)); }
  catch (e) { return { ok: false, reason: e.message, request: deferred }; }

  const row = await one(
    `UPDATE ship_request SET deferred_at=NULL, deferred_by=NULL, commit=$2, migrations=$3::jsonb, boot_migrations=$4::jsonb,
            requested_at=now()
       WHERE id=$1 AND status='pending' AND deferred_at IS NOT NULL RETURNING *`,
    [id, commit, JSON.stringify(migrations), JSON.stringify(bootMigrations)]);
  if (!row) throw new Error('ship request changed underneath the resume — reload and try again');
  broadcast('ship', row);
  logline('ship', `RESUMED ship for ${xell?.slug || deferred.xell_id} by ${by} @ ${String(commit).slice(0, 8)}`
    + ` — re-aimed at the current ${main} tip (${migrations.length} deploy-time migration(s)`
    + `${bootMigrations?.applicable ? `, ${bootMigrations.ok ? bootMigrations.pending.length : '?'} at boot` : ''})`);
  notifyShipRequest({ project, xell, request: row });
  return { ok: true, request: row };
}

// ── bundle: ship every DEFERRED ship as ONE combined deploy ───────────────────
// Resuming deferred ships one at a time and approving each is N prod deploys of (identically) the
// current main tip — the very "a deploy per commit" noise that deferring set out to avoid. Bundle
// is the human's "gather all of these into one" click: per prod SITE (a build cannot target two
// sites at once), it elects ONE deferred ship as the CARRIER, re-aims it at the current main tip,
// and FOLDS every other deferred ship for that site into it — those riders stay set aside (out of
// the pad and the alarm) and share the carrier's single verdict when its one deploy finishes (see
// the fold-in in runShipBody). Like "Resume" but for all at once: the carrier becomes a normal
// awaiting-approval ship, so the human still approves that ONE click before prod — nothing here
// deploys on its own. Its landed work plus every rider's is already in the main tip it builds, so
// one build genuinely ships them all. HUMAN-only, like every ship decision.
export async function bundleDeferredShips(projectId, { by = 'human@console' } = {}) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('unknown project');
  const main = project.main_branch || 'main';
  const deferred = await q(
    `SELECT s.*, x.worktree_path, x.slug AS xell_slug FROM ship_request s
       JOIN xell x ON x.id = s.xell_id
      WHERE s.project_id=$1 AND s.status='pending' AND s.deferred_at IS NOT NULL
        AND s.dismissed_at IS NULL AND s.bundled_into IS NULL
      ORDER BY s.deferred_at ASC`, [projectId]);
  if (!deferred.length) return { ok: false, reason: 'no deferred ship requests to bundle' };

  // Group by target site (null = the project default). One deploy per site — a single build cannot
  // produce two sites' images — so each distinct site gets its OWN carrier that folds that site's
  // members. Most projects have one prod site, so this is usually a single group.
  const groups = new Map();
  for (const s of deferred) {
    const k = s.site_id || 'default';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  const bundles = [];
  const skipped = [];
  for (const members of groups.values()) {
    // Every rider's work must still be on main — forward-only landings keep a deferred ship
    // landable, but re-check: a bundle that shipped unlanded work would be exactly the band-aid the
    // ship gate exists to forbid. An unlanded one is dropped from the bundle (stays deferred).
    const landed = [];
    for (const m of members) {
      const st = landedState(m.worktree_path, main);
      if (st.landed) landed.push(m); else skipped.push({ slug: m.xell_slug, reason: st.reason });
    }
    if (!landed.length) continue;

    const site = landed[0].site_id
      ? await one(`SELECT * FROM deploy_site WHERE id=$1`, [landed[0].site_id])
      : await resolveShipSite(projectId, null);
    let commit, migrations, bootMigrations;
    try { ({ commit, migrations, bootMigrations } = await resolveShipCommit(project, site, main)); }
    catch (e) { skipped.push({ slug: `site ${site?.key || 'default'}`, reason: e.message }); continue; }

    const [carrier, ...riders] = landed;
    const slugs = landed.map((m) => m.xell_slug);
    const reason = `bundled ship of ${landed.length} deferred request(s): ${slugs.join(', ')}`;
    // Carrier: un-defer and re-aim at the current main tip, but leave it PENDING — bundling mirrors
    // "Resume", not "Approve". The carrier becomes a normal awaiting-approval ship showing the
    // combined commit + migration set; the human still approves THAT before anything reaches prod
    // (the single most consequential click stays a click). Its one build carries every listed
    // xell's landed work, because they all resolve to this same main tip.
    const c = await one(
      `UPDATE ship_request SET deferred_at=NULL, deferred_by=NULL, bundled_into=NULL,
              commit=$2, migrations=$3::jsonb, requested_at=now(), reason=$4, boot_migrations=$5::jsonb
         WHERE id=$1 AND status='pending' AND deferred_at IS NOT NULL RETURNING *`,
      [carrier.id, commit, JSON.stringify(migrations), reason, JSON.stringify(bootMigrations)]);
    if (!c) { skipped.push({ slug: carrier.xell_slug, reason: 'changed underneath the bundle' }); continue; }
    broadcast('ship', c);

    // Fold the riders into the carrier: they stay set aside (still pending + deferred, so the pad
    // never picks them up on their own and they raise no alarm) with bundled_into pointing at the
    // carrier. When the carrier is approved and its one deploy finishes, every rider is resolved to
    // its verdict (see resolveBundleRiders in runShipBody).
    let folded = [];
    if (riders.length) {
      folded = await q(
        `UPDATE ship_request SET bundled_into=$2
           WHERE id = ANY($1) AND status='pending' AND deferred_at IS NOT NULL RETURNING id`,
        [riders.map((m) => m.id), c.id]);
      for (const f of folded) broadcast('ship', { id: f.id });
    }
    logline('ship', `BUNDLED ${landed.length} deferred ship(s) → carrier ${String(commit).slice(0, 8)}`
      + ` for site ${site?.key || 'default'} by ${by} (${slugs.join(', ')}) — awaiting approval`);
    notifyShipRequest({ project, xell: { slug: carrier.xell_slug }, request: c });
    bundles.push({ carrier: c.id, site: site?.key || null, count: landed.length, commit });
  }

  if (!bundles.length) {
    return { ok: false, skipped,
      reason: skipped.map((s) => `${s.slug}: ${s.reason}`).join('; ') || 'nothing bundlable' };
  }
  return { ok: true, bundles, skipped };
}

// Resolve every rider folded into a finished carrier to that carrier's ONE verdict. Their landed
// work is in the main tip the carrier built, so a shipped carrier ships them and a failed carrier
// fails them — from the single real deploy, no rider ever builds on its own. Shared by the normal
// success/fail path and the crash path so a carrier that dies mid-run still frees its riders.
async function resolveBundleRiders(carrierId, ok, commit) {
  const riders = await q(
    `UPDATE ship_request
        SET status=$2, finished_at=now(), deferred_at=NULL, deferred_by=NULL,
            decided_at=COALESCE(decided_at, now()), decided_by=COALESCE(decided_by, 'bundle@queenzee'),
            containers=$3::jsonb, error=$4
      WHERE bundled_into=$1 AND status='pending' RETURNING *`,
    [carrierId, ok ? 'shipped' : 'failed',
      JSON.stringify([{ role: 'bundle', ok, method: 'bundled',
        log: `rode a bundled ship built from main @ ${String(commit).slice(0, 8)} — this xell's landed `
          + `work is included in that single deploy` }]),
      ok ? null : `bundle carrier ${String(commit).slice(0, 8)} failed`]);
  for (const r of riders) broadcast('ship', r);
  if (riders.length) {
    logline('ship', `bundle: ${riders.length} folded ship(s) resolved → ${ok ? 'shipped' : 'failed'}`
      + ` with carrier ${String(commit).slice(0, 8)}`);
  }
  return riders.length;
}

export async function listShipRequests(projectId, { open = true } = {}) {
  const where = open ? `AND s.status IN ('pending','approved','shipping')` : '';
  return q(
    `SELECT s.*, x.slug AS xell_slug, ds.key AS site_key FROM ship_request s
       JOIN xell x ON x.id = s.xell_id
       LEFT JOIN deploy_site ds ON ds.id = s.site_id
       WHERE s.project_id=$1 ${where} ORDER BY s.requested_at DESC LIMIT 50`, [projectId]);
}

export async function shipStatus(xellId) {
  return one(
    `SELECT s.*, x.slug AS xell_slug FROM ship_request s JOIN xell x ON x.id=s.xell_id
       WHERE s.xell_id=$1 ORDER BY s.requested_at DESC LIMIT 1`, [xellId]);
}

// ── the human's decision ─────────────────────────────────────────────────────
// siteId (optional, approve only): the human aims the ship at a CHOSEN prod site — the dialog's
// target picker when a project has more than one production. The request recorded the default at
// request time; re-aiming here re-resolves the migration set against the chosen site's ledger, so
// what deploys is exactly what the human approved FOR that site. One production → nothing to
// choose, the recorded (default) site ships as always.
export async function decideShip(id, decision, by = 'human@console',
                                 { siteId, allowStaleCxellImage = false } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  let retarget = null;
  // The human's cxell-image override, recorded WITH the approval (migration 055). Only meaningful
  // on an approve, and only ever set true here — nothing may quietly clear a guard.
  const allowStale = decision === 'approved' && !!allowStaleCxellImage;
  if (decision === 'approved' && siteId) {
    const pending = await one(`SELECT * FROM ship_request WHERE id=$1 AND status='pending'`, [id]);
    if (!pending) throw new Error('no such pending ship request (already decided?)');
    if (siteId !== pending.site_id) {
      const site = await one(
        `SELECT * FROM deploy_site WHERE id=$1 AND project_id=$2 AND tier='prod'`, [siteId, pending.project_id]);
      if (!site) throw new Error('chosen site is not a prod site of this project');
      const project = await one(`SELECT * FROM project WHERE id=$1`, [pending.project_id]);
      const mig = await pendingMigrations(project, pending.commit, site);
      // the boot set is per-DATABASE too — a different site is a different ledger, so re-resolve it
      // rather than carry the one computed for the site the human just moved away from
      const boot = await pendingBootMigrations(project, pending.commit, site);
      retarget = { site, migrations: JSON.stringify(mig.pending || []), boot: JSON.stringify(boot) };
    }
  }
  const row = retarget
    ? await one(
      `UPDATE ship_request SET status=$2, decided_at=now(), decided_by=$3, site_id=$4, migrations=$5::jsonb,
              allow_stale_cxell_image=$6, boot_migrations=$7::jsonb
         WHERE id=$1 AND status='pending' RETURNING *`,
      [id, decision, by, retarget.site.id, retarget.migrations, allowStale, retarget.boot])
    : await one(
      `UPDATE ship_request SET status=$2, decided_at=now(), decided_by=$3, allow_stale_cxell_image=$4
         WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by, allowStale]);
  if (!row) throw new Error('no such pending ship request (already decided?)');
  broadcast('ship', row);
  logline('ship', `${decision.toUpperCase()} ship ${String(row.commit).slice(0, 8)} by ${by}`
    + (retarget ? ` → site ${retarget.site.key} (re-aimed at approval)` : '')
    // Say it at approval time, not just at build time: this is a human knowingly accepting a fleet
    // image that may not be the shipped code, and it belongs in the log next to who approved it.
    + (allowStale ? ` — WITH the cxell-image override: a failed image rebuild will NOT fail this `
                    + `ship, and new cxells may run a STALE image (chosen by ${by})` : ''));
  // A rejected BUNDLE carrier must not strand its riders pointing at it — free them back to
  // plain-deferred so a human can resume or re-bundle them.
  if (decision === 'rejected') {
    const freed = await q(`UPDATE ship_request SET bundled_into=NULL WHERE bundled_into=$1 RETURNING id`, [row.id]);
    for (const f of freed) broadcast('ship', { id: f.id });
    if (freed.length) logline('ship', `bundle carrier rejected — freed ${freed.length} rider(s) back to deferred`);
  }
  if (decision === 'approved') runShip(row.id).catch((e) => console.error('[ship] run failed:', e.message));
  return row;
}

// ── unlock & ship: force prod free, then ship this one ────────────────────────
// A pending ship cannot be approved while production is LOCKED — a prior ship is holding its
// verification countdown (or a human held it open), and approving would only queue behind it. This
// is the human deciding THIS ship should go now regardless: it force-releases the lock on this
// ship's target site and then approves it in one step, so the queenzee takes the freed lock and
// deploys. Folding the two acts ("Release now", then "Approve") into one also closes the window
// between them where a queued ship could grab the lock first. HUMAN-only, like every ship decision.
export async function unlockAndShip(id, { siteId = null, by = 'human@console',
                                          allowStaleCxellImage = false } = {}) {
  const ship = await one(`SELECT * FROM ship_request WHERE id=$1 AND status='pending'`, [id]);
  if (!ship) throw new Error('no such pending ship request (already decided?)');
  if (ship.deferred_at) throw new Error('this ship is deferred — resume it before shipping');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [ship.project_id]);
  // Which site this ship will hit — the human's re-aim (siteId) wins, else the recorded site, else
  // the project default. The lock we must free is the one keyed to THAT site.
  const site = (siteId && siteId !== ship.site_id)
    ? await one(`SELECT * FROM deploy_site WHERE id=$1 AND project_id=$2 AND tier='prod'`, [siteId, project.id])
    : (ship.site_id ? await one(`SELECT * FROM deploy_site WHERE id=$1`, [ship.site_id])
                    : await resolveShipSite(project.id, null));
  const lockKey = lockKeyFor(site);
  const held = await one(`SELECT * FROM deploy_lock WHERE project_id=$1 AND container=$2`, [project.id, lockKey]);
  if (held) {
    await q(`DELETE FROM deploy_lock WHERE id=$1`, [held.id]);
    broadcast('xell', { id: held.xell_id });
    broadcast('ship', { id: held.ship_id });
    logline('lock', `${lockKey} lock FORCE-RELEASED by ${by} — unlock & ship ${String(ship.commit).slice(0, 8)}`);
  }
  // Approve → runShip takes the (now free) lock and deploys. Pass the re-aim through so the ship
  // hits (and re-resolves its migrations for) the site the human chose.
  return decideShip(id, 'approved', by, { siteId: siteId || undefined, allowStaleCxellImage });
}

// ── the queenzee ships ───────────────────────────────────────────────────────
// Takes the lock, runs each prod container's OWN build script, then starts the release countdown.
// Exported so the LANDING PAD driver can pull an approved ship onto the runway when it reaches the
// head of the FIFO line (the same call decideShip and the reaper tick make).
export async function runShip(shipId, { mode = MODE } = {}) {
  const ship = await one(`SELECT * FROM ship_request WHERE id=$1`, [shipId]);
  if (!ship || ship.status !== 'approved') return;
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [ship.xell_id]);
  const project = await one(`SELECT * FROM project WHERE id=$1`, [ship.project_id]);

  // THE LANDING PAD's FIFO gate. This ship is approved, but the runway may be occupied (another
  // ship building, a landing merging) or an EARLIER approval may be ahead in line. If so, leave it
  // 'approved' and wait — the pad driver pulls it on when its turn comes. runShip already defers
  // on a held prod lock; this is the same idea widened to one shared, chronological queue.
  if ((await shouldProcessNow(ship.project_id, 'shipment', ship.id)) === 'wait') {
    logline('ship', `${xell.slug} ship WAITING — landing pad busy or an earlier item is ahead (FIFO)`);
    return; // stays 'approved'; the pad driver / tick retries when the runway frees
  }
  // The site this ship targets — recorded at request time; NULL = the default (or a pre-sites
  // row), which keeps every legacy behavior including the shared 'prod' lock key.
  const site = ship.site_id ? await one(`SELECT * FROM deploy_site WHERE id=$1`, [ship.site_id]) : null;
  const lockKey = lockKeyFor(site);

  // The lock is the queenzee's to grant — the zee never touches it. Atomic and PER SITE: if
  // another xell holds THIS site, this ship WAITS as 'approved' rather than queue-jumping; the
  // reaper retries when free. A different prod site's lock does not block it.
  const got = await one(
    `INSERT INTO deploy_lock (project_id, container, xell_id, zee_id, phase, task, ship_id, site_id)
       VALUES ($1,$2,$3,$4,'shipping',$5,$6,$7)
       ON CONFLICT (project_id, container) DO NOTHING RETURNING *`,
    [project.id, lockKey, xell.id, ship.zee_id, ship.reason || 'ship to production', ship.id, site?.id || null]);
  if (!got) {
    const held = await one(
      `SELECT dl.*, x.slug FROM deploy_lock dl JOIN xell x ON x.id=dl.xell_id
         WHERE dl.project_id=$1 AND dl.container=$2`, [project.id, lockKey]);
    logline('ship', `${xell.slug} ship WAITING — ${held?.slug || 'another xell'} holds ${lockKey}`);
    return; // stays 'approved'; tick() retries when the lock frees
  }
  broadcast('xell', { id: xell.id });
  logline('lock', `queenzee ASSIGNED ${lockKey} lock to ${xell.slug} for ship ${String(ship.commit).slice(0, 8)}`);

  // From here to the terminal UPDATE the ship is 'shipping', and 'shipping' with no live process
  // is the wedge that held prod all night on 2026-07-18: a throw anywhere in this stretch used to
  // be swallowed by the caller's .catch, leaving the row open forever and the lock with no
  // countdown. Register as live, and no matter what throws, land on 'failed' with the countdown
  // running — the site frees itself even when the deploy machinery is what broke.
  liveShips.add(ship.id);
  try {
    await runShipBody(ship, xell, project, site, lockKey, mode);
  } catch (e) {
    try {
      const done = await one(
        `UPDATE ship_request SET status='failed', finished_at=now(), error=$2
           WHERE id=$1 AND status IN ('approved','shipping') RETURNING *`,
        [ship.id, `ship machinery crashed mid-run: ${String(e.message || e).slice(0, 1400)}`]);
      if (done) broadcast('ship', done);
      await q(
        `UPDATE deploy_lock SET phase='failed', auto_release_at=COALESCE(auto_release_at, now() + ($2 || ' seconds')::interval)
          WHERE ship_id=$1 AND held=false`, [ship.id, String(AUTO_RELEASE_SEC)]);
      broadcast('xell', { id: xell.id });
      // A crashed carrier fails its riders too — never leave them stranded pointing at a dead ship.
      await resolveBundleRiders(ship.id, false, ship.commit).catch(() => {});
      logline('ship', `ship ${String(ship.commit).slice(0, 8)} CRASHED mid-run — marked failed, ${lockKey} countdown started: ${e.message}`);
    } catch { /* the DB is what failed — the tick() stranded sweep is the backstop */ }
  } finally {
    liveShips.delete(ship.id);
  }
}

async function runShipBody(ship, xell, project, site, lockKey, mode = MODE) {
  const shipping = await one(
    `UPDATE ship_request SET status='shipping', started_at=now() WHERE id=$1 RETURNING *`, [ship.id]);
  broadcast('ship', shipping);

  // Production's BUILD SOURCE is local main — not the xell's worktree, and not the xource
  // checkout's wandering HEAD (which is what this actually built until 2026-07-16). origin is a
  // backup and is never read. This is the anti-band-aid rule.
  // Only the roles the ZEE NAMED (ship.targets, validated at request time) — a webapp-only change
  // has no business recreating the live prod server as a side effect.
  // Only THIS site's containers. NULL-site rows are pre-migration legacy and belong to the
  // default site; a named non-default site builds exactly its own inventory.
  const cs = await q(
    `SELECT * FROM container WHERE project_id=$1 AND tier='prod' AND role = ANY($2)
       AND build_script IS NOT NULL
       AND ($3::uuid IS NULL AND (site_id IS NULL OR site_id IN
              (SELECT id FROM deploy_site WHERE project_id=$1 AND tier='prod' AND is_default))
            OR site_id = $3::uuid OR ($3::uuid IS NOT NULL AND site_id IS NULL AND $4))
       ORDER BY role DESC`,
    // DESC (webapp before server) is load-bearing for self-hosting (§6.3): Zeehive's server
    // target is the SELF-restart — it kills this very process seconds after it runs, so anything
    // ordered after it never ships (and boot recovery would then mark the ship 'shipped' off the
    // OLD webapp container still answering its URL). The suicide step goes last. For projects
    // whose targets are independent container builds, the order never mattered.
    [project.id, ship.targets?.length ? ship.targets : SHIPPABLE, site?.id || null, !!site?.is_default]);

  const results = [];
  let ok = cs.length > 0;

  // SCHEMA FIRST, code second. Pending server/sql/migrations/*.sql at the approved sha are
  // applied before any container builds: new code must never come up against the old schema, and
  // a failed migration must fail the ship while prod still runs the old code untouched. This is
  // the half of "prod builds from main" that containers alone cannot deliver — dev builds fresh
  // databases from sql/schema/ and always has every table; prod is never rebuilt, so without this
  // step it drifts behind main's schema forever (7 tournament columns deep, as of this morning).
  if (ok && ship.skip_migrations) {
    // The zee scoped this ship to CODE ONLY and the human approved that scope. Skipping is a
    // recorded step, not an absence — the results must say what was deliberately not run.
    const skipped = Array.isArray(ship.migrations) ? ship.migrations : [];
    if (skipped.length) {
      results.push({ role: 'migrations', ok: true, method: 'skipped-by-zee',
        error: null, log: `db scope: SKIPPED at the zee's request — ${skipped.length} pending file(s) NOT applied:\n`
          + skipped.join('\n') + (ship.db_note ? `\n\nzee's assessment: ${ship.db_note}` : '') });
      logline('ship', `migrations SKIPPED by zee scope (${skipped.length} pending file(s) not applied)`);
    }
  } else if (ok && mode !== 'real') {
    // A NESTED QUEENZEE MUST NOT MIGRATE THE REAL PRODUCTION DATABASE. SHIP_MODE=simulate has always
    // meant "model the deploy" — every build script exits early on mode=simulate (scripts/*.sh) — but
    // this step never read it, so the one part of a ship that is NOT delegated to a script went
    // straight through: applyMigrations resolves the prod db container FROM A FLEET ROW and runs DDL
    // in it over `docker exec … psql`. A xell's database is a CLONE of the meta-DB, so the approved
    // ship_request rows a nested queenzee's reaper picks up every 5s are the REAL fleet's, and the
    // container it would have opened is the REAL production database. Report the files, run none.
    const would = Array.isArray(ship.migrations) ? ship.migrations : [];
    results.push({ role: 'migrations', ok: true, method: 'not-applied-simulate', applied: [], error: null,
      log: `SHIP_MODE=simulate: this queenzee models the fleet, it does not write to the production `
        + `database. ${would.length} pending file(s) NOT applied:\n${would.join('\n') || '(none recorded)'}` });
    logline('ship',
      `migrations NOT applied — SHIP_MODE=simulate: this queenzee models the fleet, it does not write to `
      + `the production database. Would have applied ${would.length} file(s)`
      + `${would.length ? `: ${would.join(', ')}` : ''}`);
  } else if (ok) {
    const mig = await applyMigrations(project, ship.commit, site);
    if (mig.applied?.length || !mig.ok) {
      results.push({ role: 'migrations', ok: mig.ok, applied: mig.applied, error: mig.ok ? null : mig.error });
    }
    if (!mig.ok) ok = false;
  }

  if (!cs.length) {
    ok = false;
    results.push({ error: 'no prod container has a build_script configured — nothing to ship' });
  }

  // Materialize the prod environment from the meta-DB onto the xource's .env — the file
  // ship-prod.sh reads (<source_path>/.env) — so the meta-DB is the source of truth and the on-disk
  // file a projection (migration 043). SAFE BY CONSTRUCTION: an EMPTY prod environment is skipped,
  // leaving the existing .env untouched, so ships behave exactly as before until a human fills the
  // environment in the console. Only in real mode (simulate writes nothing, deploys nothing) and
  // never fatal — a materialize failure falls back to the on-disk .env, which is today's behaviour.
  if (ok && mode === 'real') {
    try {
      const mat = await materializeEnvFile(project.id, 'prod', join(project.repo_root, '.env'));
      if (mat.written) {
        logline('ship', `prod .env written from meta-DB environment "${mat.environment}" (${mat.count} vars`
          + `${mat.backup ? `, prior file backed up → ${mat.backup}` : ''})`);
      } else {
        logline('ship', `prod .env NOT rewritten — ${mat.reason}`);
      }
      results.push({ role: 'environment', ok: true, ...mat });
    } catch (e) {
      logline('ship', `prod .env materialize FAILED (continuing with the on-disk .env): ${e.message}`);
      results.push({ role: 'environment', ok: true, skipped: true, reason: `materialize error: ${e.message}` });
    }
  }

  for (const c of cs) {
    if (!ok) break;   // a failed migration means NO container builds — old code, old schema, intact
    // ship.commit is the sha the HUMAN approved. Passing it (rather than letting the script say
    // "main") also means a main that moved between approval and build cannot smuggle in commits
    // nobody signed off on.
    // Live-feed every build line TWICE: to the logbus (the ▚ terminal firehose), and as a
    // 'ship-log' event addressed to THIS ship — the request's own card renders that stream, so
    // watching a deploy doesn't mean fishing its lines out of everything else the hive is saying.
    // The cxell-image override, decided per-ship by a HUMAN on the card (allow_stale_cxell_image,
    // migration 055) and passed EXPLICITLY here. Unticked, nothing is set: the build script's
    // default is fatal, and a queenzee genuinely started with CXELL_IMAGE_REQUIRED=0 (the
    // operator-level escape, for a host with no reachable docker daemon) still inherits its own
    // env. Ticked, this one build is told to report a failed cxell-image rebuild without failing
    // the ship — a choice that is on the request afterwards, not a setting nobody can see.
    const extraEnv = ship.allow_stale_cxell_image ? { CXELL_IMAGE_REQUIRED: '0' } : {};
    const r = await runScript(c, project.repo_root, ship.commit, (line) => {
      logline('ship', `[${c.role}] ${line}`);
      broadcast('ship-log', { id: ship.id, role: c.role, line, ts: Date.now() });
    }, extraEnv, mode);

    // Record what prod now RUNS — the same projection lib/build.js does for dev builds. A ship
    // used to skip this entirely, so a successful deploy left last_build_commit untouched and
    // nothing in the system could say what code production was serving. That is why prod's chips
    // read "never built" while the site was up, and why its card had nothing to compare.
    const row = await one(
      `UPDATE container
          SET health = $2::container_health,
              last_build_commit = COALESCE($3, last_build_commit),
              last_built_at = CASE WHEN $4 THEN now() ELSE last_built_at END
        WHERE id=$1 RETURNING *`,
      [c.id, r.ok ? 'up' : 'down',
        r.json?.head && r.json.head !== 'unknown' ? r.json.head : null, r.ok]);
    if (row) broadcast('container', row);

    results.push({ container: c.name, role: c.role, ok: r.ok, method: r.json?.method || null,
                   error: r.ok ? null : r.err, log: r.log || null });
    if (!r.ok) { ok = false; break; }   // stop at the first failure — do not half-ship prod
  }

  // Build logs are arbitrary bytes and ride along in `results`; postgres jsonb REJECTS the
  // escaped-NUL sequence (backslash-u-0000), so one NUL anywhere in a build's output would throw
  // HERE — at the exact statement whose failure used to strand the ship at 'shipping'.
  const done = await one(
    `UPDATE ship_request SET status=$2, finished_at=now(), containers=$3::jsonb, error=$4
       WHERE id=$1 RETURNING *`,
    [ship.id, ok ? 'shipped' : 'failed', JSON.stringify(results).replaceAll('\\u0000', ''),
      ok ? null : (results.find((r) => !r.ok)?.error || 'ship failed').slice(0, 1500)]);
  broadcast('ship', done);
  logline('ship', ok
    ? `SHIPPED ${String(ship.commit).slice(0, 8)} to prod from ${xell.slug} (${mode})`
    : `ship FAILED for ${xell.slug}: ${done.error}`);

  // If this ship was a BUNDLE carrier, resolve its riders now — one deploy, one verdict for all.
  await resolveBundleRiders(ship.id, ok, ship.commit);

  // Countdown starts either way: a failed ship must not sit on prod forever either.
  const lock = await one(
    `UPDATE deploy_lock SET phase=$2, auto_release_at = now() + ($3 || ' seconds')::interval
       WHERE project_id=$1 AND container=$5 AND ship_id=$4 RETURNING *`,
    [project.id, ok ? 'awaiting-verification' : 'failed', String(AUTO_RELEASE_SEC), ship.id, lockKey]);
  if (lock) broadcast('xell', { id: xell.id });
  notifyShipDone({ project, xell, ok, request: done, seconds: AUTO_RELEASE_SEC });
  // THE REFLECTION STAGE. A successful ship is the moment the zee knows the most about its own
  // change, and until now that knowledge died with the cxell. Re-invoke it to review what went live
  // and report improvements/errors to its MANAGER (or, with no manager, to the console). Opens no
  // gate, blocks nothing, and a torn-down cxell just logs — so it can never affect the ship itself.
  //
  // The reflection is a HARNESS SETTING (migration 112, `enable_reflection`): a harness whose
  // wearers should not be re-invoked after a ship turns it OFF; the default keeps it ON, which is
  // exactly how it always behaved.
  if (ok) {
    let reflect = true;
    try {
      const { harnessArchivalSettings } = await import('../lib/conversations.js');
      reflect = (await harnessArchivalSettings(xell)).enable_reflection;
    } catch (e) { logline('ship', `${xell.slug}: could not read enable_reflection (${e.message}) — reflecting anyway`); }
    if (reflect) {
      setImmediate(() => nudgeXellForReflection(xell.id, { commit: ship.commit })
        .then((r) => { if (!r?.nudged) logline('ship', `${xell.slug}: no reflection pass — ${r?.reason || r?.error || 'no live cxell'}`); })
        .catch(() => {}));
    } else {
      logline('ship', `${xell.slug}: reflection skipped (harness enable_reflection = false)`);
    }
  }
  // The runway is free — pull the next queued landing/ship onto the pad promptly (the pad tick is
  // the backstop). Best-effort so a failure here never affects the ship's own result.
  setImmediate(() => processPad(project.id).catch(() => {}));
}

// How much of a build's output survives on the ship_request row. The tail, not the head: the
// verdict (and any failure) is at the bottom of a build log, the cache-hit noise at the top.
const LOG_TAIL_BYTES = 64 * 1024;

// `extraEnv` is passed EXPLICITLY into the child rather than left to cleanGitEnv's inheritance of
// the queenzee's own process env — a per-ship decision (see allowStaleCxellImage below) must not
// depend on what the orchestrator happens to have been started with.
function runScript(container, sourcePath, buildRef = 'main', onLine = null, extraEnv = {}, mode = MODE) {
  return new Promise((res) => {
    // A bare `bash` (the stored default on every prod container) resolves to C:\Windows\System32\
    // bash.exe (WSL) ahead of Git bash on Windows — with no distro it exits 1 with "WSL has no
    // installed distributions" and builds NOTHING, which is exactly how a prod ship wedged at
    // 'shipping' having deployed nothing. Dev builds already go through resolveBash(); ships must
    // too. A real interpreter set by an operator (sh, pwsh, …) is still respected.
    const exec = (!container.build_exec || container.build_exec === 'bash') ? resolveBash() : container.build_exec;
    const p = spawn(exec, [container.build_script, sourcePath, container.role, container.docker_ctx || '', mode, buildRef],
      { env: cleanGitEnv(extraEnv), windowsHide: true });
    let out = '', err = '', buf = '', settled = false;
    // Line-buffered live feed (stdout AND stderr — docker build writes its progress to stderr).
    // The ship used to run in total silence and only a 1500-char error tail survived a failure;
    // "ledger unreadable: " with nothing after the colon cost a day. Never again silent.
    const emit = (d) => {
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    };
    p.stdout.on('data', (d) => { out += d; emit(String(d)); });
    p.stderr.on('data', (d) => { err += d; emit(String(d)); });

    // One resolution, whichever event gets there first. 'close' is the honest one (stdio fully
    // drained) — but 'close' waits on the PIPES, not the child: a build whose grandchild (a
    // docker CLI mid-upload over a dead link) inherits stdout and outlives bash never fires it,
    // and that exact shape left runShip awaiting a process that no longer existed. So: resolve on
    // 'close' when it comes, on 'exit' + a short drain grace when it doesn't, and on the watchdog
    // when nothing exits at all.
    const finish = (forcedErr = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (buf.trim() && onLine) onLine(buf.trimEnd());
      const line = out.trim().split('\n').filter(Boolean).pop();
      let json = null; try { json = JSON.parse(line); } catch { /* no json line */ }
      const full = out + (err ? `\n--- stderr ---\n${err}` : '');
      res({ ok: !forcedErr && !!json && json.ok !== false, json,
            err: forcedErr || (err || out).slice(-1500),
            log: full.slice(-LOG_TAIL_BYTES) });
    };
    const watchdog = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
      finish(`build killed after ${Math.round(BUILD_TIMEOUT_MS / 60000)} minutes without finishing — `
        + 'not slow, gone (a hung build must fail the ship, never hold its site\'s lock open)');
    }, BUILD_TIMEOUT_MS);
    p.on('close', () => finish());
    p.on('exit', () => setTimeout(() => finish(), 10000));
    p.on('error', (e) => finish(String(e.message)));
  });
}

// ── the lock's own lifecycle ─────────────────────────────────────────────────
// HOLD cancels the countdown for a human who is actively verifying. Only a human can do this —
// there is no zee path to it, by design.
export async function holdProdLock(projectId, by = 'human@console', siteKey = null) {
  const key = siteKey ? `prod@${siteKey}` : 'prod';
  const row = await one(
    `UPDATE deploy_lock SET held=true, auto_release_at=NULL
       WHERE project_id=$1 AND container=$2 RETURNING *`, [projectId, key]);
  if (!row) throw new Error(`nobody holds ${key}`);
  broadcast('xell', { id: row.xell_id });
  logline('lock', `${key} lock HELD open by ${by} — countdown cancelled, release is manual now`);
  return row;
}

export async function forceReleaseProdLock(projectId, by = 'human@console', siteKey = null) {
  const key = siteKey ? `prod@${siteKey}` : 'prod';
  const row = await one(`SELECT * FROM deploy_lock WHERE project_id=$1 AND container=$2`, [projectId, key]);
  if (!row) throw new Error(`nobody holds ${key}`);
  await q(`DELETE FROM deploy_lock WHERE id=$1`, [row.id]);
  broadcast('xell', { id: row.xell_id });
  broadcast('ship', { id: row.ship_id });
  logline('lock', `${key} lock FORCE-RELEASED by ${by}`);
  return { released: true };
}

// Reaper tick: release expired locks, and start any ship that was waiting for prod to free up.
export async function tick() {
  // 'prod' is the default site's key; 'prod@<site>' the others — expire them all the same way.
  const expired = await q(
    `DELETE FROM deploy_lock
       WHERE container LIKE 'prod%' AND held=false AND auto_release_at IS NOT NULL AND auto_release_at <= now()
       RETURNING *`);
  for (const l of expired) {
    const x = await one(`SELECT slug FROM xell WHERE id=$1`, [l.xell_id]);
    logline('lock', `${l.container} lock auto-released from ${x?.slug || l.xell_id} (countdown expired) — that site is free`);
    broadcast('xell', { id: l.xell_id });
  }
  // A 'shipping' row this process is not actually running is already dead — its promise crashed,
  // or its build resolved into nothing. Boot recovery only fires at boot, and the queenzee stays
  // up for weeks; without this sweep such a row reads "shipping now" forever and its site's lock
  // (countdown never started) holds prod with nothing behind it. Recover DURING the run, from the
  // same evidence boot recovery uses.
  const stranded = (await q(`SELECT * FROM ship_request WHERE status='shipping'`))
    .filter((s) => !liveShips.has(s.id));
  for (const s of stranded) {
    await recoverStrandedShip(s, 'its deploy process died mid-run')
      .catch((e) => console.error('[ship] stranded recovery failed:', e.message));
  }
  // Approved-but-waiting ships: their site may be free now. runShip itself is the arbiter — it
  // no-ops (stays 'approved') when the SITE's lock is held, so trying all of them is safe and a
  // busy default site cannot starve a free second site.
  const waiting = await q(
    `SELECT s.id FROM ship_request s WHERE s.status='approved' ORDER BY s.decided_at LIMIT 5`);
  for (const w of waiting) await runShip(w.id).catch((e) => console.error('[ship] retry failed:', e.message));
  return { released: expired.length, recovered: stranded.length, started: waiting.length };
}

// Recover ships orphaned by a restart (spec §6.3). A ship stuck at 'shipping' at boot has no
// process behind it — either the queenzee died mid-ship, or a SELF-ship deliberately restarted
// us. At boot the target containers' health has been… whatever it is; probe what we can NOW and
// finish the record from evidence: every targeted thing answering → shipped (this is exactly how
// a self-ship completes: the new process being alive IS the health check); anything else → failed
// with a truthful note. Either way the site's lock countdown starts so nothing holds prod forever.
export async function recoverOrphanShips() {
  const stranded = await q(`SELECT * FROM ship_request WHERE status='shipping'`);
  for (const ship of stranded) await recoverStrandedShip(ship, 'orphaned by a queenzee restart mid-ship');
  return stranded.length;
}

// Complete ONE stranded 'shipping' row from evidence. Shared by boot recovery, the tick sweep,
// and the reaper's done-path — three different ways to notice the same fact: nothing alive is
// running this ship. `why` names the caller's evidence in the failure note.
async function recoverStrandedShip(ship, why) {
  const cs = await q(
    `SELECT name, url, docker_ctx, health FROM container
      WHERE project_id=$1 AND tier='prod' AND role = ANY($2)`,
    [ship.project_id, ship.targets?.length ? ship.targets : SHIPPABLE]);
  let allUp = cs.length > 0;
  for (const c of cs) {
    if (c.docker_ctx == null && c.url) {
      // process role — probe it live; the URL answering is the whole truth
      try { const r = await fetch(c.url, { signal: AbortSignal.timeout(5000) }); allUp = allUp && r.status < 500; }
      catch { allUp = false; }
    } else {
      allUp = allUp && c.health === 'up';   // container role — trust the monitor's last word
    }
  }
  // COALESCE the decider fields: a normally-approved ship already has them, but the
  // ship_decided_has_decider CHECK requires them on any terminal status, so recovery must
  // never produce a row that cannot land.
  const done = await one(
    `UPDATE ship_request SET status=$2, finished_at=now(), error=$3,
            decided_at=COALESCE(decided_at, now()), decided_by=COALESCE(decided_by, 'recovery@queenzee')
      WHERE id=$1 AND status='shipping' RETURNING *`,
    [ship.id, allUp ? 'shipped' : 'failed',
      allUp ? null : `${why}; targets not verifiably up — re-request`]);
  if (!done) return;   // someone else landed it between our SELECT and now — nothing to recover
  broadcast('ship', done);
  // A recovered carrier resolves its riders to the same verdict — they never outlive their carrier.
  await resolveBundleRiders(ship.id, done.status === 'shipped', ship.commit).catch(() => {});
  logline('ship', `recovered stranded ship ${String(ship.commit).slice(0, 8)} → ${done.status}`
    + (allUp ? ' (health check passed — the self-ship pattern)' : ` (${done.error})`));
  // start the countdown on its lock if the dying process never did
  await q(
    `UPDATE deploy_lock SET auto_release_at = COALESCE(auto_release_at, now() + ($2 || ' seconds')::interval)
      WHERE project_id=$1 AND ship_id=$3 AND held=false`,
    [ship.project_id, String(AUTO_RELEASE_SEC), ship.id]);
}

// ── the reaper's half: a xell marked done takes its ship state with it ────────
// "Mark done" used to ignore ships entirely, and the 2026-07-18 wedge is what that looks like:
// the xell retired while its stranded ship kept reading "shipping now" forever and the prod lock
// sat under it with nothing left alive to release either one. Called by reapXell BEFORE any
// teardown. A ship this process is ACTIVELY running blocks the reap instead — releasing prod's
// lock out from under a live deploy is how two builds end up interleaved on the same site.
export async function releaseXellShips(xellId, by = 'reaper@done') {
  const active = (await q(`SELECT * FROM ship_request WHERE xell_id=$1 AND status='shipping'`, [xellId]))
    .filter((s) => liveShips.has(s.id));
  if (active.length) {
    return { ok: false, error: `a ship (${String(active[0].commit).slice(0, 8)}) is deploying to prod RIGHT NOW — `
      + 'let it finish (or force-release its site\'s lock) before marking this xell done' };
  }
  // Undecided requests die with the xell — approving one later would deploy for nobody.
  const closed = await q(
    `UPDATE ship_request SET status='rejected', decided_at=now(), decided_by=$2
      WHERE xell_id=$1 AND status IN ('pending','approved') RETURNING *`, [xellId, by]);
  for (const s of closed) {
    broadcast('ship', s);
    logline('ship', `ship request ${String(s.commit).slice(0, 8)} withdrawn — its xell was marked done`);
    // If a withdrawn ship was a BUNDLE carrier, free its riders back to plain-deferred (bundled_into
    // NULL) so a human can re-bundle or resume them — they must not point at a rejected carrier.
    const freed = await q(
      `UPDATE ship_request SET bundled_into=NULL WHERE bundled_into=$1 RETURNING id`, [s.id]);
    for (const f of freed) broadcast('ship', { id: f.id });
  }
  // Stranded 'shipping' rows complete from evidence, exactly like boot recovery.
  const stranded = await q(`SELECT * FROM ship_request WHERE xell_id=$1 AND status='shipping'`, [xellId]);
  for (const s of stranded) await recoverStrandedShip(s, 'its xell was marked done while the ship was stranded');
  // And the lock: done means the human is finished verifying — the site frees NOW, not on a timer.
  const locks = await q(`DELETE FROM deploy_lock WHERE xell_id=$1 RETURNING *`, [xellId]);
  for (const l of locks) {
    broadcast('xell', { id: xellId });
    logline('lock', `${l.container} lock released — its holder was marked done`);
  }
  return { ok: true, withdrawn: closed.length, recovered: stranded.length, locks_released: locks.length };
}

export function startShipReaper() {
  if (process.env.SHIP_REAPER_ENABLED === 'false') {
    console.log('[queenzee] ship lock reaper DISABLED');
    return;
  }
  const interval = Number(process.env.SHIP_TICK_MS) || 5000;
  setInterval(() => tick().catch((e) => console.error('[ship] tick:', e.message)), interval);
  console.log(`[queenzee] ship lock reaper started (${interval}ms, auto-release ${AUTO_RELEASE_SEC}s, mode=${MODE})`);
}
