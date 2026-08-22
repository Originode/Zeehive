// WORK ITEM ACTUALS — the schedule the RECORD already knows, derived from facts, never typed.
//
// WHY THIS EXISTS. A gantt is a plan made visible, and this repo's plan is empty by construction:
// starts_on/due_on only exist when a human or a zee TYPES them, so a tracker with 470 items and 0
// dates shows a chart with no bars. But the record is not empty — every state transition, every
// zee turn and every landing is already in the meta-DB. This module is the derivation that turns
// that record into an item's REAL start and REAL end:
//
//   actual_start = the EARLIEST of
//     • the first work_item_event into assigned/working (a status transition, or an 'assigned'
//       event that is a real assignment — an unassign or a zee-gone note says the opposite)
//     • the first zee_turn of any xell that has been linked to the item
//   actual_end = the EARLIEST of
//     • the terminal work_item_event (done/cancelled)
//     • the first land_request that landed for a linked xell (its landed_at)
//   A null actual_end is exactly "still in flight" — the read models already resolve the live zee.
//
// THE CONTRACT WITH THE DATABASE. Migration 159 stores these on work_item as actual_start /
// actual_end, backfills them for every existing item, and keeps them current with triggers on
// work_item_event / zee_turn / land_request. THIS module is the derivation stated once in JS so
// the workflow-rehab programme can reuse it and so a synthetic item with known events can be
// asserted to yield exact expected actuals. The SQL trigger is the production writer; the pure
// functions below are the RULES it implements — and the integration test (test/work-tracker) pins
// them to the same answer.
//
// TWO SOURCES OF THE START, because they catch different halves of the same fact: an 'assigned'
// event is written the moment a zee is put on an item (even before the status moves), and a status
// transition to assigned/working is the card actually beginning. The EARLIEST of the two is the
// truth; a zee_turn is the fallback when the item was worked before the tracker wrote events.
import { dbRunner } from './work-items.js';

const START_STATUSES = new Set(['assigned', 'working']);
const END_STATUSES = new Set(['done', 'cancelled']);

// The earliest valid timestamp among values, or null. Values may be Date, ISO string, or anything
// Date can parse; invalid entries are skipped so one bad row cannot poison the whole item.
function earliestTs(values) {
  const times = (values || [])
    .map((v) => (v == null ? null : new Date(v).getTime()))
    .filter((t) => t != null && !Number.isNaN(t));
  return times.length ? new Date(Math.min(...times)) : null;
}

// min of two Dates, null-tolerant (null means "no evidence", never an earlier time).
function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(Math.min(a.getTime(), b.getTime()));
}

// Is this event row evidence the work STARTED? A status transition into assigned/working, or an
// 'assigned' event that is a real assignment. An unassign ('unassigned') and a zee-gone note are
// BOTH kind='assigned' — and both say a zee LEFT, so neither starts the clock. Clearing a link via
// PATCH also writes kind='assigned' with detail.xell_id=null (or detail.assignee=null) and says a
// zee is NOT on it, so a real assignment is one that names a non-null xell_id or assignee.
function isStartEvent(e) {
  if (e?.kind === 'status') return START_STATUSES.has(e.to_status);
  if (e?.kind === 'assigned') {
    if (e.detail?.unassigned || e.detail?.zee_gone) return false;
    const d = e.detail || {};
    return Boolean(d.xell_id) || Boolean(d.assignee);
  }
  return false;
}

// actual_start from the event ledger + zee turns. Pure, exported, tested standalone.
//
// THE WINDOW RULE (TKT-153 — the unbounded-xell leak): a xell works MANY items over its life, and
// "the first zee_turn of any linked xell" is the xell's first turn EVER — earned on whichever item
// it worked first. min(event, turn) lets that foreign turn beat this item's own assignment and
// pull the start back to a DIFFERENT item's work. So the item's OWN start events WIN; a zee_turn
// is evidence only when the ledger has no start event, and only when it falls inside the item's
// own window (a turn before the item's earliest ledger event belongs to an earlier item).
export function actualStartFrom(events = [], zeeTurns = []) {
  const fromEvents = earliestTs(events.filter(isStartEvent).map((e) => e.ts));
  if (fromEvents) return fromEvents;
  const fromTurns = earliestTs((zeeTurns || []).map((t) => t.started_at));
  if (!fromTurns) return null;
  // The item's own earliest ledger row bounds the fallback: a turn before the item existed in the
  // ledger cannot be this item's work. (The events array always includes a 'created' row, so this
  // bound is normally the item's creation.)
  const earliestEvent = earliestTs((events || []).map((e) => e.ts));
  if (earliestEvent && fromTurns < earliestEvent) return null;
  return fromTurns;
}

// actual_end from the event ledger + landings. Pure, exported, tested standalone.
//
// THE WINDOW RULE (TKT-153 — the unbounded-xell leak): a landing is per-XELL, not per-item — "the
// first land_request that landed for a linked xell" is the xell's earliest-ever landing, earned on
// whichever item it shipped first, and min() stamps that one timestamp on every item the xell ever
// touched (14 prod items shared one landing timestamp; 26 had end < start). A landing only ends an
// item if it happened DURING that item's work, so:
//   • the item's OWN terminal event (done/cancelled) WINS — a landing is evidence only in its absence;
//   • a landing counts only when landed_at >= the item's actual_start (the item's own window).
export function actualEndFrom(events = [], landings = [], { start = null } = {}) {
  const fromEvents = earliestTs(events
    .filter((e) => e?.kind === 'status' && END_STATUSES.has(e.to_status))
    .map((e) => e.ts));
  if (fromEvents) return fromEvents;
  const startMs = start ? new Date(start).getTime() : null;
  return earliestTs((landings || [])
    .filter((l) => l?.status === 'landed' && l.landed_at)
    .filter((l) => startMs === null || new Date(l.landed_at).getTime() >= startMs)
    .map((l) => l.landed_at));
}

// The whole derivation for one item, as pure data. The workflow-rehab programme reuses this to
// reconstruct actuals for its Plane-3 execution migration — feed it an item's events/turns/landings
// and it answers { actual_start, actual_end } (each a Date, or null when there is no evidence).
export function deriveActuals({ events = [], zeeTurns = [], landings = [] } = {}) {
  const actual_start = actualStartFrom(events, zeeTurns);
  let actual_end = actualEndFrom(events, landings, { start: actual_start });
  // NEVER PERSIST AN IMPOSSIBLE RANGE: actual_end < actual_start is a contradiction the renderer
  // would draw as a silent negative bar. Reject the end (null = "the record cannot place it")
  // rather than storing an inverted pair, and say so — the row is the one worth looking at.
  if (actual_end && actual_start && actual_end < actual_start) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[work-actuals] deriveActuals: end ${actual_end.toISOString()} is before start `
        + `${actual_start.toISOString()} — rejecting the end (impossible range)`);
    }
    actual_end = null;
  }
  return { actual_start, actual_end };
}

// Recompute and WRITE one item's stored columns, through the SAME SQL function the triggers call.
// This is the "keep it current" entry a future programme can call to reconstruct an item's actuals
// from its ledger without waiting for a state transition. Accepts an optional `client` so a caller
// already inside a transaction can participate in it (the dbRunner pattern work-items.js uses).
export async function refreshWorkItemActual(itemId, { client = null } = {}) {
  const db = dbRunner(client);
  await db.q(`SELECT work_item_actual_refresh($1::uuid)`, [itemId]);
}
