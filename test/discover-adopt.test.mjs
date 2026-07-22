// DISCOVER & ADOPT test — the contract of lib/discovery.js: a running production stack on a deploy
// site can be discovered (read-only) and adopted as that site's PRODUCTION xell inventory in one
// action, generalising self-onboard.js modelOwnStack(). It runs the REAL lib against this xell's
// isolated postgres — no mocks of the logic under test.
//
// What it CANNOT do in a cxell: reach a real docker daemon (there is no docker CLI/socket here).
// So the docker-facing HALF of discovery is exercised via its ERROR path (an unreachable context
// must be a stated {ok:false,error}, never an empty list) — the same lib/docker.js HTTP path the
// health monitor already relies on. Everything that writes meta rows (adopt, the prod link, the
// createSharedContainer link, idempotency) is exercised end to end.
import { randomUUID } from 'node:crypto';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { inferRole, discoverSite, adoptContainers, prodXellForSite } =
  await import('../server/src/lib/discovery.js');
const { createSite } = await import('../server/src/lib/sites.js');
const { createSharedContainer } = await import('../server/src/lib/inventory.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
let projId, siteId;

const mkProject = async (name) => (await one(
  `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id`,
  [name, `/tmp/${name}`])).id;

try {
  console.log('\n── inferRole generalises SERVICE_ROLE (compose service · image · port · label) ──');
  ok(inferRole({ compose_service: 'db', image: 'postgres:17' }).role === 'db', 'compose service "db" ⇒ db');
  ok(inferRole({ compose_service: 'server', image: 'nginx' }).role === 'server', 'compose service "server" ⇒ server');
  ok(inferRole({ compose_service: 'web' }).role === 'webapp', 'compose service "web" ⇒ webapp');
  ok(inferRole({ image: 'postgres:17-alpine' }).role === 'db', 'unlabelled postgres image ⇒ db');
  ok(inferRole({ image: 'nginx:alpine' }).role === 'infra', 'unlabelled nginx image ⇒ infra');
  ok(inferRole({ exposed_ports: [5432] }).role === 'db', 'port 5432 ⇒ db');
  const guess = inferRole({ image: 'some/unknown:1' });
  ok(guess.role === null && /choose/i.test(guess.reason), 'truly unknown ⇒ null role + a "choose" reason (never silently applied)');
  ok(/compose service/.test(inferRole({ compose_service: 'db' }).reason), 'reason names WHY (compose service)');
  ok(inferRole({ zeehive_role: 'server', compose_service: 'db' }).role === 'server', 'zeehive.role label wins over service');

  projId = await mkProject(`zt-disc-${tag}`);
  // xource on main so createSite(tier:prod) can mint the production xell.
  await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING id`, [projId]);

  console.log('\n── createSite(tier:prod) mints the production xell; prodXellForSite finds it ──');
  const site = await createSite(projId, { key: 'local', tier: 'prod', docker_ctx: 'zt-nope-ctx', is_default: true });
  siteId = site.id;
  const px = await prodXellForSite(site);
  ok(!!px, 'prodXellForSite resolves the site\'s production xell');
  const pxRow = await one(`SELECT slug, is_production FROM xell WHERE id=$1`, [px.id]);
  ok(pxRow.slug === 'production' && pxRow.is_production, "default prod site's xell is 'production' and is_production");

  console.log('\n── discoverSite on an UNREACHABLE context: a stated error, NOT an empty list ──');
  const disc = await discoverSite(siteId);
  ok(disc.ok === false, 'ok:false for a dead/unknown context');
  ok(/unreachable/i.test(disc.error || ''), `error says "unreachable" (${(disc.error||'').slice(0,60)}…)`);
  ok(!('containers' in disc) || disc.containers === undefined, 'no empty containers[] masquerading as "nothing to adopt"');

  console.log('\n── adopt: models rows tier=prod, build_script NULL, and links each to prod xell ──');
  const selections = [
    { name: `omni_db_${tag}`, role: 'db', image_tag: 'postgres:17-alpine', internal_port: 5432 },
    { name: `omni_server_${tag}`, role: 'server', image_tag: 'nginx:alpine' },
    { name: `omni_proxy_${tag}`, role: 'infra', image_tag: 'nginx:alpine' },
  ];
  const res = await adoptContainers(siteId, selections);
  ok(res.adopted.length === 3, 'adopted 3 containers');
  ok(res.linked.length === 3, 'linked 3 to the production xell');
  const rows = await q(`SELECT * FROM container WHERE project_id=$1 ORDER BY name`, [projId]);
  ok(rows.length === 3, '3 container rows exist');
  ok(rows.every((r) => r.tier === 'prod'), 'every adopted row is tier=prod');
  ok(rows.every((r) => r.isolation === 'shared'), 'every adopted row is isolation=shared');
  ok(rows.every((r) => r.build_script === null), 'every adopted row has build_script NULL (never shippable as a side effect)');
  ok(rows.every((r) => r.site_id === siteId), 'every adopted row is on the discovered site');
  const links = await q(
    `SELECT c.name FROM xell_uses_container uc JOIN container c ON c.id=uc.container_id
      WHERE uc.xell_id=$1 AND uc.relation='owns'`, [px.id]);
  ok(links.length === 3, "3 'owns' links against the production xell (they'll show in the PRODUCTION hex)");

  console.log('\n── idempotent: re-adopting the SAME set adds nothing and never throws ──');
  const res2 = await adoptContainers(siteId, selections);
  ok(res2.adopted.length === 0, 're-adopt models 0 new rows');
  ok(res2.skipped.length === 3, 're-adopt reports 3 already-modeled/skipped');
  const rows2 = await q(`SELECT id FROM container WHERE project_id=$1`, [projId]);
  ok(rows2.length === 3, 'still exactly 3 rows — no duplicates');
  const links2 = await q(`SELECT container_id FROM xell_uses_container WHERE xell_id=$1`, [px.id]);
  ok(links2.length === 3, 'still exactly 3 links — no duplicates');

  console.log('\n── adopt refuses a container with no/invalid role (inference never silently applied) ──');
  const res3 = await adoptContainers(siteId, [{ name: `omni_myst_${tag}`, role: '' }]);
  ok(res3.adopted.length === 0 && res3.skipped.length === 1, 'blank-role selection is skipped, not modeled');
  ok(/role must be one of/i.test(res3.skipped[0].reason), 'skip reason explains the missing role');

  console.log('\n── createSharedContainer now links a tier=prod row to the production xell too ──');
  const hand = await createSharedContainer(projId, { name: `omni_hand_${tag}`, role: 'webapp', tier: 'prod', site_id: siteId });
  const handLink = await one(
    `SELECT 1 FROM xell_uses_container WHERE xell_id=$1 AND container_id=$2 AND relation='owns'`,
    [px.id, hand.id]);
  ok(!!handLink, 'a hand-typed prod container is linked to the hex (the gap the task measured, closed forward)');
  ok(hand.build_script === null, 'and it is not shippable by default (build_script NULL)');

  console.log('\n── a modeled-but-UNLINKED row gets its link on (re)adopt — fixes the omnibiz case ──');
  // Simulate a legacy hand-typed row that never linked (drop its link), then adopt it.
  await q(`DELETE FROM xell_uses_container WHERE xell_id=$1 AND container_id=$2`, [px.id, hand.id]);
  const before = await one(`SELECT count(*)::int n FROM xell_uses_container WHERE xell_id=$1`, [px.id]);
  const res4 = await adoptContainers(siteId, [{ name: `omni_hand_${tag}`, role: 'webapp' }]);
  ok(res4.adopted.length === 0, 'existing row not re-created');
  ok(res4.linked.includes(`omni_hand_${tag}`), 'its missing owns link is (re)established by adopt');
  const after = await one(`SELECT count(*)::int n FROM xell_uses_container WHERE xell_id=$1`, [px.id]);
  ok(after.n === before.n + 1, 'link count went up by exactly one');

  console.log('\n── discoverSite would mark them already_modeled/linked (checked via the DB it reads) ──');
  const modeled = await q(`SELECT name FROM container WHERE project_id=$1`, [projId]);
  ok(modeled.length === 4, 'discovery\'s "already modeled" source (container rows) sees all 4');
} finally {
  if (projId) {
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM deploy_site WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
