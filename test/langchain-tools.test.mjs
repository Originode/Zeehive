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
//   E/E2. WAVE-2 ASKS. A bound `tend` produces a tend_request (asks, does not act); a bound
//      `hint-land` writes a landhint-request event (annotates, nothing else).
//   F. THE ALLOWLIST, NOT THE CALLER'S ARRAY. An over-wide `tools` array cannot widen the loop.
//   G. LOOP-ENDS-TURN ON TEND. A model raising a tend (asking for a human) ENDS the turn with a
//      visible "ended because a human was asked" result, naming the ask, with no further iterations.
//      `working` is the plain shared handler (no wrapper/guard on the tool path).
//      cannot silently clear a question posted to a human.
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
  // The wave-2 gated asks are NEVER bindable on this fleet: auto_approve_land/ship/seed are true,
  // so a bound land/ship/seed would ACT (put code on main / deploy prod / write prod rows) with no
  // human. The confinement is the allowlist, not the gate — these must be absent.
  const refusedLand = await runTool(xell, { name: 'land', args: {} });
  ok(JSON.parse(refusedLand).ok === false, 'land is refused (auto_approve_land=true → no human hold)');
  const refusedShip = await runTool(xell, { name: 'ship', args: {} });
  ok(JSON.parse(refusedShip).ok === false, 'ship is refused (auto_approve_ship=true → deploys prod)');
  const refusedSeed = await runTool(xell, { name: 'seed', args: {} });
  ok(JSON.parse(refusedSeed).ok === false, 'seed is refused (auto_approve_seed=true → writes prod rows)');
  // The registry itself must not even CONTAIN the never-bindable verbs.
  for (const neverBindable of ['run_bash', 'build', 'sync', 'db-catchup', 'catchup', 'swap', 'dispatch', 'say', 'suggest-done', 'zees', 'done', 'device', 'db-sandbox', 'prod', 'seed', 'land', 'ship']) {
    ok(!LANGCHAIN_TOOLS[neverBindable], `\`${neverBindable}\` is NOT in the tool registry`);
  }

  // ── E. WAVE 2 — a bound `tend` ASKS (it does not act), and the ask is a tend_request ─────────
  console.log('\n── E. wave 2: a bound `tend` produces a tend_request a human must answer ──');
  ok(!!LANGCHAIN_TOOLS.tend, '`tend` IS in the tool registry (the escalation verb, bound)');
  const tendRes = await runTool(xell, { name: 'tend', args: { reason: 'tool-loop test needs a human' } });
  const tendJson = JSON.parse(tendRes);
  eq(tendJson.ok, true, 'the bound tend tool succeeded');
  ok(/Tend RAISED/.test(tendJson.message), 'the tend result says it RAISED an ask');
  // The ask is a tend_request row a human must answer — not an act, not a gate.
  const tendRow = await one(
    `SELECT hook_event_name FROM session_event
      WHERE xell_id=$1 AND hook_event_name='tend-request'
      ORDER BY ts DESC LIMIT 1`, [xellId]);
  eq(tendRow?.hook_event_name, 'tend-request', 'a tend_request event was written (the human-facing ask)');
  // Clear it so the test does not leave a live tend on a throwaway xell.
  await runTool(xell, { name: 'tend', args: { clear: true } });

  // ── E2. HINTS — authorised; each writes ONE session_event (hint-request/clear), no gate/act ──
  console.log('\n── E2. wave 2: a bound hint-land writes a hint-request event, nothing else ──');
  ok(!!LANGCHAIN_TOOLS['hint-land'], '`hint-land` IS in the tool registry (authorised)');
  ok(!!LANGCHAIN_TOOLS['hint-ship'], '`hint-ship` IS in the tool registry (authorised)');
  const hl = JSON.parse(await runTool(xell, { name: 'hint-land', args: { reason: 'looks land-ready' } }));
  eq(hl.ok, true, 'the bound hint-land tool succeeded');
  const hlRow = await one(
    `SELECT hook_event_name FROM session_event
      WHERE xell_id=$1 AND hook_event_name='landhint-request'
      ORDER BY ts DESC LIMIT 1`, [xellId]);
  eq(hlRow?.hook_event_name, 'landhint-request', 'hint-land wrote a landhint-request event (annotates, nothing else)');
  await runTool(xell, { name: 'hint-land', args: { clear: true } });
  const hlClear = await one(
    `SELECT hook_event_name FROM session_event
      WHERE xell_id=$1 AND hook_event_name='landhint-clear'
      ORDER BY ts DESC LIMIT 1`, [xellId]);
  eq(hlClear?.hook_event_name, 'landhint-clear', 'hint-land clear:true wrote the matching clear event');

  // ── F. THE ALLOWLIST, NOT THE CALLER'S ARRAY — an over-wide tools array cannot widen the loop ──
  console.log('\n── F. the loop resolves through the allowlist, not the caller\'s array ──');
  // A (hypothetical) future caller passes the wave-1 list PLUS a forbidden verb. The loop must NOT
  // bind or run it: bindable filters to LANGCHAIN_TOOLS, so the extra verb is refused even when the
  // model asks for it.
  const overWide = [...Object.values(LANGCHAIN_TOOLS), { name: 'run_bash', description: 'forbidden', schema: { type: 'object', properties: {}, required: [] }, run: async () => 'SHOULD NOT RUN' }];
  const owServer = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        // A misbehaving model asks for run_bash (which is in the over-wide array but NOT the allowlist).
        res.end(JSON.stringify({ id: 'ow1', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ow', name: 'run_bash', input: { cmd: 'rm -rf /' } }], model: MODEL, stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${owServer.address().port}`;
  const ow = await runLangchainAgentTurn({
    xell, task: 'try to widen', provider: 'deepseek', model: MODEL,
    apiKey: DEEPSEEK_KEY, xellToken, tools: overWide, maxIterations: 2,
  });
  ok(!ow.executed.some((t) => t.name === 'run_bash'), 'run_bash was NEVER executed even though the caller passed it in the array');
  const owRefusal = ow.messages.some((m) => m._getType() === 'tool' && /not a bindable tool/.test(String(m.content)));
  ok(owRefusal, 'the model\'s run_bash request was REFUSED by the allowlist (not run)');
  await new Promise((r) => owServer.close(r));

  // ── G. LOOP-ENDS-TURN ON TEND — a model calling `tend` ENDS the turn with a visible reason ──
  // (Manager ruling 2026-08-11: a tend means "I am waiting for a human"; the loop is the harness
  // for a langchain zee, so raising a tend ends the turn — the same way a cxell zee ends and waits.
  // The `working` tool itself is the PLAIN shared handler; there is no wrapper/guard on it.)
  console.log('\n── G. loop-ends-turn on tend: a model raising a tend ENDS the turn, visible, no more iterations ──');
  const tendTurn = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        // The model raises a tend (asks for a human) — the loop must END after this, not continue.
        res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_t', name: 'tend', input: { reason: 'a human must decide X before I continue' } }], model: MODEL, stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${tendTurn.address().port}`;
  const ended = await runLangchainAgentTurn({
    xell, task: 'I need a human', provider: 'deepseek', model: MODEL,
    apiKey: DEEPSEEK_KEY, xellToken, maxIterations: 3,
  });
  eq(ended.endedForHuman !== null, true, 'the loop reports it ENDED because a human was asked');
  ok(/Turn ended: a human was asked/.test(ended.text), 'the result is a VISIBLE "ended because a human was asked"');
  ok(/a human must decide X/.test(ended.text), 'the result NAMES the ask');
  eq(ended.iterations, 1, 'the loop ended after ONE iteration (the tend call) — no further iterations');
  eq(ended.capped, false, 'it did NOT hit the cap — it ended for a human, not from spinning');
  // The tend is actually OPEN (the human-facing ask exists).
  const tendOpen = await one(
    `SELECT hook_event_name FROM session_event
      WHERE xell_id=$1 AND hook_event_name='tend-request'
      ORDER BY ts DESC LIMIT 1`, [xellId]);
  eq(tendOpen?.hook_event_name, 'tend-request', 'the tend_request event was written (the ask a human must answer)');
  await runTool(xell, { name: 'tend', args: { clear: true } });   // leave the throwaway xell clean
  await new Promise((r) => tendTurn.close(r));

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
