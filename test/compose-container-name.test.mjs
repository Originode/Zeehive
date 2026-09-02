// THE COMPOSE FILE NAMES THE CONTAINER — the meta-DB's naming template only guesses.
//
// THE LIVE DEFECT (omnibiz, 2026-09-02). Its spinoff compose pins:
//
//     webapp:  container_name: omnibiz_spin_web_${SPINOFF_SLUG}
//
// while the project's naming template (manifest naming.container "omnibiz_spin_{role}_{slug}")
// made the meta-DB record `omnibiz_spin_webapp_<slug>`. omnibiz's spinoff compose sets no zeehive
// labels, so the health monitor falls back to matching by NAME (queenzee/containers.js matchState)
// — and no container by that name has ever existed. Every omnibiz webapp row read 'down' minutes
// after its own build reported success (8 of 8 on the live fleet), so app-serve:webapp could never
// pass, the readiness proof could never say 'ok', and the console's `docker exec` shell addressed a
// container that is not there. The server role only worked because its pin happened to match.
//
// So the build re-stamps the row from the compose file it is about to run, and this drives the REAL
// buildContainer (a fake build-container.sh via config.repoRoot — no docker, no compile) plus the
// pure resolver, including the cases where it must answer "I don't know" and change nothing.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { config } = await import('../server/src/config.js');
const { buildContainer } = await import('../server/src/lib/build.js');
const { composeContainerName, interpolate } = await import('../server/src/lib/compose-names.js');

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── the resolver reads the compose file, and admits when it cannot ──');
const OMNI = `services:
  server:
    image: omnibiz-spin-server:\${SPINOFF_SLUG}
    container_name: omnibiz_spin_server_\${SPINOFF_SLUG}
  webapp:
    image: omnibiz-spin-webapp:\${SPINOFF_SLUG}
    container_name: omnibiz_spin_web_\${SPINOFF_SLUG}
`;
ok(composeContainerName(OMNI, 'webapp', { SPINOFF_SLUG: 'quiet-atlas-34a97a' }) === 'omnibiz_spin_web_quiet-atlas-34a97a',
   'the omnibiz shape: the webapp is "omnibiz_spin_web_<slug>" — what docker will really create');
ok(composeContainerName(OMNI, 'server', { SPINOFF_SLUG: 'quiet-atlas-34a97a' }) === 'omnibiz_spin_server_quiet-atlas-34a97a',
   '…and the server pin, which the template happened to match all along');
ok(composeContainerName('services:\n  server:\n    container_name: zeehive_spin_server_${SPINOFF_SLUG:-dev}\n',
   'server', {}) === 'zeehive_spin_server_dev', 'a ${VAR:-default} falls back exactly as compose does');
ok(composeContainerName('services:\n  server:\n    image: x\n', 'server', { SPINOFF_SLUG: 's' }) === null,
   'NO pin → null: compose names it <project>-<service>-1 and this has no opinion');
ok(composeContainerName('services:\n  server:\n    container_name: x_${WHO_KNOWS}\n', 'server', { SPINOFF_SLUG: 's' }) === null,
   'an unresolvable variable → null, never a half-interpolated name');
ok(composeContainerName('services: [not: a: map\n', 'server', {}) === null, 'unparseable YAML → null, never a throw');
ok(composeContainerName(OMNI, 'nope', { SPINOFF_SLUG: 's' }) === null, 'a service that is not there → null');
ok(interpolate('a_${A}_${B:-b}_$C', { A: 'x', C: 'z' }) === 'a_x_b_z'
   && interpolate('${MISSING}', {}) === null,
   'interpolation covers ${VAR}, ${VAR:-def} and $VAR — and refuses what it cannot resolve');

const tag = randomUUID().slice(0, 8);
const CTX = `cname-${tag}`;
const fixture = mkdtempSync(join(tmpdir(), 'zh-cname-'));
const realRepoRoot = config.repoRoot;
let projId = null;

