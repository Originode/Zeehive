// PROJECT ROUTES — name-vs-uuid sweep (card 8a9baf6d).
//
// The /projects/:id/{sites,pool-config,containers,readiness,docs,tokens,environments}
// families fed req.params.id straight into a `WHERE project_id = $1` lookup, so a caller
// addressing the project by NAME got `invalid input syntax for type uuid` — the same
// name-vs-uuid 400 the /api/router/* handlers used to ship (lib/router.js) and the
// manifest routes used to ship (test/project-manifest-refresh-name.test.mjs). This is the
// sweep that resolves :id through resolveProjectId (lib/project-resolve.js) at the top of
// each handler.
//
// This mounts the REAL routes router and drives the REAL HTTP verbs BY NAME — one
// parameterized case per route, so the next route added is one line to cover. It asserts:
//   1. every route resolves a project NAME (200, never a uuid syntax error);
//   2. an UNKNOWN project name gives a clean 404 naming the project (not 400, not 500);
//   3. the UUID path still works (one GET by uuid).
// It would FAIL the moment any route regresses to a bare uuid lookup.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { router } = await import('../server/src/api/routes.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const dir = mkdtempSync(join(tmpdir(), `zt-nvu-${tag}-`));

// Provider tokens pass the lib/provider-tokens.js shape checks (kimi / openai / deepseek each
// accept a 20+ char key). Distinct providers per token-creating case so none trips the
// provider_token (project_id, provider) unique constraint.
const KIMI_TOKEN = 'kimi-test-token-1234567890';
const OPENAI_TOKEN = 'sk-openai-test-token-1234567890';
const DEEPSEEK_TOKEN = 'sk-deepseektest1234567890';

const proj = await one(
  `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id, name`,
  [`zt-nvu-${tag}`, dir]);
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
const reqOpts = (c) => c.body
  ? { method: c.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.body) }
  : { method: c.method };
// Add a provider account and hand back its row id (the /tokens/account/:accountId routes need
// one; the POST above returns the provider object with an accounts array).
const addToken = async (provider, token) => {
  const r = await fetchJSON(`${BASE}/projects/${projId}/tokens`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, token }) });
  if (r.status !== 200) throw new Error(`setup: add ${provider} token failed: ${r.data?.error || r.status}`);
  const id = r.data?.accounts?.[0]?.id;
  if (!id) throw new Error(`setup: no account id in ${provider} token response: ${JSON.stringify(r.data)}`);
  return id;
};

// One descriptor per route. `setup` creates any prerequisite rows and returns what the path
// needs; `body` is sent for write routes.
const CASES = [
  { label: 'sites GET',          method: 'GET',    path: (id) => `/projects/${id}/sites` },
  { label: 'sites POST',         method: 'POST',   path: (id) => `/projects/${id}/sites`, body: { key: `site-${tag}`, tier: 'dev' } },
  { label: 'docs GET',           method: 'GET',    path: (id) => `/projects/${id}/docs` },
  { label: 'docs POST',          method: 'POST',   path: (id) => `/projects/${id}/docs`, body: { title: `doc-${tag}`, body: 'hello' } },
  { label: 'tokens GET',         method: 'GET',    path: (id) => `/projects/${id}/tokens` },
  { label: 'tokens POST',        method: 'POST',   path: (id) => `/projects/${id}/tokens`, body: { provider: 'kimi', token: KIMI_TOKEN } },
  { label: 'tokens account DELETE', method: 'DELETE', path: (id, c) => `/projects/${id}/tokens/account/${c.accountId}`,
    setup: () => addToken('openai', OPENAI_TOKEN).then((accountId) => ({ accountId })) },
  { label: 'tokens account pause',  method: 'POST',   path: (id, c) => `/projects/${id}/tokens/account/${c.accountId}/pause`,
    body: { by: 'test@console' },
    setup: () => addToken('deepseek', DEEPSEEK_TOKEN).then((accountId) => ({ accountId })) },
  { label: 'environments GET',  method: 'GET',    path: (id) => `/projects/${id}/environments` },
  { label: 'environments POST', method: 'POST',   path: (id) => `/projects/${id}/environments`, body: { key: `env-${tag}`, tier: 'dev' } },
  { label: 'readiness GET',     method: 'GET',    path: (id) => `/projects/${id}/readiness` },
  { label: 'pool-config GET',   method: 'GET',    path: (id) => `/projects/${id}/pool-config` },
  { label: 'pool-config PATCH', method: 'PATCH',  path: (id) => `/projects/${id}/pool-config`, body: { target_ready: 1 },
    setup: async () => { await q(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1, 0)`, [projId]); } },
  { label: 'containers GET',    method: 'GET',    path: (id) => `/projects/${id}/containers` },
  { label: 'containers POST',   method: 'POST',   path: (id) => `/projects/${id}/containers`, body: { name: `ctr-${tag}`, role: 'db', tier: 'dev' } },
];

try {
  console.log('\n── each route resolves a project NAME and 404s an unknown one ──');
  for (const c of CASES) {
    const ctx = c.setup ? await c.setup() : {};

    const r = await fetchJSON(`${BASE}${c.path(projName, ctx)}`, reqOpts(c));
    ok(r.status === 200, `${c.label} by NAME is 200 (got ${r.status}, error: ${r.data?.error || 'none'})`);
    ok(!/invalid input syntax for type uuid/.test(r.data?.error || ''),
       '  …and NOT the uuid syntax error');

    const n = await fetchJSON(`${BASE}${c.path(`no-such-project-${tag}`, ctx)}`, reqOpts(c));
    ok(n.status === 404, `${c.label} unknown name → 404 (got ${n.status})`);
    ok(/no project named|known projects/.test(n.data?.error || ''),
       `  …helpful message naming the project ("${(n.data?.error || '').slice(0, 60)}")`);
  }

  console.log('\n── the UUID path still works untouched ──');
  const r = await fetchJSON(`${BASE}/projects/${projId}/sites`);
  ok(r.status === 200, `GET /sites by UUID still resolves (status ${r.status})`);
} finally {
  await new Promise((res) => server.close(res));
  await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
