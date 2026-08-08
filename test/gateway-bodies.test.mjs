// GATEWAY BODY CAPTURE — request/response bodies for the observability drill-down
// (server/src/lib/gateway-bodies.js, migration 162).
//
// llm_gateway_request (154) is the hot ledger — no bodies, by design. This module owns the
// COLD half: the request delta + reassembled response text, capped ~32KB with a truncated
// flag, scrubbed of secrets, 14-day retention swept by the maintenance loop, per-project
// on/off switch defaulting ON, stored on a SEPARATE table keyed by the request row.
//
// What this file covers (all against DATABASE_URL, torn down in a finally — house rule 1):
//   A. requestDelta — the delta message is the LAST message (not the conversation prefix),
//      for messages / chat-completions / grok input shapes.
//   B. scrubJsonValue + scrubBodyText — a planted credential is scrubbed by its exact value
//      AND its token shape, and a sensitive JSON key is redacted wholesale.
//   C. capBody — text at/under the cap passes through; over the cap truncates with the flag,
//      and a UTF-8 char at the boundary is never split.
//   D. captureRequestText — the delta → scrubbed → capped JSON text.
//   E. gatewayBodyCaptureEnabled — default ON (no row), OFF after set, ON again.
//   F. persistBodies + bodiesForRequest — the round-trip, and bodiesForRequest returns null
//      for an unknown request.
//   G. sweepGatewayBodies — rows older than the window are deleted, newer rows survive.
//   H. switch OFF stores nothing — with gateway_body_capture=false, persistBodies is NOT the
//      gate (the gateway checks the switch before calling capture), so this asserts the
//      switch read + the capture-on/off contract the gateway depends on.
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { BODY_CAP, requestDelta, scrubJsonValue, scrubBodyText, capBody, captureRequestText,
         gatewayBodyCaptureEnabled, secretValuesForProject, persistBodies, bodiesForRequest,
         sweepGatewayBodies } from '../server/src/lib/gateway-bodies.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── A. requestDelta ─────────────────────────────────────────────────────────────────────
console.log('\n── A. requestDelta — the LAST message, not the conversation prefix ──');
const delta = requestDelta({ model: 'm', messages: [
  { role: 'user', content: 'old turn 1' },
  { role: 'assistant', content: 'old answer 1' },
  { role: 'user', content: 'the NEW ask' },
] });
eq(delta?.role, 'user', 'the delta is the last message');
eq(delta?.content, 'the NEW ask', 'the delta content is the new content, not the prefix');
eq(requestDelta({ model: 'm', messages: [{ role: 'user', content: 'only' }] })?.content, 'only', 'single message → that message');
eq(requestDelta({ model: 'm', messages: [] }), null, 'empty messages → null');
eq(requestDelta({ model: 'm', input: 'bare grok prompt' }), 'bare grok prompt', 'grok bare string input → the input');
eq(requestDelta({ model: 'm', input: ['a', { role: 'user', content: 'hi' }] })?.content, 'hi', 'grok array input → last item');
eq(requestDelta({ model: 'm' }), null, 'no conversation shape → null');
eq(requestDelta(null), null, 'null body → null');

// ── B. scrubJsonValue + scrubBodyText — the planted credential ─────────────────────────
console.log('\n── B. scrubbing — planted credential + sensitive keys ──');
// The exact provider-token VALUE a cage holds (e.g. a DeepSeek key on the project) must be
// gone from a body that echoes it. `planted` is deliberately NOT a known token shape, so the
// EXACT-VALUE scrub (not the shape scrub) is what has to catch it — that is the half that
// would let a rotated or bespoke credential through.
const planted = 'PLANTED-credential-value-xyz987';
const bodyText = `the result echoed ${planted} and the api key was ${planted}`;
const scrubbed = scrubBodyText(bodyText, { secretValues: [planted] });
ok(!scrubbed.includes(planted), 'the exact planted credential value is gone');
ok(scrubbed.includes('[REDACTED]'), 'the planted credential became [REDACTED]');
// A token SHAPE is scrubbed even when it is NOT a known value (a rotated key is no longer in
// provider_token but still matches the shape).
ok(!scrubBodyText('using sk-othersecret123456 now').includes('sk-othersecret123456'), 'any sk-… shape is scrubbed, not just known values');
ok(!scrubBodyText('xai-newkey1234567890').includes('xai-newkey1234567890'), 'xai-… shape is scrubbed (the grok signature)');
// Sensitive JSON keys are redacted wholesale, nested included.
const jsonVal = scrubJsonValue({
  role: 'user',
  content: `echo ${planted}`,
  api_key: 'sk-super-secret',
  tool_use: { input: { authorization: 'Bearer sk-bearer-secret', ok: true, token: 'abc' } },
}, { secretValues: [planted] });
eq(jsonVal.api_key, '[REDACTED]', 'api_key value redacted wholesale');
eq(jsonVal.tool_use.input.authorization, '[REDACTED]', 'nested authorization redacted');
eq(jsonVal.tool_use.input.token, '[REDACTED]', 'nested token redacted');
eq(jsonVal.tool_use.input.ok, true, 'non-sensitive siblings survive');
ok(!JSON.stringify(jsonVal).includes(planted), 'planted credential gone from the serialized value');
// Array values scrub too.
const arrVal = scrubJsonValue(['keep', planted, { password: 'hunter2' }], { secretValues: [planted] });
eq(arrVal[0], 'keep', 'non-secret array items survive');
eq(arrVal[2].password, '[REDACTED]', 'sensitive key inside an array item redacted');

