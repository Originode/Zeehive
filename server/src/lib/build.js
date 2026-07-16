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
import { cleanGitEnv, headCommit } from '../lib/git.js';
import { logline } from '../lib/logbus.js';

const MODE = process.env.BUILD_MODE === 'simulate' ? 'simulate' : 'real';
const BUILDABLE = new Set(['server', 'webapp']); // db is shared infra — not a per-xell build

// Async spawn (NOT spawnSync) — a real image build would otherwise freeze the event loop.
// `recorded` carries the meta-DB's compose/env/port facts as env overrides; the script keeps its
// own derivation as fallback, so a bare invocation (or an old row with NULLs) still works.
function runBuild({ worktree, role, ctx, hot, recorded = {} }) {
  return new Promise((res) => {
    const script = resolve(config.repoRoot, 'scripts', 'build-container.sh');
    const env = {};
    for (const [k, v] of Object.entries(recorded)) if (v != null && v !== '') env[k] = String(v);
    const p = spawn('bash', [script, worktree, role, ctx || 'ugreen-nas', hot ? 'true' : 'false', MODE],
      { env: cleanGitEnv(env), windowsHide: true });
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
  const xell = await one(`SELECT slug, worktree_path, project_id FROM xell WHERE id=$1`, [c.owner_xell_id]);
  if (!xell?.worktree_path) throw new Error('owner xell has no worktree');

  // What the meta-DB already recorded about this stack: compose file/project on the container
  // row (stamped at provision), env-file convention on the project, and the ACTUAL allocated
  // host ports of both buildable roles (the compose file interpolates both, whichever we build).
  const project = await one(
    `SELECT repo_root, env_file FROM project WHERE id=$1`, [xell.project_id]);
  const siblings = await q(
    `SELECT role, host_port FROM container WHERE owner_xell_id=$1 AND role = ANY($2)`,
    [c.owner_xell_id, [...BUILDABLE]]);
  const portOf = (role) => siblings.find((s) => s.role === role)?.host_port;
  const recorded = {
    BUILD_COMPOSE_FILE: c.compose_file,
    BUILD_COMPOSE_PROJECT: c.compose_project,
    BUILD_ENV_FILE: project?.env_file && project?.repo_root
      ? `${String(project.repo_root).replace(/\\/g, '/')}/${project.env_file}` : null,
    SPINOFF_SLUG: xell.slug,
    SPINOFF_SERVER_PORT: portOf('server'),
    SPINOFF_WEB_PORT: portOf('webapp'),
  };

  const building = await one(`UPDATE container SET health='building' WHERE id=$1 RETURNING *`, [containerId]);
  broadcast('container', building);
  logline('build', `${hot ? 'HOT ' : ''}build started: ${c.name} (${MODE}) from ${xell.slug}`);

  // background — do NOT await; a real build takes minutes
  (async () => {
    const { json, err } = await runBuild({ worktree: xell.worktree_path, role: c.role, ctx: c.docker_ctx, hot, recorded });
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
  })().catch(async (e) => {
    // The ONLY thing that can move this row off 'building' is this callback — the health monitor
    // deliberately skips 'building' so it can't clobber a live build. So an unhandled throw in
    // here (runBuild blowing up, or a single ETIMEDOUT to the NAS meta-DB on the UPDATE above —
    // see the note in index.js; that exact blip has already taken this orchestrator down once)
    // strands the container at 'building' FOREVER, spinner and all, with no build behind it.
    // Land it on a terminal state and say so, rather than leave a permanent lie on the chip.
    try {
      const row = await one(`UPDATE container SET health='down' WHERE id=$1 AND health='building' RETURNING *`, [containerId]);
      if (row) broadcast('container', row);
    } catch { /* the DB is what failed — the boot-time recoverOrphanBuilds() is the backstop */ }
    logline('build', `build ERRORED: ${c.name} — ${e?.message || e} (marked down; rebuild when ready)`);
  });

  return { status: 'building', container: c.name, role: c.role, hot, mode: MODE };
}

// Is this xell's stack built from the code that is in its worktree RIGHT NOW?
//
// This is the question a zee actually has after a build ("is the container serving MY fix?"), and
// without an answer it invents a curl-poll loop against its own webapp that greps for a string —
// which hangs forever when it guesses the condition wrong. The queenzee already knows: it records
// last_build_commit at build time. So answer it here, from server truth.
// build-container.sh records a SHORT sha (8) while git rev-parse HEAD is the full 40, so `===`
// is never true and every container looks stale. Compare on the shorter one's length.
function sameCommit(a, b) {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

export async function getBuildStatus(xellId) {
  const xell = await one(`SELECT id, slug, worktree_path FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('xell not found');
  const head = xell.worktree_path ? headCommit(xell.worktree_path, 'HEAD') : null;

  const cs = await q(
    `SELECT id, name, role, health, last_build_commit, last_built_at, hot_build
       FROM container WHERE owner_xell_id=$1 AND role = ANY($2) ORDER BY role`,
    [xellId, [...BUILDABLE]]);

  const containers = cs.map((c) => ({
    ...c,
    // A HOT build re-used the old image, so its recorded commit does NOT mean the code is live.
    serving_head: !!head && !c.hot_build && c.health === 'up' && sameCommit(c.last_build_commit, head),
    never_built: !c.last_build_commit,
  }));
  return {
    xell: { id: xell.id, slug: xell.slug },
    head,
    building: containers.some((c) => c.health === 'building'),
    settled: containers.every((c) => c.health !== 'building'),
    all_serving_head: containers.length > 0 && containers.every((c) => c.serving_head),
    containers,
  };
}

// Recover builds orphaned by a server restart.
//
// buildContainer finalizes health from an in-process background promise, and the health monitor
// deliberately SKIPS health='building' so it can't clobber a live build's spinner. Together that
// means a restart mid-build strands the container at 'building' FOREVER: the promise died, and
// the one thing that would fix it refuses to look. The dashboard spins and a waiting zee waits
// forever. At boot there can be no in-flight build in THIS process, so every 'building' row is by
// definition an orphan — hand them back to the monitor.
export async function recoverOrphanBuilds() {
  const rows = await q(
    `UPDATE container SET health='unknown' WHERE health='building' RETURNING id, name`);
  for (const r of rows) broadcast('container', r);
  if (rows.length) {
    logline('build', `recovered ${rows.length} orphaned build(s) after restart: `
      + `${rows.map((r) => r.name).join(', ')} — health monitor will re-derive from docker`);
  }
  return rows.length;
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
