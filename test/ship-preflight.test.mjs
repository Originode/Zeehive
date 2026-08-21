// SHIP-PRE-FLIGHT test (ticket #58) — the deploy's preconditions are checked and recorded at
// REQUEST time, so the card shows "cannot ship, because X" BEFORE a human spends attention
// approving it. 8 of 31 ship failures were facts knowable at request time: a prod db row with no
// host_port, a target db that cannot be inspected on its docker context.
//
// Part A drives runShipPreflight DIRECTLY with an injectable docker adapter (deterministic — no
// daemon needed): the migration-target guard from shipmigrate.js (unaddressed row → missing;
// inspect confirms the address → ok; inspect contradicts → missing), build-targets inventory,
// deploy-context reachability (unreachable → unknown, never a hard red).
//
// Part B drives the REAL requestShip against a throwaway postgres + real git repo (the sandbox has
// NO docker, so the pre-flight's unaddressed prod-db row fails deterministically before any daemon
// call): the row records preflight/preflight_at/preflight_error, the verdict is 'missing', the
// auto-approve policy is HELD on a definite miss, and pendingMigrations failing at request time
// rides the row as migrations_error instead of silently becoming "no migrations".
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required — run against a throwaway db (zee db-sandbox --migrate)'); process.exit(2); }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'ship-preflight-'));
const PID = '00000000-0000-4000-8000-00000000f111';
const XOURCE = '00000000-0000-4000-8000-00000000f222';
const XELL = '00000000-0000-4000-8000-00000000f333';

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

