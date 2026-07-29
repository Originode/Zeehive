// WORK TRACKER — THE TIMELINE (part 4), checked statically and rendered for real.
//
// Same bargain as test/work-console.test.mjs: there is no linter, no browser and no CI runner in
// this repo, so the only thing standing between a wiring mistake and a blank tab is a test that
// READS THE SOURCE and then RENDERS it. A gantt adds two failure modes the board did not have, and
// both are guarded here:
//
//   • DATE MATHS NOBODY CAN EYEBALL. An off-by-one day is invisible on a chart and wrong in the
//     plan, so every conversion (date ⇄ pixel, the zoom snap, the whole drag, the axis bands) lives
//     in web/src/work/timescale.js as pure functions with no imports at all — and this file
//     exercises them directly, in node, with fixed dates.
//   • A SECOND SOURCE OF TRUTH. `/api/gantt` already rolls a parent's span up from its children,
//     weights its progress by leaves and flags the undated rows. If the browser re-derived any of
//     that the two would drift, so the checks below insist the chart READS those fields rather than
//     computing them, and that its colours are the board's `.work-st-<key>` rules rather than a
//     second palette.
//
// The render pass at the end is the part that catches what reading cannot: a free identifier, a bad
// hook call, a crash on first paint. It renders the real chart over a FIXTURE (no network) and
// asserts on the markup — bars for the dated rows, a summary bracket for the parent, an arrow for
// the dependency, the undated tray, and NO bar for an undated row.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const path = (p) => resolve(here, '..', p);
const read = (p) => readFileSync(path(p), 'utf8');
// Source with COMMENTS stripped: the checks below hunt for text that must not appear in the CODE,
// and this repo's files carry long WHY headers that legitimately name the very things they forbid.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. the files exist, parse, and explain themselves ──
const FILES = ['web/src/work/Gantt.jsx', 'web/src/work/timescale.js'];
for (const f of FILES) {
  const there = existsSync(path(f));
  ok(there, `${f} exists`);
  if (!there) continue;
  let parsed = true; let why = '';
  try { transformSync(read(f), { loader: f.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic' }); }
  catch (e) { parsed = false; why = ` — ${String(e.message).split('\n')[0]}`; }
  ok(parsed, `${f} parses${why}`);
  ok(/\/\/ [^\n]{40,}/.test(read(f).split('\n').slice(0, 40).join('\n')), `${f} opens with a WHY comment`);
}

const gantt = read('web/src/work/Gantt.jsx');
const gcode = code('web/src/work/Gantt.jsx');
const scale = read('web/src/work/timescale.js');

// ── 2. the seam WorkConsole was cut along is untouched ──
ok(/export default function Gantt\(\s*\{\s*projectId,\s*rootId\s*\}/.test(gantt),
   'Gantt.jsx still exports `Gantt({ projectId, rootId })` — the contract part 2 froze');
ok(/export function GanttChart\(/.test(gantt),
   'the CHART is exported separately, so it can be rendered from a fixture with no network');
const consoleSrc = read('web/src/work/WorkConsole.jsx');
ok(/import\s+Gantt\s+from\s+['"]\.\/Gantt\.jsx['"]/.test(consoleSrc), 'WorkConsole imports Gantt');
ok(/<Gantt\s+projectId=\{[^}]*\}\s+rootId=\{[^}]*\}/.test(consoleSrc),
   'WorkConsole RENDERS <Gantt projectId rootId> (an import nothing renders is the old bug)');

// ── 3. the rows come from /api/gantt — the browser derives no dates of its own ──
ok(/getGantt\(/.test(gcode), 'the timeline calls getGantt() (GET /api/gantt), not a second read model');
ok(/\/api\/gantt/.test(read('web/src/work/workApi.js')), 'workApi.js is where that URL lives');
for (const field of ['computed_start', 'computed_end', 'rolled_progress', 'unscheduled']) {
  ok(gcode.includes(field), `the chart READS the server's ${field} rather than recomputing it`);
}
ok(!/Math\.min\(\s*\.\.\.[^)]*start/.test(gcode) && !/reduce\([^)]*computed_start/.test(gcode),
   'no roll-up is recomputed in the browser (the server owns min/max over children)');
// The one place dates are ever PROPOSED is the explicit "schedule" action in the undated tray.
ok(/scheduleWindow\(/.test(gcode) && /scheduleWindow/.test(scale),
   'undated rows are only ever dated by the explicit tray action (scheduleWindow), never inferred');

// ── 4. the colours are the board's, not a second palette ──
ok(/work-st-\$\{/.test(gantt), 'a bar takes its colour from the shared `.work-st-<key>` class');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(gcode), 'Gantt.jsx defines no colours of its own (no hex literals)');
const css = read('web/src/styles.css');
const fenceAt = css.indexOf('══ WORK TRACKER');
ok(fenceAt > 0 && !/\.work-/.test(css.slice(0, fenceAt)), 'the timeline CSS lives in the one fenced WORK TRACKER section');
const fence = css.slice(fenceAt);
for (const sel of ['.work-gbar', '.work-gsum', '.work-gtray', '.work-gtip', '.work-garrow', '.work-gtoday']) {
  ok(fence.includes(sel), `styles.css carries ${sel}`);
}
// The status keys the CSS knows must still be exactly the server's — the timeline adds none.
const mod = await import('../server/src/lib/work-status.js');
const serverKeys = mod.WORK_STATUS_KEYS || Object.keys(mod.WORK_STATUS || {});
const cssKeys = new Set([...fence.matchAll(/\.work-st-([a-z_]+)/g)].map((m) => m[1]));
ok(serverKeys.every((k) => cssKeys.has(k)) && cssKeys.size === serverKeys.length,
   `the dot/bar palette is exactly the server's vocabulary (${serverKeys.join(', ')})`);
// And no status key is typed into the timeline's code (it reads `terminal` off the vocabulary).
const leaked = [...new Set([...gcode.matchAll(/'([A-Za-z_]+)'|"([A-Za-z_]+)"/g)].map((m) => m[1] || m[2]))]
  .filter((s) => serverKeys.includes(s));
ok(!leaked.length, `Gantt.jsx hardcodes no status key${leaked.length ? ` (found: ${leaked.join(', ')})` : ''}`);
ok(/statuses \|\| \[\]\)\.find\(\(s\) => s\.key === key\)\?\.terminal|\.terminal/.test(gcode),
   '"overdue" asks the vocabulary whether the status is terminal — a finished item cannot be late');

// ── 4b. the two rules the audit added ──
ok(/dragged\.current/.test(gcode) && /if \(!dragged\.current\) return;/.test(gcode),
   'a gesture that never MOVED cannot write (belt one against the click-reschedules-it defect)');
ok(/shiftBy/.test(scale) && !/snapDate/.test(scale),
   'the drag quantises the MOVEMENT (shiftBy); the absolute-date snap that caused the defect is gone');
ok(/MAX_SPAN_DAYS/.test(scale) && /clamped/.test(gcode),
   'the window is capped by a NAMED constant and the chart announces the cap');

// ── 4c. the six sharp edges the audit left, once they were fixed ──
ok(/const todayKey = today \? dayKey\(today\) : null;/.test(gcode) && /\[todayKey\]/.test(gcode),
   'today is memoised on the DAY, not on a fresh object per render (the axis no longer rebuilds on every pointermove)');
ok(!/today = new Date\(\) \}/.test(gcode), 'and it is no longer a default prop that changes identity every render');
ok(/setZees\(null\)/.test(gcode) && /zeesKnown/.test(gcode),
   'a board that does not answer leaves the zees UNKNOWN, rather than asserting nobody is on the item');
ok(/inFlight/.test(gcode) && /inFlight\.current\.has\(id\)/.test(gcode),
   'a refetch clears only the optimistic overrides whose PATCH has already settled');
ok(/moved while you were dragging it/.test(gantt) && /onRefuse/.test(gcode),
   'a drop whose row moved under the gesture is REFUSED, not written last-wins');
ok(/linking/.test(gcode) && /\.work-garrows\.linking \.work-garrow-hit \{ pointer-events: none/.test(fence),
   'arrows go inert while a dependency is being drawn, so one cannot swallow the drop');
ok(/touch-action: none/.test(fence.slice(fence.indexOf('.work-gbar, .work-gsum'))),
   'bars and their handles set touch-action:none — the drag exists on a touchscreen at all');

// ── 5. dialogs, drawer, live ──
ok(/import\s*\{[^}]*showConfirm[^}]*\}\s*from\s*['"]\.\.\/Dialog\.jsx['"]/.test(gantt),
   'removing a dependency asks through Dialog.jsx (showConfirm), imported where it is called');
ok(!/(^|[^.\w])(window\.)?(confirm|alert|prompt)\s*\(/m.test(gcode.replace(/show(Confirm|Alert|Prompt)\s*\(/g, 'X(')),
   'no native window.confirm/alert/prompt (they park the event loop and freeze the SSE stream)');
ok(/import WorkItemDrawer from '\.\/WorkItemDrawer\.jsx'/.test(gantt) && /<WorkItemDrawer/.test(gantt),
   'clicking a bar opens the SAME drawer the board uses — there is no second detail pane');
ok(/subscribe\(/.test(gcode) && /onChange/.test(gcode),
   'the timeline refetches on the SSE `work` event, the way WorkConsole does');
ok(/legalNext|next_statuses/.test(gcode) === false,
   'the timeline offers no status picker of its own — the drawer owns that rule (bits.jsx legalNext)');
ok(/addDep\(|removeDep\(/.test(gcode) && /patchWorkItem\(/.test(gcode),
   'dependencies and reschedules go through workApi (POST/DELETE …/deps, PATCH …/work-items/:id)');

// ── 6. timescale.js is PURE (that is why it can be tested at all) ──
ok(!/^\s*import\s/m.test(scale), 'timescale.js imports nothing — no React, no DOM, no date library');
ok(!/document\.|window\.|React/.test(code('web/src/work/timescale.js')), 'timescale.js touches no browser globals');

const ts = await import('../web/src/work/timescale.js');
const D = (y, m, d) => new Date(y, m - 1, d);
// window: a fortnight either side, aligned to the zoom's unit, and readable when the plan is empty.
{
  const w = ts.windowFor([D(2026, 7, 20), D(2026, 7, 24)], { today: D(2026, 7, 20), zoom: 'day' });
  ok(ts.dayKey(w.start) === '2026-07-06', `a fortnight BEFORE the earliest start (${ts.dayKey(w.start)})`);
  ok(ts.diffDays(D(2026, 8, 7), w.end) >= 0, `a fortnight AFTER the latest end (${ts.dayKey(w.end)})`);
  const week = ts.windowFor([D(2026, 7, 20)], { today: D(2026, 7, 20), zoom: 'week' });
  ok(week.start.getDay() === 1, 'at week zoom the window starts on a MONDAY so the bands line up');
  const none = ts.windowFor([], { today: D(2026, 7, 20), zoom: 'day' });
  ok(none.days >= 28, `an EMPTY plan still gets a readable ruler (${none.days} days), not a zero-width canvas`);
}
// bar geometry: inclusive of the last day, and honest about a missing end.
{
  const w = ts.windowFor([D(2026, 7, 20), D(2026, 7, 22)], { today: D(2026, 7, 20), zoom: 'day' });
  const b = ts.barSpan(D(2026, 7, 20), D(2026, 7, 22), w.start, 10);
  ok(b.w === 30, `a three-day bar is three days wide, ends included (${b.w}px at 10px/day)`);
  ok(b.x === ts.diffDays(w.start, D(2026, 7, 20)) * 10, 'a bar starts where its start date is');
  ok(ts.barSpan(D(2026, 7, 20), null, w.start, 10).open === true, 'a row with no due date draws open-ended, not guessed');
  ok(ts.barSpan(null, null, w.start, 10) === null, 'a row with no dates at all draws NO bar');
}
// ── THE ZERO-MOVEMENT RULE — the defect this feature shipped with, pinned at every zoom ──────
// A bar starting on a Wednesday used to snap to Monday even when the delta was ZERO, so a plain
// CLICK on a bar (the commonest gesture on the tab) silently rescheduled it and then opened the
// drawer showing the moved dates as if a human had set them. dragDates now quantises the MOVEMENT,
// so a 0px gesture is an exact identity — asserted for every zoom × every mode × three bar shapes,
// because "it is fine at day zoom" was exactly how it hid.
{
  let bad = [];
  for (const zoom of ['day', 'week', 'month']) {
    for (const mode of [ts.MOVE, ts.START, ts.END]) {
      for (const [s0, e0] of [[D(2026, 7, 22), D(2026, 7, 24)],   // mid-week, mid-month
                              [D(2026, 1, 31), D(2026, 3, 15)],   // a month-end start
                              [D(2026, 7, 20), D(2026, 7, 20)]]) { // a one-day bar
        const r = ts.dragDates({ mode, start: s0, end: e0 }, 0, zoom);
        if (r.starts_on !== ts.dayKey(s0) || r.due_on !== ts.dayKey(e0)) bad.push(`${zoom}/${mode} ${ts.dayKey(s0)}→${r.starts_on}`);
      }
    }
  }
  ok(!bad.length, `a 0px gesture returns the ORIGINAL dates at every zoom and mode${bad.length ? ` — ${bad.join(', ')}` : ' (27 combinations)'}`);
}
// and a drag SHORTER than the zoom's unit is likewise a no-op, rather than a jump to the grid
ok(ts.dragDates({ mode: ts.MOVE, start: D(2026, 7, 22), end: D(2026, 7, 24) }, 3, 'week').starts_on === '2026-07-22',
   'a 3-day drag at WEEK zoom does not move the bar (under half a unit)');
ok(ts.dragDates({ mode: ts.MOVE, start: D(2026, 7, 22), end: D(2026, 7, 24) }, 4, 'week').starts_on === '2026-07-29',
   'a 4-day drag at week zoom moves it exactly ONE week, keeping its weekday');
ok(ts.dragDates({ mode: ts.MOVE, start: D(2026, 7, 22), end: D(2026, 7, 24) }, 10, 'month').starts_on === '2026-07-22',
   'a 10-day drag at MONTH zoom does not move the bar');
ok(ts.dragDates({ mode: ts.MOVE, start: D(2026, 7, 22), end: D(2026, 7, 24) }, 20, 'month').starts_on === '2026-08-22',
   'a 20-day drag at month zoom moves it exactly one month, keeping its day-of-month');
ok(ts.dayKey(ts.addMonthsKeepingDay(D(2026, 1, 31), 1)) === '2026-02-28',
   'a month shift out of a long month is clamped into the short one (Jan 31 → Feb 28), never overflowed');
// THE DRAG — the gesture as arithmetic, so the ghost and the PATCH cannot disagree.
{
  const g = { mode: ts.MOVE, start: D(2026, 7, 20), end: D(2026, 7, 24) };
  const moved = ts.dragDates(g, 3, 'day');
  ok(moved.starts_on === '2026-07-23' && moved.due_on === '2026-07-27', 'a MOVE carries both dates and keeps the length');
  const back = ts.dragDates(g, -30, 'day');
  ok(back.starts_on === '2026-06-20' && ts.diffDays(D(2026, 6, 20), new Date(2026, 5, 24)) === 4,
     'a move backwards is just as valid — the server, not the browser, refuses an impossible plan');
  const grown = ts.dragDates({ ...g, mode: ts.END }, 5, 'day');
  ok(grown.starts_on === '2026-07-20' && grown.due_on === '2026-07-29', 'an END resize moves only the end');
  const shrunk = ts.dragDates({ ...g, mode: ts.START }, 2, 'day');
  ok(shrunk.starts_on === '2026-07-22' && shrunk.due_on === '2026-07-24', 'a START resize moves only the start');
  const inside = ts.dragDates({ ...g, mode: ts.END }, -30, 'day');
  ok(inside.due_on === '2026-07-20', 'an edge dragged past the other one stops there — a bar is never inside out');
  ok(ts.daysAt(95, 30) === 3, 'a pixel delta becomes a WHOLE number of days');
}
// ── THE CLAMP — one accepted-but-absurd date used to ask for three million DOM nodes ─────────
{
  const p1 = (x) => { const m = /^(\d{1,4})-(\d{2})-(\d{2})/.exec(x); return new Date(+m[1], +m[2] - 1, +m[3]); };
  const wild = ts.windowFor([p1('0001-01-01'), p1('9999-12-31')], { today: D(2026, 7, 29), zoom: 'day' });
  ok(wild.days <= ts.MAX_SPAN_DAYS + 31, `an 8000-year span is clamped to ${wild.days} days (cap ${ts.MAX_SPAN_DAYS})`);
  ok(wild.clamped && wild.clamped.requested > 2000000, 'and the clamp REPORTS what it refused to draw, so the UI can say so');
  ok(ts.diffDays(wild.start, D(2026, 7, 29)) >= 0 && ts.diffDays(D(2026, 7, 29), wild.end) > 0,
     'the clamped window still contains TODAY — the work a human is doing is what they need to see');
  const typo = ts.windowFor([p1('2026-07-20'), p1('2206-08-01')], { today: D(2026, 7, 29), zoom: 'day' });
  ok(typo.clamped && typo.days <= ts.MAX_SPAN_DAYS + 31, 'a mistyped year (2206 for 2026) clamps too — the realistic case');
  const b = ts.bands(wild.start, wild.end, 'day', 30);
  ok(b.minor.length + b.weekends.length < 1600, `the clamped axis is ${b.minor.length + b.weekends.length} nodes, not millions`);
  const direct = ts.bands(new Date(1, 0, 1), new Date(9999, 11, 31), 'day', 30);
  ok(direct.minor.length <= ts.MAX_SPAN_DAYS, 'and bands() caps itself even when handed an unclamped window directly (belt + braces)');
  ok(ts.windowFor([D(2026, 7, 20), D(2026, 8, 5)], { today: D(2026, 7, 29), zoom: 'day' }).clamped === null,
     'an ordinary plan is NOT clamped and says so');
}
// a bar reaching past the clamped window is CUT, not laid into the scroller at 657,000px
{
  ok(ts.clampSpan({ x: -50, w: 657490 }, 1000).w === 1000, 'a bar wider than the canvas is cut to it');
  const cut = ts.clampSpan({ x: -50, w: 657490 }, 1000);
  ok(cut.cutLeft && cut.cutRight, 'and marked on both ends, so a human sees it continues');
  ok(ts.clampSpan({ x: 5000, w: 100 }, 1000) === null,
     'a bar entirely outside the window draws NOTHING — the row keeps its name and the clamp notice counts it');
  ok(ts.clampSpan({ x: 20, w: 50 }, 1000).cutRight === false, 'an ordinary bar is untouched');
  ok(ts.clampSpan(null, 1000) === null, 'and an undated row is still no bar at all');
}
// an INVERTED row (due before start) spans the contradiction rather than hiding as a 6px stub.
// Migration 060 now forbids storing one; this stays as the defence that made the case visible.
{
  const w = ts.windowFor([D(2026, 7, 20), D(2026, 8, 10)], { today: D(2026, 7, 29), zoom: 'day' });
  const inv = ts.barSpan(D(2026, 8, 10), D(2026, 7, 20), w.start, 30);
  ok(inv.inverted === true, 'an inverted row is FLAGGED (060 now forbids storing one — this is the belt)');
  ok(inv.w === 22 * 30, `and drawn across both dates (${inv.w}px = 22 days), not collapsed to the 6px minimum`);
  ok(ts.barSpan(D(2026, 7, 20), D(2026, 7, 20), w.start, 30).inverted === false, 'an honest one-day bar is not');
}
// the axis
{
  const w = ts.windowFor([D(2026, 7, 1), D(2026, 7, 31)], { today: D(2026, 7, 15), zoom: 'day' });
  const b = ts.bands(w.start, w.end, 'day', 30);
  ok(b.minor.length === w.days, 'day zoom labels every day');
  ok(b.weekends.length > 0, 'weekends are banded when a day is wide enough to see');
  ok(b.major.length >= 2 && /\d{4}/.test(b.major[0].label), 'the band above them names the month and year');
  ok(ts.bands(w.start, w.end, 'month', 3.4).weekends.length === 0,
     'at month zoom the weekend stripes are dropped — a 3px stripe is noise, not information');
  ok(Math.round(b.width) === Math.round(w.days * 30), 'the canvas is exactly as wide as the window');
}
// the tray's proposal
ok(ts.scheduleWindow({ estimate_hours: 16 }, D(2026, 7, 29)).due_on === '2026-07-31',
   'an item with a 16h estimate is scheduled today → today + 2 days');
ok(ts.scheduleWindow({}, D(2026, 7, 29)).due_on === '2026-07-30',
   'an item with NO estimate gets today → today + 1 day');

// ── 7. RENDER: the chart over a fixture, and the tab over a stubbed fetch ──────────────────────
const ROWS = [
  { id: 'p', parent_id: null, depth: 0, kind: 'project', title: 'Project', status: serverKeys[0],
    starts_on: null, due_on: null, computed_start: '2026-07-20', computed_end: '2026-08-05',
    progress: 0, rolled_progress: 40, deps: [], unscheduled: false },
  { id: 'a', parent_id: 'p', depth: 1, kind: 'activity', title: 'Activity', status: serverKeys[2],
    starts_on: null, due_on: null, computed_start: '2026-07-20', computed_end: '2026-08-05',
    progress: 0, rolled_progress: 40, deps: [], unscheduled: false },
  { id: 't1', parent_id: 'a', depth: 2, kind: 'task', title: 'First task', status: serverKeys[2],
    starts_on: '2026-07-20', due_on: '2026-07-24', computed_start: '2026-07-20', computed_end: '2026-07-24',
    progress: 80, rolled_progress: 80, estimate_hours: 8, deps: [], unscheduled: false },
  { id: 't2', parent_id: 'a', depth: 2, kind: 'task', title: 'Second task', status: serverKeys[0],
    starts_on: '2026-07-28', due_on: '2026-08-05', computed_start: '2026-07-28', computed_end: '2026-08-05',
    progress: 0, rolled_progress: 0, deps: ['t1'], unscheduled: false },
  { id: 't3', parent_id: 'a', depth: 2, kind: 'task', title: 'Undated task', status: serverKeys[0],
    starts_on: null, due_on: null, computed_start: null, computed_end: null,
    progress: 0, rolled_progress: 0, estimate_hours: 4, deps: [], unscheduled: true },
];
const statuses = serverKeys.map((key, i) => ({ key, label: key, order: i, terminal: i >= serverKeys.length - 2 }));

const render = async () => {
  const esbuild = await import('esbuild');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  const out = resolve(tmpdir(), 'work-gantt-smoke.cjs');
  await esbuild.build({
    stdin: {
      contents: `
        const React = require('react');
        const { renderToString } = require('react-dom/server');
        const G = require('./Gantt.jsx');
        module.exports = { React, renderToString, Gantt: G.default, GanttChart: G.GanttChart, crumbOf: G.crumbOf, hiddenTitle: G.hiddenTitle, Tip: G.Tip };
      `,
      resolveDir: resolve(here, '..', 'web/src/work'),
      loader: 'js',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
  });
  return createRequire(out)(out);
};

try {
  const { React, renderToString, Gantt, GanttChart, crumbOf, hiddenTitle, Tip } = await render();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"rows":[]}' });
  const el = (C, props) => React.createElement(C, props);
  const today = D(2026, 7, 29);

  const tab = renderToString(el(Gantt, { projectId: 'p', rootId: null }));
  ok(true, 'the tab renders without throwing (free identifiers, bad hooks, first-paint crashes)');
  ok(/data-testid="work-gantt"/.test(tab), 'the first frame already carries data-testid="work-gantt"');
  ok(/loading the timeline/.test(tab), 'and says it is loading rather than showing an empty chart');

  const chart = renderToString(el(GanttChart, {
    rows: ROWS, statuses, zees: new Map(), unscheduledCount: 1, today,
  }));
  const bars = (chart.match(/data-testid="work-gbar"/g) || []).length;
  ok(bars === 4, `one bar per DATED row and none for the undated one (${bars} bars for 4 dated rows)`);
  ok(/work-gsum/.test(chart), 'a parent draws as a SUMMARY bracket, not a solid bar');
  ok(/work-gbar[^"]*"/.test(chart), 'a leaf draws as a bar');
  ok(chart.includes(`work-st-${serverKeys[2]}`), 'bars carry the shared status colour class');
  ok(/work-garrow-line/.test(chart) && /marker-end/.test(chart), 'the finish→start dependency is drawn as an arrow with a head');
  ok(/work-gtoday/.test(chart), 'the TODAY line is drawn');
  ok(/work-gwe/.test(chart) || /work-gmin[^"]*we/.test(chart), 'weekends are banded');
  ok(/data-testid="work-gtray"/.test(chart) && /Undated task/.test(chart) && />schedule</.test(chart),
     'the undated row is LISTED in the tray with a schedule action');
  ok(!/2026-07-29/.test(chart.split('work-gtray')[1] || ''), 'the tray shows no invented dates on the row itself');
  ok(/Undated task/.test(chart), 'and the undated row is still named, not hidden');

  const emptyChart = renderToString(el(GanttChart, { rows: [], statuses, today }));
  ok(/Tickets/.test(emptyChart) && /work-gempty/.test(emptyChart),
     'an empty scope tells a manager what to do next (break a ticket down), not a blank rectangle');
  const undatedOnly = renderToString(el(GanttChart, { rows: [ROWS[4]], statuses, unscheduledCount: 1, today }));
  ok(/No dated work items yet/.test(undatedOnly) && /work-gtray/.test(undatedOnly),
     'a plan with rows but no dates says so AND still lists them');

  ok(crumbOf(ROWS[3], new Map(ROWS.map((r) => [r.id, r]))).join(' › ') === 'Project › Activity',
     'the tooltip breadcrumb is built from the rows already in hand — no second request');

  // THE TOOLTIP, rendered directly. It only appears on hover, so a chart render cannot reach it —
  // and it is where three genuinely different facts about "who is on it" are told apart.
  {
    const row = { id: 't1', title: 'x', kind: 'task', status: serverKeys[0], starts_on: '2026-07-20',
                  due_on: '2026-07-24', computed_start: '2026-07-20', computed_end: '2026-07-24', assignee: null };
    const tip = (props) => renderToString(el(Tip, { row, x: 10, y: 10, statuses, crumb: [], today, ...props }));
    ok(/could not read who is on it/.test(tip({ zeesKnown: false })),
       'when the board did not answer, the tooltip says it does not KNOW who is on it');
    ok(/nobody on it/.test(tip({ zeesKnown: true })), 'when it does know and nobody is, it says so');
    ok(/alice/.test(tip({ zeesKnown: true, row: { ...row, assignee: 'alice' } })), 'an assignee is named');
    ok(/work-zee/.test(tip({ zeesKnown: true, zee: { slug: 'brisk-fen-1', hive_status: 'occ-working' } })),
       'and a live zee is drawn as the hive chip, in the hive palette');
    ok(/rolled up from the children/.test(tip({ summary: true, row: { ...row, starts_on: null, due_on: null } })),
       'a computed-only row explains why it cannot be dragged');
    ok(/waits for/.test(tip({ hidden: [{ title: 'blocker', why: 'has no dates yet' }] })),
       'and an undrawable dependency is spelled out where a human is already looking');
  }

  // ── the four UI fixes, rendered ───────────────────────────────────────────────────────────
  const R = (o) => ({ parent_id: null, depth: 0, kind: 'task', status: serverKeys[0], progress: 0,
                      rolled_progress: 0, deps: [], unscheduled: false, ...o });
  const count = (h, re) => (h.match(re) || []).length;

  // a PARENT that states its OWN dates may be dragged (it used to have no handles and no explanation)
  {
    const h = renderToString(el(GanttChart, { today, statuses, rows: [
      R({ id: 'a', kind: 'activity', title: 'own dates', starts_on: '2026-07-20', due_on: '2026-08-05',
          computed_start: '2026-07-20', computed_end: '2026-08-05' }),
      R({ id: 'k', parent_id: 'a', depth: 1, title: 'child', starts_on: '2026-07-22', due_on: '2026-07-24',
          computed_start: '2026-07-22', computed_end: '2026-07-24' }),
      R({ id: 'b', kind: 'activity', title: 'rolled up', computed_start: '2026-07-20', computed_end: '2026-08-05' }),
      R({ id: 'c', parent_id: 'b', depth: 1, title: 'child2', starts_on: '2026-07-20', due_on: '2026-08-05',
          computed_start: '2026-07-20', computed_end: '2026-08-05' }),
    ] }));
    ok(count(h, /work-ghandle/g) === 6, `a parent with its OWN dates gets drag handles; one with only rolled-up dates does not (${count(h, /work-ghandle/g) / 2} of 4 rows draggable)`);
    ok(count(h, /class="work-gsum/g) === 2, 'both parents still draw as summary BRACKETS — draggability is about ownership, not shape');
  }
  // an undrawable dependency SAYS something
  {
    const h = renderToString(el(GanttChart, { today, statuses, unscheduledCount: 1, rows: [
      R({ id: 'u', title: 'undated blocker', computed_start: null, computed_end: null, unscheduled: true }),
      R({ id: 'b', title: 'blocked', starts_on: '2026-08-01', due_on: '2026-08-05',
          computed_start: '2026-08-01', computed_end: '2026-08-05', deps: ['u'] }),
      R({ id: 'c', title: 'blocked from outside', starts_on: '2026-08-01', due_on: '2026-08-05',
          computed_start: '2026-08-01', computed_end: '2026-08-05', deps: ['gone'] }),
    ] }));
    ok(count(h, /work-gdepx/g) === 2, `each undrawable dependency is marked on the successor (${count(h, /work-gdepx/g)} of 2)`);
    ok(/has no dates yet/.test(h) && /outside the scope/.test(h), 'and the marker says WHY it cannot be drawn');
    ok(hiddenTitle([{ title: 'x', why: 'has no dates yet' }]).startsWith('waits for 1 item'),
       'the marker and the tooltip describe it with the SAME sentence (one function)');
  }
  // an inverted row is painted as inverted
  {
    const h = renderToString(el(GanttChart, { today, statuses, rows: [
      R({ id: 'i', title: 'inverted', starts_on: '2026-08-10', due_on: '2026-07-20',
          computed_start: '2026-08-10', computed_end: '2026-07-20' })] }));
    ok(/work-gbar[^"]*inverted/.test(h), 'an inverted row carries the inverted class');
    const m = /data-gbar="i"[^>]*style="left:([\d.]+)px;width:([\d.]+)px"/.exec(h);
    ok(m && Number(m[2]) > 6, `and spans the contradiction (${m ? m[2] : '?'}px), instead of the 6px stub that hid it`);
  }
  // the clamp is ANNOUNCED, not silent
  {
    const h = renderToString(el(GanttChart, { today, statuses, rows: [
      R({ id: 'w', title: 'typo', starts_on: '2026-07-20', due_on: '2206-08-01',
          computed_start: '2026-07-20', computed_end: '2206-08-01' })] }));
    ok(/work-gclamp/.test(h), 'a plan too long to draw shows the clamp notice');
    const widest = Math.max(...[...h.matchAll(/data-gbar="[^"]*"[^>]*style="left:[\d.]+px;width:([\d.]+)px"/g)].map((m) => Number(m[1])));
    ok(widest <= 40000, `and no bar is laid into the scroller wider than the canvas (widest ${widest}px, not 657,490)`);
    ok(/work-gcut/.test(h), 'the cut end is marked, so the bar does not pretend to end there');
    ok(/mistyped year/.test(h) && /days/.test(h), 'and tells the human what to do about it');
    ok(count(h, /work-gmin/g) < 1600, `while the axis stays at ${count(h, /work-gmin/g)} cells`);
    ok(!/work-gclamp/.test(renderToString(el(GanttChart, { rows: ROWS, statuses, today }))),
       'an ordinary plan shows no notice');
  }
} catch (e) {
  ok(false, `the timeline threw while rendering — ${String(e.message).split('\n')[0]}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
