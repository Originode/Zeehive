// Reaper — despawns a xell once a HUMAN marks its task done.
// Deterministic teardown: release resources → remove worktree/branch → retire rows.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { cleanGitEnv } from '../lib/git.js';
import { removeXellImages } from '../lib/images.js';
import { logline, activity } from '../lib/logbus.js';
import { resolveBash } from '../lib/bash.js';
import { resolveSite } from '../lib/sites.js';
import { dropCloneDb } from '../lib/xell-db.js';
import { removeCxell, cxellName } from '../lib/cxell.js';
import { stopAndRemoveContainer } from '../lib/docker.js';
import { MID_TURN_STATUSES } from '../lib/zee-turn.js';
import { releaseXellShips } from './shipgate.js';
import { collectDispatchLoss, reportDispatchLoss } from '../lib/dispatch-loss.js';

// Same switch every other real-side-effect module reads (intake, pool, xell-db, machines, harness,
// the .zeehive.env reconcile): 'real' touches machines, anything else models. A teardown is the
// most destructive thing the queenzee does with a fleet row — worktree, branch, containers, images
// and the cxell, all named from `xell`/`container` — and a xell's database is a CLONE of the
// meta-DB, so a NESTED queenzee's rows are the REAL fleet's. It does not even need a human: the
// boot janitor below walks every 'tearing-down' row it inherited in the clone, and the pool
// maintainer trims 'ready' surplus down to POOL_TARGET_READY (0 in a xell) five xells a tick. So in
// simulate reapXell RETIRES THE ROW and touches no machine — see the destructive block below.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// Boot recovery: a queenzee killed mid-reap (a self-ship, a crash) strands rows at
// 'tearing-down' — worktree possibly gone, row never 'retired', and the dashboard renders
// every non-retired xell, so the pile looks like rogues that never prune (2026-07-19: 107 of
// them from the triple-queenzee kill). reapXell is idempotent, so just walk them the rest of
// the way. Serial and best-effort — this is a boot janitor, not a hot path.
export async function recoverOrphanTeardowns() {
  const rows = await q(
    `SELECT id, slug FROM xell WHERE status = 'tearing-down' AND NOT is_production`);
  if (!rows.length) return { finished: 0 };
  logline('reaper', `finishing ${rows.length} teardown(s) stranded by a previous queenzee's death`);
  let finished = 0;
  for (const x of rows) {
    const r = await reapXell(x.id, 'stranded-teardown').catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) finished++;
    else logline('reaper', `stranded teardown ${x.slug} still stuck: ${r.error}`);
  }
  logline('reaper', `stranded teardowns: ${finished}/${rows.length} finished`);
  return { finished };
}

// ── IS THERE A ZEE MID-TURN IN THERE? ────────────────────────────────────────
//
// The one question the reap guard turns on, and it used to be asked wrong. The old test was
//
//     active = cli_active === true || status in (spawning, online, working)
//
// — the zee's own status ORed with the MONITOR's flag. Those two do not mean the same thing, and
// for a cxell zee the second one does not mean "working" at all:
//
//   • `zee.status` is the queenzee's OWN record of the turn. It writes 'working' when it starts the
//     headless run and 'idle' + last_stop_reason='end_turn' when that run returns (intake.js). For a
//     cxell that is the only lifecycle there is — hooks (Channel A) are not installed in the cage and
//     the passive poller (Channel B) skips entrypoint='cxell-cli' outright.
//   • `zee.cli_active` is monitor.js's probe. For a cxell it is cxellZeeActive() — a broad
//     `pgrep -f '(claude|codex|kimi)'` INSIDE the container (AGENT_PROC_PATTERN). The cage is KEPT
//     after the turn so commits stay collectible, and the moment anyone opens its terminal or sends
//     it a message, tmux starts zee-attach.sh, which — once the headless turn is over — runs
//     `claude --resume <sid>` interactively in the pane and leaves it there for the life of the
//     container. That resting process matches the probe. So cli_active is "an agent is ATTACHED",
//     not "an agent is WORKING", and once true it stays true forever.
//
// ORing them therefore made the NORMAL END STATE OF EVERY CXELL JOB — turn over, zee idle, a resting
// session in the pane — read as ACTIVE, and the refusal said so in its own contradictory words:
// "its zee is still idle (monitor confirms it is really active)". Five human-approved done
// suggestions were refused that way in one hour, and the humans were told nothing.
//
// So: THE ZEE'S OWN STATUS DECIDES, and the monitor's flag is reported as the evidence it actually
// is (attached / not attached). Nothing was widened for a zee that is genuinely mid-turn: every
// status the old test refused on it still refuses on, force is still required to get past it, and
// force is still not the default anywhere.
//
// THE GAP THIS USED TO NAME, and what now covers it — with the part that still does not. An
// INTERACTIVE turn (a message typed into the resting pane session) starts a turn no hook, no poller
// and no pgrep of ours can observe, so such a zee read 'idle' here for the whole of it. Closing it
// needed "the cage itself to report turn-start/turn-end (the `zee` CLI and token are already in
// there)", and that is now what happens: the vendor CLI's own turn hooks call `zee turn --start` /
// `--end` (queenzee/self.js selfTurn), installed into the cage at spawn.
//
// What it does NOT cover, so nobody reads more into a row than it can carry: cages spawned BEFORE
// that install (their hooks were never written), runtimes with no measured hook of their own (codex,
// kimi — lib/cxell-runtimes.js turnHookCmd declares none rather than guessing), and a session whose
// hook simply failed. In all of those the old blindness stands — so `force` and the human's typed
// confirmation in front of this remain what that race is for.
//
// The list itself lives in lib/zee-turn.js — the MESSAGE router asks the same question ("is a
// headless run going on in that cage right now?") to decide queue-vs-resume, and two copies of
// these three statuses is two answers waiting to disagree. Re-exported so this file still names it.
export { MID_TURN_STATUSES };

