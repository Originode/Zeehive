// PAUSE / PLAY — the fleet-wide stop button, and the call back to work.
//
// One human act, two fan-outs:
//
//   PAUSE  raise the flag, then SIGINT the headless turn in every live cxell — workers and MANAGER
//          zees alike (a manager left running would keep dispatching, messaging and re-tasking a crew
//          that had been stopped, which is not a paused fleet, it is a confused one).
//   PLAY   lower the flag, then RESUME exactly the zees this pause interrupted, with a prompt that
//          says what happened (queenzee/nudge.js RESUMED_PROMPT).
//
// ORDER IS THE WHOLE THING, in both directions:
//   • the flag goes UP BEFORE the walk. The queenzee is a set of loops that start turns on their own
//     (a landing lands → nudge, a runway clears → re-call, a ship succeeds → reflect, a human
//     dispatches); raising the flag first is what stops the fleet from re-waking behind the sweep.
//   • the flag comes DOWN BEFORE the resume walk, because the resume is itself a turn start and would
//     otherwise be refused by the gate it just lifted.
//
// WHAT IT DOES NOT TOUCH: nothing in a workspace, no commit, no branch, no request, no gate, no
// container. A pause costs a zee the remainder of its turn and nothing else — which is exactly why it
// can be a button rather than a ceremony.
import { q, one } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { broadcast } from '../lib/events.js';
import { cxellName, interruptCxellZee, cxellHeadlessActive } from '../lib/cxell.js';
import { setPaused, setPauseCounts, pauseState, PAUSED_STOP_REASON,
         NUDGE_HELD, NUDGE_HELD_CLEAR,
         setProjectPaused, setProjectPauseCounts, projectPauseState,
         setXellPaused } from '../lib/fleet-pause.js';
import { recordEvent } from '../lib/status.js';
import { nudgeXellForFleetResume } from './nudge.js';

// Same switch every other real-side-effect module reads (nudge, landgate, xellgit, harness, reaper):
// 'real' touches machines, anything else models. An interrupt is a `docker exec cxell_<slug> pkill`
// and the slug comes off a fleet row — which, in a NESTED queenzee running against a CLONE of the
// meta-DB, is another zee's live cage, mid-task, on work this instance knows nothing about. So a
// non-real queenzee reports what it WOULD have stopped and execs nothing. The flag still moves: the
// pause is honest about being a model of one, and the gates it drives (dispatch, nudges) are this
// instance's own behaviour, which is real either way.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// Every xell with a LIVE cxell zee, optionally filtered by project or by xell id.
// `viewer_kind='ssh-terminal'` is this repo's definition of "the cage is still up" (nudge.js uses the
// same test), and the newest zee per xell is the one that owns it.
// Passing neither returns ALL live cxell zees (fleet-wide).
async function liveCxellZees(projectId = null, xellId = null) {
  const conditions = ['z.entrypoint = \'cxell-cli\'', 'z.viewer_kind = \'ssh-terminal\'',
                      'z.decommissioned_at IS NULL', 'x.status NOT IN (\'retired\',\'tearing-down\')'];
  const params = [];
  let pIdx = 1;
  if (projectId) { conditions.push(`x.project_id = $${pIdx++}`); params.push(projectId); }
  if (xellId) { conditions.push(`x.id = $${pIdx++}`); params.push(xellId); }
  return q(
    `SELECT DISTINCT ON (x.id)
            x.id AS xell_id, x.slug, x.status AS xell_status, x.project_id,
            COALESCE(x.zee_type, 'worker') AS zee_type,
            z.id AS zee_id, z.status AS zee_status, z.last_stop_reason,
            -- Did a wake-up for this xell get REFUSED while the flag was up? (lib/fleet-pause.js
            -- noteHeldNudge — a landing approved, a sha gone stale, a runway cleared, a ship to
            -- reflect on, all decided by a human during the pause.) Latest-event-wins, the same ride
            -- tend and the hints take.
            (SELECT se.hook_event_name FROM session_event se
               WHERE se.xell_id = x.id AND se.hook_event_name IN ($1, $2)
               ORDER BY se.ts DESC LIMIT 1) = $1 AS nudge_held
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY x.id, z.created_at DESC`, [NUDGE_HELD, NUDGE_HELD_CLEAR, ...params]);
}

