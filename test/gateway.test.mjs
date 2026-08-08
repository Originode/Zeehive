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
//   D. gatewayEnv — the base URLs cxells get, per provider (deepseek → /deepseek, kimi → /kimi,
//      grok → /grok, and NO trailing /v1 on the OpenAI-dialect URLs).
//   D2. providerUpstreamUrl + forward path — one path per provider, NO doubled /v1.
//   E. The WIRING — the index.js gateway mount exists and the proxy is registered.
//   F. usageFromStream — the proxy reads usage from SSE/JSON response text (pure).
//   G2. The read model carries turn attribution — requestsForXell LEFT JOINs zee_turn so the
//      observability panel can group calls under their turn (turn_kind/status/model/etc., null
//      for older rows recorded before turn_id was populated).
//   G. zee/turn linkage — recordRequest resolves the live zee + open turn when zeeId is absent.
//   H. joinUpstreamPath — the proxy's own path join (used by gatewayProxy) stays correct even
//      when the upstream base DOES carry a version segment (an operator-set base with /v1).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { q, one, pool } from '../server/src/db/pool.js';
import { mintXellToken, xellForToken } from '../server/src/lib/xell-token.js';
import { parseGatewayPath, normalizeUsage, gatewayEnv, recordRequest, completeRequest,
         requestsForXell, gatewayHello, usageFromStream, providerUpstreamUrl,
         joinUpstreamPath, zeeTurnForXell } from '../server/src/lib/gateway.js';

// providerUpstreamUrl reads these from the PROCESS env (the queenzee's own operator overrides).
// This test must assert the DEFAULTS, so clear any the caller's shell may have set (e.g. a zee
// cage has ANTHROPIC_BASE_URL pointed at its own dispatch endpoint) — providerUpstreamUrl reads
// them lazily, so clearing now is enough.
for (const k of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'KIMI_CODE_BASE_URL', 'DEEPSEEK_ANTHROPIC_BASE_URL', 'GROK_XAI_API_BASE_URL']) {
  delete process.env[k];
}

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

// ── D. gatewayEnv — the base URLs cxells get ─────────────────────────────────────────────────
console.log('\n── D. gatewayEnv — the base URLs cxells get ──');
const env = gatewayEnv({ xellToken: 'abc123' });
ok(env.ANTHROPIC_BASE_URL.includes('/x/abc123/claude'), 'claude base url carries the xell identity');
ok(env.OPENAI_BASE_URL.includes('/x/abc123/openai'), 'openai base url carries the xell identity');
ok(env.KIMI_MODEL_BASE_URL.includes('/x/abc123/kimi'), 'kimi base url points at the kimi segment (not openai)');
ok(env.GROK_XAI_API_BASE_URL?.includes('/x/abc123/grok'), 'grok base url carries the xell identity');
ok(!env.ANTHROPIC_BASE_URL.includes('/openai'), 'anthropic base url does not point at the openai segment');
const de = gatewayEnv({ xellToken: 'abc123', provider: 'deepseek' });
ok(de.ANTHROPIC_BASE_URL.includes('/x/abc123/deepseek'), 'deepseek base url points at the deepseek segment (not claude)');
ok(de.OPENAI_BASE_URL.includes('/x/abc123/openai') && de.KIMI_MODEL_BASE_URL.includes('/x/abc123/kimi')
  && de.GROK_XAI_API_BASE_URL?.includes('/x/abc123/grok'), 'deepseek env still carries the other providers gateway URLs');
