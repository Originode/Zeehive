// Pool maintainer / reconciler — keeps EXACTLY `pool_config.target_ready` pooled xells that
// are each pristine: sitting on the source tip (diff 0,0), claimable immediately. Pure script,
// no AI. Each tick, per project:
//   1. reconcile every pooled xell to the source — clean fast-forward (catch up), else
//      decommission it (dirty / diverged / too far behind / ff impossible).
//   2. INVARIANT: a xell is 'ready' only when its diff to source is (0 ahead, 0 behind).
//   3. fill  — if ready < target, provision fresh xells (which start at the source tip).
//   4. trim  — if ready > target, decommission the surplus (oldest first).
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { provisionXell } from '../lib/provision.js';
import { reapXell } from './reaper.js';
import { reconcileXell } from './landing.js';
import { logline } from '../lib/logbus.js';

const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

async function reconcileProject(projectId, target) {
  const project = await one(`SELECT main_branch FROM project WHERE id=$1`, [projectId]);
  const src = project?.main_branch || 'main';

  // 1+2. Reconcile pooled xells to the source. Only in real mode (simulate has no worktrees).
  if (MODE === 'real') {
    const pooled = await q(
      `SELECT id, slug, head_commit, worktree_path FROM xell
         WHERE project_id=$1 AND status='ready' AND NOT is_production`, [projectId]);
    for (const x of pooled) {
      const { verdict, res } = await reconcileXell(x, src);
      if (verdict === 'decommission') {
        logline('pool', `decommissioning ${x.slug} — ${res?.reason || 'unreconcilable'} (behind ${res?.behind ?? '?'}); will reprovision fresh`);
        await reapXell(x.id, `stale:${res?.reason || 'drift'}`).catch((e) => console.error('[pool] reap', e.message));
      }
    }
  }

  // 3+4. Fill or trim to hit exactly `target` ready (all now guaranteed at the source tip).
  const ready = await q(
    `SELECT id, slug FROM xell WHERE project_id=$1 AND status='ready' AND NOT is_production
       ORDER BY ready_at DESC NULLS LAST, created_at DESC`, [projectId]);

  if (ready.length < target) {
    for (let i = 0; i < target - ready.length; i++) {
      try {
        const x = await provisionXell({ projectId, mode: MODE });
        logline('pool', `provisioned ready xell ${x.slug} (${MODE}) → server :${x.ports.serverPort} web :${x.ports.webPort}`);
      } catch (err) {
        console.error('[pool] provision failed:', err.message);
        break; // stop hammering on persistent failure this tick
      }
    }
  } else if (ready.length > target) {
    const surplus = ready.slice(target); // freshest kept, oldest surplus reaped
    logline('pool', `trimming ${surplus.length} surplus ready xell(s): ${surplus.map((s) => s.slug).join(', ')}`);
    for (const s of surplus) await reapXell(s.id, 'pool-surplus').catch((e) => console.error('[pool] trim', e.message));
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
  const tick = () => ensureReady().catch((e) => console.error('[pool]', e.message));
  tick();
  return setInterval(tick, config.poolIntervalMs);
}
