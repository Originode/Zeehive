// LLM GATEWAY — the transparent LiteLLM-style door every cxell CLI points its base URL at
// (server/src/lib/gateway.js, migration 154, GET /xells/:id/gateway-requests).
//
// The queenzee sits in the middle of every AI call: the CLI sends its request to the gateway
// path /x/<xellToken>/<provider>/v1/... and the gateway records it at the transport layer,
// attributed to the xell by the token in the PATH (not by parsing the bearer). This is what
// makes observability complete — the post-hoc CLI-output parser cannot see interactive turns,
// but every HTTP request crosses the gateway.
//
// What this file covers (all against DATABASE_URL, torn down in a finally — house rule 1):
//   A. parseGatewayPath — the identity/provider from the gateway path (pure).
//   B. normalizeUsage — Anthropic vs OpenAI usage shapes (pure).
//   C. The record → complete → read round-trip (like the proxy does per request).
//   D. gatewayEnv — the base URLs cxells get.
//   E. The WIRING — the index.js gateway mount exists and the proxy is registered.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { mintXellToken, xellForToken } from '../server/src/lib/xell-token.js';
import { parseGatewayPath, normalizeUsage, gatewayEnv, recordRequest, completeRequest,
         requestsForXell, gatewayHello } from '../server/src/lib/gateway.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── A. parseGatewayPath ──────────────────────────────────────────────────────────────────────
console.log('\n── A. parseGatewayPath — identity from the path ──');
const p = parseGatewayPath('/x/token123/claude/v1/messages?beta=true');
eq(p?.xellToken, 'token123', 'the xell token is in the path');
eq(p?.provider, 'claude', 'the provider is in the path');
eq(p?.forward, '/v1/messages?beta=true', 'the forward path strips the prefix');
ok(parseGatewayPath('/x/tok/deepseek/v1/messages')?.provider === 'deepseek', 'deepseek provider resolves');
ok(parseGatewayPath('/v1/messages') === null, 'a bare path (no /x/...) is not a gateway path');
ok(parseGatewayPath('/api/hello') === null, 'the unprefixed hello probe is not a gateway path');

// ── B. normalizeUsage ────────────────────────────────────────────────────────────────────────
console.log('\n── B. normalizeUsage — the two dialects ──');
const a = normalizeUsage({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 }, 'messages');
eq(a.input, 100, 'anthropic input'); eq(a.output, 50, 'anthropic output');
eq(a.cacheRead, 20, 'anthropic cache read'); eq(a.cacheWrite, 5, 'anthropic cache write');
const o = normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 }, 'chat-completions');
eq(o.input, 100, 'openai prompt'); eq(o.output, 50, 'openai completion');
eq(o.cacheRead, 0, 'openai has no cache read'); eq(o.cacheWrite, 0, 'openai has no cache write');

// ── D. gatewayEnv ────────────────────────────────────────────────────────────────────────────
console.log('\n── D. gatewayEnv — the base URLs cxells get ──');
const env = gatewayEnv({ xellToken: 'abc123' });
ok(env.ANTHROPIC_BASE_URL.includes('/x/abc123/claude'), 'claude base url carries the xell identity');
ok(env.OPENAI_BASE_URL.includes('/x/abc123/openai'), 'openai base url carries the xell identity');
ok(env.KIMI_MODEL_BASE_URL.includes('/x/abc123/openai'), 'kimi base url points at the openai dialect');

// ── E. the wiring ────────────────────────────────────────────────────────────────────────────
console.log('\n── E. the gateway is wired ──');
const index = readFileSync('server/src/index.js', 'utf8');
ok(/gatewayApp\.all\('\/x\/\*', gatewayProxy\)/.test(index), 'the gateway proxies /x/*');
ok(/gatewayApp\.(get|head)\('\/api\/hello'/.test(index), 'the hello probe is answered');
const gw = readFileSync('server/src/lib/gateway.js', 'utf8');
ok(/xellForToken\(parsed\.xellToken\)/.test(gw), 'the proxy resolves the xell from the path token');

// ── C. the round-trip ────────────────────────────────────────────────────────────────────────
console.log('\n── C. record → complete → read ──');
let projectId = null, xourceId = null, xellId = null, zeeId = null, rid = null;
try {
  const name = 'gateway-' + randomUUID().slice(0, 8);
  const proj = await one(`INSERT INTO project (name, repo_root) VALUES ($1, $2) RETURNING id`, [name, `/tmp/${name}`]);
  projectId = proj.id;
  const xo = await one(`INSERT INTO xource (project_id, ref) VALUES ($1, 'refs/heads/main') RETURNING id`, [projectId]);
  xourceId = xo.id;
  const xl = await one(`INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status)
    VALUES ($1, $2, $3, $4, $5, 'claimed') RETURNING id`,
    [projectId, xourceId, name, `spinoff/${name}`, `/tmp/${name}-wt`]);
  xellId = xl.id;
  const z = await one(`INSERT INTO zee (xell_id, attach_mode, viewer_kind, status, kind, entrypoint, model)
    VALUES ($1, 'headless-spawn', 'none', 'idle', 'headless', 'cxell-cli', 'opus') RETURNING id`, [xellId]);
  zeeId = z.id;

  const token = await mintXellToken(xellId);
  const resolved = await xellForToken(token);
  ok(resolved?.id === xellId, 'the minted token resolves to the xell (what the gateway uses)');

  rid = await recordRequest({
    xell: resolved, zeeId, turnId: null, kind: 'messages', provider: 'deepseek',
    model: 'deepseek-chat', method: 'POST', path: '/v1/messages?beta=true',
  });
  ok(!!rid, 'recordRequest returns an id');
  await completeRequest(rid, { status: 200, input: 6, output: 9, cacheRead: 0, cacheWrite: 0, durationMs: 1200, cost: 0 });
  const rows = await requestsForXell(xellId);
  eq(rows.length, 1, 'requestsForXell finds the request');
  eq(rows[0]?.provider, 'deepseek', 'provider is recorded');
  eq(rows[0]?.model, 'deepseek-chat', 'model is recorded');
  eq(Number(rows[0]?.total_tokens), 15, 'total tokens = input + output');
  eq(rows[0]?.status, 200, 'status is recorded');

  // gatewayHello answers 200 (the CLI probe)
  const helloRes = { statusCode: 0, json: (b) => { helloRes.body = b; }, status: (c) => { helloRes.statusCode = c; return helloRes; } };
  gatewayHello(null, helloRes);
  ok(helloRes.statusCode === 200 && helloRes.body?.ok === true, 'the hello probe answers 200');

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  if (rid) await q(`DELETE FROM llm_gateway_request WHERE id=$1`, [rid]).catch(() => {});
  if (zeeId) await q(`DELETE FROM zee WHERE id=$1`, [zeeId]).catch(() => {});
  if (xellId) await q(`DELETE FROM xell WHERE id=$1`, [xellId]).catch(() => {});
  if (xourceId) await q(`DELETE FROM xource WHERE id=$1`, [xourceId]).catch(() => {});
  if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  await pool.end();
}
process.exit(fail ? 1 : 0);