// Run `fn` over `items` a few at a time. A fleet can hold dozens of cages and each interrupt is a
// docker exec: all-at-once floods the daemon, one-at-a-time makes the operator watch a progress bar
// they did not ask for. Never rejects — a thrown item becomes its own result via `fn`.
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

// ── PAUSE ─────────────────────────────────────────────────────────────────────────────────────────
// Returns the receipt the console renders: the state, and one row per xell saying what happened to
// it. `interrupted` counts zees that were genuinely mid-turn; `idle` ones had no turn to stop (a
// success — they are not working); `stuck` and `failed` are the ones an operator must know about,
// because a pause that quietly left a zee running is the one outcome this must never claim.
// ── PROJECT-SCOPED PAUSE ───────────────────────────────────────────────────────────────────────────
// Like pauseFleet but scoped to ONE project's xells. Same interrupt mechanism, same receipt shape.
export async function pauseProject(projectId, { by = 'human@console', reason = null } = {}) {
  const row = await setProjectPaused(projectId, true, { by, reason });
  logline('pause', `PROJECT ${String(projectId).slice(0, 8)} PAUSED by ${by}${reason ? ` — ${reason}` : ''}: no new work in this project`);

  const zees = await liveCxellZees(projectId);
  const results = await inBatches(zees, 6, async (z) => {
    if (PROVISION_MODE !== 'real') {
      return { ...zeeBrief(z), stopped: false, dry_run: true };
    }
    try {
      const r = await interruptCxellZee({ slug: z.slug });
      if (!r.idle) await markPaused(z);
      return { ...zeeBrief(z), stopped: r.stopped, idle: r.idle, gone: !!r.gone, how: r.how };
    } catch (e) {
      return { ...zeeBrief(z), stopped: false, error: e.message };
    }
  });

  const interrupted = results.filter((r) => r.stopped && !r.idle).length;
  const unreachable = results.filter((r) => !r.stopped && !r.dry_run).length;
  await setProjectPauseCounts(projectId, { interrupted, unreachable });
  broadcast('fleet-pause', { project_id: projectId, paused: true, by, reason, interrupted, unreachable });
  logline('pause', `project pause swept ${results.length} cxell(s): ${interrupted} interrupted, ${unreachable} unreachable`);

  return {
    ok: true, paused: true, project_id: projectId, by, reason,
    dry_run: PROVISION_MODE !== 'real',
    counts: { live: results.length, interrupted, idle: results.filter((r) => r.idle).length,
              gone: results.filter((r) => r.gone).length, unreachable },
    state: await projectPauseState(projectId),
    since: row?.paused_at || null,
  };
}

export async function resumeProject(projectId, { by = 'human@console' } = {}) {
  const before = await projectPauseState(projectId);
  const minutes = before.since ? Math.max(0, Math.round((Date.now() - new Date(before.since).getTime()) / 60000)) : null;
  await setProjectPaused(projectId, false, { by });
  logline('pause', `PROJECT ${String(projectId).slice(0, 8)} RESUMED by ${by} — calling back zees`);

  const zees = (await liveCxellZees(projectId))
    .filter((z) => z.last_stop_reason === PAUSED_STOP_REASON || z.nudge_held === true);
  const results = await inBatches(zees, 4, async (z) => {
    try {
      if (PROVISION_MODE === 'real' && await cxellHeadlessActive({ slug: z.slug })) {
        return { ...zeeBrief(z), nudged: false, skipped: 'already running' };
      }
      const r = await nudgeXellForFleetResume(z.xell_id, { minutes, reason: before.reason, by });
      if (r?.nudged) { await clearPausedMark(z); await clearHeldNudge(z); }
      return { ...zeeBrief(z), nudged: !!r?.nudged, dry_run: !!r?.dry_run,
               why: z.last_stop_reason === PAUSED_STOP_REASON ? 'interrupted' : 'a wake-up was held' };
    } catch (e) {
      return { ...zeeBrief(z), nudged: false, error: e.message };
    }
  });

  const nudged = results.filter((r) => r.nudged).length;
  await setProjectPauseCounts(projectId, { nudged });
  broadcast('fleet-pause', { project_id: projectId, paused: false, by, nudged });

  return {
    ok: true, paused: false, project_id: projectId, by,
    counts: { paused_zees: results.length, nudged,
              skipped: results.filter((r) => r.skipped).length,
              dry_run: results.filter((r) => r.dry_run).length,
              failed: results.filter((r) => r.error || (!r.nudged && !r.skipped && !r.dry_run)).length },
    state: await projectPauseState(projectId),
  };
}

