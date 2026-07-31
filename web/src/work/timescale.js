// WORK TRACKER — the TIME AXIS maths, kept as pure functions on purpose (the same bargain as
// order.js: the genuinely algorithmic part of a drag lives where a test can reach it).
//
// A gantt is two pieces of arithmetic wearing a chart: WHERE a date sits on a pixel ruler, and
// WHICH date a pixel means when a human drags a bar. Both are easy to get subtly wrong and
// impossible to eyeball — an off-by-one day is invisible on screen and wrong in the plan — so
// every one of them is here, with no React, no DOM and no imports, and `test/work-gantt.test.mjs`
// exercises them directly.
//
// FOUR RULES THIS MODULE HOLDS:
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
// 3. A DRAG SNAPS THE **DELTA**, NEVER THE ABSOLUTE DATE. At month zoom a pixel is a third of a
//    day, so an unsnapped drag would write a date the human cannot see they chose — but snapping
//    the RESULTING date is worse, and shipped as a real defect: a bar starting on a Wednesday
//    snapped to Monday even when the delta was ZERO, so at week/month zoom a plain CLICK on a bar
//    silently rescheduled it (and the drawer then opened showing the moved dates as if a human had
//    set them). Quantising the MOVEMENT instead makes a 0px gesture an exact identity at every
//    zoom — pinned by an assertion per zoom per mode in test/work-gantt.test.mjs — and it keeps a
//    bar's weekday, which is what a planner meant when they put it on a Wednesday.
//    `dragDates()` is still the whole gesture as one pure function, so the ghost bar and the PATCH
//    cannot disagree.
//
// 4. THE WINDOW IS CLAMPED, AND THE CLAMP IS ANNOUNCED. The API accepts any date postgres accepts
//    (`0001-01-01`, a fat-fingered `2206`), a parent rolls it up, and an unclamped ruler then wants
//    ~3 million day cells — the tab hangs. So the window is capped at MAX_SPAN_DAYS and says so
//    (`clamped`), because a chart that admits "this plan spans 8,000 years; showing three" is
//    honest, and one that freezes is not.

export const DAY_MS = 86400000;

// px = pixels per DAY at that zoom. Day zoom is wide enough to label every day; month zoom fits a
// year or so of plan on one screen. The zoom's unit is what a drag's MOVEMENT quantises to (rule 3).
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

// THE CAP, and why this number. Every day in the window is an axis cell at day zoom (plus a weekend
// stripe every third one), and each one is a DOM element — so the window length IS the render cost.
// 1100 days is a little over three years: more plan than anyone reads in one screen, ~1400 elements
// at the worst zoom (fine), and small enough that the pathological input can no longer hang the tab.
// The pathological input is real, not theoretical: PATCH accepts `0001-01-01`/`9999-12-31` (verified
// against the live API), a parent rolls that span up, and the unclamped ruler wanted 2,958,161 days.
// A mistyped year — 2206 for 2026 — wanted 65,784. Both now clamp and SAY they clamped.
export const MAX_SPAN_DAYS = 1100;

// The visible window: a fortnight either side of the plan, aligned to the zoom's unit, so the bands
// line up with the labels. An EMPTY plan still gets a readable ruler around today rather than a
// zero-width canvas — a chart of nothing must still look like a chart. A plan longer than `max` is
// cut to a window anchored on TODAY (or on the plan's start, when today is nowhere near it) and
// reports the cut in `clamped`, so the UI can say what it is not showing.
export function windowFor(dates, { today = new Date(), pad = 14, min = 28, zoom = 'week', max = MAX_SPAN_DAYS } = {}) {
  const list = (dates || []).filter(Boolean).map(startOfDay).sort((a, b) => a.getTime() - b.getTime());
  let start = list.length ? addDays(list[0], -pad) : addDays(today, -pad);
  let end = list.length ? addDays(list[list.length - 1], pad) : addDays(today, pad * 2);
  if (diffDays(start, end) < min) end = addDays(start, min);

  let clamped = null;
  const requested = diffDays(start, end);
  if (requested > max) {
    const inside = diffDays(start, today) >= 0 && diffDays(today, end) >= 0;
    const anchor = inside ? startOfDay(today) : start;
    let s = addDays(anchor, -Math.round(max / 4));      // a quarter of the window is history
    if (diffDays(start, s) < 0) s = start;
    start = s;
    end = addDays(s, max);
    clamped = { requested, shown: max, from: dayKey(start), to: dayKey(end) };
  }

  const align = zoom === 'month' ? startOfMonth : zoom === 'week' ? startOfWeek : startOfDay;
  start = align(start);
  end = align(addDays(end, zoom === 'month' ? 31 : zoom === 'week' ? 7 : 1));
  return { start, end, days: diffDays(start, end), clamped };
}

