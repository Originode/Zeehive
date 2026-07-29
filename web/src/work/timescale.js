// WORK TRACKER — the TIME AXIS maths, kept as pure functions on purpose (the same bargain as
// order.js: the genuinely algorithmic part of a drag lives where a test can reach it).
//
// A gantt is two pieces of arithmetic wearing a chart: WHERE a date sits on a pixel ruler, and
// WHICH date a pixel means when a human drags a bar. Both are easy to get subtly wrong and
// impossible to eyeball — an off-by-one day is invisible on screen and wrong in the plan — so
// every one of them is here, with no React, no DOM and no imports, and `test/work-gantt.test.mjs`
// exercises them directly.
//
// THREE RULES THIS MODULE HOLDS:
//
// 1. A DAY IS A LOCAL CALENDAR DAY, NEVER A UTC INSTANT. The API's dates are date-only columns
//    ('2026-08-01'); `new Date('2026-08-01')` is UTC midnight, which is the PREVIOUS day for
//    anyone west of Greenwich. So every function here works on Dates already normalised to local
//    midnight (bits.jsx `parseDay` does the parsing — this module never parses a string, so it
//    stays importable by a plain node test) and every difference is rounded, which also makes it
//    survive the two DST days a year when a "day" is 23 or 25 hours long.
//
// 2. DATES ARE ONLY EVER READ FROM THE SERVER'S ROWS. Nothing here invents a start or an end:
//    `/api/gantt` rolls a parent's span up from its children and flags the rows that have no dates
//    anywhere, and an unscheduled row stays unscheduled until a human schedules it. The one place
//    this module proposes dates at all is `scheduleWindow()`, which is the explicit "schedule it"
//    action a human clicks in the unscheduled tray.
//
// 3. A DRAG SNAPS TO THE ZOOM'S UNIT. At month zoom a pixel is a third of a day, so an unsnapped
//    drag would write a date the human cannot see they chose. `dragDates()` is the whole gesture —
//    move both ends, or resize one — expressed as a pure function of (original dates, day delta,
//    zoom), so the preview a human sees during the drag and the PATCH sent on drop are computed by
//    the same line of code and cannot disagree.

export const DAY_MS = 86400000;

// px = pixels per DAY at that zoom. Day zoom is wide enough to label every day; month zoom fits a
// year or so of plan on one screen. The unit is what a drag snaps to.
export const ZOOMS = [
  { key: 'day', label: 'day', px: 30 },
  { key: 'week', label: 'week', px: 10 },
  { key: 'month', label: 'month', px: 3.4 },
];
export const zoomOf = (key) => ZOOMS.find((z) => z.key === key) || ZOOMS[1];

// The drag gestures, named once so the chart and this module cannot spell them differently.
export const MOVE = 'move';
export const START = 'start';
export const END = 'end';
export const LINK = 'link';

export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; };
// Weeks start on MONDAY — the console is a work planner, and a week that starts on Sunday puts the
// weekend in the middle of a sprint.
export const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
export const startOfMonth = (d) => { const x = startOfDay(d); x.setDate(1); return x; };
export const addMonths = (d, n) => { const x = startOfMonth(d); x.setMonth(x.getMonth() + n); return x; };
export const diffDays = (a, b) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
export const isWeekend = (d) => { const w = startOfDay(d).getDay(); return w === 0 || w === 6; };

const p2 = (n) => String(n).padStart(2, '0');
// The wire format the API uses for a date-only column, built from LOCAL parts (see rule 1).
export const dayKey = (d) => { const x = startOfDay(d); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; };

const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short' });
const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const DAY_MONTH = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

// The visible window: a fortnight either side of the plan, aligned to the zoom's unit so the bands
// line up with the labels. An EMPTY plan still gets a readable ruler around today rather than a
// zero-width canvas — a chart of nothing must still look like a chart.
export function windowFor(dates, { today = new Date(), pad = 14, min = 28, zoom = 'week' } = {}) {
  const list = (dates || []).filter(Boolean).map(startOfDay).sort((a, b) => a.getTime() - b.getTime());
  let start = list.length ? addDays(list[0], -pad) : addDays(today, -pad);
  let end = list.length ? addDays(list[list.length - 1], pad) : addDays(today, pad * 2);
  if (diffDays(start, end) < min) end = addDays(start, min);
  const align = zoom === 'month' ? startOfMonth : zoom === 'week' ? startOfWeek : startOfDay;
  start = align(start);
  end = align(addDays(end, zoom === 'month' ? 31 : zoom === 'week' ? 7 : 1));
  return { start, end, days: diffDays(start, end) };
}

// date → x, and a pixel delta → a number of WHOLE days (the only two conversions the chart needs).
export const xOf = (date, start, px) => diffDays(start, date) * px;
export const daysAt = (dx, px) => Math.round(dx / (px || 1));

