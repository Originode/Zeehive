// THE BOARD MOVES ITSELF — projecting the LIVE fact of the hive onto the plan.
//
// A kanban board that a human has to drag is a board that is wrong by lunchtime. Every work item with
// a zee on it already HAS a truth: what that zee's hexagon says right now. This tick (30 s) reads
// that truth for every assigned item and writes it onto the card, so the plan follows the fleet
// instead of the other way round.
//
//   work_item.xell_id → the xell's HIVE STATUS (lib/hive-status.js, from exactly the signals
//   lib/fleet.js feeds it) → statusFromHive() (lib/work-status.js) → the item's status.
//
// ── THE POLICY, which is the load-bearing decision of this file ──────────────────────────────────
// The tick may ONLY move an item BETWEEN THE IN-FLIGHT STATUSES (assigned, working, blocked, review,
// shipping). It will never:
//
//   • move an item to `done` or `cancelled` — FINISHING IS A DECISION. This whole repo is built on
//     the rule that a decision belongs to a human: a push is HELD at the landing gate, a prod deploy
//     is a request the queenzee performs only once someone approves it, a zee cannot even mark
//     ITSELF done. A tick that could close a card would be the one machine in the system allowed to
//     declare work finished — from a signal ("the zee looks idle") that is not evidence of anything.
//     An idle zee is a zee waiting for a human, and that is the opposite of done.
//   • move an item OUT of a terminal status — once a human has decided, no tick un-decides it. A
//     reopened card is a human's act too.
//   • touch an item nobody is on. No xell, no fact — it stays plan.
//
// When the assigned xell is GONE (retired, or the row deleted), the status is left exactly where it
// was and only the LINK is cleared: the work that happened still happened, and the card goes back to
// being plan, with an event that says why. Guessing a status backwards would destroy the one thing
// the history exists to record.
//
// Every move it does make is written as a `work_item_event` with actor 'queenzee', so the item's
// history reads honestly as "the board moved itself" and is never mistaken for a human's judgement.
//
// Same shape as queenzee/dbclone.js: a pure-script tick, loud in the log, disabled with
// WORKSYNC_ENABLED=false, and every failure isolated per item so one bad row cannot stop the sweep.
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { hiveStatus } from '../lib/hive-status.js';
import { statusFromHive } from '../lib/work-status.js';
import { setStatus, emit } from '../lib/work-items.js';

// The window this tick may move within. Deliberately written HERE, next to the policy it enforces,
// rather than imported: this is not the status VOCABULARY (work-status.js owns that, and
// statusFromHive maps into it) — it is the FENCE around what a machine is allowed to set. A fence
// you have to open another file to read is a fence nobody checks. test/work-assign.test.mjs pins it
// against the real vocabulary, so it cannot silently drift from the statuses that exist.
export const IN_FLIGHT = ['assigned', 'working', 'blocked', 'review', 'shipping'];
const inFlight = (s) => IN_FLIGHT.includes(s);

// The live SIGNALS hiveStatus() needs and the xell row does not hold. These are the SAME predicates
// lib/fleet.js folds into its fleet read (held landing / awaiting ship / the two prod-data asks / the
// tend ping / the readiness hints / a manager's done-suggestion) — the hive status a work item is
// projected from must be the one a human sees on the hexagon, not a second opinion derived here.
const SIGNALS = `
  EXISTS(SELECT 1 FROM land_request lr WHERE lr.xell_id = x.id
           AND lr.status IN ('pending','approved') AND lr.dismissed_at IS NULL) AS land_pending,
  EXISTS(SELECT 1 FROM ship_request sr WHERE sr.xell_id = x.id
           AND sr.status IN ('pending','approved','shipping') AND sr.dismissed_at IS NULL
           AND sr.deferred_at IS NULL) AS ship_pending,
  EXISTS(SELECT 1 FROM prod_bind_request pbr WHERE pbr.xell_id = x.id
           AND pbr.status = 'pending') AS prod_bind_pending,
  EXISTS(SELECT 1 FROM prod_seed_request psr WHERE psr.xell_id = x.id
           AND psr.status IN ('pending','approved','running') AND psr.dismissed_at IS NULL) AS seed_pending,
  (SELECT se.hook_event_name FROM session_event se
     WHERE se.xell_id = x.id AND se.hook_event_name IN ('tend-request','tend-clear')
     ORDER BY se.ts DESC LIMIT 1) = 'tend-request' AS tend_pending,
  (SELECT se.hook_event_name FROM session_event se
     WHERE se.xell_id = x.id AND se.hook_event_name IN ('landhint-request','landhint-clear')
     ORDER BY se.ts DESC LIMIT 1) = 'landhint-request' AS land_hint,
  (SELECT se.hook_event_name FROM session_event se
     WHERE se.xell_id = x.id AND se.hook_event_name IN ('shiphint-request','shiphint-clear')
     ORDER BY se.ts DESC LIMIT 1) = 'shiphint-request' AS ship_hint,
  EXISTS(SELECT 1 FROM done_suggestion ds WHERE ds.target_xell_id = x.id
           AND ds.status = 'pending' AND ds.dismissed_at IS NULL) AS done_suggested,
  EXISTS(SELECT 1 FROM deploy_lock dl WHERE dl.project_id = x.project_id
           AND dl.container = 'prod') AS prod_lock_active`;

