// LANGCHAIN TOOL LOOP — "model → tool request → queenzee-owned verb → tool result → model"
// (server/src/lib/langchain-tools.js + runLangchainAgentTurn in langchain-zee.js,
// docs/langchain-stateful-zees.md §8.3.1).
//
// What this proves, end to end against a REAL gatewayProxy + a mock upstream that emits tool_use:
//   A. THE LOOP. A langchain zee with the tool registry bound makes a model call; the model
//      requests a tool (`working`); the QUEENZEE runs the SHARED /api/xell/self handler
//      (selfWorking — the exact function the route calls, no second copy); the tool result is fed
//      back as a ToolMessage; the model then sees the result and finishes. The return carries
//      toolCalls so the caller (spawnLangchainZee) can feed the play-by-play.
//   B. THE GATEWAY. Every iteration is a separate model call through gatewayProxy → llm_gateway_request
//      attributed to the live zee + open turn (the same drill-down the CLI calls produce).
//   C. THE CAP. A model that keeps requesting tools without finishing is stopped at the hard cap
//      (default 8, injectable for the test) and the result is a VISIBLE capped message, not a
//      silent stop.
//   D. CONFINEMENT. A tool NOT in the registry is refused (the allowlist IS the confinement), and
//      the refusal is fed back to the model as a tool result the model can react to — the loop
//      does not die, it continues with the refusal.
//
// RUN:  DATABASE_URL=... PORT=4999 GATEWAY_PORT=4998 CXELL_API_BASE=http://127.0.0.1:4998 \
//         node test/langchain-tools.test.mjs
import http from 'node:http';
import { q, one, pool } from '../server/src/db/pool.js';
import { mintXellToken } from '../server/src/lib/xell-token.js';
import { gatewayProxy, requestsForXell } from '../server/src/lib/gateway.js';
import { runLangchainAgentTurn, messageText } from '../server/src/lib/langchain-zee.js';
import { LANGCHAIN_TOOLS, runTool } from '../server/src/lib/langchain-tools.js';
import { fakeTokens } from './_bin/tokens.mjs';

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

let projectId = null, xourceId = null, xellId = null, zeeId = null, turnId = null, workItemId = null;
let mockServer = null, gwServer = null;

// A mock upstream that follows a SCRIPT of responses. The first request has no tool_result → emit a
// tool_use for `working`. Once the request carries a tool_result, emit a plain-text finish. This is
// the "model asks for a tool, gets the result, then concludes" shape.
function startMockUpstream() {
  return new Promise((resolve) => {
    const requests = [];
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch { /* not json */ }
        requests.push(j);
        const hasToolResult = (j.messages || []).some((m) =>
          Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result'));
        res.writeHead(200, { 'content-type': 'application/json' });
        if (!hasToolResult) {
          // First call: request the `working` tool.
          res.end(JSON.stringify({
            id: 'msg_1', type: 'message', role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'working', input: { note: 'starting the tool loop' } }],
            model: j.model || MODEL, stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
          }));
        } else {
          // Second call: the tool_result is present — conclude.
          res.end(JSON.stringify({
            id: 'msg_2', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'tool loop finished: I pinged working.' }],
            model: j.model || MODEL, stop_reason: 'end_turn',
            usage: { input_tokens: 12, output_tokens: 6 },
          }));
        }
      });
    });
    mockServer.listen(0, '127.0.0.1', () => resolve({ server: mockServer, requests }));
  });
}

