// THE QUEENZEE AS A TRANSPARENT LLM GATEWAY (LiteLLM-style).
//
// Every cxell CLI points its base URL at the queenzee (ANTHROPIC_BASE_URL / OPENAI_BASE_URL /
// KIMI_MODEL_BASE_URL → this gateway's host:port). Every AI call — a spawn, a resume, or an
// interactive TUI turn — therefore crosses ONE door the queenzee owns, and the gateway records
// it at the transport layer BEFORE it reaches the provider. This is what makes the per-xell
// observability complete: the post-hoc CLI-output parser structurally cannot see interactive
// turns (their stdout never reaches the queenzee), but a gateway sees every HTTP request.
//
// WIRE SHAPE. The CLIs speak two dialects:
//   /v1/messages          (Anthropic-compatible — claude + deepseek, and codex's --json)
//   /v1/chat/completions  (OpenAI-compatible — codex, kimi)
// Both are JSON POSTs; responses stream as text/event-stream (SSE). The gateway proxies the
// stream without buffering (same discipline as webapp-proxy.js) and reads the UPSTREAM's own
// authoritative usage from the final event of the stream — not a parsed CLI line format.
//
// AUTHENTICATION IS IDENTITY, NOT PARSING. The cxell already carries ZEEHIVE_XELL_TOKEN
// (lib/xell-token.js) and sends it as `Authorization: Bearer <token>` on every /api/xell/self/*
// call. The gateway requires the SAME header, resolves it to a xell via xellForToken, and uses
// that xell's project to pick the provider credential (tokenForSpawn — the same resolution the
// spawn path uses). So the gateway knows WHICH xell made every call without parsing a session id.
//
// CREDENTIAL FORWARDING. The caller's token is the XELL identity token, NOT the provider key.
// The gateway reads the provider key from the meta-DB (provider_token rows, per project + per
// account) and forwards it upstream. The provider never sees the xell token; the xell never
// handles the provider key over the wire (it is already in the cage env, but the gateway path is
// the single door). This mirrors the existing credential model exactly — provider-tokens.js.
//
// STREAMING + SSE. Responses are text/event-stream. The gateway must:
//   1. forward the SSE headers + stream the body without buffering (webapp-proxy discipline);
//   2. intercept the FINAL event of the stream to read usage (for messages, the last
//      message_delta / message_stop event carries usage; for chat completions, the data:
//      [DONE] event or the last chunk carries usage).
// Because we cannot read the provider's usage until the stream completes, the row is written
// with the request facts first (model, xell, turn, requested_at), then UPDATED with usage +
// cost + duration when the stream finishes (or errors).
//
// COST. The upstream's usage object is authoritative for tokens. Cost is derived per provider
// from the model's price in ai_model_spec (the same table the dispatch picker reads); when the
// upstream also reports cost (Anthropic's total_cost_usd), that is used instead. A model with no
// known price records cost 0 + a meta note (never a wrong estimate).
//
// BEST-EFFORT, NEVER THROWS — the same contract as Langfuse ingestion: a recording failure must
// not fail the AI call the human is waiting on. Every write is awaited but catch-guarded, and
// the proxy itself is the only thing that can fail the request (a dead provider is a 502).
import http from 'node:http';
import https from 'node:https';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { config } from '../config.js';
import { xellForToken } from './xell-token.js';
import { tokenForSpawn, PROVIDERS } from './provider-tokens.js';

// The gateway's own port. The queenzee API stays on PORT; the gateway is a SEPARATE listener so
// it can never shadow API routes (/v1/messages is not an API route, but keeping the two doors
// apart is the same reasoning as the webapp proxy mount).
export const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 4701);

// The gateway base URL cxells should point their provider base-urls at. From inside a cxell the
// queenzee is at CXELL_API_BASE's host (host.docker.internal, or the service name on the compose
// network); the gateway is the same host, one port over. Overridable so a test/dev cage can point
// at any gateway.
export function gatewayBaseUrl() {
  const api = process.env.CXELL_API_BASE || 'http://host.docker.internal:4700';
  const host = api.replace(/:\d+$/, '');          // strip the API port
  const port = Number(process.env.GATEWAY_PORT || 4701);
  return `${host}:${port}`;
}

