// POOL PROCESS-LOCAL MACHINE — per-machine pooling honored for runner:process projects on the
// ONE machine their xells actually live on (docs/process-machine-pooling-decision-record.md).
//
// A process xell's worktree, server/webapp processes and cage all live on the queenzee host by
// construction, so the queenzee-host machine row's pool_size GOVERNS such a project — counted
// PROJECT-WIDE (no docker_ctx join: process server rows carry docker_ctx=NULL, and the join
// count of zero-forever is exactly the 167-xell runaway the old blanket guard existed to stop).
// Remote rows stay a dead letter and the loud guard names only those.
//
// Companions: test/pool-machine-guard-silence.test.mjs (remote-only config stays loud + legacy),
// test/pool-machine-placeable-without-compose.test.mjs (compose projects take the full machine
// path). This drives the real ensureReady() in simulate mode against a fixture queenzee-host
// machine ('default' context) plus a HIGHER-PRIORITY remote machine, and asserts:
//   1. fill provisions exactly the HOST row's pool_size (not the remote's, not the project-wide
//      target) and a second tick does not overshoot — the project-wide count works;
//   2. process modeling is preserved: server containers carry docker_ctx=NULL;
//   3. the per-xell db container is PINNED to the queenzee host even though the remote machine
//      outranks it on dev_priority (the mis-placement defect: a remote-placed meta-DB is
//      unreachable over zee-hive-net from the local processes);
//   4. the loud DISABLED line names ONLY the remote machine and says the host row governs;
//   5. max_xells caps the fill through the NULL-ctx-aware liveXellCount.
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';   // before any import: no machine may be touched

