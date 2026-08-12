// PROVISIONING A DEV DB RECORDS A URL — end to end through provisionDevDb, in simulate mode.
//
// THE DEFECT (companion to machine-dev-db-url.test.mjs, which pins the host resolution): the
// machine-matrix "＋ dev db" button on the QUEENZEE-HOST ("local") machine left the chip wearing
// "no URL recorded". The machine row carries no host_ip (it is local!), so the old
// `m.host_ip || project.dev_host_ip || config.devHostIp` came out null and the container row was
// written with conn_ref NULL even though the db was reachable at the host's own address.
//
// This drives the REAL provisionDevDb in simulate mode and reads the container rows it inserts:
//   • LOCAL machine (docker_ctx = the queenzee host), no host_ip → conn_ref IS recorded
//     (host.docker.internal / localhost), so the chip shows the URL;
//   • REMOTE machine with no host_ip → conn_ref stays NULL (fail closed — db-dsn-needs-a-host:
//     a guessed 'localhost' would point every consumer at a silent wrong database).
//
// Requires a migrated postgres at DATABASE_URL (like pool-machine-default.test.mjs).
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';   // before any import: no machine may be touched

const { q, one, pool } = await import('../server/src/db/pool.js');
const { provisionDevDb, queenzeeHostCtx } = await import('../server/src/lib/machines.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await fn();
    if (r) return r;
    await sleep(100);
  }
  return null;
};

const tag = randomUUID().slice(0, 8);
const remoteCtx = `zt-url-remote-${tag}`;
let localMachine = null, remoteMachine = null, proj = null;
try {
  localMachine = (await one(
    `INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
     VALUES ($1,$2,NULL,9,true) RETURNING id`, [`zt-url-local-${tag}`, queenzeeHostCtx()])).id;
  remoteMachine = (await one(
    `INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
     VALUES ($1,$2,NULL,9,true) RETURNING id`, [`zt-url-remote-${tag}`, remoteCtx])).id;
  proj = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,NULL) RETURNING id`,
    [`zt-url-proj-${tag}`, `/tmp/zt-url-${tag}`, JSON.stringify({ tiers: { spinoff: {} } })])).id;

  console.log('\n── a LOCAL dev db provision records a URL ──');
  await provisionDevDb(proj, localMachine);
  const localRow = await waitFor(() => one(
    `SELECT host, host_port, conn_ref FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' AND docker_ctx=$2`,
    [proj, queenzeeHostCtx()]));
  ok(!!localRow, `the local dev db container row appears (got ${localRow ? 'row' : 'NOTHING'})`);
  ok(!!localRow?.conn_ref, `its conn_ref is recorded (got ${localRow?.conn_ref ?? 'NULL'} — the defect is a NULL here)`);
  ok(!!localRow?.host && localRow.host !== 'null', `its host is a real address, not 'null' (got ${localRow?.host ?? 'NULL'})`);

  console.log('\n── a REMOTE dev db with no host still fails closed ──');
  await provisionDevDb(proj, remoteMachine);
  const remoteRow = await waitFor(() => one(
    `SELECT host, host_port, conn_ref FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' AND docker_ctx=$2`,
    [proj, remoteCtx]));
  ok(!!remoteRow, `the remote dev db container row appears (got ${remoteRow ? 'row' : 'NOTHING'})`);
  ok(remoteRow?.conn_ref === null, `its conn_ref is NULL — fail closed, no guessed 'localhost' (got ${remoteRow?.conn_ref ?? 'NULL'})`);
} finally {
  for (const m of [localMachine, remoteMachine]) if (m) await q(`DELETE FROM machine WHERE id=$1`, [m]).catch(() => {});
  if (proj) {
    await q(`DELETE FROM container WHERE project_id=$1`, [proj]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [proj]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
