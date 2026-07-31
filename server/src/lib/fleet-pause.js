// FLEET PAUSE — the state half of the operator's pause/play switch (the fan-out is
// queenzee/pause.js; the table and the argument for a durable flag are in migration 100).
//
// This module manages THREE levels of pause:
//   1. FLEET-WIDE (fleet_pause table, migration 100) — stops EVERY xell in every project.
//   2. PER-PROJECT (project_pause table, migration 101) — stops every xell in ONE project.
//   3. PER-XELL (session_event 'xell-pause'/'xell-resume', migration 101) — stops ONE xell.
//
// A xell is "paused" if ANY of these three levels says so. The hive_status derivation AND every
// gate (dispatch, nudge, ...) check all three.
//
// WHY A CACHE. `paused` is read on hot paths (every spawn, every nudge, every fleet snapshot) and the
// meta-DB is on a NAS: a blocking round-trip per read is exactly the kind of cost that gets a guard
// "optimised" back out again. So the flag is cached for a second and the cache is INVALIDATED by the
// writers here, which means a pause takes effect immediately for anything going through this process
// (the single-queenzee lock in index.js guarantees there is only one). The TTL is the backstop for a
// row changed underneath us — `psql`, a test, a second process that should not exist.
//
// AND WHY IT FAILS OPEN. A read that throws returns the LAST KNOWN value (false at boot). Failing
// closed would mean a NAS blip silently paused the fleet — every dispatch refused, every landing nudge
// swallowed — which is a far worse failure than one turn starting during an outage, and it would be
// reported as "zeehive stopped working" with nothing in the log to explain it.
import { one } from '../db/pool.js';
import { logline } from './logbus.js';

let cached = { paused: false, at: 0 };
const TTL_MS = 1000;

// The whole row, uncached — for the console/API read model and for anything that needs the receipt
// (who paused it, when, why, and what the last fan-out reached). Never throws: a read model that
// cannot answer must not take a route down with it (see the note on GET /api/fleet).
export async function pauseState() {
  try {
    const r = await one(`SELECT * FROM fleet_pause WHERE id = true`);
    // No row (a database older than migration 100) is honestly "not paused", not an error.
    if (!r) return { paused: false, since: null, by: null, reason: null, interrupted: 0, unreachable: 0, nudged: 0, resumed_at: null, resumed_by: null };
    cached = { paused: !!r.paused, at: Date.now() };
    return {
      paused: !!r.paused,
      since: r.paused ? r.paused_at : null,
      by: r.paused ? r.paused_by : null,
      reason: r.paused ? r.reason : null,
      interrupted: r.interrupted || 0,
      unreachable: r.unreachable || 0,
      nudged: r.nudged || 0,
      resumed_at: r.resumed_at || null,
      resumed_by: r.resumed_by || null,
    };
  } catch (e) {
    logline('pause', `could not read the pause flag (${String(e.message).slice(0, 120)}) — answering with the last known value (${cached.paused ? 'PAUSED' : 'running'})`);
    return { paused: cached.paused, since: null, by: null, reason: null, interrupted: 0, unreachable: 0, nudged: 0, resumed_at: null, resumed_by: null, stale: true };
  }
}

// The hot-path question: may a turn start right now? Cached (see above) and never throws.
export async function fleetPaused() {
  if (Date.now() - cached.at < TTL_MS) return cached.paused;
  try {
    const r = await one(`SELECT paused FROM fleet_pause WHERE id = true`);
    cached = { paused: !!r?.paused, at: Date.now() };
  } catch (e) {
    // Keep the last known value AND keep the timestamp stale, so the next call retries rather than
    // caching an outage's answer for a second at a time.
    logline('pause', `pause-flag read failed (${String(e.message).slice(0, 120)}) — carrying on as ${cached.paused ? 'PAUSED' : 'running'}`);
  }
  return cached.paused;
}