const agoText = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

// Pure — takes the zee row (or null) and returns the verdict plus the evidence behind it, so every
// caller can SAY which signal decided and when that signal last saw anything.
export function midTurnVerdict(live) {
  if (!live) {
    return { active: false, decided_by: 'zee-rows', zee_status: null, attached: false,
             last_activity_at: null, why: 'no live zee is bound to it' };
  }
  const attached = live.cli_active === true;
  const seen = live.last_event_at || live.last_monitor_at || null;
  const base = { zee_status: live.status, attached, last_activity_at: seen,
                 monitor_source: live.monitor_source || null, monitor_at: live.last_monitor_at || null };
  if (MID_TURN_STATUSES.includes(live.status)) {
    return { ...base, active: true, decided_by: 'zee-status',
      why: `the ZEE'S OWN STATUS says it is ${live.status} — a turn is in flight (last seen ${agoText(seen)})` };
  }
  const cage = live.entrypoint === 'cxell-cli';
  return { ...base, active: false, decided_by: 'zee-status',
    why: `the ZEE'S OWN STATUS says ${live.status} — its turn ended (last seen ${agoText(seen)})`
       + (attached
         ? `; the monitor (${live.monitor_source || 'probe'}, ${agoText(live.last_monitor_at)}) only proves a session `
           + `is ATTACHED${cage ? ' — after a turn that is the `claude --resume` zee-attach.sh leaves in its pane' : ''}`
         : `; the monitor (${live.monitor_source || 'probe'}) sees no live agent session either`) };
}

