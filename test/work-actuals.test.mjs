// WORK ITEM ACTUALS — the derivation is a clean callable module, so a synthetic item with known
// events yields exact expected actuals.
//
// This is the standalone test the card calls for. It exercises the PURE functions in
// server/src/lib/work-actuals.js — the derivation rules stated once in JS, the same rules migration
// 159 implements in its trigger SQL (and test/work-tracker pins the two to the same answer by
// driving the trigger). No database, no HTTP: feed it event rows / zee turns / landings in the
// exact shapes the ledger returns and it answers { actual_start, actual_end } as Dates.
import { actualStartFrom, actualEndFrom, deriveActuals } from '../server/src/lib/work-actuals.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);
const eq = (a, b) => (a === b || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()));

// the ledger's event shape: { kind, ts, to_status, detail } (ts is what node-pg returns for a
// timestamptz; detail is the parsed jsonb)
const EV = (kind, ts, to = null, detail = null) => ({ kind, ts, to_status: to, detail });

const T = (iso) => new Date(iso);

// ── the START ────────────────────────────────────────────────────────────────
section('actual_start — the first event into assigned/working');
{
  const events = [
    EV('created', T('2026-07-01T09:00:00Z')),
    EV('status', T('2026-07-02T10:00:00Z'), 'assigned'),
    EV('status', T('2026-07-03T11:00:00Z'), 'working'),
    EV('status', T('2026-07-05T12:00:00Z'), 'blocked'),
    EV('status', T('2026-07-06T13:00:00Z'), 'working'),
  ];
  const start = actualStartFrom(events, []);
  ok(eq(start, T('2026-07-02T10:00:00Z')),
     `the first transition INTO assigned/working is the start (${start?.toISOString()})`);
}

section('actual_start — an assigned event (the moment a zee is put on) counts too');
{
  const events = [
    EV('created', T('2026-07-01T09:00:00Z')),
    EV('assigned', T('2026-07-01T10:00:00Z'), null, { xell_id: 'x', xell_slug: 'worker' }),
    EV('status', T('2026-07-02T10:00:00Z'), 'working'),
  ];
  const start = actualStartFrom(events, []);
  ok(eq(start, T('2026-07-01T10:00:00Z')),
     `an assignment BEFORE the status transition is the start (${start?.toISOString()})`);
}

section('actual_start — an unassign or a zee-gone note is NOT a start');
{
  const events = [
    EV('assigned', T('2026-07-01T10:00:00Z'), null, { unassigned: true, xell_id: 'x' }),
    EV('assigned', T('2026-07-02T10:00:00Z'), null, { zee_gone: true, xell_id: 'x' }),
    EV('status', T('2026-07-03T10:00:00Z'), 'working'),
  ];
  const start = actualStartFrom(events, []);
  ok(eq(start, T('2026-07-03T10:00:00Z')),
     `leavings do not start the clock — only the real assignment/transition does (${start?.toISOString()})`);
  ok(actualStartFrom([EV('assigned', T('2026-07-01T10:00:00Z'), null, { unassigned: true })], []) === null,
     'an item with ONLY an unassign and nothing else has NO actual start (nothing ever started)');
  // a PATCH that CLEARS the link (updateWorkItem {xell_id:null}) writes kind='assigned' with
  // detail.xell_id=null — that says a zee is NOT on it, so it is not a start either
  ok(actualStartFrom([EV('assigned', T('2026-07-01T10:00:00Z'), null, { xell_id: null })], []) === null,
     'an assigned event naming NO xell or assignee is not a start (a cleared link)');
  ok(actualStartFrom([EV('assigned', T('2026-07-01T10:00:00Z'), null, { assignee: null })], []) === null,
     'nor is one naming a null assignee');
  ok(eq(actualStartFrom([EV('assigned', T('2026-07-01T10:00:00Z'), null, { xell_id: 'x' })], []),
        T('2026-07-01T10:00:00Z')),
     'an assigned event naming a real xell IS a start');
}

