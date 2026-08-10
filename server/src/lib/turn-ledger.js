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

/**
 * Persist one stream-json feed event against a turn. Skips system/init noise (same filter the
 * original inline INSERT used). Returns the inserted row, or null when skipped/failed.
 *
 * @param {{ turnId: string, zeeId?: string, xellId?: string, event: object, sessionId?: string }} args
 */
export async function recordFeedEvent({ turnId, zeeId = null, xellId = null, event = null, sessionId = null } = {}) {
  if (!turnId || !event?.type || event.type === 'system') return null;
  const toolName = event.type === 'assistant'
    && event.message?.content?.[0]?.type === 'tool_use'
    ? (event.message.content[0].name || null)
    : null;
  try {
    // $1..$8 contiguous — do NOT start at $2 with a literal source. Postgres cannot type an
    // unreferenced $1 and the insert then fails every time (the fleet-empty play-by-play bug).
    const row = await one(
      `INSERT INTO session_event
         (source, hook_event_name, zee_id, xell_id, turn_id, claude_session_id, tool_name, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, ts, source, hook_event_name, turn_id, zee_id, xell_id, tool_name`,
      ['cxell-feed', event.type, zeeId || null, xellId || null, turnId,
       event.session_id || sessionId || null, toolName,
       JSON.stringify(event)]);
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
  startTurn, endTurn, turnsForXell, eventsForTurn,
  recordFeedEvent, feedWriteStats, resetFeedWriteStats,
  TURN_KIND, TURN_STATUS,
};