// ── PER-XELL PAUSE ─────────────────────────────────────────────────────────────────────────────────
// Pause ONE xell: mark it in session_event and interrupt its zee if active.
export async function pauseXell(xellId, { by = 'human@console' } = {}) {
  await setXellPaused(xellId, true, { by });
  logline('pause', `XELL ${String(xellId).slice(0, 8)} PAUSED by ${by}`);

  // Interrupt the zee if it has a live cxell
  const zees = await liveCxellZees(null, xellId);
  const results = await inBatches(zees, 6, async (z) => {
    if (PROVISION_MODE !== 'real') return { ...zeeBrief(z), stopped: false, dry_run: true };
    try {
      const r = await interruptCxellZee({ slug: z.slug });
      if (!r.idle) await markPaused(z);
      return { ...zeeBrief(z), stopped: r.stopped, idle: r.idle, gone: !!r.gone, how: r.how };
    } catch (e) {
      return { ...zeeBrief(z), stopped: false, error: e.message };
    }
  });

  const interrupted = results.filter((r) => r.stopped && !r.idle).length;
  logline('pause', `xell pause: ${interrupted} interrupted`);

  return { ok: true, paused: true, xell_id: xellId, by, counts: { live: results.length, interrupted } };
}

// Resume ONE xell: mark it in session_event and nudge the zee back.
export async function resumeXell(xellId, { by = 'human@console' } = {}) {
  await setXellPaused(xellId, false, { by });
  logline('pause', `XELL ${String(xellId).slice(0, 8)} RESUMED by ${by}`);

  const zees = (await liveCxellZees(null, xellId))
    .filter((z) => z.last_stop_reason === PAUSED_STOP_REASON || z.nudge_held === true);
  const results = await inBatches(zees, 4, async (z) => {
    try {
      if (PROVISION_MODE === 'real' && await cxellHeadlessActive({ slug: z.slug })) {
        return { ...zeeBrief(z), nudged: false, skipped: 'already running' };
      }
      const r = await nudgeXellForFleetResume(z.xell_id, { minutes: 0, reason: 'resumed individually', by });
      if (r?.nudged) { await clearPausedMark(z); await clearHeldNudge(z); }
      return { ...zeeBrief(z), nudged: !!r?.nudged, dry_run: !!r?.dry_run };
    } catch (e) {
      return { ...zeeBrief(z), nudged: false, error: e.message };
    }
  });

  const nudged = results.filter((r) => r.nudged).length;
  return { ok: true, paused: false, xell_id: xellId, by, counts: { nudged } };
}

