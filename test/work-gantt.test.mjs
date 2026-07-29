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
// the snap, per zoom
ok(ts.dayKey(ts.snapDate(D(2026, 7, 29), 'day')) === '2026-07-29', 'day zoom snaps to the day');
ok(ts.snapDate(D(2026, 7, 29), 'week').getDay() === 1, 'week zoom snaps to a Monday');
ok(ts.dayKey(ts.snapDate(D(2026, 7, 29), 'month')) === '2026-08-01', 'month zoom snaps to the nearest 1st');
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
        module.exports = { React, renderToString, Gantt: G.default, GanttChart: G.GanttChart, crumbOf: G.crumbOf };
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
  const { React, renderToString, Gantt, GanttChart, crumbOf } = await render();
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
} catch (e) {
  ok(false, `the timeline threw while rendering — ${String(e.message).split('\n')[0]}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
