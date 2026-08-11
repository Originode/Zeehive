// THE LANGCHAIN ZEE DRIVER — "deploy zees via langchain" (docs/langchain-stateful-zees.md).
//
// WHAT THIS IS. Langchain used as a LIBRARY, under the queenzee's existing determinism: a langchain
// chat model wrapper makes the model call (instead of a vendor CLI), a DB-backed memory store
// (`zee_conversation`) carries the conversation across turns, and the queenzee still decides WHEN a
// turn runs, starts/ends it, and owns every gate. There is no graph, no framework loop — the
// queenzee invokes langchain, never the other way round.
//
// THE GATEWAY IS THE ONE DOOR. The chat model's base URL is the gateway path
// (`/x/<xell-token>/<provider>`), the same path the vendor CLIs use, so every langchain model call
// crosses `gatewayProxy` and is recorded in `llm_gateway_request` exactly like a CLI call. The
// transparency directive replaced Langfuse so nothing depends on an agent volunteering data; the
// transport-layer recording is unchanged by langchain.
//
// WHAT STATE MEANS. The conversation that must survive a handover is stored one row per message in
// `zee_conversation` (migration 192), keyed by xell_id (the xell is the durable work unit — it
// survives swaps and re-crews). A turn loads it before the model call and appends after, so the
// next zee on the same xell starts WARM.
//
// CONFINEMENT. The first build runs a SINGLE model call per turn — no tools, no file access — so it
// runs in the queenzee process safely. When the agent gains tools (the next card), it must run
// inside the cxell so the container remains the permission boundary; that needs langchain in the
// zee-agent image.
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { gatewayEnv } from './gateway.js';
import { toolList, runTool, LANGCHAIN_TOOLS } from './langchain-tools.js';

// openai + kimi speak the OpenAI dialect (/v1/chat/completions); everything else is Anthropic
// dialect (/v1/messages — claude, deepseek; grok is /responses but Anthropic-shaped usage).
const OPENAI_DIALECT = new Set(['openai', 'kimi']);

export function isOpenAIDialect(provider) {
  return OPENAI_DIALECT.has(provider);
}

// The gateway base URL + dialect for a provider — the same path shape gatewayEnv mints for the
// vendor CLIs. The xell token travels in the PATH, so the gateway attributes the call to the xell
// without parsing the bearer (which stays the provider key).
export function chatModelConfig({ provider = 'claude', xellToken = null } = {}) {
  const gw = gatewayEnv({ xellToken, provider });
  return {
    dialect: isOpenAIDialect(provider) ? 'chat-completions' : 'messages',
    baseUrl: isOpenAIDialect(provider) ? gw.OPENAI_BASE_URL : gw.ANTHROPIC_BASE_URL,
  };
}

// Build a langchain chat model pointed at the gateway. `apiKey` is the provider token the gateway
// will forward (passed through as x-api-key so the upstream sees ONE consistent credential); the
// gateway replaces the Authorization header with the real token either way.
export function buildChatModel({ provider = 'claude', model = null, apiKey = null, baseUrl = null } = {}) {
  if (isOpenAIDialect(provider)) {
    return new ChatOpenAI({
      model: model || undefined,
      apiKey: apiKey || 'xell-identity',
      configuration: { baseURL: baseUrl || undefined },
    });
  }
  return new ChatAnthropic({
    model: model || undefined,
    apiKey: apiKey || 'xell-identity',
    anthropicApiUrl: baseUrl || undefined,
  });
}

// ── message <-> row mapping (langchain message types ↔ zee_conversation rows) ────────────────
export function messageToRow(msg) {
  if (!msg) return null;
  let role = 'user';
  if (msg instanceof AIMessage) role = 'assistant';
  else if (msg instanceof SystemMessage) role = 'system';
  else if (msg instanceof ToolMessage) role = 'tool';
  else if (msg && msg._getType && msg._getType() === 'ai') role = 'assistant';
  return { role, content: messageText(msg.content), name: msg.name || null };
}

export function rowToMessage(row) {
  const content = row?.content ?? '';
  switch (row?.role) {
    case 'assistant': return new AIMessage(content);
    case 'system': return new SystemMessage(content);
    case 'tool': return new ToolMessage({ content, name: row.name || undefined });
    default: return new HumanMessage(content);
  }
}