// ── C. capBody ──────────────────────────────────────────────────────────────────────────
console.log('\n── C. capBody — capped with an explicit truncated flag ──');
const small = capBody('short');
eq(small.text, 'short', 'under the cap passes through untouched');
eq(small.truncated, false, 'under the cap is NOT truncated');
const big = capBody('x'.repeat(BODY_CAP + 10));
eq(big.text.length, BODY_CAP, 'over the cap is cut to the cap');
eq(big.truncated, true, 'over the cap sets the truncated flag');
eq(capBody(null).text, '', 'null text → empty, not a crash');
// A UTF-8 boundary char is dropped whole, never halved into a replacement char.
const snow = '❄'.repeat(BODY_CAP - 1) + '❄';  // exactly over by one char (2 bytes per snowman)
const utf = capBody(snow);
ok(utf.truncated, 'a multi-byte char at the boundary sets truncated');
ok(!utf.text.includes('�'), 'the cut never leaves a replacement char (a UTF-8 char is not split)');
ok(Buffer.byteLength(utf.text) <= BODY_CAP, 'the capped text is within the byte cap');

// ── D. captureRequestText ───────────────────────────────────────────────────────────────
console.log('\n── D. captureRequestText — delta → scrubbed → capped JSON ──');
const cap = captureRequestText({ model: 'm', messages: [{ role: 'user', content: `hi ${planted}` }] }, { secretValues: [planted] });
ok(!!cap, 'captureRequestText returns a cap result');
ok(cap.text.includes('"content":"hi [REDACTED]"'), 'the delta text is scrubbed in the JSON');
ok(!cap.text.includes(planted), 'the planted credential is not in the captured JSON');
ok(!cap.text.includes('old'), 'the conversation prefix is NOT captured (only the delta)');
eq(captureRequestText({ model: 'm' }), null, 'no delta → null');