// One sentence for every gate that refuses because of the pause. Same wording everywhere on purpose:
// an operator who sees this in a dispatch error, in a log line and in a zee's `zee status` should not
// have to work out that they are the same thing.
// The marker written to `last_stop_reason` on a zee whose turn the pause ENDED — the column whose
// entire meaning is "why did this zee's turn stop". It lives here, with the state, because three
// modules need it and none of them should own it: queenzee/pause.js writes it when it interrupts a
// cage and reads it to decide who PLAY calls back (waking a zee that had legitimately finished, or one
// waiting on a human gate, would be a pause with side effects); intake.js writes it when the headless
// run it spawned dies under the interrupt, so the turn is not filed as 'errored'; fleet.js reads it to
// show the hexagon as paused rather than as merely idle.
export const PAUSED_STOP_REASON = 'fleet-paused';

export const PAUSED_REASON = 'the fleet is PAUSED — every zee was interrupted by the console\'s pause button. '
  + 'Press play to resume, then try again.';

// Set the flag. Returns the updated row. THROWS — unlike the reads, a write that failed must not be
// reported as a pause that happened (that is the "operator believes the fleet is stopped" failure).
export async function setPaused(paused, { by = 'human@console', reason = null } = {}) {
  const r = await one(
    `INSERT INTO fleet_pause (id, paused, paused_at, paused_by, reason, resumed_at, resumed_by)
          VALUES (true, $1,
                  CASE WHEN $1 THEN now() ELSE NULL END,
                  CASE WHEN $1 THEN $2::text ELSE NULL END,
                  CASE WHEN $1 THEN $3::text ELSE NULL END,
                  CASE WHEN $1 THEN NULL ELSE now() END,
                  CASE WHEN $1 THEN NULL ELSE $2::text END)
     ON CONFLICT (id) DO UPDATE SET
       paused     = EXCLUDED.paused,
       paused_at  = CASE WHEN EXCLUDED.paused THEN COALESCE(fleet_pause.paused_at, now()) ELSE NULL END,
       paused_by  = CASE WHEN EXCLUDED.paused THEN $2::text ELSE NULL END,
       reason     = CASE WHEN EXCLUDED.paused THEN $3::text ELSE NULL END,
       resumed_at = CASE WHEN EXCLUDED.paused THEN NULL ELSE now() END,
       -- $2 DIRECTLY, not EXCLUDED.paused_by. EXCLUDED carries the row this statement would have
       -- INSERTED, and that row's paused_by is itself "CASE WHEN paused THEN $2 ELSE NULL" — so on a
       -- resume it is NULL, and reading it back here recorded every play as done by nobody. The
       -- parameters are in scope in ON CONFLICT; the derived column is the wrong place to read them from.
       resumed_by = CASE WHEN EXCLUDED.paused THEN NULL ELSE $2::text END
     RETURNING *`,
    [!!paused, by, reason]);
  cached = { paused: !!r?.paused, at: Date.now() };
  return r;
}

// Record what a fan-out actually reached. Separate from setPaused because the counts are only known
// AFTER the flag moved: pause sets the flag first (so nothing starts while we walk the fleet), then
// walks it, then writes the receipt.
export async function setPauseCounts({ interrupted = null, unreachable = null, nudged = null } = {}) {
  return one(
    `UPDATE fleet_pause SET
       interrupted = COALESCE($1, interrupted),
       unreachable = COALESCE($2, unreachable),
       nudged      = COALESCE($3, nudged)
     WHERE id = true RETURNING *`, [interrupted, unreachable, nudged]).catch(() => null);
}

// Test/boot hook: forget the cached answer so the next read hits the row.
export function forgetPauseCache() { cached = { paused: cached.paused, at: 0 }; }

