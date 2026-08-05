// SITE ↔ PRODUCTION XELL LIFECYCLE test — the contract of lib/sites.js (spec §5.2: ONE
// production xell per prod site — 'production' for the default site, 'production-<key>' for the
// rest). A site's xell must FOLLOW it: a make-default swaps the two slugs, a key-rename moves the
// xell, and deleting the site deletes its xell. That lifecycle was the hole behind the "2
// production xells are visible in both zeehive and omnibiz projects" bug — a deleted or renamed
// site left a phantom 'PRODUCTION' hexagon behind.
import { randomUUID } from 'node:crypto';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { createSite, updateSite, deleteSite, prodXellSlug } =
  await import('../server/src/lib/sites.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
let projId;

const mkProject = async (name) => (await one(
  `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id`,
  [name, `/tmp/${name}`])).id;

const prodXellRow = async (slug) => one(
  `SELECT id, slug, branch FROM xell WHERE project_id=$1 AND slug=$2 AND is_production`, [projId, slug]);

const countProdXells = async () => (await one(
  `SELECT count(*)::int AS n FROM xell WHERE project_id=$1 AND is_production`, [projId])).n;

try {
  projId = await mkProject(`zt-site-${tag}`);
  // xource on main so createSite(tier:prod) can mint the production xell.
  await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING id`, [projId]);

  console.log('\n── createSite: default prod site mints "production", another mints "production-<key>" ──');
  const defaultSite = await createSite(projId, { key: 'local', tier: 'prod', docker_ctx: 'zt-ctx', is_default: true });
  ok(prodXellSlug(defaultSite) === 'production', 'prodXellSlug(default) === "production"');
  const extraSite = await createSite(projId, { key: 'nas', tier: 'prod', docker_ctx: 'zt-ctx' });
  ok(prodXellSlug(extraSite) === 'production-nas', 'prodXellSlug(non-default) === "production-nas"');
  ok(!!(await prodXellRow('production')), 'default site has xell "production"');
  ok(!!(await prodXellRow('production-nas')), 'extra site has xell "production-nas"');
  ok((await countProdXells()) === 2, 'exactly 2 production xells after 2 prod sites');

  console.log('\n── make-default: slugs SWAP so no phantom hexagon is left behind ──');
  await updateSite(extraSite.id, { is_default: true });
  ok(prodXellSlug({ ...extraSite, is_default: true }) === 'production', 'extra site now expects "production"');
  ok(!!(await prodXellRow('production')), '"production" xell exists after the swap');
  ok(!!(await prodXellRow('production-local')), 'old default\'s xell moved to "production-local"');
  ok(!(await prodXellRow('production-nas')), 'the swapped-away "production-nas" slug is freed');
  const defaultNow = await one(`SELECT * FROM deploy_site WHERE project_id=$1 AND tier='prod' AND is_default`, [projId]);
  ok(defaultNow.id === extraSite.id, 'the extra site is the default now');
  // The two xells should be the ORIGINAL rows, just renamed — nothing minted twice.
  const prodX = await prodXellRow('production');
  const localX = await prodXellRow('production-local');
  ok(prodX.branch === 'production' && localX.branch === 'production-local', 'branch follows slug on both');
  ok(prodX.id !== localX.id, 'two distinct xell rows after the swap');
  ok((await countProdXells()) === 2, 'still exactly 2 production xells — a swap renames, never duplicates');

  console.log('\n── key-rename on a non-default site moves its xell ──');
  // defaultNow is the extra site (key "nas"), now default → xell "production".
  // Make the ORIGINAL default site key change: local → local2 (still non-default).
  const localSite = await one(`SELECT * FROM deploy_site WHERE project_id=$1 AND key='local'`, [projId]);
  await updateSite(localSite.id, { key: 'local2' });
  ok(!!(await prodXellRow('production-local2')), 'key rename moved xell to "production-local2"');
  ok(!(await prodXellRow('production-local')), 'old "production-local" is gone');
  ok((await countProdXells()) === 2, 'still exactly 2 production xells after the rename');

  console.log('\n── deleteSite removes its production xell ──');
  await deleteSite(localSite.id);
  ok(!(await prodXellRow('production-local2')), 'deleting a prod site deletes its xell');
  ok((await countProdXells()) === 1, 'exactly 1 production xell after deleting the non-default site');
  // The default site's xell survives.
  ok(!!(await prodXellRow('production')), 'default site\'s "production" xell survives');

  console.log('\n── deleting the DEFAULT prod site removes the "production" xell too ──');
  await deleteSite(defaultNow.id);
  ok((await countProdXells()) === 0, 'no production xells remain when the last prod site is deleted');
} finally {
  if (projId) {
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM deploy_site WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