const { q, one, pool } = await import('../server/src/db/pool.js');
const { ensureReady } = await import('../server/src/queenzee/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const { liveXellCount, queenzeeHostCtx } = await import('../server/src/lib/machines.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const hostCtx = queenzeeHostCtx();
const remoteCtx = `zt-pl-ctx-${tag}`;
const remoteKey = `zt-pl-rem-${tag}`;
let hostMachineId = null, hostMachineCreated = false, hostMaxXellsBefore = null;
let remoteMachineId = null, projId = null;

// Zeehive-shaped: process runner on the spinoff tier and both app roles, db-isolated coupling
// so provisioning models the per-xell db container (the one docker-placed piece — the row is
// inserted in simulate too, docker run only in real mode).
const processManifest = {
  tiers: {
    spinoff: {
      runner: 'process',
      ports: {
        server: { env: 'PORT', base: 4800, mod: 90 },
        webapp: { env: 'WEB_PORT', base: 5300, mod: 90 },
      },
    },
  },
  roles: {
    server: { service: 'server', runner: 'process' },
    webapp: { service: 'web', runner: 'process' },
  },
};

try {
  // The queenzee-host machine row: docker_ctx is UNIQUE, so reuse an existing row (a dev DB has
  // one) and only restore what this test changes; a fresh sandbox gets a created row.
  const existingHost = await one(`SELECT id, key, max_xells FROM machine WHERE docker_ctx=$1`, [hostCtx]);
  if (existingHost) {
    hostMachineId = existingHost.id;
    hostMaxXellsBefore = existingHost.max_xells;
  } else {
    hostMachineId = (await one(
      `INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,9,true) RETURNING id`,
      [`zt-pl-local-${tag}`, hostCtx])).id;
    hostMachineCreated = true;
  }
  const hostKey = (await one(`SELECT key FROM machine WHERE id=$1`, [hostMachineId])).key;
  remoteMachineId = (await one(
    `INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
     VALUES ($1,$2,'10.2.0.99',9,true) RETURNING id`,
    [remoteKey, remoteCtx])).id;

  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,NULL) RETURNING id`,
    [`zt-pl-proj-${tag}`, `/tmp/zt-pl-${tag}`, JSON.stringify(processManifest)])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projId]);
  // Project-wide target 0 — the legacy path would provision NOTHING. db-isolated so the
  // per-xell db container row exists to assert placement on.
  await q(`INSERT INTO pool_config (project_id, target_ready, default_db_coupling)
           VALUES ($1,0,'db-isolated')`, [projId]);
  // The trap: the REMOTE machine outranks the host on dev_priority AND asks for a bigger pool.
  // Neither number may have any effect on a process project.
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES ($1,$2,2,2)`,
    [hostMachineId, projId]);
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES ($1,$2,3,5)`,
    [remoteMachineId, projId]);

  const mark = recentLogs(2000).length;
  await ensureReady();
  const poolLines = recentLogs(2000).slice(mark).filter((l) => l.scope === 'pool').map((l) => l.msg);

  console.log('\n── fill honors the queenzee-host row\'s pool_size, project-wide count ──');
  const xells = await q(
    `SELECT x.id, x.slug, c.docker_ctx
       FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
      WHERE x.project_id=$1 AND x.status='ready'`, [projId]);
  ok(xells.length === 2,
     `provisioned host pool_size=2 ready xells (got ${xells.length}) — target_ready=0 would give 0, the remote's pool_size would give 3`);
  ok(xells.every((x) => x.docker_ctx === null),
     `process modeling preserved: every server container has docker_ctx=NULL (got ${[...new Set(xells.map((x) => String(x.docker_ctx)))].join(',')})`);

  console.log('\n── the per-xell db container is pinned to the queenzee host ──');
  const dbs = await q(
    `SELECT c.docker_ctx FROM container c JOIN xell x ON x.id = c.owner_xell_id
      WHERE x.project_id=$1 AND c.role='db' AND c.isolation='per-xell'`, [projId]);
  ok(dbs.length === 2, `each xell modeled its own db container (got ${dbs.length}, wanted 2)`);
  ok(dbs.every((c) => c.docker_ctx === hostCtx),
     `every per-xell db is on '${hostCtx}' despite the remote machine's higher dev_priority (got ${[...new Set(dbs.map((c) => c.docker_ctx))].join(',')})`);

  console.log('\n── the no-effect line names ONLY the remote machine ──');
  const warned = poolLines.find((l) => /per-machine pooling has no effect on \[/.test(l));
  ok(!!warned, 'a no-effect line was recorded (the remote config is still a dead letter — informational, not an alert)');
  const named = warned && (warned.match(/no effect on \[([^\]]*)\]/) || [])[1];
  ok(named === remoteKey, `the no-effect list is exactly the remote machine (got [${named}])`);
  ok(!!warned && warned.includes(`governed by '${hostKey}'`),
     `…and it says pooling is governed by the queenzee-host row '${hostKey}'`);

  console.log('\n── a second tick does not overshoot (the count is not stuck at zero) ──');
  await ensureReady();
  const after = await one(`SELECT count(*)::int AS n FROM xell WHERE project_id=$1 AND status='ready'`, [projId]);
  ok(after?.n === 2, `still exactly 2 ready after a second tick (got ${after?.n}) — no runaway fill`);

  console.log('\n── max_xells caps the fill through the NULL-ctx-aware live count ──');
  const live = await liveXellCount(hostCtx);
  ok(live >= 2, `liveXellCount('${hostCtx}') sees the NULL-ctx process xells (got ${live}, wanted ≥2)`);
  // Freeze the cap at today's live count and ask for a bigger pool: room must be zero.
  await q(`UPDATE machine SET max_xells=$2 WHERE id=$1`, [hostMachineId, live]);
  await q(`UPDATE machine_pool SET pool_size=5 WHERE machine_id=$1 AND project_id=$2`, [hostMachineId, projId]);
  await ensureReady();
  const capped = await one(`SELECT count(*)::int AS n FROM xell WHERE project_id=$1 AND status='ready'`, [projId]);
  ok(capped?.n === 2, `fill stops at max_xells (got ${capped?.n} ready, wanted 2) — process xells are no longer invisible to the cap`);
} finally {
  if (projId) {
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM machine_pool WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  if (hostMachineCreated && hostMachineId) {
    await q(`DELETE FROM machine WHERE id=$1`, [hostMachineId]).catch(() => {});
  } else if (hostMachineId && hostMaxXellsBefore != null) {
    await q(`UPDATE machine SET max_xells=$2 WHERE id=$1`, [hostMachineId, hostMaxXellsBefore]).catch(() => {});
  }
  if (remoteMachineId) await q(`DELETE FROM machine WHERE id=$1`, [remoteMachineId]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
