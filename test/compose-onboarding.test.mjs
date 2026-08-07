// COMPOSE ONBOARDING — detect docker-compose*.yml → plan → human approves → meta-DB.
//
// The operator wants compose files on disk reflected in the meta-DB project row (manifest +
// compose_* columns) without rewriting live production containers, and without a silent write:
// every file and column change is listed in a plan, and apply refuses without approved:true.
//
// This drives the REAL lib (planComposeOnboarding / applyComposeOnboarding) and the REAL HTTP
// routes against a temp repo + project row on this xell's postgres. It asserts:
//   1. plan detects compose files and proposes compose_spinoff / compose_prod meta changes;
//   2. apply WITHOUT approved:true refuses and writes nothing;
//   3. apply WITH approved:true writes zeehive.yml (when asked) and sets the meta-DB columns;
//   4. container rows are untouched (we seed a fake prod container and assert its compose_file);
//   5. a process-runner yml keeps runner:process when a prod compose is adopted (no clobber);
//   6. second plan is not applicable (idempotent).
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { planComposeOnboarding } = await import('../server/src/lib/manifest.js');
const { getComposeOnboardingPlan, applyComposeOnboarding } = await import('../server/src/lib/projects.js');
const { router } = await import('../server/src/api/routes.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const dir = mkdtempSync(join(tmpdir(), `zt-co-${tag}-`));

// OmniBiz-shaped: spinoff + prod compose at the root, no zeehive.yml yet.
writeFileSync(join(dir, 'docker-compose.spinoff.yml'), `
services:
  server: { image: app-server }
  webapp: { image: app-web }
  postgres: { image: postgres:17 }
`);
writeFileSync(join(dir, 'docker-compose.prod.yml'), `
services:
  server: { image: app-server-prod }
  webapp: { image: app-web-prod }
`);

let projId = null;
let prodContainerId = null;

const app = express();
app.use(express.json());
app.use('/api', router);
const server = app.listen(0, '127.0.0.1');
await new Promise((res) => server.once('listening', res));
const BASE = `http://127.0.0.1:${server.address().port}/api`;

const fetchJSON = async (url, opts = {}) => {
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* */ }
  return { status: r.status, data };
};

