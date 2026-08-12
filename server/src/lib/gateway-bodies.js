// GATEWAY BODY CAPTURE — request/response BODIES for the observability drill-down.
//
// Migration 154's llm_gateway_request is the HOT ledger: one row per AI call, narrow on
// purpose (identity, model, path, status, tokens, cost). It has no bodies, so the
// drill-down's input/output panel has nothing to render. This module owns the COLD half:
// the request/response bodies, stored on a SEPARATE table (llm_gateway_body, migration
// 162) keyed by the request row, capped ~32KB with an explicit truncated flag, scrubbed
// of secrets, swept after 14 days by the maintenance loop, and switched per-project
// (pool_config.gateway_body_capture, default ON).
//
// SEPARATE TABLE ON PURPOSE. Bodies are big and cold; the hot ledger stays narrow. A
// list of 50 calls must not ship 50×64KB of body text — the read model fetches a body
// only when a human expands one call.
//
// WHAT IS STORED:
//   • request_body  — the DELTA message: the LAST message in the request's messages/
//     input array (the new content of THIS call), NOT the whole resent conversation
//     prefix. Captured as a JSON object, scrubbed, capped.
//   • response_body — the response text REASSEMBLED from the SSE chunks (the proxy keeps
//     a 4096-byte sseTail carry across chunks so a split event is parsed; the body must
//     be the reassembled text, not raw per-chunk fragments). Never buffered unbounded:
//     the accumulation stops at the cap and sets the truncated flag.
//
// SECRETS. The bodies travel through the gateway — the one door every AI call crosses —
// so they may carry a pasted key, a tool result echoing a token, or the request's own
// api_key field. Every string is passed through provider-tokens.scrubSecrets (the registry
// of every known provider key shape), exact known credential env values are replaced by
// their literal string, and any JSON value under a sensitive key name (api_key, auth,
// token, …) is redacted wholesale.
//
// BEST-EFFORT, NEVER THROWS — the same contract as the gateway ledger itself: a capture
// or scrub failure must never fail the AI call the human is waiting on. Every write is
// awaited but catch-guarded.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { scrubSecrets } from './provider-tokens.js';

// The per-body cap. ~32KB: enough to render a meaningful input/output panel, small enough
// that a 50-call list stays cheap and the streaming buffer stays bounded.
export const BODY_CAP = 32 * 1024;

// JSON keys whose WHOLE VALUE is a secret — redacted rather than scrubbed, because the
// value is a credential by construction no matter what it looks like.
const SENSITIVE_KEY_RE = /(api[_-]?key|authorization|auth|token|secret|password|passwd|credential)/i;

// ── pure: the request DELTA ───────────────────────────────────────────────────────────
// The LAST message of the request's conversation — the new content of THIS call. The CLI
// resends the WHOLE conversation prefix on every request (Anthropic messages[], OpenAI
// chat messages[], grok input[]), and the drill-down wants the delta, not the prefix.
// Returns the last message (an object, a string for grok's bare input, or any primitive)
// or null when the body carries no conversation shape at all.
export function requestDelta(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages[body.messages.length - 1];
  }
  if (body.input != null) {
    if (Array.isArray(body.input) && body.input.length > 0) return body.input[body.input.length - 1];
    return body.input;
  }
  return null;
}

// ── pure: secret scrubbing ─────────────────────────────────────────────────────────────
// Scrub a TEXT: every provider token shape (scrubSecrets — registry-driven) plus the
// exact known credential env values this project holds (a rotated key or a bespoke value
// that matches no shape is caught by its literal string).
export function scrubBodyText(text, { secretValues = [] } = {}) {
  let out = scrubSecrets(text);
  for (const s of secretValues || []) {
    if (!s || typeof s !== 'string' || s.length < 6) continue;
    out = out.split(s).join('[REDACTED]');
  }
  return out;
}

// Recursively scrub a JSON value: every string through scrubBodyText, every value under a
// SENSITIVE_KEY name redacted wholesale. Returns a NEW value (never mutates the input).
export function scrubJsonValue(value, { secretValues = [] } = {}) {
  const scrub = (s) => scrubBodyText(s, { secretValues });
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubJsonValue(v, { secretValues }));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : scrubJsonValue(v, { secretValues });
    }
    return out;
  }
  return value;
}

// ── pure: the cap ─────────────────────────────────────────────────────────────────────
// Cap a body at `cap` BYTES with an explicit truncated flag. A cut never splits a UTF-8
// sequence (a multi-byte char at the boundary is dropped whole, not halved into a
// replacement char). Text at or under the cap passes through untouched.
export function capBody(text, cap = BODY_CAP) {
  const t = String(text ?? '');
  if (Buffer.byteLength(t) <= cap) return { text: t, truncated: false };
  let cut = 0;
  let bytes = 0;
  for (const ch of t) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > cap) break;
    bytes += b;
    cut += ch.length;
  }
  return { text: t.slice(0, cut), truncated: true };
}

// Capture the request body (the delta, scrubbed, capped). Returns { text, truncated } or
// null when the body carries no delta to store.
export function captureRequestText(body, { secretValues = [] } = {}) {
  const delta = requestDelta(body);
  if (delta == null) return null;
  const scrubbed = scrubJsonValue(delta, { secretValues });
  return capBody(JSON.stringify(scrubbed));
}