await client.connect();
try {
  await client.query(`DELETE FROM project WHERE id=$1`, [PID]).catch(() => {});
  const { requestShip } = await import('../server/src/queenzee/shipgate.js');
  const { runShipPreflight, runShipPreflightAndNote } = await import('../server/src/queenzee/ship-preflight.js');
  const { prodDb } = await import('../server/src/queenzee/shipmigrate.js');

  // a real xource with a real main, and a real xell worktree on its own branch — LANDED
  const repo = join(tmp, 'xource'); mkdirSync(repo);
  git(tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@zeehive');
  git(repo, 'config', 'user.name', 'ship-preflight-test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const wt = join(tmp, 'xell');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/ship-preflight-test', wt);
  writeFileSync(join(wt, 'b.txt'), 'work\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'landed work');
  git(repo, 'merge', '-q', '--ff-only', 'spinoff/ship-preflight-test');

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'ship-preflight-test',$2,'main')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'main')`, [XOURCE, PID]);
  await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status)
       VALUES ($1,$2,$3,'ship-preflight-cove','spinoff/ship-preflight-test',$4,'working')`, [XELL, PID, XOURCE, wt]);
  const project = (await client.query(`SELECT * FROM project WHERE id=$1`, [PID])).rows[0];

  // a docker adapter that answers from a FIXTURE, never a daemon
  const stubDocker = (fixtures) => async (ctx, args) => {
    const key = `${ctx} ${args[0]}`;
    const hit = fixtures[key];
    if (hit) return hit;
    return { unknown: true, reason: `no fixture for ${key}` };
  };

  // ── Part A: the probes, driven directly with a stub docker ───────────────────
  console.log('\n── Part A: runShipPreflight with an injectable docker ──');

  // A1. unaddressed prod db row → db-migration-target MISSING (the exact 5+3 hole)
  const dbA1 = await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx)
       VALUES ($1,'db','prod','shared','pf58_a1_db','default') RETURNING id`, [PID]);
  const vA1 = await runShipPreflight(project, null, 'main', ['server', 'webapp'],
    { docker: stubDocker({}) });
  const m1 = vA1.checks.find((c) => c.check === 'db-migration-target');
  ok(vA1.status === 'missing', `A1: an unaddressed prod db row → '${vA1.status}'`);
  ok(m1?.ok === false && m1?.unknown === false, 'A1: the db-migration-target check FAILED (not unknown)');
  ok(/neither a host_port nor a network host/.test(m1?.detail || ''), `A1: …and names the hole (${m1?.detail?.slice(0, 60)}…)`);
  ok((vA1.error || '').startsWith('db-migration-target: '), 'A1: the combined error names the failing check');
  await client.query(`DELETE FROM container WHERE id=$1`, [dbA1.rows[0].id]);

  // A2. a row whose host_port IS confirmed by docker → db-migration-target ok
  const dbA2 = await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host_port)
       VALUES ($1,'db','prod','shared','pf58_a2_db','default',15432) RETURNING id`, [PID]);
  const passDocker = stubDocker({
    'default inspect': { status: 0, stdout: '{"5432/tcp":[{"HostPort":"15432"}]}', stderr: '' },
  });
  const vA2 = await runShipPreflight(project, null, 'main', ['server', 'webapp'], { docker: passDocker });
  const m2 = vA2.checks.find((c) => c.check === 'db-migration-target');
  ok(m2?.ok === true, `A2: the host_port the row records IS published → ${m2?.detail?.slice(0, 60)}`);
  await client.query(`DELETE FROM container WHERE id=$1`, [dbA2.rows[0].id]);

  // A3. the row records a port docker does NOT publish → db-migration-target MISSING
  const dbA3 = await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host_port)
       VALUES ($1,'db','prod','shared','pf58_a3_db','default',15433) RETURNING id`, [PID]);
  const wrongDocker = stubDocker({
    'default inspect': { status: 0, stdout: '{"5432/tcp":[{"HostPort":"15999"}]}', stderr: '' },
  });
  const vA3 = await runShipPreflight(project, null, 'main', ['server', 'webapp'], { docker: wrongDocker });
  const m3 = vA3.checks.find((c) => c.check === 'db-migration-target');
  ok(vA3.status === 'missing' && m3?.ok === false, `A3: a port the container does NOT publish → '${vA3.status}'`);
  ok(/does not publish the prod db row's host_port 15433/.test(m3?.detail || ''), 'A3: …and names the mismatch');
  await client.query(`DELETE FROM container WHERE id=$1`, [dbA3.rows[0].id]);

  // A4. build-targets: no buildable prod container for the targets → MISSING
  const vA4 = await runShipPreflight(project, null, 'main', ['server', 'webapp'],
    { docker: stubDocker({}) });
  const b4 = vA4.checks.find((c) => c.check === 'build-targets');
  ok(b4?.ok === false && /nothing to ship/.test(b4?.detail || ''),
     `A4: no buildable container → build-targets FAILS (${b4?.detail?.slice(0, 50)}…)`);

  // A5. buildable containers EXIST → build-targets ok (and the context check sees them)
  const webApp = await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, build_script)
       VALUES ($1,'webapp','prod','shared','pf58_web','default','scripts/ship-webapp.sh') RETURNING id`, [PID]);
  const server = await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, build_script)
       VALUES ($1,'server','prod','shared','pf58_srv','mardale','scripts/ship-server.sh') RETURNING id`, [PID]);
  const vA5 = await runShipPreflight(project, null, 'main', ['server', 'webapp'],
    { docker: passDocker });
  const b5 = vA5.checks.find((c) => c.check === 'build-targets');
  ok(b5?.ok === true && /2 prod container/.test(b5?.detail || ''), `A5: the build inventory names both targets (${b5?.detail})`);

  // A6. deploy-context: a context docker cannot answer → UNKNOWN, never a hard red
  // (a prod db row with the SAME host_port keeps the migration-target check green, so the only
  // non-green check is the unreachable contexts)
  const dbA6 = await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host_port)
       VALUES ($1,'db','prod','shared','pf58_a6_db','default',15432) RETURNING id`, [PID]);
  const noDaemon = stubDocker({
    'default inspect': { status: 0, stdout: '{"5432/tcp":[{"HostPort":"15432"}]}', stderr: '' },
    // 'default info' and 'mardale info' have NO fixture → the adapter reports unknown
  });
  const vA6 = await runShipPreflight(project, null, 'main', ['server', 'webapp'], { docker: noDaemon });
  const d6 = vA6.checks.find((c) => c.check === 'deploy-context');
  ok(d6?.unknown === true, `A6: an unreachable docker context → deploy-context UNKNOWN (${d6?.detail?.slice(0, 60)}…)`);
  ok(vA6.status === 'unknown', `A6: …and the verdict is 'unknown' (${vA6.status}), not 'missing'`);

  // A7. every check green → ok
  const allGood = stubDocker({
    'default inspect': { status: 0, stdout: '{"5432/tcp":[{"HostPort":"15432"}]}', stderr: '' },
    'default info': { status: 0, stdout: '27.0.1', stderr: '' },
    'mardale info': { status: 0, stdout: '26.1.4', stderr: '' },
  });
  const vA7 = await runShipPreflight(project, null, 'main', ['server', 'webapp'], { docker: allGood });
  ok(vA7.status === 'ok' && vA7.error === null, `A7: all preconditions met → '${vA7.status}'`);
  ok(vA7.checks.length === 3 && vA7.checks.every((c) => c.ok),
     'A7: every check passed (db-migration-target, build-targets, deploy-context)');

  // A8. runShipPreflightAndNote stamps the row (a probe must never THROW through the gate)
  const noted = await runShipPreflightAndNote('00000000-0000-4000-8000-000000000000',
    project, null, 'main', ['server', 'webapp'], { docker: allGood });
  ok(noted.status === 'ok', 'A8: runShipPreflightAndNote returns the verdict, never throws');
  await client.query(`DELETE FROM container WHERE id=$1`, [dbA6.rows[0].id]);

  // ── Part B: the REAL requestShip wires it (sandbox has no docker → deterministic) ──
  // This process runs SHIP_MODE=simulate, so requestShip's pre-flight skips db-migration-target
  // (runShipBody would record migrations as not-applied-simulate). The definite miss to exercise
  // through the real gate is build-targets: drop the Part A build containers so there is nothing
  // to ship — a miss that is mode-INDEPENDENT (runShipBody fails on an empty inventory before it
  // ever reaches the migration branch).
  console.log('\n── Part B: requestShip records the pre-flight on the row ──');
  await client.query(`DELETE FROM container WHERE id=$1`, [webApp.rows[0].id]);
  await client.query(`DELETE FROM container WHERE id=$1`, [server.rows[0].id]);

  // B1. a definite miss → the request is created WITH the pre-flight failure recorded
  const rB1 = await requestShip({ xellId: XELL, reason: 'ship the landed work', targets: ['server', 'webapp'] });
  ok(rB1.ok === true && !!rB1.request?.id, 'B1: the ask still becomes a row (a pre-flight does not refuse the ask)');
  const b1 = await client.query(`SELECT * FROM ship_request WHERE id=$1`, [rB1.request.id]);
  const rowB1 = b1.rows[0];
  ok(rowB1.status === 'pending', `B1: the row is pending (${rowB1.status}) — a human still sees the card`);
  ok(rowB1.preflight_at && rowB1.preflight_error, 'B1: preflight_at AND preflight_error are recorded');
  ok(Array.isArray(rowB1.preflight) && rowB1.preflight.length === 3,
     'B1: every check is kept on the row, not just the failure');
  ok(/no prod container for server\/webapp has a build_script/.test(rowB1.preflight_error || ''),
     `B1: the failure NAMES the missing build target (${rowB1.preflight_error?.slice(0, 80)}…)`);
  // the simulate-scope db check is SKIPPED on the record, not silently absent — honest either way
  const b1Db = rowB1.preflight.find((c) => c.check === 'db-migration-target');
  ok(b1Db?.skipped === true && /models the fleet/.test(b1Db?.detail || ''),
     'B1: db-migration-target reports SKIPPED (simulate scope), with the reason on the record');
  // pendingMigrations failed at request time (no docker to read the prod ledger) → recorded, not dropped
  ok(!!rowB1.migrations_error, 'B1: migrations_error is recorded (UNKNOWN beats silently zero)');
  await client.query(`DELETE FROM ship_request WHERE id=$1`, [rB1.request.id]);

  // B2. auto-approve policy is HELD on a definite miss — the whole point of pre-flight
  await client.query(`UPDATE project SET auto_approve_ship=true WHERE id=$1`, [PID]);
  const rB2 = await requestShip({ xellId: XELL, reason: 'auto-approve must hold on a known miss' });
  ok(rB2.ok === true && rB2.request.status === 'pending',
     `B2: auto-approve HELD — the request stays pending (${rB2.request.status}), not approved`);
  ok(/pre-flight found a missing prerequisite/.test(rB2.note || ''),
     'B2: the note tells the zee WHY policy would not deploy it');
  ok(/A human can still ship it manually/.test(rB2.note || ''), 'B2: …and that a human still can');
  const b2 = await client.query(`SELECT status, decided_at FROM ship_request WHERE id=$1`, [rB2.request.id]);
  ok(b2.rows[0].status === 'pending' && !b2.rows[0].decided_at, 'B2: the row is untouched — nothing decided');
  await client.query(`DELETE FROM ship_request WHERE id=$1`, [rB2.request.id]);
  await client.query(`UPDATE project SET auto_approve_ship=false WHERE id=$1`, [PID]);
} finally {
  await cleanup();
  await client.end();
  const { pool } = await import('../server/src/db/pool.js');
  await pool.end().catch(() => {});
}

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);
