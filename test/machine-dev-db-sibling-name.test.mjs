// A NEW MACHINE'S SHARED DEV DB IS A CANONICAL SIBLING, NOT AN EXTENSION OF THE LAST ONE — through
// the REAL provisionDevDb, in simulate mode.
//
// THE DEFECT (2026-09-07): provisionDevDb named a new machine's shared dev db by appending the
// machine key to the PREVIOUS sibling's WHOLE name (`${source.name}_${mkey}`), so every extra machine
// grew the container name by one more segment: zeehive_db_dev_mardale_prod →
// zeehive_db_dev_mardale_prod_ugreen_nas → …_mardale_prod_ugreen_nas_local. And for a lineage that had
// once been bootstrapped from the PROD name (the pre-2026-07-23 bug), the whole polluted root was
// re-seeded every time too: omnibiz_db_prod_dev_local_mardale_prod_ugreen_nas →
// …_ugreen_nas_local → …_ugreen_nas_local_mardale_prod. Names that long are hard to read and hard to
// type, and a dev db whose name is a prefix-extension of prod is a standing tripwire for the
// name-shape resolver (xell-db.js).
//
// A sibling is <the project's OWN dev identity> + <THIS machine> — omnibiz_db_dev_<machine> —
// whatever the other machines' dbs happen to be called. `source` still hands over its IMAGE (a prod
// dump needs the custom postgis build); it never lends its NAME.
//
// This drives the REAL provisionDevDb in simulate mode and reads the container rows it inserts:
//   • three machines provisioned one after another → each wears <project>_db_dev_<its own key>,
//     never an extension of the previous machine's name;
//   • a project whose existing dev db wears a legacy prod-derived name → a new machine's db is
//     minted fresh from the project identity, not by extending that polluted root.
//
// Requires a migrated postgres at DATABASE_URL (like machine-dev-db-provision.test.mjs).
import { randomUUID } from 'node:crypto';

process.env.PROVISION_MODE = 'simulate';   // before any import: no machine may be touched

const { q, one, pool } = await import('../server/src/db/pool.js');
const { provisionDevDb } = await import('../server/src/lib/machines.js');

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
const machines = [];
const projects = [];

const mkMachine = async (key, ctx) => {
  const id = (await one(
    `INSERT INTO machine (key, docker_ctx, host_ip, max_xells, enabled)
     VALUES ($1,$2,NULL,9,true) RETURNING id`, [key, ctx])).id;
  machines.push(id);
  return id;
};
const mkProject = async (name) => {
  const id = (await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, compose_spinoff)
     VALUES ($1,$2,'main',$3::jsonb,NULL) RETURNING id`,
    [name, `/tmp/${name}`, JSON.stringify({ tiers: { spinoff: {} } })])).id;
  projects.push(id);
  return id;
};
// Provision a shared dev db on a fresh machine (key → ctx, both unique to this test) and read the
// container row it inserts. Waits for the row so the NEXT provision can see it as its sibling.
const provisionAndRead = async (projectId, key, ctx) => {
  const machineId = await mkMachine(key, ctx);
  await provisionDevDb(projectId, machineId);
  const row = await waitFor(() => one(
    `SELECT name, image_tag FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' AND docker_ctx=$2`,
    [projectId, ctx]));
  ok(!!row, `a dev db appears on machine '${key}' (got ${row ? 'row' : 'NOTHING'})`);
  return row?.name ?? null;
};

try {
  console.log('\n── three machines, one project: each db is <project>_db_dev_<its own key> ──');
  const projA = await mkProject(`sib${tag}`);   // no punctuation: the logical root is exactly <name>_db_dev
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','prod','shared',$2,$3,'prod-ctx')`,
    [projA, `sib${tag}_db_prod`, `zt-img-prod-${tag}`]);
  const logicalA = `sib${tag}_db_dev`;

  const nameA = await provisionAndRead(projA, `zt-a-${tag}`, `zt-sib-ctx-${tag}-a`);
  const nameB = await provisionAndRead(projA, `zt-b-${tag}`, `zt-sib-ctx-${tag}-b`);
  const nameC = await provisionAndRead(projA, `zt-c-${tag}`, `zt-sib-ctx-${tag}-c`);

  ok(nameA === `${logicalA}_zt_a_${tag}`, `first machine is ${logicalA}_zt_a_${tag} (got ${nameA})`);
  ok(nameB === `${logicalA}_zt_b_${tag}`,
    `second machine is ${logicalA}_zt_b_${tag}, NOT an extension of the first's name (got ${nameB})`);
  ok(nameC === `${logicalA}_zt_c_${tag}`, `third machine is ${logicalA}_zt_c_${tag} (got ${nameC})`);
  ok(!String(nameB).includes('zt_a_') && !String(nameC).includes('zt_b_') && !String(nameC).includes('zt_a_'),
    'no name carries a sibling\'s machine key — each name has exactly ONE machine on the end');

  console.log('\n── a legacy prod-derived dev root is NOT re-seeded onto a new machine ──');
  const projB = await mkProject(`leg${tag}`);
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','prod','shared',$2,$3,'prod-ctx')`,
    [projB, `leg${tag}_db_prod`, `zt-img-prod-${tag}`]);
  // The polluted lineage this whole fix exists to stop extending: a dev db whose name reads as a
  // prod-prefix (omnibiz_db_prod_dev_local_…), sitting on some other machine.
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','dev','shared',$2,$3,$4)`,
    [projB, `leg${tag}_db_prod_dev_zt_other`, `zt-img-${tag}`, `zt-leg-other-${tag}`]);
  const nameNew = await provisionAndRead(projB, `zt-new-${tag}`, `zt-leg-ctx-${tag}`);
  ok(nameNew === `leg${tag}_db_dev_zt_new_${tag}`,
    `the new machine's db is minted from the project's OWN dev identity — leg${tag}_db_dev_zt_new_${tag} (got ${nameNew})`);
  ok(!String(nameNew).includes('_prod_'), 'the new name is never a prod-prefix extension (no "_prod_" in it)');
} finally {
  for (const m of machines) await q(`DELETE FROM machine WHERE id=$1`, [m]).catch(() => {});
  for (const p of projects) {
    await q(`DELETE FROM container WHERE project_id=$1`, [p]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [p]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