function startGateway() {
  return new Promise((resolve, reject) => {
    gwServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
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

// Build the minimal fleet rows a worker xell needs for selfWorking / selfStatus.
async function setupRows() {
  const name = `langchain-tools-${Date.now().toString(36)}`;
  const proj = await one(`INSERT INTO project (name, repo_root) VALUES ($1, $2) RETURNING id`, [name, `/tmp/${name}`]);
  projectId = proj.id;
  const xo = await one(`INSERT INTO xource (project_id, ref) VALUES ($1, 'refs/heads/main') RETURNING id`, [projectId]);
  xourceId = xo.id;
  const xl = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, zee_type)
     VALUES ($1, $2, $3, $4, $5, 'ready', 'worker') RETURNING id`,
    [projectId, xourceId, name, `spinoff/${name}`, `/tmp/${name}-wt`]);
  xellId = xl.id;
  const z = await one(
    `INSERT INTO zee (xell_id, attach_mode, runtime_id, viewer_kind, status, kind, entrypoint,
                      model, permission_mode, cwd, title)
     VALUES ($1,'headless-spawn',NULL,'none','working','headless','langchain',$2,'bypassPermissions','/work/repo','tool-loop-test')
     RETURNING id`, [xellId, MODEL]);
  zeeId = z.id;
  // The gateway's resolveUpstream needs a deepseek account on the project to forward the call
  // (it reads tokenForSpawn(project, 'deepseek') and returns 502 without one).
  await q(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label)
     VALUES ($1, 'deepseek', $2, $3, 'langchain-tools-test')`,
    [projectId, DEEPSEEK_KEY, `…${DEEPSEEK_KEY.slice(-4)}`]);
  const t = await one(
    `INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, status, model)
     VALUES ($1,$2,$3,'spawn','started',$4) RETURNING id`, [zeeId, xellId, projectId, MODEL]);
  turnId = t.id;
  // A work item assigned to this xell so `working`/`item`/`work` have a target.
  const wi = await one(
    `INSERT INTO work_item (project_id, kind, title, status, xell_id)
     VALUES ($1,'task','Tool loop test card','working',$2) RETURNING id`, [projectId, xellId]);
  workItemId = wi.id;
  return { xell: xl, zee: z, turn: t };
}

console.log('\n── setup: mock upstream + gateway + a worker xell on a card ──');
try {
  const mock = await startMockUpstream();
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.server.address().port}`;
  console.log(`  mock upstream on :${mock.server.address().port}`);
  await startGateway();
  console.log(`  gateway on :${GATEWAY_PORT}`);
  const { xell } = await setupRows();
  const xellToken = await mintXellToken(xellId);
  ok(!!xellToken, 'the xell has an identity token for the gateway path');

  // ── A. THE LOOP — model → tool → shared handler → result → model ───────────────────────────
  console.log('\n── A. the loop: the model requests `working`, the queenzee runs the SHARED handler ──');
  const res = await runLangchainAgentTurn({
    xell, task: 'start the tool loop', provider: 'deepseek', model: MODEL,
    apiKey: DEEPSEEK_KEY, xellToken,
  });
  eq(messageText(res.text), 'tool loop finished: I pinged working.', 'the model concluded after the tool result');
  eq(res.iterations, 2, 'two model calls — one tool request + one conclusion');
  eq(res.toolCalls.length, 1, 'the model requested exactly one tool');
  eq(res.toolCalls[0].name, 'working', 'the requested tool is `working`');
  eq(res.toolCalls[0].args?.note, 'starting the tool loop', 'the model passed the note arg');
  ok(res.capped === false, 'the loop was NOT capped (it finished naturally)');
  // The mock's second request must have carried the tool_result (the queenzee's handler output).
  const secondReq = mock.requests[1];
  const toolResultBlock = secondReq?.messages?.find((m) =>
    Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result'))?.content;
  ok(!!toolResultBlock, 'the model\'s second call carried the tool_result block');
  const trText = toolResultBlock?.find((c) => c.type === 'tool_result')?.content || '';
  ok(trText.includes('"ok":true'), 'the tool_result is the queenzee handler\'s output (ok:true)');
  ok(trText.includes('Working ping recorded'), 'the tool_result is the REAL selfWorking message');

  // ── B. THE GATEWAY — every iteration attributed to the zee + turn ──────────────────────────
  console.log('\n── B. the gateway: every iteration is a recorded, attributed request ──');
  const rows = await requestsForXell(xellId);
  ok(rows.length >= 2, `the gateway recorded both iterations (${rows.length} rows)`);
  const iterRows = rows.slice(0, 2);
  ok(iterRows.every((r) => r.zee_id === zeeId), 'every iteration is attributed to the live zee');
  ok(iterRows.every((r) => r.turn_id === turnId), 'every iteration is attributed to the open turn');
  ok(iterRows.every((r) => r.provider === 'deepseek'), 'every iteration is attributed to deepseek');

  // ── D. CONFINEMENT — a tool outside the registry is refused, and the loop continues ─────────
  console.log('\n── D. confinement: a tool outside the registry is refused (allowlist) ──');
  const refused = await runTool(xell, { name: 'run_bash', args: { cmd: 'rm -rf /' } });
  const refusedJson = JSON.parse(refused);
  eq(refusedJson.ok, false, 'run_bash is refused');
  ok(/not a bindable tool/.test(refusedJson.error), 'the refusal names it as not bindable');
  const refused2 = await runTool(xell, { name: 'build', args: {} });
  ok(JSON.parse(refused2).ok === false, 'build is refused (the migration-at-boot hole)');
  const refused3 = await runTool(xell, { name: 'sync', args: {} });
  ok(JSON.parse(refused3).ok === false, 'sync is refused (it triggers a build)');
  // The registry itself must not even CONTAIN the never-bindable verbs.
  for (const neverBindable of ['run_bash', 'build', 'sync', 'db-catchup', 'catchup', 'swap', 'dispatch', 'say', 'suggest-done', 'zees', 'done', 'device', 'db-sandbox', 'prod', 'seed']) {
    ok(!LANGCHAIN_TOOLS[neverBindable], `\`${neverBindable}\` is NOT in the tool registry`);
  }

  // ── C. THE CAP — a model that never finishes is stopped VISIBLY ───────────────────────────
  console.log('\n── C. the cap: a model that keeps requesting tools is stopped at the hard cap ──');
  const alwaysTool = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_cap', type: 'message', role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_cap', name: 'working', input: {} }],
          model: MODEL, stop_reason: 'tool_use',
          usage: { input_tokens: 5, output_tokens: 5 },
        }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${alwaysTool.address().port}`;
  const capped = await runLangchainAgentTurn({
    xell, task: 'loop forever', provider: 'deepseek', model: MODEL,
    apiKey: DEEPSEEK_KEY, xellToken, maxIterations: 3,   // injectable cap for the test
  });
  eq(capped.capped, true, 'the loop reports it was capped');
  eq(capped.iterations, 3, 'the loop stopped at the injected cap (3)');
  ok(/capped at 3 iterations/.test(capped.text), 'the result is a VISIBLE capped message, not a silent stop');
  ok(capped.toolCalls.length === 3, 'three tool requests were made before the cap');
  await new Promise((r) => alwaysTool.close(r));

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = '';
  if (mockServer) await new Promise((r) => mockServer.close(r));
  if (gwServer) await new Promise((r) => gwServer.close(r));
  if (workItemId) await q(`DELETE FROM work_item WHERE id=$1`, [workItemId]).catch(() => {});
  if (turnId) await q(`DELETE FROM zee_turn WHERE id=$1`, [turnId]).catch(() => {});
  if (zeeId) await q(`DELETE FROM zee WHERE id=$1`, [zeeId]).catch(() => {});
  if (xellId) await q(`DELETE FROM zee_conversation WHERE xell_id=$1`, [xellId]).catch(() => {});
  if (xellId) await q(`DELETE FROM llm_gateway_request WHERE xell_id=$1`, [xellId]).catch(() => {});
  if (xellId) await q(`DELETE FROM xell WHERE id=$1`, [xellId]).catch(() => {});
  if (xourceId) await q(`DELETE FROM xource WHERE id=$1`, [xourceId]).catch(() => {});
  if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  await pool.end();
}
process.exit(fail ? 1 : 0);