// ── I/O: the switch ──────────────────────────────────────────────────────────────────
// pool_config.gateway_body_capture (migration 162), default ON. OFF stores nothing — the
// gateway checks this before capturing; the ledger row is written either way. Absent row
// (a project with no pool_config) reads as ON (the default); a READ ERROR fails closed to
// OFF — capture must never be able to break the call.
export async function gatewayBodyCaptureEnabled(projectId) {
  if (!projectId) return false;
  try {
    const row = await one(`SELECT gateway_body_capture FROM pool_config WHERE project_id=$1`, [projectId]);
    return row ? row.gateway_body_capture !== false : true;
  } catch (e) {
    logline('gateway', `gatewayBodyCaptureEnabled failed (${String(e.message).slice(0, 120)})`);
    return false;
  }
}

// Flip the per-project switch (the console's toggle). Returns the new value. Throws when the
// project has no pool_config row (a project's config should exist; a silent no-op would hide a
// broken setup).
export async function setGatewayBodyCapture(projectId, enabled) {
  if (!projectId) throw new Error('project required');
  const row = await one(
    `UPDATE pool_config SET gateway_body_capture=$2 WHERE project_id=$1 RETURNING gateway_body_capture`,
    [projectId, !!enabled]);
  if (!row) throw new Error('no pool_config for project');
  return row.gateway_body_capture;
}

// ── I/O: the project's known credential env values ───────────────────────────────────
// Every provider token this project holds (the same rows the spawn path injects into a
// cage's env) — used to scrub the exact literal values out of a captured body.
export async function secretValuesForProject(projectId) {
  if (!projectId) return [];
  try {
    const rows = await q(
      `SELECT token FROM provider_token WHERE project_id=$1 AND token IS NOT NULL`, [projectId]);
    return rows.map((r) => r.token).filter((t) => typeof t === 'string' && t.length >= 6);
  } catch (e) {
    logline('gateway', `secretValuesForProject failed (${String(e.message).slice(0, 120)})`);
    return [];
  }
}

// ── I/O: persist ─────────────────────────────────────────────────────────────────────
// Write one body row (UPSERT on the request id — a request completes exactly once, but a
// retry/rebuild of the same proxy path must not double-write). Never throws. Skips when
// there is nothing to store (neither body).
export async function persistBodies({ rowId, projectId, requestBody, requestTruncated = false,
                                      responseBody, responseTruncated = false } = {}) {
  if (!rowId) return;
  const rb = requestBody == null ? null : String(requestBody);
  const pb = responseBody == null ? null : String(responseBody);
  if (!rb && !pb) return;   // nothing to store — an empty response with no request delta is noise
  try {
    await one(
      `INSERT INTO llm_gateway_body
         (request_id, project_id, request_body, request_truncated, response_body, response_truncated)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (request_id) DO UPDATE SET
         request_body = EXCLUDED.request_body,
         request_truncated = EXCLUDED.request_truncated,
         response_body = EXCLUDED.response_body,
         response_truncated = EXCLUDED.response_truncated,
         updated_at = now()`,
      [rowId, projectId || null, rb, !!requestTruncated, pb, !!responseTruncated]);
  } catch (e) {
    logline('gateway', `could not persist gateway bodies for ${String(rowId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
  }
}

// ── I/O: the read model ──────────────────────────────────────────────────────────────
// The bodies for ONE request row (the drill-down expands one call at a time — the list
// never ships body text). Returns the row or null.
export async function bodiesForRequest(requestId) {
  if (!requestId) return null;
  try {
    return await one(
      `SELECT request_id, request_body, request_truncated, response_body, response_truncated
         FROM llm_gateway_body WHERE request_id=$1`, [requestId]);
  } catch (e) {
    logline('gateway', `bodiesForRequest failed (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

// ── I/O: the retention sweep ─────────────────────────────────────────────────────────
// Delete bodies older than `olderThanDays` (default 14). Bodies are cold by design; the
// request ledger row itself is NOT touched. Called by the queenzee maintenance loop.
// Returns the number of rows deleted (0 on failure — a sweep must never throw).
export async function sweepGatewayBodies({ olderThanDays = 14, now = Date.now() } = {}) {
  try {
    const rows = await q(
      `DELETE FROM llm_gateway_body
        WHERE created_at < $1::timestamptz
        RETURNING request_id`,   // request_id for the count; the row is gone either way
      [new Date(now - olderThanDays * 86400 * 1000).toISOString()]);
    if (rows.length) logline('maint', `gateway body sweep removed ${rows.length} body row(s) (older than ${olderThanDays}d)`);
    return rows.length;
  } catch (e) {
    logline('maint', `gateway body sweep failed: ${String(e.message).slice(0, 120)}`);
    return 0;
  }
}

export default { BODY_CAP, requestDelta, scrubBodyText, scrubJsonValue, capBody, captureRequestText,
                 gatewayBodyCaptureEnabled, setGatewayBodyCapture, secretValuesForProject,
                 persistBodies, bodiesForRequest, sweepGatewayBodies };