mkdirSync(join(fixture, 'scripts'), { recursive: true });
writeFileSync(join(fixture, 'scripts', 'build-container.sh'),
  '#!/usr/bin/env bash\nprintf \'{"ok":true,"head":"deadbee","hot":false,"method":"fake","service":"%s"}\\n\' "$2"\n');

const settle = async (id, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const r = await one(`SELECT name, health FROM container WHERE id=$1`, [id]);
    if (r.health !== 'building') return r;
    if (Date.now() - t0 > ms) throw new Error('build did not settle');
    await sleep(50);
  }
};

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, env_file, compose_spinoff, manifest,
        port_server_base, port_web_base, port_slot_mod)
     VALUES ($1,$2,'main','.env','docker-compose.spinoff.yml',$3,34500,36500,1) RETURNING id`,
    [`zt-cname-${tag}`, fixture,
     // the naming template that made the wrong name, plus the role→service map the resolver uses
     JSON.stringify({ version: 1, roles: { server: { service: 'server' }, webapp: { service: 'webapp' } },
                      naming: { container: { default: 'omnibiz_spin_{role}_{slug}' } } })])).id;
  await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main')`, [projId]);
  await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0)`, [projId]);

  const slug = `cname-${tag}`;
  const wt = join(fixture, slug);
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, 'docker-compose.spinoff.yml'), OMNI);   // the branch's own compose
  const xellId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, ready_at)
     VALUES ($1,(SELECT id FROM xource WHERE project_id=$1),$2,$3,$4,'ready',true,now()) RETURNING id`,
    [projId, slug, `spinoff/${slug}`, wt])).id;
  const ids = {};
  for (const [role, port] of [['server', 34500], ['webapp', 36500]]) {
    ids[role] = (await one(
      `INSERT INTO container (project_id,role,tier,isolation,name,image_tag,docker_ctx,host,host_port,
          internal_port,url,compose_project,compose_file,owner_xell_id,health)
       VALUES ($1,$2,'spinoff','per-xell',$3,$4,$5,'10.9.9.9',$6,$7,$8,$9,'docker-compose.spinoff.yml',$10,'down')
       RETURNING id`,
      [projId, role, `omnibiz_spin_${role}_${slug}`, `omnibiz-spin-${role}:${slug}`, CTX, port,
       role === 'server' ? 3000 : 5173, `http://10.9.9.9:${port}`, `omnibiz-spin-${slug}`, xellId])).id;
  }

  config.repoRoot = fixture;

  console.log('\n── the build re-stamps the row to the name the daemon will hold ──');
  await buildContainer(ids.webapp, {});
  const web = await settle(ids.webapp);
  ok(web.name === `omnibiz_spin_web_${slug}`,
     `the webapp row now says "${web.name}" — the compose file's pin, not the template's guess `
     + '(the health monitor can finally find it)');

  console.log('\n── a role the template already got right is left completely alone ──');
  await buildContainer(ids.server, {});
  const srv = await settle(ids.server);
  ok(srv.name === `omnibiz_spin_server_${slug}`,
     `the server row is untouched ("${srv.name}") — this corrects a mismatch, it does not rename the fleet`);

  console.log('\n── no pin in the compose → the recorded name stands ──');
  writeFileSync(join(wt, 'docker-compose.spinoff.yml'),
    'services:\n  server:\n    image: x\n  webapp:\n    image: y\n');
  await q(`UPDATE container SET name=$2 WHERE id=$1`, [ids.webapp, `omnibiz_spin_webapp_${slug}`]);
  await buildContainer(ids.webapp, {});
  const web2 = await settle(ids.webapp);
  ok(web2.name === `omnibiz_spin_webapp_${slug}`,
     `unpinned compose → "${web2.name}" is left as recorded: silence is not a new name`);
} finally {
  config.repoRoot = realRepoRoot;
  await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]).catch(() => {});
  await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM xell WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM xource WHERE project_id=$1`, [projId]).catch(() => {});
  await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