// A bar may reach outside the window — an out-of-range date, or simply a plan wider than the clamp.
// Draw the part that is inside and SAY it continues: laying a 657,000px element into the scroller
// (measured, from a mistyped year) leaves the horizontal scrollbar meaningless, which defeats the
// clamp it was drawn inside. A bar entirely outside returns null — the row keeps its name and the
// clamp notice counts it, which is more honest than a bar parked on the edge pretending to be there.
export function clampSpan(span, width, minW = 6) {
  if (!span) return null;
  const right = span.x + span.w;
  if (right <= 0 || span.x >= width) return null;
  const x = Math.max(0, span.x);
  const w = Math.max(minW, Math.min(width, right) - x);
  return { ...span, x, w, cutLeft: span.x < 0, cutRight: right > width };
}

// date → x, and a pixel delta → a number of WHOLE days (the only two conversions the chart needs).
export const xOf = (date, start, px) => diffDays(start, date) * px;
export const daysAt = (dx, px) => Math.round(dx / (px || 1));

// A bar's rectangle. `end` may be missing (a row with a start and no due date, which the server
// reports honestly rather than filling in) — that draws as a single unit, marked open-ended.
//
// An INVERTED row (due_on before starts_on) can no longer be STORED — migration 060 made
// due_on >= starts_on an invariant, and the library refuses it with a sentence — but this stays,
// deliberately: it costs three lines, it is what made the case visible in the first place (the bar
// used to collapse to the 6px minimum at the start date, pixel-identical to an ordinary one-day
// task, which is how a contradiction hides in plain sight), and a read model is not the only way
// rows arrive. If one ever does, it spans the contradiction (due → start) and says `inverted` so
// the caller can paint it as the mistake it is, instead of drawing a tidy little lie.
export function barSpan(start, end, winStart, px, minW = 6) {
  if (!start && !end) return null;
  const s = start || end;
  const e = end || start;
  const inverted = diffDays(s, e) < 0;
  const from = inverted ? e : s;
  const to = inverted ? s : e;
  const x = xOf(from, winStart, px);
  const w = Math.max(minW, (diffDays(from, to) + 1) * px);
  return { x, w, open: !end, inverted };
}

// Add n months KEEPING the day of the month (clamped into short months: Jan 31 + 1 → Feb 28), as
// opposed to addMonths() above, which is the axis's "go to the 1st" helper.
export function addMonthsKeepingDay(d, n) {
  const x = startOfDay(d);
  const first = new Date(x.getFullYear(), x.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(x.getDate(), last));
  return startOfDay(first);
}

// Move a date by a drag of `days`, quantised to the zoom's unit — one day, one week, one month.
// The quantum is applied to the MOVEMENT, so `days === 0` is an exact identity at every zoom (see
// rule 3), and a bar keeps the weekday / day-of-month its planner chose.
export function shiftBy(date, days, zoom) {
  if (zoom === 'month') return addMonthsKeepingDay(date, Math.round(days / 30.4375));
  if (zoom === 'week') return addDays(date, Math.round(days / 7) * 7);
  return addDays(date, Math.round(days));
}

// THE WHOLE DRAG, as arithmetic. `mode` is MOVE (both ends travel together, the length is kept),
// START or END (one edge moves and the bar cannot be turned inside out). Returns the exact
// `{starts_on, due_on}` body the PATCH will send, so the ghost bar and the request agree.
export function dragDates({ mode, start, end }, days, zoom) {
  const s0 = startOfDay(start);
  const e0 = startOfDay(end || start);
  if (mode === START) {
    let s = shiftBy(s0, days, zoom);
    if (diffDays(s, e0) < 0) s = e0;                 // an edge dragged past the other one stops there
    return { starts_on: dayKey(s), due_on: dayKey(e0) };
  }
  if (mode === END) {
    let e = shiftBy(e0, days, zoom);
    if (diffDays(s0, e) < 0) e = s0;
    return { starts_on: dayKey(s0), due_on: dayKey(e) };
  }
  const s = shiftBy(s0, days, zoom);
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
  // A belt as well as braces: windowFor already clamps, but a caller that computes its own window
  // must not be able to ask this function for three million DOM elements.
  const total = Math.min(diffDays(start, end), MAX_SPAN_DAYS);
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