export async function pauseFleet({ by = 'human@console', reason = null } = {}) {
  const row = await setPaused(true, { by, reason });
  logline('pause', `FLEET PAUSED by ${by}${reason ? ` — ${reason}` : ''}: nothing new will be dispatched, `
    + 'no landing/clearance/reflection nudge will be delivered, and no message will reach a session until play');

  const zees = await liveCxellZees();
  const results = await inBatches(zees, 6, async (z) => {
    if (PROVISION_MODE !== 'real') {
      logline('pause', `${z.slug}: would interrupt ${cxellName(z.slug)} — PROVISION_MODE=simulate, so this `
        + 'queenzee models the fleet and stops no real cage');
      return { ...zeeBrief(z), stopped: false, dry_run: true };
    }
    try {
      const r = await interruptCxellZee({ slug: z.slug });
      if (!r.idle) await markPaused(z);
      logline('pause', r.gone
        ? `${z.slug}: its cage is gone — nothing to interrupt (the zee row outlived the container)`
        : r.idle
          ? `${z.slug}: no turn to interrupt (${z.zee_type} zee was between turns)`
          : `${z.slug}: ${z.zee_type} zee INTERRUPTED (${r.how})`);
      if (!r.stopped) {
        logline('pause', `${z.slug}: ⚠ the ${z.zee_type} zee did NOT stop — it survived SIGINT and SIGTERM. `
          + 'It is still working; a human needs to look at that cage.');
      }
      return { ...zeeBrief(z), stopped: r.stopped, idle: r.idle, gone: !!r.gone, how: r.how };
    } catch (e) {
      // A cage we could not reach is NOT a stopped zee. Say so per xell rather than failing the whole
      // pause: the other twenty zees still need stopping, and the operator needs the list.
      logline('pause', `${z.slug}: could NOT interrupt (${String(e.message).slice(0, 140)}) — its zee may still be working`);
      return { ...zeeBrief(z), stopped: false, error: e.message };
    }
  });

  const interrupted = results.filter((r) => r.stopped && !r.idle).length;
  const unreachable = results.filter((r) => !r.stopped && !r.dry_run).length;
  await setPauseCounts({ interrupted, unreachable });
  broadcast('fleet-pause', { paused: true, by, reason, interrupted, unreachable });
  logline('pause', `pause swept ${results.length} live cxell(s): ${interrupted} interrupted mid-turn, `
    + `${results.filter((r) => r.idle).length} already between turns`
    + (unreachable ? `, ${unreachable} NOT confirmed stopped` : ''));

  return {
    ok: true, paused: true, by, reason,
    dry_run: PROVISION_MODE !== 'real',
    counts: {
      live: results.length, interrupted, idle: results.filter((r) => r.idle).length,
      // Cages whose container is already gone: counted, and NOT as a failure — see CAGE_GONE in
      // lib/cxell.js. They are reported so a fleet quietly accumulating stale zee rows is visible.
      gone: results.filter((r) => r.gone).length,
      stuck: results.filter((r) => r.how === 'stuck').length,
      failed: results.filter((r) => r.error).length, unreachable,
    },
    xells: results,
    state: await pauseState(),
    since: row?.paused_at || null,
  };
}

