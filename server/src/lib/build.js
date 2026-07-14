// Container build — (re)build a per-xell server/webapp container from its worktree code, and
// record what commit it was built at + whether it was a HOT build. The docker work lives in
// scripts/build-container.sh (queenzee-run); this projector schedules it and persists the result.
// BUILD_MODE=real runs docker compose; default 'simulate' records the build with no side effects.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { cleanGitEnv } from '../lib/git.js';
import { logline } from '../lib/logbus.js';

const MODE = process.env.BUILD_MODE === 'real' ? 'real' : 'simulate';
const BUILDABLE = new Set(['server', 'webapp']); // db is shared infra — not a per-xell build

function runBuild({ worktree, service, ctx, project, file, hot }) {
  const script = resolve(config.repoRoot, 'scripts', 'build-container.sh');
  const r = spawnSync('bash',
    [script, worktree, service, ctx || 'ugreen-nas', project || '', file || '', MODE, hot ? 'true' : 'false'],
    { encoding: 'utf8', timeout: 600000, windowsHide: true, env: cleanGitEnv() });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return null; }
}

// Build one container. Returns the updated container row, or throws with a clear reason.
export async function buildContainer(containerId, { hot = false } = {}) {
  const c = await one(`SELECT * FROM container WHERE id=$1`, [containerId]);
  if (!c) throw new Error('container not found');
  if (!BUILDABLE.has(c.role)) throw new Error(`role '${c.role}' is not buildable (only server/webapp)`);
  if (!c.owner_xell_id) throw new Error('not a per-xell container');
  const xell = await one(`SELECT slug, worktree_path FROM xell WHERE id=$1`, [c.owner_xell_id]);
  if (!xell?.worktree_path) throw new Error('owner xell has no worktree');

  // building…
  await one(`UPDATE container SET health='building' WHERE id=$1 RETURNING id`, [containerId])
    .then((r) => r && broadcast('container', { id: containerId, health: 'building' }));

  const res = runBuild({
    worktree: xell.worktree_path, service: c.name, ctx: c.docker_ctx,
    project: c.compose_project, file: c.compose_file, hot,
  });
  const ok = !!res && res.ok !== false;

  const row = await one(
    `UPDATE container
        SET health = $2::container_health,
            hot_build = $3,
            last_build_commit = COALESCE($4, last_build_commit),
            last_built_at = now()
      WHERE id=$1 RETURNING *`,
    [containerId, ok ? 'up' : 'down', !!hot, res?.head && res.head !== 'unknown' ? res.head : null]);
  broadcast('container', row);
  logline('build', `${hot ? 'HOT ' : ''}build ${c.name} (${MODE}/${res?.method || '?'}) @ ${res?.head || '?'} → ${ok ? 'up' : 'FAILED'}`);
  if (!ok) throw new Error(`build failed for ${c.name}`);
  return row;
}

// Build every buildable (server + webapp) container owned by a xell.
export async function buildXell(xellId, { hot = false } = {}) {
  const cs = await q(
    `SELECT id FROM container WHERE owner_xell_id=$1 AND role = ANY($2) ORDER BY role`,
    [xellId, [...BUILDABLE]]);
  const built = [];
  for (const c of cs) built.push(await buildContainer(c.id, { hot }));
  return built;
}