// The path provider segment drives the gateway's ACCOUNT resolution, so it must name the xell's
// ACTUAL provider — a deepseek cxell must not hit /claude (or the gateway uses the claude key).
const denv = gatewayEnv({ xellToken: 'abc123', provider: 'deepseek' });
ok(denv.ANTHROPIC_BASE_URL.includes('/x/abc123/deepseek'), 'a deepseek cxell is pointed at /deepseek, not /claude');
ok(!denv.ANTHROPIC_BASE_URL.includes('/claude'), 'a deepseek zee is never pointed at the claude provider route');
const kenv = gatewayEnv({ xellToken: 'abc123', provider: 'kimi' });
ok(kenv.KIMI_MODEL_BASE_URL.includes('/x/abc123/kimi'), 'a kimi cxell is pointed at /kimi, not /openai');
ok(!kenv.KIMI_MODEL_BASE_URL.includes('/openai'), 'a kimi zee is never pointed at the openai provider route');
const oenv = gatewayEnv({ xellToken: 'abc123', provider: 'openai' });
ok(oenv.OPENAI_BASE_URL.includes('/x/abc123/openai'), 'a codex cxell stays at /openai');
// Dialect composition: OpenAI-compatible CLIs (codex, kimi) carry the /v1 in the BASE and append
// /chat/completions; Anthropic CLIs (claude/deepseek/grok) append /v1/messages to a bare base.
ok(env.OPENAI_BASE_URL.endsWith('/openai/v1'), 'openai base url carries /v1 (codex appends /chat/completions)');
ok(env.KIMI_MODEL_BASE_URL.endsWith('/kimi/v1'), 'kimi base url carries /v1 (kimi appends /chat/completions)');
ok(!env.ANTHROPIC_BASE_URL.endsWith('/v1'), 'claude base url has no /v1 (claude appends /v1/messages)');
ok(!env.GROK_XAI_API_BASE_URL.endsWith('/v1'), 'grok base url has no /v1 (grok appends /v1/messages)');

// ── D2. upstream path composition — one path per provider, no doubled /v1 ─────────────────────
console.log('\n── D2. providerUpstreamUrl + forward path — no doubled /v1 ──');
// The gateway forwards parsed.forward (the CLI's own request path) straight upstream; the upstream
// path is its base pathname + that forward. This is what must NOT double the /v1 the CLI already
// sends (the original bug: openai /v1 + /v1/chat/completions → /v1/v1/chat/completions → 404).
const compose = (provider, fwd) => {
  const target = new URL(providerUpstreamUrl(provider));
  return `${target.pathname === '/' ? '' : target.pathname}${fwd}`;
};
eq(compose('openai', '/v1/chat/completions'), '/v1/chat/completions', 'openai upstream has NO double /v1');
eq(compose('kimi', '/v1/chat/completions'), '/coding/v1/chat/completions', 'kimi upstream path is /coding/v1/chat/completions');
eq(compose('deepseek', '/v1/messages'), '/anthropic/v1/messages', 'deepseek upstream keeps its /anthropic base');
eq(compose('claude', '/v1/messages'), '/v1/messages', 'claude upstream is the plain /v1/messages');
// grok is the exception to the /v1 strip: its CLI appends /responses DIRECTLY to the base (no
// version in the forward path), so the upstream KEEPS its own /v1 → https://api.x.ai/v1/responses.
eq(compose('grok', '/responses'), '/v1/responses', 'grok upstream keeps its /v1 (the CLI appends /responses bare)');
ok(providerUpstreamUrl('grok').includes('api.x.ai'), 'grok upstream resolves to xAI (not the anthropic default)');
// The claude provider's upstream is api.anthropic.com regardless of the SERVER's own
// ANTHROPIC_BASE_URL (which may legitimately point at deepseek, as this very cage's does).
ok(!providerUpstreamUrl('claude').includes('deepseek'), 'claude upstream is never the deepseek URL');
// And parseGatewayPath pairs with the gateway base URLs from D: the CLI's request against the
// gateway base URL must parse to the CLI path that compose consumes. OpenAI-style CLIs append
// /chat/completions to a /v1-carrying base; Anthropic-style append /v1/messages to a bare base.
const pair = (base, cliPath) => parseGatewayPath(new URL(base).pathname + cliPath);
eq(pair(env.OPENAI_BASE_URL, '/chat/completions')?.provider, 'openai', 'openai request resolves provider from the path');
eq(pair(env.OPENAI_BASE_URL, '/chat/completions')?.forward, '/v1/chat/completions', 'openai request forward is the CLI path');
eq(pair(env.KIMI_MODEL_BASE_URL, '/chat/completions')?.provider, 'kimi', 'kimi request resolves to the kimi provider');
eq(pair(env.KIMI_MODEL_BASE_URL, '/chat/completions')?.forward, '/v1/chat/completions', 'kimi request forward is the CLI path');
eq(pair(env.GROK_XAI_API_BASE_URL, '/responses')?.provider, 'grok', 'grok request resolves to the grok provider');
eq(pair(de.ANTHROPIC_BASE_URL, '/v1/messages')?.provider, 'deepseek', 'deepseek request resolves to the deepseek provider');
eq(pair(env.ANTHROPIC_BASE_URL, '/v1/messages')?.provider, 'claude', 'claude request resolves to the claude provider');