// Flatten a langchain message's content (string, or an array of content blocks) to text.
export function messageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b) return '';
        if (typeof b === 'string') return b;
        if (b.type === 'text') return b.text || '';
        if (b.type === 'tool_use') return `[tool_use ${b.name}]`;
        if (b.type === 'tool_result') return `[tool_result ${b.content}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

// The usage a langchain AIMessage carries — mapped to the zee_turn burn shape
// ({ cost, input, output, cacheRead, cacheWrite, metered }). cost is 0: the langchain model does
// not report a price, and the GATEWAY ledger (llm_gateway_request) prices the call authoritatively
// from the model spec. null when the provider reported none.
export function usageFromLc(resp) {
  const u = resp?.usage_metadata;
  if (!u) return null;
  return {
    cost: 0,
    input: Number(u.input_tokens || 0) || 0,
    output: Number(u.output_tokens || 0) || 0,
    cacheRead: Number(u.input_token_details?.cache_read || 0) || 0,
    cacheWrite: Number(u.input_token_details?.cache_creation || 0) || 0,
    metered: true,
  };
}

// ── memory: the zee_conversation store ───────────────────────────────────────────────────────
// Best-effort by contract (like every ledger write in this system): a load that fails returns an
// empty history (the zee still runs, just cold), and an append that fails logs and never fails the
// turn. The queueenzee's scheduling never depends on these.

export async function loadConversation(xellId, { limit = 100 } = {}) {
  if (!xellId) return [];
  try {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const rows = await q(
      `SELECT role, content, name FROM zee_conversation
        WHERE xell_id=$1 ORDER BY seq DESC LIMIT $2`, [xellId, cap]);
    return rows.reverse().map(rowToMessage);
  } catch (e) {
    logline('langchain', `loadConversation(${String(xellId).slice(0, 8)}) failed (${e.message})`);
    return [];
  }
}

export async function appendConversation(xellId, messages, { zeeId = null, turnId = null } = {}) {
  if (!xellId || !messages?.length) return;
  try {
    const max = await one(
      `SELECT COALESCE(MAX(seq),0) AS m FROM zee_conversation WHERE xell_id=$1`, [xellId]);
    let seq = Number(max?.m || 0);
    for (const msg of messages) {
      const row = messageToRow(msg);
      if (!row) continue;
      seq += 1;
      await q(
        `INSERT INTO zee_conversation (xell_id, zee_id, turn_id, seq, role, content, name)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (xell_id, seq) DO UPDATE
           SET content=EXCLUDED.content, role=EXCLUDED.role, name=EXCLUDED.name`,
        [xellId, zeeId || null, turnId || null, seq, row.role, row.content, row.name]);
    }
  } catch (e) {
    logline('langchain', `appendConversation(${String(xellId).slice(0, 8)}) failed (${e.message})`);
  }
}

export async function resetConversation(xellId) {
  if (!xellId) return;
  try { await q(`DELETE FROM zee_conversation WHERE xell_id=$1`, [xellId]); }
  catch (e) { logline('langchain', `resetConversation(${String(xellId).slice(0, 8)}) failed (${e.message})`); }
}

// ── the turn ──────────────────────────────────────────────────────────────────────────────────
// Run ONE langchain model call for a zee: load the xell's conversation, append the task as the
// user message, call the model through the gateway, persist the exchange, return the result.
//
// `apiKey` is the provider token (from spawnCreds / tokenForSpawn). `system` is an OPTIONAL system
// message supplied fresh per turn by the caller (the harness brief) — it is deliberately NOT
// persisted into zee_conversation, because a swapped-in zee wears a different harness and must not
// inherit the previous persona's system context.
export async function runLangchainTurn({ xell, task = null, provider = 'claude', model = null,
                                          apiKey = null, xellToken = null, system = null } = {}) {
  const { baseUrl } = chatModelConfig({ provider, xellToken });
  const chat = buildChatModel({ provider, model, apiKey, baseUrl });
  const history = await loadConversation(xell.id);
  const messages = [];
  if (system) messages.push(new SystemMessage(system));
  messages.push(...history);
  const userMsg = new HumanMessage(task ?? '');
  messages.push(userMsg);

  const resp = await chat.invoke(messages);

  // Persist the exchange so the NEXT zee on this xell starts warm.
  await appendConversation(xell.id, [userMsg, resp]);

  return {
    text: messageText(resp.content),
    usage: usageFromLc(resp),
    content: resp.content,
    messages,          // what the model actually saw (history + task) — for tests/observability
  };
}

// ── the TOOL LOOP (the "deploy zees via langchain" mechanism slice — docs §8.3.1) ──────────────
// Model → tool request → queenzee-owned verb → tool result → model, looping, with every gate still
// in front of everything irreversible. The loop is the QUEENZEE'S, not langchain's: langchain only
// makes each model call and exposes the tool_calls; this function decides to continue, what to run,
// when to stop, and WHO the xell is (the identity comes from the turn, never from the model).
//
// CONFINEMENT IS THE TOOL LIST: only the tools in the registry (langchain-tools.js) are bindable,
// and they call the SAME handlers /api/xell/self/* uses. A request for anything outside the registry
// is answered with a refusal (visible to the model, so it can recover) rather than a silent no-op.
// The never-bindable verbs (workspace action, build/sync, manager verbs, done) are simply not in the
// registry — enforced by absence, never by a runtime check that could be argued around.
//
// HARD CAP: `maxIterations` (default 8) bounds the loop. When the cap is hit the result is a VISIBLE
// `capHit` — a loop that quietly truncates looks like a finished answer, which is the exact failure
// a tool loop must not have.
export const MAX_TOOL_ITERATIONS = 8;
// Each tool result feeds back into the model's context; an unbounded result would blow it (a
// selfStatus payload, a long listing). Capped like the gateway's body capture.
export const TOOL_RESULT_CAP = 4000;

export function buildTool(desc, ctx) {
  return tool(
    desc.schema || { type: 'object', properties: {}, required: [] },
    async (args) => {
      const out = await desc.run(ctx.xell, args || {});
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
    { name: desc.name, description: desc.description },
  );
}

// Run the agent turn: load the xell's conversation, add the task, then the bounded loop.
// `tools` defaults to the WAVE-1 registry (status/work/working/item). `onAssistant` / `onTool`
// let the caller (spawnLangchainZee) feed the play-by-play. Returns the final model response, the
// accumulated messages, how many model calls ran, whether the cap was hit, and which tools ran.
export async function runLangchainAgentTurn({ xell, task = null, provider = 'claude', model = null,
                                               apiKey = null, xellToken = null, system = null,
                                               tools = toolList(), maxIterations = MAX_TOOL_ITERATIONS,
                                               onAssistant = null, onTool = null } = {}) {
  const { baseUrl } = chatModelConfig({ provider, xellToken });
  const chat = buildChatModel({ provider, model, apiKey, baseUrl });
  const history = await loadConversation(xell.id);
  const messages = [];
  if (system) messages.push(new SystemMessage(system));
  messages.push(...history);
  const userMsg = new HumanMessage(task ?? '');
  messages.push(userMsg);

  // THE ALLOWLIST IS THE CONFINEMENT, STRUCTURALLY. Only tools in LANGCHAIN_TOOLS may be bound, and
  // every execution resolves through the allowlist (runTool, which defaults to LANGCHAIN_TOOLS). A
  // caller passing an over-wide `tools` array cannot widen the loop: `bindable` filters it down to
  // the allowlist, so a verb outside it is never even offered to the model, and if the model asks
  // for it anyway runTool refuses it. The loop never binds or runs a verb the allowlist does not name.
  const bindable = tools.filter((d) => LANGCHAIN_TOOLS[d.name]);
  const bound = bindable.length ? chat.bindTools(bindable.map((d) => buildTool(d, { xell }))) : chat;
  let iterations = 0;
  let capHit = false;
  let finalResp = null;
  let endedForHuman = null;   // { reason } — the loop ENDED because a tend was RAISED (not cleared)
  const executed = [];
  // The loop makes several model calls; the zee_turn burn is the SUM of them all (the gateway
  // already records each call individually in llm_gateway_request; this is the per-turn total).
  const totalUsage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, metered: false };
  const addUsage = (u) => {
    if (!u) return;
    totalUsage.cost += Number(u.cost || 0);
    totalUsage.input += Number(u.input || 0);
    totalUsage.output += Number(u.output || 0);
    totalUsage.cacheRead += Number(u.cacheRead || 0);
    totalUsage.cacheWrite += Number(u.cacheWrite || 0);
    totalUsage.metered = totalUsage.metered || !!u.metered;
  };
  while (true) {
    iterations += 1;
    finalResp = await bound.invoke(messages);
    addUsage(usageFromLc(finalResp));
    messages.push(finalResp);
    if (onAssistant) { try { onAssistant(finalResp); } catch (e) { logline('langchain', `onAssistant threw (${String(e.message).slice(0, 80)})`); } }
    const calls = finalResp.tool_calls || [];
    if (!calls.length) break;                          // natural end — the model answered
    for (const tc of calls) {
      // ONE dispatch path: runTool (which resolves against the ALLOWLIST, never the caller's array)
      // is the single place a tool is looked up and run — the allowlist refusal + the handler call.
      // `desc` is the ALLOWLIST lookup (LANGCHAIN_TOOLS[tc.name]), so `executed`/`onTool` only ever
      // record a verb the allowlist names; an over-wide caller array cannot leak a name in.
      const desc = LANGCHAIN_TOOLS[tc.name];
      const content = await runTool(xell, { name: tc.name, args: tc.args || {} });
      if (desc) executed.push({ name: tc.name, args: tc.args || {} });
      messages.push(new ToolMessage({ content: String(content).slice(0, TOOL_RESULT_CAP), tool_call_id: tc.id }));
      if (onTool && desc) { try { onTool({ name: tc.name, args: tc.args || {} }); } catch (e) { logline('langchain', `onTool threw (${String(e.message).slice(0, 80)})`); } }
      // LOOP-ENDS-TURN ON TEND — harness policy, NOT verb semantics. A tend means "I am waiting for
      // a human." A zee that raises one and keeps iterating has not asked for anything — it has
      // logged a wish. What must be shared is the VERB'S EFFECT: `tend` still calls the SAME
      // selfTend handler, writes the same row, shows the same card — the door is unchanged. What
      // belongs to the harness is WHETHER THE TURN CONTINUES. A cxell zee's harness decides when its
      // turn ends; this loop IS the harness for a langchain zee, so "raising a tend ends this turn"
      // is harness policy, not verb semantics. A CLEAR (tend clear=true) does NOT end the turn — it
      // is answering, not asking. hint-land/hint-ship do NOT end the turn either — a hint blocks
      // nothing by construction (it lights a button) and the zee keeps working; ending on a hint
      // would invent a stop the fleet does not have.
      if (tc.name === 'tend' && !tc.args?.clear) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.ok) endedForHuman = { reason: parsed.message || 'a human was asked' };
        } catch { /* not JSON — fall through, the tend was refused (e.g. no reason) */ }
        if (endedForHuman) break;
      }
    }
    if (endedForHuman) break;   // the turn is over — the zee is waiting to be resumed
    if (iterations >= maxIterations) { capHit = true; break; }
  }

  // Persist the exchange so the NEXT zee on this xell starts warm. The tool interactions are the
  // journey; the durable exchange is the user task + the final assistant response.
  await appendConversation(xell.id, [userMsg, finalResp]);

  // A CAPPED loop is a VISIBLE result, not a silent stop: the model never reached a final answer,
  // so the text says exactly that (a loop that quietly truncates looks like a finished answer).
  // A loop that ENDED FOR A HUMAN (a tend was raised) is also a VISIBLE result: the zee asked a
  // human something, so the turn is over — exactly as a cxell zee ends its turn and waits to be
  // resumed. The text names the ask, not a silent break.
  const capped = capHit;
  const text = endedForHuman
    ? `Turn ended: a human was asked — "${endedForHuman.reason}". The zee is waiting to be resumed.`
    : capped
      ? `Tool loop stopped: capped at ${iterations} iterations without reaching a final answer.`
      : messageText(finalResp.content);

  return {
    text,
    usage: totalUsage,
    content: finalResp.content,
    messages,
    iterations,
    endedForHuman,      // the turn ended because a tend was raised (the ask a human must answer)
    capped,             // visible "the cap was hit" — never a silent truncation
    capHit,
    toolCalls: executed, // the tools that actually ran ({name, args}) — for the play-by-play
    executed,
  };
}