// ── token→usage→cost ──────────────────────────────────────────────────────────────────────────

// The OpenAI-compatible usage shape { prompt_tokens, completion_tokens, total_tokens } vs the
// Anthropic shape { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }.
// Returns a NORMALIZED { input, output, cacheRead, cacheWrite } + the upstream's raw usage.
export function normalizeUsage(usage = {}, kind = 'messages') {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (kind === 'chat-completions') {
    return {
      input: Number(usage.prompt_tokens || 0) || 0,
      output: Number(usage.completion_tokens || 0) || 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  }
  return {
    input: Number(usage.input_tokens || 0) || 0,
    output: Number(usage.output_tokens || 0) || 0,
    cacheRead: Number(usage.cache_read_input_tokens || 0) || 0,
    cacheWrite: Number(usage.cache_creation_input_tokens || 0) || 0,
  };
}

// Extract the upstream's usage object from a response STREAM chunk (SSE) or a single JSON body.
// Returns the raw upstream usage (the shape normalizeUsage understands) or null when the text
// carries none. `kind` = 'messages' (Anthropic dialect) | 'chat-completions' (OpenAI dialect).
//
// Two dialect shapes:
//   Anthropic SSE: `event: message_delta\ndata: {"type":"message_delta","usage":{...}}` — usage
//     rides the final message_delta (or a non-streaming single `message` object with inline usage).
//   OpenAI SSE: `data: {"choices":[],"usage":{...}}` — usage rides the last chunk before [DONE]
//     when the request set stream_options.include_usage.
// Pure so the proxy's parsing is testable without an upstream (test/gateway.test.mjs).
export function usageFromStream(text = '', kind = 'messages') {
  if (!text) return null;
  if (kind === 'chat-completions') {
    for (const m of text.matchAll(/data: (\{.*\})/g)) {
      try { const j = JSON.parse(m[1]); if (j.usage) return j.usage; } catch { /* partial */ }
    }
    return null;
  }
  // Anthropic dialect: the JSON is the SECOND capture group (the first is the event NAME — parsing
  // the name was the original bug that silently dropped every stream's usage).
  for (const m of text.matchAll(/event: (\w+)\n?data: (\{.*\})/g)) {
    try {
      const j = JSON.parse(m[2]);
      if (j.type === 'message_delta' && j.usage) return j.usage;
      if (j.type === 'message' && j.usage) return j.usage;
    } catch { /* partial event at a chunk boundary — the next chunk carries the rest */ }
  }
  // A non-SSE JSON body (a single message response).
  if (!text.includes('event:') && !text.includes('data: {')) {
    try { const j = JSON.parse(text); if (j.usage) return j.usage; } catch { /* not JSON or partial */ }
  }
  return null;
}

// Look up a model's $/1M input + output price from ai_model_spec. Returns null when unknown.
export async function modelPrice(provider, model) {
  if (!provider || !model) return null;
  const spec = await one(
    `SELECT key, label FROM ai_model_spec WHERE provider=$1 AND key=$2 AND enabled`, [provider, model])
    .catch(() => null);
  // ai_model_spec carries no price columns today (context_window/max_output only); the price
  // table is a future migration. Until then, cost is recorded as 0 + a meta flag rather than an
  // invented figure — the upstream's own total_cost_usd is used when the provider reports one.
  if (!spec) return null;
  return { found: true, key: spec.key, label: spec.label, price: null };
}

// Derive cost in USD from usage. When the upstream reported a cost (Anthropic total_cost_usd),
// use it. Otherwise 0 until per-model prices land (never a wrong estimate).
export function costOf({ upstreamCost = null, price = null, usage = null } = {}) {
  if (upstreamCost != null) return Number(upstreamCost) || 0;
  return 0;
}

// ── the recorder ──────────────────────────────────────────────────────────────────────────────

// Best-effort: find the LIVE zee for a xell and its OPEN turn, so a gateway request can be
// attributed to the zee/turn that produced it. The xell token in the path gives the xell; the
// live zee is the one whose status is NOT idle/errored (a spawned/resumed zee is 'working' while
// it runs; an interactive pane is often 'idle' and records xell-only); the open turn is the most
// recent zee_turn with status='started'. Either may be absent — a request with no live zee or no
// open turn records xell-only and NEVER fails the AI call. Returns { zeeId, turnId } (both null on
// a lookup failure).
export async function zeeTurnForXell(xellId) {
  try {
    if (!xellId) return { zeeId: null, turnId: null };
    const zee = await one(
      `SELECT id FROM zee WHERE xell_id=$1 AND status NOT IN ('idle','errored')
        ORDER BY created_at DESC LIMIT 1`, [xellId]);
    if (!zee) return { zeeId: null, turnId: null };
    const turn = await one(
      `SELECT id FROM zee_turn WHERE zee_id=$1 AND status='started'
        ORDER BY started_at DESC LIMIT 1`, [zee.id]);
    return { zeeId: zee.id, turnId: turn?.id || null };
  } catch (e) {
    logline('gateway', `zeeTurnForXell failed (${String(e.message).slice(0, 120)})`);
    return { zeeId: null, turnId: null };
  }
}

// Insert one gateway request row. Returns the row id (for the completion UPDATE) or null.
// EXPORTED for the test — the proxy is the only production caller, but the round-trip (record →
// complete → read) is exactly what test/gateway.test.mjs must prove.
// When zeeId is not supplied, the live zee + open turn for the xell are looked up (best-effort)
// so the ledger attributes every request to the zee/turn that made it.
export async function recordRequest({ xell, zeeId = null, turnId = null, kind, provider, model,
                                     method, path, sessionId = null }) {
  try {
    if (!zeeId) {
      const live = await zeeTurnForXell(xell?.id);
      zeeId = live.zeeId;
      turnId = live.turnId;
    }
    const row = await one(
      `INSERT INTO llm_gateway_request
         (xell_id, zee_id, turn_id, project_id, kind, provider, model, method, path, session_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING id`,
      [xell?.id || null, zeeId || null, turnId || null, xell?.project_id || null,
       kind, provider || null, model || null, method || 'POST', path || '',
       sessionId || null, JSON.stringify({})]);
    return row?.id || null;
  } catch (e) {
    logline('gateway', `could not record a gateway request (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

// Complete a recorded request with the upstream's verdict. Never throws. Exported for the test.
export async function completeRequest(rowId, fields) {
  if (!rowId) return;
  try {
    await one(
      `UPDATE llm_gateway_request
          SET status=$2, input_tokens=$3, output_tokens=$4, cache_read_tokens=$5,
              cache_write_tokens=$6, total_tokens=$7, cost_usd=$8, duration_ms=$9,
              error=$10, completed_at=now()
        WHERE id=$1`,
      [rowId, fields.status ?? null,
       fields.input || 0, fields.output || 0, fields.cacheRead || 0, fields.cacheWrite || 0,
       (fields.input || 0) + (fields.output || 0) + (fields.cacheRead || 0) + (fields.cacheWrite || 0),
       fields.cost ?? 0, fields.durationMs ?? null, fields.error ?? null]);
  } catch (e) {
    logline('gateway', `could not complete gateway request ${String(rowId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
  }
}

// ── the proxy ─────────────────────────────────────────────────────────────────────────────────

// The CLI's connectivity PROBE. claude sends `HEAD <base>/api/hello` to a custom ANTHROPIC_BASE_URL
// before the first POST (measured: claude 2.1.222 does this with no auth header). Because the base
// URL is path-prefixed (/x/<token>/<provider>), the probe arrives at /x/<token>/<provider>/api/hello
// and lands on the gatewayProxy route. It is answered HERE, by the gateway itself (a connectivity
// check needs no provider round-trip and must not be recorded as an LLM call). The caller strips
// the /x/<token>/<provider> prefix before calling.
export function gatewayHello(_req, res) {
  return res.status(200).json({ ok: true, service: 'zeehive-llm-gateway' });
}

// Resolve the upstream for a request: which provider URL + credential. `path` is the gateway
// path (/v1/messages or /v1/chat/completions). Returns { provider, upstreamUrl, token, kind }
// or null when the caller is not a known xell / the project has no account for the provider.
async function resolveUpstream(xell, kind, providerKey) {
  // The provider comes from the PATH (/x/<token>/<provider>/...) — the gateway's own URL, so it is
  // authoritative. claude + deepseek + grok speak the Anthropic dialect (/v1/messages); openai +
  // kimi the OpenAI dialect (/v1/chat/completions). A provider with no dispatch runtime is refused.
  const p = PROVIDERS[providerKey];
  if (!p || !p.dispatch) return null;
  const acct = await tokenForSpawn(xell.project_id, p.key).catch(() => null);
  if (!acct) {
    logline('gateway', `xell ${xell.slug}: no ${p.label} account — refusing to forward`);
    return null;
  }
  // The upstream URL per provider (the same base the adapter would have used directly).
  const upstreamUrl = providerUpstreamUrl(p.key);
  return { provider: p.key, upstreamUrl, token: acct.token, kind };
}

// The provider's real API base, by provider key — the value the cxell adapters inject today.
//
// The upstream URL deliberately carries NO trailing `/v1` for the OpenAI-compatible providers
// (openai, kimi, grok). The gateway forwards `parsed.forward` — the CLI's own request path
// (`/v1/chat/completions` or `/v1/messages`) — straight on to the upstream, so the upstream's
// own `/v1` would DOUBLE (openai `/v1` + forward `/v1/chat/completions` → `/v1/v1/chat/completions`,
// a 404). Stripping it here restores the real endpoint: `https://api.openai.com/v1/chat/completions`
// and `https://api.kimi.com/coding/v1/chat/completions` (the `/coding` prefix is kept — the CLI's
// path does not carry it). claude + deepseek send `/v1/messages` and their upstream base has no
// `/v1` to double.
function stripTrailingV1(u) {
  return String(u || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

export function providerUpstreamUrl(provider) {
  switch (provider) {
    case 'openai': return stripTrailingV1(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
    case 'kimi': return stripTrailingV1(process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1');
    case 'deepseek': return process.env.DEEPSEEK_ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
    case 'grok': return stripTrailingV1(process.env.XAI_BASE_URL || 'https://api.x.ai/v1');
    default: return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  }
}

// Proxy one gateway request: authenticate the caller, resolve the upstream, forward, stream the
// response, and record the request + the upstream's usage. This is the express middleware for
// /v1/messages and /v1/chat/completions (mounted on the gateway's OWN http listener).
export async function gatewayProxy(req, res) {
  const t0 = Date.now();
  // ── identity + provider FROM THE PATH ──
  // The CLI is pointed at /x/<xellToken>/<provider>/... so the identity travels in the URL, not in
  // the bearer (which stays the provider key). Resolve the xell from the token in the path.
  const parsed = parseGatewayPath(req.url);
  logline('gateway', `gatewayProxy hit: ${req.method} ${req.url} → parsed=${parsed ? JSON.stringify(parsed) : 'null'}`);
  if (!parsed) {
    return res.status(404).json({ error: 'gateway: path must be /x/<xell-token>/<provider>/v1/…' });
  }
  // The CLI's connectivity probe — answer 200 locally, never forward it to the provider.
  if (parsed.forward === '/api/hello' || parsed.forward.startsWith('/api/hello')) {
    logline('gateway', `hello probe answered for ${parsed.provider} (${req.method})`);
    return res.status(200).json({ ok: true, service: 'zeehive-llm-gateway' });
  }
  const xell = await xellForToken(parsed.xellToken).catch(() => null);
  if (!xell) {
    return res.status(401).json({ error: 'gateway: unknown xell identity (the token in the path does not match a live xell)' });
  }
  // Which dialect is the forward path? /v1/messages → Anthropic, /v1/chat/completions → OpenAI.
  const kind = parsed.forward.startsWith('/v1/chat/completions') ? 'chat-completions' : 'messages';

  const upstream = await resolveUpstream(xell, kind, parsed.provider).catch(() => null);
  if (!upstream) {
    return res.status(502).json({ error: `gateway: cannot forward for xell ${xell.slug} (provider ${parsed.provider})` });
  }

  // ── record the request fact ──
  const rowId = await recordRequest({
    xell, kind, provider: upstream.provider, model: modelFromBody(req.body),
    method: req.method, path: parsed.forward,
  });

  // ── forward ──
  const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
  const headers = { ...req.headers };
  for (const h of hopByHop) delete headers[h];
  // The upstream credential: the provider key from the meta-DB. The provider never sees the xell
  // identity token (it is in the path, not the auth header); the xell never handles the provider
  // key over the wire beyond what it already holds in its cage env.
  headers.authorization = `Bearer ${upstream.token}`;
  headers.host = new URL(upstream.upstreamUrl).host;
  // The body is already parsed (express.json); forward it as a string with an explicit
  // content-length. Piping req (a chunked stream) to an https request without content-length is
  // what made the upstream hang up. The AI request body is JSON text; reserialize it.
  const body = typeof req.body === 'string' ? req.body : (req.body ? JSON.stringify(req.body) : '');
  headers['content-length'] = Buffer.byteLength(body);
  logline('gateway', `forward ${req.method} ${parsed.forward} → ${upstream.upstreamUrl} (body ${Buffer.byteLength(body)}B, provider ${upstream.provider})`);

  const target = new URL(upstream.upstreamUrl);
  const transporter = target.protocol === 'https:' ? https : http;
  // The upstream URL may carry a base PATH (deepseek's api.deepseek.com/anthropic). The forward
  // path is the upstream's pathname + the CLI's path (which already carries ?query).
  const forwardPath = `${target.pathname === '/' ? '' : target.pathname}${parsed.forward}`;
  const proxyReq = transporter.request({
    hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method, headers, path: forwardPath,
  }, (proxyRes) => {
    // Stream the response through. For SSE, this must be unbuffered.
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
    // Read the upstream's final usage from the stream for the completion UPDATE. A bounded tail is
    // kept across chunks so an SSE event SPLIT by a TCP segment (event header in one chunk, the
    // rest in the next) is still parsed — per-chunk parsing alone silently misses a split usage
    // event and records 0 tokens (verified with a fragmenting mock upstream).
    let usage = null;
    let sseTail = '';
    proxyRes.on('data', (chunk) => {
      const text = sseTail + chunk.toString();
      sseTail = text.slice(-4096);
      const u = usageFromStream(text, upstream.kind);
      if (u) usage = u;
    });
    proxyRes.on('end', () => {
      const u = normalizeUsage(usage, upstream.kind);
      completeRequest(rowId, {
        status: proxyRes.statusCode || 502, ...u, durationMs: Date.now() - t0,
        cost: costOf({ upstreamCost: usage?.total_cost_usd ?? null }),
      });
    });
  });
  proxyReq.on('error', (e) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `gateway upstream unreachable: ${e.message}` });
    } else { try { res.destroy(); } catch { /* already gone */ } }
    completeRequest(rowId, { status: 502, error: e.message, durationMs: Date.now() - t0 });
  });
  if (body) proxyReq.write(body);
  proxyReq.end();
}

// The model name from a request body, if the body carries one. The body is read by express.json
// BEFORE this middleware (mounted after app.use(express.json())), so req.body is already parsed.
function modelFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  return body.model || body.meta?.model || null;
}

// ── the gateway's own read model ─────────────────────────────────────────────────────────────
// Per-xell request list (the observability panel's gateway tab): newest-first.
export async function requestsForXell(xellId, { limit = 50 } = {}) {
  try {
    return await q(
      `SELECT r.*, z.name AS zee_name FROM llm_gateway_request r
         LEFT JOIN zee z ON z.id = r.zee_id
        WHERE r.xell_id = $1
        ORDER BY r.requested_at DESC
        LIMIT $2`,
      [xellId, Math.min(Math.max(Number(limit) || 50, 1), 500)]);
  } catch (e) {
    logline('gateway', `requestsForXell failed (${String(e.message).slice(0, 120)})`);
    return [];
  }
}

export default { GATEWAY_PORT, gatewayBaseUrl, gatewayProxy, gatewayHello, requestsForXell,
                 normalizeUsage, usageFromStream, modelPrice, costOf, providerUpstreamUrl,
                 parseGatewayPath, recordRequest, completeRequest, gatewayEnv, zeeTurnForXell };

// ── the cxell-facing env ──────────────────────────────────────────────────────────────────────
// The base URL every cxell CLI points at the gateway, per provider, carrying the xell's identity
// in the PATH (/x/<xell-identity>/<provider>/...). The queenzee mints this URL at spawn from the
// xell's identity token and injects it as the provider's base-url env — so the gateway attributes
// every call to the xell WITHOUT parsing the bearer (which stays the real provider key, unchanged
// from today). The identity is URL-safe (the token is hex from lib/xell-token.js mintToken).
//
// `provider` names the provider the CURRENT cage was dispatched on (adapter.provider). It decides
// the ANTHROPIC_BASE_URL segment: claude AND deepseek both speak the Anthropic dialect through
// ANTHROPIC_BASE_URL, but a deepseek cage must resolve to the deepseek account/upstream — the
// gateway reads the provider from the path segment, so `/claude` in a deepseek cage would send
// deepseek traffic to the claude account. The OpenAI-dialect vars (OPENAI_BASE_URL for codex,
// KIMI_MODEL_BASE_URL for kimi) and the grok CLI's XAI_BASE_URL are provider-specific by name, so
// their segments are fixed.
//
// OFF SWITCH: when GATEWAY_PORT === PORT the gateway listener is NOT mounted (index.js), so the
// base URLs would point at a dead port and every AI call would fail. In that case return an EMPTY
// env — the adapters' own real base URLs (the provider's actual API) are used unchanged, exactly
// the pre-gateway behaviour.
//
// Path shape (measured: claude 2.1.222 preserves the base-url path prefix on both the /api/hello
// probe and the /v1/messages POST). The two dialects compose differently:
//   • Anthropic CLIs (claude, deepseek, grok) append `/v1/messages` to a base WITHOUT a trailing
//     `/v1` → ANTHROPIC_BASE_URL = .../claude → POST .../claude/v1/messages?beta=true
//   • OpenAI-compatible CLIs (codex, kimi) use the SDK convention: the base CARRIES the `/v1` and
//     the CLI appends `/chat/completions` → OPENAI_BASE_URL = .../openai/v1 → POST
//     .../openai/v1/chat/completions (which the gateway parses as forward `/v1/chat/completions`).
// Either way the gateway receives `/x/<token>/<provider>/v1/<path>` and forwards the CLI's own
// path (`/v1/messages` or `/v1/chat/completions`) straight upstream — providerUpstreamUrl strips
// the upstream's own `/v1` so it does not double.
//   ANTHROPIC_BASE_URL  = <gateway>/x/<xellToken>/claude   (or /deepseek for a deepseek cage)
//   → HEAD <gateway>/x/<token>/claude/api/hello
//   → POST <gateway>/x/<token>/claude/v1/messages?beta=true
//   OPENAI_BASE_URL     = <gateway>/x/<xellToken>/openai/v1 → POST .../openai/v1/chat/completions
//   KIMI_MODEL_BASE_URL = <gateway>/x/<xellToken>/kimi/v1   → POST .../kimi/v1/chat/completions
//   XAI_BASE_URL        = <gateway>/x/<xellToken>/grok      → POST .../grok/v1/messages
export function gatewayEnv({ xellToken = null, provider = 'claude' } = {}) {
  if (config.gatewayPort === config.port) return {};
  const base = gatewayBaseUrl();
  const ident = xellToken ? `/x/${encodeURIComponent(xellToken)}` : '';
  const anthropic = provider === 'deepseek' ? 'deepseek' : 'claude';
  return {
    ANTHROPIC_BASE_URL: `${base}${ident}/${anthropic}`,
    OPENAI_BASE_URL: `${base}${ident}/openai/v1`,
    KIMI_MODEL_BASE_URL: `${base}${ident}/kimi/v1`,
    // The grok CLI (Grok Build) reads XAI_BASE_URL for its endpoint — the same XAI_ prefix its
    // auth uses (XAI_API_KEY, measured on grok 0.2.118). The gateway path segment is `/grok` so
    // the gateway resolves the grok account/upstream, not openai.
    XAI_BASE_URL: `${base}${ident}/grok`,
  };
}

// Parse the xell identity + provider from a gateway path. Returns { xellToken, provider, forward }
// or null when the path is not a gateway path. The forward path is what the upstream actually
// receives (the /x/<token>/<provider> prefix stripped).
export function parseGatewayPath(path = '') {
  const m = /^\/x\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return null;
  return {
    xellToken: decodeURIComponent(m[1]),
    provider: m[2],
    forward: m[3] || '/',
  };
}