section('actual_start — the zee_turn fallback, and the item\'s own events win');
{
  const turns = [{ started_at: T('2026-07-02T09:00:00Z') }, { started_at: T('2026-07-01T09:00:00Z') }];
  ok(eq(actualStartFrom([], turns), T('2026-07-01T09:00:00Z')),
     'the FIRST zee_turn of the linked xell is the start when there are no events');
  // THE LEAK (TKT-153): a multi-item xell's FIRST turn was earned on an earlier item, and min()
  // let it beat this item's own assignment — pulling the start back to a DIFFERENT item's work.
  // The item's OWN start event must win; a turn is evidence only in its absence.
  const events = [EV('status', T('2026-07-04T10:00:00Z'), 'working')];
  ok(eq(actualStartFrom(events, turns), T('2026-07-04T10:00:00Z')),
     'the item\'s OWN start event wins — an earlier xell turn no longer pulls the start back');
  // scope the fallback to the item's own window: a turn before the item existed in the ledger
  // cannot be this item's work.
  const createdOnly = [EV('created', T('2026-07-01T09:00:00Z'))];
  const earlyTurn = [{ started_at: T('2026-06-30T09:00:00Z') }];
  ok(actualStartFrom(createdOnly, earlyTurn) === null,
     'a zee_turn before the item\'s own earliest event is rejected (it belongs to a different item)');
}

section('actual_start — empty and malformed inputs');
{
  ok(actualStartFrom() === null && actualStartFrom([], []) === null, 'no evidence → null, never a guess');
  ok(actualStartFrom([EV('created', T('2026-07-01T09:00:00Z'))], []) === null,
     'a created event alone is not a start');
  ok(actualStartFrom([{ kind: 'status', ts: 'not-a-date', to_status: 'working' }], []) === null,
     'an unparseable timestamp is skipped, not thrown');
  ok(actualStartFrom([{ kind: 'status', to_status: 'working' }], []) === null,
     'an event with no ts contributes nothing');
}

// ── the END ──────────────────────────────────────────────────────────────────
section('actual_end — the terminal event or the landing that closed it');
{
  const events = [
    EV('status', T('2026-07-10T10:00:00Z'), 'working'),
    EV('status', T('2026-07-11T10:00:00Z'), 'done'),
    EV('comment', T('2026-07-12T10:00:00Z'), null, { body: 'later' }),
  ];
  ok(eq(actualEndFrom(events, []), T('2026-07-11T10:00:00Z')),
     `the terminal transition is the end (${actualEndFrom(events, [])?.toISOString()})`);
  ok(actualEndFrom([EV('status', T('2026-07-10T10:00:00Z'), 'working')], []) === null,
     'no terminal event and no landing → null (still in flight)');
}

section('actual_end — cancelled counts, landings are the fallback, the terminal event wins');
{
  const cancelled = [EV('status', T('2026-07-11T10:00:00Z'), 'cancelled')];
  ok(eq(actualEndFrom(cancelled, []), T('2026-07-11T10:00:00Z')), 'cancelled is a terminal end too');
  const landings = [{ status: 'landed', landed_at: T('2026-07-11T09:00:00Z') },
                    { status: 'landed', landed_at: T('2026-07-13T09:00:00Z') }];
  ok(eq(actualEndFrom([], landings), T('2026-07-11T09:00:00Z')),
     'the FIRST landed landing is the end when there is no terminal event');
  // THE LEAK (TKT-153): a landing is per-XELL, not per-item — the xell's earliest-ever landing
  // (earned on a DIFFERENT item) used to beat this item's own done event via min(). The item's
  // OWN terminal event must win; a landing is evidence only in its absence.
  const both = [EV('status', T('2026-07-12T10:00:00Z'), 'done'), EV('status', T('2026-07-11T10:00:00Z'), 'working')];
  ok(eq(actualEndFrom(both, landings), T('2026-07-12T10:00:00Z')),
     'the item\'s OWN terminal event wins — an earlier landing no longer beats it');
  // scope the fallback to the item's own window: a landing before the item started is evidence
  // of a DIFFERENT item's work, and must not end this one.
  ok(actualEndFrom([], [{ status: 'landed', landed_at: T('2026-07-11T09:00:00Z') }],
                       { start: T('2026-07-12T10:00:00Z') }) === null,
     'a landing before the item started is rejected (it ended a different item)');
  ok(eq(actualEndFrom([], landings, { start: T('2026-07-11T09:30:00Z') }), T('2026-07-13T09:00:00Z')),
     'a landing AFTER the start is accepted — the fallback keeps working when the item has no terminal event');
  ok(actualEndFrom([], [{ status: 'pending', landed_at: null }]) === null,
     'a PENDING landing is not an end');
}

