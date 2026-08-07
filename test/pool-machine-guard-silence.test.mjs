// POOL MACHINE-GUARD — process-runner projects stay on the legacy path, LOUDLY.
//
// A project with a machine_pool row (dev_priority>0, pool_size>0) whose spinoff server is
// runner:process cannot take the machine-aware path: process servers are stamped with
// docker_ctx=NULL (provision.js), so the machine-mode ready count (JOIN on
// container.role='server' AND docker_ctx) is always ZERO and the pool would provision
// pool_size more every tick — exactly the 167-xell pile-up the pool.js comment documents.
// The guard is REAL. The defect this test pins is that the skip must be LOUD (and must name
// the process-runner reason, not the old compose_spinoff red herring).
//
// Companion: test/pool-machine-placeable-without-compose.test.mjs — a compose-shaped project
// (no process runner) with NULL compose_spinoff MUST take the machine path; that was the
// "mardale-prod never gets pool xells" defect under its second diagnosis.
//
// This drives the real `ensureReady()` against this xell's postgres with a fixture machine +
// machine_pool and a process-runner manifest, and asserts a pool logline names the skipped
// machine and the process-runner reason.
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';   // before any import: no machine may be touched

const { q, one, pool } = await import('../server/src/db/pool.js');
const { ensureReady } = await import('../server/src/queenzee/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const ctx = `zt-mg-ctx-${tag}`;
const mkey = `zt-mg-${tag}`;
let machineId = null, projId = null;

// Zeehive-shaped: process runner, no compose_spinoff. The guard must fire on the runner, not
// on the missing compose column (a compose project with the same NULL column is placeable).
const processManifest = {
  tiers: { spinoff: { runner: 'process' } },
  roles: {
    server: { service: 'server', runner: 'process' },
    webapp: { service: 'web', runner: 'process' },
  },
};

try {
  machineId = (await one(
    `INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,9,true) RETURNING id`,
    [mkey, ctx])).id;
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,NULL) RETURNING id`,
    [`zt-mg-proj-${tag}`, `/tmp/zt-mg-${tag}`, JSON.stringify(processManifest)])).id;
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [projId]);
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES ($1,$2,2,5)`,
    [machineId, projId]);

  // target_ready=0 keeps fillTrim inert on the legacy path (nothing to fill, nothing to trim)
  // — the ONLY behaviour under test is the guard's log, not provisioning.
  const mark = recentLogs(2000).length;
  await ensureReady();
  const poolLines = recentLogs(2000).slice(mark).filter((l) => l.scope === 'pool').map((l) => l.msg);

  console.log('\n── the process-runner skip is loud ──');
  const warned = poolLines.find((l) => l.includes(mkey));
  ok(!!warned, `a pool logline names the skipped machine '${mkey}'`);
  ok(!!warned && /runner:process|process role|process-runner/i.test(warned),
     '…and names the process-runner reason so an operator can fix the project from the message alone');
  ok(!!warned && /machine-aware|machine placement|machine pooling/i.test(warned),
     '…and says the machine config is being skipped (machine-aware pooling disabled)');
  ok(!!warned && /^!!!/.test(warned.trim()),
     '…and starts with the house "loud" marker (!!!) so a manager\'s ops digest (ops-review ALERT_RE) surfaces it');
  ok(!!warned && !/compose_spinoff is unset/.test(warned),
     '…and does NOT blame compose_spinoff (that column is not the placement predicate)');

  console.log('\n── the legacy path still runs (fill/trim semantics preserved) ──');
  // With target_ready=0 and no ready xells, fillTrim must be a quiet no-op — the guard's legacy
  // fallback still executes, it just does not provision. If the guard were removed AND the count
  // bug bit, pool_size=2 would have provisioned 2 xells here.
  const xells = await one(`SELECT count(*)::int AS n FROM xell WHERE project_id=$1`, [projId]);
  ok(xells?.n === 0, `no xells were provisioned for the fixture (got ${xells?.n}, wanted 0)`);

  console.log('\n── rate-limited: a second tick does not spam a new line every 15s ──');
  const mark2 = recentLogs(2000).length;
  await ensureReady();
  const secondTick = recentLogs(2000).slice(mark2).filter((l) => l.scope === 'pool' && l.msg.includes(mkey)).length;
  ok(secondTick === 0, `the second tick stays silent on the SAME warning (got ${secondTick} repeat line(s), wanted 0 — the throttle, not a new message)`);
} finally {
  if (projId) {
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM machine_pool WHERE machine_id=$1`, [machineId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  if (machineId) await q(`DELETE FROM machine WHERE id=$1`, [machineId]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
