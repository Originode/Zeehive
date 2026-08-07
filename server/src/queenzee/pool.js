// Pool maintainer / reconciler — keeps the pool of pristine pooled xells: each sitting on the
// source tip (diff 0,0), claimable immediately. Pure script, no AI. Each tick, per project:
//   1. reconcile every pooled xell to the source — clean fast-forward (catch up), else
//      decommission it (dirty / diverged / too far behind / ff impossible).
//   2. INVARIANT: a xell is 'ready' only when its diff to source is (0 ahead, 0 behind).
//   3. fill  — provision fresh xells (which start at the source tip) up to target.
//   4. trim  — decommission the surplus (oldest first).
//
// TARGETS: machine-aware when machine rows exist (023) — each dev machine keeps
// `machine.pool_size` ready xells PER PROJECT, and `max_xells` caps the machine's total live
// dev xells across EVERY project (the host only has so much muscle). Filled in dev_priority
// order so the preferred machine warms first. With no machines, the legacy project-wide
// `pool_config.target_ready` applies unchanged on the one dev site.
//
// The machine-aware path ALSO requires a placeable per-xell app tier: the server role must
// NOT be `runner: process`. Machine mode counts ready xells through their owned server
// container (JOIN on role='server' + docker_ctx), and a process server is stamped with
// docker_ctx=NULL (provision.js), so that count is zero by construction and fill would pile
// up pool_size per tick. That used to be gated on `project.compose_spinoff` — the wrong
// predicate. Compose projects stamp docker_ctx even when compose_spinoff is unset (the compose
// file is a build detail; build-container.sh defaults to docker-compose.spinoff.yml), so the
// old guard left mardale-prod's per-machine pool sizes as a dead letter on every compose
// project that had not refreshed tiers.spinoff.compose into the column. The guard is now the
// process-runner check (serverRoleIsProcess); when it fires it is rate-limited and LOUD
// (test: test/pool-machine-guard-silence.test.mjs).
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { provisionXell } from '../lib/provision.js';
import { devMachines, liveXellCount, machinePoolSize } from '../lib/machines.js';
import { reapXell } from './reaper.js';
import { reconcileXell } from './landing.js';
import { takeReadyXellForSweep, untakeSweptXell, explainSweepSkip, currentXells } from '../lib/xell-claim.js';
import { logline } from '../lib/logbus.js';
import { spawnPrepFor, bakesImage } from '../lib/spawn-prep.js';
import { ensurePreppedImage } from '../lib/cxell.js';
import { deviceConfig } from '../lib/devices.js';
import { serverRoleIsProcess } from '../lib/manifest.js';

const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// Say the machine-guard skip when it CHANGES, not every 15s tick — the same "say it when it
// CHANGES" rule monitor.js uses for the census and stale-claim lines. Keyed per project so a
// project that leaves process-runner (or gains machines) logs again the moment it becomes
// true, and a fleet with several affected projects hears each one once.
const lastMachineGuardSaid = new Map();

