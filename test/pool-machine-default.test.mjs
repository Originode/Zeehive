// POOL MACHINE-DEFAULT — machine-aware pooling is the DEFAULT when machines exist
// (docs/default-machine-pooling-decision-record.md). Two policies pinned here:
//
//   1. IMPLICIT: a project with NO machine_pool rows no longer falls back to the placeless
//      legacy path when machines exist — the project-wide target pools on the one machine that
//      can actually HOST it (compose: the machine holding its shared dev db; process: the
//      queenzee host, counted project-wide). Eligibility is the guard against "default =
//      everywhere": a machine without the project's dev db is never chosen implicitly.
//   2. EITHER KNOB ACTIVATES: a machine_pool row with pool_size>0 alone (dev_priority=0) makes
//      the machine a pool site — before this, pool_size was dead until dev_priority was also
//      set, and the knob lied. devMachines (spawn targeting) keeps requiring dev_priority>0:
//      that contract is pinned by machine-pool-per-project.test.mjs and is NOT changed here.
//
// Companions: pool-process-local-machine.test.mjs (explicit host row on a process project),
// pool-machine-guard-silence.test.mjs (remote-only config on a process project stays loud),
// pool-machine-placeable-without-compose.test.mjs (explicit compose machine path).
// Drives the real ensureReady() in simulate mode.
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';   // before any import: no machine may be touched

const { q, one, pool } = await import('../server/src/db/pool.js');
const { ensureReady } = await import('../server/src/queenzee/pool.js');
const { recentLogs } = await import('../server/src/lib/logbus.js');
const { queenzeeHostCtx } = await import('../server/src/lib/machines.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const ctxA = `zt-md-a-${tag}`, ctxB = `zt-md-b-${tag}`;
const keyA = `zt-md-a-${tag}`, keyB = `zt-md-b-${tag}`;
const hostCtx = queenzeeHostCtx();
let mA = null, mB = null, composeProj = null, procProj = null;
let hostMachineId = null, hostMachineCreated = false;

const composeManifest = {
  tiers: { spinoff: { ports: {
    server: { env: 'SPINOFF_SERVER_PORT', base: 3100, mod: 90 },
    webapp: { env: 'SPINOFF_WEB_PORT', base: 5200, mod: 90 },
  } } },
  roles: {
    server: { service: 'server', buildable: true },
    webapp: { service: 'webapp', buildable: true },
    db: { service: 'postgres', buildable: false },
  },
};
const processManifest = {
  tiers: { spinoff: { runner: 'process', ports: {
    server: { env: 'PORT', base: 4800, mod: 90 },
    webapp: { env: 'WEB_PORT', base: 5300, mod: 90 },
  } } },
  roles: {
    server: { service: 'server', runner: 'process' },
    webapp: { service: 'web', runner: 'process' },
  },
};

try {
  // Machine A holds the compose project's shared dev db; machine B does not. Neither has a
  // machine_pool row — the whole point is that nothing was configured.
  mA = (await one(`INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
                   VALUES ($1,$2,'10.3.0.1',9,true) RETURNING id`, [keyA, ctxA])).id;
  mB = (await one(`INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
                   VALUES ($1,$2,'10.3.0.2',9,true) RETURNING id`, [keyB, ctxB])).id;
  composeProj = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,NULL) RETURNING id`,
    [`zt-md-proj-${tag}`, `/tmp/zt-md-${tag}`, JSON.stringify(composeManifest)])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [composeProj]);
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,2)`, [composeProj]);
  // The project's shared dev db lives on machine A (and only A).
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx)
           VALUES ($1,'db','dev','shared',$2,$3)`, [composeProj, `db_zt_md_${tag}`, ctxA]);

  const mark = recentLogs(2000).length;
  await ensureReady();

  console.log('\n── implicit default: the project-wide target pools on the dev-db machine ──');
  const xells = await q(
    `SELECT x.id, c.docker_ctx FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
      WHERE x.project_id=$1 AND x.status='ready'`, [composeProj]);
  ok(xells.length === 2, `target_ready=2 filled with ZERO machine_pool rows (got ${xells.length}) — machine-aware is the default`);
  ok(xells.every((x) => x.docker_ctx === ctxA),
     `every server container is on '${keyA}' — the machine holding the project's shared dev db (got ${[...new Set(xells.map((x) => x.docker_ctx))].join(',')})`);
  ok(!xells.some((x) => x.docker_ctx === ctxB), `nothing landed on '${keyB}' — no dev db there, not eligible`);
  const said = recentLogs(2000).slice(mark).filter((l) => l.scope === 'pool')
    .find((l) => l.msg.includes('defaults to machine') && l.msg.includes(keyA));
  ok(!!said, `the pool SAID the default out loud (…defaults to machine '${keyA}'…)`);

  console.log('\n── the implicit fill is idempotent (machine-aware count, no runaway) ──');
  await ensureReady();
  const again = await one(`SELECT count(*)::int AS n FROM xell WHERE project_id=$1 AND status='ready'`, [composeProj]);
  ok(again?.n === 2, `still exactly 2 ready after a second tick (got ${again?.n})`);

  console.log('\n── pool_size>0 ALONE activates a machine (dev_priority stays 0) ──');
  await q(`INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority) VALUES ($1,$2,3,0)`,
    [mA, composeProj]);
  await ensureReady();
  const explicit = await q(
    `SELECT c.docker_ctx FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
      WHERE x.project_id=$1 AND x.status='ready'`, [composeProj]);
  ok(explicit.length === 3,
     `the pool_size-only row governs: 3 ready (got ${explicit.length}) — explicit config overrides the implicit default`);
  ok(explicit.every((c) => c.docker_ctx === ctxA), `…all on '${keyA}'`);

  console.log('\n── process project: the queenzee-host machine is the default, no config ──');
  const existingHost = await one(`SELECT id FROM machine WHERE docker_ctx=$1`, [hostCtx]);
  if (existingHost) hostMachineId = existingHost.id;
  else {
    hostMachineId = (await one(
      `INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,9,true) RETURNING id`,
      [`zt-md-local-${tag}`, hostCtx])).id;
    hostMachineCreated = true;
  }
  procProj = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,NULL) RETURNING id`,
    [`zt-md-proc-${tag}`, `/tmp/zt-md-proc-${tag}`, JSON.stringify(processManifest)])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [procProj]);
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,2)`, [procProj]);
  await ensureReady();
  const proc = await q(
    `SELECT c.docker_ctx FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
      WHERE x.project_id=$1 AND x.status='ready'`, [procProj]);
  ok(proc.length === 2,
     `process project filled target_ready=2 with ZERO machine_pool rows (got ${proc.length}) — the host machine is its default`);
  ok(proc.every((c) => c.docker_ctx === null), 'process modeling preserved: server containers carry docker_ctx=NULL');
  await ensureReady();
  const procAgain = await one(`SELECT count(*)::int AS n FROM xell WHERE project_id=$1 AND status='ready'`, [procProj]);
  ok(procAgain?.n === 2, `idempotent for the process project too (got ${procAgain?.n})`);
} finally {
  for (const p of [composeProj, procProj]) if (p) {
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [p]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM machine_pool WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [p]).catch(() => {});
  }
  for (const m of [mA, mB]) if (m) await q(`DELETE FROM machine WHERE id=$1`, [m]).catch(() => {});
  if (hostMachineCreated && hostMachineId) await q(`DELETE FROM machine WHERE id=$1`, [hostMachineId]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
