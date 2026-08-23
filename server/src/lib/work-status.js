// SINGLE SOURCE OF TRUTH for the WORK vocabulary — the statuses a ticket or a work item can hold,
// and what a board column is called.
//
// This is the deliberate twin of lib/hive-status.js, and for the same reason: hive-status projects a
// xell's raw lifecycle onto the operator-facing words on a hexagon, and it is pure and
// dependency-free so the server read models (fleet.js, self.js) and the web palette
// (web/src/hive/status.js) cannot drift apart. The work tracker has exactly that problem one layer
// up — the server builds the board/gantt read models, the console renders the columns — so it gets
// exactly that answer: one pure module both sides import.
//
// WHY THIS VOCABULARY AND NOT A NEW ONE. A tracker bolted onto ZEEHIVE with its own words
// ("todo/doing/done", "open/closed") would immediately be lying about the thing it is tracking: the
// work here is done by ZEES, and a zee's real states are already named. So work_status IS the zee
// lifecycle —
//
//   task_status (001_init): queued · assigned · working · done · cancelled
//
// — plus the three states a zee visibly passes through that only the hive vocabulary names:
//
//   occ-tendRequest                 → blocked    (the zee is stopped, waiting on a human)
//   occ-landRequest / occ-landHint  → review     (work exists and is being looked at)
//   occ-shipRequest / occ-shipHint  → shipping   (it is going to production)
//
// That correspondence is not decorative: statusFromHive() below is what lets a board card show what
// the zee on it is ACTUALLY doing right now, next to the status a human last set. The card's column
// is always the STORED status — a live hive status is advisory, never an automatic write, because a
// zee going idle for a minute must not silently move somebody's card.

// key → { label (column/pill text), order (left-to-right column order), terminal }.
// `terminal` means the work is over: done (succeeded) and cancelled (abandoned). It is what stamps
// closed_at in the database (work_status_is_terminal() in migration 058 lists the same two — the two
// definitions are deliberately parallel and must be edited together).
export const WORK_STATUS = {
  queued:    { label: 'queued',    order: 0, terminal: false },
  assigned:  { label: 'assigned',  order: 1, terminal: false },
  working:   { label: 'working',   order: 2, terminal: false },
  blocked:   { label: 'blocked',   order: 3, terminal: false },
  review:    { label: 'review',    order: 4, terminal: false },
  shipping:  { label: 'shipping',  order: 5, terminal: false },
  done:      { label: 'done',      order: 6, terminal: true  },
  cancelled: { label: 'cancelled', order: 7, terminal: true  },
};

export const WORK_STATUS_KEYS = Object.keys(WORK_STATUS);

export function workLabel(key) { return WORK_STATUS[key]?.label || key || '—'; }
export function isWorkStatus(key) { return Object.prototype.hasOwnProperty.call(WORK_STATUS, key); }
export function isTerminal(key) { return WORK_STATUS[key]?.terminal === true; }
export function workOrder(key) { return WORK_STATUS[key]?.order ?? 99; }

// The KINDS, alongside the statuses, so the web imports its whole vocabulary from one place.
export const WORK_ITEM_KINDS = ['project', 'activity', 'task'];
export const TICKET_KINDS = ['bug', 'feature', 'chore', 'question', 'incident'];

// A xell's LIVE hive status → the work_status it implies, or null when it implies nothing.
//
// Null is a real answer and the common one: 'vac-ready', 'live-protected', 'occ-seedRequest' and
// friends say nothing about the work item a zee happens to be holding, and inventing a status from
// them would be worse than silence. Callers treat null as "no live hint".
//
// 'occ-paused' is deliberately among them. An operator stopping the fleet says nothing about whether
// the WORK is queued, in review or blocked — it is the same item, mid-flight, with the agent switched
// off — so the card keeps the status it had and does not flicker to 'blocked' and back on a press.
export function statusFromHive(hiveStatusKey) {
  switch (hiveStatusKey) {
    case 'occ-working':      return 'working';
    case 'occ-claimed':      return 'assigned';
    case 'occ-idle':         return 'assigned';
    case 'occ-tendRequest':  return 'blocked';
    case 'occ-landRequest':
    case 'occ-landHint':     return 'review';
    case 'occ-shipRequest':
    case 'occ-shipHint':     return 'shipping';
    case 'occ-done':
    case 'occ-doneRequest':  return 'done';
    default:                 return null;
  }
}

// The legal transitions out of a status. Four rules, and nothing else:
//   • anything may be CANCELLED (abandoning work is always allowed);
//   • a TERMINAL status may only reopen through 'queued' — except `done`, which may also go to
//     'review': a landed card that needs an adversarial read ("landed, under review", ticket #56)
//     is a legal place for the board to be, and it is the ONLY terminal→non-terminal edge on
//     purpose. Reopening through queued/review starts the flow again rather than dropping the item
//     back into the middle of it, so "how did this get to review?" always has an answer in
//     work_item_event;
//   • otherwise any non-terminal status may move to any other status. Work does not proceed in a
//     line — a task goes working → blocked → working → review → blocked — and a state machine that
//     pretends otherwise just teaches people to lie to it.
export function nextStatuses(key) {
  if (!isWorkStatus(key)) return [];
  if (key === 'done') return ['queued', 'review', 'cancelled'];
  if (key === 'cancelled') return ['queued'];
  const rest = WORK_STATUS_KEYS.filter((k) => k !== key && k !== 'cancelled' && k !== 'done');
  return [...rest, 'done', 'cancelled'];
}

export function canTransition(from, to) {
  if (!isWorkStatus(to)) return false;
  if (from === to) return true;              // a no-op write is not an illegal transition
  return nextStatuses(from).includes(to);
}

// The whole vocabulary, shaped for GET /api/work-statuses — so the console never hardcodes a
// column list, a label or an order of its own.
export function workStatusVocabulary() {
  return {
    statuses: WORK_STATUS_KEYS.map((key) => ({ key, ...WORK_STATUS[key], next: nextStatuses(key) })),
    item_kinds: WORK_ITEM_KINDS,
    ticket_kinds: TICKET_KINDS,
  };
}
