// LANGFUSE STATUS — a live instance must never read as 'provisioning' (regression for the 2026-08-04
// prod finding: langfuse_config.status sat at 'provisioning' while the instance was live and
// ingesting — GET /api/public/traces returned fresh zee-turn traces — so the console reported a
// healthy instance as still provisioning).
//
// Root cause: probeLangfuse() gated the HTTP health GET on PROVISION_MODE === 'real', so in
// simulate mode it returned 'provisioning' WITHOUT ever checking the URL. The mode gate belongs on
// the docker-compose ACTIONS (provision/teardown/heal/inject), never on a read-only health probe.
// And postTurnToLangfuse() was never mode-gated, so ingestion kept working — the two disagreed.
//
// What this file covers:
//   A. probeLangfuse() reports a genuinely-live instance as 'up' even when PROVISION_MODE=simulate,
//      and it actually ISSUES the HTTP GET (the pre-fix mode gate short-circuited before any fetch).
//   B. langfuseStatus() returns live='up' (the health signal) and RECONCILES the stale row's
//      'provisioning' to 'up' on read (the probe's verdict reaches the row).
//   C. postTurnToLangfuse() ingests into the same live instance (proves the instance is live while
//      the pre-fix probe refused to check it).
//
// The live instance is a MOCK Langfuse: globalThis.fetch is stubbed to answer the public API paths
// and record every call. This is deliberately NOT a real TCP socket — it makes the test
// deterministic in every environment, and the assertion that fetch WAS called is exactly what
// catches the pre-fix mode gate (which returned before ever calling fetch). The real-TCP
// reproduction (a genuine HTTP server on 127.0.0.1, seed the row, probe → 'up') was verified
// separately against a live mock and is documented in the work report.
//
// Runs in simulate mode (forced deterministically, independent of the invoking env). House rule 1:
// the pre-test config + project map are restored in a finally, so a shared dev db's LIVE Langfuse
// config is left exactly as it was found.
import { q, one, pool } from '../server/src/db/pool.js';

// Snapshot the config row + project map BEFORE the test, so the finally can restore exactly it.
const _beforeConfig = await one(`SELECT * FROM langfuse_config WHERE id=true`).catch(() => null);
const _beforeMap = await q(`SELECT * FROM langfuse_project_map`).catch(() => []);

// Force simulate mode deterministically so the repro is stable regardless of the invoking env —
// MODE is captured at module load, so set it BEFORE the dynamic import.
process.env.PROVISION_MODE = 'simulate';
const {
  probeLangfuse, langfuseStatus, postTurnToLangfuse,
} = await import('../server/src/lib/langfuse.js');

// A mock Langfuse reached by STUBBING globalThis.fetch (no real socket — deterministic). Records
// every call so the test can assert the probe actually issued its HTTP GET.
const _base = 'http://langfuse.test';
const _calls = [];
const _realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  _calls.push({ method: init.method || 'GET', path: u.pathname, url: String(url) });
  if (u.pathname === '/api/public/health') {
    return new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.pathname === '/api/public/traces') {
    return new Response(JSON.stringify({ data: [{ id: 'trace-1', name: 'zee turn — live', sessionId: 'sess-1', timestamp: new Date().toISOString() }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.pathname === '/api/public/otel/v1/traces') {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

try {
  // Seed the exact prod state: enabled=t, status='provisioning', an instance at base_url.
  await q(`UPDATE langfuse_config SET
      enabled=true, status='provisioning', error=null, docker_ctx='default',
      host_port=3123, minio_port=9090, compose_project='zeehive-langfuse',
      base_url=$1, client_base_url=$1, ui_url='http://localhost:3123',
      org_name='ZeeHive', public_key='pk-lf-test', secret_key='sk-lf-test',
      public_key_hint='pk-lf-…', secret_key_hint='sk-lf-…',
      admin_email='admin@zeehive.local', admin_name='ZeeHive Admin', admin_password='pw', admin_password_hint='pw…'
      WHERE id=true`, [_base]);

  console.log('\n── A. probeLangfuse reports a LIVE instance as up (not mode-gated) ──');
  const callsBefore = _calls.length;
  const live = await probeLangfuse();
  ok(live === 'up', `probeLangfuse() → 'up' for a live instance in simulate mode (got '${live}') — the health probe is a READ and must not be gated on PROVISION_MODE`);
  ok(_calls.some((c) => c.path === '/api/public/health'),
    'probeLangfuse actually ISSUED the HTTP health GET — the pre-fix mode gate returned before any fetch');

  console.log('\n── B. langfuseStatus returns live health and heals the stale row ──');
  const st = await langfuseStatus();
  ok(st.live === 'up', `langfuseStatus().live → 'up' (got '${st.live}')`);
  ok(st.status === 'up', `langfuseStatus().status → 'up' (got '${st.status}') — the stored 'provisioning' is provisioning-time, not health`);
  const row = await one(`SELECT status FROM langfuse_config WHERE id=true`);
  ok(row.status === 'up', `the stored status self-heals to 'up' on read (got '${row.status}') — the probe's verdict reaches the row`);

  console.log('\n── C. ingestion works against the same live instance ──');
  const posted = await postTurnToLangfuse({ xell: { slug: 's' }, zee: {}, model: 'claude-opus-5', result: {} });
  ok(posted.ok === true, `postTurnToLangfuse() ingests into the live instance (${JSON.stringify(posted)}) — the instance is live and ingesting while the pre-fix probe reported 'provisioning'`);
  ok(_calls.some((c) => c.path === '/api/public/otel/v1/traces'), 'the ingestion POST reached /api/public/otel/v1/traces');
} finally {
  globalThis.fetch = _realFetch;
  // House rule 1: restore the PRE-TEST config + map state (NOT force-zero) — a test running
  // against a shared dev db must leave the live Langfuse config exactly as it found it.
  try {
    await q(`DELETE FROM langfuse_project_map`);
    for (const m of _beforeMap) {
      await q(
        `INSERT INTO langfuse_project_map
           (id, project_id, langfuse_project_id, langfuse_project_name, public_key, secret_key, public_key_hint, secret_key_hint, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [m.id, m.project_id, m.langfuse_project_id, m.langfuse_project_name,
         m.public_key, m.secret_key, m.public_key_hint, m.secret_key_hint, m.created_at]);
    }
    if (_beforeConfig) {
      const keys = Object.keys(_beforeConfig);
      const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      await q(`UPDATE langfuse_config SET ${sets} WHERE id=true`, keys.map((k) => _beforeConfig[k]));
    }
  } catch (e) { console.error('cleanup failed (best-effort):', e.message); }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
