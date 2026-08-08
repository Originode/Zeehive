// GATEWAY PROXY E2E — the full HTTP proxy path with a LIVE mock upstream.
//
// test/gateway.test.mjs covers the pure pieces (parseGatewayPath, normalizeUsage, usageFromStream,
// joinUpstreamPath) and the DB round-trip (record → complete → read). What it does NOT cover is the
// PROXY itself: an HTTP request landing on the gateway, being forwarded to an upstream, the SSE
// stream piped back UNBUFFERED, and the upstream's usage parsed out of the stream into the ledger.
// That is the whole point of the observability layer — every AI call crossing the gateway is
// recorded at the transport layer, attributed to the xell by the token in the path — so this file
// exercises it for real against a mock upstream.
//
// What this file covers (all against DATABASE_URL, torn down in a finally — house rule 1):
//   A. Anthropic dialect (deepseek): POST /x/<token>/deepseek/v1/messages → the SSE stream is
//      forwarded verbatim AND the upstream's message_delta usage lands in llm_gateway_request.
//      (Claude itself is NOT mocked here: providerUpstreamUrl hard-codes claude to
//      api.anthropic.com, so the test uses deepseek, which speaks the same /v1/messages dialect
//      and respects its own base-url env.)
//   B. OpenAI dialect (openai): POST /x/<token>/openai/v1/chat/completions → the stream is
//      forwarded and usage recorded, and the upstream receives /v1/chat/completions — NOT
//      /v1/v1/chat/completions (the version-segment doubling joinUpstreamPath fixes).
//   B2. Kimi dialect (kimi): POST /x/<token>/kimi/v1/chat/completions → resolved as the KIMI
//      provider (not openai), forwarded to the kimi upstream's /coding/v1 base, and recorded
//      with the kimi key.
//   C. Unknown xell identity → 401, and NO row is written.
//   D. The gateway is best-effort: a dead upstream → 502 with a completed error row, never a hang.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { q, one, pool } from '../server/src/db/pool.js';
import { mintXellToken } from '../server/src/lib/xell-token.js';
import { gatewayProxy, gatewayHello, requestsForXell } from '../server/src/lib/gateway.js';
import { bodiesForRequest, gatewayBodyCaptureEnabled } from '../server/src/lib/gateway-bodies.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// The mock upstream: answers both dialects, logs what it received, returns a usage-bearing SSE.
function startMockUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, auth: req.headers.authorization || null };
      seen.push(rec);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (req.url.includes('/chat/completions')) {
        res.write('data: {"choices":[]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n');
        res.write('data: [DONE]\n\n');
      } else {
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":11,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"total_cost_usd":0.0005}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

// A throwaway project + xell + provider token. Returns the fixture ids + the xell's identity token.
async function makeFixture(provider, token) {
  const name = `gw-proxy-${provider}-` + randomUUID().slice(0, 8);
  const proj = await one(`INSERT INTO project (name, repo_root) VALUES ($1, $2) RETURNING id`, [name, `/tmp/${name}`]);
  const projectId = proj.id;
  const xo = await one(`INSERT INTO xource (project_id, ref) VALUES ($1, 'refs/heads/main') RETURNING id`, [projectId]);
  const xourceId = xo.id;
  const xl = await one(`INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status)
    VALUES ($1, $2, $3, $4, $5, 'claimed') RETURNING id`,
    [projectId, xourceId, name, `spinoff/${name}`, `/tmp/${name}-wt`]);
  const xellId = xl.id;
  await one(`INSERT INTO provider_token (project_id, provider, token, token_hint)
    VALUES ($1, $2, $3, $4) RETURNING id`, [projectId, provider, token, `${token.slice(0, 6)}…`]);
  const xellToken = await mintXellToken(xellId);
  return { name, projectId, xourceId, xellId, xellToken };
}

// The gateway is an express app mounted exactly as index.js mounts it.
function startGatewayApp() {
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  app.get('/api/hello', gatewayHello);
  app.head('/api/hello', gatewayHello);
  app.all('/x/*', gatewayProxy);
  app.use((_req, res) => res.status(404).json({ error: 'gateway: expected /x/<xell-token>/<provider>/v1/…' }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// The proxy answers the client first and writes the best-effort completion row a beat later
// (observability never blocks the AI call). Read the row once it has a status — poll rather than
// race the async write.
async function completedRow(xellId) {
  for (let i = 0; i < 40; i++) {
    const rows = await requestsForXell(xellId);
    if (rows.length && rows[0]?.status != null) return rows[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  return (await requestsForXell(xellId))[0] || null;
}

const mock = await startMockUpstream();
const gw = await startGatewayApp();
// Point the gateway at the mock. The openai/kimi bases CARRY their version path like the real
// upstreams (api.openai.com/v1, api.kimi.com/coding/v1), so the doubling bug joinUpstreamPath
// fixes is exercised rather than dodged.
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`;
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
process.env.KIMI_CODE_BASE_URL = `http://127.0.0.1:${mock.port}/coding/v1`;
process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`;
// NOTE: claude's upstream is deliberately NOT mocked here — providerUpstreamUrl hard-codes claude
// to api.anthropic.com (main), and setting ANTHROPIC_BASE_URL would be a no-op for it.

const fixtures = [];
try {
  // The Anthropic-dialect section runs through the DEEPSEEK provider, not claude: providerUpstreamUrl
  // deliberately hard-codes claude to api.anthropic.com (main), so a claude call cannot be pointed
  // at a mock upstream from a test. deepseek speaks the SAME Anthropic /v1/messages dialect, respects
  // its own base-url env, and exercising it also covers the deepseek routing fix.
  console.log('\n── A. Anthropic dialect (deepseek) — /v1/messages through the proxy ──');
  const fx = await makeFixture('deepseek', 'sk-mockdeepseek123456789');
  fixtures.push(fx);
  const res = await fetch(`http://127.0.0.1:${gw.port}/x/${fx.xellToken}/deepseek/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-mockdeepseek123456789' },
    body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.text();
  ok(res.status === 200, 'the SSE stream is forwarded with 200');
  ok(body.includes('event: message_delta'), 'the upstream SSE events pass through untouched');
  ok(body.includes('"input_tokens":11'), 'the usage event is in the forwarded stream');
  const rows = await requestsForXell(fx.xellId);
  eq(rows.length, 1, 'the proxy recorded the request');
  const row = await completedRow(fx.xellId);
  eq(row?.provider, 'deepseek', 'provider is deepseek');
  eq(row?.model, 'deepseek-chat', 'model is read from the body');
  eq(Number(row?.input_tokens), 11, 'input tokens from the upstream usage');
  eq(Number(row?.output_tokens), 5, 'output tokens from the upstream usage');
  eq(Number(row?.cache_read_tokens), 2, 'cache read tokens');
  eq(Number(row?.cache_write_tokens), 1, 'cache write tokens');
  eq(Number(row?.total_tokens), 19, 'total = input + output + cache read + cache write');
  eq(Number(row?.cost_usd), 0.0005, 'cost from the upstream total_cost_usd');
  eq(row?.status, 200, 'status 200');
  eq(mock.seen.at(-1)?.url, '/v1/messages?beta=true', 'the upstream received the stripped forward path');
  ok(mock.seen.at(-1)?.auth?.includes('sk-mockdeepseek123456789'), 'the upstream got the PROVIDER key, not the xell token');
  // BODY CAPTURE (migration 162, lib/gateway-bodies.js): the request DELTA + the REASSEMBLED
  // response SSE. The default switch (no pool_config row) is ON.
  const aBody = await bodiesForRequest(row.id);
  ok(!!aBody, 'the proxy captured the request/response bodies');
  eq(aBody?.request_body, '{"role":"user","content":"hi"}', 'the request body is the DELTA (the last message), not the whole conversation');
  eq(aBody?.request_truncated, false, 'a small request body is not truncated');
  ok(aBody?.response_body?.includes('event: message_start'), 'the response body is the REASSEMBLED SSE text');
  ok(aBody?.response_body?.includes('event: message_stop'), 'the response body carries the final SSE event');
  ok(aBody?.response_body?.includes('"input_tokens":11'), 'the usage event is in the reassembled response body');
  eq(aBody?.response_truncated, false, 'a short SSE response is not truncated');

  console.log('\n── B. OpenAI dialect — /v1/chat/completions through the proxy ──');
  const fx2 = await makeFixture('openai', 'sk-mockopenai123456789012');
  fixtures.push(fx2);
  const res2 = await fetch(`http://127.0.0.1:${gw.port}/x/${fx2.xellToken}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-mockopenai123456789012' },
    body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body2 = await res2.text();
  ok(res2.status === 200, 'openai stream forwarded with 200');
  ok(body2.includes('[DONE]'), 'openai SSE passes through');
  const rows2 = await requestsForXell(fx2.xellId);
  eq(rows2.length, 1, 'the proxy recorded the openai request');
  const row2 = await completedRow(fx2.xellId);
  eq(Number(row2?.input_tokens), 7, 'prompt tokens from the usage chunk');
  eq(Number(row2?.output_tokens), 3, 'completion tokens from the usage chunk');
  eq(Number(row2?.total_tokens), 10, 'openai total tokens');
  eq(mock.seen.at(-1)?.url, '/v1/chat/completions', 'the upstream got /v1/chat/completions — NOT /v1/v1/…');
  eq(row2?.path, '/v1/chat/completions', 'the recorded path is the forward path');

  console.log('\n── B2. Kimi dialect — /kimi/v1/chat/completions through the proxy ──');
  const fxK = await makeFixture('kimi', 'kimi-mocktoken1234567890');
  fixtures.push(fxK);
  const resK = await fetch(`http://127.0.0.1:${gw.port}/x/${fxK.xellToken}/kimi/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer kimi-mocktoken1234567890' },
    body: JSON.stringify({ model: 'kimi-k2', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const bodyK = await resK.text();
  ok(resK.status === 200, 'kimi stream forwarded with 200');
  ok(bodyK.includes('[DONE]'), 'kimi SSE passes through');
  const rowsK = await requestsForXell(fxK.xellId);
  eq(rowsK.length, 1, 'the proxy recorded the kimi request');
  const rowK = await completedRow(fxK.xellId);
  eq(rowK?.provider, 'kimi', 'provider is kimi — NOT openai');
  eq(rowK?.model, 'kimi-k2', 'kimi model recorded');
  eq(Number(rowK?.total_tokens), 10, 'kimi total tokens');
  eq(mock.seen.at(-1)?.url, '/coding/v1/chat/completions', 'the kimi upstream got /coding/v1/chat/completions — the kimi base path, no doubled /v1');
  ok(mock.seen.at(-1)?.auth?.includes('kimi-mocktoken1234567890'), 'the kimi upstream got the KIMI key, not the openai key');

  console.log('\n── C. unknown xell identity → 401, no row ──');
  const res3 = await fetch(`http://127.0.0.1:${gw.port}/x/definitely-not-a-real-token/claude/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  eq(res3.status, 401, 'unknown xell → 401');
  const j3 = await res3.json().catch(() => ({}));
  ok(/unknown xell/.test(j3.error || ''), 'the 401 names the unknown identity');
  const before = mock.seen.length;
  await new Promise((r) => setTimeout(r, 50));
  eq(mock.seen.length, before, 'nothing was forwarded to the upstream for an unknown xell');

  console.log('\n── D. dead upstream → 502, error row, no hang ──');
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${await (async () => { const s = http.createServer(() => {}); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; s.close(); return p; })()}`;
  const fx4 = await makeFixture('deepseek', 'sk-mockdeepseek123456789');
  fixtures.push(fx4);
  const res4 = await fetch(`http://127.0.0.1:${gw.port}/x/${fx4.xellToken}/deepseek/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-mockdeepseek123456789' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  ok(res4.status === 502, 'dead upstream → 502');
  // The completion is BEST-EFFORT (the proxy answers the client first, then writes the row), so
  // the DB write may land a beat after the response. Poll rather than race it.
  let row4 = null;
  for (let i = 0; i < 40; i++) {
    const rows4 = await requestsForXell(fx4.xellId);
    if (rows4.length && rows4[0]?.status != null) { row4 = rows4[0]; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  ok(!!row4, 'the failed forward is still recorded');
  eq(row4?.status, 502, 'the row carries the 502 status');

  console.log('\n── F. per-project switch OFF → the proxy stores no bodies ──');
  // Section D pointed DEEPSEEK_ANTHROPIC_BASE_URL at a DEAD port — point it back at the mock.
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`;
  const fxOff = await makeFixture('deepseek', 'sk-mockdeepseek123456789');
  fixtures.push(fxOff);
  await one(`INSERT INTO pool_config (project_id, gateway_body_capture) VALUES ($1, false)`, [fxOff.projectId]);
  eq(await gatewayBodyCaptureEnabled(fxOff.projectId), false, 'the switch reads OFF');
  const resOff = await fetch(`http://127.0.0.1:${gw.port}/x/${fxOff.xellToken}/deepseek/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-mockdeepseek123456789' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
  });
  ok(resOff.status === 200, 'a call still succeeds with capture OFF');
  const offRow = await completedRow(fxOff.xellId);
  eq(offRow?.status, 200, 'the ledger row is written even with capture OFF');
  eq(await bodiesForRequest(offRow?.id), null, 'NO body row is stored while the switch is OFF');

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  for (const fx of fixtures) {
    await q(`DELETE FROM llm_gateway_request WHERE xell_id=$1`, [fx.xellId]).catch(() => {});
    await q(`DELETE FROM provider_token WHERE project_id=$1`, [fx.projectId]).catch(() => {});
    await q(`DELETE FROM xell WHERE id=$1`, [fx.xellId]).catch(() => {});
    await q(`DELETE FROM xource WHERE id=$1`, [fx.xourceId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [fx.projectId]).catch(() => {});
  }
  gw.server.close();
  mock.server.close();
  await pool.end();
}
process.exit(fail ? 1 : 0);
