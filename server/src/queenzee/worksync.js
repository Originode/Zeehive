// THE BOARD MOVES ITSELF — projecting the LIVE fact of the hive onto the plan.
//
// A kanban board that a human has to drag is a board that is wrong by lunchtime. Every work item
// with a zee on it already HAS a truth: what that zee's hexagon says right now. This tick (30 s)
// reads that truth for every assigned item and writes it onto the card, so the plan follows the
// fleet instead of the other way round.
//
//   work_item.xell_id → liveZees() → the xell's HIVE STATUS (lib/hive-status.js, derived from
//   exactly the signals lib/fleet.js feeds it) → statusFromHive() (lib/work-status.js) → the status.
//
// liveZees is part 1's own batched helper and is used verbatim: the hive status a card is moved by
// MUST be the one the hexagon shows and the one the board read model already prints on the chip. A
// second derivation here would eventually disagree with both, and nobody would know which was right.
//
// ── THE POLICY, which is the load-bearing decision of this file ──────────────────────────────────
// The tick may ONLY move an item BETWEEN THE IN-FLIGHT STATUSES (assigned · working · blocked ·
// review · shipping — derived below, never a hardcoded list). It will never:
//
//   • move an item to `done` or `cancelled` — FINISHING IS A DECISION. This whole repo is built on
//     the rule that a decision belongs to a human: a push is HELD at the landing gate, a prod deploy
//     is a request the queenzee performs only once someone approves it, a zee cannot even mark
//     ITSELF done. A tick that could close a card would be the one machine in the system allowed to
//     declare work finished — and it would do it from a signal that is not evidence: statusFromHive
//     maps `occ-done` and `occ-doneRequest` to 'done', and BOTH of those are a xell being torn down
//     or ASKING to be, which says nothing about whether the work item is complete.
//   • move an item OUT of a terminal status — once a human has decided, no tick un-decides it.
//     Reopening is a human's act (and work-status.js only allows terminal → queued anyway).
//   • move an item that has not started (`queued`) — that is what assignment is for.
//   • touch an item nobody is on. No xell, no fact — it stays plan.
//
// When the assigned xell is GONE (retired, or the row deleted) the status is left exactly where it
// was and only the LINK is cleared, with an event that says why: the work that happened still
// happened, and the card goes back to being plan. Guessing a status backwards would destroy the one
// thing the history exists to record.
//
// ⚠ ONE PLACE THIS DISAGREES WITH PART 1'S DOC, ON PURPOSE AND OUT LOUD. Policy 4 in
// docs/work-tracker.md keeps a dead xell's id on the row ("xell_id: <still there, as history>") and
// suggests part 2/3 build a "was: <slug>" affordance from it. Part 3's brief says the opposite: when
// the zee is gone the item "goes back to being plan, not fact", so the link is cleared. Both agree on
// the thing that matters — a reap must NEVER move the item, and a dead xell must never lend it a
// signal (liveZees filters retired/husk/error, so a husk simply yields no hive word and this tick
// leaves it entirely alone). The history is not lost either way: the clearing event is a
// kind:'assigned' row whose detail carries xell_id AND xell_slug, which is what "was: <slug>" should
// be rendered from — a denormalized slug outlives the xell row, and reading it needs no join to a
// corpse. If the console would rather have the column, this is a one-line change here plus a test.
//
// Every move it does make is written by part 1's ledger with actor 'queenzee', so the item's history
// reads honestly as "the board moved itself" and is never mistaken for a human's judgement.
//
// Same shape as queenzee/dbclone.js: a pure-script tick, loud in the log, disabled with
// WORKSYNC_ENABLED=false, and every failure isolated per item so one bad row cannot stop the sweep.
import { q } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { statusFromHive, isTerminal, WORK_STATUS_KEYS, canTransition } from '../lib/work-status.js';
import { liveZees, logWorkEvent } from '../lib/work-items.js';
// The board announces itself in the SAME shape part 1 documents for these kinds ({ kind, item }) —
// a card the console cannot patch is a card that only moves on a refresh.
import { announceWorkItem } from '../lib/work-assign.js';

// The window this tick may move within: everything that is neither FINISHED nor NOT-YET-STARTED.
// Derived from the vocabulary rather than listed, so a new in-flight status is picked up and a new
// terminal one is excluded without a second edit here — and the fence still cannot be widened by
// accident, because `terminal` is what work-status.js and migration 058 both define.
export const IN_FLIGHT = WORK_STATUS_KEYS.filter((k) => k !== 'queued' && !isTerminal(k));
const inFlight = (s) => IN_FLIGHT.includes(s);