// ── the DB-backed half ──────────────────────────────────────────────────────────────────
let projectId = null, xourceId = null, xellId = null, rid = null;
try {
  const name = 'gwb-' + randomUUID().slice(0, 8);
  const proj = await one(`INSERT INTO project (name, repo_root) VALUES ($1, $2) RETURNING id`, [name, `/tmp/${name}`]);
  projectId = proj.id;
  const xo = await one(`INSERT INTO xource (project_id, ref) VALUES ($1, 'refs/heads/main') RETURNING id`, [projectId]);
  xourceId = xo.id;
  const xl = await one(`INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status)
    VALUES ($1, $2, $3, $4, $5, 'claimed') RETURNING id`,
    [projectId, xourceId, name, `spinoff/${name}`, `/tmp/${name}-wt`]);
  xellId = xl.id;

  // A planted credential on the project — the "known credential env value" the scrubber must
  // catch by its exact string.
  await one(`INSERT INTO provider_token (project_id, provider, token, token_hint)
    VALUES ($1, 'deepseek', $2, $3)`, [projectId, planted, `sk-…`]);
  const secrets = await secretValuesForProject(projectId);
  ok(secrets.includes(planted), 'secretValuesForProject returns the planted credential');

  // ── E. the switch ─────────────────────────────────────────────────────────────────────
  console.log('\n── E. gatewayBodyCaptureEnabled — per-project switch, default ON ──');
  eq(await gatewayBodyCaptureEnabled(projectId), true, 'default ON (no pool_config row)');
  await one(`INSERT INTO pool_config (project_id) VALUES ($1)`, [projectId]);
  eq(await gatewayBodyCaptureEnabled(projectId), true, 'pool_config with no column value → ON (column default true)');
  await one(`UPDATE pool_config SET gateway_body_capture=false WHERE project_id=$1`, [projectId]);
  eq(await gatewayBodyCaptureEnabled(projectId), false, 'explicit OFF reads OFF');
  await one(`UPDATE pool_config SET gateway_body_capture=true WHERE project_id=$1`, [projectId]);
  eq(await gatewayBodyCaptureEnabled(projectId), true, 'back ON');

  // ── F. persistBodies + bodiesForRequest — the round-trip ──────────────────────────────
  console.log('\n── F. persistBodies + bodiesForRequest — round-trip ──');
  rid = await one(
    `INSERT INTO llm_gateway_request (xell_id, project_id, kind, provider, model, method, path)
     VALUES ($1,$2,'messages','deepseek','deepseek-chat','POST','/v1/messages') RETURNING id`,
    [xellId, projectId]);
  rid = rid.id;
  eq(await bodiesForRequest(rid), null, 'no body row yet → null');
  await persistBodies({
    rowId: rid, projectId,
    requestBody: '{"role":"user","content":"hi"}', requestTruncated: false,
    responseBody: 'event: message_stop', responseTruncated: true,
  });
  const read = await bodiesForRequest(rid);
  eq(read?.request_body, '{"role":"user","content":"hi"}', 'request body round-trips');
  eq(read?.request_truncated, false, 'request truncated flag round-trips');
  eq(read?.response_body, 'event: message_stop', 'response body round-trips');
  eq(read?.response_truncated, true, 'response truncated flag round-trips');
  // UPSERT: a second persist with new data overwrites, not duplicates.
  await persistBodies({ rowId: rid, projectId, requestBody: '{"role":"user","content":"hi again"}', responseBody: null });
  const read2 = await bodiesForRequest(rid);
  eq(read2?.request_body, '{"role":"user","content":"hi again"}', 'UPSERT overwrites the request body');
  eq(read2?.response_body, null, 'UPSERT clears a body when the new value is null');
  eq((await q(`SELECT count(*)::int AS n FROM llm_gateway_body WHERE request_id=$1`, [rid]))[0].n, 1, 'exactly one body row per request');
  // persistBodies with both bodies null/empty writes nothing.
  await persistBodies({ rowId: rid, projectId, requestBody: null, responseBody: null });
  eq((await q(`SELECT count(*)::int AS n FROM llm_gateway_body WHERE request_id=$1`, [rid]))[0].n, 1, 'a nothing-to-store persist does not create a row');

  // ── G. sweepGatewayBodies — 14-day retention ──────────────────────────────────────────
  console.log('\n── G. sweepGatewayBodies — 14-day retention ──');
  const oldRid = (await one(
    `INSERT INTO llm_gateway_request (xell_id, project_id, kind, provider, model, method, path)
     VALUES ($1,$2,'messages','deepseek','deepseek-chat','POST','/v1/messages') RETURNING id`,
    [xellId, projectId])).id;
  await q(`INSERT INTO llm_gateway_body (request_id, project_id, request_body, created_at)
    VALUES ($1,$2,'old', now() - interval '15 days')`, [oldRid, projectId]);
  const freshRid = (await one(
    `INSERT INTO llm_gateway_request (xell_id, project_id, kind, provider, model, method, path)
     VALUES ($1,$2,'messages','deepseek','deepseek-chat','POST','/v1/messages') RETURNING id`,
    [xellId, projectId])).id;
  await q(`INSERT INTO llm_gateway_body (request_id, project_id, request_body, created_at)
    VALUES ($1,$2,'fresh', now() - interval '5 days')`, [freshRid, projectId]);
  const removed = await sweepGatewayBodies({ olderThanDays: 14, now: Date.now() });
  eq(removed, 1, 'the 15-day-old body is swept');
  eq(await bodiesForRequest(oldRid), null, 'the swept body is gone');
  eq((await bodiesForRequest(freshRid))?.request_body, 'fresh', 'the 5-day-old body survives');
  // The request rows are NOT swept — bodies are the cold part; the ledger stays.
  eq((await one(`SELECT id FROM llm_gateway_request WHERE id=$1`, [oldRid]))?.id, oldRid, 'the ledger row survives the body sweep');

  // ── H. switch OFF stores nothing (the gateway contract) ───────────────────────────────
  console.log('\n── H. switch OFF stores nothing ──');
  await one(`UPDATE pool_config SET gateway_body_capture=false WHERE project_id=$1`, [projectId]);
  eq(await gatewayBodyCaptureEnabled(projectId), false, 'the switch reads OFF');
  // The gateway gates BOTH the capture and the persist on the switch (gateway.js): when it is
  // OFF, captureRequestText is never called and persistBodies is never reached. Assert the two
  // halves the gateway depends on: the switch is the single gate, and a body row only appears
  // when the gateway persisted one.
  const offRid = (await one(
    `INSERT INTO llm_gateway_request (xell_id, project_id, kind, provider, model, method, path)
     VALUES ($1,$2,'messages','deepseek','deepseek-chat','POST','/v1/messages') RETURNING id`,
    [xellId, projectId])).id;
  eq(await bodiesForRequest(offRid), null, 'no body is stored for a request while the switch is OFF');

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  await q(`DELETE FROM llm_gateway_body WHERE project_id=$1`, [projectId]).catch(() => {});
  await q(`DELETE FROM llm_gateway_request WHERE xell_id=$1`, [xellId]).catch(() => {});
  await q(`DELETE FROM pool_config WHERE project_id=$1`, [projectId]).catch(() => {});
  await q(`DELETE FROM provider_token WHERE project_id=$1`, [projectId]).catch(() => {});
  await q(`DELETE FROM xell WHERE id=$1`, [xellId]).catch(() => {});
  await q(`DELETE FROM xource WHERE id=$1`, [xourceId]).catch(() => {});
  await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  await pool.end();
}
process.exit(fail ? 1 : 0);
