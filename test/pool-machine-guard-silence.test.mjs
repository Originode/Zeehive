// POOL MACHINE-GUARD SILENCE test — the "mardale-prod never gets pool xells" defect.
//
// A project with a machine_pool row (dev_priority>0, pool_size>0) but NO compose_spinoff is
// silently pool-by-project-wide-target: pool.js line ~117 bails to `fillTrim(projectId, target,
// null)` and the whole per-machine config (priorities, per-machine pool sizes, the max_xells cap)
// is a dead letter. The guard itself is REAL — a bare-worktree project owns no per-xell server
// containers, so the machine-mode ready count (JOIN on container.role='server' AND docker_ctx)
// is always ZERO and the pool would provision pool_size more every tick, exactly the 167-xell
// pile-up the pool.js comment documents. The DEFECT is that the skip is silent.
//
// This test would FAIL the moment the skip stops being loud: it drives the real `ensureReady()`
// against this xell's postgres with a fixture machine + machine_pool and a NULL compose_spinoff,
// and asserts a pool logline names the skipped machine and the missing prerequisite.
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

try {
  // The router's exact scenario: a machine fully configured for this project (dev_priority=5
  // highest, pool_size=2), on a project whose compose_spinoff is NULL.
  machineId = (await one(
    `INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,9,true) RETURNING id`,
    [mkey, ctx])).id;
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id`,
    [`zt-mg-proj-${tag}`, `/tmp/zt-mg-${tag}`])).id;
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [projId]);
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES ($1,$2,2,5)`,
    [machineId, projId]);

  // target_ready=0 keeps fillTrim inert (nothing to fill, nothing to trim) — the ONLY behaviour
  // under test is the guard's log, not provisioning.
  const mark = recentLogs(2000).length;
  await ensureReady();
  const poolLines = recentLogs(2000).slice(mark).filter((l) => l.scope === 'pool').map((l) => l.msg);

  console.log('\n── the silent skip is now loud ──');
  const warned = poolLines.find((l) => l.includes(mkey));
  ok(!!warned, `a pool logline names the skipped machine '${mkey}'`);
  ok(!!warned && /compose_spinoff/.test(warned),
     '…and names the missing prerequisite (compose_spinoff) so an operator can fix the project settings from the message alone');
  ok(!!warned && /machine-aware|machine placement|machine pooling/i.test(warned),
     '…and says the machine config is being skipped (machine-aware pooling disabled)');
  ok(!!warned && /^!!!/.test(warned.trim()),
     '…and starts with the house "loud" marker (!!!) so a manager\'s ops digest (ops-review ALERT_RE) surfaces it');

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
