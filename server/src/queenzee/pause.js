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
import { setPaused, setPauseCounts, pauseState, PAUSED_STOP_REASON } from '../lib/fleet-pause.js';
import { nudgeXellForFleetResume } from './nudge.js';

// Same switch every other real-side-effect module reads (nudge, landgate, xellgit, harness, reaper):
// 'real' touches machines, anything else models. An interrupt is a `docker exec cxell_<slug> pkill`
// and the slug comes off a fleet row — which, in a NESTED queenzee running against a CLONE of the
// meta-DB, is another zee's live cage, mid-task, on work this instance knows nothing about. So a
// non-real queenzee reports what it WOULD have stopped and execs nothing. The flag still moves: the
// pause is honest about being a model of one, and the gates it drives (dispatch, nudges) are this
// instance's own behaviour, which is real either way.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// Every xell with a LIVE cxell zee, across every project. `viewer_kind='ssh-terminal'` is this repo's
// definition of "the cage is still up" (nudge.js uses the same test), and the newest zee per xell is
// the one that owns it.
async function liveCxellZees() {
  return q(
    `SELECT DISTINCT ON (x.id)
            x.id AS xell_id, x.slug, x.status AS xell_status, x.project_id,
            COALESCE(x.zee_type, 'worker') AS zee_type,
            z.id AS zee_id, z.status AS zee_status, z.last_stop_reason
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE z.entrypoint = 'cxell-cli'
        AND z.viewer_kind = 'ssh-terminal'
        AND z.decommissioned_at IS NULL
        AND x.status NOT IN ('retired', 'tearing-down')
      ORDER BY x.id, z.created_at DESC`);
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
      logline('pause', r.idle
        ? `${z.slug}: no turn to interrupt (${z.zee_type} zee was between turns)`
        : `${z.slug}: ${z.zee_type} zee INTERRUPTED (${r.how})`);
      if (!r.stopped) {
        logline('pause', `${z.slug}: ⚠ the ${z.zee_type} zee did NOT stop — it survived SIGINT and SIGTERM. `
          + 'It is still working; a human needs to look at that cage.');
      }
      return { ...zeeBrief(z), stopped: r.stopped, idle: r.idle, how: r.how };
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
      stuck: results.filter((r) => r.how === 'stuck').length,
      failed: results.filter((r) => r.error).length, unreachable,
    },
    xells: results,
    state: await pauseState(),
    since: row?.paused_at || null,
  };
}

// ── PLAY ──────────────────────────────────────────────────────────────────────────────────────────
// Lower the flag, then call back ONLY the zees this pause interrupted (see PAUSED_STOP_REASON). A zee
// that is somehow already running is SKIPPED rather than resumed: forking a second headless turn onto
// one session is how you get two agents writing the same files, and a human who attached to a cage
// and started it by hand does not need the queenzee racing them.
export async function resumeFleet({ by = 'human@console' } = {}) {
  const before = await pauseState();
  const minutes = before.since ? Math.max(0, Math.round((Date.now() - new Date(before.since).getTime()) / 60000)) : null;
  await setPaused(false, { by });
  logline('pause', `FLEET RESUMED by ${by}${minutes != null ? ` after ~${minutes} minute(s)` : ''} — `
    + 'calling back every zee the pause interrupted');

  const zees = (await liveCxellZees()).filter((z) => z.last_stop_reason === PAUSED_STOP_REASON);
  const results = await inBatches(zees, 4, async (z) => {
    try {
      if (PROVISION_MODE === 'real' && await cxellHeadlessActive({ slug: z.slug })) {
        logline('pause', `${z.slug}: already running — NOT resumed (a second turn on one session would double-drive it)`);
        return { ...zeeBrief(z), nudged: false, skipped: 'already running' };
      }
      const r = await nudgeXellForFleetResume(z.xell_id, { minutes, reason: before.reason, by });
      // Clear the marker only on a delivered resume, so a zee we could not reach stays in the list and
      // a second press of play tries it again (the receipt must not claim a call that never happened).
      if (r?.nudged) await clearPausedMark(z);
      return { ...zeeBrief(z), nudged: !!r?.nudged, dry_run: !!r?.dry_run, reason: r?.reason || null };
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
    counts: { paused_zees: results.length, nudged, skipped: results.filter((r) => r.skipped).length,
              failed: results.filter((r) => r.error || (!r.nudged && !r.skipped)).length },
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

async function clearPausedMark(z) {
  const row = await one(
    `UPDATE zee SET last_stop_reason = 'resumed after fleet pause' WHERE id = $1
        AND last_stop_reason = $2 RETURNING *`, [z.zee_id, PAUSED_STOP_REASON]).catch(() => null);
  if (row) broadcast('zee', row);
}
