// LANGFUSE PLUGIN — ONE system-wide LLM observability instance.
//
// The feature (migration 114 + lib/langfuse.js + routes.js + the console panel):
//   • langfuse_config — a SINGLE-ROW table (id=true) holding the whole plugin's state. Disabled
//     by default; a human clicks Setup in the console to provision (mode-gated: simulate models
//     the config, real runs docker compose).
//   • lib/langfuse.js — config (masked read), provision/teardown, the LANGFUSE_* env injected
//     into every cxell, the ingestion POST that records each finished zee turn as a trace, the
//     public-API trace read, and the human reveal door.
//   • intake.js spawnCxell injects the client env; runZee accepts extraEnv; both turn-completion
//     paths post a trace (best-effort, never blocking).
//   • routes.js /api/langfuse/*; web LangfusePanel in the ProjectMenu popup.
//
// What this file covers:
//   A. the config row exists and defaults to off/enabled=false.
//   B. buildOtelTrace — the exact OTel/HTTP JSON payload (resourceSpans → scopeSpans → span)
//      POSTed to /api/public/otel/v1/traces is asserted as data, including the Langfuse OTel
//      attribute mapping (session → langfuse.session.id, model → gen_ai.request.model, …).
//   C. langfuseClientEnv — returns {} when disabled, the LANGFUSE_* trio when enabled.
//   D. provisionLangfuse in simulate — records the config (keys, ports, URLs) WITHOUT touching
//      docker, and leaves status 'provisioning' with a simulate note.
//   E. teardownLangfuse — clears the sensitive config back to off.
//   F. postTurnToLangfuse — a no-op (never throws) when disabled / no keys.
//
// House rule 1: everything created is cleaned up in a finally. This test runs against whatever
// DATABASE_URL points at — which, on a shared dev db, may be the LIVE Langfuse config. So the
// cleanup PRESERVES the pre-test config state instead of force-zeroing it: a test that finds
// Langfuse already enabled must leave it enabled, or it silently turns observability off for the
// whole fleet. (That happened twice during development — the test's finally wiped a live
// provision. The snapshot below is the fix.)
import { q, one, pool } from '../server/src/db/pool.js';

// Snapshot the config row + project map BEFORE the test, so the finally can restore exactly it.
const _beforeConfig = await one(`SELECT * FROM langfuse_config WHERE id=true`).catch(() => null);
const _beforeMap = await q(`SELECT * FROM langfuse_project_map`).catch(() => []);
import {
  langfuseConfig, langfuseClientEnv, provisionLangfuse, teardownLangfuse,
  buildOtelTrace, postTurnToLangfuse, syncLangfuseProjects, listLangfuseProjects,
  langfuseSigninPage, resolvePort, resolveOrg, reconcileLangfuseBaseUrl,
  reconcileLangfuseWriteMode, composeEnv, composeEnvFromContainer,
} from '../server/src/lib/langfuse.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── A. the single-row config ──────────────────────────────────────────────────
console.log('\n── A. config row defaults ──');
const off = await langfuseConfig();
ok(typeof off === 'object' && off !== null, 'langfuseConfig() returns an object');
// The config starts whatever the pre-test snapshot says it was — on a fresh DB that is disabled/
// off, but on a shared dev db it may already be enabled (a live provision). Assert the read is
// MASKED and stable, and that the snapshot's enable state is what the read returns.
ok(off.enabled === !!_beforeConfig?.enabled, `config enabled matches the pre-test snapshot (got ${off.enabled})`);
ok(off.public_key === undefined && !off.public_key_hint,
  'the config read is MASKED — full keys never leave the server');

// ── B. ingestion payload shape (OTel HTTP JSON — the durable Langfuse v4 door) ─
console.log('\n── B. OTel trace payload shape (what we POST to /api/public/otel/v1/traces) ──');
const otel = buildOtelTrace({
  sessionId: 'sess-1', model: 'claude-opus-5', traceId: 'trace-1',
  usage: { input: 100, output: 50 }, startTime: new Date('2026-08-03T00:00:00Z'), endTime: new Date('2026-08-03T00:00:10Z'),
  metadata: { xell_slug: 'slug-1', zee_id: 'z-1', project_id: 'proj-1', project_name: 'Acme', cost_usd: 0.02 },
});
ok(otel.resourceSpans?.length === 1 && otel.resourceSpans[0].scopeSpans?.[0]?.spans?.length === 1,
  'the body is an OTLP resourceSpans → scopeSpans → spans structure');
