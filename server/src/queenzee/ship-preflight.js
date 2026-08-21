// SHIP PRE-FLIGHT — CHECK THE DEPLOY'S PRECONDITIONS BEFORE A HUMAN APPROVES (ticket #58).
//
// 8 of 31 ship failures were facts knowable at request time (a prod db row with no host_port; a
// target db that cannot be inspected on its docker context), and the rest stored ~400 characters of
// raw docker log as the "cause". This module runs the READ-ONLY probes that answer "can this ship
// actually deploy?" and stamps the verdict on the ship_request row where the human's card reads it.
//
// Same contract as preflight.js (TKT-53) and build-readiness.js (TKT-173):
//   • never WRITES — no row, no docker object, no build, no migration. A probe that fixes what it
//     checks would be a preflight that damages what it checks.
//   • never THROWS for a verdict outcome — a preflight that can fail requestShip would be a new way
//     to break the ship gate.
//   • never reports GREEN for a check it could not run — an unreachable context or an absent docker
//     carries the reason and flips that check to 'unknown', a first-class verdict, never green.
//
// Verdict shape (mirrors build-readiness): { status: 'ok'|'missing'|'unknown', error, checks }.
//   ok      → every check passed; the deploy's preconditions are met.
//   missing → at least one check FAILED — a definite missing prerequisite is named.
//   unknown → nothing failed, but a check could not be run (docker absent / context unreachable).
//
// The checks, from the deploy path the ship actually walks (shipgate.runShipBody / shipmigrate):
//   • db-migration-target — the production db the migration step will open: the registry row is
//     present, carries an address (host_port or a conn_ref network alias), and docker confirms the
//     container publishes that address. The exact guard applyMigrations runs BEFORE any write, so
//     the "refusing to migrate …" failures (5+3 in the ticket) are caught at request time.
//   • build-targets       — at least one prod container for the requested role(s) has a build_script
//     (the "no prod container has a build_script configured — nothing to ship" failure).
//   • deploy-context      — the docker contexts the deploy will touch (each buildable container's
//     and the prod db's) answer `docker info`. Unreachable → 'unknown', never a hard red.
import { spawn } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { prodDb, prodDbAddress, decideProdDbTarget, inspectFormatFor } from './shipmigrate.js';

export const SHIP_PREFLIGHT_TIMEOUT_MS = 8000;

const pass = (check, detail) => ({ check, ok: true, skipped: false, unknown: false, detail });
const fail = (check, detail) => ({ check, ok: false, skipped: false, unknown: false, detail });
const skip = (check, detail) => ({ check, ok: true, skipped: true, unknown: false, detail });
const unk = (check, detail) => ({ check, ok: false, skipped: false, unknown: true, detail });

// The one thin docker adapter. Default shells out to `docker --context <ctx> <args…>` exactly the
// way build-readiness.js does — genuinely ASYNC (a spawnSync adapter would serialize every docker
// call on the single Node event loop and freeze the queenzee) and INJECTABLE so the probes run in
// tests without a docker daemon. Resolves { status, stdout, stderr } when the CLI answered, or
// { unknown, reason } when it could not run at all (no docker binary, spawn error, timeout).
export function dockerAdapter(ctx, args, { timeout = SHIP_PREFLIGHT_TIMEOUT_MS, bin = 'docker' } = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      // Timeout: kill the child so no docker process leaks past the ceiling, then report unknown.
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ unknown: true, reason: `${bin} --context ${ctx} did not answer within ${timeout}ms` });
    }, timeout);
    timer.unref?.();   // never keep the process alive for a probe that may already be done
    try {
      child = spawn(bin, ['--context', ctx, ...args], { windowsHide: true });
    } catch (e) {
      finish({ unknown: true, reason: e.message });
      return;
    }
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ unknown: true, reason: e.message }));
    child.on('close', (code, signal) => {
      if (signal || code == null) {
        finish({ unknown: true, reason: `${bin} --context ${ctx} did not answer` });
        return;
      }
      finish({ status: code, stdout, stderr });
    });
  });
}

// The prod containers a ship would build for `targets` on `site` — the SAME inventory runShipBody
// walks (container.build_script IS NOT NULL, tier='prod', role in targets, site-scoped). Shared by
// the build-targets and deploy-context checks so the two cannot disagree about what ships.
async function prodBuildableContainers(project, site, targets) {
  return q(
    `SELECT role, name, build_script, docker_ctx, url FROM container
      WHERE project_id=$1 AND tier='prod' AND role = ANY($2) AND build_script IS NOT NULL
        AND ($3::uuid IS NULL AND (site_id IS NULL OR site_id IN
              (SELECT id FROM deploy_site WHERE project_id=$1 AND tier='prod' AND is_default))
             OR site_id = $3::uuid OR ($3::uuid IS NOT NULL AND site_id IS NULL AND $4))
       ORDER BY role DESC`,
    [project.id, targets, site?.id || null, !!site?.is_default]);
}