export async function reapXell(xellId, reason = 'task-done', { force = false, mode = PROVISION_MODE } = {}) {
  const xell = await one(`SELECT * FROM xell WHERE id = $1`, [xellId]);
  if (!xell) return { ok: false, error: 'xell not found' };
  if (xell.is_production) return { ok: false, error: 'production is protected — cannot be decommissioned by a zee' };

  // An ACTIVE xell has a zee still working in it. Tearing it down kills the agent mid-task and
  // deletes its worktree + branch. Refuse unless the caller explicitly forces it — this lives on
  // the server, not just the UI, because a UI-only guard is bypassed by anyone (human OR AI)
  // calling the API directly. That is exactly how a working xell got destroyed.
  let verdict = null;
  if (!force) {
    const live = await one(
      `SELECT id, status, cli_active, monitor_source, last_monitor_at, last_event_at, entrypoint
         FROM zee
        WHERE xell_id=$1 AND status IN ('spawning','online','working','idle') ORDER BY created_at DESC LIMIT 1`,
      [xellId]);
    verdict = midTurnVerdict(live);
    if (verdict.active) {
      return {
        ok: false, active: true, xell: xell.slug,
        decided_by: verdict.decided_by, zee_status: verdict.zee_status, attached: verdict.attached,
        last_activity_at: verdict.last_activity_at,
        error: `xell "${xell.slug}" is ACTIVE — ${verdict.why}.`
             + ' Tearing it down kills the agent mid-task and deletes its worktree + branch.'
             + ' Pass force:true to do it anyway.',
      };
    }
  }

  // WAS THIS A DISPATCH NOBODY WILL EVER HEAR ABOUT? Read the evidence NOW — the teardown below
  // stamps every zee row and deletes the containers, so afterwards the question "did a zee ever run
  // in here?" is answered by the very thing being reported on. The verdict is delivered at the end,
  // once the xell is actually gone (lib/dispatch-loss.js).
  const loss = await collectDispatchLoss(xell, reason).catch(() => ({ lost: false }));

  // ── SHIPS AND THE PROD LOCK GO WITH THE XELL ────────────────────────────────
  // Open ship requests are withdrawn, a stranded 'shipping' row is completed from evidence, and
  // the xell's deploy lock is released — BEFORE teardown, or "done" leaves a card reading
  // "shipping now" forever with prod locked under it (2026-07-18, the whole night). The one case
  // that blocks instead: a ship this queenzee is actively deploying right now — force does not
  // override that either, because yanking prod's lock mid-build is worse than waiting.
  const ships = await releaseXellShips(xellId, `done:${reason}`);
  if (!ships.ok) return { ok: false, error: ships.error };

  // ── PRODUCTION IS DISCONNECTED, NEVER TORN DOWN ─────────────────────────────
  // A /xell-prod xell has the LIVE production db, server and webapp as its assigned containers.
  // Marking it done must release them, not reap them.
  //
  // Today nothing below could delete them anyway: every teardown path is scoped by ownership —
  // `DELETE FROM container WHERE owner_xell_id=$1`, removeXellImages' same filter, and
  // spin-env.sh purge's `omnibiz-spin-<slug>` project on the DEV context — and prod's containers
  // are shared, so owner_xell_id is NULL and they match none of it.
  //
  // That is ownership saving us, not intent. Nothing here SAYS "never delete prod". One change
  // from `owner_xell_id = $1` to a xell_uses_container join — an entirely reasonable-looking
  // refactor, since that junction is what the card renders from — and marking a data xell done
  // would delete production. So: state the rule, and unlink FIRST, before any teardown machinery
  // runs. After this point the xell has no prod containers to lose.
  const prodLinks = await q(
    `SELECT c.name, c.role FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1 AND c.tier = 'prod'`, [xellId]);
  if (prodLinks.length) {
    await q(
      `DELETE FROM xell_uses_container uc USING container c
        WHERE uc.container_id = c.id AND uc.xell_id = $1 AND c.tier = 'prod'`, [xellId]);
    // Drop the coupling too, so a half-torn-down row can never answer the prod guard with "yes".
    await q(`UPDATE xell SET db_coupling='db-shared-dev' WHERE id=$1
               AND db_coupling IN ('db-shared-prod','db-prod-readonly')`, [xellId]);
    // A MANAGER held prod through its OWN read-only postgres role. Give it back: a credential that
    // outlives the agent it was minted for is a credential nobody owns. Best-effort — an unreachable
    // database must not wedge a teardown, and the role is inert once its DSN is gone with the cxell.
    if (xell.db_coupling === 'db-prod-readonly' || xell.prod_ro_dsn) {
      const { dropProdReader } = await import('../lib/prod-readonly.js');
      const r = await dropProdReader(xell);
      logline('reaper', `${xell.slug}: read-only prod role ${r.role || ''} ${r.dropped ? 'DROPPED' : `not dropped (${r.reason || r.error || '—'})`}`);
    }
    logline('reaper',
      `${xell.slug} was bound to PRODUCTION — DISCONNECTED ${prodLinks.map((c) => c.name).join(', ')} `
      + '(released, NOT deleted) before teardown. Production is untouched.');
  }

  logline('reaper', `decommissioning ${xell.slug} (${reason}) — releasing resources, removing worktree + branch`
    + ` [liveness: ${verdict ? verdict.why : 'FORCED — the guard was not consulted'}]`);
  await one(`UPDATE xell SET status='tearing-down' WHERE id=$1 RETURNING *`, [xellId])
    .then((x) => x && broadcast('xell', x));
  // the honeycomb's queenzee→xell line: the queenzee is reaping/decommissioning this xell
  activity('q2x', xellId, 'reap', xell.project_id);

  // A db-clone xell owns a DATABASE inside the shared dev postgres (its db_instance row) — drop
  // it, or every retired schema-work xell leaks a full copy of dev into the container. Best-
  // effort: a failed drop logs and the teardown continues, and the instance row it leaves behind
  // is exactly how the leak stays visible (discovery flags it as an orphan).
  {
    const dropped = await dropCloneDb(xell).catch((e) => ({ ok: false, error: e.message }));
    if (dropped?.ok === false) {
      logline('reaper', `could not drop ${xell.slug}'s clone database: ${dropped.error} — its `
        + 'db_instance row stays as the orphan record');
    }
  }

  // STOP THE ZEE — every zee row this xell hosted, whatever state it is in.
  //
  // This used to be gated on `status IN ('spawning','online','working','idle')`, i.e. on the
  // statuses that mean "a turn is in flight". Everything else was left untouched — and 'errored'
  // is everything else. A headless turn that dies on an API 429/529 lands in 'errored', so the
  // teardown of such a xell retired the xell, removed the cage, and left the zee row saying
  // decommissioned_at IS NULL, name set, cli_active true: a row that claims a live, ATTACHED agent
  // in a cage that no longer exists. Six of them were sitting in the live meta-DB when this was
  // found (the oldest four days old), and nothing revisits a zee row after its xell is retired, so
  // they never age out. `scripts/audit-agent-sessions.mjs` reports them as GHOST ROWS.
  //
  // The fix is to key on the FACT (this row has not been decommissioned) instead of on a status
  // whitelist. cli_active goes false too: it is the monitor's "an agent is attached" probe, and
  // there is provably nothing to attach to once the cage is gone. The status a run ENDED in is
  // preserved for anything but a live-turn status — 'errored' is why this row stopped and
  // last_stop_reason is the detail, so overwriting it with 'stopped' would delete the diagnosis.
  // Multiple rows are possible (a cxell xell can outlive several zees), so this is q(), not one().
  const stopped = await q(
    `UPDATE zee
        SET status = CASE WHEN status IN ('spawning','online','working','idle') THEN 'stopped'
                          ELSE status END,
            name = NULL, cli_active = false, decommissioned_at = now()
      WHERE xell_id = $1 AND decommissioned_at IS NULL RETURNING *`, [xellId]);
  for (const z of stopped) broadcast('zee', z);

  // ── FROM HERE DOWN, EVERY STEP TOUCHES A REAL MACHINE ───────────────────────
  // …with names taken straight out of the rows above, so it is the whole point of the guard at the
  // top of this file. In simulate the row still retires (the model stays coherent, the dashboard
  // still shows the xell gone) and nothing on any host is removed. REPORT-ONLY, not a silent skip:
  // a teardown that quietly did nothing would be indistinguishable from a clean one.
  const destructive = mode === 'real';
  if (!destructive) {
    const owned = await q(`SELECT name FROM container WHERE owner_xell_id=$1`, [xellId]);
    logline('reaper', `${xell.slug}: retiring the ROW ONLY — PROVISION_MODE=simulate: this queenzee `
      + 'models the fleet, it does not tear down machines. Would have removed: worktree '
      + `${xell.worktree_path || '(none)'}, cxell ${cxellName(xell.slug)}`
      + `${owned.length ? `, container(s) ${owned.map((c) => c.name).join(', ')}` : ''}, and its images.`);
  }

  // deterministic despawn script (purge containers, remove worktree/branch).
  // Only run it when the worktree actually exists on disk — in simulate mode the
  // worktree was never created, so there is nothing to tear down.
  const script = resolve(config.repoRoot, 'scripts', 'despawn-xell.sh');
  // WHY THE DESPAWN DID NOT RUN, named — because four different reasons used to drop out of one `&&`
  // chain into the same three words, "despawn failed", and a human reading that goes hunting a docker
  // fault that does not exist. The four need different responses: a missing SCRIPT is a broken
  // queenzee deployment (every teardown after this one is degraded too); no worktree PATH is a pooled
  // xell that never had one; a path that is already gone is nothing to do and is fine; and simulate is
  // the mode working. Behaviour is unchanged — a missing script still never blocks a teardown.
  const skipReason = !destructive
    ? 'PROVISION_MODE=simulate, nothing was torn down'
    : !existsSync(script)
      ? `the despawn script is MISSING from this queenzee's own tree (${script}) — nothing was purged and `
        + 'nothing here is a docker fault; every teardown on this queenzee is degraded until the file is back'
      : !xell.worktree_path
        ? 'this xell has no worktree_path recorded — there was nothing on disk to tear down'
        : !existsSync(xell.worktree_path)
          ? `its worktree was already gone from disk (${xell.worktree_path}) — nothing left to purge`
          : null;
  // The missing-script case is a DEPLOYMENT fault, not a per-xell one: say it once, loudly, on the
  // channel a human actually reads. The same stance as the cxell file installs.
  if (destructive && !existsSync(script)) {
    logline('reaper', `!!! ${xell.slug}: ${skipReason}`);
    console.error(`[reaper] !!! despawn script missing: ${script} — teardowns purge nothing until it is restored`);
  }
  let despawn = { skipped: true, ...(skipReason ? { reason: skipReason } : {}) };
  if (destructive && existsSync(script) && xell.worktree_path && existsSync(xell.worktree_path)) {
    // Despawn on the xell's OWN machine — its containers' stamped context, which since machines
    // (023) can differ per xell. The project dev site and the global env default are fallbacks
    // for rows that predate stamping; purging on the wrong daemon removes nothing and leaks.
    const project = await one(`SELECT repo_root FROM project WHERE id=$1`, [xell.project_id]);
    const ownCtx = (await one(
      `SELECT docker_ctx FROM container WHERE owner_xell_id=$1 AND role='server' AND docker_ctx IS NOT NULL LIMIT 1`,
      [xellId]))?.docker_ctx || null;
    const devSite = await resolveSite(xell.project_id, 'dev');
    const r = spawnSync(resolveBash(), [script, xell.worktree_path], {
      cwd: project?.repo_root || config.omnibizRoot, encoding: 'utf8', timeout: 120000,
      env: cleanGitEnv({ SPINOFF_DOCKER_CONTEXT: ownCtx || devSite?.docker_ctx || config.dockerCtx }),
    });
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
    let verdict = null; try { verdict = JSON.parse(line); } catch { /* no JSON line */ }
    despawn = { code: r.status, ...(verdict || {}), stderr: (r.stderr || '').slice(-600) };
    // "the script RAN and failed" is a different fact from "the script was not there", and the log
    // below prints whichever `reason` it is given. Say which, with the exit code and the tail of the
    // script's own complaint — that is the line a human can act on.
    if (!despawn.reason && (r.status !== 0 || verdict?.ok === false)) {
      const tail = (r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop() || 'no output';
      despawn.reason = `the despawn script RAN and failed (exit ${r.status ?? '?'}): ${tail.slice(0, 200)}`;
    }
  }

  // --rm SEMANTICS: reclaim this xell's built images BEFORE dropping the container rows — those
  // rows are the only record of which image_tags were its. The despawn script above tries to purge
  // them too, but only via `spin-env.sh purge` run from INSIDE the worktree: if the worktree is
  // gone/broken (or the purge silently failed), ~2.6 GB per xell leaks with nobody watching. The
  // queenzee knows the exact tags, so it does not need the worktree to clean up after itself.
  if (destructive) {
    await removeXellImages(xellId, xell.slug).catch((e) => logline('reaper', `image cleanup failed for ${xell.slug}: ${e.message}`));
  }

  // the xell's zee CXELL, if a cxell zee ever ran here (lib/cxell.js) — it idles sealed on the
  // queenzee's local daemon after its turn so commits stay collectible; retirement is the point
  // of no return, so it goes too. Best-effort like the rest: a leak is visible in `docker ps`
  // by its zeehive.cxell label.
  if (destructive) {
    await removeCxell({ ctx: 'default', slug: xell.slug }).catch((e) => logline('reaper', `cxell cleanup failed for ${xell.slug}: ${e.message}`));

    // Physically remove owned containers the queenzee docker-ran itself (the per-xell db of a
    // process-runner xell — spec §6.1). Compose-managed ones were already purged by the despawn
    // script; stop+rm is idempotent, so hitting them again is a no-op, and prod containers are
    // shared (owner_xell_id NULL) so they can never match. Best-effort like the rest.
    const owned = await q(
      `SELECT name, docker_ctx FROM container WHERE owner_xell_id=$1 AND docker_ctx IS NOT NULL`, [xellId]);
    for (const c of owned) {
      await stopAndRemoveContainer(c.docker_ctx, c.name, { removeVolumes: true })
        .catch((e) => logline('reaper', `container cleanup failed for ${c.name}: ${e.message}`));
    }
  }

  // drop this xell's per-xell containers from the meta DB
  await q(`DELETE FROM container WHERE owner_xell_id = $1`, [xellId]);

  const retired = await one(
    `UPDATE xell SET status='retired', retired_at=now(), is_pooled=false WHERE id=$1 RETURNING *`, [xellId]);
  broadcast('xell', retired);

  // The DB row is retired either way (the xell is gone as far as the fleet is concerned), but do
  // NOT report a clean teardown when the folder is still on disk — that is how orphaned worktrees
  // pile up unnoticed. Say it plainly instead.
  const orphaned = xell.worktree_path && existsSync(xell.worktree_path);
  if (orphaned) {
    logline('reaper', `retired ${xell.slug} BUT its worktree is still on disk: ${xell.worktree_path} — `
      // every path above now sets a reason (missing script / no path / already gone / ran-and-failed /
      // simulate), so this no longer has to guess "despawn failed" and send a human after a phantom
      // docker fault. The bare fallback stays only for a future branch that forgets to set one.
      + `${despawn.reason || 'despawn did not run and did not say why — that is a bug in reaper.js'}`);
  } else {
    logline('reaper', `retired ${xell.slug}: zee decommissioned, worktree + containers removed ✓`);
  }

  // AND IF IT WAS A DISPATCH THAT NEVER RAN, say so to whoever dispatched it — a manager in its
  // inbox, anyone else as a ticket. One log line was all this used to be, and a human retried the
  // same destroyed dispatch four times over it (TKT-88-D6B4).
  const lossReport = await reportDispatchLoss(loss).catch(() => ({ reported: false }));

  return { ok: true, reason, orphaned_worktree: orphaned ? xell.worktree_path : null, despawn,
           dispatch_loss: loss?.lost ? { ...lossReport, why: loss.why } : null,
           // The zee this teardown stopped (the newest, when a cxell xell hosted several) plus how
           // many rows were stamped — a caller that only ever saw one id could not tell that a
           // second, differently-statused row had been left behind.
           zee_id: stopped[stopped.length - 1]?.id || null, zees_decommissioned: stopped.length,
           liveness: verdict };
}

// DANGER ZONE — purge every non-production xell in a project, reclaiming the dev fleet back to
// bare prod. Reaps regardless of in-flight work (force:true), so a zee mid-task is killed and its
// worktree + branch + per-xell containers deleted. Production is never a candidate: is_production
// rows are excluded here AND refused by reapXell, and prod's shared containers have no owner so no
// teardown path touches them. The pool maintainer will refill READY xells afterward unless the
// caller also drops the pool target — that is the console's job, offered alongside this.
// Idempotent and best-effort: one xell's failure is recorded and the sweep continues.
export async function purgeDevXells(projectId, { reason = 'danger-purge' } = {}) {
  if (!projectId) return { ok: false, error: 'projectId required' };
  const targets = await q(
    `SELECT id, slug FROM xell
       WHERE project_id = $1 AND is_production = false AND status <> 'retired'
       ORDER BY created_at`, [projectId]);
  logline('reaper', `DANGER purge: reaping ${targets.length} non-production xell(s) in project ${projectId} — prod is untouched`);
  const results = [];
  for (const x of targets) {
    const r = await reapXell(x.id, reason, { force: true }).catch((e) => ({ ok: false, error: e.message }));
    results.push({ slug: x.slug, ok: !!r.ok, error: r.ok ? null : r.error });
    logline('reaper', r.ok ? `purge: reaped ${x.slug} ✓` : `purge: ${x.slug} FAILED — ${r.error}`);
  }
  const reaped = results.filter((r) => r.ok).length;
  logline('reaper', `DANGER purge complete: ${reaped}/${targets.length} reaped, production intact`);
  return { ok: true, total: targets.length, reaped, failed: results.filter((r) => !r.ok), results };
}