const span = otel.resourceSpans[0].scopeSpans[0].spans[0];
ok(typeof span.traceId === 'string' && span.traceId.length === 32, 'traceId is a 32-char hex string');
ok(typeof span.startTimeUnixNano === 'string' && typeof span.endTimeUnixNano === 'string', 'start/end are nano strings');
const attr = (k) => span.attributes?.find((a) => a.key === k)?.value;
ok(attr('xell_slug')?.stringValue === 'slug-1' && attr('zee_id')?.stringValue === 'z-1',
  'span attributes carry xell_slug + zee_id (the manager filter keys)');
ok(attr('project_id')?.stringValue === 'proj-1' && attr('project_name')?.stringValue === 'Acme',
  'span attributes carry project_id + project_name (the 1:1 project scope keys)');
ok(attr('langfuse.session.id')?.stringValue === 'sess-1' && attr('gen_ai.request.model')?.stringValue === 'claude-opus-5',
  'span carries session (langfuse.session.id — the OTel attribute Langfuse maps to its Sessions feature) + model');
ok(!attr('sessionId'), 'a plain `sessionId` attribute is NOT emitted — Langfuse only maps langfuse.session.id / session.id to a session');
ok(attr('gen_ai.usage.input_tokens')?.intValue === '100' && attr('gen_ai.usage.output_tokens')?.intValue === '50',
  'token usage lands as gen_ai.usage attributes');
ok(attr('cost_usd')?.doubleValue === 0.02, 'metadata carries cost_usd as a double');

// a no-usage trace → the span still exists but carries no usage attrs
const bare = buildOtelTrace({ sessionId: 's', startTime: new Date() });
const bareSpan = bare.resourceSpans[0].scopeSpans[0].spans[0];
ok(!bareSpan.attributes?.some((a) => a.key === 'gen_ai.usage.input_tokens'), 'no usage → no usage attributes');

// ── C. client env ─────────────────────────────────────────────────────────────
console.log('\n── C. cxell client env ──');
ok(Object.keys(await langfuseClientEnv()).length === 0, 'disabled → langfuseClientEnv() is {} (nothing injected)');

// ── D. provision (simulate) ───────────────────────────────────────────────────
console.log('\n── D. provision in simulate mode ──');
const provisioned = await provisionLangfuse({ by: 'test' });
ok(provisioned.ok === true, 'provisionLangfuse resolves ok (simulate)');
ok(provisioned.enabled === true, 'enabled after provision');
ok(provisioned.host_port === 3000, `host port 3000 (got ${provisioned.host_port})`);
ok(typeof provisioned.public_key_hint === 'string' && provisioned.public_key_hint.length >= 8,
  `public key hint present (${provisioned.public_key_hint})`);
ok(provisioned.base_url?.includes('host.docker.internal'),
  `queenzee-facing base is host.docker.internal (works from a host process AND a containerized queenzee) (${provisioned.base_url})`);
ok(provisioned.client_base_url?.includes('host.docker.internal'), `cxell-facing base is host.docker.internal (${provisioned.client_base_url})`);
ok(provisioned.ui_url?.includes('localhost'), `human-facing UI url is localhost (${provisioned.ui_url})`);
ok(provisioned.status === 'provisioning' && provisioned.error?.includes('simulate'),
  'simulate → status stays provisioning with a simulate note (nothing was actually started)');

const enabledEnv = await langfuseClientEnv();
ok(enabledEnv.LANGFUSE_PUBLIC_KEY && enabledEnv.LANGFUSE_SECRET_KEY && enabledEnv.LANGFUSE_BASE_URL,
  'enabled → langfuseClientEnv() returns the LANGFUSE_* trio');
ok(enabledEnv.LANGFUSE_BASE_URL === provisioned.client_base_url, 'LANGFUSE_BASE_URL is the cxell-facing base');

// ── F. turn post (best-effort, never throws) ─────────────────────────────────
// After D the config is ENABLED and base_url is host.docker.internal — reachable from a cxell.
// So postTurnToLangfuse should ATTEMPT a real POST and never throw (it may succeed against a
// live instance, or return a best-effort failure against none). Either way it must not throw.
console.log('\n── F. postTurnToLangfuse is best-effort (never throws) ──');
const posted = await postTurnToLangfuse({ xell: { slug: 's' }, zee: {}, model: 'claude-opus-5', result: {} });
ok(posted && typeof posted.ok === 'boolean', 'postTurnToLangfuse returns a result object, never throws');
ok(posted.ok === true || posted.ok === false, 'result is a boolean ok, even when the POST fails');

