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
// When the assigned xell is GONE (retired, or the row deleted) this tick NOTES it in the ledger and
// CHANGES NOTHING ELSE — not the status, and not the link:
//
//   xell_id is HISTORY. Liveness is resolved at READ time, never by nulling the column.
//
// That is policy 4 of docs/work-tracker.md, and it is where the guard belongs. `liveZees()` filters
// retired/husk/error and `hive-status.js` answers null for a retired row, so a stale id CANNOT lie to
// anybody: the read models already hand a dead xell's card `zee: null, live_status: null`. A SECOND
// guard here, at write time, would be the cache invalidation that doc warns about — missed by
// `purgeDevXells`, by `recoverOrphanTeardowns` finishing a half-done reap, and by a human updating a
// row — and it would cost the board its provenance: which agent was actually on this work. A tracker
// that quietly forgets that thirty seconds after a reap is less trustworthy, not more.
//
// (Part 3's brief originally said to CLEAR the column. It was surfaced rather than silently obeyed,
// and the ruling was to keep it — the read-time guard is enough, and 'was: <slug>' should render from
// a column with the ledger as corroboration, not from the ledger as the only witness. Do not
// "restore" the clearing: the event below is the whole job.)
//
// The event is written ONCE per dead xell, not once per tick — the link survives now, so the branch
// below would otherwise fire every 30 seconds forever and turn an item's history into a stutter.
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
// deliberately: an item pointing at a xell whose row no longer exists is exactly the case to note.
// `gone_recorded` is the idempotency key — have we already said, in this item's ledger, that THIS
// xell went away? (Matched on the xell id in the event's detail, so a later re-assignment to a
// different xell that also dies gets its own entry.)
async function assignedItems() {
  return q(
    `SELECT wi.id, wi.project_id, wi.title, wi.status, wi.xell_id,
            x.id AS xell_row_id, x.slug AS xell_slug, x.status AS xell_status,
            EXISTS (SELECT 1 FROM work_item_event e
                     WHERE e.work_item_id = wi.id AND e.kind = 'assigned'
                       AND e.detail->>'zee_gone' = 'true'
                       AND e.detail->>'xell_id' = wi.xell_id::text) AS gone_recorded
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
      return { scanned: 0, moved: 0, noted: 0, skipped: 'no work tracker schema' };
    }
    throw e;
  }
  if (!rows.length) return { scanned: 0, moved: 0, noted: 0 };

  // ONE batched read for every zee on the board (part 1's helper — a board of eighty cards must not
  // cost eighty queries), and the same hive status the hexagon and the board chip show.
  const zees = await liveZees(rows.map((r) => r.xell_id));

  let moved = 0, noted = 0;
  for (const row of rows) {
    try {
      // ── the xell is GONE: say so in the ledger, ONCE, and change nothing else ──
      // Only 'retired' (or a vanished row) counts as gone here. A 'husk'/'error' xell is awaiting
      // queenzee housekeeping and may yet come back, and liveZees already refuses to speak for it —
      // so it is left completely untouched rather than half-handled by a tick.
      if (!row.xell_row_id || row.xell_status === 'retired') {
        if (row.gone_recorded) continue;                 // already noted; the link is history now
        await logWorkEvent(row.id, 'assigned', { actor: 'queenzee',
          detail: { zee_gone: true, xell_id: row.xell_id, xell_slug: row.xell_slug || null,
                    reason: 'the assigned xell is gone', status_kept: row.status } });
        await announceWorkItem('assigned', row.id, { zee_gone: true });
        logline('worksync',
          `"${row.title}": its zee (${row.xell_slug || row.xell_id}) is GONE — noted in the ledger and `
          + `nothing else touched: the status stays '${row.status}' (the agent left; the work did not `
          + 'finish) and xell_id stays as history (the read models already refuse to resolve a dead xell)');
        noted++;
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
  return { scanned: rows.length, moved, noted };
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
