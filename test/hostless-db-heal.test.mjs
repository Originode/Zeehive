// THE "NO URL RECORDED" HEAL — a db row that has only a port gets its address filled in.
//
// Companion to machine-dev-db-provision.test.mjs (which pins the PROVISION path writing the
// URL up front). This one pins the SELF-HEAL for rows the buggy provision already wrote:
// a shared dev db on the QUEENZEE-HOST (local) machine can exist with host_port recorded
// and host/conn_ref NULL — a db that is UP and listening whose chip says "no URL recorded".
// healHostlessDbRows fills host + conn_ref for exactly that shape, and only that shape.
//
// • LOCAL row (docker_ctx = the queenzee host) → host + conn_ref ARE filled.
// • REMOTE row with no derivable host → untouched (fail closed — no guessed localhost).
// • A row that already has a host/conn_ref → untouched (never overwrites a recorded address).
//
// Requires a migrated postgres at DATABASE_URL (like machine-dev-db-provision.test.mjs).
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { queenzeeHostCtx } = await import('../server/src/lib/machines.js');
const { healHostlessDbRows } = await import('../server/src/queenzee/containers.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const remoteCtx = `zt-heal-remote-${tag}`;
let proj = null, localRow = null, remoteRow = null, healthyRow = null;
const hostCtx = queenzeeHostCtx();
try {
  proj = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff, db_name, db_user)
     VALUES ($1,$2,'main',$3::jsonb,NULL,$4,$5) RETURNING id`,
    [`zt-heal-proj-${tag}`, `/tmp/zt-heal-${tag}`, JSON.stringify({ tiers: { spinoff: {} } }), 'omnibiz', 'postgres'])).id;
  await q(`INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,9,true)`,
    [`zt-heal-local-${tag}`, hostCtx]);
  await q(`INSERT INTO machine (key, docker_ctx, max_xells, enabled) VALUES ($1,$2,9,true)`,
    [`zt-heal-remote-${tag}`, remoteCtx]);

  const mkBroken = async (name, ctx) => (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host_port, internal_port, health)
     VALUES ($1,'db','dev','shared',$2,$3,$4,5432,'up') RETURNING id`, [proj, name, ctx, 32771])).id;
  localRow = await mkBroken(`zt_heal_local_${tag}`, hostCtx);
  remoteRow = await mkBroken(`zt_heal_remote_${tag}`, remoteCtx);
  // A row that ALREADY has an address must not be touched.
  healthyRow = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, host, host_port, conn_ref, health)
     VALUES ($1,'db','dev','shared',$2,$3,$4,$5,$6,'up') RETURNING id`,
    [proj, `zt_heal_ok_${tag}`, hostCtx, '10.9.9.9', 12345, 'postgresql://postgres@10.9.9.9:12345/omnibiz'])).id;

  console.log('\n── a local hostless dev db row gets its URL ──');
  const n = await healHostlessDbRows();
  const local = await one(`SELECT host, conn_ref FROM container WHERE id=$1`, [localRow]);
  ok(!!local?.host && !!local?.conn_ref,
     `local row healed: host=${local?.host ?? 'NULL'} conn_ref=${local?.conn_ref ?? 'NULL'} (the defect is both NULL)`);
  ok(n >= 1, `healHostlessDbRows reports it healed at least one row (got ${n})`);

  console.log('\n── a remote hostless row with no derivable host stays fail-closed ──');
  const remote = await one(`SELECT host, conn_ref FROM container WHERE id=$1`, [remoteRow]);
  ok(remote?.host === null && remote?.conn_ref === null,
     `remote row untouched: host/conn_ref stay NULL (no guessed localhost)`);

  console.log('\n── an already-addressed row is never overwritten ──');
  const healthy = await one(`SELECT host, conn_ref FROM container WHERE id=$1`, [healthyRow]);
  ok(healthy?.host === '10.9.9.9' && healthy?.conn_ref === 'postgresql://postgres@10.9.9.9:12345/omnibiz',
     'an existing address is preserved (the heal only fills missing ones)');
} finally {
  if (proj) {
    await q(`DELETE FROM container WHERE project_id=$1`, [proj]).catch(() => {});
    await q(`DELETE FROM machine WHERE key LIKE $1`, [`zt-heal-%-${tag}`]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [proj]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
