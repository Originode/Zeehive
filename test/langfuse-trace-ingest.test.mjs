// LANGFUSE TRACE INGEST — a finished zee turn actually ARRIVES at the receiver carrying its
// session id at the TRACE level (fake OTel receiver).
//
// The regression this file exists for is TKT-83. buildOtelTrace emitted `sessionId` instead of
// `langfuse.session.id`, so every trace ingested with a NULL session and the Langfuse Sessions
// view was empty. The unit test that existed asserted the payload KEY only (it watched
// buildOtelTrace's return value, not what the POST path actually sent), so the rename slipped
// straight through. Nothing caught it because the layer in between — the real HTTP POST to the
// Langfuse OTel endpoint — was never exercised with a receiver on the other end.
//
// This file stands up a FAKE OTel receiver (node:http on 127.0.0.1, ephemeral port), points the
// post path at it by writing OUR OWN db's langfuse_config row (base_url + keys), calls
// postTurnToLangfuse with a realistic xell/zee/result, and asserts on what the receiver
// RECEIVED — the layer TKT-83 slipped through:
//   • the path is /api/public/otel/v1/traces (fail if someone points the post back at the
//     DEPRECATED /api/public/ingestion endpoint, which is events_only on Langfuse v4 and
//     silently drops trace-create);
//   • the Basic auth is built from the configured public_key:secret_key;
//   • the span attributes carry langfuse.session.id (fail if it is renamed back to `sessionId`),
//     xell_slug, zee_id, gen_ai.request.model, and the gen_ai.usage.* token counts;
//   • a receiver that 500s, a connection that is refused, and a disabled config NEVER throw out
//     of postTurnToLangfuse (best-effort is the contract — observability must not sink a zee's
//     completion);
//   • when langfuse_project_map has a row for the xell's project, the POST uses the MAPPED
//     project's keys (the 1:1 project scope from migration 117).
//
// No traffic reaches a live Langfuse instance: base_url is always the fake receiver. House
// rule 1: every row written here (config + project map) is restored in a finally, whatever
// happens, and the receiver is closed in the same finally.
//
// SHARED-DB NOTE: langfuse_config is a single shared row. setConfig writes AND reads it back,
// throwing a named error if another process clobbered it in between — the failure mode this
// test (and its sibling langfuse-plugin.test.mjs) share when two runs race on a shared dev db.
// Each section re-points the config immediately before its postTurnToLangfuse so the window is
// as small as it can be, and every assertion message carries the current base_url when the
// result is unexpected.
import http from 'node:http';
import { q, one, pool } from '../server/src/db/pool.js';

// Snapshot the config row + project map BEFORE the test, so the finally can restore exactly it
// (a test running against a shared dev db must leave the live Langfuse config as it found it).
const _beforeConfig = await one(`SELECT * FROM langfuse_config WHERE id=true`).catch(() => null);
const _beforeMap = await q(`SELECT * FROM langfuse_project_map`).catch(() => []);
import { postTurnToLangfuse } from '../server/src/lib/langfuse.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── the fake OTel receiver ─────────────────────────────────────────────────────────────────────
// node:http on 127.0.0.1:0 (ephemeral port). Records every request as it is read, then answers
// with `onRequest`'s status (default 200). `records` is appended to BEFORE the response is
// written, so by the time postTurnToLangfuse's `await fetch` resolves, the record is there.
function startReceiver(onRequest) {
  const records = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      records.push({
        method: req.method,
        path: new URL(req.url, 'http://fake-receiver').pathname,
        authorization: req.headers.authorization || null,
        body,
      });
      const status = typeof onRequest === 'function' ? onRequest(records[records.length - 1]) : 200;
      res.writeHead(status, { 'content-type': 'application/json', 'connection': 'close' });
      res.end(status >= 500 ? JSON.stringify({ error: 'fake receiver error' }) : JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, records }));
  });
}

const closeReceiver = (server) => new Promise((res) => server.close(res));

// Point our own db's langfuse_config at a base_url. WRITE + READ-BACK: if another process
// clobbered the row in between, throw a named error so the test fails with the cause visible
// instead of a confusing "fetch failed".
async function setConfig({ enabled = true, publicKey = null, secretKey = null, baseUrl }) {
  await q(`UPDATE langfuse_config SET
            enabled=$2, status=$3, base_url=$4, client_base_url=$4, ui_url=$4,
            public_key=$5, secret_key=$6,
            public_key_hint=$7, secret_key_hint=$8
          WHERE id=$1`,
    [true, enabled, enabled ? 'up' : 'off', baseUrl,
     enabled ? publicKey : null, enabled ? secretKey : null,
     enabled ? String(publicKey).slice(0, 4) + '…' : null,
     enabled ? String(secretKey).slice(0, 4) + '…' : null]);
  const check = await one(`SELECT enabled, base_url, public_key FROM langfuse_config WHERE id=true`);
  if (!enabled && check.enabled !== false) {
    throw new Error(`langfuse_config was clobbered to enabled=${check.enabled} right after my write — another process is racing on the shared config row`);
  }
  if (enabled && (check.base_url !== baseUrl || check.public_key !== publicKey)) {
    throw new Error(`langfuse_config was clobbered to ${check.base_url} (pk ${check.public_key}) right after my write — another process is racing on the shared config row`);
  }
}

