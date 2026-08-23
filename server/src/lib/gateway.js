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
//   /responses            (xAI Responses API — grok; usage is Anthropic-shaped)
// All are JSON POSTs; responses stream as text/event-stream (SSE). The gateway proxies the
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
// BEST-EFFORT, NEVER THROWS — a recording failure must not fail the AI call the human is waiting
// on. Every write is awaited but catch-guarded, and the proxy itself is the only thing that can
// fail the request (a dead provider is a 502).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { config } from '../config.js';
import { xellForToken } from './xell-token.js';
import { tokenForSpawn, PROVIDERS } from './provider-tokens.js';
// Body capture lives in its OWN module (gateway-bodies.js) so a future rewrite of the
// proxy path — e.g. the meter fix landing on this file in parallel — merges cleanly: the
// gateway only calls a handful of named functions, it does not own the capture logic.
import { BODY_CAP, gatewayBodyCaptureEnabled, secretValuesForProject, captureRequestText,
         scrubBodyText, persistBodies } from './gateway-bodies.js';
import { GATEWAY_UPSTREAM_UNREACHABLE_PREFIX } from './gateway-upstream.js';

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

// The SECOND name a cage can use for the gateway: the compose-network host ZEEHIVE_API_FALLBACK
// names (ticket #94), one port over. A provider CLI base-url is ONE string — the cage cannot try a
// second name itself, so the queenzee chooses primary-then-fallback at dispatch time and mints only
// the one that answers /api/hello (chooseGatewayBaseUrl).
//
// TRAP, inherited from the API (config.js): cxellApiFallback DEFAULTS to the same string as
// cxellApiBase, so an install that sets no CXELL_API_FALLBACK has NO second name at all.
// chooseGatewayBaseUrl says so loudly rather than pretending a fallback exists. Read the env
// lazily (like gatewayBaseUrl) so the two stay comparable and a test can flip the fallback.
export function gatewayFallbackBaseUrl() {
  const api = process.env.CXELL_API_FALLBACK || config.cxellApiFallback || 'http://host.docker.internal:4700';
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
  // Any other `data: {…}` SSE carrying a usage object — the xAI Responses API (grok, which routes
  // through /responses and reports usage as input_tokens/output_tokens in its completed event), and
  // any future Anthropic-dialect variant. The xAI Responses API nests usage under `response.usage`
  // (its completed event carries the WHOLE response object), so BOTH the flat and the nested shape
  // are checked — a top-level-only check is how grok tokens would read 0 after decompression.
  for (const m of text.matchAll(/data: (\{.*\})/g)) {
    try {
      const j = JSON.parse(m[1]);
      if (j.usage) return j.usage;
      if (j.response?.usage) return j.response.usage;
    } catch { /* partial */ }
  }
  // A non-SSE JSON body (a single message response).
  if (!text.includes('event:') && !text.includes('data: {')) {
    try { const j = JSON.parse(text); if (j.usage) return j.usage; } catch { /* not JSON or partial */ }
  }
  return null;
}

// The model id from a response body/SSE text — used when the REQUEST carried no model (grok's
// CLI omits it; the ledger then recorded model NULL, and those rows can never price). Every
// dialect names the model in its first response object: Anthropic message_start carries
// `message.model`, OpenAI's first chunk carries `model`, and the xAI Responses API completed
// event carries `model`. Grep the FIRST `"model"` key. Pure so the capture is testable.
export function modelFromStream(text = '') {
  if (!text) return null;
  const m = /"model"\s*:\s*"([^"]+)"/.exec(text);
  return m ? m[1] : null;
}

// Classify a response body into the CONVERSATION text vs the THINKING stream — the observability
// gateway is the one place every model's output crosses, so this is where "which thinking stream,
// which actual conversation text" is answered PER ROW. The result is stored on the ledger row in
// meta.speech (the gateway's completeRequest) and the mobile chat renders the conversation WITHOUT
// the zee needing to call a tool. `kind` is the same dialect the usage parser uses:
//   'messages'          — Anthropic dialect (text/thinking/redacted_thinking content blocks, SSE
//                         content_block_delta events) PLUS the xAI Responses API (grok routes
//                         through /responses; output_text.delta / reasoning_summary.delta) which
//                         is dispatched as kind 'messages'.
//   'chat-completions'  — OpenAI dialect (choices[].delta.content / choices[].message.content,
//                         deepseek-reasoner's delta.reasoning_content thinking stream).
// Pure so the classification is testable without an upstream (test/gateway.test.mjs).
export function classifyResponseText(text = '', kind = 'messages') {
  const out = { conversation: [], thinking: [] };
  if (!text) return out;

  const push = (arr, v) => {
    if (v == null) return;
    const s = typeof v === 'string' ? v : (v?.text ?? v?.content ?? '');
    if (String(s).trim()) arr.push(String(s));
  };
  const eachBlock = (blocks, fn) => {
    if (Array.isArray(blocks)) blocks.forEach(fn);
  };

  // Anthropic SSE delivers a thinking block's FULL text TWICE: content_block_start carries it AND
  // the thinking_delta repeats it (unlike text, whose deltas are incremental). Track the indexes
  // whose start block already emitted the whole stream so the delta does not duplicate it.
  const thinkingEmitted = new Set();

  const parseData = (j) => {
    if (!j || typeof j !== 'object') return;
    // OpenAI dialect: choices[] with delta/message content (a string or an array of text parts)
    // and deepseek-reasoner's reasoning_content thinking stream.
    if (Array.isArray(j.choices)) {
      for (const c of j.choices) {
        const m = c?.message || c?.delta || {};
        push(out.conversation, m.content);
        push(out.thinking, m.reasoning_content);
        eachBlock(m.content, (b) => {
          if (b && typeof b === 'object' && (b.type === 'text' || b.type === 'output_text')) push(out.conversation, b.text);
        });
      }
      return;
    }
    // xAI Responses API SSE: output_text deltas (conversation) and reasoning_summary (thinking).
    if (j.type === 'response.output_text.delta') push(out.conversation, j.delta);
    if (j.type === 'response.output_text.done') push(out.conversation, j.text);
    if (j.type === 'response.reasoning_summary.delta') push(out.thinking, j.delta);
    if (j.type === 'response.reasoning_summary.done') push(out.thinking, j.text);
    // Anthropic non-streaming message content + xAI non-streaming output[].
    if (Array.isArray(j.content)) {
      eachBlock(j.content, (b) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'text' || b.type === 'output_text' || b.type === 'input_text') push(out.conversation, b.text);
        if (b.type === 'thinking') push(out.thinking, b.thinking ?? b.data ?? b.text);
        if (b.type === 'redacted_thinking') push(out.thinking, b.data ?? b.thinking ?? b.text);
        if (b.type === 'reasoning') push(out.thinking, b.summary ?? b.text ?? b.data);
      });
    }
    if (Array.isArray(j.output)) {
      eachBlock(j.output, (item) => {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'message') {
          eachBlock(item.content, (b) => {
            if (!b || typeof b !== 'object') return;
            if (b.type === 'output_text' || b.type === 'input_text') push(out.conversation, b.text);
            if (b.type === 'reasoning') push(out.thinking, b.summary ?? b.text ?? b.data);
          });
        }
        if (item.type === 'reasoning') push(out.thinking, item.summary ?? item.text ?? item.data);
      });
    }
    // Anthropic SSE streaming: content_block_start carries the full first block; content_block_delta
    // carries text_delta / thinking_delta / redacted_thinking_delta. Thinking is emitted ONCE: the
    // start block has the whole stream and the delta repeats it, so the index set skips the repeat.
    if (j.type === 'content_block_start') {
      const b = j.content_block || {};
      if (b.type === 'text') push(out.conversation, b.text);
      if (b.type === 'thinking' && String(b.thinking ?? b.text ?? '').trim()) {
        push(out.thinking, b.thinking ?? b.text);
        thinkingEmitted.add(j.index);
      }
      if (b.type === 'redacted_thinking' && String(b.data ?? b.text ?? '').trim()) {
        push(out.thinking, b.data ?? b.text);
        thinkingEmitted.add(j.index);
      }
    }
    if (j.type === 'content_block_delta') {
      const d = j.delta || {};
      if (d.type === 'text_delta') push(out.conversation, d.text);
      if (d.type === 'thinking_delta' && !thinkingEmitted.has(j.index)) {
        push(out.thinking, d.thinking ?? d.text);
        thinkingEmitted.add(j.index);
      }
      if (d.type === 'redacted_thinking_delta' && !thinkingEmitted.has(j.index)) {
        push(out.thinking, d.data ?? d.text);
        thinkingEmitted.add(j.index);
      }
    }
    // A bare JSON body with a string content (rare, non-SSE, no choices wrapper).
    if (typeof j.content === 'string') push(out.conversation, j.content);
  };

  for (const m of text.matchAll(/data: (\{.*\})/g)) {
    try { parseData(JSON.parse(m[1])); } catch { /* partial event at a chunk boundary */ }
  }
  if (!text.includes('data: {')) {
    try { parseData(JSON.parse(text)); } catch { /* not JSON (or a partial chunk) */ }
  }
  return out;
}