try {
  const proj = await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING *`,
    [`zt-co-${tag}`, dir]);
  projId = proj.id;

  // A live-shaped prod container with a stamped compose_file — apply must not rewrite it.
  const c = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, compose_file, health)
     VALUES ($1,'server','prod','shared',$2,'docker-compose.OLD-prod.yml','up') RETURNING id, compose_file`,
    [projId, `zt-co-prod-${tag}`]);
  prodContainerId = c.id;
  const stampedBefore = c.compose_file;

  console.log('\n── plan detects compose files and proposes meta-DB changes ──');
  const plan = await getComposeOnboardingPlan(projId);
  ok(plan.applicable === true, 'plan is applicable');
  ok(plan.compose_files?.some((f) => f.file === 'docker-compose.spinoff.yml' && f.tier_guess === 'spinoff'),
     'detects spinoff compose');
  ok(plan.compose_files?.some((f) => f.file === 'docker-compose.prod.yml' && f.tier_guess === 'prod'),
     'detects prod compose');
  ok(plan.meta_changes?.some((c) => c.column === 'compose_spinoff' && c.to === 'docker-compose.spinoff.yml'),
     'proposes compose_spinoff → docker-compose.spinoff.yml');
  ok(plan.meta_changes?.some((c) => c.column === 'compose_prod' && c.to === 'docker-compose.prod.yml'),
     'proposes compose_prod → docker-compose.prod.yml');
  ok(plan.files_to_modify?.some((f) => f.path === 'zeehive.yml' && f.action === 'create'),
     'proposes CREATE zeehive.yml');
  ok(plan.containers_untouched === true && plan.deploy_sites_untouched === true,
     'plan guarantees containers + deploy_sites untouched');
  ok((plan.warnings || []).some((w) => /production containers are NOT modified/i.test(w)),
     'plan warns that production containers are not modified');

  console.log('\n── apply without approved:true refuses and writes nothing ──');
  let refused = false;
  try {
    await applyComposeOnboarding(projId, { approved: false, write_yml: true, apply_meta: true });
  } catch (e) {
    refused = /approval required/i.test(e.message);
    ok(refused, `refuses without approval (got: ${e.message.slice(0, 80)})`);
  }
  if (!refused) ok(false, 'should have thrown without approved:true');
  ok(!existsSync(join(dir, 'zeehive.yml')), 'zeehive.yml was NOT written without approval');
  const stillEmpty = await one(`SELECT compose_spinoff, compose_prod, manifest FROM project WHERE id=$1`, [projId]);
  ok(stillEmpty.compose_spinoff == null && stillEmpty.manifest == null,
     'meta-DB columns unchanged without approval');

  console.log('\n── HTTP: GET plan + POST apply without approved → 400 ──');
  let r = await fetchJSON(`${BASE}/projects/${projId}/manifest/compose-plan`);
  ok(r.status === 200 && r.data?.applicable === true, `GET compose-plan is 200 applicable (got ${r.status})`);
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest/compose-apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved: false }),
  });
  ok(r.status === 400 && /approval required/i.test(r.data?.error || ''),
     `POST apply without approved is 400 (got ${r.status}: ${r.data?.error || ''})`);

  console.log('\n── apply WITH approved:true writes yml + meta-DB, leaves containers alone ──');
  const result = await applyComposeOnboarding(projId, { approved: true, write_yml: true, apply_meta: true });
  ok(result.ok === true, 'apply returns ok');
  ok(existsSync(join(dir, 'zeehive.yml')), 'zeehive.yml was written');
  const yml = readFileSync(join(dir, 'zeehive.yml'), 'utf8');
  ok(/compose:\s*docker-compose\.spinoff\.yml/.test(yml), 'yml declares spinoff compose');
  ok(/compose:\s*docker-compose\.prod\.yml/.test(yml), 'yml declares prod compose');

  const after = await one(
    `SELECT compose_spinoff, compose_prod, manifest IS NOT NULL AS has_m, manifest_hash FROM project WHERE id=$1`,
    [projId]);
  ok(after.compose_spinoff === 'docker-compose.spinoff.yml',
     `compose_spinoff set (got ${after.compose_spinoff})`);
  ok(after.compose_prod === 'docker-compose.prod.yml',
     `compose_prod set (got ${after.compose_prod})`);
  ok(after.has_m && !!after.manifest_hash, 'manifest cache stamped');

  const stampedAfter = await one(`SELECT compose_file FROM container WHERE id=$1`, [prodContainerId]);
  ok(stampedAfter.compose_file === stampedBefore,
     `prod container compose_file UNCHANGED ("${stampedAfter.compose_file}" === "${stampedBefore}")`);

  console.log('\n── second plan is not applicable (idempotent) ──');
  const plan2 = await getComposeOnboardingPlan(projId);
  ok(plan2.applicable === false, `second plan not applicable (reason: ${plan2.reason || '—'})`);

  console.log('\n── process-runner yml keeps runner:process when prod compose is adopted ──');
  const dir2 = mkdtempSync(join(tmpdir(), `zt-co-proc-${tag}-`));
  writeFileSync(join(dir2, 'zeehive.yml'), `version: 1
project: zt-proc
tiers:
  spinoff:
    runner: process
    ports:
      server: { env: PORT, base: 4800, mod: 90 }
      webapp: { env: ZEEHIVE_WEB_PORT, base: 5300, mod: 90 }
roles:
  server: { service: server, runner: process }
  webapp: { service: web, runner: process }
`);
  writeFileSync(join(dir2, 'docker-compose.prod.yml'), `services:\n  db: { image: postgres:17 }\n`);
  const proj2 = await one(
    `INSERT INTO project (name, repo_root, main_branch, manifest, manifest_hash)
     VALUES ($1,$2,'main',$3::jsonb,'abc') RETURNING id`,
    [`zt-co-proc-${tag}`, dir2, JSON.stringify({
      version: 1, tiers: { spinoff: { runner: 'process' } },
      roles: { server: { service: 'server', runner: 'process' } },
    })]);
  const pure = planComposeOnboarding(dir2, 'zt-proc', {
    name: 'zt-proc',
    manifest: { version: 1, tiers: { spinoff: { runner: 'process' } },
      roles: { server: { service: 'server', runner: 'process' } } },
    compose_spinoff: null, compose_prod: null,
  });
  ok(pure.applicable, 'process project with new prod compose is applicable');
  ok(pure.proposed_manifest?.tiers?.spinoff?.runner === 'process',
     'proposed manifest KEEPS runner:process on spinoff');
  ok(pure.proposed_manifest?.tiers?.prod?.compose === 'docker-compose.prod.yml',
     'proposed manifest ADDS tiers.prod.compose');
  ok(pure.yml.action === 'update', 'yml action is update (not create/overwrite-from-scratch)');
  const applied2 = await applyComposeOnboarding(proj2.id, { approved: true, write_yml: true, apply_meta: true });
  ok(applied2.ok, 'process project apply ok');
  const yml2 = readFileSync(join(dir2, 'zeehive.yml'), 'utf8');
  ok(/runner:\s*process/.test(yml2), 'written yml still has runner: process');
  ok(/docker-compose\.prod\.yml/.test(yml2), 'written yml gained prod compose');
  const row2 = await one(`SELECT compose_prod, compose_spinoff, manifest FROM project WHERE id=$1`, [proj2.id]);
  ok(row2.compose_prod === 'docker-compose.prod.yml', 'meta compose_prod set');
  ok(row2.compose_spinoff == null, 'compose_spinoff stays null for process project');
  ok(row2.manifest?.tiers?.spinoff?.runner === 'process', 'cached manifest keeps process runner');

  // cleanup proj2
  await q(`DELETE FROM project WHERE id=$1`, [proj2.id]).catch(() => {});
  try { rmSync(dir2, { recursive: true, force: true }); } catch { /* */ }

} finally {
  await new Promise((res) => server.close(res));
  if (prodContainerId) await q(`DELETE FROM container WHERE id=$1`, [prodContainerId]).catch(() => {});
  if (projId) {
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