// ── the whole derivation ─────────────────────────────────────────────────────
section('deriveActuals — one synthetic item, exact expected actuals');
{
  const item = {
    events: [
      EV('created', T('2026-07-01T09:00:00Z')),
      EV('assigned', T('2026-07-02T10:00:00Z'), null, { xell_id: 'x', xell_slug: 'w' }),
      EV('status', T('2026-07-03T10:00:00Z'), 'working'),
      EV('status', T('2026-07-08T16:00:00Z'), 'done'),
    ],
    zeeTurns: [{ started_at: T('2026-07-03T09:00:00Z') }, { started_at: T('2026-07-04T09:00:00Z') }],
    landings: [{ status: 'landed', landed_at: T('2026-07-08T17:00:00Z') }],
  };
  const a = deriveActuals(item);
  ok(eq(a.actual_start, T('2026-07-02T10:00:00Z')),
     `actual_start is the assignment moment (${a.actual_start?.toISOString()})`);
  ok(eq(a.actual_end, T('2026-07-08T16:00:00Z')),
     `actual_end is the terminal event, beating the landing that followed (${a.actual_end?.toISOString()})`);
}

section('deriveActuals — a live item has a start and no end');
{
  const a = deriveActuals({
    events: [EV('assigned', T('2026-07-02T10:00:00Z'), null, { xell_id: 'x' }),
             EV('status', T('2026-07-03T10:00:00Z'), 'working')],
  });
  ok(eq(a.actual_start, T('2026-07-02T10:00:00Z')) && a.actual_end === null,
     'in flight = a start with no end (the live zee proves it, the read models resolve it)');
}

section('deriveActuals — the multi-item xell leak is closed');
{
  // The xell's FIRST landing (07-10) was earned on item 1. Item 2 started 07-12 and was
  // delivered by its own landing on 07-13. min() over the xell's whole history stamps 07-10
  // on item 2 too — an end 2 days before it started. The scoped rule must pick the landing
  // INSIDE item 2's own window.
  const item2 = {
    events: [
      EV('assigned', T('2026-07-12T10:00:00Z'), null, { xell_id: 'x' }),
      EV('status', T('2026-07-12T11:00:00Z'), 'working'),
    ],
    zeeTurns: [{ started_at: T('2026-07-12T09:00:00Z') }],   // a turn from item 1's era — must NOT pull the start back
    landings: [
      { status: 'landed', landed_at: T('2026-07-10T09:00:00Z') },  // item 1's landing
      { status: 'landed', landed_at: T('2026-07-13T10:00:00Z') },  // item 2's landing
    ],
  };
  const a = deriveActuals(item2);
  ok(eq(a.actual_start, T('2026-07-12T10:00:00Z')),
     `start comes from item 2's OWN assignment, not the xell's earlier turn (${a.actual_start?.toISOString()})`);
  ok(eq(a.actual_end, T('2026-07-13T10:00:00Z')),
     `end is the landing INSIDE the item's window, not the xell's earliest (${a.actual_end?.toISOString()})`);
  ok(!a.actual_end || a.actual_end >= a.actual_start, 'the derived range is never inverted');
}

section('deriveActuals — an impossible range is rejected, not stored');
{
  // A done event BEFORE the item's own start is contradictory data. The rule must not persist
  // an inverted range: the end is rejected (null) rather than stored as end < start.
  const a = deriveActuals({
    events: [
      EV('status', T('2026-07-10T10:00:00Z'), 'working'),
      EV('status', T('2026-07-09T10:00:00Z'), 'done'),   // done BEFORE the start
    ],
  });
  ok(a.actual_end === null,
     'an end before the start is rejected (null), never stored as an inverted range');
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