// DECOMMISSION A XELL THIS SWEEP SCANNED — the take, the reap and the hand-back, in ONE place, so
// both sweep sites (the reconcile pass and the trim below) obey the same rule.
//
// The rule: everything the caller decided was decided from the ROW IT SCANNED, and by the time we
// get here that row can be minutes old — each reconcile is git work and each reap is spawnSync-
// heavy. A dispatch may have CLAIMED and RENAMED this very xell in between, which is exactly how
// five dispatched tasks were destroyed in three minutes on 2026-08-05 (TKT-88-D6B4): the rename
// moved the worktree out from under the scan, `landOne` reported `no-worktree` against the path the
// scan was holding, and the reap then ran against the freshly named, freshly dispatched xell —
// naming the OLD slug in the pool line and the NEW one in the reaper line, one xell, two names.
//
// So the verdict is re-asked of the database ATOMICALLY before it is acted on: takeReadyXellForSweep
// is a conditional UPDATE that only moves a xell that is STILL 'ready', STILL this slug and STILL
// this worktree. A dispatch's claim is the same compare-and-set on the same row off the same value,
// so exactly one of the two can win — in either order, with no window between a read and a write for
// the other to slip through. Exported as the seam the regression test drives
// (test/dispatch-claim-vs-pool-sweep.test.mjs).
export async function sweepDecommission(scanned, reason, { what = null, verdict = null, failLabel = 'REAP' } = {}) {
  const taken = await takeReadyXellForSweep(scanned);
  if (!taken) {
    const now = (await currentXells([scanned.id])).get(scanned.id) || null;
    logline('pool', `NOT decommissioning ${scanned.slug}${verdict ? ` (${verdict})` : ''} — `
      + `${explainSweepSkip(scanned, now)}; this sweep's verdict is stale and was discarded`);
    return { reaped: false, skipped: explainSweepSkip(scanned, now) };
  }
  if (what) logline('pool', what);
  // A reap that FAILS must be loud: it leaves the xell exactly where it was, and a console.error
  // nobody reads is how a stuck xell survives for hours. The take above moved it to 'tearing-down',
  // so hand it back — every refusal reapXell can return happens before it changes anything.
  const r = await reapXell(scanned.id, reason).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) {
    await untakeSweptXell(scanned.id);
    logline('pool', `${failLabel} FAILED for ${scanned.slug}: ${r?.error || 'refused'} — it stays ready and will be retried next tick`);
    return { reaped: false, error: r?.error || 'refused' };
  }
  return { reaped: true };
}

