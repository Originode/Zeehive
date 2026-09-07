// THE MEDIC DRIVER, END TO END — a REAL medic turn through a REAL gatewayProxy to a mock upstream
// (server/src/queenzee/medic-spawn.js; docs/medic-meta-plane-plan.md §2/§4, DR-7/DR-8; kit stage 4).
//
// The langchain-zee test proves the LOOP with the zee registry; this file proves the MEDIC plane's
// whole turn on top of it, the exact wire a dispatched medic uses:
//
//   dispatchMedic → medic row → zee row (medic_id, NO xell) → ChatAnthropic → gateway
//   /x/<medic-token>/deepseek → gatewayProxy (medicForToken — the xell lookup MISSES) → mock
//   upstream, scripted: ① tool_use meta_select → runs on the zeehive_medic ROLE and the result
//   rides back to the model; ② tool_use report(converged); ③ a final text.
//
// Asserted at the end, from the DATABASE (never the driver's own return alone):
//   A. the medic row is 'converged' (the report tool moved it);
//   B. its zee row is medic-keyed (xell_id NULL), idle, stop reason end_turn;
//   C. llm_gateway_request carries the calls with medic_id set and xell_id NULL (247) — the
//      transparency property: a meta-plane loop is exactly as recorded as a caged zee;
//   D. zee_conversation is medic-keyed: the task + the final answer (one user + one assistant);
//   E. medic_action holds the report receipt (owner-pool audit);
//   F. the meta_select RAN on the role: mock call ② carries a tool_result naming the fixture
//      project — the model demonstrably saw real meta-DB data.
//
// RUN:  DATABASE_URL=... PORT=4999 GATEWAY_PORT=4998 CXELL_API_BASE=http://127.0.0.1:4998 \
//         node test/medic-spawn.test.mjs
// Fixture rows are removed in the finally; the Zeehive project row is reused when one exists.
import http from 'node:http';
import { q, one, pool } from '../server/src/db/pool.js';
import { fakeTokens } from './_bin/tokens.mjs';

for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
  delete process.env[k];
}
process.env.MEDICRW_MODE = 'real';   // the sandbox is throwaway; the SQL half must be live