// ── PLAY ──────────────────────────────────────────────────────────────────────────────────────────
// Lower the flag, then call back the zees this pause left waiting — the ones it INTERRUPTED, and the
// ones whose wake-up it REFUSED (see the selection below; both, or the second class strands silently).
// A zee that is somehow already running is SKIPPED rather than resumed: forking a second headless turn
// onto one session is how you get two agents writing the same files, and a human who attached to a
// cage and started it by hand does not need the queenzee racing them.
export async function resumeFleet({ by = 'human@console' } = {}) {
  const before = await pauseState();
  const minutes = before.since ? Math.max(0, Math.round((Date.now() - new Date(before.since).getTime()) / 60000)) : null;
  await setPaused(false, { by });
  logline('pause', `FLEET RESUMED by ${by}${minutes != null ? ` after ~${minutes} minute(s)` : ''} — `
    + 'calling back every zee the pause interrupted or left a held wake-up for');

  // TWO reasons to call a zee back, and the second is not optional. It was INTERRUPTED (its turn was
  // cut off — the obvious one), or a wake-up it needed was REFUSED while the flag was up: a zee that
  // asked to land had already ended its turn, so nothing interrupted it, and the landing a human
  // approved during the pause reached it only through a nudge this feature refuses. Without the second
  // clause that zee waits forever for a message that was thrown away. Anything else is left alone —
  // resuming a zee that had legitimately finished is a pause with side effects.
  const zees = (await liveCxellZees())
    .filter((z) => z.last_stop_reason === PAUSED_STOP_REASON || z.nudge_held === true);
  const results = await inBatches(zees, 4, async (z) => {
    try {
      if (PROVISION_MODE === 'real' && await cxellHeadlessActive({ slug: z.slug })) {
        logline('pause', `${z.slug}: already running — NOT resumed (a second turn on one session would double-drive it)`);
        return { ...zeeBrief(z), nudged: false, skipped: 'already running' };
      }
      const r = await nudgeXellForFleetResume(z.xell_id, { minutes, reason: before.reason, by });
      // Clear the marks only on a DELIVERED resume, so a zee we could not reach stays in the list and a
      // second press of play tries it again (the receipt must not claim a call that never happened).
      if (r?.nudged) { await clearPausedMark(z); await clearHeldNudge(z); }
      return { ...zeeBrief(z), nudged: !!r?.nudged, dry_run: !!r?.dry_run,
               why: z.last_stop_reason === PAUSED_STOP_REASON ? 'interrupted' : 'a wake-up was held',
               reason: r?.reason || null };
    } catch (e) {
      return { ...zeeBrief(z), nudged: false, error: e.message };
    }
  });

  const nudged = results.filter((r) => r.nudged).length;
  await setPauseCounts({ nudged });
  broadcast('fleet-pause', { paused: false, by, nudged });
  logline('pause', `play called back ${nudged} of ${results.length} paused zee(s)`
    + (results.length - nudged ? ` — ${results.length - nudged} could not be resumed (see the lines above)` : ''));

  return {
    ok: true, paused: false, by,
    // `failed` is "a zee we meant to call back and could not" — deliberately NOT counting a dry_run
    // (nothing was attempted, because this queenzee models the fleet) nor a skip (already running, so
    // it needs no call). Counting either would put a red warning on the operator's toast for a resume
    // that went exactly as designed, which is the same cry-wolf failure as the gone-cage case.
    counts: { paused_zees: results.length, nudged, skipped: results.filter((r) => r.skipped).length,
              dry_run: results.filter((r) => r.dry_run).length,
              failed: results.filter((r) => r.error || (!r.nudged && !r.skipped && !r.dry_run)).length },
    xells: results,
    state: await pauseState(),
  };
}

const zeeBrief = (z) => ({ xell_id: z.xell_id, slug: z.slug, zee_id: z.zee_id, zee_type: z.zee_type });

// Stamp the interrupted zee. `idle` is the truth about a zee with no turn running, and the stop reason
// is what makes the stop EXPLICABLE — without it the console shows a zee that simply went quiet, and
// the honest answer to "why did this stop" is buried in a log ring that a restart empties.
//
// intake.js writes the same pair when it notices its headless run died during a pause (the process it
// spawned exits as the SIGINT lands, and that handler would otherwise record 'errored'). Two writers,
// one value, last one wins — deliberately, because neither is guaranteed to run: the intake handler
// only exists in the process that spawned the run, and this sweep also covers turns started by a
// nudge and cages inherited across a queenzee restart.
async function markPaused(z) {
  const row = await one(
    `UPDATE zee SET status = CASE WHEN status IN ('spawning','online','working') THEN 'idle' ELSE status END,
                    last_stop_reason = $2
       WHERE id = $1 RETURNING *`, [z.zee_id, PAUSED_STOP_REASON]).catch(() => null);
  if (row) broadcast('zee', row);
}

// Lower the "a wake-up for this xell was refused" flag. Append-only, latest-event-wins — the same
// shape tend/hint clears take, so nothing is ever deleted from the event log.
async function clearHeldNudge(z) {
  if (!z.nudge_held) return;
  await recordEvent({ source: 'queenzee', hook_event_name: NUDGE_HELD_CLEAR, xell_id: z.xell_id,
                      raw: { why: 'resumed by play' } }).catch(() => {});
}

async function clearPausedMark(z) {
  const row = await one(
    `UPDATE zee SET last_stop_reason = 'resumed after fleet pause' WHERE id = $1
        AND last_stop_reason = $2 RETURNING *`, [z.zee_id, PAUSED_STOP_REASON]).catch(() => null);
  if (row) broadcast('zee', row);
}