// ── G. custom port + org name (follow-ups) ───────────────────────────────────
console.log('\n── G. custom port + org name validators ──');
ok(resolvePort(3105) === 3105, 'resolvePort accepts an integer');
ok(resolvePort('') === 3000, 'resolvePort empty → default 3000');
let portThrew = false;
try { resolvePort('nope'); } catch { portThrew = true; }
ok(portThrew, 'resolvePort rejects a non-integer');
ok(resolveOrg('My Org') === 'My Org', 'resolveOrg trims a valid name');
let orgThrew = false;
try { resolveOrg('bad name!'); } catch { orgThrew = true; }
ok(orgThrew, 'resolveOrg rejects illegal characters');

console.log('\n── G2. provision with custom port + org + org keys ──');
// This section tests the NON-override path (custom port carries into the URLs), but a cxell has
// LANGFUSE_BASE_URL injected into its env, and that override would win over the custom port (that
// override is exactly what D2 asserts later). Clear it here so the custom-port assertion is about
// the port, not about which env var the box happens to carry; D2 restores-then-tests the override.
const _lfBaseUrlSaved = process.env.LANGFUSE_BASE_URL;
delete process.env.LANGFUSE_BASE_URL;
await teardownLangfuse({ by: 'test' });   // D left it enabled — start clean so provision stores the knobs
const provisioned2 = await provisionLangfuse({ by: 'test', hostPort: 3105, orgName: 'Test Org',
  orgPublicKey: 'pk-lf-testpub', orgSecretKey: 'sk-lf-testsec' });
ok(provisioned2.ok === true, 'provision resolves ok (simulate)');
ok(provisioned2.host_port === 3105, `custom port stored (got ${provisioned2.host_port})`);
ok(provisioned2.org_name === 'Test Org', `custom org stored (got ${provisioned2.org_name})`);
ok(provisioned2.base_url?.includes(':3105') && provisioned2.client_base_url?.includes(':3105'),
  'URLs carry the custom port');
ok(provisioned2.org_public_key_hint?.startsWith('pk-lf-') && provisioned2.org_secret_key_hint?.startsWith('sk-lf-'),
  'org key hints present (masked)');
if (_lfBaseUrlSaved !== undefined) process.env.LANGFUSE_BASE_URL = _lfBaseUrlSaved;

// ── J. v4 dual write mode — the events_only traces fix ────────────────────────
// Langfuse v4 defaults migration write mode to `events_only`, which DISABLES the traces API (the
// console's "recent traces" read 404s). The fix: provision in `dual` (compose default + the vars
// composeEnv passes) so the traces API stays live, and a HUMAN-triggered heal (the panel button /
// /api/langfuse/heal) flips an already-running events_only stack. The heal is deliberately NOT
// automatic at boot — the first version auto-fired compose up on the live stack with an
// INCOMPLETE interpolation env and took it down (2026-08-03), so the env reconstruction
// (composeEnvFromContainer) is the load-bearing piece and gets asserted here.
console.log('\n── J. v4 dual write mode (events_only → traces API disabled) ──');
const env = composeEnv({ publicKey: 'pk-lf-x', secretKey: 'sk-lf-x', port: 3000, org: 'ZeeHive' });
ok(env.LANGFUSE_MIGRATION_V4_WRITE_MODE === 'dual',
  `composeEnv provisions in dual write mode (got ${env.LANGFUSE_MIGRATION_V4_WRITE_MODE})`);
ok(env.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN === 'true',
  'composeEnv sets ALLOW_PREVIEW_OPT_IN (required for dual)');
const composeText = await (await import('node:fs/promises')).readFile(
  new URL('../docker/zeehive/docker-compose.langfuse.yml', import.meta.url), 'utf8');
ok(composeText.includes('LANGFUSE_MIGRATION_V4_WRITE_MODE: "${LANGFUSE_MIGRATION_V4_WRITE_MODE:-dual}"'),
  'the compose file defaults the write mode to dual (a bare `compose up` is dual too)');
