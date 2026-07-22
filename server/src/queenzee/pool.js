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
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { provisionXell } from '../lib/provision.js';
import { devMachines, liveXellCount, machinePoolSize } from '../lib/machines.js';
import { reapXell } from './reaper.js';
import { reconcileXell } from './landing.js';
import { logline } from '../lib/logbus.js';

const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

async function reconcileProject(projectId, target) {
  const project = await one(`SELECT main_branch, compose_spinoff FROM project WHERE id=$1`, [projectId]);
  const src = project?.main_branch || 'main';

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
        logline('pool', `decommissioning ${x.slug} — ${res?.reason || 'unreconcilable'} (behind ${res?.behind ?? '?'}); will reprovision fresh`);
        // A reap that FAILS must be loud: it leaves the xell exactly where it was, and a
        // console.error nobody reads is how a stuck xell survives for hours.
        await reapXell(x.id, `stale:${res?.reason || 'drift'}`)
          .catch((e) => logline('pool', `REAP FAILED for ${x.slug}: ${e.message} — it stays ready and will be retried next tick`));
      }
    }
  }

  // 3+4. Fill or trim (all pooled xells now guaranteed at the source tip). Machine mode: each
  // machine keeps ITS OWN number of ready xells for THIS project (machine_pool, 025 — a
  // high-load project pools bigger than a quiet one on the same host); legacy project-wide
  // target otherwise.
  // Machine mode counts a project's ready xells THROUGH their owned server container
  // (fillTrim's join on role='server' + docker_ctx). A project with no per-xell app tier
  // (no compose_spinoff — e.g. Zeehive itself: its xells are bare worktrees) owns no such
  // containers, so that count is ALWAYS ZERO no matter how many ready xells exist: fill
  // provisions pool_size more every tick, trim never sees a surplus, and max_xells (counted
  // the same way) never caps it. That is exactly how 167 ready Zeehive xells piled up by
  // 2026-07-19 — and the per-tick reconcile sweep over all of them is what froze the API.
  // Machine placement is meaningless for bare worktrees anyway (they live on the queenzee's
  // host), so such projects use the legacy project-wide target, whose count has no join.
  const machines = await devMachines(projectId);
  if (!machines.length || !project?.compose_spinoff) return fillTrim(projectId, target, null);
  for (const m of machines) {
    const size = await machinePoolSize(m.id, projectId);
    await fillTrim(projectId, size, m).catch((e) => console.error(`[pool] ${m.key}:`, e.message));
  }
}

// Fill to / trim past `target` ready xells — on one machine (m) or project-wide (m = null).
async function fillTrim(projectId, target, m) {
  const ready = m
    ? await q(
      `SELECT x.id, x.slug FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
        WHERE x.project_id=$1 AND x.status='ready' AND NOT x.is_production AND c.docker_ctx=$2
        ORDER BY x.ready_at DESC NULLS LAST, x.created_at DESC`, [projectId, m.docker_ctx])
    : await q(
      `SELECT id, slug FROM xell WHERE project_id=$1 AND status='ready' AND NOT is_production
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
    for (const s of batch) await reapXell(s.id, 'pool-surplus')
      .catch((e) => logline('pool', `TRIM FAILED for ${s.slug}: ${e.message} — surplus xell stays`));
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
