// THE SPIN DETECTOR — a per-turn budget the queenzee enforces against the gateway ledger.
//
// A zee waiting on another zee or on a human gate has no suspend primitive, so it spins: the live
// meta-DB measured one spawn turn at 69 gateway calls / 5,003,163 tokens and another at 29 calls,
// none of it progress. The manual already forbids poll loops (never curl your own app in a loop,
// never hand-roll a wait) but nothing ENFORCES it — until this. It is the interim alarm: the
// workflow-rehab programme's lease/await model is the cure, so everything here is deliberately
// self-contained and cheap to remove.
//
// THE SIGNAL IS REPETITION WITHOUT PROGRESS, NOT DURATION. A long honest build/verify turn makes
// many gateway calls too — what it does NOT do is make them all the SAME SIZE with nothing landing,
// reporting or pinging in between. So the detector:
//
//   1. takes the turn's gateway calls (llm_gateway_request, one query per turn_id);
//   2. drops every call BEFORE the turn's last PROGRESS event (a working ping, a tend, a report to
//      its manager, a land request — see PROGRESS_EVENT_NAMES below) — progress RESETS the window;
//   3. calls the remaining window a SPIN only when it clears ALL of: a call floor, a token floor,
//      a similarity bound (largest call ≤ max_size_spread × smallest), and a same-path check.
//
// A turn that is making progress never accumulates a window; a turn whose calls are genuinely
// diverse (context growing as it works) fails the similarity bound. Only a turn that repeats the
// same near-identical call, over and over, with nothing else happening, trips it.
//
// Thresholds are CONFIG, not constants: spin_detector_config (migration 158), scoped
// harness > project > default. The 'default' row and DEFAULT_SPIN_CONFIG below agree, so a database
// without the table behaves identically. See spinConfigFor.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { recordEvent, setTend } from './status.js';
import { endTurn } from './turn-ledger.js';
import { postMessage } from './managers.js';

// The stop reason a spin-ended turn carries — short, so it groups cleanly in a WHERE/GROUP BY and
// reads on a chip. Mirrors PAUSED_STOP_REASON ('fleet-paused').
export const SPIN_STOP_REASON = 'spin-detector';

// The session_event hook_event_names that count as PROGRESS for the "no intervening progress" guard.
// Each is a self verb (or a human/manager driving the pane) that asserts the zee is DOING something
// other than re-sending the same call. Commit is approximated by the verbs that follow one (a land
// request, a report) plus the similarity bound — a turn that is actually committing is changing its
// context, which blows max_size_spread long before the call floor.
export const PROGRESS_EVENT_NAMES = [
  'working-ping',            // zee reported working (`zee working`)
  'tend-request',            // zee raised a human (`zee tend`)
  'ship-refused',            // zee tried to ship (`zee ship`)
  'interactive-turn-start',  // a human/manager typed into the pane (`zee turn --start`)
];

// Sane fleet defaults, and the values the migration's 'default' row ships. A row in
// spin_detector_config overrides these per project / per harness; the two must not drift — the
// migration is the source for the stored copy, this is the source for a database with no rows.
export const DEFAULT_SPIN_CONFIG = {
  enabled: true,
  minCalls: 20,             // gateway calls in the suspect window before we look
  minTokens: 1_000_000,     // total tokens in the suspect window before we look (the 5M measured turn clears both)
  maxSizeSpread: 1.6,       // largest call ≤ 1.6× smallest in the window ⇒ "similar payloads"
  samePath: true,           // every call in the window must share the gateway path
};