async function reconcileProject(projectId, target) {
  const project = await one(`SELECT main_branch, compose_spinoff, manifest FROM project WHERE id=$1`, [projectId]);
  const src = project?.main_branch || 'main';
  // Process-runner server ⇒ docker_ctx NULL on the server row ⇒ machine-mode counts are zero.
  // Compose projects (no process runner) are placeable even when compose_spinoff is unset.
  const placeable = !serverRoleIsProcess(project?.manifest);

  // BAKE THE PREPPED CXELL IMAGE (spawn template `when: image|provision`) — here, because here is
  // the pool's clock. Every cage of this project then starts from an image that already carries the
  // template's packages, instead of running apt on the dispatch path while a human waits. It is a
  // no-op unless the project asked for it, a no-op when the image already exists, and never fatal:
  // a failed bake leaves dispatch installing the packages the way it always has.
  if (MODE === 'real') {
    const prep = await spawnPrepFor(projectId);
    if (bakesImage(prep)) {
      await ensurePreppedImage({ ctx: 'default', baseImage: deviceConfig(project).cxellImage || undefined,
                                prep, label: `project ${projectId.slice(0, 8)}` })
        .catch((e) => logline('pool', `prepped image: ${e.message}`));
    }
  }

  // 1+2. Reconcile pooled xells to the source. Only in real mode (simulate has no worktrees).
  if (MODE === 'real') {
    // Capped per tick: each reconcile is git work. Against a normal pool (≤ a handful) the cap
    // is invisible; against a runaway pile it keeps the tick bounded while trim drains it —
    // an unreconciled surplus xell is fine, it is on its way out anyway.
    const pooled = await q(
      `SELECT id, slug, head_commit, worktree_path FROM xell
         WHERE project_id=$1 AND status='ready' AND NOT is_production
         ORDER BY ready_at DESC NULLS LAST, created_at DESC LIMIT 25`, [projectId]);
    for (const x of pooled) {
      const { verdict, res } = await reconcileXell(x, src);
      if (verdict === 'decommission') {
        await sweepDecommission(x, `stale:${res?.reason || 'drift'}`,
          { what: `decommissioning ${x.slug} — ${res?.reason || 'unreconcilable'} (behind ${res?.behind ?? '?'}); will reprovision fresh`,
            verdict: res?.reason || 'unreconcilable' });
      }
    }
  }

  // 3+4. Fill or trim (all pooled xells now guaranteed at the source tip). Machine mode: each
  // machine keeps ITS OWN number of ready xells for THIS project (machine_pool, 025 — a
  // high-load project pools bigger than a quiet one on the same host); legacy project-wide
  // target otherwise.
  // Machine mode counts a project's ready xells THROUGH their owned server container
  // (fillTrim's join on role='server' + docker_ctx). A process-runner project (e.g. Zeehive
  // itself: bare worktree + process server/webapp) stamps docker_ctx=NULL on those rows, so
  // that count is ALWAYS ZERO no matter how many ready xells exist: fill provisions pool_size
  // more every tick, trim never sees a surplus, and max_xells (counted the same way) never
  // caps it. That is exactly how 167 ready Zeehive xells piled up by 2026-07-19 — and the
  // per-tick reconcile sweep over all of them is what froze the API. Machine placement is
  // meaningless for bare processes anyway (they live on the queenzee's host), so such
  // projects use the legacy project-wide target, whose count has no join.
  //
  // compose_spinoff is NOT the predicate: a compose project with machines configured but an
  // empty compose_spinoff column still stamps docker_ctx at provision, and must take the
  // machine path — otherwise mardale-prod's pool_size is a dead letter until someone happens
  // to refresh tiers.spinoff.compose into the column (the "mardale-prod never gets pool xells"
  // defect under its second diagnosis).
  const machines = await devMachines(projectId);
  if (!machines.length || !placeable) {
    // When a machine_pool row exists (dev_priority>0, pool_size>0) but the project cannot place
    // (process-runner server), this guard takes the legacy path and the whole per-machine config
    // is a dead letter. Say it out loud: naming the skipped machines AND the reason, so an
    // operator can fix the project from the message alone. Rate-limited to once per state change
    // (the same "say it when it CHANGES" rule monitor.js uses): the pool ticks every 15s, and a
    // verbatim repeat would drown the lines that carry news.
    const skipped = machines.map((m) => m.key);
    if (skipped.length && !placeable) {
      // `!!!` is the house "loud" convention (ops-review.js ALERT_RE scans for it) — a manager's
      // ops digest must catch this line, not just a human reading the terminal.
      const msg = `!!! machine-aware pooling DISABLED for project ${String(projectId).slice(0, 8)}: `
        + `machine(s) [${skipped.join(', ')}] are configured (dev_priority>0 / pool_size>0) but `
        + `the spinoff server is runner:process — machine placement needs a docker-backed app tier `
        + `(server containers get docker_ctx=NULL for process roles, so the ready count is zero by `
        + `construction). Per-machine pool sizes have no effect; the project-wide pool target applies. `
        + `To place on machines, give roles.server (or tiers.spinoff) a compose runner and a spinoff `
        + `compose file, then refresh the manifest.`;
      const first = !lastMachineGuardSaid.has(projectId);
      if (lastMachineGuardSaid.get(projectId) !== msg) {
        lastMachineGuardSaid.set(projectId, msg);
        logline('pool', msg);
        // The ring buffer is read in the console's terminal modal; stdout is the docker log.
        // The FIRST occurrence is the "operator, look here" event; later state changes that alter
        // the message log again but only to the ring, so a fix that rotates machines stays audible
        // without repeating the same line every 15 seconds.
        if (first) console.error(`[pool] ${msg}`);
      }
    }
    return fillTrim(projectId, target, null);
  }
  for (const m of machines) {
    const size = await machinePoolSize(m.id, projectId);
    await fillTrim(projectId, size, m).catch((e) => console.error(`[pool] ${m.key}:`, e.message));
  }
}