// The hive status of the xell on this item — derived exactly as fleet.js derives it.
export function hiveStatusOf(row) {
  return hiveStatus(
    { status: row.xell_status, zee_status: row.zee_status, cli_active: row.cli_active,
      is_production: row.is_production },
    {
      landPending: row.land_pending === true,
      shipPending: row.ship_pending === true,
      tendPending: row.tend_pending === true,
      landHint: row.land_hint === true,
      shipHint: row.ship_hint === true,
      prodBindPending: row.prod_bind_pending === true,
      seedPending: row.seed_pending === true,
      doneSuggested: row.done_suggested === true,
      prodUnprotected: row.is_production && row.prod_lock_active === true,
    },
  );
}

// Every work item that claims a xell, with that xell's live row + signals. A LEFT JOIN, deliberately:
// an item pointing at a xell that no longer exists is exactly the case that needs cleaning up.
async function assignedItems() {
  return q(
    `SELECT wi.id, wi.project_id, wi.title, wi.status, wi.xell_id,
            x.id AS xell_row_id, x.slug AS xell_slug, x.status AS xell_status,
            x.is_production, COALESCE(x.zee_type,'worker') AS zee_type,
            z.status AS zee_status, z.cli_active,
            ${SIGNALS}
       FROM work_item wi
       LEFT JOIN xell x ON x.id = wi.xell_id
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id = x.id
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC LIMIT 1) z ON true
      WHERE wi.xell_id IS NOT NULL`);
}

// One sweep. Returns a summary so a caller (or a test) can assert on it without reading the log.
export async function workSyncTick() {
  let rows;
  try { rows = await assignedItems(); }
  catch (e) {
    // The work tracker's tables may not exist yet in an older meta-DB — that is not an error worth
    // spamming every 30s about, and it must never take the queenzee's other loops down with it.
    if (/relation .*(work_item|work_status)/i.test(e.message)) return { scanned: 0, moved: 0, cleared: 0, skipped: 'no work tracker schema' };
    throw e;
  }
  let moved = 0, cleared = 0;
  for (const row of rows) {
    try {
      // ── the xell is GONE: clear the link, keep the status, say so ──
      if (!row.xell_row_id || row.xell_status === 'retired') {
        await q(`UPDATE work_item SET xell_id=NULL WHERE id=$1`, [row.id]);
        await emit(row.id, 'unassigned', { actor: 'queenzee',
          data: { xell_id: row.xell_id, xell_slug: row.xell_slug || null, reason: 'the assigned xell is gone',
                  status_kept: row.status } });
        broadcast('work', { item_id: row.id, project_id: row.project_id, kind: 'unassigned' });
        logline('worksync',
          `"${row.title}": its zee (${row.xell_slug || row.xell_id}) is gone — cleared the assignment and LEFT the `
          + `status at '${row.status}' (work that happened, happened; the card is plan again)`);
        cleared++;
        continue;
      }

      const hive = hiveStatusOf(row);
      const next = statusFromHive(hive);
      if (!next || next === row.status) continue;

      // ── THE FENCE (see the header) ──
      if (!inFlight(row.status)) continue;   // terminal, or queued and nobody has started it
      if (!inFlight(next)) continue;         // never done/cancelled from a tick

      await setStatus(row.id, next, { actor: 'queenzee',
        note: `${row.xell_slug} is ${hive}` });
      await emit(row.id, 'status', { actor: 'queenzee',
        data: { from: row.status, to: next, hive_status: hive, xell_slug: row.xell_slug, by: 'worksync' } });
      broadcast('work', { item_id: row.id, project_id: row.project_id, kind: 'status', status: next });
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