const { gatewayProxy, providerUpstreamUrl } = await import('../server/src/lib/gateway.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 4998);
const DEEPSEEK_KEY = fakeTokens.deepseek();
const MODEL = 'deepseek-chat';
const cleanups = [];
let mockServer = null, gwServer = null;

// The scripted mock upstream: three model calls, each answered by SCRIPT position — the Anthropic
// dialect shapes ChatAnthropic parses (tool_use stops with stop_reason 'tool_use').
const mockRequests = [];
const modelCalls = () => mockRequests.filter((r) => r.url === '/v1/messages');
const SCRIPT = [
  { content: [{ type: 'tool_use', id: 'tu_1', name: 'meta_select',
                input: { sql: `SELECT name FROM project WHERE lower(name)='zeehive'` } }],
    stop_reason: 'tool_use' },
  { content: [{ type: 'tool_use', id: 'tu_2', name: 'report',
                input: { status: 'converged', message: 'the pair proves green' } }],
    stop_reason: 'tool_use' },
  { content: [{ type: 'text', text: 'condition fixed and reported' }], stop_reason: 'end_turn' },
];
function startMockUpstream() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body || '{}'); } catch { /* not json */ }
        mockRequests.push({ url: req.url, body: j });
        if (req.url !== '/v1/messages') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
        const step = SCRIPT[Math.min(modelCalls().length - 1, SCRIPT.length - 1)];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `msg_${modelCalls().length}`, type: 'message', role: 'assistant',
          content: step.content, model: j.model || MODEL, stop_reason: step.stop_reason,
          usage: { input_tokens: 10, output_tokens: 5 } }));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => resolve(mockServer.address().port));
  });
}
function startGateway() {
  return new Promise((resolve, reject) => {
    gwServer = http.createServer((req, res) => {
      if (req.url === '/api/hello') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true,"service":"zeehive-llm-gateway"}');
      }
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

try {
  console.log('\n── setup: mock upstream + gateway + the Zeehive project with a deepseek account ──');
  const mockPort = await startMockUpstream();
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${mockPort}`;
  ok(providerUpstreamUrl('deepseek') === `http://127.0.0.1:${mockPort}`, 'deepseek forwards to the mock');
  await startGateway();

  const zeehive = await one(`SELECT id FROM project WHERE lower(name)='zeehive'`)
    || await one(`INSERT INTO project (name, repo_root) VALUES ('Zeehive', '/work/repo') RETURNING id`);
  const tok = await one(
    `INSERT INTO provider_token (project_id, provider, token, token_hint, label)
     VALUES ($1, 'deepseek', $2, $3, 'medic-spawn-test') RETURNING id`,
    [zeehive.id, DEEPSEEK_KEY, `…${DEEPSEEK_KEY.slice(-4)}`]);
  cleanups.push(() => q(`DELETE FROM provider_token WHERE id=$1`, [tok.id]));
  // The condition sits on a PATIENT project that holds NO provider account — the real dispatch
  // shape (a medic attends someone else's broken project). The gateway must resolve the forward
  // account from the ORCHESTRATOR'S OWN project (resolveUpstream's medic branch): resolving it
  // from the patient made every medic's first model call 502 `cannot forward`, so a dispatched
  // medic errored before its first tool ran (2026-09-06 — "deployed medics do nothing").
  const patient = await one(
    `INSERT INTO project (name, repo_root) VALUES ('medic-spawn-patient', '/tmp/patient') RETURNING id`);
  cleanups.push(() => q(`DELETE FROM project WHERE id=$1`, [patient.id]));
  const cond = await one(
    `INSERT INTO project_condition (project_id, body)
     VALUES ($1, '[test] the pair cannot build — medic-spawn e2e') RETURNING id, project_id, body`, [patient.id]);
  cleanups.push(() => q(`DELETE FROM project_condition WHERE id=$1`, [cond.id]));

  console.log('\n── the whole turn: dispatchMedic --wait against the scripted upstream ──');
  const { dispatchMedic } = await import('../server/src/queenzee/medic-spawn.js');
  const out = await dispatchMedic({ condition: { ...cond, project_name: 'Zeehive' },
                                    provider: 'deepseek', model: MODEL, wait: true });
  ok(out.ok === true && out.plane === 'meta', 'dispatch answered a meta-plane receipt');
  const medicId = out.medic_id;
  cleanups.push(() => q(`DELETE FROM medic WHERE id=$1`, [medicId]));

  console.log('\n── A/B. the rows: medic converged, zee medic-keyed ──');
  const medic = await one(`SELECT * FROM medic WHERE id=$1`, [medicId]);
  ok(medic.status === 'converged', `the report tool moved the medic to converged (got ${medic.status})`);
  const zee = await one(`SELECT * FROM zee WHERE medic_id=$1`, [medicId]);
  ok(!!zee && zee.xell_id === null, 'the zee row is medic-keyed with NO xell');
  ok(zee.status === 'idle' && zee.last_stop_reason === 'end_turn', `the turn ended cleanly (${zee.status}, ${zee.last_stop_reason})`);

  console.log('\n── C. the gateway ledger (247) ──');
  const gw = await q(`SELECT xell_id, medic_id, zee_id FROM llm_gateway_request WHERE medic_id=$1`, [medicId]);
  ok(gw.length === modelCalls().length && gw.length >= 3,
    `every model call is recorded with medic_id (${gw.length} rows, ${modelCalls().length} calls)`);
  ok(gw.every((r) => r.xell_id === null && r.zee_id === zee.id), 'each row: xell_id NULL, attributed to the medic\'s zee');

  console.log('\n── D. the conversation is medic-keyed ──');
  const conv = await q(`SELECT role, content FROM zee_conversation WHERE medic_id=$1 ORDER BY seq`, [medicId]);
  ok(conv.length === 2 && conv[0].role === 'user' && conv[1].role === 'assistant',
    `one user + one assistant persisted (${conv.map((c) => c.role).join(',')})`);
  ok(/condition fixed and reported/.test(conv[1].content), 'the final answer is the durable exchange');

  console.log('\n── E. the audit ledger ──');
  const acts = await q(`SELECT tool, statement FROM medic_action WHERE medic_id=$1 ORDER BY created_at`, [medicId]);
  ok(acts.some((a) => a.tool === 'report' && /the pair proves green/.test(a.statement)),
    'the report landed in medic_action (owner-pool receipt)');

  console.log('\n── F. the meta_select RAN on the role and the model saw real data ──');
  const call2 = modelCalls()[1]?.body || {};
  const toolResults = JSON.stringify(call2.messages || []).toLowerCase();
  ok(/zeehive/.test(toolResults), 'call ② carries a tool_result naming the fixture project');

  console.log('\n── G. the RESUME path (the Bay reply box drives a second turn) ──');
  // A resume mints a SECOND zee row for the same medic: the driver must close the first (245's
  // one_active_zee_per_medic counts 'idle' as active) and mint a fresh claude_session_id (the
  // column is globally unique). Both broke the first live resume, 2026-09-06.
  const { resumeMedic } = await import('../server/src/queenzee/medic-spawn.js');
  const before = modelCalls().length;
  const r = await resumeMedic(medicId, { message: 'a human answers: thanks — confirm and finish', wait: true });
  ok(r.ok === true && r.resumed === true, 'resume answered a receipt');
  ok(modelCalls().length > before, `the answer became a real next turn (${modelCalls().length - before} more model call(s))`);
  const zees = await q(`SELECT status, last_stop_reason FROM zee WHERE medic_id=$1 ORDER BY created_at`, [medicId]);
  ok(zees.length === 2, `one zee row per turn (${zees.length})`);
  ok(zees[0].status === 'stopped', `the first turn's row was closed, not left 'active' (${zees[0].status})`);
  ok(zees[1].status === 'idle' && zees[1].last_stop_reason === 'end_turn',
    `the resume turn ended cleanly (${zees[1].status}, ${zees[1].last_stop_reason})`);
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best-effort teardown */ } }
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = '';
  mockServer?.close(); gwServer?.close();
  const { medicDbPool } = await import('../server/src/lib/medic-role.js');
  await medicDbPool().then((p) => p.end()).catch(() => {});
  await pool.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