// ── A HELD WAKE-UP IS NOT A DISCARDED ONE ─────────────────────────────────────────────────────────
//
// The hole this closes, found reading the diff back rather than in the field: a zee's turn ENDS at
// `zee land`, so a zee waiting on a landing is not mid-turn and the pause does not interrupt it — it
// has nothing to interrupt. But a human at the console can keep deciding while the fleet is stopped,
// and every one of those decisions reaches its zee through a NUDGE, which the pause refuses. So:
// approve zee A's landing during a pause and its "you are on main, carry on" is refused; main moves,
// zee B's approved sha can no longer fast-forward and goes stale, and its recovery nudge is refused
// too — and neither zee is marked as interrupted, so play would not call either of them back. Two
// zees stranded, silently, by a button whose entire promise is that nothing is lost.
//
// So a refused nudge is RECORDED against the xell, and play calls back everything with one. It rides
// the append-only session_event log like tend / the hints / a refused ship (the dev schema is frozen,
// and this is the same shape: an open state, latest-event-wins) rather than adding a table.
//
// It does NOT store the prompt. Re-delivering four different held prompts per xell would be a second,
// divergent copy of the ones in nudge.js — and the resume prompt already answers all of them the only
// way that cannot go stale: it sends the zee to `zee status`, which reports the landing, the ship, the
// tend and the inbox as they are NOW rather than as they were when the nudge was refused.
export const NUDGE_HELD = 'nudge-held';
export const NUDGE_HELD_CLEAR = 'nudge-held-clear';

// ── PER-PROJECT PAUSE (project_pause table) ────────────────────────────────────────────────────────

// Read the project pause row. A missing row reads as "not paused".
export async function projectPauseState(projectId) {
  if (!projectId) return { paused: false, by: null, reason: null };
  try {
    const r = await one(`SELECT * FROM project_pause WHERE project_id = $1`, [projectId]);
    if (!r) return { paused: false, by: null, reason: null };
    return {
      paused: !!r.paused,
      since: r.paused ? r.paused_at : null,
      by: r.paused ? r.paused_by : null,
      reason: r.paused ? r.reason : null,
      interrupted: r.interrupted || 0,
      unreachable: r.unreachable || 0,
      nudged: r.nudged || 0,
    };
  } catch (e) {
    logline('pause', `could not read project pause (${String(e.message).slice(0, 120)}) — answering not paused`);
    return { paused: false, by: null, reason: null };
  }
}

// Set the project pause flag. Returns the updated row.
export async function setProjectPaused(projectId, paused, { by = 'human@console', reason = null } = {}) {
  if (!projectId) throw new Error('projectId is required');
  const r = await one(
    `INSERT INTO project_pause (project_id, paused, paused_at, paused_by, reason, resumed_at, resumed_by)
          VALUES ($1, $2,
                  CASE WHEN $2 THEN now() ELSE NULL END,
                  CASE WHEN $2 THEN $3::text ELSE NULL END,
                  CASE WHEN $2 THEN $4::text ELSE NULL END,
                  CASE WHEN $2 THEN NULL ELSE now() END,
                  CASE WHEN $2 THEN NULL ELSE $3::text END)
     ON CONFLICT (project_id) DO UPDATE SET
       paused     = EXCLUDED.paused,
       paused_at  = CASE WHEN EXCLUDED.paused THEN COALESCE(project_pause.paused_at, now()) ELSE NULL END,
       paused_by  = CASE WHEN EXCLUDED.paused THEN $3::text ELSE NULL END,
       reason     = CASE WHEN EXCLUDED.paused THEN $4::text ELSE NULL END,
       resumed_at = CASE WHEN EXCLUDED.paused THEN NULL ELSE now() END,
       resumed_by = CASE WHEN EXCLUDED.paused THEN NULL ELSE $3::text END
     RETURNING *`,
    [projectId, !!paused, by, reason]);
  return r;
}

// Record what a project pause fan-out actually reached.
export async function setProjectPauseCounts(projectId, { interrupted = null, unreachable = null, nudged = null } = {}) {
  if (!projectId) return null;
  return one(
    `UPDATE project_pause SET
       interrupted = COALESCE($2, interrupted),
       unreachable = COALESCE($3, unreachable),
       nudged      = COALESCE($4, nudged)
     WHERE project_id = $1 RETURNING *`, [projectId, interrupted, unreachable, nudged]).catch(() => null);
}

// ── PER-XELL PAUSE (xell_pause_state table, migration 102) ─────────────────────────────────────────
// One row per xell, proper columns (who paused, when, why), readable in a single
// column check. Replaces the session_event approach from migration 101.

