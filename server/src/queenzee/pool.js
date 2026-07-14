// Pool maintainer — keeps `pool_config.target_ready` empty xells READY per project, so a
// new task never waits on provisioning. Pure script: it neither reads nor injects prompts.
import { config } from '../config.js';
import { q } from '../db/pool.js';
import { provisionXell } from '../lib/provision.js';
import { logline } from '../lib/logbus.js';

// PROVISION_MODE=real actually runs git worktree + spin-env up on the dev NAS.
// Default 'simulate' models the xell + containers in the meta-DB with correct ports/names
// but performs NO live mutation (safe for dev/demo without polluting the shared stack).
const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

export async function ensureReady() {
  const projects = await q(
    `SELECT p.id, COALESCE(pc.target_ready,0) AS target
       FROM project p LEFT JOIN pool_config pc ON pc.project_id = p.id`);
  for (const p of projects) {
    const [{ count }] = await q(
      `SELECT count(*)::int AS count FROM xell WHERE project_id=$1 AND status='ready'`, [p.id]);
    const missing = Math.max(0, p.target - count);
    for (let i = 0; i < missing; i++) {
      try {
        const x = await provisionXell({ projectId: p.id, mode: MODE });
        logline('pool', `provisioned ready xell ${x.slug} (${MODE}) → server :${x.ports.serverPort} web :${x.ports.webPort}`);
      } catch (err) {
        console.error('[pool] provision failed:', err.message);
        break; // stop hammering on persistent failure this tick
      }
    }
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
