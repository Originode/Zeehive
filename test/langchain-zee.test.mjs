// LANGCHAIN ZEE DRIVER — "deploy zees via langchain", stateful, with proper turnover
// (server/src/lib/langchain-zee.js, server/src/queenzee/langchain-spawn.js, docs/langchain-stateful-zees.md).
//
// What this file proves, end to end against a REAL gatewayProxy + a mock upstream:
//   A. The langchain chat model is pointed at the GATEWAY, not the provider — a model call flows
//      through gatewayProxy and lands in llm_gateway_request (the transport layer records it,
//      exactly like a vendor CLI call). No agent volunteers data.
//   B. TURNOVER — state survives a handover. Turn 1 appends its exchange to zee_conversation;
//      turn 2 on the SAME xell (a "swap" — a new zee row, a new turn) loads that conversation and
//      its model call carries the full prior history. The next zee demonstrably starts WARM.
//   C. The queenzee still owns every decision — the driver is a library the test (and the spawn
//      path) INVOKES; there is no graph, no framework loop, no langgraph import anywhere in it.
//      (langgraph is a transitive dependency of @langchain/core but is never imported here.)
//
// Wire shape (the exact path a cxell CLI would use): ChatAnthropic → gateway /x/<token>/deepseek →
// gatewayProxy → DEEPSEEK_ANTHROPIC_BASE_URL (this file's mock) → /v1/messages.
//
// RUN:  DATABASE_URL=... PORT=4999 GATEWAY_PORT=4998 CXELL_API_BASE=http://127.0.0.1:4998 \
//         node test/langchain-zee.test.mjs
// (PORT must differ from GATEWAY_PORT or gatewayEnv returns {} and the model points at the real
// provider instead of the gateway.)
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { mintXellToken } from '../server/src/lib/xell-token.js';
import { gatewayProxy, requestsForXell, providerUpstreamUrl } from '../server/src/lib/gateway.js';
import { runLangchainTurn, loadConversation, chatModelConfig, messageText } from '../server/src/lib/langchain-zee.js';
import { fakeTokens } from './_bin/tokens.mjs';

// The cxell's own env has ANTHROPIC_BASE_URL pointed at the fleet gateway (and an auth token).
// ChatAnthropic prefers env over constructor args for some fields; this test must isolate from that.
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
  delete process.env[k];
}

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 4998);
const CXELL_API_BASE = process.env.CXELL_API_BASE || `http://127.0.0.1:${GATEWAY_PORT}`;
const DEEPSEEK_KEY = fakeTokens.deepseek();
const MODEL = 'deepseek-chat';

let projectId = null, xourceId = null, xellId = null, zee1 = null, zee2 = null, turn1 = null, turn2 = null;
let mockServer = null, gwServer = null;