// Look up a model's $/1M token prices from ai_model_spec (migration 163). The ledger records the
// WIRE id the CLI sent (claude-opus-5); the spec row is keyed by the SHORT alias (opus) and lists
// its known wire ids in wire_ids (migration 164 — GROUND TRUTH, an explicit per-id alias, never a
// regex/strip: an id absent from the list is UNPRICED, not guessed, so a repriced claude-opus-6 is
// loud instead of silently priced at the opus-5 row). Matches key OR wire_ids. Returns null when
// the provider/model is unknown, the spec query fails (a DB predating the price columns), or the
// model has no price rows. The prices are per MILLION tokens (mtok) — costOf divides by 1e6.
const asNum = (v) => (v == null ? null : Number(v));
export async function modelPrice(provider, model) {
  if (!provider || !model) return null;
  const spec = await one(
    `SELECT key, label,
            input_price_per_mtok, output_price_per_mtok,
            cache_read_price_per_mtok, cache_write_price_per_mtok
       FROM ai_model_spec
      WHERE provider=$1 AND enabled AND (key=$2 OR $2 = ANY(wire_ids))`, [provider, model])
    .catch(() => null);
  if (!spec) return null;
  return {
    found: true, key: spec.key, label: spec.label,
    inputPerMtok: asNum(spec.input_price_per_mtok),
    outputPerMtok: asNum(spec.output_price_per_mtok),
    cacheReadPerMtok: asNum(spec.cache_read_price_per_mtok),
    cacheWritePerMtok: asNum(spec.cache_write_price_per_mtok),
  };
}

// Derive cost in USD from usage. When the upstream reported a cost (Anthropic total_cost_usd),
// that is authoritative and used as-is. Otherwise the cost is computed from the tokens the
// upstream reported × the model's per-mtok price (migration 163): tokens/1e6 × $per-mtok for
// input, output, cache read and cache write. A model with no known price records cost 0 — never
// a wrong estimate (the same contract the header comment above promises).
export function costOf({ upstreamCost = null, price = null, usage = null } = {}) {
  if (upstreamCost != null) return Number(upstreamCost) || 0;
  if (!price || !usage) return 0;
  const input = (Number(usage.input) || 0) * (price.inputPerMtok ?? 0);
  const output = (Number(usage.output) || 0) * (price.outputPerMtok ?? 0);
  const cacheRead = (Number(usage.cacheRead) || 0) * (price.cacheReadPerMtok ?? 0);
  const cacheWrite = (Number(usage.cacheWrite) || 0) * (price.cacheWritePerMtok ?? 0);
  return (input + output + cacheRead + cacheWrite) / 1e6 || 0;
}