// Fill to / trim past `target` ready xells — on one machine (m) or project-wide (m = null).
async function fillTrim(projectId, target, m) {
  const ready = m
    ? await q(
      `SELECT x.id, x.slug, x.worktree_path FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
        WHERE x.project_id=$1 AND x.status='ready' AND NOT x.is_production AND c.docker_ctx=$2
        ORDER BY x.ready_at DESC NULLS LAST, x.created_at DESC`, [projectId, m.docker_ctx])
    : await q(
      `SELECT id, slug, worktree_path FROM xell WHERE project_id=$1 AND status='ready' AND NOT is_production
        ORDER BY ready_at DESC NULLS LAST, created_at DESC`, [projectId]);

  if (ready.length < target) {
    // max_xells is MACHINE-WIDE: every live dev xell on the host counts (all projects, claimed
    // and working too), so a busy machine fills less than pool_size rather than blowing past it.
    let room = target - ready.length;
    if (m) room = Math.min(room, Math.max(0, m.max_xells - await liveXellCount(m.docker_ctx)));
    for (let i = 0; i < room; i++) {
      try {
        const x = await provisionXell({ projectId, mode: MODE, machineCtx: m?.docker_ctx });
        logline('pool', `provisioned ready xell ${x.slug} (${MODE}${m ? ` on ${m.key}` : ''}) → server :${x.ports.serverPort} web :${x.ports.webPort}`);
      } catch (err) {
        console.error(`[pool] provision failed${m ? ` on ${m.key}` : ''}:`, err.message);
        break; // stop hammering on persistent failure this tick
      }
    }
  } else if (ready.length > target) {
    // Batch the trim: a reap is spawnSync-heavy (worktree + branch removal), and a large
    // surplus (the 167-xell pile above) drained in one tick would freeze the API for minutes.
    // Five per tick keeps the queenzee responsive; the rest go next tick.
    const surplus = ready.slice(target); // freshest kept, oldest surplus reaped
    const batch = surplus.slice(0, 5);
    logline('pool', `trimming ${batch.length}/${surplus.length} surplus ready xell(s)${m ? ` on ${m.key}` : ''}: ${batch.map((s) => s.slug).join(', ')}`);
    // Same take, same reason as the reconcile sweep above: this list was SELECTed before the reaps
    // began, and a dispatch can claim any of it while the batch drains (a reap is spawnSync-heavy,
    // so the last of five is decided on a list that is seconds old).
    for (const s of batch) {
      await sweepDecommission(s, 'pool-surplus', { what: null, verdict: 'surplus', failLabel: 'TRIM' });
    }
  }
}

export async function ensureReady() {
  const projects = await q(
    `SELECT p.id, COALESCE(pc.target_ready,0) AS target
       FROM project p LEFT JOIN pool_config pc ON pc.project_id = p.id`);
  for (const p of projects) {
    await reconcileProject(p.id, p.target).catch((e) => console.error('[pool] reconcile', e.message));
  }
}

export function startPool() {
  if (process.env.POOL_ENABLED === 'false') {
    console.log('[queenzee] pool maintainer DISABLED (POOL_ENABLED=false)');
    return null;
  }
  console.log(`[queenzee] pool maintainer started (mode=${MODE}, ${config.poolIntervalMs}ms)`);
  // SAY THE QUIET HALF OUT LOUD. "mode=simulate" reads as "provisioning is fake", which sounds
  // harmless. The unadvertised half is that it also switches the RECONCILER off (see ensureReady:
  // the whole catch-up/decommission pass is inside `if (MODE === 'real')`), because a simulated
  // xell legitimately has no worktree and reconciling would bin the lot.
  //
  // Both halves are fine against a demo database and ruinous against a real one: the maintainer
  // backfills the pool with rows it never provisioned, and the one check that would notice is off.
  // On 2026-07-16 a restart dropped PROVISION_MODE=real and this ran for an hour — three xells sat
  // 'ready' with no worktree on disk, dispatch kept handing them out, and the only symptom was a
  // confusing spawn failure inside a zee. One line of startup noise is cheaper than that hour.
  if (MODE !== 'real') {
    console.log('[queenzee] ⚠ POOL IS IN SIMULATE — it will mark xells `ready` with NO worktree on '
      + 'disk, AND the reconciler that would decommission them is OFF. Do not point this at a real '
      + 'registry: run with PROVISION_MODE=real (see HANDOFF "Run it").');
  }
  // Re-entrancy guard: setInterval fires on schedule whether or not the last sweep finished,
  // so a sweep that outruns the interval (large pool, slow git) STACKS more sweeps on top —
  // each slower than the last. That compounding is what took the API from 47s to 90s+ on
  // 2026-07-19. One sweep at a time; a skipped tick just runs next interval.
  let sweeping = false;
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await ensureReady(); } catch (e) { console.error('[pool]', e.message); }
    finally { sweeping = false; }
  };
  tick();
  return setInterval(tick, config.poolIntervalMs);
}
