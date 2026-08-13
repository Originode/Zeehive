// THE A2A OUTBOUND SEND — a zee's `zee a2a <card-url> --message "…"` verb (plan §6 P4, DR-2/DR-7).
//
// The zee never dials the external agent's server directly — the QUEENZEE makes the HTTP call on
// its behalf (DR-2: "their client path is queenzee-mediated"), and the call is RECORDED at the
// transport layer exactly like the LLM gateway records its calls (lib/gateway.js recordRequest →
// llm_gateway_request): a ledger row is inserted BEFORE the call and completed with the verdict
// AFTER it, so the fleet always has a record of what a zee asked an external agent to do even when
// the external server is unreachable (migration 201, a2a_outbound_request).
//
// Discovery is A2A v1.0's own: the card URL the zee names is fetched first (an AgentCard — served
// by the external server at /.well-known/agent-card.json or /a2a/v1/agents/:slug/card), and the
// card's supportedInterfaces[0] (protocolBinding JSONRPC) names the endpoint the SendMessage POST
// goes to. Both the card fetch and the SendMessage are bounded with a hard timeout — a hung
// external server must not wedge the single-process queenzee (the same reasoning as
// lib/remote-git.js githubApi).
import { one } from '../db/pool.js';
import { logline } from './logbus.js';
import { zeeTurnForXell } from './gateway.js';
import { randomUUID } from 'node:crypto';

const FETCH_TIMEOUT_MS = 15000;

// Extract the JSON-RPC endpoint from an A2A AgentCard — the supportedInterface whose
// protocolBinding is JSONRPC (plan §3.1: exactly one per agent card). Pure so it is testable.
export function resolveAgentInterface(card) {
  const iface = card?.supportedInterfaces?.find((i) => i?.protocolBinding === 'JSONRPC');
  return iface?.url ? iface : null;
}

// One bounded HTTP call that returns { ok, status, body, error } instead of throwing — the same
// contract as remote-git.js githubApi. `body` is the parsed JSON payload when the answer had one.
async function httpJson(url, { method = 'GET', payload = null, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'zeehive-a2a',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty/non-json body */ }
    return { ok: res.ok, status: res.status, body: json, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e?.name === 'AbortError' ? 'timed out' : String(e?.message || e) };
  } finally { clearTimeout(t); }
}

// ── the ledger (migration 201) — the transport-layer record ──────────────────
// Same shape as lib/gateway.js recordRequest: insert a row before the call, complete it with the
// verdict after. When zeeId is not supplied the live zee + open turn for the xell are looked up
// (best-effort, never failing the send), so the ledger attributes every outbound call.
export async function recordA2AOutbound({ xell, zeeId = null, turnId = null, cardUrl, agentUrl = null,
                                          method = 'SendMessage', body = null }) {
  try {
    if (!zeeId) {
      const live = await zeeTurnForXell(xell?.id);
      zeeId = live.zeeId; turnId = live.turnId;
    }
    const row = await one(
      `INSERT INTO a2a_outbound_request (xell_id, zee_id, turn_id, project_id, card_url, agent_url, method, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [xell?.id || null, zeeId || null, turnId || null, xell?.project_id || null,
       String(cardUrl || ''), agentUrl || null, method || 'SendMessage', body || null]);
    return row?.id || null;
  } catch (e) {
    logline('a2a', `could not record an outbound A2A request (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

export async function completeA2AOutbound(rowId, { status = null, result = null, error = null, agentUrl = null } = {}) {
  if (!rowId) return;
  try {
    await one(
      `UPDATE a2a_outbound_request
          SET status=$2, response=$3::jsonb, error=$4, agent_url=COALESCE($5, agent_url), completed_at=now()
        WHERE id=$1`,
      [rowId, status ?? null, JSON.stringify(result ?? {}), error ?? null, agentUrl ?? null]);
  } catch (e) {
    logline('a2a', `could not complete outbound A2A request ${String(rowId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
  }
}

// ── the send ────────────────────────────────────────────────────────────────
// Fetches the external agent's card, resolves its JSON-RPC endpoint, POSTs a v1.0 SendMessage,
// and records the whole exchange in the ledger. Returns the JSON-RPC result on success, or an
// error object { ok:false, error } that self.js surfaces to the zee.
export async function sendExternalA2AMessage({ xell, cardUrl, message }) {
  const url = String(cardUrl || '').trim();
  const text = String(message || '').trim();
  if (!url) return { ok: false, error: 'a2a needs <card-url> — the external agent\'s card URL' };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: `"${url}" is not an http(s) URL — point me at the external agent's card` };
  }
  if (!text) return { ok: false, error: 'a2a needs --message "…" — what you want to say to the external agent' };

  const rowId = await recordA2AOutbound({ xell, cardUrl: url, body: text });
  logline('a2a', `${xell?.slug || '?'} → external ${url} (SendMessage): ${text.replace(/\s+/g, ' ').slice(0, 120)}`);

  // 1. Discovery — fetch the card.
  const card = await httpJson(url, { method: 'GET' });
  if (!card.ok) {
    await completeA2AOutbound(rowId, { status: card.status || 0, error: `card fetch failed: ${card.error}` });
    return { ok: false, error: `could not fetch the agent card at ${url}: ${card.error}` };
  }
  const iface = resolveAgentInterface(card.body);
  if (!iface) {
    await completeA2AOutbound(rowId, { status: card.status, result: card.body,
      error: 'the card declares no JSONRPC supportedInterface' });
    return { ok: false, error: `the card at ${url} declares no JSON-RPC interface — nothing to send to` };
  }
  const agentUrl = iface.url;

  // 2. SendMessage.
  const payload = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'SendMessage',
    params: { message: { role: 'user', parts: [{ text }] } },
  };
  const sent = await httpJson(agentUrl, {
    method: 'POST', payload,
    headers: { 'A2A-Version': '1.0' },
  });

  // 3. Record the verdict, then surface the JSON-RPC answer.
  if (!sent.ok) {
    await completeA2AOutbound(rowId, { status: sent.status || 0, error: sent.error, agentUrl });
    return { ok: false, error: `the external agent answered HTTP ${sent.status || '—'} (${sent.error})` };
  }
  if (sent.body?.error) {
    const jr = sent.body.error;
    await completeA2AOutbound(rowId, { status: sent.status, result: sent.body, agentUrl,
      error: `${jr.message || 'json-rpc error'} (code ${jr.code ?? '?'})` });
    return { ok: false, error: `the external agent refused: ${jr.message || jr.code || 'json-rpc error'}` };
  }
  await completeA2AOutbound(rowId, { status: sent.status, result: sent.body, agentUrl });
  return { ok: true, agent: { card_url: url, url: agentUrl }, result: sent.body?.result ?? null, recorded: rowId };
}