// ── H. joinUpstreamPath — the proxy's own path join must not double the version segment ─────
console.log('\n── H. joinUpstreamPath — upstream base + CLI forward path ──');
// providerUpstreamUrl already strips a trailing /v1 (main), so joinUpstreamPath usually sees a
// bare upstream path. It is ALSO correct when the base DOES carry a version segment (an
// operator-set OPENAI_BASE_URL that includes /v1): the duplicate is dropped, not doubled.
// claude: upstream has no base path; the forward /v1/messages passes through untouched.
eq(joinUpstreamPath('https://api.anthropic.com', '/v1/messages?beta=true'), '/v1/messages?beta=true', 'claude: no base path, forward passes through');
// deepseek: upstream base /anthropic is a prefix, not a version overlap; keep both.
eq(joinUpstreamPath('https://api.deepseek.com/anthropic', '/v1/messages'), '/anthropic/v1/messages', 'deepseek: base prefix kept, forward appended');
// openai: upstream base ALREADY ends in /v1 and the forward starts with /v1 — must NOT double.
eq(joinUpstreamPath('https://api.openai.com/v1', '/v1/chat/completions'), '/v1/chat/completions', 'openai: /v1 NOT doubled');
// kimi: upstream base /coding/v1 ends in /v1 too — the forward must lose its /v1.
eq(joinUpstreamPath('https://api.kimi.com/coding/v1', '/v1/chat/completions'), '/coding/v1/chat/completions', 'kimi: /coding/v1 kept, duplicate /v1 dropped');
// an operator-set openai base WITHOUT /v1 still works (no overlap to drop).
eq(joinUpstreamPath('https://api.openai.com', '/v1/chat/completions'), '/v1/chat/completions', 'openai base without /v1 → forward intact');
// the forward path still carries its query string through every join.
eq(joinUpstreamPath('https://api.openai.com/v1', '/v1/chat/completions?model=x'), '/v1/chat/completions?model=x', 'query string survives the overlap drop');

