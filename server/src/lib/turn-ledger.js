// THE PER-TURN OBSERVABILITY LEDGER — one row per TURN, the unit a human replays.
//
// The zee row carries LIFETIME burn (cost + tokens, summed across every turn that zee
// hosted — migration 030). That is the right number for a fleet burn, and the wrong
// grain for "what did THIS turn do and cost?". A xell that hosted three zees (a swap,
// a resume) or one zee that ran three turns cannot say which turn spent what from the
// zee row alone. zee_turn is the missing per-turn grain:
//
//   * `startTurn` is called by every writer that STARTS a turn the queenzee can see —
//     intake.js (spawn), nudge.js (resume), self.js (interactive turn start). It
//     returns the turn row so the caller can thread `turn_id` into the play-by-play
//     events that follow.
//   * `endTurn` is called by every writer that ENDS a turn — intake (spawn result,
//     spawn error, fleet-pause), nudge (resume result), self (interactive turn end).
//     It writes the turn's OWN burn (not the zee's cumulative — usageFrom's result is
//     the per-turn figure) and its ending state.
//
// The burn columns mirror the zee row (030) exactly, so the SAME usageFrom() reader
// feeds both consumers and the two can never disagree about a turn. `metered` records
// whether the provider reported usage at all — a turn with no total_cost_usd and no
// usage object is NOT free (TKT-99-1390), it is unmeasured, and the row says so.
//
// NEVER THROWS: observability must not sink a zee's completion. Every path that can
// fail (a pg blip, a missing row) is caught and logged, returning null — the caller's
// turn machinery already handles its own failures and must never depend on this.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';

export const TURN_KIND = { spawn: 'spawn', resume: 'resume', interactive: 'interactive' };
export const TURN_STATUS = { started: 'started', ended: 'ended', errored: 'errored', paused: 'paused' };

// ── TURN BUDGET — warn a zee as its turn approaches the vendor ceiling ──────────────────────────
// Bare-'error' deaths in this fleet average 18.8M tokens and $12.15 a turn, against 9.8M and
// $7.02 for healthy turns (zee rows, all time, 2026-08). A turn that runs past ~19M dies with the
// unclassifiable bare 'error' — the ceiling, not a random fault — and takes its unlanded work with
// it (~$158 of finished work fleet-wide). 12M is the warning threshold: well above the healthy
// average (9.8M), well below where deaths cluster (18.8M), and far enough below the ceiling to
// leave the zee runway to commit + land. ONE named constant so the next person can move it against
// outcomes (the firing is recorded on the turn row — see meta.turn_budget_warning).
export const TURN_BUDGET_WARNING_TOKENS = 12_000_000;

// ── THINKING vs CONVERSATION — the classifier the whole feature rides on ──────────────
// An assistant feed event's content blocks carry BOTH the model's internal reasoning and the
// text it actually outputs. Anthropic's extended thinking names the first
// {type:'thinking'} (or {type:'redacted_thinking'} when the provider withheld it); the real
// reply is {type:'text'}. OpenAI-dialect CLIs collapse reasoning into text at the parser, so
// the distinction only arrives STRUCTURED on the Anthropic wire — which is the reference
// shape every vendor adapter normalises to (cxell-runtimes.js). The mobile chat shows
// conversation text as chat bubbles and thinking as a dimmed aside; both must be captured
// SEPARATELY at the observability layer, never mixed. This is the pure classifier used at
// CAPTURE time (recordFeedEvent enriches the persisted raw) and at READ time (rows written
// before the classifier existed fall back to it).
export function classifyAssistantEvent(event) {
  const out = { conversation: [], thinking: [], tools: [] };
  if (!event || typeof event !== 'object' || event.type !== 'assistant') return out;
  const blocks = event.message?.content;
  if (typeof blocks === 'string') {
    if (String(blocks).trim()) out.conversation.push(String(blocks));
    return out;
  }
  if (!Array.isArray(blocks)) return out;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const t = b.type;
    if (t === 'text') {
      const txt = String(b.text ?? '');
      if (txt.trim()) out.conversation.push(txt);
    } else if (t === 'thinking' || t === 'redacted_thinking') {
      const th = b.thinking ?? b.data ?? (typeof b.text === 'string' ? b.text : '');
      if (String(th ?? '').trim()) out.thinking.push(String(th));
    } else if (t === 'tool_use') {
      out.tools.push({ name: b.name || 'tool', input: b.input || {} });
    }
    // Anything else (tool_result echoes, a provider-only block type) is not speech — skip.
  }
  return out;
}