// Every work item that claims a xell, with the xell's own lifecycle status. A LEFT JOIN,
// deliberately: an item pointing at a xell that no longer exists is exactly the case to clean up.
async function assignedItems() {
  return q(
    `SELECT wi.id, wi.project_id, wi.title, wi.status, wi.xell_id,
            x.id AS xell_row_id, x.slug AS xell_slug, x.status AS xell_status
       FROM work_item wi
       LEFT JOIN xell x ON x.id = wi.xell_id
      WHERE wi.xell_id IS NOT NULL`);
}

// One sweep. Returns a summary so a caller (or a test) can assert on it without reading the log.
export async function workSyncTick() {
  let rows;
  try { rows = await assignedItems(); }
  catch (e) {
    // An older meta-DB may not have the work tracker at all. That is not an error worth spamming
    // every 30s about, and it must never take the queenzee's other loops down with it.
    if (/relation .*work_item/i.test(e.message)) {
      return { scanned: 0, moved: 0, cleared: 0, skipped: 'no work tracker schema' };
    }
    throw e;
  }
  if (!rows.length) return { scanned: 0, moved: 0, cleared: 0 };

  // ONE batched read for every zee on the board (part 1's helper — a board of eighty cards must not
  // cost eighty queries), and the same hive status the hexagon and the board chip show.
  const zees = await liveZees(rows.map((r) => r.xell_id));

  let moved = 0, cleared = 0;
  for (const row of rows) {
    try {
      // ── the xell is GONE: clear the link, keep the status, say so ──
      // Only 'retired' (or a vanished row) counts as gone here. A 'husk'/'error' xell is awaiting
      // queenzee housekeeping and may yet come back, and liveZees already refuses to speak for it —
      // so it is left completely untouched rather than half-cleaned by a tick.
      if (!row.xell_row_id || row.xell_status === 'retired') {
        await q(`UPDATE work_item SET xell_id=NULL WHERE id=$1`, [row.id]);
        await logWorkEvent(row.id, 'assigned', { actor: 'queenzee',
          detail: { unassigned: true, xell_id: row.xell_id, xell_slug: row.xell_slug || null,
                    reason: 'the assigned xell is gone', status_kept: row.status } });
        await announceWorkItem('assigned', row.id, { unassigned: true });
        logline('worksync',
          `"${row.title}": its zee (${row.xell_slug || row.xell_id}) is gone — cleared the assignment and LEFT `
          + `the status at '${row.status}' (work that happened, happened; the card is plan again)`);
        cleared++;
        continue;
      }

      const hive = zees.get(row.xell_id)?.hive_status || null;
      const next = hive ? statusFromHive(hive) : null;
      if (!next || next === row.status) continue;

      // ── THE FENCE (see the header). Three independent conditions, all of them cheap. ──
      if (!inFlight(row.status)) continue;   // terminal (decided), or queued (not started)
      if (!inFlight(next)) continue;         // never done/cancelled from a tick
      if (!canTransition(row.status, next)) continue;   // and never an illegal transition

      await q(`UPDATE work_item SET status=$2 WHERE id=$1`, [row.id, next]);
      await logWorkEvent(row.id, 'status', { from: row.status, to: next, actor: 'queenzee',
        detail: { hive_status: hive, xell_slug: row.xell_slug, by: 'worksync' } });
      await announceWorkItem('status', row.id);
      logline('worksync',
        `"${row.title}" ${row.status} → ${next} — ${row.xell_slug} is ${hive} (the board moved itself)`);
      moved++;
    } catch (e) {
      logline('worksync', `could not sync work item ${row.id}: ${e.message} — will retry next tick`);
    }
  }
  return { scanned: rows.length, moved, cleared };
}

export function startWorkSync() {
  if (process.env.WORKSYNC_ENABLED === 'false') {
    console.log('[queenzee] work-item sync DISABLED (WORKSYNC_ENABLED=false)');
    return null;
  }
  const interval = Number(process.env.WORKSYNC_INTERVAL_MS) || 30000;
  console.log(`[queenzee] work-item sync started (${interval}ms)`);
  const tick = () => workSyncTick().catch((e) => console.error('[worksync]', e.message));
  setTimeout(tick, 15000);   // let the API + the first fleet reads settle
  return setInterval(tick, interval);
}