ok(composeText.includes('LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN: "${LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN:-true}"'),
  'the compose file defaults ALLOW_PREVIEW_OPT_IN to true');

// The heal rebuilds the compose INTERPOLATION env from a running container's RESOLVED env — the
// load-bearing fix. A langfuse-web container's .Config.Env has the compose `environment:` block
// filled in (DATABASE_URL, SALT, …) but the compose file interpolates the LANGFUSE_* names; the
// reverse-map is what lets `compose up` reproduce the same config instead of failing on undefined
// vars (which is what took the live stack down). Simulate a container env as docker inspect returns it.
const containerEnv = {
  NEXTAUTH_URL: 'http://localhost:3000',
  NEXTAUTH_SECRET: 'next-secret',
  SALT: 'the-salt',
  ENCRYPTION_KEY: 'the-key',
  DATABASE_URL: 'postgresql://postgres:pw@postgres:5432/langfuse',
  CLICKHOUSE_URL: 'http://clickhouse:8123',
  CLICKHOUSE_MIGRATION_URL: 'clickhouse://clickhouse:9000',
  CLICKHOUSE_USER: 'clickhouse',
  CLICKHOUSE_PASSWORD: 'chpw',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
  REDIS_AUTH: 'redis-pw',
  LANGFUSE_S3_EVENT_UPLOAD_BUCKET: 'langfuse',
  LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: 'minio',
  LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: 'minio-pw',
  LANGFUSE_INIT_ORG_ID: 'zeehive',
  LANGFUSE_INIT_PROJECT_PUBLIC_KEY: 'pk-lf-init',
  LANGFUSE_INIT_PROJECT_SECRET_KEY: 'sk-lf-init',
  LANGFUSE_MIGRATION_V4_WRITE_MODE: 'events_only',
};
const rebuilt = composeEnvFromContainer(containerEnv);
ok(rebuilt.LANGFUSE_DATABASE_URL === 'postgresql://postgres:pw@postgres:5432/langfuse',
  'DATABASE_URL → LANGFUSE_DATABASE_URL (compose would otherwise see an undefined var)');
ok(rebuilt.LANGFUSE_SALT === 'the-salt' && rebuilt.LANGFUSE_ENCRYPTION_KEY === 'the-key'
  && rebuilt.LANGFUSE_NEXTAUTH_SECRET === 'next-secret',
  'SALT / ENCRYPTION_KEY / NEXTAUTH_SECRET map back to their LANGFUSE_* names');
ok(rebuilt.LANGFUSE_CLICKHOUSE_URL === 'http://clickhouse:8123' && rebuilt.LANGFUSE_REDIS_AUTH === 'redis-pw',
  'CLICKHOUSE_URL / REDIS_AUTH map back');
ok(rebuilt.LANGFUSE_MINIO_USER === 'minio' && rebuilt.LANGFUSE_MINIO_PASSWORD === 'minio-pw',
  'the S3 upload block maps back to LANGFUSE_MINIO_USER / LANGFUSE_MINIO_PASSWORD');
ok(rebuilt.LANGFUSE_PUBLIC_KEY === 'pk-lf-init' && rebuilt.LANGFUSE_SECRET_KEY === 'sk-lf-init',
  'the init block maps back to LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY');
ok(rebuilt.LANGFUSE_MIGRATION_V4_WRITE_MODE === 'events_only'
  && rebuilt.LANGFUSE_INIT_ORG_ID === 'zeehive',
  'keys already named LANGFUSE_* pass through unchanged');

// In simulate nothing is running and docker is unreachable — the heal must be a clean no-op.
const healedMode = await reconcileLangfuseWriteMode();
ok(healedMode === null, 'reconcileLangfuseWriteMode is a safe no-op in simulate (never throws)');

