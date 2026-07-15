// Container build — a REAL `docker compose build` + `up -d` of a per-xell server/webapp from its
// worktree code, recording the commit it was built at and whether it was a HOT build. The docker
// work lives in scripts/build-container.sh (queenzee-run, mirroring the project's spin-env.sh).
//
// Builds take MINUTES, so this never blocks: the container flips to health='building' (the UI
// shows a spinner), the build runs via async spawn, and the row + SSE update when it finishes.
// BUILD_MODE=simulate opts out of Docker entirely (demo escape hatch); default is REAL.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { cleanGitEnv } from '../lib/git.js';
import { logline } from '../lib/logbus.js';

const MODE = process.env.BUILD_MODE === 'simulate' ? 'simulate' : 'real';
const BUILDABLE = new Set(['server', 'webapp']); // db is shared infra — not a per-xell build

// Async spawn (NOT spawnSync) — a real image build would otherwise freeze the event loop.
function runBuild({ worktree, role, ctx, hot }) {
  return new Promise((res) => {
    const script = resolve(config.repoRoot, 'scripts', 'build-container.sh');
    const p = spawn('bash', [script, worktree, role, ctx || 'ugreen-nas', hot ? 'true' : 'false', MODE],
      { env: cleanGitEnv(), windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      let json = null; try { json = JSON.parse(line); } catch { /* no JSON line */ }
      res({ json, err: err.slice(-1500) });
    });
    p.on('error', (e) => res({ json: null, err: String(e.message) }));
  });
}

// Kick off a build. Returns as soon as it's queued (health='building'); the row updates live.
export async function buildContainer(containerId, { hot = false } = {}) {
  const c = await one(`SELECT * FROM container WHERE id=$1`, [containerId]);
  if (!c) throw new Error('container not found');
  if (!BUILDABLE.has(c.role)) throw new Error(`role '${c.role}' is not buildable (only server/webapp)`);
  if (!c.owner_xell_id) throw new Error('not a per-xell container');
  if (c.health === 'building') throw new Error(`${c.name} is already building`);
  const xell = await one(`SELECT slug, worktree_path FROM xell WHERE id=$1`, [c.owner_xell_id]);
  if (!xell?.worktree_path) throw new Error('owner xell has no worktree');

  const building = await one(`UPDATE container SET health='building' WHERE id=$1 RETURNING *`, [containerId]);
  broadcast('container', building);
  logline('build', `${hot ? 'HOT ' : ''}build started: ${c.name} (${MODE}) from ${xell.slug}`);

  // background — do NOT await; a real build takes minutes
  (async () => {
    const { json, err } = await runBuild({ worktree: xell.worktree_path, role: c.role, ctx: c.docker_ctx, hot });
    const ok = !!json && json.ok !== false;
    const row = await one(
      `UPDATE container
          SET health = $2::container_health, hot_build = $3,
              last_build_commit = COALESCE($4, last_build_commit),
              last_built_at = CASE WHEN $5 THEN now() ELSE last_built_at END
        WHERE id=$1 RETURNING *`,
      [containerId, ok ? 'up' : 'down', !!hot && ok, json?.head && json.head !== 'unknown' ? json.head : null, ok]);
    broadcast('container', row);
    logline('build', ok
      ? `${hot ? 'HOT ' : ''}build OK: ${c.name} @ ${json?.head} (${json?.method})`
      : `build FAILED: ${c.name} — ${(err || 'see docker output').split('\n').filter(Boolean).pop()}`);
  })();

  return { status: 'building', container: c.name, role: c.role, hot, mode: MODE };
}

// Build a xell's buildable containers. role=null → both (server + webapp); otherwise just that
// one. This is the sanctioned entry point for a zee: it goes through the queenzee, so the commit,
// hot flag, health and dashboard all stay truthful.
export async function buildXell(xellId, { hot = false, role = null } = {}) {
  if (role && !BUILDABLE.has(role)) throw new Error(`role '${role}' is not buildable (server|webapp|all)`);
  const cs = await q(
    `SELECT id FROM container WHERE owner_xell_id=$1 AND role = ANY($2) ORDER BY role`,
    [xellId, role ? [role] : [...BUILDABLE]]);
  if (!cs.length) throw new Error(`xell has no buildable ${role || 'server/webapp'} container`);
  const started = [];
  for (const c of cs) started.push(await buildContainer(c.id, { hot }).catch((e) => ({ error: e.message })));
  return started;
}
