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
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { cleanGitEnv, headCommit } from '../lib/git.js';
import { notifyShipRequest, notifyShipDone } from '../lib/notify.js';

// Real deploys are gated on a human anyway; SHIP_MODE=simulate exists to verify ZEEHIVE itself.
const MODE = process.env.SHIP_MODE === 'simulate' ? 'simulate' : 'real';
// How long the shipping xell keeps prod before the queenzee takes it back. An unattended hold
// blocks every other xell for as long as the human is away, so silence must NOT mean "keep it".
const AUTO_RELEASE_SEC = Number(process.env.SHIP_LOCK_RELEASE_SEC) || 180;
const SHIPPABLE = ['server', 'webapp'];

// Is this xell's work actually ON main? A ship builds from main, so shipping unlanded work would
// deploy code the zee doesn't have — the request is meaningless, not merely unwise.
function landedState(worktreePath, mainBranch) {
  if (!worktreePath) return { landed: false, reason: 'xell has no worktree' };
  const ahead = gitCount(worktreePath, `${mainBranch}..HEAD`);
  const dirty = gitDirty(worktreePath);
  if (ahead === null) return { landed: false, reason: 'cannot read the worktree' };
  if (ahead > 0) return { landed: false, reason: `${ahead} commit(s) not landed on ${mainBranch} yet — land them first (a ship builds from ${mainBranch}, so unlanded work would NOT be in it)` };
  if (dirty > 0) return { landed: false, reason: `${dirty} uncommitted file(s) — commit and land them first, or they will not be in the ship` };
  return { landed: true };
}

function gitCount(cwd, range) {
  const r = spawnSync('git', ['-C', cwd, 'rev-list', '--count', range],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : null;
}
function gitDirty(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean).length : 0;
}