// ── E. the wiring ────────────────────────────────────────────────────────────────────────────
console.log('\n── E. the gateway is wired ──');
const index = readFileSync('server/src/index.js', 'utf8');
ok(/gatewayApp\.all\('\/x\/\*', gatewayProxy\)/.test(index), 'the gateway proxies /x/*');
ok(/gatewayApp\.(get|head)\('\/api\/hello'/.test(index), 'the hello probe is answered');
const gw = readFileSync('server/src/lib/gateway.js', 'utf8');
ok(/xellForToken\(parsed\.xellToken\)/.test(gw), 'the proxy resolves the xell from the path token');

// ── F. usageFromStream — the proxy reads usage from the response text ───────────────────────
console.log('\n── F. usageFromStream — the stream usage parser ──');
const antStream = 'event: message_start\ndata: {"type":"message_start","message":{}}\n\n'
  + 'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":5}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const antUsage = usageFromStream(antStream, 'messages');
eq(antUsage?.input_tokens, 10, 'anthropic SSE: input tokens from message_delta');
eq(antUsage?.output_tokens, 5, 'anthropic SSE: output tokens from message_delta');
// The event NAME (m[1]) must NOT be parsed as JSON — this is the bug that silently dropped usage.
ok(antUsage !== null, 'anthropic SSE usage is captured (the m[1] vs m[2] regression)');
const nonStream = JSON.stringify({ id: 'x', type: 'message', usage: { input_tokens: 3, output_tokens: 2 } });
eq(usageFromStream(nonStream, 'messages')?.input_tokens, 3, 'anthropic non-streaming JSON body usage');
eq(usageFromStream('event: message_stop\ndata: {"type":"message_stop"}\n\n', 'messages'), null, 'no usage event → null');
const oaiStream = 'data: {"choices":[]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
eq(usageFromStream(oaiStream, 'chat-completions')?.prompt_tokens, 7, 'openai SSE: prompt tokens');
eq(usageFromStream(oaiStream, 'chat-completions')?.completion_tokens, 3, 'openai SSE: completion tokens');
ok(usageFromStream('', 'messages') === null, 'empty text → null');
ok(usageFromStream(null, 'messages') === null, 'null text → null');
// A split event (TCP segmentation): the proxy keeps a bounded tail and parses tail+chunk, so the
// concatenated text must recover usage that each fragment alone cannot.
const frag1 = 'event: message_delta\ndata: {"type":"message_de';
const frag2 = 'lta","usage":{"input_tokens":10,"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
eq(usageFromStream(frag1, 'messages'), null, 'a partial event alone → null');
eq(usageFromStream(frag2, 'messages'), null, 'the completing fragment alone has no event header → null');
eq(usageFromStream(frag1 + frag2, 'messages')?.input_tokens, 10, 'concatenated split event → usage recovered');

// ── C. the round-trip ────────────────────────────────────────────────────────────────────────
console.log('\n── C. record → complete → read ──');
let projectId = null, xourceId = null, xellId = null, zeeId = null, rid = null, autoRid = null;
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

  // ── G. zee/turn linkage — a request is attributed to the live zee + open turn ──────────────
  console.log('\n── G. zee/turn linkage — zee_id + turn_id at record time ──');
  // The zee created above is status='idle'. Per one_active_zee_per_xell (at most one zee in
  // spawning/online/working/idle per xell), an idle zee IS the xell's active zee — an interactive
  // TUI in a hook-less cage keeps the zee idle and must still be attributed. So zeeTurnForXell
  // resolves the zee, but with no open turn yet the turn_id stays null (xell/zee-only record).
  const none = await zeeTurnForXell(xellId);
  eq(none.zeeId, zeeId, 'an idle zee is the xell\'s active zee — zee_id resolves');
  eq(none.turnId, null, 'no open turn yet — turn_id stays null (xell/zee-only record)');
  // A working zee + an open turn (status='started') → both resolved.
  const live = await one(`UPDATE zee SET status='working' WHERE id=$1 RETURNING id`, [zeeId]);
  ok(!!live?.id, 'the zee is now live (working)');
  const tr = await one(
    `INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, status, model)
     VALUES ($1,$2,$3,'spawn','started','opus') RETURNING id`, [zeeId, xellId, projectId]);
  const linked = await zeeTurnForXell(xellId);
  eq(linked.zeeId, zeeId, 'the live zee is resolved from the xell');
  eq(linked.turnId, tr.id, 'the open turn is resolved from the live zee');
  // recordRequest WITHOUT a zeeId looks it up — the row carries zee_id + turn_id.
  autoRid = await recordRequest({
    xell: resolved, kind: 'messages', provider: 'claude', model: 'opus',
    method: 'POST', path: '/v1/messages',
  });
  ok(!!autoRid, 'recordRequest without a zeeId still returns an id');
  const autoRow = await one(`SELECT zee_id, turn_id FROM llm_gateway_request WHERE id=$1`, [autoRid]);
  eq(autoRow?.zee_id, zeeId, 'the auto-recorded request carries zee_id');
  eq(autoRow?.turn_id, tr.id, 'the auto-recorded request carries turn_id');

  // ── G2. the read model carries turn attribution (requestsForXell LEFT JOIN zee_turn) ─────────
  console.log('\n── G2. read model turn attribution — turn_* columns on requestsForXell ──');
  const withTurn = (await requestsForXell(xellId)).find((r) => r.id === autoRid);
  eq(withTurn?.turn_id, tr.id, 'attributed row carries turn_id');
  eq(withTurn?.turn_kind, 'spawn', 'attributed row carries turn_kind');
  eq(withTurn?.turn_status, 'started', 'attributed row carries turn_status');
  eq(withTurn?.turn_model, 'opus', 'attributed row carries turn_model');
  eq(withTurn?.zee_name, null, 'attributed row carries zee_name (this zee has no name)');
  const noTurn = (await requestsForXell(xellId)).find((r) => r.id === rid);
  eq(noTurn?.turn_id, null, 'un-attributed request has null turn_id');
  eq(noTurn?.turn_kind, null, 'un-attributed request has null turn_kind (degrades)');
  eq(noTurn?.turn_status, null, 'un-attributed request has null turn_status (degrades)');

  console.log(`\n${fail ? fail + ' FAILED' : 'all good'}`);
} finally {
  if (rid) await q(`DELETE FROM llm_gateway_request WHERE id=$1`, [rid]).catch(() => {});
  if (autoRid) await q(`DELETE FROM llm_gateway_request WHERE id=$1`, [autoRid]).catch(() => {});
  if (zeeId) await q(`DELETE FROM zee WHERE id=$1`, [zeeId]).catch(() => {});
  if (xellId) await q(`DELETE FROM xell WHERE id=$1`, [xellId]).catch(() => {});
  if (xourceId) await q(`DELETE FROM xource WHERE id=$1`, [xourceId]).catch(() => {});
  if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  await pool.end();
}
process.exit(fail ? 1 : 0);