// The last assistant TEXT a turn produced — the closest thing a turn has to "what it said".
// Clude-shaped assistant messages carry content blocks ({type:'text', text} | {type:'tool_use'}).
// Returns a bounded string (the first 500 chars) or null. The final `result` event may also
// carry a plain result string; that is the fallback.
export function lastAssistantText(msg) {
  if (!msg) return null;
  if (typeof msg === 'string') return msg.slice(0, 500);
  if (msg.result && typeof msg.result === 'string') return msg.result.slice(0, 500);
  const blocks = msg.message?.content || msg.content || [];
  let last = null;
  for (const b of blocks) {
    if (b?.type === 'text' && b.text) last = b.text;
  }
  return last ? String(last).slice(0, 500) : null;
}

// Start a turn. `kind` = spawn | resume | interactive. Returns the turn row, or null on
// any failure (observability is best-effort by contract). The caller threads the id into
// session_event rows so the play-by-play can be replayed per turn.
//
// `executionId` — the PLANE-3 execution (workflow weld) this turn advances. The QUEENZEE
// stamps it when it starts a turn for a DISPATCHED execution; the caller resolves it from
// the xell's execution_id binding (the source of truth). A turn with no execution keeps
// execution_id NULL — every standalone turn and every historic turn is exactly that.
export async function startTurn({ zee, xell = null, kind = 'spawn', sessionId = null, model = null,
                                   startedAt = null, meta = null, executionId = null }) {
  try {
    const row = await one(
      `INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, session_id, model, started_at, meta, execution_id)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($8, '{}'::jsonb), $9)
       RETURNING *`,
      [zee?.id || null, xell?.id || zee?.xell_id || null, xell?.project_id || null,
       kind, sessionId || zee?.claude_session_id || zee?.session_name || null,
       model || zee?.model || null, startedAt || null,
       meta ? JSON.stringify(meta) : null, executionId || xell?.execution_id || null]);
    return row;
  } catch (e) {
    logline('turn', `could not start a turn ledger row (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

// End a turn with the turn's OWN burn. `burn` is the usageFrom() shape
// ({ cost, input, output, cacheRead, cacheWrite, metered }). `summary` is the last
// assistant text the turn produced (its answer). `stopReason` is the turn's end reason
// (end_turn, an error message, PAUSED_STOP_REASON, …). Returns the updated row or null.
//
// `ended_at IS NULL` in the WHERE makes the end a ONE-SHOT act: a turn that already ended
// (ended_at set) is never re-stamped — a second writer (the spin detector racing intake, a
// double-fired completion handler) gets null back instead of overwriting the ending state. A
// ledger we are building trust in must not let a late writer relabel a turn that ended naturally.
export async function endTurn(turnId, { status = 'ended', burn = null, stopReason = null,
                                        summary = null, endedAt = null, meta = null } = {}) {
  if (!turnId) return null;
  const b = burn || { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, metered: true };
  try {
    const row = await one(
      `UPDATE zee_turn
          SET status = $2, ended_at = COALESCE($3, now()),
              cost_usd = $4, input_tokens = $5, output_tokens = $6,
              cache_read_tokens = $7, cache_write_tokens = $8,
              metered = $9, stop_reason = COALESCE($10, stop_reason),
              summary = COALESCE($11, summary),
              meta = meta || COALESCE($12, '{}'::jsonb)
        WHERE id = $1 AND ended_at IS NULL RETURNING *`,
      [turnId, status, endedAt || null, b.cost, b.input, b.output, b.cacheRead, b.cacheWrite,
       b.metered !== false, stopReason || null, summary || null,
       meta ? JSON.stringify(meta) : null]);
    if (!row) logline('turn', `endTurn: no OPEN zee_turn row ${String(turnId).slice(0, 8)} to close (already ended, or absent)`);
    _turnBudget.delete(turnId); // the turn is over — drop its running total (a new turn re-accumulates)
    return row;
  } catch (e) {
    logline('turn', `could not end turn ${String(turnId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

// The per-xell read model the console renders: turns newest-first, each with its burn,
// its timing, and a summary of what it did. Optional zee_id narrows to one zee.
export async function turnsForXell(xellId, { zeeId = null, limit = 50 } = {}) {
  if (!xellId) return [];
  try {
    const rows = await q(
      `SELECT t.*, z.name AS zee_name, z.status AS zee_status
         FROM zee_turn t LEFT JOIN zee z ON z.id = t.zee_id
        WHERE t.xell_id = $1 AND ($2::uuid IS NULL OR t.zee_id = $2)
        ORDER BY t.started_at DESC
        LIMIT $3`,
      [xellId, zeeId || null, Math.min(Math.max(Number(limit) || 50, 1), 500)]);
    return rows;
  } catch (e) {
    logline('turn', `turnsForXell failed (${String(e.message).slice(0, 120)})`);
    return [];
  }
}

// The play-by-play events for one turn, oldest first. Reads the append-only session_event
// log filtered by turn_id — the same rows the console's /zees/:id/events endpoint already
// serves, now attributed to the turn they belong to.
export async function eventsForTurn(turnId, { limit = 500 } = {}) {
  if (!turnId) return [];
  try {
    return await q(
      `SELECT id, ts, source, hook_event_name, claude_session_id, zee_id, xell_id, turn_id,
              tool_name, permission_mode, stop_reason, raw
         FROM session_event
        WHERE turn_id = $1
        ORDER BY ts ASC
        LIMIT $2`,
      [turnId, Math.min(Math.max(Number(limit) || 500, 1), 2000)]);
  } catch (e) {
    logline('turn', `eventsForTurn failed (${String(e.message).slice(0, 120)})`);
    return [];
  }
}

// Extract the conversation/thinking/tools from a session_event row's raw. Rows written AFTER the
// classifier exists carry `raw.capture` (enriched at write time by recordFeedEvent); OLDER rows
// fall back to classifying the raw event itself — the same result, computed on read.
export function extractCaptureFromEvent(raw) {
  const ev = raw && typeof raw === 'object' ? raw : {};
  if (ev.capture && (Array.isArray(ev.capture.conversation) || Array.isArray(ev.capture.thinking))) {
    return {
      conversation: ev.capture.conversation || [],
      thinking: ev.capture.thinking || [],
      tools: ev.capture.tools || [],
    };
  }
  return classifyAssistantEvent(ev);
}

// The zee's CAPTURED CONVERSATION output — the actual text the zee's model produced during its
// turns (from the feed's assistant events), NOT the operator↔zee message door. Each assistant
// event's content is classified at capture time (recordFeedEvent → raw.capture); this reads the
// classification and returns it newest-first: [{ ts, kind: 'conversation'|'thinking', text, turn_id }].
// The mobile chat's Chat tab renders these as the zee's speech WITHOUT the zee calling any tool —
// the feed captured it while the zee worked. Best-effort like every observability read.
export async function conversationForXell(xellId, { limit = 100 } = {}) {
  if (!xellId) return [];
  try {
    const rows = await q(
      `SELECT ts, raw, turn_id
         FROM session_event
        WHERE xell_id=$1 AND source='cxell-feed' AND hook_event_name='assistant'
        ORDER BY ts DESC
        LIMIT $2`,
      [xellId, Math.min(Math.max(Number(limit) || 100, 1), 500)]);
    const out = [];
    for (const r of rows) {
      let raw = r.raw;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
      const cap = extractCaptureFromEvent(raw);
      for (const text of cap.conversation || []) {
        out.push({ ts: r.ts, kind: 'conversation', text: String(text), turn_id: r.turn_id || null });
      }
      for (const text of cap.thinking || []) {
        out.push({ ts: r.ts, kind: 'thinking', text: String(text), turn_id: r.turn_id || null });
      }
    }
    return out;   // rows are newest-first; items inside one event share its ts
  } catch (e) {
    logline('turn', `conversationForXell failed (${String(e.message).slice(0, 120)})`);
    return [];
  }
}

// The WELD read model — the nested drill-down tree (work_node → execution → turns → gateway calls)
// for a xell's observability. docs/hierarchical-workflow-adoption.md §3.2: the chain
// execution → zee_turn → llm_gateway_request is the waterfall, and this is its per-xell read shape.
// A human expands a work node, sees its executions, expands one, sees the turns that advanced it,
// expands a turn, sees the LLM gateway calls that made it up. Every row is a byproduct of a door —
// this only READS. Best-effort like every observability read (503-not-throw).
export async function workflowTreeForXell(xellId) {
  if (!xellId) return [];
  try {
    const xell = await one(`SELECT execution_id FROM xell WHERE id=$1`, [xellId]);
    const boundExecId = xell?.execution_id || null;
    // The executions this xell's zees worked on: the xell's own binding (xell.execution_id) plus
    // every execution a zee_turn of this xell was stamped with. DISTINCT because a turn-stamped
    // execution may also BE the xell's binding.
    const execs = await q(
      `SELECT DISTINCT e.id, e.run_id, e.work_node_id, e.attempt, e.map_index, e.loop_iteration,
              e.state, e.entity_id, e.inputs, e.outputs, e.error, e.effect_key,
              e.started_at, e.finished_at, e.created_at,
              wn.name AS work_node_name, wn.kind AS work_node_kind
         FROM execution e
         JOIN work_node wn ON wn.id = e.work_node_id
         LEFT JOIN zee_turn t ON t.execution_id = e.id AND t.xell_id = $1
        WHERE e.id = $2 OR t.id IS NOT NULL
        ORDER BY wn.name, e.started_at`, [xellId, boundExecId]);
    if (!execs.length) return [];
    const execIds = execs.map((e) => e.id);
    const turns = await q(
      `SELECT t.*, z.name AS zee_name
         FROM zee_turn t LEFT JOIN zee z ON z.id = t.zee_id
        WHERE t.execution_id = ANY($1::uuid[])
        ORDER BY t.started_at ASC`, [execIds]);
    const turnIds = [...new Set(turns.map((t) => t.id))];
    const reqs = turnIds.length ? await q(
      `SELECT id, turn_id, provider, model, method, path, status,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
              cost_usd, duration_ms, error, requested_at, completed_at
         FROM llm_gateway_request WHERE turn_id = ANY($1::uuid[])
        ORDER BY requested_at ASC`, [turnIds]) : [];
    const reqsByTurn = new Map();
    for (const r of reqs) {
      if (!reqsByTurn.has(r.turn_id)) reqsByTurn.set(r.turn_id, []);
      reqsByTurn.get(r.turn_id).push(r);
    }
    const turnsByExec = new Map();
    for (const t of turns) {
      if (!turnsByExec.has(t.execution_id)) turnsByExec.set(t.execution_id, []);
      turnsByExec.get(t.execution_id).push({ ...t, gateway_requests: reqsByTurn.get(t.id) || [] });
    }
    const byNode = new Map();
    for (const e of execs) {
      const { work_node_name, work_node_kind, ...exec } = e;
      if (!byNode.has(e.work_node_id)) {
        byNode.set(e.work_node_id, {
          work_node_id: e.work_node_id,
          work_node_name: e.work_node_name,
          work_node_kind: e.work_node_kind,
          executions: [],
        });
      }
      byNode.get(e.work_node_id).executions.push({ ...exec, turns: turnsByExec.get(e.id) || [] });
    }
    return [...byNode.values()];
  } catch (e) {
    logline('turn', `workflowTreeForXell failed (${String(e.message).slice(0, 120)})`);
    return [];
  }
}

// ── play-by-play feed persistence ─────────────────────────────────────────────────────────────
//
// intake.js's feed() (cxell path) and the SDK stream loop both call this so the same stream-json
// events the SSE bus carries as 'zee-output' also land in session_event WITH turn_id. Without
// that column the Turns tab's expandable log is empty by construction.
//
// THE BUG THIS REPLACES: the original hot-path INSERT used
//   VALUES ('cxell-feed', $2, $3, $4, $5, $6, $7, $8)
// with an 8-element params array whose $1 was never referenced. Postgres rejects that with
// "could not determine data type of parameter $1", and the call was `.catch(() => {})` — so every
// feed event failed invisibly forever. Fleet evidence (2026-08-08): 1,815 session_event rows,
// zero with turn_id, and the 'cxell-feed' source never appeared. Observability that cannot be
// told apart from "never shipped" is not observability.
//
// CONTRACT: best-effort, never throws, never blocks the feed (callers fire-and-forget). A failure
// is LOUD — a process-local counter + a logline on every miss — so a silent empty play-by-play
// cannot happen again without a trail.

let _feedOk = 0;
let _feedFail = 0;

/** Process-local counters for the play-by-play writer. Exposed so a test (and ops) can see silence. */
export function feedWriteStats() {
  return { ok: _feedOk, failed: _feedFail };
}

/** Test/ops helper — reset the counters without restarting the process. */
export function resetFeedWriteStats() {
  _feedOk = 0;
  _feedFail = 0;
}

// ── TURN-BUDGET RUNNING TOTAL ──────────────────────────────────────────────────────────────────
// The per-turn running token total, accumulated from the SAME feed stream the queenzee already
// reads (recordFeedEvent). The claude/grok CLI streams carry PER-CALL usage in `stream_event`
// wrappers (message_start = the input/cache-write for one API request, message_delta = the
// output/cache-read for that request); summing them across the turn gives the running total, which
// is what a zee can act on before the vendor ceiling arrives. The `result` event's usage is the
// CUMULATIVE checkpoint for the whole turn — it is NOT a delta, so it is not accumulated here
// (adding it would double-count the per-call events that already summed to it).
//
// The state is process-local, exactly like the feed-write counters: a queenzee restart loses the
// running totals (turns also end on a restart, so this is a minor gap), and the WARNING FIRING is
// what is recorded durably (meta.turn_budget_warning on the turn row), never the transient total.

const _turnBudget = new Map();   // turnId -> { total, warned }
let _budgetWarned = 0;           // process-local count of warnings fired (test/ops visibility)

/** Test/ops visibility into the turn-budget accumulator. */
export function turnBudgetWarningStats() {
  return { fired: _budgetWarned };
}

/** Test/ops helper — reset the accumulator state without restarting the process. */
export function resetTurnBudgetWarningStats() {
  _turnBudget.clear();
  _budgetWarned = 0;
}

/** The current accumulated token total for a turn (0 when nothing has been seen). */
export function turnBudgetRunningTotal(turnId) {
  return turnId ? (_turnBudget.get(turnId)?.total || 0) : 0;
}

// The ONE warning a turn gets. Half the deliverable is the TEXT: it must tell the zee how much of
// the budget it has spent, that the ceiling (not a person) will kill the turn, and what to do —
// commit + land NOW, before starting anything new. A warning the zee cannot act on is noise.
export const turnBudgetWarningMessage = (tokens) =>
  `⚠ TURN BUDGET — this turn has used ~${Math.round(Number(tokens) / 1_000_000)}M tokens `
  + `(${Number(tokens).toLocaleString('en-US')}). Turns in this fleet that run past ~19M tokens DIE: `
  + `the vendor's ceiling cuts the turn — that is the ceiling, not a person and not a rejection of `
  + `your work — and a dead turn takes its unlanded work with it. You are still under the ceiling, `
  + 'so ACT NOW: commit everything that works and land it (`zee land`), then report where you are '
  + '(`zee item --status working --note "…"`). Do NOT begin anything new until what exists is landed.';

// Extract the per-event token usage a feed event contributes to the turn's running total. Handles
// the `stream_event` wrappers the claude/grok streams emit (and the SDK path's SDKPartialAssistantMessage,
// which is the same shape) plus bare message_start/message_delta events. Returns all-zero for
// events that carry no usage — including the `result` event, whose usage is the turn's CUMULATIVE
// total rather than a delta. Pure and never throws.
export function usageFromFeedEvent(event) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!event || typeof event !== 'object') return out;
  const inner = (event.type === 'stream_event' && event.event && typeof event.event === 'object')
    ? event.event
    : event;
  const u = (inner.message && typeof inner.message === 'object' ? inner.message.usage : null) || inner.usage;
  if (!u || typeof u !== 'object') return out;
  if (inner.type === 'message_start') {
    out.input = Number(u.input_tokens || 0) || 0;
    out.cacheWrite = Number(u.cache_creation_input_tokens || 0) || 0;
  } else if (inner.type === 'message_delta') {
    out.output = Number(u.output_tokens || 0) || 0;
    out.cacheRead = Number(u.cache_read_input_tokens || 0) || 0;
  }
  return out;
}

// Accumulate one feed event's tokens into a turn's running total, and fire the ONE warning when the
// running total crosses TURN_BUDGET_WARNING_TOKENS. Returns the warnTurnBudget promise when the
// warning fires (so a caller that AWAITS recordFeedEvent sees the row update deterministically), or
// null otherwise. NEVER throws — the feed must never depend on the budget.
//
// The `result` event is deliberately NOT accumulated (usageFromFeedEvent returns all-zero for it):
// its usage is the turn's CUMULATIVE checkpoint, and it arrives at the very END of the turn — too
// late to warn a zee, and "warning" a zee whose turn just ended (to land NOW) would be noise at
// best and a false alarm at worst. The warning is for the LIVE stream: message_start (this request's
// input + cache writes) and message_delta (this request's output + cache reads), summed across every
// request the turn makes.
async function accumulateTurnBudget(turnId, xellId, event) {
  if (!turnId || !event) return null;
  const u = usageFromFeedEvent(event);
  const tokens = (u.input + u.output + u.cacheRead + u.cacheWrite) || 0;
  if (!tokens) return null;
  const st = _turnBudget.get(turnId) || { total: 0, warned: false };
  st.total += tokens;
  _turnBudget.set(turnId, st);
  if (st.total >= TURN_BUDGET_WARNING_TOKENS && !st.warned) {
    st.warned = true; // in-memory one-shot — a second crossing this turn cannot re-fire
    _budgetWarned += 1;
    return warnTurnBudget(turnId, xellId, st.total);
  }
  return null;
}

// Record the turn-budget warning on the turn row (durably, so the threshold can be tuned against
// outcomes) and tell the zee to land. The UPDATE's WHERE `meta->'turn_budget_warning' IS NULL`
// makes the DB write a one-shot even if two processes race a turn — a turn can never be warned
// twice. NEVER throws, and NEVER ends the turn: the ceiling does that, our job is only to warn
// before it arrives. Returns { fired:true, tokens } (so the caller can assert it happened).
async function warnTurnBudget(turnId, xellId, tokens) {
  try {
    await q(
      `UPDATE zee_turn SET meta = meta || $2::jsonb
        WHERE id = $1 AND meta->'turn_budget_warning' IS NULL`,
      [turnId, JSON.stringify({ turn_budget_warning: { fired: true, tokens: Number(tokens) || 0 } })]);
  } catch (e) {
    logline('turn', `could not record turn-budget warning for turn ${String(turnId).slice(0, 8)} `
      + `(${String(e.message).slice(0, 120)})`);
  }
  try {
    // Dynamic import to avoid a require cycle: nudge.js imports startTurn/endTurn/lastAssistantText
    // from THIS module, so a static import here would be circular. The nudge is best-effort — a zee
    // with no live cxell (viewer_kind !== 'ssh-terminal') is refused by sendMessageToXell, which is
    // the correct behaviour for a turn whose warning cannot be typed anywhere.
    const { nudgeXellForTurnBudget } = await import('../queenzee/nudge.js');
    await nudgeXellForTurnBudget(xellId, { tokens: Number(tokens) || 0, by: 'queenzee' });
  } catch (e) {
    logline('turn', `could not nudge the zee about the turn-budget warning (${String(e.message).slice(0, 120)})`);
  }
  return { fired: true, tokens: Number(tokens) || 0 };
}

/**
 * Persist one stream-json feed event against a turn. Skips system/init noise (same filter the
 * original inline INSERT used). Returns the inserted row, or null when skipped/failed.
 *
 * @param {{ turnId: string, zeeId?: string, xellId?: string, event: object, sessionId?: string }} args
 */
export async function recordFeedEvent({ turnId, zeeId = null, xellId = null, event = null, sessionId = null } = {}) {
  if (!turnId || !event?.type || event.type === 'system') return null;
  // TURN BUDGET — count this event's tokens toward the turn's running total and warn ONCE when the
  // threshold crosses. Best-effort, never throws, and NEVER ends the turn: the vendor's ceiling does
  // that; our job is to warn a zee before it arrives so it can land what it has. Awaited here so a
  // caller that awaits recordFeedEvent sees the warning's row update deterministically — the live
  // feed callers (intake.js) fire-and-forget, so this never blocks a stream.
  await accumulateTurnBudget(turnId, xellId, event);
  const toolName = event.type === 'assistant'
    && event.message?.content?.[0]?.type === 'tool_use'
    ? (event.message.content[0].name || null)
    : null;
  try {
    // $1..$8 contiguous — do NOT start at $2 with a literal source. Postgres cannot type an
    // unreferenced $1 and the insert then fails every time (the fleet-empty play-by-play bug).
    // The persisted raw is ENRICHED with the thinking/conversation classification
    // (classifyAssistantEvent) so a reader — the mobile chat's conversation view, the console's
    // event log — can tell the model's reasoning from its actual output WITHOUT re-parsing.
    const enriched = { ...event, capture: classifyAssistantEvent(event) };
    const row = await one(
      `INSERT INTO session_event
         (source, hook_event_name, zee_id, xell_id, turn_id, claude_session_id, tool_name, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, ts, source, hook_event_name, turn_id, zee_id, xell_id, tool_name`,
      ['cxell-feed', event.type, zeeId || null, xellId || null, turnId,
       event.session_id || sessionId || null, toolName,
       JSON.stringify(enriched)]);
    _feedOk += 1;
    return row;
  } catch (e) {
    _feedFail += 1;
    logline('turn', `play-by-play write FAILED (#${_feedFail} total, ok=${_feedOk}): `
      + `${String(e.message).slice(0, 160)}`);
    return null;
  }
}

export default {
  startTurn, endTurn, turnsForXell, eventsForTurn, conversationForXell,
  classifyAssistantEvent, extractCaptureFromEvent,
  recordFeedEvent, feedWriteStats, resetFeedWriteStats,
  TURN_BUDGET_WARNING_TOKENS, turnBudgetWarningMessage, usageFromFeedEvent,
  turnBudgetRunningTotal, turnBudgetWarningStats, resetTurnBudgetWarningStats,
  TURN_KIND, TURN_STATUS,
};