// ── the zee's only prod verb ─────────────────────────────────────────────────
export async function requestShip({ xellId, zeeId = null, reason = null, targets = null }) {
  // Which roles to rebuild — the zee names them (/ooney webapp|server|both). Silently dropping an
  // unknown role would ship less than the zee asked for and report success, so validate loudly.
  const t = (Array.isArray(targets) && targets.length ? targets : SHIPPABLE).map(String);
  const bad = t.filter((r) => !SHIPPABLE.includes(r));
  if (bad.length) throw new Error(`unshippable target(s): ${bad.join(', ')} — only ${SHIPPABLE.join('/')}`);
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('unknown xell');
  if (xell.is_production) throw new Error('production cannot ship itself');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  const main = project.main_branch || 'main';

  const state = landedState(xell.worktree_path, main);
  if (!state.landed) {
    logline('ship', `REFUSED ship from ${xell.slug}: ${state.reason}`);
    return { ok: false, reason: state.reason, request: null };
  }

  const existing = await one(
    `SELECT * FROM ship_request WHERE project_id=$1 AND xell_id=$2
       AND status IN ('pending','approved','shipping')`, [project.id, xellId]);
  if (existing) return { ok: true, request: existing, note: 'you already have an open ship request' };

  const commit = headCommit(project.repo_root, main);
  const row = await one(
    `INSERT INTO ship_request (project_id, xell_id, zee_id, commit, reason, targets)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [project.id, xellId, zeeId, commit, reason, t]);
  broadcast('ship', row);
  logline('ship', `HELD ship request from ${xell.slug} @ ${String(commit).slice(0, 8)} — awaiting human approval`);
  notifyShipRequest({ project, xell, request: row });
  return { ok: true, request: row };
}

export async function listShipRequests(projectId, { open = true } = {}) {
  const where = open ? `AND s.status IN ('pending','approved','shipping')` : '';
  return q(
    `SELECT s.*, x.slug AS xell_slug FROM ship_request s
       JOIN xell x ON x.id = s.xell_id
       WHERE s.project_id=$1 ${where} ORDER BY s.requested_at DESC LIMIT 50`, [projectId]);
}

export async function shipStatus(xellId) {
  return one(
    `SELECT s.*, x.slug AS xell_slug FROM ship_request s JOIN xell x ON x.id=s.xell_id
       WHERE s.xell_id=$1 ORDER BY s.requested_at DESC LIMIT 1`, [xellId]);
}

// ── the human's decision ─────────────────────────────────────────────────────
export async function decideShip(id, decision, by = 'human@console') {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE ship_request SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending ship request (already decided?)');
  broadcast('ship', row);
  logline('ship', `${decision.toUpperCase()} ship ${String(row.commit).slice(0, 8)} by ${by}`);
  if (decision === 'approved') runShip(row.id).catch((e) => console.error('[ship] run failed:', e.message));
  return row;
}

// ── the queenzee ships ───────────────────────────────────────────────────────
// Takes the lock, runs each prod container's OWN build script, then starts the release countdown.
async function runShip(shipId) {
  const ship = await one(`SELECT * FROM ship_request WHERE id=$1`, [shipId]);
  if (!ship || ship.status !== 'approved') return;
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [ship.xell_id]);
  const project = await one(`SELECT * FROM project WHERE id=$1`, [ship.project_id]);

  // The lock is the queenzee's to grant — the zee never touches it. Atomic: if another xell holds
  // prod, this ship WAITS as 'approved' rather than queue-jumping; the reaper retries when free.
  const got = await one(
    `INSERT INTO deploy_lock (project_id, container, xell_id, zee_id, phase, task, ship_id)
       VALUES ($1,'prod',$2,$3,'shipping',$4,$5)
       ON CONFLICT (project_id, container) DO NOTHING RETURNING *`,
    [project.id, xell.id, ship.zee_id, ship.reason || 'ship to production', ship.id]);
  if (!got) {
    const held = await one(
      `SELECT dl.*, x.slug FROM deploy_lock dl JOIN xell x ON x.id=dl.xell_id
         WHERE dl.project_id=$1 AND dl.container='prod'`, [project.id]);
    logline('ship', `${xell.slug} ship WAITING — ${held?.slug || 'another xell'} holds prod`);
    return; // stays 'approved'; tick() retries when the lock frees
  }
  broadcast('xell', { id: xell.id });
  logline('lock', `queenzee ASSIGNED prod lock to ${xell.slug} for ship ${String(ship.commit).slice(0, 8)}`);

  const shipping = await one(
    `UPDATE ship_request SET status='shipping', started_at=now() WHERE id=$1 RETURNING *`, [ship.id]);
  broadcast('ship', shipping);

  // Production's BUILD SOURCE is local main — not the xell's worktree, and not the xource
  // checkout's wandering HEAD (which is what this actually built until 2026-07-16). origin is a
  // backup and is never read. This is the anti-band-aid rule.
  // Only the roles the ZEE NAMED (ship.targets, validated at request time) — a webapp-only change
  // has no business recreating the live prod server as a side effect.
  const cs = await q(
    `SELECT * FROM container WHERE project_id=$1 AND tier='prod' AND role = ANY($2)
       AND build_script IS NOT NULL ORDER BY role`,
    [project.id, ship.targets?.length ? ship.targets : SHIPPABLE]);

  const results = [];
  let ok = cs.length > 0;
  if (!cs.length) {
    ok = false;
    results.push({ error: 'no prod container has a build_script configured — nothing to ship' });
  }
  for (const c of cs) {
    // ship.commit is the sha the HUMAN approved. Passing it (rather than letting the script say
    // "main") also means a main that moved between approval and build cannot smuggle in commits
    // nobody signed off on.
    const r = await runScript(c, project.repo_root, ship.commit);

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

    results.push({ container: c.name, role: c.role, ok: r.ok, method: r.json?.method || null, error: r.ok ? null : r.err });
    if (!r.ok) { ok = false; break; }   // stop at the first failure — do not half-ship prod
  }

  const done = await one(
    `UPDATE ship_request SET status=$2, finished_at=now(), containers=$3::jsonb, error=$4
       WHERE id=$1 RETURNING *`,
    [ship.id, ok ? 'shipped' : 'failed', JSON.stringify(results),
      ok ? null : (results.find((r) => !r.ok)?.error || 'ship failed').slice(0, 1500)]);
  broadcast('ship', done);
  logline('ship', ok
    ? `SHIPPED ${String(ship.commit).slice(0, 8)} to prod from ${xell.slug} (${MODE})`
    : `ship FAILED for ${xell.slug}: ${done.error}`);

  // Countdown starts either way: a failed ship must not sit on prod forever either.
  const lock = await one(
    `UPDATE deploy_lock SET phase=$2, auto_release_at = now() + ($3 || ' seconds')::interval
       WHERE project_id=$1 AND container='prod' AND ship_id=$4 RETURNING *`,
    [project.id, ok ? 'awaiting-verification' : 'failed', String(AUTO_RELEASE_SEC), ship.id]);
  if (lock) broadcast('xell', { id: xell.id });
  notifyShipDone({ project, xell, ok, request: done, seconds: AUTO_RELEASE_SEC });
}

function runScript(container, sourcePath, buildRef = 'main') {
  return new Promise((res) => {
    const exec = container.build_exec || 'bash';
    const p = spawn(exec, [container.build_script, sourcePath, container.role, container.docker_ctx || '', MODE, buildRef],
      { env: cleanGitEnv(), windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      let json = null; try { json = JSON.parse(line); } catch { /* no json line */ }
      res({ ok: !!json && json.ok !== false, json, err: (err || out).slice(-1500) });
    });
    p.on('error', (e) => res({ ok: false, json: null, err: String(e.message) }));
  });
}

// ── the lock's own lifecycle ─────────────────────────────────────────────────
// HOLD cancels the countdown for a human who is actively verifying. Only a human can do this —
// there is no zee path to it, by design.
export async function holdProdLock(projectId, by = 'human@console') {
  const row = await one(
    `UPDATE deploy_lock SET held=true, auto_release_at=NULL
       WHERE project_id=$1 AND container='prod' RETURNING *`, [projectId]);
  if (!row) throw new Error('nobody holds prod');
  broadcast('xell', { id: row.xell_id });
  logline('lock', `prod lock HELD open by ${by} — countdown cancelled, release is manual now`);
  return row;
}

export async function forceReleaseProdLock(projectId, by = 'human@console') {
  const row = await one(`SELECT * FROM deploy_lock WHERE project_id=$1 AND container='prod'`, [projectId]);
  if (!row) throw new Error('nobody holds prod');
  await q(`DELETE FROM deploy_lock WHERE id=$1`, [row.id]);
  broadcast('xell', { id: row.xell_id });
  broadcast('ship', { id: row.ship_id });
  logline('lock', `prod lock FORCE-RELEASED by ${by}`);
  return { released: true };
}

// Reaper tick: release expired locks, and start any ship that was waiting for prod to free up.
export async function tick() {
  const expired = await q(
    `DELETE FROM deploy_lock
       WHERE container='prod' AND held=false AND auto_release_at IS NOT NULL AND auto_release_at <= now()
       RETURNING *`);
  for (const l of expired) {
    const x = await one(`SELECT slug FROM xell WHERE id=$1`, [l.xell_id]);
    logline('lock', `prod lock auto-released from ${x?.slug || l.xell_id} (countdown expired) — prod is free`);
    broadcast('xell', { id: l.xell_id });
  }
  // Approved-but-waiting ships: prod may be free now.
  const waiting = await q(
    `SELECT s.id FROM ship_request s
       WHERE s.status='approved'
         AND NOT EXISTS (SELECT 1 FROM deploy_lock dl WHERE dl.project_id=s.project_id AND dl.container='prod')
       ORDER BY s.decided_at LIMIT 1`);
  for (const w of waiting) await runShip(w.id).catch((e) => console.error('[ship] retry failed:', e.message));
  return { released: expired.length, started: waiting.length };
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
