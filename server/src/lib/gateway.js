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
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
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

// Insert one gateway request row. Returns the row id (for the completion UPDATE) or null.
// EXPORTED for the test — the proxy is the only production caller, but the round-trip (record →
// complete → read) is exactly what test/gateway.test.mjs must prove.
export async function recordRequest({ xell, zeeId = null, turnId = null, kind, provider, model,
                                     method, path, sessionId = null }) {
  try {
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

// Resolve the upstream for a request: which provider URL + credential. `path` is the gateway
// path (/v1/messages or /v1/chat/completions). Returns { provider, upstreamUrl, token, kind }
// or null when the caller is not a known xell / the project has no account for the provider.
async function resolveUpstream(xell, path, requestedProvider = null) {
  const kind = path.startsWith('/v1/chat/completions') ? 'chat-completions' : 'messages';
  // Which provider does the CLI's base-url point at? The gateway is reached via ONE base URL
  // (the same gateway host:port for every provider), so the provider is identified by the
  // Authorization token's SIGNATURE (sk-ant- → claude, sk- non-ant → openai/deepseek, etc.) or
  // by a ZEEHIVE-provider header the env sets. Default: the request path decides the dialect,
  // and the xell's project credential for that dialect's natural provider is used.
  const p = PROVIDERS[requestedProvider || 'claude'];
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
function providerUpstreamUrl(provider) {
  switch (provider) {
    case 'openai': return process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    case 'kimi': return process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1';
    case 'deepseek': return process.env.DEEPSEEK_ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
    default: return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  }
}

// Proxy one gateway request: authenticate the caller, resolve the upstream, forward, stream the
// response, and record the request + the upstream's usage. This is the express middleware for
// /v1/messages and /v1/chat/completions (mounted on the gateway's OWN http listener).
export async function gatewayProxy(req, res) {
  const t0 = Date.now();
  // ── authenticate the caller by xell identity token ──
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const xell = bearer ? await xellForToken(bearer).catch(() => null) : null;
  if (!xell) {
    return res.status(401).json({ error: 'unknown xell identity — the gateway requires ZEEHIVE_XELL_TOKEN as Bearer' });
  }

  // ── which provider? ──
  // The cxell's env sets ZEEHIVE_PROVIDER=<key> beside the base url, so the gateway knows which
  // provider's dialect the caller speaks. Fallback: the path dialect decides (claude for /v1/messages).
  const providerHeader = String(req.headers['x-zeehive-provider'] || '');
  const requestedProvider = providerHeader || (req.url.startsWith('/v1/chat/completions') ? 'openai' : 'claude');

  const upstream = await resolveUpstream(xell, req.url, requestedProvider).catch(() => null);
  if (!upstream) {
    return res.status(502).json({ error: `gateway: cannot forward for xell ${xell.slug} (no ${requestedProvider} account)` });
  }

  // ── record the request fact ──
  const rowId = await recordRequest({
    xell, kind: upstream.kind, provider: upstream.provider, model: modelFromBody(req.body),
    method: req.method, path: req.url,
  });

  // ── forward ──
  const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
  const headers = { ...req.headers };
  for (const h of hopByHop) delete headers[h];
  // The upstream credential: replace the xell bearer with the provider key. The provider never
  // sees the xell identity token; the xell never needs the provider key over the wire.
  headers.authorization = `Bearer ${upstream.token}`;
  headers.host = new URL(upstream.upstreamUrl).host;

  const target = new URL(upstream.upstreamUrl);
  const proxyReq = http.request({
    hostname: target.hostname, port: target.port || 443,
    method: req.method, headers, path: req.url,
  }, (proxyRes) => {
    // Stream the response through. For SSE, this must be unbuffered.
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
    // Read the upstream's final usage from the stream for the completion UPDATE.
    let usage = null;
    if (upstream.kind === 'chat-completions') {
      // OpenAI stream: the last data: chunk before [DONE] carries usage when stream_options.include_usage
      proxyRes.on('data', (chunk) => {
        const text = chunk.toString();
        for (const m of text.matchAll(/data: (\{.*\})/g)) {
          try { const j = JSON.parse(m[1]); if (j.usage) usage = j.usage; } catch { /* partial */ }
        }
      });
    } else {
      // Anthropic stream: the final message_delta / message_stop event carries usage.
      proxyRes.on('data', (chunk) => {
        const text = chunk.toString();
        for (const m of text.matchAll(/event: (\w+)\n?data: (\{.*\})/g)) {
          try { const j = JSON.parse(m[2]); if (j.type === 'message_delta' && j.usage) usage = j.usage; } catch { /* partial */ }
        }
      });
    }
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
  req.pipe(proxyReq);
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

export default { GATEWAY_PORT, gatewayBaseUrl, gatewayProxy, requestsForXell,
                 normalizeUsage, modelPrice, costOf, providerUpstreamUrl };

// ── the cxell-facing env ──────────────────────────────────────────────────────────────────────
// The base URLs every cxell CLI should point at the gateway, per provider. These REPLACE the
// provider's real URL in adapter.env() when the gateway is enabled, so ALL traffic (spawn, resume,
// interactive) crosses the queenzee. The provider the CLI actually talks to is carried as
// X-Zeehive-Provider (the gateway uses it to resolve the upstream + credential). The xell identity
// token is NOT put here — it is already ZEEHIVE_XELL_TOKEN in the cage env, and the gateway reads
// it from the Authorization header the CLI sends.
export function gatewayEnv() {
  const base = gatewayBaseUrl();
  return {
    // claude + deepseek (Anthropic dialect) → the gateway's /v1/messages
    ANTHROPIC_BASE_URL: base,
    // codex + kimi (OpenAI dialect) → the gateway's /v1/chat/completions
    OPENAI_BASE_URL: `${base}/v1`,
    KIMI_MODEL_BASE_URL: `${base}/v1`,
  };
}
