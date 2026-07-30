// FLEET PAUSE — the state half of the operator's pause/play switch (the fan-out is
// queenzee/pause.js; the table and the argument for a durable flag are in migration 100).
//
// This module is deliberately a LEAF: it imports the db and the log bus and nothing else. Everything
// that can start or continue a zee's turn has to ask it — nudge.js (landing/clearance/reflection
// resumes, operator messages, manager→worker talk), intake.js (dispatch/spawn), the console read
// models — and a leaf is what makes that safe to import from all of them without an import cycle.
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
       paused_by  = CASE WHEN EXCLUDED.paused THEN EXCLUDED.paused_by ELSE NULL END,
       reason     = CASE WHEN EXCLUDED.paused THEN EXCLUDED.reason ELSE NULL END,
       resumed_at = CASE WHEN EXCLUDED.paused THEN NULL ELSE now() END,
       resumed_by = CASE WHEN EXCLUDED.paused THEN NULL ELSE EXCLUDED.paused_by END
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