// CHECK 1 — the migration target. Resolves the prod db row the same way applyMigrations does and
// runs the SAME identity guard decideProdDbTarget (via the injectable docker adapter instead of a
// blocking spawnSync). This is the whole "the prod db row records no host_port" + "cannot inspect …
// on its docker context" failure family, caught before a human approves.
//
// The check mirrors runShipBody's migration branch EXACTLY: when the ship is scoped to code only
// (skipDb) or the queenzee is simulating (mode !== 'real'), the deploy path records the migration
// step as a deliberate SKIP / not-applied and moves on — the target db is not a precondition of
// THAT ship, so the pre-flight reports the check as skipped, never as a hard miss. A real ship
// with no code-only scope runs applyMigrations, so the target is checked hard.
async function checkDbMigrationTarget(db, docker, { skipDb = false, mode = 'real' } = {}) {
  if (skipDb) {
    return skip('db-migration-target', 'the ship was scoped to code only (skip_migrations) — the migration step is deliberately not part of this deploy');
  }
  if (mode !== 'real') {
    return skip('db-migration-target', `SHIP_MODE=${mode} — this queenzee models the fleet and does not write to the production database; the migration target is not exercised`);
  }
  if (db && db._error) return fail('db-migration-target', `could not resolve the production database: ${db._error}`);
  if (!db) return fail('db-migration-target', 'no prod db container registered for this project — the migration step has nothing to target');

  const addr = prodDbAddress(db);
  // An unaddressed row needs NO daemon: decideProdDbTarget refuses it on the row alone.
  if (addr.mode === 'none') return fail('db-migration-target', decideProdDbTarget(db, null).error);

  const r = await docker(db.ctx, ['inspect', '--format', inspectFormatFor(addr.mode), db.container]);
  const inspect = r.unknown
    ? { status: 1, stderr: r.reason, error: { message: r.reason } }
    : { status: r.status, stdout: r.stdout, stderr: r.stderr };
  const verdict = decideProdDbTarget(db, inspect);
  if (!verdict.ok) return fail('db-migration-target', verdict.error);
  return pass('db-migration-target',
    `production database ${db.container} on ${db.ctx} carries the address the registry row records `
    + `(${addr.mode === 'port' ? `host_port ${addr.port}` : `network alias '${addr.alias}'`})`);
}

// CHECK 2 — the build inventory. A ship with no buildable prod container for its target(s) fails
// at "no prod container has a build_script configured — nothing to ship" AFTER the human approves;
// name it before.
async function checkBuildTargets(project, site, targets) {
  const cs = await prodBuildableContainers(project, site, targets);
  if (!cs.length) {
    return fail('build-targets',
      `no prod container for ${targets.join('/')} has a build_script configured — nothing to ship`);
  }
  return pass('build-targets',
    `${cs.length} prod container(s) build from the requested target(s): `
    + cs.map((c) => `${c.role} (${c.name})`).join(', '));
}

// CHECK 3 — the deploy contexts. Every docker context the deploy will touch (each buildable
// container's, and the prod db's) must answer `docker info`. A daemon that is down or a context
// that is misconfigured means the build cannot run; docker absent entirely is 'unknown' (cannot
// tell), never a hard red — the same direction build-readiness.js takes for an unreachable daemon.
async function checkDeployContext(project, site, targets, docker, db = null) {
  const cs = await prodBuildableContainers(project, site, targets);
  const ctxs = new Set(cs.map((c) => c.docker_ctx).filter(Boolean));
  if (db && db.ctx) ctxs.add(db.ctx);
  if (!ctxs.size) {
    return skip('deploy-context', 'no docker contexts involved in this ship (no buildable containers, no prod db)');
  }

  const probes = await Promise.all([...ctxs].map(async (ctx) => {
    const r = await docker(ctx, ['info', '--format', '{{.ServerVersion}}']);
    if (r.unknown) {
      return { ctx, ok: false, unknown: true,
               detail: `cannot reach docker context '${ctx}': ${r.reason}` };
    }
    if (r.status !== 0) {
      const why = (r.stderr || r.stdout || '').trim().split('\n').pop()
        || `docker --context ${ctx} exited ${r.status}`;
      return { ctx, ok: false, unknown: true,
               detail: `daemon on '${ctx}' did not answer: ${why.slice(0, 300)}` };
    }
    return { ctx, ok: true, detail: `daemon on '${ctx}' reachable (docker ${(r.stdout || '').trim()})` };
  }));

  const unreachable = probes.filter((p) => !p.ok);
  if (unreachable.length) {
    return unk('deploy-context', unreachable.map((p) => p.detail).join(' · '));
  }
  return pass('deploy-context', probes.map((p) => p.detail).join(' · '));
}