// A bar's rectangle. `end` may be missing (a row with a start and no due date, which the server
// reports honestly rather than filling in) — that draws as a single unit, marked open-ended.
export function barSpan(start, end, winStart, px, minW = 6) {
  if (!start && !end) return null;
  const s = start || end;
  const e = end || start;
  const x = xOf(s, winStart, px);
  const w = Math.max(minW, (diffDays(s, e) + 1) * px);
  return { x, w, open: !end };
}

// Snap a date to the zoom's own unit: a day, a Monday, or the 1st.
export function snapDate(date, zoom) {
  const d = startOfDay(date);
  if (zoom === 'week') { const s = startOfWeek(d); return diffDays(s, d) >= 4 ? addDays(s, 7) : s; }
  if (zoom === 'month') {
    const m = startOfMonth(d); const n = addMonths(m, 1);
    return diffDays(m, d) >= diffDays(m, n) / 2 ? n : m;
  }
  return d;
}

// THE WHOLE DRAG, as arithmetic. `mode` is MOVE (both ends travel together, the length is kept),
// START or END (one edge moves and the bar cannot be turned inside out). Returns the exact
// `{starts_on, due_on}` body the PATCH will send, so the ghost bar and the request agree.
export function dragDates({ mode, start, end }, days, zoom) {
  const s0 = startOfDay(start);
  const e0 = startOfDay(end || start);
  if (mode === START) {
    let s = snapDate(addDays(s0, days), zoom);
    if (diffDays(s, e0) < 0) s = e0;                 // an edge dragged past the other one stops there
    return { starts_on: dayKey(s), due_on: dayKey(e0) };
  }
  if (mode === END) {
    let e = snapDate(addDays(e0, days), zoom);
    if (diffDays(s0, e) < 0) e = s0;
    return { starts_on: dayKey(s0), due_on: dayKey(e) };
  }
  const s = snapDate(addDays(s0, days), zoom);
  return { starts_on: dayKey(s), due_on: dayKey(addDays(s, diffDays(s0, e0))) };
}

// The dates the "schedule" button in the unscheduled tray proposes: today → today + the estimate
// (8h = a day), or today + ONE day when the item carries no estimate. This is the only place the
// console proposes a date at all, and it happens because a human asked for it by name.
export function scheduleWindow(row, today = new Date()) {
  const h = Number(row?.estimate_hours);
  const days = Number.isFinite(h) && h > 0 ? Math.max(1, Math.ceil(h / 8)) : 1;
  const s = startOfDay(today);
  return { starts_on: dayKey(s), due_on: dayKey(addDays(s, days)) };
}

// The axis: `minor` are the labelled cells (a day, a week, a month), `major` the band above them
// (a month, or a year at month zoom), `weekends` the shaded runs — dropped entirely once a day is
// too narrow to see, because a 3px stripe is noise, not information.
export function bands(start, end, zoom, px) {
  const total = diffDays(start, end);
  const minor = [];
  const major = [];
  const weekends = [];
  const cell = (from, to) => ({ x: xOf(from, start, px), w: diffDays(from, to) * px });

  if (zoom === 'day') {
    for (let i = 0; i < total; i++) {
      const d = addDays(start, i);
      minor.push({ key: dayKey(d), x: i * px, w: px, label: String(d.getDate()), weekend: isWeekend(d) });
    }
  } else if (zoom === 'week') {
    for (let d = startOfWeek(start); diffDays(d, end) > 0; d = addDays(d, 7)) {
      minor.push({ key: dayKey(d), ...cell(d, addDays(d, 7)), label: DAY_MONTH.format(d) });
    }
  } else {
    for (let d = startOfMonth(start); diffDays(d, end) > 0; d = addMonths(d, 1)) {
      minor.push({ key: dayKey(d), ...cell(d, addMonths(d, 1)), label: MONTH.format(d) });
    }
  }

  if (zoom === 'month') {
    for (let d = new Date(start.getFullYear(), 0, 1); diffDays(d, end) > 0; d = new Date(d.getFullYear() + 1, 0, 1)) {
      major.push({ key: String(d.getFullYear()), ...cell(d, new Date(d.getFullYear() + 1, 0, 1)), label: String(d.getFullYear()) });
    }
  } else {
    for (let d = startOfMonth(start); diffDays(d, end) > 0; d = addMonths(d, 1)) {
      major.push({ key: dayKey(d), ...cell(d, addMonths(d, 1)), label: MONTH_YEAR.format(d), alt: d.getMonth() % 2 === 1 });
    }
  }

  if (px >= 5) {
    for (let i = 0; i < total; i++) {
      const d = addDays(start, i);
      if (isWeekend(d)) weekends.push({ key: dayKey(d), x: i * px, w: px });
    }
  }
  return { minor, major, weekends, width: total * px };
}