// ── the pure verdict ─────────────────────────────────────────────────────────────────────────────
// Decide whether one turn's gateway calls are a spin. `requests` is the turn's llm_gateway_request
// rows (oldest first; path/total_tokens/input_tokens/output_tokens/requested_at are read).
// `lastProgressAt` is the latest progress event for the turn, or null when it never had one. PURE and
// never throws — the loop hands it exactly what the ledger says and trusts the table.
//
// → { spinning, reason, windowCalls, windowTokens, maxSizeRatio, samePath }
//   spinning=false reasons: 'not-enough-calls' | 'not-enough-tokens' | 'not-similar' | 'multiple-paths'
//   spinning=true  reason:  'repetition-without-progress'
export function detectSpin({ requests = [], lastProgressAt = null, cfg = DEFAULT_SPIN_CONFIG } = {}) {
  const c = { ...DEFAULT_SPIN_CONFIG, ...cfg };
  const since = lastProgressAt ? new Date(lastProgressAt).getTime() : -Infinity;
  // pg returns bigint columns as strings — coerce with Number() so the DB and the synthetic tests
  // feed the same shapes.
  const window = (requests || [])
    .filter((r) => r && r.total_tokens != null && Number.isFinite(Number(r.total_tokens)))
    .map((r) => ({
      ...r,
      total_tokens: Number(r.total_tokens),
      input_tokens: r.input_tokens == null ? null : Number(r.input_tokens),
      output_tokens: r.output_tokens == null ? null : Number(r.output_tokens),
    }))
    .filter((r) => !r.requested_at || new Date(r.requested_at).getTime() >= since);

  const windowCalls = window.length;
  const windowTokens = window.reduce((s, r) => s + r.total_tokens, 0);
  if (windowCalls < c.minCalls) {
    return { spinning: false, reason: 'not-enough-calls', windowCalls, windowTokens, maxSizeRatio: 1, samePath: true };
  }

  if (windowTokens < c.minTokens) {
    return { spinning: false, reason: 'not-enough-tokens', windowCalls, windowTokens, maxSizeRatio: 1, samePath: true };
  }

  // "Similar payload sizes": the largest call in the window must be within max_size_spread × the
  // smallest. A poll loop re-sends nearly the same context each time (max/min ≈ 1.0–1.3); a real
  // turn's context GROWS as it works, so its max/min blows past 1.6 long before the call floor. A
  // zero-token call (an errored request) makes the ratio infinite ⇒ NOT similar ⇒ not a spin — an
  // error is a change, and a change is the opposite of repetition.
  //
  // WHAT "SIZE" MEANS. This is the whole reason a working ZEEHIVE turn was misread as a spin.
  // ZEEHIVE zees carry a huge constant context (the manual + skills + task prompt), and the CLI
  // re-sends it on EVERY call. The provider prices that re-sent prefix as cache_read — so
  // total_tokens (= input + output + cache_read + cache_write) is DOMINATED by the near-constant
  // cached prefix. A genuinely working zee that does varied new work shows total_tokens barely
  // moving (measured: max/min 1.05× — comfortably under the 1.6 spread) while its actual new
  // work varies 8×+. The detector therefore measured the WRONG signal: every long-context turn
  // looked "similar-sized" and got ended as a spin. A poll loop, by contrast, sends SMALL amounts
  // of new text (a few hundred tokens of "is it done yet?") over and over. So the metric that
  // separates them is the NEW WORK per call — input_tokens + output_tokens (prompt + completion,
  // the tokens the model actually processes), NOT the cached prefix and NOT the total. cache_read
  // is dropped precisely because it is the constant a working zee re-sends and a poll loop cannot
  // avoid either; cache_write is dropped as a mostly-zero column that would only add noise.
  //
  // A call with NO usage split recorded (input_tokens/output_tokens NULL — an old ledger row or a
  // request that never completed) falls back to total_tokens so it still participates, and a
  // missing-NEW-work call (input+output = 0, e.g. a fully-cached prompt with no completion yet) is
  // treated as "a change" (not-similar) rather than a repetition — an error is a change, and change
  // is the opposite of repetition.
  const workOf = (r) => {
    if (r.input_tokens != null && r.output_tokens != null) return r.input_tokens + r.output_tokens;
    return r.total_tokens;
  };
  let lo = Infinity, hi = 0;
  for (const r of window) {
    const t = workOf(r);
    if (t <= 0) {
      return { spinning: false, reason: 'not-similar', windowCalls, windowTokens, maxSizeRatio: Infinity, samePath: true };
    }
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const maxSizeRatio = hi / lo;
  if (maxSizeRatio > c.maxSizeSpread) {
    return { spinning: false, reason: 'not-similar', windowCalls, windowTokens, maxSizeRatio, samePath: true };
  }

  // "Same path": a poll loop uses one CLI, hence one gateway path (/v1/messages, /v1/chat/completions,
  // /responses). A turn that switched dialects mid-window was doing something different.
  const samePath = c.samePath !== true || new Set(window.map((r) => r.path || '')).size <= 1;
  if (!samePath) {
    return { spinning: false, reason: 'multiple-paths', windowCalls, windowTokens, maxSizeRatio, samePath };
  }

  return { spinning: true, reason: 'repetition-without-progress', windowCalls, windowTokens, maxSizeRatio, samePath };
}

// ── the config lookup (harness > project > default, field-level inheritance) ──────────────────────
// The xell's harness_id and project_id pick the most specific rows; each row's NULL knobs inherit
// from the next less specific scope, and the code defaults are the floor. So a harness that tunes
// ONLY min_calls keeps the project's min_tokens — the model_policy precedent (an omitted field
// inherits from the parent chain). Never throws (a config bug must not kill the sweep).
export async function spinConfigFor({ projectId = null, harnessId = null } = {}) {
  try {
    const rows = [];
    const def = await one(`SELECT * FROM spin_detector_config WHERE scope='default' LIMIT 1`);
    const proj = projectId
      ? await one(`SELECT * FROM spin_detector_config WHERE scope='project' AND project_id=$1`, [projectId])
      : null;
    const har = harnessId
      ? await one(`SELECT * FROM spin_detector_config WHERE scope='harness' AND harness_id=$1`, [harnessId])
      : null;
    if (def) rows.push(def);
    if (proj) rows.push(proj);
    if (har) rows.push(har);

    const out = { ...DEFAULT_SPIN_CONFIG };
    for (const r of rows) {
      if (r.enabled != null) out.enabled = r.enabled;
      // pg returns bigint/numeric columns as strings — coerce so the verdict compares numbers.
      if (r.min_calls != null) out.minCalls = Number(r.min_calls);
      if (r.min_tokens != null) out.minTokens = Number(r.min_tokens);
      if (r.max_size_spread != null) out.maxSizeSpread = Number(r.max_size_spread);
      if (r.same_path != null) out.samePath = r.same_path;
    }
    return out;
  } catch (e) {
    logline('spin', `spinConfigFor failed (${String(e.message).slice(0, 120)}) — using defaults`);
    return DEFAULT_SPIN_CONFIG;
  }
}

// ── the last progress event for a turn ────────────────────────────────────────────────────────────
// Three sources, all cheap indexed probes, latest wins — and all scoped to the XELL + the turn's
// start time, because the self-verb progress events (working-ping, tend-request, …) are recorded
// with xell_id but NOT turn_id (self.js's recordEvent does not carry one). Scoping by xell + ts >
// startedAt is the correct "did anything happen DURING this turn" test:
//   • session_event on this xell whose hook_event_name is a PROGRESS name (a self verb), after start;
//   • zee_message FROM this xell (a report to its manager), after the turn started;
//   • land_request for this xell, after the turn started (asking to land is progress).
// Returns a Date or null. Never throws (a progress probe failing must not fail the sweep).
export async function lastProgressAtForTurn({ xellId = null, startedAt = null } = {}) {
  try {
    let at = null;
    if (xellId && startedAt) {
      const ev = await one(
        `SELECT MAX(ts) AS ts FROM session_event
          WHERE xell_id=$1 AND hook_event_name = ANY($2::text[]) AND ts > $3`,
        [xellId, PROGRESS_EVENT_NAMES, startedAt]);
      if (ev?.ts) at = ev.ts;
      const msg = await one(
        `SELECT MAX(created_at) AS ts FROM zee_message
          WHERE from_xell_id=$1 AND created_at > $2`, [xellId, startedAt]);
      if (msg?.ts && (!at || new Date(msg.ts) > new Date(at))) at = msg.ts;
      const land = await one(
        `SELECT MAX(requested_at) AS ts FROM land_request
          WHERE xell_id=$1 AND requested_at > $2`, [xellId, startedAt]);
      if (land?.ts && (!at || new Date(land.ts) > new Date(at))) at = land.ts;
    }
    return at ? new Date(at) : null;
  } catch (e) {
    logline('spin', `lastProgressAtForTurn failed (${String(e.message).slice(0, 120)}) — treating as no progress`);
    return null;
  }
}

// ── END the spinning turn ─────────────────────────────────────────────────────────────────────────
// Called by the sweep when detectSpin says spinning. Books the end on the zee row and the turn row
// (so the reason is recorded even if the CLI's own completion handler never fires), records a
// session_event with the evidence, and reports to the xell's manager (or raises a tend when there is
// none). NEVER reaps the zee: the cage, the branch, the commits and the containers all stay — a
// human/manager decides what happens to them. The CLI interrupt is the CALLER's job (it is a docker
// exec, gated on PROVISION_MODE); this function only writes the bookkeeping that makes the end a
// fact, and does so BEST-EFFORT (a bookkeeping bug must not take the sweep down).
//
// `burn` is the turn's OWN spend off the gateway ledger ({ cost, input, output, cacheRead,
// cacheWrite }) so the row is honest even when intake's handler never runs. `manager` is the xell
// row of the manager (null → tend instead).
export async function endSpinningTurn({ turn, zee, xell, burn = null, evidence = null, manager = null, by = 'spin-detector' } = {}) {
  const b = burn || { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const reason = 'repeated gateway calls without progress (a poll loop)';
  const summary = `ended by the spin detector — ${reason}`
    + (evidence?.windowCalls != null ? ` (${evidence.windowCalls} calls / ${evidence.windowTokens} tokens in the suspect window)` : '');
  const outcome = { ended: false, alreadyEnded: false, interrupted: false, notified: null };

  try {
    // 1. CLOSE THE TURN FIRST — the act everything else hangs on, and the one that is honest about
    //    whether this was a spin at all. endTurn's WHERE `ended_at IS NULL` (turn-ledger.js) makes it
    //    one-shot: if the turn already ended cleanly between the sweep's SELECT and here, endTurn
    //    returns null and the detector backs off ENTIRELY — no evidence event, no zee marker, no
    //    notification. A turn that is no longer spinning is not a spin, and labelling it as one is
    //    the exact observability lie this feature exists to end (manager finding #2).
    const closed = turn?.id
      ? await endTurn(turn.id, {
          status: 'ended', burn: b, stopReason: SPIN_STOP_REASON, summary,
          meta: { spin_detected: true, ...(evidence || {}) },
        })
      : null;
    if (!closed) {
      if (turn?.id) {
        logline('spin', `turn ${String(turn.id).slice(0, 8)} already ended before the detector could close it — backing off, not labelling`);
      }
      outcome.alreadyEnded = true;
      return outcome;
    }
    outcome.ended = true;

    // 2. THE EVIDENCE — a session_event the console can replay, with the raw numbers. Written AFTER
    //    the close, so a turn that was never actually closed by the detector never gets a false
    //    'spin-detector' event. The turn row above already carries the why (stop_reason + summary +
    //    meta); this is the replayable copy.
    await recordEvent({
      source: by, hook_event_name: 'spin-detector',
      zee_id: zee?.id || null, xell_id: xell?.id || null, turn_id: turn.id,
      raw: { reason, ...(evidence || {}), stop_reason: SPIN_STOP_REASON },
    });

    // 3. The ZEE row: idle + SPIN_STOP_REASON. This is the marker a completion handler (intake.js)
    //    can cross-check against the TURN row to preserve a spin end instead of filing the killed CLI
    //    as a provider error. The burn is NOT booked here — intake is the authoritative burn booker
    //    for a spawned turn, and booking it twice would overstate the zee's lifetime burn.
    //    `decommissioned_at IS NULL` is the same guard markZeeTurn/claimZeeTurn carry: a zee reaped
    //    between the sweep's SELECT and this UPDATE must not have its status resurrected (the reaper
    //    keeps whatever status it stopped in, and a reaped zee is nobody's to wake).
    if (zee?.id) {
      await q(
        `UPDATE zee SET status='idle', last_event_at=now(), last_stop_reason=$2, name=NULL
          WHERE id=$1 AND decommissioned_at IS NULL`,
        [zee.id, SPIN_STOP_REASON]).catch((e) => logline('spin', `could not idle zee ${String(zee.id).slice(0, 8)} (${String(e.message).slice(0, 100)})`));
    }

    // 4. REPORT to the manager, or raise a TEND when there is none. The notification is the point of
    //    the card: a runaway turn burns tokens invisibly until a human happens to look, and this is
    //    the line that makes it visible.
    if (manager?.id) {
      try {
        const r = await postMessage({
          from: null, to: manager, kind: 'report', by,
          body: `${xell?.slug || String(xell?.id || '').slice(0, 8)} was spinning and its turn was ENDED. `
            + `${summary}. The zee is idle (stop_reason=${SPIN_STOP_REASON}) and NOT reaped — its cage, branch `
            + 'and commits are intact. It was waiting on something that never came (a poll loop); re-task it, '
            + 'resume it with a real instruction, or mark it done.',
        });
        outcome.notified = { kind: 'manager', ok: !!r?.ok };
      } catch (e) {
        logline('spin', `could not message manager of ${xell?.slug} (${String(e.message).slice(0, 120)})`);
        outcome.notified = { kind: 'manager', ok: false, error: String(e.message).slice(0, 120) };
      }
    } else if (xell?.id) {
      try {
        await setTend(xell.id, true, { reason: summary, source: by });
        outcome.notified = { kind: 'tend', ok: true };
      } catch (e) {
        logline('spin', `could not raise a tend for ${xell?.slug} (${String(e.message).slice(0, 120)})`);
        outcome.notified = { kind: 'tend', ok: false, error: String(e.message).slice(0, 120) };
      }
    }
  } catch (e) {
    logline('spin', `endSpinningTurn failed for ${xell?.slug || turn?.id}: ${String(e.message).slice(0, 160)}`);
  }
  return outcome;
}

export default { SPIN_STOP_REASON, PROGRESS_EVENT_NAMES, DEFAULT_SPIN_CONFIG, detectSpin, spinConfigFor, lastProgressAtForTurn, endSpinningTurn };