// Pull a single span attribute value off the received OTLP body.
const attr = (rec, key) => rec?.body?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
  ?.attributes?.find((a) => a.key === key)?.value;

// A realistic finished-turn `result` (the shape the adapters' final `result` event carries —
// lib/cxell-runtimes.js usageFrom reads the same fields).
const realisticResult = {
  type: 'result',
  is_error: false,
  total_cost_usd: 0.02,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5,
  },
  text: 'the turn said something',
};

// A realistic xell/zee, exactly the shape the intake/nudge call sites pass.
const xell = { id: 'xell-1', slug: 'prove-a-zee-turn', project_id: null };
const zee = { id: 'zee-1', model: 'claude-opus-5', session_name: 'sess-abc' };
const SYSTEM_PK = 'pk-lf-system-trace';
const SYSTEM_SK = 'sk-lf-system-trace';

let receiver;
try {
  // ── A. happy path: the finished turn ARRIVES at the OTel endpoint ────────────────────────────
  console.log('\n── A. postTurnToLangfuse reaches the fake OTel receiver ──');
  receiver = await startReceiver();
  const base = `http://127.0.0.1:${receiver.port}`;
  await setConfig({ enabled: true, publicKey: SYSTEM_PK, secretKey: SYSTEM_SK, baseUrl: base });

  const posted = await postTurnToLangfuse({
    xell, zee, sessionId: 'sess-abc', model: 'claude-opus-5',
    result: realisticResult,
    startTime: new Date('2026-08-03T00:00:00Z'),
    endTime: new Date('2026-08-03T00:00:10Z'),
  });
  ok(posted.ok === true, `postTurnToLangfuse resolves ok against the fake receiver (got ${JSON.stringify(posted)})`);

  ok(receiver.records.length === 1, `the receiver got exactly one request (got ${receiver.records.length})`);
  const rec = receiver.records[0];
  ok(rec.method === 'POST', `the receiver got a POST (got ${rec.method})`);
  ok(rec.path === '/api/public/otel/v1/traces',
    `the POST lands on the OTel v1 traces endpoint, NOT the deprecated /api/public/ingestion (got ${rec.path})`);
  const expectAuth = `Basic ${Buffer.from(`${SYSTEM_PK}:${SYSTEM_SK}`).toString('base64')}`;
  ok(rec.authorization === expectAuth,
    `Basic auth is built from the configured public:secret keys (got ${rec.authorization})`);

  // the session must be on the TRACE/span at langfuse.session.id — the one mapping Langfuse's
  // Sessions feature reads. This is the exact assertion TKT-83 would have failed.
  const sessionAttr = attr(rec, 'langfuse.session.id');
  ok(sessionAttr?.stringValue === 'sess-abc',
    `span carries langfuse.session.id = 'sess-abc' at the TRACE level (got ${JSON.stringify(sessionAttr)})`);
  ok(!attr(rec, 'sessionId'),
    'a plain `sessionId` attribute is NOT emitted — renaming langfuse.session.id back to sessionId is the TKT-83 regression');

  ok(attr(rec, 'xell_slug')?.stringValue === 'prove-a-zee-turn'
    && attr(rec, 'zee_id')?.stringValue === 'zee-1',
    'span carries xell_slug + zee_id (the xell/zee identity)');
  ok(attr(rec, 'gen_ai.request.model')?.stringValue === 'claude-opus-5',
    'span carries gen_ai.request.model');
  ok(attr(rec, 'gen_ai.usage.input_tokens')?.intValue === '110'
    && attr(rec, 'gen_ai.usage.output_tokens')?.intValue === '55',
    `token usage lands (input 100+10 cacheRead=110, output 50+5 cacheWrite=55; got ${attr(rec, 'gen_ai.usage.input_tokens')?.intValue}/${attr(rec, 'gen_ai.usage.output_tokens')?.intValue})`);
  ok(attr(rec, 'cost_usd')?.doubleValue === 0.02, 'cost_usd rides along as a double');

  // ── B. a project with NO mapping falls back to the system trace keys ────────────────────────
  console.log('\n── B. per-project key mapping ──');
  const proj = await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`);
  await setConfig({ enabled: true, publicKey: SYSTEM_PK, secretKey: SYSTEM_SK, baseUrl: base });
  receiver.records.length = 0;
  const noMapPosted = await postTurnToLangfuse({
    xell: { id: 'xell-1', slug: 'prove-a-zee-turn', project_id: proj.id },
    zee, sessionId: 'sess-abc', model: 'claude-opus-5', result: realisticResult,
  });
  ok(noMapPosted.ok === true, `post resolves ok for a project with no mapping (got ${JSON.stringify(noMapPosted)})`);
  ok(receiver.records.length === 1 && receiver.records[0].authorization === expectAuth,
    'no map row → the system trace project\'s keys are used (fallback)');

  // ── C. the MAPPED project's keys are used when a map row exists ──────────────────────────────
  const MAPPED_PK = 'pk-lf-mapped-project';
  const MAPPED_SK = 'sk-lf-mapped-project';
  const mapRow = await q(
    `INSERT INTO langfuse_project_map
       (project_id, langfuse_project_id, langfuse_project_name, public_key, secret_key, public_key_hint, secret_key_hint)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [proj.id, 'lf-proj-mapped', 'Mapped Project', MAPPED_PK, MAPPED_SK, 'pk-lf-…', 'sk-lf-…']);
  await setConfig({ enabled: true, publicKey: SYSTEM_PK, secretKey: SYSTEM_SK, baseUrl: base });
  receiver.records.length = 0;
  const mappedPosted = await postTurnToLangfuse({
    xell: { id: 'xell-1', slug: 'prove-a-zee-turn', project_id: proj.id },
    zee, sessionId: 'sess-abc', model: 'claude-opus-5', result: realisticResult,
  });
  ok(mappedPosted.ok === true, `post resolves ok for a mapped project (got ${JSON.stringify(mappedPosted)})`);
  ok(receiver.records.length === 1, `a mapped project still posts exactly one trace (got ${receiver.records.length})`);
  const mappedAuth = `Basic ${Buffer.from(`${MAPPED_PK}:${MAPPED_SK}`).toString('base64')}`;
  ok(receiver.records[0].authorization === mappedAuth,
    `the POST uses the MAPPED project's keys, not the system keys (got ${receiver.records[0].authorization})`);
  ok(attr(receiver.records[0], 'langfuse.session.id')?.stringValue === 'sess-abc',
    'the mapped project\'s trace still carries the session id at langfuse.session.id');
  await q(`DELETE FROM langfuse_project_map WHERE id=$1`, [mapRow[0].id]);

  // ── D. best-effort: a receiver that 500s never throws ───────────────────────────────────────
  console.log('\n── D. postTurnToLangfuse is best-effort (never throws) ──');
  const failReceiver = await startReceiver(() => 500);
  await setConfig({ enabled: true, publicKey: SYSTEM_PK, secretKey: SYSTEM_SK,
    baseUrl: `http://127.0.0.1:${failReceiver.port}` });
  let dThrew = false, dRes;
  try {
    dRes = await postTurnToLangfuse({ xell, zee, sessionId: 's', result: {} });
  } catch (e) { dThrew = true; }
  ok(!dThrew, 'a receiver that 500s does NOT throw out of postTurnToLangfuse');
  ok(dRes?.ok === false && dRes?.status === 500,
    `a 500 is reported as { ok:false, status:500 } (got ${JSON.stringify(dRes)})`);
  await closeReceiver(failReceiver.server);

  // ── E. a connection that is refused never throws ────────────────────────────────────────────
  const deadReceiver = await startReceiver();
  const deadPort = deadReceiver.port;
  await setConfig({ enabled: true, publicKey: SYSTEM_PK, secretKey: SYSTEM_SK,
    baseUrl: `http://127.0.0.1:${deadPort}` });
  await closeReceiver(deadReceiver.server);   // port now refuses connections
  let eThrew = false, eRes;
  try {
    eRes = await postTurnToLangfuse({ xell, zee, sessionId: 's', result: {} });
  } catch (err) { eThrew = true; }
  ok(!eThrew, 'a refused connection does NOT throw out of postTurnToLangfuse');
  ok(eRes?.ok === false && typeof eRes?.error === 'string',
    `a refused connection is reported as { ok:false, error } (got ${JSON.stringify(eRes)})`);

  // ── F. disabled config → no-op, nothing reaches the receiver ────────────────────────────────
  receiver.records.length = 0;
  await setConfig({ enabled: false, baseUrl: base });
  const offPosted = await postTurnToLangfuse({ xell, zee, sessionId: 's', result: {} });
  ok(offPosted?.ok === false && offPosted?.skipped === 'disabled',
    `disabled config → { ok:false, skipped:'disabled' } (got ${JSON.stringify(offPosted)})`);
  ok(receiver.records.length === 0, 'disabled → NO request reaches the receiver');
} finally {
  // House rule 1: restore the PRE-TEST config + map state (NOT force-zero) — a test running
  // against a shared dev db must leave the live Langfuse config exactly as it found it.
  if (receiver) await closeReceiver(receiver.server).catch(() => {});
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
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