// ── H. 1:1 project mapping (true per-project keys) ────────────────────────────
console.log('\n── H. project mapping in simulate ──');
const proj = await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`);
const syncRes = await syncLangfuseProjects({ by: 'test' });
ok(syncRes.ok === true, 'sync resolves ok (simulate, org keys present)');
ok(syncRes.created.length >= 1, `created mappings for ${syncRes.created.length} project(s)`);
const mapped = await one(`SELECT * FROM langfuse_project_map WHERE project_id=$1`, [proj.id]);
ok(!!mapped?.public_key && !!mapped?.secret_key, 'a map row stores full per-project keys');
ok(mapped.public_key_hint && mapped.secret_key_hint, 'and masked hints');

// langfuseClientEnv(projectId) returns the PROJECT's keys
const projEnv = await langfuseClientEnv(proj.id);
ok(projEnv.LANGFUSE_PUBLIC_KEY === mapped.public_key && projEnv.LANGFUSE_SECRET_KEY === mapped.secret_key,
  'langfuseClientEnv(projectId) returns the mapped project\'s own keys');

// listLangfuseProjects read model
const listed = await listLangfuseProjects();
ok(listed.enabled === true && listed.projects?.length >= 1, 'listLangfuseProjects returns projects');
ok(listed.projects.some((p) => p.mapped && p.public_key_hint), 'the read model marks mapped projects');

// ── I. auto sign-in page ──────────────────────────────────────────────────────
console.log('\n── I. signin page (auto sign-in) ──');
const disabledSignin = await langfuseSigninPage();
ok(disabledSignin.ok === false, 'signin page refuses when the stack is not up (simulate)');

// ── E. teardown ───────────────────────────────────────────────────────────────
console.log('\n── E. teardown ──');
const torn = await teardownLangfuse({ by: 'test' });
ok(torn.ok === true, 'teardown resolves ok');
ok(torn.enabled === false && torn.status === 'off', 'back to off after teardown');
ok(torn.public_key_hint === null && torn.secret_key_hint === null, 'sensitive config cleared');
ok(Object.keys(await langfuseClientEnv()).length === 0, 'client env is {} again after teardown');

// ── D2. the queenzee-facing base_url is its OWN door, overridable ────────────
// The langfuse stack publishes on the HOST; a containerized queenzee must reach it via
// host.docker.internal (its localhost is its own loopback). LANGFUSE_BASE_URL overrides the
// auto-detected door, and ui_url stays browser-facing regardless.
console.log('\n── D2. queenzee-facing base_url door + override ──');
process.env.LANGFUSE_BASE_URL = 'http://queenzee-door.example:3000';
const p2 = await provisionLangfuse({ by: 'test' });
ok(p2.base_url === 'http://queenzee-door.example:3000', `override wins for the queenzee-facing base_url (${p2.base_url})`);
ok(p2.ui_url?.includes('localhost'), `ui_url is browser-facing, untouched by the override (${p2.ui_url})`);
ok(p2.client_base_url?.includes('host.docker.internal'), `client_base_url stays host.docker.internal (${p2.client_base_url})`);
delete process.env.LANGFUSE_BASE_URL;
await teardownLangfuse({ by: 'test' });

// ── G. reconcileLangfuseBaseUrl self-heals a pre-fix localhost row ────────────
// Rows provisioned before the container-aware base_url fix keep localhost, which a containerized
// queenzee can never reach. reconcileLangfuseBaseUrl() rewrites them to the host.docker.internal
// door at boot, so an already-provisioned deployment heals without a re-provision.
console.log('\n── G. base_url self-heal heals a pre-fix localhost row ──');
await q(`UPDATE langfuse_config SET enabled=true, status='provisioning',
            base_url='http://localhost:3000', client_base_url='http://host.docker.internal:3000',
            public_key='pk-lf-old', secret_key='sk-lf-old', public_key_hint='pk-lf-…', secret_key_hint='sk-lf-…'
          WHERE id=true`);
const healed = await reconcileLangfuseBaseUrl();
const healedRow = await langfuseConfig();
if (healed !== null) {
  ok(healed.includes('host.docker.internal'), `self-heal rewrites localhost → host.docker.internal (${healed})`);
  ok(healedRow.base_url === healed, 'the healed base_url is what the row now carries');
} else {
  // a host-process queenzee leaves a localhost row alone — that is correct for it
  ok(healedRow.base_url === 'http://localhost:3000', 'host-process queenzee leaves localhost row untouched');
}
await teardownLangfuse({ by: 'test' });

// house rule 1: restore the PRE-TEST config + map state (NOT force-zero) — a test running against
// a shared dev db must leave the live Langfuse config exactly as it found it.
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
    await q(`UPDATE langfuse_config SET ${sets} WHERE id=true`,
      keys.map((k) => _beforeConfig[k]));
  }
} catch (e) { console.error('cleanup failed (best-effort):', e.message); }
await pool.end().catch(() => {});

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
