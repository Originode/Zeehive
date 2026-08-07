// POOL MACHINE-PLACEABLE WITHOUT compose_spinoff — the "mardale-prod never gets pool xells"
// defect under its second diagnosis.
//
// A compose-shaped project (no runner:process) stamps docker_ctx on its per-xell server
// container at provision even when project.compose_spinoff is NULL. Machine-mode ready counts
// (JOIN on role='server' + docker_ctx) therefore work, and the pool MUST take the per-machine
// path so machine_pool.pool_size / dev_priority actually govern. The old guard required
// compose_spinoff to be set; that left every per-machine knob as a dead letter on projects
// that had machines configured but had never refreshed tiers.spinoff.compose into the column
// — exactly "mardale-prod is fully configured for pooling, yet every pool xell fills on
// docker_ctx=default" (the routing request that started the loud-guard work).
//
// This drives the real ensureReady() in simulate mode against a fixture machine + a compose
// project with NULL compose_spinoff and pool_size=2, and asserts:
//   1. NO machine-aware-pooling-DISABLED warning (the project is placeable);
//   2. exactly pool_size ready xells are provisioned;
//   3. their server containers carry the machine's docker_ctx (placed on that host, not
//      whatever pickDevMachine would have chosen under the legacy path alone).
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { ensureReady } = await import('../server/src/queenzee/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const ctx = `zt-mp-ctx-${tag}`;
const mkey = `zt-mp-${tag}`;
let machineId = null, projId = null;

// OmniBiz-shaped: compose roles, NO process runner, compose_spinoff deliberately NULL.
// The compose file is a build detail; placement must not wait on the column.
const composeManifest = {
  tiers: {
    spinoff: {
      // no compose key — mirrors a project whose yml never declared tiers.spinoff.compose
      // (or whose column was never refreshed), yet still runs docker-backed spinoffs.
      ports: {
        server: { env: 'SPINOFF_SERVER_PORT', base: 3100, mod: 90 },
        webapp: { env: 'SPINOFF_WEB_PORT', base: 5200, mod: 90 },
      },
    },
  },
  roles: {
    server: { service: 'server', buildable: true },
    webapp: { service: 'webapp', buildable: true },
    db: { service: 'postgres', buildable: false },
  },
};

try {
  machineId = (await one(
    `INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
     VALUES ($1,$2,'10.2.0.16',9,true) RETURNING id`,
    [mkey, ctx])).id;
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,NULL) RETURNING id`,
    [`zt-mp-proj-${tag}`, `/tmp/zt-mp-${tag}`, JSON.stringify(composeManifest)])).id;
  // xource required by provisionXell
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projId]);
  // project-wide target 0 — if the legacy path were taken, fill would provision NOTHING.
  // Machine path uses pool_size=2 instead.
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [projId]);
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority)
           VALUES ($1,$2,2,5)`, [machineId, projId]);

  const mark = recentLogs(2000).length;
  await ensureReady();
  const poolLines = recentLogs(2000).slice(mark).filter((l) => l.scope === 'pool').map((l) => l.msg);

  console.log('\n── compose project with NULL compose_spinoff is placeable ──');
  const warned = poolLines.find((l) => /machine-aware pooling DISABLED/i.test(l) && l.includes(mkey));
  ok(!warned, `no DISABLED warning for a compose project (got: ${warned ? warned.slice(0, 120) : 'none'})`);

  const xells = await q(
    `SELECT x.id, x.slug, x.status, c.docker_ctx
       FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
      WHERE x.project_id=$1 AND x.status='ready'`, [projId]);
  ok(xells.length === 2,
     `machine path provisioned pool_size=2 ready xells (got ${xells.length}) — legacy path with target_ready=0 would have provisioned 0`);
  ok(xells.every((x) => x.docker_ctx === ctx),
     `every server container is on the machine's docker_ctx '${ctx}' (got ${[...new Set(xells.map((x) => x.docker_ctx))].join(',')})`);

  console.log('\n── a second tick does not overshoot (count is not stuck at zero) ──');
  await ensureReady();
  const after = await one(
    `SELECT count(*)::int AS n FROM xell WHERE project_id=$1 AND status='ready'`, [projId]);
  ok(after?.n === 2, `still exactly 2 ready after a second tick (got ${after?.n}) — no runaway fill`);
} finally {
  if (projId) {
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
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
