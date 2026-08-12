// MANIFEST WIZARD — knob-driven build + write (the "no manifest yet" onboarding flow).
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { router } = await import('../server/src/api/routes.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const dir = mkdtempSync(join(tmpdir(), `zt-mw-${tag}-`));
writeFileSync(join(dir, 'docker-compose.spinoff.yml'), `
services:
  server: { image: app-server }
  webapp: { image: app-web }
  postgres: { image: postgres:17 }
`);

const proj = await one(
  `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id, name`,
  [`zt-mw-${tag}`, dir]);
const projId = proj.id;
const projName = proj.name;

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
const knobs = {
  env_file: '.env',
  tiers: { dev: { compose: '' }, spinoff: { compose: 'docker-compose.spinoff.yml' }, prod: { compose: '' } },
  roles: { server: { service: 'server' }, webapp: { service: 'webapp' }, db: { service: 'postgres' } },
  ports: { server_base: 3100, webapp_base: 5200, slot_mod: 90 },
};

try {
  console.log('\n── build returns a valid preview and writes nothing ──');
  let r = await fetchJSON(`${BASE}/projects/${projId}/manifest/build`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ knobs }),
  });
  ok(r.status === 200, `build is 200 (got ${r.status})`);
  ok(/compose: docker-compose\.spinoff\.yml/.test(r.data?.yaml || ''), 'preview yml declares spinoff compose');
  ok(/service: server/.test(r.data?.yaml || ''), 'preview yml declares server role');
  ok(r.data?.suggestions?.compose?.spinoff === 'docker-compose.spinoff.yml', 'suggestions detect spinoff compose');
  ok(r.data?.suggestions?.roles?.server === 'server', 'suggestions detect server role from compose services');
  ok(!existsSync(join(dir, 'zeehive.yml')), 'build wrote NO file');

  console.log('\n── write refuses blank / invalid yaml ──');
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest/write`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: '  ' }),
  });
  ok(r.status === 400 && /required/i.test(r.data?.error || ''), `blank yaml refused (${r.status}: ${r.data?.error || ''})`);
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest/write`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ yaml: 'version: nope\nthis: [is: not: yaml' }),
  });
  ok(r.status === 400 && /invalid/i.test(r.data?.error || ''), `invalid yaml refused (${r.status}: ${r.data?.error || ''})`);
  ok(!existsSync(join(dir, 'zeehive.yml')), 'nothing written on refusal');

  console.log('\n── write creates zeehive.yml and applies to the meta-DB row ──');
  const preview = (await fetchJSON(`${BASE}/projects/${projId}/manifest/build`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ knobs }),
  })).data?.yaml;
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest/write`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: preview }),
  });
  ok(r.status === 200 && r.data?.written === true, `write is 200 written (${r.status})`);
  ok(existsSync(join(dir, 'zeehive.yml')), 'zeehive.yml created on disk');
  const written = readFileSync(join(dir, 'zeehive.yml'), 'utf8');
  ok(/compose: docker-compose\.spinoff\.yml/.test(written), 'written yml has spinoff compose');
  const row = await one(`SELECT compose_spinoff, port_server_base, port_web_base, port_slot_mod, manifest_hash, manifest IS NOT NULL AS has_m FROM project WHERE id=$1`, [projId]);
  ok(row.compose_spinoff === 'docker-compose.spinoff.yml', `compose_spinoff applied (got ${row.compose_spinoff})`);
  ok(Number(row.port_server_base) === 3100 && Number(row.port_web_base) === 5200 && Number(row.port_slot_mod) === 90,
     `port columns applied (${row.port_server_base}/${row.port_web_base}/mod ${row.port_slot_mod})`);
  ok(row.has_m && !!row.manifest_hash, 'manifest cache stamped');

  console.log('\n── build + write refuse once a valid manifest exists ──');
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest/build`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ knobs }),
  });
  ok(r.status === 400 && /already exists/i.test(r.data?.error || ''), `build refuses on existing manifest (${r.status}: ${(r.data?.error || '').slice(0, 50)})`);
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest/write`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: preview }),
  });
  ok(r.status === 400 && /already exists/i.test(r.data?.error || ''), `write refuses on existing manifest (${r.status})`);

  console.log('\n── an INVALID manifest can be replaced with overwrite:true ──');
  writeFileSync(join(dir, 'zeehive.yml'), 'version: 9\nnot: valid\n');
  // The regenerate wizard still builds a preview over an INVALID manifest (build only refuses a
  // valid one) — that is how the console recovers a broken file.
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest/build`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ knobs }),
  });
  ok(r.status === 200 && !!r.data?.yaml, `build still works over an INVALID manifest (${r.status})`);
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest/write`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: preview, overwrite: true }),
  });
  ok(r.status === 200 && r.data?.written === true, `overwrite of invalid manifest is 200 (${r.status})`);
  const replaced = readFileSync(join(dir, 'zeehive.yml'), 'utf8');
  ok(/version: 1/.test(replaced), 'invalid manifest replaced by valid one');
} finally {
  await new Promise((res) => server.close(res));
  await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