// RATE / USAGE-LIMIT HEADERS — how much of THIS provider ACCOUNT's limit is still available.
//
// Two header families ride ordinary API responses (no Admin key needed):
//
//   1. Claude Code / OAuth SEAT windows (the answer a human on Pro/Max actually wants):
//        anthropic-ratelimit-unified-5h-utilization   0.0–1.0 used fraction of the 5-hour window
//        anthropic-ratelimit-unified-7d-utilization   same for the weekly cap
//        anthropic-ratelimit-unified-*-status         allowed | exceeded | rate_limited
//        anthropic-ratelimit-unified-*-reset          unix epoch when that window resets
//        anthropic-ratelimit-unified-status           overall
//        anthropic-ratelimit-unified-representative-claim  five_hour | seven_day | …
//      Measured on live Claude Code traffic (claude-meter / Anthropic client source): the client
//      already reads these for its /usage bar; the gateway was throwing them away.
//
//   2. API RPM/TPM (pay-as-you-go + every vendor that publishes them):
//        anthropic-ratelimit-{tokens,requests}-{limit,remaining,reset}
//        x-ratelimit-{limit,remaining}-{tokens,requests}  (OpenAI-compatible)
//
// The number a human wants is AVAILABLE, not used: available_pct = 100 − used%. Pure so the
// extraction is unit-testable without a proxy. Returns null when no limit header is present.
export function extractRateLimit(headers = {}) {
  if (!headers || typeof headers !== 'object') return null;
  const h = {};
  for (const [k, v] of Object.entries(headers)) {
    // node http lowercases; express/undici may not. Array values take the first entry.
    h[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  const num = (k) => {
    const v = h[k];
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (k) => {
    const v = h[k];
    return v == null || v === '' ? null : String(v);
  };
  // available% from remaining/limit (API TPM/RPM). Null when either side is missing.
  const availFromRemLim = (rem, lim) => {
    if (rem == null || lim == null || !(lim > 0)) return null;
    return Math.round((rem / lim) * 1000) / 10;
  };
  // available% from a 0.0–1.0 utilization fraction (unified seat windows).
  const availFromUtil = (u) => {
    if (u == null || !Number.isFinite(u)) return null;
    return Math.round((1 - Math.min(1, Math.max(0, u))) * 1000) / 10;
  };
  // unix epoch seconds (or ms) → ISO; leave non-numeric strings alone.
  const resetAt = (raw) => {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 1e9) {
      // seconds if < 1e12, else already ms
      const ms = n < 1e12 ? n * 1000 : n;
      try { return new Date(ms).toISOString(); } catch { return String(raw); }
    }
    return String(raw);
  };

  // ── Claude Code / OAuth unified windows ──────────────────────────────────────────────────
  const windows = {};
  for (const win of ['5h', '7d', '7d_sonnet', '7d_opus']) {
    const util = num(`anthropic-ratelimit-unified-${win}-utilization`);
    const status = str(`anthropic-ratelimit-unified-${win}-status`);
    const reset = resetAt(str(`anthropic-ratelimit-unified-${win}-reset`));
    if (util == null && !status) continue;
    windows[win] = {
      status: status || null,
      utilization: util,
      available_pct: availFromUtil(util),
      reset_at: reset,
    };
  }
  const unifiedStatus = str('anthropic-ratelimit-unified-status');
  // representative_claim: five_hour | seven_day | seven_day_sonnet | … — normalize to window key
  const claimRaw = str('anthropic-ratelimit-unified-representative-claim');
  const claimToWin = {
    five_hour: '5h', fivehour: '5h', '5h': '5h',
    seven_day: '7d', sevenday: '7d', '7d': '7d',
    seven_day_sonnet: '7d_sonnet', seven_day_opus: '7d_opus',
  };
  const representative = claimRaw
    ? (claimToWin[claimRaw.toLowerCase().replace(/-/g, '_')] || claimRaw)
    : null;

  // ── API TPM / RPM ────────────────────────────────────────────────────────────────────────
  const tokens_remaining = num('anthropic-ratelimit-tokens-remaining')
    ?? num('x-ratelimit-remaining-tokens');
  const tokens_limit = num('anthropic-ratelimit-tokens-limit')
    ?? num('x-ratelimit-limit-tokens');
  const requests_remaining = num('anthropic-ratelimit-requests-remaining')
    ?? num('x-ratelimit-remaining-requests');
  const requests_limit = num('anthropic-ratelimit-requests-limit')
    ?? num('x-ratelimit-limit-requests');
  const tokens_reset = str('anthropic-ratelimit-tokens-reset')
    || str('x-ratelimit-reset-tokens');
  const requests_reset = str('anthropic-ratelimit-requests-reset')
    || str('x-ratelimit-reset-requests');

  const hasUnified = Object.keys(windows).length > 0 || !!unifiedStatus;
  const hasApi = tokens_remaining != null || tokens_limit != null
    || requests_remaining != null || requests_limit != null;
  if (!hasUnified && !hasApi) return null;

  // PRIMARY available_pct: the binding unified window first (what a seat user hits), else TPM, else RPM.
  let available_pct = null;
  if (representative && windows[representative]?.available_pct != null) {
    available_pct = windows[representative].available_pct;
  } else if (windows['5h']?.available_pct != null) {
    available_pct = windows['5h'].available_pct;
  } else if (windows['7d']?.available_pct != null) {
    available_pct = windows['7d'].available_pct;
  } else {
    available_pct = availFromRemLim(tokens_remaining, tokens_limit)
      ?? availFromRemLim(requests_remaining, requests_limit);
  }

  // Keep the legacy used% fields so older readers of meta.rate_limit still work; the primary
  // field for the console is available_pct.
  const usedFromAvail = (a) => (a == null ? null : Math.round((100 - a) * 10) / 10);

  return {
    source: 'headers',
    status: unifiedStatus || null,
    representative,
    available_pct,
    windows: hasUnified ? windows : undefined,
    tokens: hasApi ? {
      remaining: tokens_remaining, limit: tokens_limit, reset: tokens_reset,
      available_pct: availFromRemLim(tokens_remaining, tokens_limit),
    } : undefined,
    requests: hasApi ? {
      remaining: requests_remaining, limit: requests_limit, reset: requests_reset,
      available_pct: availFromRemLim(requests_remaining, requests_limit),
    } : undefined,
    // legacy (used% for meta.rate_limit consumers written before available_pct)
    tokens_remaining, tokens_limit, tokens_reset,
    tokens_used_pct: usedFromAvail(availFromRemLim(tokens_remaining, tokens_limit)),
    requests_remaining, requests_limit, requests_reset,
    requests_used_pct: usedFromAvail(availFromRemLim(requests_remaining, requests_limit)),
  };
}

// DEEPSEEK BALANCE — the ONE quota signal DeepSeek offers.
//
// DeepSeek's API returns NO rate-limit response headers at all (verified live on 2026-08-13 with a
// real key: a 200 from api.deepseek.com/anthropic/v1/messages carries only content-type/date/etc).
// So extractRateLimit() above returns null for every deepseek call and provider_token.usage_limit
// was never written — the console showed "limit: —" for deepseek while claude had its 5h/7d
// windows. What DeepSeek DOES offer is its account balance endpoint:
//
//   GET https://api.deepseek.com/user/balance   (Authorization: Bearer <key>)
//   → { "is_available": true,
//       "balance_infos": [ { "currency": "USD", "total_balance": "56.40",
//                            "granted_balance": "0.00", "topped_up_balance": "56.40" } ] }
//
// A dollar balance is not a "percent of a window remaining", so this snapshot deliberately does NOT
// invent an available_pct. It carries the balance FACTS (source 'balance', currency, total,
// granted, topped-up, is_available) and the console renders "— $56.40 balance" for deepseek
// instead of a "% free" chip. The one number a human actually cares about ("is there money left?")
// is is_available, plus the total. Pure so it is unit-testable without a network.
export function extractDeepseekBalance(body = null) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.is_available !== 'boolean') return null;
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const rows = infos
    .map((b) => ({
      currency: b?.currency || null,
      total_balance: b?.total_balance != null ? String(b.total_balance) : null,
      granted_balance: b?.granted_balance != null ? String(b.granted_balance) : null,
      topped_up_balance: b?.topped_up_balance != null ? String(b.topped_up_balance) : null,
    }))
    .filter((b) => b.total_balance != null);
  if (!rows.length) return null;
  return {
    source: 'balance',
    is_available: body.is_available,
    available_pct: null,          // a dollar balance is not a % of a window — no invented number
    representative: 'balance',
    balance: rows,
    // legacy no-op fields so consumers that expect the header shape keep working
    status: body.is_available ? 'allowed' : null,
  };
}