// Whether a specific xell is individually paused. Reads the table directly.
export async function isXellPaused(xellId) {
  if (!xellId) return false;
  try {
    const r = await one(`SELECT paused FROM xell_pause_state WHERE xell_id = $1`, [xellId]);
    return !!r?.paused;
  } catch (e) {
    logline('pause', `could not read xell pause for ${String(xellId).slice(0, 8)} (${String(e.message).slice(0, 100)})`);
    return false;
  }
}

// Set a xell's pause state in the meta-DB table. Best-effort, never throws.
export async function setXellPaused(xellId, paused, { by = 'human@console', reason = null } = {}) {
  if (!xellId) return;
  try {
    await one(
      `INSERT INTO xell_pause_state (xell_id, paused, paused_at, paused_by, reason, resumed_at, resumed_by)
            VALUES ($1, $2,
                    CASE WHEN $2 THEN now() ELSE NULL END,
                    CASE WHEN $2 THEN $3::text ELSE NULL END,
                    CASE WHEN $2 THEN $4::text ELSE NULL END,
                    CASE WHEN $2 THEN NULL ELSE now() END,
                    CASE WHEN $2 THEN NULL ELSE $3::text END)
       ON CONFLICT (xell_id) DO UPDATE SET
         paused     = EXCLUDED.paused,
         paused_at  = CASE WHEN EXCLUDED.paused THEN COALESCE(xell_pause_state.paused_at, now()) ELSE NULL END,
         paused_by  = CASE WHEN EXCLUDED.paused THEN $3::text ELSE NULL END,
         reason     = CASE WHEN EXCLUDED.paused THEN $4::text ELSE NULL END,
         resumed_at = CASE WHEN EXCLUDED.paused THEN NULL ELSE now() END,
         resumed_by = CASE WHEN EXCLUDED.paused THEN NULL ELSE $3::text END
       RETURNING *`,
      [xellId, !!paused, by, reason]);
  } catch (e) {
    logline('pause', `could not write xell pause for ${String(xellId).slice(0, 8)} (${String(e.message).slice(0, 100)})`);
  }
}

// ── COMBINED CHECK ─────────────────────────────────────────────────────────────────────────────────
// Is a SPECIFIC xell paused? Checks all three levels: fleet-wide, project-scoped, and per-xell.
// The `xellPausedHint` parameter is an optional pre-resolved per-xell flag (from the fleet query's
// lateral join) to avoid a second round-trip when the caller already has the row.
export async function xellPaused(xell, { xellPausedHint = null } = {}) {
  if (!xell) return false;
  const fleet = await fleetPaused();                           // level 1: fleet-wide
  if (fleet) return true;
  const project = await isProjectPaused(xell.project_id);      // level 2: project-scoped
  if (project) return true;
  if (xellPausedHint === true) return true;                    // level 3: per-xell (pre-resolved)
  if (xellPausedHint === false) return false;
  return await isXellPaused(xell.id);
}

// Quick check: is a project paused? (no caching — called from non-hot paths)
async function isProjectPaused(projectId) {
  if (!projectId) return false;
  try {
    const r = await one(`SELECT paused FROM project_pause WHERE project_id = $1`, [projectId]);
    return !!r?.paused;
  } catch { return false; }
}

// The single human-readable sentence for "the project is paused". Used by every gate that refuses.
export function projectPausedReason(projectName) {
  return `the project ${projectName || 'this project'} is PAUSED — press play to resume.`;
}

// Record that a wake-up for this xell was refused because the fleet is paused. Best-effort and never
// throws: this is bookkeeping on a path that must not fail (nudges are fire-and-forget by contract).
export async function noteHeldNudge(xellId, why = 'nudge') {
  if (!xellId) return false;
  try {
    const { recordEvent } = await import('./status.js');
    await recordEvent({ source: 'queenzee', hook_event_name: NUDGE_HELD, xell_id: xellId, raw: { why } });
    return true;
  } catch (e) {
    logline('pause', `could not record the held nudge for xell ${String(xellId).slice(0, 8)} (${String(e.message).slice(0, 100)}) `
      + '— play may not call that zee back; `zee status` from the zee is still authoritative');
    return false;
  }
}
