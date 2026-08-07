// PROJECT MANIFEST REFRESH — name-vs-uuid (the "Manifest refresh does not work" report).
//
// Manifest refresh is POST /projects/:id/manifest/refresh, and the :id is the project UUID OR
// NAME — the manifest verbs are addressed from the same places the rest of the API is (the
// console, scripts, a human's ad-hoc curl). Refresh maps tiers.spinoff.compose →
// project.compose_spinoff (the compose file stamped onto container rows at provision) and
// caches the parsed manifest (including runner: process, which IS the pool's placement
// predicate — see test/pool-machine-placeable-without-compose.test.mjs).
//
// THE DEFECT: the route fed req.params.id straight into a `WHERE id = $1` lookup, so a caller that
// named its project got `invalid input syntax for type uuid` — the exact name-vs-uuid 400 the
// /api/router/* handlers used to ship (lib/router.js resolves through lib/project-resolve.js;
// these routes did not). That is "the REFRESH action does not work" from the operator's console.
//
// This mounts the REAL routes router and drives the REAL HTTP verb (no lib function under test,
// no mock of the route): a temp repo with a zeehive.yml, a real project row, and both spellings
// of the refresh call. It asserts:
//   1. refresh by UUID works and maps tiers.spinoff.compose → project.compose_spinoff;
//   2. refresh by NAME now works too (the fix) and returns the same composed value;
//   3. GET /manifest and POST /manifest/draft by NAME resolve the same way;
//   4. an UNKNOWN name still refuses with a helpful message, not a uuid syntax error.
// It would FAIL the moment the name path regresses to a bare uuid lookup.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { router } = await import('../server/src/api/routes.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const dir = mkdtempSync(join(tmpdir(), `zt-mr-${tag}-`));

// A zeehive.yml WITHOUT tiers.spinoff.compose — the Zeehive-shaped project the operator sees
// the pooling warning on.
const baseYml = `version: 1
project: zt-mr
tiers:
  prod:
    compose: docker-compose.yml
  spinoff:
    runner: process
    ports:
      server: { env: PORT, base: 4800, mod: 90 }
      webapp: { env: ZEEHIVE_WEB_PORT, base: 5300, mod: 90 }
roles:
  server: { service: server, buildable: false, runner: process, start: "npm run server" }
  webapp: { service: web, buildable: false, runner: process, start: "npm run web" }
  db:     { service: db, buildable: false }
`;
writeFileSync(join(dir, 'zeehive.yml'), baseYml);

const proj = await one(
  `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id, name`,
  [`zt-mr-${tag}`, dir]);
const projId = proj.id;
const projName = proj.name;

// The real routes router, mounted exactly as server/src/index.js mounts it.
const app = express();
app.use(express.json());
app.use('/api', router);
const server = app.listen(0, '127.0.0.1');
await new Promise((res) => server.once('listening', res));
const BASE = `http://127.0.0.1:${server.address().port}/api`;

const fetchJSON = async (url, opts = {}) => {
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, data };
};

try {
  console.log('\n── the operator\'s end-to-end remedy (UUID path): add tiers.spinoff.compose, refresh ──');
  // The operator edits the repo's zeehive.yml: tiers.spinoff gains a compose file.
  const fixedYml = baseYml.replace('  spinoff:\n    runner: process',
    '  spinoff:\n    compose: docker-compose.spinoff.yml\n    runner: process');
  writeFileSync(join(dir, 'zeehive.yml'), fixedYml);

  let r = await fetchJSON(`${BASE}/projects/${projId}/manifest/refresh`, { method: 'POST' });
  ok(r.status === 200 && r.data?.compose_spinoff === 'docker-compose.spinoff.yml',
     `refresh by UUID maps tiers.spinoff.compose → compose_spinoff (got ${JSON.stringify(r.data?.compose_spinoff)})`);

  const row = await one(`SELECT compose_spinoff FROM project WHERE id=$1`, [projId]);
  ok(row.compose_spinoff === 'docker-compose.spinoff.yml',
     'and the project row actually holds compose_spinoff (stamped onto containers at provision)');

  console.log('\n── the DEFECT + FIX: refresh by NAME ──');
  r = await fetchJSON(`${BASE}/projects/${projName}/manifest/refresh`, { method: 'POST' });
  ok(r.status === 200, `refresh by NAME is 200 (got ${r.status}, error: ${r.data?.error || 'none'})`);
  ok(r.data?.compose_spinoff === 'docker-compose.spinoff.yml',
     `…and returns the same composed value (got ${JSON.stringify(r.data?.compose_spinoff)})`);

  console.log('\n── GET and DRAFT resolve by NAME the same way ──');
  r = await fetchJSON(`${BASE}/projects/${projName}/manifest`);
  ok(r.status === 200 && r.data?.repo?.found === true,
     `GET /manifest by NAME resolves (status ${r.status})`);
  r = await fetchJSON(`${BASE}/projects/${projName}/manifest/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(r.status === 200 && !!r.data?.draft, `POST /manifest/draft by NAME resolves (status ${r.status})`);

  console.log('\n── an unknown project refuses with a helpful message, never a uuid syntax error ──');
  r = await fetchJSON(`${BASE}/projects/no-such-project-${tag}/manifest/refresh`, { method: 'POST' });
  ok(r.status === 400 && /no project named|known projects/.test(r.data?.error || ''),
     `unknown name → helpful refusal (got "${(r.data?.error || '').slice(0, 60)}")`);
  ok(!/invalid input syntax for type uuid/.test(r.data?.error || ''),
     '…and NOT the bare uuid syntax error that used to surface');

  console.log('\n── the UUID path still works untouched ──');
  r = await fetchJSON(`${BASE}/projects/${projId}/manifest`);
  ok(r.status === 200 && r.data?.drift === false, `GET by UUID still clean (status ${r.status}, drift ${r.data?.drift})`);
} finally {
  await new Promise((res) => server.close(res));
  await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