// The mock upstream — speaks the Anthropic dialect (non-streaming JSON; ChatAnthropic's default).
// Records every request body so the test can assert what the second turn carried.
const mockRequests = [];
// Count ONLY the model calls (POST /v1/messages) — the gateway fires a background GET /user/balance
// probe after each deepseek call, which also lands on the mock and would otherwise break the
// "exactly one request" assertions (the balance probe is not a model call).
const modelCalls = () => mockRequests.filter((r) => r.url === '/v1/messages');
function startMockUpstream() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch { /* not json */ }
        mockRequests.push({ url: req.url, body: j });
        if (j.stream) {
          // streaming (not used by default, but handle it honestly)
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null } })}\n\n`);
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello from mock' } })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_1', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'hello from mock' }],
            model: j.model || MODEL, stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }));
        }
      });
    });
    mockServer.listen(0, '127.0.0.1', () => resolve(mockServer.address().port));
  });
}

// The gateway itself — mounted exactly as index.js mounts it (express.json + gatewayProxy on /x/*).
function startGateway() {
  return new Promise((resolve, reject) => {
    gwServer = http.createServer((req, res) => {
      // The connectivity probe gatewayEnv mints VERIFY against (TKT-179): chatModelConfig now
      // PROVES the gateway by hitting /api/hello before minting, so the mock must answer it 200
      // like the real gateway's index.js mount (gatewayApp.get('/api/hello', gatewayHello)).
      if (req.url === '/api/hello') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true,"service":"zeehive-llm-gateway"}');
      }
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        // Rebuild a minimal req object gatewayProxy expects (req.url, req.method, req.headers, req.body)
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* keep */ }
        gatewayProxy({ url: req.url, method: req.method, headers: req.headers, body: parsed }, res)
          .catch((e) => { if (!res.headersSent) res.statusCode = 500; res.end(String(e.message)); });
      });
    });
    gwServer.on('error', reject);
    gwServer.listen(GATEWAY_PORT, '127.0.0.1', () => resolve());
  });
}

console.log('\n── setup: mock upstream + gateway + a xell with a deepseek account ──');
try {
  const mockPort = await startMockUpstream();
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${mockPort}`;
  console.log(`  mock upstream on :${mockPort} (DEEPSEEK_ANTHROPIC_BASE_URL)`);
  ok(providerUpstreamUrl('deepseek') === `http://127.0.0.1:${mockPort}`, 'the gateway will forward deepseek calls to the mock');
  await startGateway();
  console.log(`  gateway on :${GATEWAY_PORT}`);

  const name = `langchain-test-${Date.now().toString(36)}`;
  const proj = await one(`INSERT INTO project (name, repo_root) VALUES ($1, $2) RETURNING id`, [name, `/tmp/${name}`]);
  projectId = proj.id;
  const xo = await one(`INSERT INTO xource (project_id, ref) VALUES ($1, 'refs/heads/main') RETURNING id`, [projectId]);
  xourceId = xo.id;
  const xl = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status)
     VALUES ($1, $2, $3, $4, $5, 'ready') RETURNING id`,
    [projectId, xourceId, name, `spinoff/${name}`, `/tmp/${name}-wt`]);
  xellId = xl.id;
  // A deepseek account (the provider the gateway will forward to — same account the real fleet uses).
  await q(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label)
     VALUES ($1, 'deepseek', $2, $3, 'langchain-test')`,
    [projectId, DEEPSEEK_KEY, `…${DEEPSEEK_KEY.slice(-4)}`]);
  const xellToken = await mintXellToken(xellId);
  ok(!!xellToken, 'the xell has an identity token for the gateway path');

  // ── the driver's gateway wiring (part C: the config the model is pointed at) ──────────────
  console.log('\n── A. the model is pointed at the GATEWAY, not the provider ──');
  const cfg = await chatModelConfig({ provider: 'deepseek', xellToken });
  ok(cfg.baseUrl.includes(`/x/${xellToken}/deepseek`), `the base url is the gateway path (got ${cfg.baseUrl})`);
  ok(cfg.baseUrl.startsWith(CXELL_API_BASE), 'the gateway path is on the gateway host');
  ok(!cfg.baseUrl.includes('api.deepseek.com'), 'it is NOT the provider\'s own URL');

  // ── TURN 1 — the first zee on the xell ────────────────────────────────────────────────────
  console.log('\n── turn 1: a fresh langchain zee makes a model call through the gateway ──');
  zee1 = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, title)
     VALUES ($1,'headless-spawn',NULL,'none','working','headless','langchain',$2,'bypassPermissions','/work/repo','langchain-test-1')
     RETURNING *`, [xellId, MODEL]);
  turn1 = await one(
    `INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, status, model)
     VALUES ($1,$2,$3,'spawn','started',$4) RETURNING id`, [zee1.id, xellId, projectId, MODEL]);

  const r1 = await runLangchainTurn({
    xell: { id: xellId }, task: 'first question', provider: 'deepseek', model: MODEL,
    apiKey: DEEPSEEK_KEY, xellToken,
  });
  eq(messageText(r1.content), 'hello from mock', 'turn 1 got the mock response through the gateway');
  ok(modelCalls().length === 1, 'the mock upstream received exactly one request (turn 1)');
  const gwRows1 = await requestsForXell(xellId);
  ok(gwRows1.length >= 1, 'the gateway recorded the langchain call in llm_gateway_request');
  eq(gwRows1[0]?.provider, 'deepseek', 'the recorded request is attributed to deepseek');
  const conv1 = await loadConversation(xellId);
  eq(conv1.length, 2, 'turn 1 persisted its exchange (user + assistant) to zee_conversation');
  ok(conv1.some((m) => m._getType() === 'human'), 'the persisted history has the user message');
  ok(conv1.some((m) => m._getType() === 'ai'), 'the persisted history has the assistant message');

  // ── TURN 2 — THE HANDOVER: a NEW zee on the SAME xell ────────────────────────────────────
  console.log('\n── B. TURNOVER — the next zee on the same xell starts WARM ──');
  // The handover: the outgoing zee is retired (a swap sets status='stopped') so the incoming zee
  // can take the xell — the one_active_zee_per_xell unique index allows at most one live zee.
  await q(`UPDATE zee SET status='stopped' WHERE id=$1`, [zee1.id]);
  zee2 = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, title)
     VALUES ($1,'headless-spawn',NULL,'none','working','headless','langchain',$2,'bypassPermissions','/work/repo','langchain-test-2')
     RETURNING *`, [xellId, MODEL]);
  turn2 = await one(
    `INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, status, model)
     VALUES ($1,$2,$3,'spawn','started',$4) RETURNING id`, [zee2.id, xellId, projectId, MODEL]);
  const before = modelCalls().length;
  const r2 = await runLangchainTurn({
    xell: { id: xellId }, task: 'second question', provider: 'deepseek', model: MODEL,
    apiKey: DEEPSEEK_KEY, xellToken,
  });
  eq(messageText(r2.content), 'hello from mock', 'turn 2 got the mock response through the gateway');
  ok(modelCalls().length === before + 1, 'the mock upstream received exactly one request (turn 2)');
  const req2 = modelCalls()[modelCalls().length - 1];
  const roles2 = (req2.body.messages || []).map((m) => m.role);
  ok(roles2.includes('user') && roles2.includes('assistant') && roles2.includes('user'),
    `turn 2's model call carried the FULL prior history (roles: ${roles2.join(',')})`);
  const texts2 = (req2.body.messages || []).map((m) => String(m.content));
  ok(texts2.includes('first question'), 'turn 2 carried turn 1\'s user message ("first question")');
  ok(texts2.includes('hello from mock'), 'turn 2 carried turn 1\'s assistant reply ("hello from mock")');
  ok(texts2.includes('second question'), 'turn 2 carried its own task ("second question")');
  // The zee_conversation table now holds both turns' exchanges.
  const conv2 = await loadConversation(xellId);
  eq(conv2.length, 4, 'both turns persisted — 4 messages in zee_conversation (2 turns × user+assistant)');

  // The gateway recorded BOTH turns' calls.
  const gwRows2 = await requestsForXell(xellId);
  ok(gwRows2.length >= 2, `the gateway recorded both turns' calls (${gwRows2.length} rows)`);

  // ── C. the REAL spawn path (spawnLangchainZee) drives a langchain zee end to end ───────────
  console.log('\n── C. spawnLangchainZee — a real zee turn driven by the driver ──');
  const { spawnLangchainZee } = await import('../server/src/queenzee/langchain-spawn.js');
  // The handover again: retire the current live zee so the spawn path can take the xell (a swap
  // does exactly this — retire, then dispatch the incoming zee).
  await q(`UPDATE zee SET status='stopped' WHERE id=$1`, [zee2.id]);
  const rt = await one(`SELECT * FROM agent_runtime WHERE key='langchain-stateful'`);
  ok(!!rt && rt.driver === 'langchain', 'the langchain-stateful runtime row exists with driver=langchain');
  const beforeSpawn = modelCalls().length;
  const spawnOut = await spawnLangchainZee({
    pid: projectId, xell: await one(`SELECT * FROM xell WHERE id=$1`, [xellId]),
    task: 'spawn path question', rt, model: MODEL, provider: 'deepseek',
  });
  ok(spawnOut.ok === true, `spawnLangchainZee returned ok (${JSON.stringify(spawnOut).slice(0, 120)})`);
  ok(modelCalls().length === beforeSpawn + 1, 'the spawn path made exactly one model call through the gateway');
  const spawnZee = await one(`SELECT * FROM zee WHERE id=$1`, [spawnOut.zee_id]);
  eq(spawnZee.status, 'idle', 'the spawned zee ended idle (a completed turn)');
  eq(spawnZee.entrypoint, 'langchain', 'the spawned zee is entrypoint=langchain');
  const spawnTurn = await one(`SELECT * FROM zee_turn WHERE zee_id=$1 ORDER BY started_at DESC LIMIT 1`, [spawnOut.zee_id]);
  eq(spawnTurn.status, 'ended', 'the spawned zee\'s turn ended');
  const spawnConv = await loadConversation(xellId);
  ok(spawnConv.length > 4, `the spawn path persisted its exchange too (${spawnConv.length} messages now)`);
  const spawnGw = await requestsForXell(xellId);
  ok(spawnGw.length >= 3, `the spawn path\'s model call is in the gateway ledger (${spawnGw.length} rows)`);

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = '';
  if (mockServer) await new Promise((r) => mockServer.close(r));
  if (gwServer) await new Promise((r) => gwServer.close(r));
  if (turn1) await q(`DELETE FROM zee_turn WHERE id=$1`, [turn1.id]).catch(() => {});
  if (turn2) await q(`DELETE FROM zee_turn WHERE id=$1`, [turn2.id]).catch(() => {});
  if (xellId) await q(`DELETE FROM zee_conversation WHERE xell_id=$1`, [xellId]).catch(() => {});
  if (xellId) await q(`DELETE FROM llm_gateway_request WHERE xell_id=$1`, [xellId]).catch(() => {});
  if (xellId) await q(`DELETE FROM zee WHERE xell_id=$1`, [xellId]).catch(() => {});
  if (xellId) await q(`DELETE FROM xell WHERE id=$1`, [xellId]).catch(() => {});
  if (xourceId) await q(`DELETE FROM xource WHERE id=$1`, [xourceId]).catch(() => {});
  if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  await pool.end();
}
process.exit(fail ? 1 : 0);