// Run every pre-flight check for one ship and return the verdict. NEVER throws for a verdict
// outcome — a ship request must not fail because a probe misbehaved.
// `skipDb` and `mode` mirror the ship's own scope (runShipBody): a code-only ship or a simulating
// queenzee deliberately does not run the migration step, so the migration-target check reports
// SKIPPED rather than a hard miss — the pre-flight reflects the deploy that will actually happen.
export async function runShipPreflight(project, site, commit, targets,
                                       { docker = dockerAdapter, skipDb = false, mode = 'real' } = {}) {
  const scope = { skipDb, mode };
  const checks = [];
  // Resolve the prod db ONCE and share the handle: prodDb() does a blocking docker ps internally
  // (resolveRealDbContainer), so resolving it in every check would multiply the request-time probe
  // latency. Only a REAL ship that will run migrations needs the db at all — a code-only or
  // simulating ship skips the migration-target check before the handle is ever opened. A resolution
  // error rides on the handle ({ _error }) so the check can name it, never a throw.
  try {
    let db = null;
    if (!skipDb && mode === 'real') {
      try { db = await prodDb(project, site); } catch (e) { db = { _error: e.message }; }
    }
    checks.push(await checkDbMigrationTarget(db, docker, scope));
    checks.push(await checkBuildTargets(project, site, targets));
    checks.push(await checkDeployContext(project, site, targets, docker, db));
  } catch (e) {
    // A READ-ONLY advisory probe must NEVER be the reason a ship cannot be raised: the whole point
    // is to inform the ask, so a probe that misbehaves — a transient DB error in the inventory read
    // (prodBuildableContainers), a throwing adapter, anything — degrades to 'unknown' and the card
    // still gets raised; the deploy's own guards stay the backstop. Same rule as work-overlap.js's
    // outer catch: "a coordination hint must never be the reason a sync does not happen or a land
    // is refused." The checks that DID complete still ride the verdict, so nothing verified is lost.
    return {
      status: 'unknown',
      error: `preflight could not run: ${e.message}`,
      checks,
      at: new Date().toISOString(),
      commit,
    };
  }

  const definite = checks.filter((c) => !c.ok && !c.unknown);
  const unknown = checks.filter((c) => c.unknown);
  let status = 'ok';
  if (definite.length) status = 'missing';
  else if (unknown.length) status = 'unknown';
  const error = status === 'ok' ? null
    : (definite.length ? definite : unknown).map((c) => `${c.check}: ${c.detail}`).join(' · ');
  return { status, error, checks, at: new Date().toISOString(), commit };
}

// Stamp the verdict on a ship_request row. Never throws and never lets bookkeeping about a probe
// become a second way for the probe to fail — the same rule notePreflight follows. Returns the
// verdict; the caller broadcasts the row if it wants the card to update.
export async function noteShipPreflight(shipId, verdict) {
  await one(
    `UPDATE ship_request SET preflight=$2::jsonb, preflight_at=now(), preflight_error=$3
       WHERE id=$1 RETURNING id`,
    [shipId, JSON.stringify(verdict?.checks || []), verdict?.error || null]);
  return verdict;
}

// Run the pre-flight AND record it — what every ship call-site wants. Never throws: a ship whose
// pre-flight could not run is reported as an unknown verdict, not a failed request.
export async function runShipPreflightAndNote(shipId, project, site, commit, targets,
                                              { docker = dockerAdapter, skipDb = false, mode = 'real' } = {}) {
  let verdict;
  try {
    verdict = await runShipPreflight(project, site, commit, targets, { docker, skipDb, mode });
  } catch (e) {
    verdict = { status: 'unknown', error: `preflight could not run: ${e.message}`,
                checks: [], at: new Date().toISOString(), commit };
  }
  try { await noteShipPreflight(shipId, verdict); } catch { /* the probe matters more than the note */ }
  return verdict;
}
