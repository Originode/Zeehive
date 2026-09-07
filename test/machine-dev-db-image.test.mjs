// A NEW DEV DB INHERITS THE IMAGE ITS PROD DUMPS RESTORE INTO — through provisionDevDb, simulate mode.
//
// THE DEFECT (2026-09-04, omnibiz): "duplicate prod → newly provisioned dev db" and "restore from a
// prod backup" both died with `extension "postgis" is not available`. The new dev db was standing on
// a STOCK postgres image, because provisionDevDb resolved its image from the wrong place, two ways:
//   • `const prodDb = source ? null : …` — ANY existing shared dev row (even one modeled with NO
//     image_tag) suppressed the prod lookup entirely, so the image silently fell to the hardcoded
//     fallback instead of what prod actually runs;
//   • in real mode the prod inspect ran against the row's LOGICAL name (omnibiz_db_prod), which on
//     the daemon belongs to an EXITED stock postgres:18beta1 husk — not the live versioned
//     omnibiz_db_prod_v184 (that half is registry-identity resolution + a State.Running check,
//     real-mode docker, pinned by reading; this test pins the lineage half).
//
// SECOND RECURRENCE (2026-09-07): the identity fix alone did not cure omnibiz, because all THREE
// of its dev sibling rows had already recorded the husk's stock image — and sibling-first
// precedence meant every re-provision inherited the poison no matter what prod ran. The image now
// comes from PROD FIRST (live container by identity, else the prod row's tag), and a sibling's
// tag is only the fallback when prod is unreachable/unmodeled. Sibling NAMES that are
// prefix-extensions of the prod name (the 2026-07-23 ship-to-clone shape) are not inherited
// either.
//
// This drives the REAL provisionDevDb in simulate mode and reads the container rows it inserts:
//   • a project whose ONLY image knowledge is its prod row → the new dev db wears prod's image;
//   • a tagless dev sibling + a prod row with a tag → prod's image, never the hardcoded fallback;
//   • a POISONED sibling (stock tag, prod-extension name) + a prod row → prod's image wins and
//     the new name is not a prod extension;
//   • a tagged sibling with NO prod row at all → the sibling is still a usable fallback.
//
// Requires a migrated postgres at DATABASE_URL (like machine-dev-db-provision.test.mjs).
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
const PROD_IMAGE = `zt-postgis:prod-${tag}`;   // distinct from the hardcoded fallback, on purpose
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

try {
  console.log('\n── bootstrapping from the prod row: the dev db wears PROD\'s image ──');
  const projA = await mkProject(`zt-img-a-${tag}`);
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','prod','shared',$2,$3,'prod-ctx')`,
    [projA, `zt_img_a_${tag}_db_prod`, PROD_IMAGE]);
  // machine.docker_ctx is UNIQUE — one queenzee-host machine serves all three (per-project) runs.
  const m = await mkMachine(`zt-img-${tag}`, queenzeeHostCtx());
  await provisionDevDb(projA, m);
  const rowA = await waitFor(() => one(
    `SELECT image_tag FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared'`, [projA]));
  ok(!!rowA, `the dev db container row appears (got ${rowA ? 'row' : 'NOTHING'})`);
  ok(rowA?.image_tag === PROD_IMAGE,
    `it wears prod's image (got ${rowA?.image_tag ?? 'NULL'}, want ${PROD_IMAGE})`);

  console.log('\n── a dev SIBLING with no image_tag must not silence the prod lookup ──');
  const projB = await mkProject(`zt-img-b-${tag}`);
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','prod','shared',$2,$3,'prod-ctx')`,
    [projB, `zt_img_b_${tag}_db_prod`, PROD_IMAGE]);
  // The tagless sibling: an older shared dev db modeled without an image_tag, on ANOTHER machine.
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','dev','shared',$2,NULL,$3)`,
    [projB, `zt_img_b_${tag}_db_dev`, `zt-img-elsewhere-${tag}`]);
  await provisionDevDb(projB, m);
  const rowB = await waitFor(() => one(
    `SELECT image_tag FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' AND docker_ctx=$2`,
    [projB, queenzeeHostCtx()]));
  ok(!!rowB, `the dev db container row appears (got ${rowB ? 'row' : 'NOTHING'})`);
  ok(rowB?.image_tag === PROD_IMAGE,
    `prod's image is consulted despite the tagless sibling (got ${rowB?.image_tag ?? 'NULL'}, `
    + `want ${PROD_IMAGE} — the defect hands back the hardcoded fallback here)`);

  console.log('\n── PROD beats a POISONED sibling: image from prod, name not a prod extension ──');
  // The 2026-09-07 recurrence: every omnibiz dev sibling recorded the husk's stock image AND wore
  // a prefix-extension of the prod name (omnibiz_db_prod_dev_local_mardale_prod…). Sibling-first
  // meant each re-provision re-created the fault; prod-first heals it without row surgery.
  const projC = await mkProject(`zt-img-c-${tag}`);
  const POISON_IMAGE = `zt-stock:pg18-${tag}`;
  const prodNameC = `zt_img_c_${tag}_db_prod`;
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','prod','shared',$2,$3,'prod-ctx')`,
    [projC, prodNameC, PROD_IMAGE]);
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','dev','shared',$2,$3,$4)`,
    [projC, `${prodNameC}_dev_local`, POISON_IMAGE, `zt-img-elsewhere-${tag}`]);
  await provisionDevDb(projC, m);
  const rowC = await waitFor(() => one(
    `SELECT name, image_tag FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' AND docker_ctx=$2`,
    [projC, queenzeeHostCtx()]));
  ok(!!rowC, `the dev db container row appears (got ${rowC ? 'row' : 'NOTHING'})`);
  ok(rowC?.image_tag === PROD_IMAGE,
    `prod's image beats the poisoned sibling tag (got ${rowC?.image_tag ?? 'NULL'}, want ${PROD_IMAGE})`);
  ok(!!rowC?.name && !rowC.name.startsWith(prodNameC),
    `the name is not a prefix-extension of prod's (got ${rowC?.name ?? 'NULL'})`);

  console.log('\n── with NO prod row at all, a tagged sibling is still a usable fallback ──');
  const projD = await mkProject(`zt-img-d-${tag}`);
  const SIB_IMAGE = `zt-postgis:dev-${tag}`;
  const sibNameD = `zt_img_d_${tag}_db_dev`;
  await q(`INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx)
           VALUES ($1,'db','dev','shared',$2,$3,$4)`,
    [projD, sibNameD, SIB_IMAGE, `zt-img-elsewhere-${tag}`]);
  await provisionDevDb(projD, m);
  const rowD = await waitFor(() => one(
    `SELECT name, image_tag FROM container
      WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' AND docker_ctx=$2`,
    [projD, queenzeeHostCtx()]));
  ok(!!rowD, `the dev db container row appears (got ${rowD ? 'row' : 'NOTHING'})`);
  ok(rowD?.image_tag === SIB_IMAGE,
    `the sibling's image is used when prod is unmodeled (got ${rowD?.image_tag ?? 'NULL'}, want ${SIB_IMAGE})`);
  ok(rowD?.name === `${sibNameD}_${m ? (await one(`SELECT key FROM machine WHERE id=$1`, [m])).key.replace(/-/g, '_') : ''}`,
    `a clean sibling name is still the lineage (got ${rowD?.name ?? 'NULL'})`);
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
