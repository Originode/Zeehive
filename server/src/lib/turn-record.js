// RECORD A TURN BOUNDARY ON THE ZEE ROW — and on the zee row ONLY.
//
// One writer, because there are now three kinds of turn and every one of them must be written the
// same way or the fleet's instruments disagree:
//
//   • a SPAWNED turn      — queenzee/intake.js, which owns the whole zee lifecycle around it;
//   • a RESUMED turn      — queenzee/nudge.js (a landing approved, a message, a runway cleared, a
//                           post-ship reflection, a fleet resume);
//   • an INTERACTIVE turn — one a human or a manager started by TYPING into the cage's pane, which
//                           the queenzee does not start and therefore cannot observe. The cage
//                           reports its own boundaries through `zee turn` (queenzee/self.js).
//
// THE ZEE ROW ONLY — deliberately NOT lib/status.js setZeeStatus, whose job includes mirroring the
// status onto the XELL. A zee resumed (or typed at) after proposing done sits in a xell whose status
// is 'awaiting-done', and mirroring 'working' over that would delete a decision a human is holding —
// which is precisely the situation the original report came from (the worker had proposed done).
// hiveStatus already ranks awaiting-done above plain activity, so the hexagon keeps saying done?
// while the crew view correctly says working. That rule is why this is a separate writer rather than
// a flag on setZeeStatus, and it must not be "unified" back without answering the held-decision case.
//
// THE BURN RIDES WITH IT, in the same statement, because a turn's cost belongs to the same event as
// its end (TKT-60): one UPDATE, one broadcast, no window in which a row says idle at last turn's
// price. It ADDS where intake ASSIGNS, and that difference is the point — intake writes the FIRST
// turn onto a fresh row (0 + t == t), while every later turn lands on a row that already carries the
// earlier ones. `cost_usd = cost_usd + $` is what makes the row the zee's LIFETIME burn, which is
// what its readers already assume: lib/fleet.js sums these columns across a xell's zees and calls
// the result "the xell's whole burn", and lib/ops-review.js sums them across the fleet.
//
// Each turn is counted ONCE: intake's UPDATE answers for the spawn's exec, nudge's for the resume's,
// and no turn goes through both. An interactive turn passes no burn at all — the cage's hook knows a
// turn happened, not what it cost (see queenzee/self.js selfTurn, which says so plainly).
//
// Never throws, and never resurrects a decommissioned row (the reaper's ghost-row rule).
import { one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { codenameFor } from './names.js';
import { scrubSecrets } from './provider-tokens.js';
import { MID_TURN_STATUSES } from './zee-turn.js';

// The marker a turn whose usage the provider never reported carries in last_stop_reason. Zeros must
// mean "measured zero", never "we could not read the meter" (TKT-99-1390): a zee that ran real turns
// but whose result carried no total_cost_usd/usage is not free, and a plain 'end_turn' next to
// cost=0/tokens=0 reads exactly like a zee that never ran. Appended by markZeeTurn when the burn is
// unmetered, and reused by intake's spawned-turn paths for the same reason.
export const UNMETERED_SUFFIX = ' (usage unreported)';

// The stop reason a turn that reported no usage deserves. `base` is what the turn actually ended as
// ('end_turn', or an error message — a 429 still spent tokens we cannot count). The suffix rides on
// either; it changes no classifier (neither classifyStopReason nor classifyTurnDeath matches it).
export function turnStopReason(base, metered) {
  if (metered) return base;
  const s = String(base ?? 'end_turn');
  return s.includes(UNMETERED_SUFFIX) ? s : `${s}${UNMETERED_SUFFIX}`;
}

export async function markZeeTurn(zeeId, status, stopReason = null, burn = null) {
  const b = burn || { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // A stop reason can echo the provider's raw error — scrub token-shaped substrings at the FIRST
  // write of zee.last_stop_reason (finding [10] of the credential-injection review), so the row
  // broadcast to the console never carries a key. markZeeTurn is one of the shared turn writers.
  if (stopReason) stopReason = scrubSecrets(stopReason);
  // A turn whose usage the provider never reported is booked with the explicit marker rather than
  // a plain 'end_turn' beside zeros — the signature that misread a live worker as "never ran".
  if (b.metered === false) stopReason = turnStopReason(stopReason, false);
  try {
    const row = await one(
      // Both casts are load-bearing: $2 is read as a zee_status here and as text one line down, and
      // postgres refuses to deduce two types for one parameter ("inconsistent types deduced for
      // parameter $2") — which this helper would then swallow into its catch, leaving every row
      // exactly as silent as before the fix.
      `UPDATE zee
          SET status = $2::zee_status, last_event_at = now(),
              name = CASE WHEN $2::text = 'working' THEN COALESCE(name, $4) ELSE NULL END,
              last_stop_reason = COALESCE($3, last_stop_reason),
              cost_usd           = cost_usd           + $5,
              input_tokens       = input_tokens       + $6,
              output_tokens      = output_tokens      + $7,
              cache_read_tokens  = cache_read_tokens  + $8,
              cache_write_tokens = cache_write_tokens + $9
        WHERE id = $1 AND decommissioned_at IS NULL RETURNING *`,
      [zeeId, status, stopReason, codenameFor(zeeId),
       b.cost, b.input, b.output, b.cacheRead, b.cacheWrite]);
    if (row) broadcast('zee', row);
    return row;
  } catch (e) {
    logline('turn', `could not record the turn on zee ${String(zeeId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
    return null;
  }
}

// THE TURN LOCK — ONE RUNNING TURN PER ZEE, MADE A FACT RATHER THAN AN INTENTION (TKT-114-B).
//
// The zee row's status IS the lock: a turn is live in 'spawning'/'online'/'working' (MID_TURN_STATUSES,
// imported from lib/zee-turn.js — deliberately by reference so the two cannot drift). Claiming a turn
// is ONE conditional UPDATE: postgres re-evaluates the WHERE against the latest committed row when two
// claims race, so exactly one wins and the loser gets null back. That is the whole serialization —
// before this, a resume read the row, saw 'idle', and blindly wrote 'working' (markZeeTurn has no
// status guard), so two concurrent resumes of one zee both proceeded and ran the same session twice:
// the ten resumes in eleven minutes (TKT-114) produced two commits in a worker's cage that no run of
// its session ever authored.
//
// A successful claim ALSO clears a pending revive schedule (revive_next_at). If the zee is being
// resumed by anything other than the reviver — a message, a landing approval, a fleet resume — the
// reviver's schedule is now stale: the turn it would have revived is being continued by THIS one, and
// a later revive would wake the zee a SECOND time with a stale "your turn was cut" story. (When the
// claim IS the revive, reviveTick has already cleared the schedule, so the clear is a no-op.)
//
// `why` becomes last_stop_reason exactly as markZeeTurn('working') used it. Returns the zee row on a
// successful claim, or null when a turn is already in flight. Never throws.
export async function claimZeeTurn(zeeId, why = 'resumed turn') {
  try {
    const row = await one(
      `UPDATE zee
          SET status = 'working', last_event_at = now(),
              last_stop_reason = COALESCE($2, last_stop_reason),
              name = COALESCE(name, $3),
              revive_next_at = NULL
        WHERE id = $1 AND decommissioned_at IS NULL
          AND status NOT IN ('spawning','online','working')
        RETURNING *`,
      [zeeId, why, codenameFor(zeeId)]);
    if (row) broadcast('zee', row);
    return row;
  } catch (e) {
    logline('turn', `could not claim the turn on zee ${String(zeeId).slice(0, 8)} (${String(e.message).slice(0, 120)})`);
    return null;
  }
}