// Persist a rate/usage-limit snapshot onto the provider_token ACCOUNT that authenticated the
// call. MERGES with the previous snapshot so provider-wide updates AND by_model entries accumulate
// (an opus call must not wipe the sonnet / gpt-5.6 row). Best-effort, never throws.
export async function recordAccountUsageLimit(accountId, rateLimit, { model = null, provider = null } = {}) {
  if (!accountId || !rateLimit) return;
  try {
    const { mergeUsageLimit } = await import('./usage-limits.js');
    const prev = await one(`SELECT usage_limit FROM provider_token WHERE id = $1`, [accountId]);
    const merged = mergeUsageLimit(prev?.usage_limit, rateLimit, { model, provider });
    await q(
      `UPDATE provider_token
          SET usage_limit = $2::jsonb, usage_limit_at = now()
        WHERE id = $1`,
      [accountId, JSON.stringify(merged)]);
  } catch (e) {
    // Column absent (migration 203 not applied yet) or row gone — log once-ish, never throw.
    logline('gateway', `could not store usage_limit on account ${String(accountId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
  }
}

// ── the DeepSeek balance probe ─────────────────────────────────────────────────────────────────
// Fired best-effort from the gateway on each completed deepseek call. DeepSeek sends no
// rate-limit headers, so the ONLY quota signal is the /user/balance endpoint; the probe fills
// the gap (the "deepseek shows no limit" report). Bounded (hard timeout), silent on failure
// (observability must never sink or slow an AI response), and it never touches the response
// stream — it runs in the background after the response is handed through.
const BALANCE_TIMEOUT_MS = 5000;

export async function probeDeepseekBalance({ accountId = null, upstreamUrl = null, token = null } = {}) {
  if (!accountId || !token) return null;
  try {
    // The balance endpoint lives at the API ROOT (https://api.deepseek.com/user/balance), NOT under
    // the /anthropic path the messages endpoint rides (that path 404s — verified live). So derive
    // the origin from the upstream URL and hit /user/balance there.
    let origin = 'https://api.deepseek.com';
    try { origin = new URL(String(upstreamUrl || providerUpstreamUrl('deepseek'))).origin; } catch { /* default */ }
    const url = `${origin}/user/balance`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), BALANCE_TIMEOUT_MS);
    let out = null;
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: ctl.signal,
      });
      if (res.ok) {
        const snap = extractDeepseekBalance(await res.json().catch(() => null));
        if (snap) { await recordAccountUsageLimit(accountId, snap); out = snap; }
      }
    } catch { /* timeout / network — no snapshot, never an error */ }
    finally { clearTimeout(t); }
    return out;
  } catch { return null; }
}

// ── the recorder ──────────────────────────────────────────────────────────────────────────────

// Best-effort: find the LIVE zee for a xell and its OPEN turn, so a gateway request can be
// attributed to the zee/turn that produced it. The xell token in the path gives the xell; the
// live zee is the one whose status is IN ('spawning','online','working','idle') — the same
// filter self.js's liveZee uses, and safe because the one_active_zee_per_xell unique index allows
// at most ONE such zee per xell. (A spawned/resumed zee is 'working' while it runs; an
// interactive TUI in a hook-less cage keeps the zee 'idle' and is still the xell's only zee, so
// it is attributed too — the task's "not idle" shorthand for "the active zee", satisfied because
// the index makes the candidate unambiguous.) The open turn is the most recent zee_turn with
// status='started'. Either may be absent — a request with no live zee or no open turn records
// xell-only and NEVER fails the AI call. Returns { zeeId, turnId } (both null on a lookup failure).
export async function zeeTurnForXell(xellId) {
  try {
    if (!xellId) return { zeeId: null, turnId: null };
    const zee = await one(
      `SELECT id FROM zee WHERE xell_id=$1
         AND status IN ('spawning','online','working','idle')
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
// `fields.meta` is MERGED into the row's existing meta jsonb (used to flag unpriced models);
// `fields.model` UPDATES the model column when non-null (used when the model was only found in
// the response, not the request). Neither is required — existing callers pass neither.
export async function completeRequest(rowId, fields) {
  if (!rowId) return;
  try {
    await one(
      `UPDATE llm_gateway_request
          SET status=$2, input_tokens=$3, output_tokens=$4, cache_read_tokens=$5,
              cache_write_tokens=$6, total_tokens=$7, cost_usd=$8, duration_ms=$9,
              error=$10, model=COALESCE($11, model), meta = meta || $12::jsonb,
              completed_at=now()
        WHERE id=$1`,
      [rowId, fields.status ?? null,
       fields.input || 0, fields.output || 0, fields.cacheRead || 0, fields.cacheWrite || 0,
       (fields.input || 0) + (fields.output || 0) + (fields.cacheRead || 0) + (fields.cacheWrite || 0),
       fields.cost ?? 0, fields.durationMs ?? null, fields.error ?? null,
       fields.model ?? null, JSON.stringify(fields.meta || {})]);
  } catch (e) {
    logline('gateway', `could not complete gateway request ${String(rowId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
  }
}

// An unpriced model is LOUD, not silent: the first row whose tokens are nonzero but whose model
// has no ai_model_spec price logs (provider, model) ONCE per process and flags the row in meta
// (completeRequest) — so the next mismatch is visible in the ledger instead of a believable $0.
const seenUnpriced = new Set();
export function logUnpriced(provider, model) {
  const key = `${provider}|${model}`;
  if (seenUnpriced.has(key)) return;
  seenUnpriced.add(key);
  logline('gateway', `no ai_model_spec price for ${provider}/${model} — cost recorded 0 (see meta.unpriced)`);
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

// Resolve the upstream for a request: which provider URL + credential. Returns
// { provider, upstreamUrl, token, kind, accountId, accountLabel } or null when the caller is
// not a known xell / the project has no account for the provider.
//
// Account selection: prefer the account this xell was GRANTED at spawn (xell_provider_grant) so
// the usage-limit snapshot lands on the same row the cage is actually holding — the freshest
// project account can differ after a rotation. Fall back to tokenForSpawn's freshest ACTIVE.
async function resolveUpstream(xell, kind, providerKey) {
  // The provider comes from the PATH (/x/<token>/<provider>/...) — the gateway's own URL, so it is
  // authoritative. claude + deepseek speak the Anthropic dialect (/v1/messages); openai + kimi the
  // OpenAI dialect (/v1/chat/completions); grok speaks the xAI Responses API (/responses) but its
  // usage is Anthropic-shaped (input_tokens/output_tokens), so kind stays 'messages'. A provider
  // with no dispatch runtime is refused.
  const p = PROVIDERS[providerKey];
  if (!p || !p.dispatch) return null;
  let tokenId = null;
  try {
    const grant = await one(
      `SELECT provider_token_id FROM xell_provider_grant
        WHERE xell_id = $1 AND provider = $2`, [xell.id, p.key]);
    tokenId = grant?.provider_token_id || null;
  } catch { /* grant table missing in ancient DBs — fall through */ }
  const acct = await tokenForSpawn(xell.project_id, p.key, { tokenId }).catch(() => null);
  if (!acct) {
    logline('gateway', `xell ${xell.slug}: no ${p.label} account — refusing to forward`);
    return null;
  }
  // The upstream URL per provider (the same base the adapter would have used directly).
  const upstreamUrl = providerUpstreamUrl(p.key);
  return {
    provider: p.key, upstreamUrl, token: acct.token, kind,
    accountId: acct.id || null, accountLabel: acct.label || null,
  };
}

// The provider's real API base, by provider key — the value the cxell adapters inject today.
//
// The trailing `/v1` is STRIPPED for the OpenAI-compatible providers (openai, kimi): the CLI's
// forward path (after /x/<token>/<provider>) already carries the API version — `/v1/chat/completions`
// from the OpenAI SDK (base ends /v1) — so the upstream base must not ALSO end in /v1 or the
// forwarded path doubles it (`/v1/v1/chat/completions` → 404 from the upstream). Verified with a
// mock upstream: the proxy forwarded `/v1/v1/chat/completions` for a codex call before this.
// claude + deepseek send `/v1/messages` and their upstream base has no `/v1` to double.
// grok is the exception: its CLI appends `/responses` + `/models` DIRECTLY to the base (no `/v1` in
// the forward path), so the upstream KEEPS its `/v1` (default `https://api.x.ai/v1` →
// `https://api.x.ai/v1/responses`). Measured on grok 0.2.118.
function stripTrailingV1(u) {
  return String(u || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

export function providerUpstreamUrl(provider) {
  switch (provider) {
    case 'openai': return stripTrailingV1(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
    case 'kimi': return stripTrailingV1(process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1');
    case 'deepseek': return process.env.DEEPSEEK_ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
    // grok (Grok Build) reads GROK_XAI_API_BASE_URL for its endpoint — EMPIRICALLY verified on
    // grok 0.2.118 in this cage: XAI_API_BASE_URL is ignored (the CLI still hit api.x.ai), while
    // GROK_XAI_API_BASE_URL redirects to the mock. NOT stripped of /v1 — the forward path is the
    // CLI's own /responses (no version), so the upstream keeps its own /v1.
    case 'grok': return process.env.GROK_XAI_API_BASE_URL || process.env.XAI_API_BASE_URL || 'https://api.x.ai/v1';
    // The claude provider's upstream is ALWAYS api.anthropic.com — NOT the server's own
    // ANTHROPIC_BASE_URL, which is the queenzee's default-provider knob and can legitimately point
    // at deepseek (as this very cage's does). Using it here would send every claude cxell call to
    // the wrong vendor with the wrong key.
    default: return 'https://api.anthropic.com';
  }
}

// Join the upstream's base URL with the CLI's forward path WITHOUT doubling the version
// segment. The forward path from the CLI ALREADY carries the dialect's version prefix
// (/v1/messages for Anthropic, /v1/chat/completions for OpenAI), and the upstream base URL may
// ALSO carry one — api.openai.com/v1, api.kimi.com/coding/v1, api.deepseek.com/anthropic. A
// naive string join produces /v1/v1/chat/completions (openai) or /coding/v1/v1/chat/completions
// (kimi), which 404s upstream. When the upstream base path already ends with the forward's first
// segment, that segment is dropped from the forward before joining. Pure so the proxy's mapping
// is testable without an upstream (test/gateway.test.mjs).
export function joinUpstreamPath(upstreamUrl, forward) {
  const target = new URL(upstreamUrl);
  const basePath = target.pathname === '/' ? '' : target.pathname;
  const firstSeg = forward.startsWith('/') ? '/' + (forward.split('/')[1] || '') : '';
  const fwd = basePath && firstSeg && basePath.endsWith(firstSeg)
    ? (forward.slice(firstSeg.length) || '/')
    : forward;
  return `${basePath}${fwd}`;
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
  // Which dialect does the provider speak? openai + kimi are the OpenAI-compatible CLIs
  // (/v1/chat/completions); claude + deepseek run the claude CLI (Anthropic dialect, /v1/messages).
  // Derived from the PROVIDER (now authoritative in the path), not the forward path — the forward
  // path shape changes with the CLI's base-url suffix, the provider does not.
  const kind = (parsed.provider === 'openai' || parsed.provider === 'kimi') ? 'chat-completions' : 'messages';

  const upstream = await resolveUpstream(xell, kind, parsed.provider).catch(() => null);
  if (!upstream) {
    return res.status(502).json({ error: `gateway: cannot forward for xell ${xell.slug} (provider ${parsed.provider})` });
  }

  // ── record the request fact ──
  // recordRequest resolves the LIVE zee + OPEN turn for the xell itself (zeeTurnForXell), so the
  // read model's zee join is populated and the row carries zee_id + turn_id. Best-effort: a
  // missing live zee / open turn records xell-only, never fails the AI call. The price lookup is
  // started NOW (before the upstream round-trip) so the cost is ready when the stream completes —
  // it reads ai_model_spec (migration 163), never fails the call.
  const model = modelFromBody(req.body);
  const rowId = await recordRequest({
    xell, kind, provider: upstream.provider, model,
    method: req.method, path: parsed.forward,
  });
  const pricePromise = modelPrice(upstream.provider, model);

  // ── body capture (the cold half — gateway-bodies.js) ──
  // Bodies go on a SEPARATE table keyed by the request row, capped ~32KB, scrubbed of
  // secrets, and switched per-project (pool_config.gateway_body_capture, default ON). All
  // best-effort: a capture failure must never fail the AI call, and the ledger row above
  // is written whether or not the bodies land. The request body is the DELTA (the last
  // message), not the whole resent conversation prefix. `secrets` is fetched once and used
  // by BOTH bodies, so a capture does not read provider_token twice.
  let captureOn = false;
  let requestCap = null;        // { text, truncated } — the scrubbed, capped request delta
  let secretValues = [];        // this project's provider tokens, for scrubbing the response
  if (rowId) {
    captureOn = await gatewayBodyCaptureEnabled(xell?.project_id);
    if (captureOn) {
      secretValues = await secretValuesForProject(xell?.project_id);
      requestCap = captureRequestText(req.body, { secretValues });
    }
  }

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
  // The CLI's Accept-Encoding (gzip/br) is NOT forwarded. A compressed SSE response body is
  // binary to chunk.toString() and matches no SSE usage event — the meter reads 0 tokens for
  // every compressed provider (claude 0/53, grok 0/29; identity-encoded deepseek worked 88/89).
  // Ask the upstream for identity so the stream is plain text. The response is ALSO decompressed
  // before parsing (below), so even an upstream that gzips anyway cannot hide its usage.
  headers['accept-encoding'] = 'identity';
  // The body is already parsed (express.json); forward it as a string with an explicit
  // content-length. Piping req (a chunked stream) to an https request without content-length is
  // what made the upstream hang up. The AI request body is JSON text; reserialize it.
  const body = typeof req.body === 'string' ? req.body : (req.body ? JSON.stringify(req.body) : '');
  headers['content-length'] = Buffer.byteLength(body);
  logline('gateway', `forward ${req.method} ${parsed.forward} → ${upstream.upstreamUrl} (body ${Buffer.byteLength(body)}B, provider ${upstream.provider})`);

  const target = new URL(upstream.upstreamUrl);
  const transporter = target.protocol === 'https:' ? https : http;
  // The upstream URL may carry a base PATH (deepseek's api.deepseek.com/anthropic, or an
  // operator-set OPENAI_BASE_URL that already includes /v1). The forward path from the CLI also
  // starts with the dialect's version segment, so a naive join doubles it — joinUpstreamPath
  // drops the overlap. The forward path is the upstream's pathname + the CLI's path (which
  // already carries ?query).
  const forwardPath = joinUpstreamPath(upstream.upstreamUrl, parsed.forward);
  const proxyReq = transporter.request({
    hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method, headers, path: forwardPath,
  }, (proxyRes) => {
    // Stream the response through. For SSE, this must be unbuffered.
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    // The client gets the RAW bytes (it sent Accept-Encoding and can decode what it asked for);
    // the METER reads the DECOMPRESSED stream. accept-encoding was overridden to identity above,
    // so a well-behaved upstream sends plain SSE — but an upstream (or a transparent proxy) may
    // still gzip/br, and a compressed body is binary to chunk.toString() and matches no SSE
    // event. Decompress before parsing so usage + cost read nonzero. The decompressor errors
    // (a truncated stream) are caught — best-effort, the completion still records what was read.
    proxyRes.pipe(res);
    const encoding = String(proxyRes.headers['content-encoding'] || '').toLowerCase();
    const inflate = encoding === 'gzip' ? zlib.createGunzip()
      : encoding === 'deflate' ? zlib.createInflate()
      : encoding === 'br' ? zlib.createBrotliDecompress()
      : null;
    const meter = inflate ? proxyRes.pipe(inflate) : proxyRes;
    // Read the upstream's final usage from the stream for the completion UPDATE. A bounded tail is
    // kept across chunks so an SSE event SPLIT by a TCP segment (event header in one chunk, the
    // rest in the next) is still parsed — per-chunk parsing alone silently misses a split usage
    // event and records 0 tokens (verified with a fragmenting mock upstream).
    let usage = null;
    let sseTail = '';
    // The response BODY capture, gated on captureOn (the per-project switch). The REASSEMBLED
    // text (raw chunks appended, NOT the sseTail-carry text — that would repeat the tail on
    // every chunk) is accumulated up to the cap, then the truncated flag latches and the
    // buffer stops growing — the "never buffer unbounded" half of the spec. A StringDecoder
    // joins the chunks, so a multi-byte UTF-8 char split across a TCP segment reassembles
    // correctly instead of becoming a replacement char. 4096 bytes of sseTail continue to
    // ride regardless, so usage parsing is unaffected by the cap.
    let respText = '';
    let respTruncated = false;
    const decoder = new StringDecoder('utf8');
    meter.on('data', (chunk) => {
      const text = sseTail + chunk.toString();
      sseTail = text.slice(-4096);
      const u = usageFromStream(text, upstream.kind);
      if (u) usage = u;
      if (captureOn && !respTruncated) {
        respText += decoder.write(chunk);
        if (respText.length > BODY_CAP) {
          respText = respText.slice(0, BODY_CAP);
          respTruncated = true;
        }
      }
    });
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      if (captureOn && !respTruncated) respText += decoder.end();
      const u = normalizeUsage(usage, upstream.kind);
      // The model may exist in the RESPONSE when the request did not carry one (grok's CLI omits
      // it — the ledger then recorded model NULL, which can never price). Extract it and price
      // against it; the row's model column is updated to match. Nothing else re-runs: a response
      // model found here changes the price lookup, never the request facts.
      let m = model;
      let price = await pricePromise;
      if (!m && respText) m = modelFromStream(respText);
      if (m && m !== model) price = await modelPrice(upstream.provider, m).catch(() => null);
      // An unpriced model is LOUD, not silent: tokens moved, no spec price AND no upstream cost,
      // so cost is a believable $0. Log it once and flag the row so the ledger shows why. When the
      // upstream reported its own cost, the row is priced — no flag, no noise.
      const upstreamCost = usage?.total_cost_usd ?? null;
      const hasTokens = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) > 0;
      let metaPatch = null;
      if (hasTokens && upstreamCost == null && !price) {
        logUnpriced(upstream.provider, m);
        metaPatch = { unpriced: { provider: upstream.provider, model: m } };
      }
      // HOW MUCH OF THIS ACCOUNT'S LIMIT IS STILL AVAILABLE — the upstream's own headers.
      // Stored on the ledger row (meta.rate_limit) AND on the provider_token account
      // (usage_limit — migration 203) so the console can answer per PROVIDER, not per xell.
      const rateLimit = extractRateLimit(proxyRes.headers);
      if (rateLimit) {
        metaPatch = {
          ...(metaPatch || {}),
          rate_limit: rateLimit,
          provider_token_id: upstream.accountId || null,
        };
        // Persist onto the account (provider-wide + by_model merge) for prompt pickers + badge HP.
        if (upstream.accountId) {
          recordAccountUsageLimit(upstream.accountId, rateLimit, {
            model: m || model || null,
            provider: upstream.provider,
          });
        }
      }
      // DEEPSEEK: no rate-limit headers exist, so a response header snapshot is never captured
      // (verified live — api.deepseek.com returns none). The only quota signal is the account
      // balance endpoint; probe it in the BACKGROUND (bounded, never blocks the stream) so the
      // deepseek account gets a usage_limit snapshot like claude does.
      if (upstream.provider === 'deepseek' && upstream.accountId) {
        void probeDeepseekBalance({
          accountId: upstream.accountId,
          upstreamUrl: upstream.upstreamUrl,
          token: upstream.token,
        });
      }
      // THE CONVERSATION vs THE THINKING STREAM — the gateway is the one place every model's
      // output crosses, so each row captures what the model SAID (meta.speech.conversation) and
      // what it THOUGHT (meta.speech.thinking), classified from the reassembled response body.
      // The mobile chat's Chat tab reads this, so a zee's speech surfaces WITHOUT the zee making
      // any tool call. Only when capture is on (the per-project body-capture switch) — same gate
      // as persistBodies below, so no row is held to a higher cost than the project chose.
      if (captureOn && respText) {
        const speech = classifyResponseText(respText, upstream.kind);
        if (speech.conversation.length || speech.thinking.length) {
          metaPatch = { ...(metaPatch || {}), speech };
        }
      }
      completeRequest(rowId, {
        status: proxyRes.statusCode || 502, ...u, durationMs: Date.now() - t0,
        cost: costOf({ upstreamCost, price, usage: u }),
        model: (m && m !== model) ? m : undefined,
        meta: metaPatch || undefined,
      });
      if (captureOn) {
        const resp = scrubBodyText(respText, { secretValues });
        persistBodies({
          rowId, projectId: xell?.project_id,
          requestBody: requestCap?.text ?? null, requestTruncated: requestCap?.truncated ?? false,
          responseBody: resp || null, responseTruncated: respTruncated,
        });
      }
    };
    meter.on('end', finish);
    if (inflate) inflate.on('error', (e) => {
      logline('gateway', `gateway decompress failed (${String(e.message).slice(0, 120)})`);
      finish();
    });
  });
  proxyReq.on('error', (e) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `${GATEWAY_UPSTREAM_UNREACHABLE_PREFIX}: ${e.message}` });
    } else { try { res.destroy(); } catch { /* already gone */ } }
    completeRequest(rowId, { status: 502, error: e.message, durationMs: Date.now() - t0 });
    // The request body is already captured (it was read before the forward); persist it with
    // no response — the call failed before producing one.
    if (captureOn) {
      persistBodies({
        rowId, projectId: xell?.project_id,
        requestBody: requestCap?.text ?? null, requestTruncated: requestCap?.truncated ?? false,
        responseBody: null, responseTruncated: false,
      });
    }
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
// Per-xell request list (the observability panel's gateway tab): newest-first. Each row is one
// llm_gateway_request plus its zee's name and — when the request was attributed to a turn — that
// turn's ledger metadata (kind/status/model/summary/timing). The observability panel groups the
// per-request rows under their turn, so the transport-level calls read together with the per-turn
// ledger; the turn_* columns are NULL for older rows recorded before turn_id was populated.
export async function requestsForXell(xellId, { limit = 50 } = {}) {
  try {
    return await q(
      `SELECT r.*, z.name AS zee_name,
              t.kind AS turn_kind, t.status AS turn_status, t.model AS turn_model,
              t.summary AS turn_summary, t.started_at AS turn_started_at,
              t.ended_at AS turn_ended_at, t.stop_reason AS turn_stop_reason,
              t.session_id AS turn_session_id, t.cost_usd AS turn_cost_usd
         FROM llm_gateway_request r
         LEFT JOIN zee z ON z.id = r.zee_id
         LEFT JOIN zee_turn t ON t.id = r.turn_id
        WHERE r.xell_id = $1
        ORDER BY r.requested_at DESC
        LIMIT $2`,
      [xellId, Math.min(Math.max(Number(limit) || 50, 1), 500)]);
  } catch (e) {
    logline('gateway', `requestsForXell failed (${String(e.message).slice(0, 120)})`);
    return [];
  }
}

export default { GATEWAY_PORT, gatewayBaseUrl, gatewayFallbackBaseUrl, probeGatewayBase,
                 _resetGatewayProbeCache, chooseGatewayBaseUrl, verifyGatewayReachable,
                 gatewayProxy, gatewayHello, requestsForXell,
                 normalizeUsage, usageFromStream, modelFromStream, modelPrice, costOf, logUnpriced,
                 classifyResponseText,
                 extractRateLimit, extractDeepseekBalance, recordAccountUsageLimit,
                 probeDeepseekBalance,
                 providerUpstreamUrl, joinUpstreamPath, parseGatewayPath, recordRequest,
                 completeRequest, gatewayEnv, gatewayEnvForBase, zeeTurnForXell };

// ── the cxell-facing env ──────────────────────────────────────────────────────────────────────
// The base URL every cxell CLI points at the gateway, per provider, carrying the xell's identity
// in the PATH (/x/<xell-identity>/<provider>/...). The queenzee mints this URL at spawn from the
// xell's identity token and injects it as the provider's base-url env — so the gateway attributes
// every call to the xell WITHOUT parsing the bearer (which stays the real provider key, unchanged
// from today). The identity is URL-safe (the token is hex from lib/xell-token.js mintToken).
//
// `provider` is the dispatched provider key (adapter.provider). It matters for ANTHROPIC_BASE_URL:
// the Anthropic dialect is spoken by claude AND deepseek (the deepseek adapter is the claude CLI
// aimed at DeepSeek's Anthropic-compatible endpoint), and the provider in the PATH is what tells
// the gateway which upstream + credential to use. A deepseek zee pointed at /x/<token>/claude
// would have its calls attributed to claude and forwarded with a CLAUDE key — exactly the
// cross-provider misrouting the credential gates exist to stop.
//
// OFF SWITCH: when GATEWAY_PORT === PORT the gateway listener is NOT mounted (index.js), so the
// base URLs would point at a dead port and every AI call would fail. In that case gatewayEnv()
// returns an EMPTY env — the adapters' own real base URLs (the provider's actual API) are used
// unchanged, exactly the pre-gateway behaviour. The probe never runs when the gateway is off.
//
// PROVE THE ADDRESS BEFORE MINTING IT (TKT-179). gatewayEnv() is the only place the gateway
// base-url is minted for a cage, and it now CHOOSES the base URL by probing /api/hello — a
// provider CLI base-url is a single string, so a cage handed a dead address has no second name to
// try and every provider fails with the VENDOR's words. The queenzee proves the address itself,
// cached, and refuses loudly when neither candidate answers instead of minting a dead env.
//
// Path shape (measured: claude 2.1.222 preserves the base-url path prefix on both the /api/hello
// probe and the /v1/messages POST):
//   ANTHROPIC_BASE_URL = <gateway>/x/<xellToken>/<claude|deepseek>
//   → HEAD <gateway>/x/<token>/claude/api/hello
//   → POST <gateway>/x/<token>/claude/v1/messages?beta=true
//   OPENAI_BASE_URL     = <gateway>/x/<xellToken>/openai/v1 → POST .../openai/v1/chat/completions
//   KIMI_MODEL_BASE_URL = <gateway>/x/<xellToken>/kimi/v1   → POST .../kimi/v1/chat/completions
//   GROK_XAI_API_BASE_URL = <gateway>/x/<xellToken>/grok    → GET .../grok/models, POST .../grok/responses
//
// The <provider> segment MUST be the xell's ACTUAL provider key, because the gateway resolves the
// provider ACCOUNT from the path (resolveUpstream → tokenForSpawn). A deepseek cxell pointed at
// /claude would be forwarded with the project's CLAUDE key; a kimi cxell pointed at /openai with
// the OPENAI key — both wrong (and refused when the project has no such account). So the spawn
// passes the dispatched provider through and the path names it.
//
// The OpenAI-dialect vars are FIXED per CLI (OPENAI_BASE_URL → /openai, KIMI_MODEL_BASE_URL → /kimi)
// rather than derived from the dispatched provider: a claude cage also carries the codex/kimi base
// URLs (the every-provider env lets a zee switch CLIs), and each must resolve to its OWN provider's
// account. The grok CLI (Grok Build) reads GROK_XAI_API_BASE_URL for its endpoint — EMPIRICALLY
// verified on grok 0.2.118 (XAI_API_BASE_URL is ignored; GROK_XAI_API_BASE_URL redirects to a mock;
// the CLI then speaks /responses, not /v1/messages).
//
// KNOWN GAP, stated rather than hidden: that redirect was measured on the API-KEY path
// (api.x.ai/v1/responses). A cage authenticated with a SuperGrok / Business SEAT session — the
// device-auth credential, see lib/cxell-runtimes.js grokSessionCredential — talks to the vendor's
// own cli-chat-proxy.grok.com instead, so its turns are NOT observed to pass through this gateway
// and may not be metered here. The seat is billed by the weekly pool rather than per call, so
// nothing is spent unseen; what is missing is the RECORD. Measure it before claiming either way.

// ── the gateway reachability probe ────────────────────────────────────────────────────────────
// GET <base>/api/hello — the same connectivity probe the CLIs send (gatewayHello). Best-effort,
// bounded, CACHED, never throws: the probe must never fail a live AI call. A spawn must not pay a
// network round-trip, so a working address stays trusted for a short TTL and a dead address is
// re-probed sooner — a transient blip recovers fast, a real outage surfaces at the next mint with
// a NAMED refusal instead of a silently dead env. Overridable via env so a test can shrink the TTL.
//
// REACH = ANY HTTP ANSWER, NOT JUST 200 (measured 2026-08-23 by the manager): from a cage,
// host.docker.internal:4701 refused (connection refused — the TKT-179 incident shape) while
// zeehive_server:4701 answered HTTP 404. A 404 is PROOF the port resolves and a server answers —
// the exact thing a provider CLI needs to reach the gateway — so it counts as reachable. What the
// probe rejects is the dead-address family: connection refused, DNS ENOTFOUND, timeout, no server
// at all. Anything that gets an HTTP response back is an address the cage can use.
const PROBE_TIMEOUT_MS = Number(process.env.GATEWAY_PROBE_TIMEOUT_MS || 2000);
const PROBE_TTL_OK_MS = Number(process.env.GATEWAY_PROBE_TTL_OK_MS || 30000);
const PROBE_TTL_FAIL_MS = Number(process.env.GATEWAY_PROBE_TTL_FAIL_MS || 3000);
const probeCache = new Map();   // baseUrl → { ok, at }

// TEST-ONLY: clear the probe verdict cache (+ the once-only "no second name" warning). The
// standalone choose/refuse test drives the same module across scenarios (primary → fallback →
// both dead) and needs one scenario's cached verdict to not leak into the next.
export function _resetGatewayProbeCache() {
  probeCache.clear();
  loggedEqualFallback = false;
}

export async function probeGatewayBase(baseUrl) {
  if (!baseUrl) return false;
  const cached = probeCache.get(baseUrl);
  const ttl = cached ? (cached.ok ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS) : 0;
  if (cached && Date.now() - cached.at < ttl) return cached.ok;
  let verdict = false;
  try {
    const res = await fetch(`${baseUrl}/api/hello`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // ANY HTTP answer (any status) is proof the port resolves and a server listens — a 404 from
    // the compose-name /api/hello is reachable (measured). Only the connection-failure family
    // (refused / ENOTFOUND / timeout) fails the probe.
    verdict = true;
  } catch { /* connection refused / timeout / DNS — verdict stays false */ }
  probeCache.set(baseUrl, { ok: verdict, at: Date.now() });
  return verdict;
}

// ── the gateway base-url CHOICE ───────────────────────────────────────────────────────────────
// PRIMARY host.docker.internal:<gatewayPort> (the stable address — the compose name FLAPS with
// ENOTFOUND while the container is recreated; config.js documents why). FALLBACK the compose-network
// name derived from config.cxellApiFallback (zeehive_server:<gatewayPort> in prod). When the two
// resolve equal there is NO second name, and that is said loudly rather than pretended away. When
// neither answers, REFUSE with a named sentence quoting both addresses — never a cage full of
// vendor-branded ConnectionRefused (TKT-179: one unpublished port failed every provider for 13h).
let loggedEqualFallback = false;
// The fallback address we last SAID we were probing — so the "primary unreachable" line is a
// STATE CHANGE, not a 30s tick. The health monitor (queenzee/gateway-health.js) calls this every
// ~30s; a primary that stays down while the fallback answers must not print the same line forever.
// null = never logged (or the primary has answered since — a fresh episode is loud again).
let lastFallbackProbeLogged = null;

export async function chooseGatewayBaseUrl() {
  const primary = gatewayBaseUrl();
  const fallback = gatewayFallbackBaseUrl();
  if (primary === fallback && !loggedEqualFallback) {
    loggedEqualFallback = true;
    logline('gateway', `WARNING: no gateway fallback — CXELL_API_FALLBACK resolves equal to CXELL_API_BASE (${fallback}). `
      + 'An install that sets no CXELL_API_FALLBACK has only ONE name to try; if that port is unpublished '
      + 'every gateway mint will refuse loudly.');
  }
  if (await probeGatewayBase(primary)) {
    lastFallbackProbeLogged = null;   // the primary answered — a later fallback is a NEW episode, say it loud
    return primary;
  }
  if (lastFallbackProbeLogged !== fallback) {
    lastFallbackProbeLogged = fallback;
    logline('gateway', `gateway primary ${primary} unreachable — probing fallback ${fallback}`);
  }
  if (await probeGatewayBase(fallback)) return fallback;
  lastFallbackProbeLogged = null;     // both refused — the throw below is the loud word; a recovery is a new episode
  throw new Error(
    `LLM gateway unreachable: neither ${primary} nor ${fallback} answers /api/hello. `
    + 'The queenzee refuses to hand a cage a gateway address it cannot reach itself. '
    + 'Check that GATEWAY_PORT is published in BOTH docker-compose.prod.yml and docker-compose.bootstrap.yml '
    + 'and that the gateway listener is up.'
  );
}

// PROVE the gateway address once at startup, BEFORE any dispatch — the boot-time half of TKT-179.
// Best-effort and never fatal: a gateway the queenzee itself cannot reach is logged LOUDLY so a
// human sees it at boot, and the dispatch path (chooseGatewayBaseUrl) still refuses per-mint if the
// state persists. Never crashes the boot.
export async function verifyGatewayReachable() {
  try {
    const base = await chooseGatewayBaseUrl();
    logline('gateway', `gateway reachable at ${base} — cages will get a working provider base-url`);
    return { ok: true, base };
  } catch (e) {
    const msg = `GATEWAY UNREACHABLE AT STARTUP: ${e.message}`;
    console.error(`[zeehive] ${msg}`);
    try { logline('gateway', msg); } catch { /* logbus needs the db too */ }
    return { ok: false, error: e.message };
  }
}

// The pure env SHAPE for a GIVEN base URL — split from gatewayEnv so the shape is testable without
// a network probe (gatewayEnv chooses the base, this mints the per-provider vars unchanged).
export function gatewayEnvForBase(base, { xellToken = null, provider = 'claude' } = {}) {
  const ident = xellToken ? `/x/${encodeURIComponent(xellToken)}` : '';
  // Anthropic-dialect providers run the claude CLI: claude → /claude, deepseek → /deepseek.
  const anthro = provider === 'deepseek' ? 'deepseek' : 'claude';
  return {
    ANTHROPIC_BASE_URL: `${base}${ident}/${anthro}`,
    OPENAI_BASE_URL: `${base}${ident}/openai/v1`,
    KIMI_MODEL_BASE_URL: `${base}${ident}/kimi/v1`,
    GROK_XAI_API_BASE_URL: `${base}${ident}/grok`,
  };
}

// Mint the cxell-facing gateway env for a dispatch. ASYNC because it PROVES the address first
// (chooseGatewayBaseUrl — cached, so a spawn normally pays no round-trip) and refuses loudly when
// neither candidate answers. Off switch intact: GATEWAY_PORT === PORT returns {} without probing,
// so the adapters' real URLs are used unchanged.
export async function gatewayEnv({ xellToken = null, provider = 'claude' } = {}) {
  if (config.gatewayPort === config.port) return {};
  const base = await chooseGatewayBaseUrl();
  return gatewayEnvForBase(base, { xellToken, provider });
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
