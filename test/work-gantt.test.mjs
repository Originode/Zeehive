// WORK TRACKER — THE TIMELINE (stage 6: re-pointed at the model), checked statically and rendered
// for real.
//
// Same bargain as test/work-console.test.mjs: there is no linter, no browser and no CI runner in
// this repo, so the only thing standing between a wiring mistake and a blank tab is a test that
// READS THE SOURCE and then RENDERS it. Stage 6 re-pointed Gantt.jsx at the HIERARCHICAL WORKFLOW
// MODEL — PLANNED from the CPM pass, ACTUAL from execution.started_at/finished_at, WAITING from
// held leases on waiting executions — so the static checks that used to look for work-item
// roll-ups now look for the three server-derived layers, and the render pass feeds the chart a
// workflow-shaped fixture. Coverage:
//
//   • the seam WorkConsole cuts along: Gantt({ projectId }) is exported and rendered, GanttChart
//     is exported separately for fixture rendering, and the timeline calls getWorkflowGantt
//     (GET /api/workflow/gantt) — the model read model, not a second /api/gantt.
//   • the chart READS the server's planned/actual/waiting dates and recomputes none of them in
//     the browser (the CPM pass and the execution/lease roll-up are the server's).
//   • the colours are the shared WORK TRACKER fence's classes, not a second palette; the fence
//     carries the waiting bar, the critical marker and the weld waterfall.
//   • timescale.js stays PURE (that is why it can be tested at all) — unchanged by stage 6.
//   • RENDER: the chart over a workflow fixture draws one PLAN bar per row, one ACTUAL bar per
//     row the record has dates for, one WAITING bar per row under a held lease, a summary
//     bracket for a container, the critical marker, and the re-anchored dependency arrows; a
//     COLLAPSED parent hides its children and RE-ANCHORS an edge from a hidden child onto the
//     parent bar; clicking opens the WELD WATERFALL.
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

// ── 2. the seam WorkConsole was cut along ──
ok(/export default function Gantt\(\s*\{\s*projectId\s*\}/.test(gantt),
   'Gantt.jsx exports `Gantt({ projectId })` — the model timeline takes a project, not a work_item root');
ok(/export function GanttChart\(/.test(gantt),
   'the CHART is exported separately, so it can be rendered from a fixture with no network');
const consoleSrc = read('web/src/work/WorkConsole.jsx');
ok(/import\s+Gantt\s+from\s*['"]\.\/Gantt\.jsx['"]/.test(consoleSrc), 'WorkConsole imports Gantt');
ok(/<Gantt\s+projectId=\{[^}]*\}\s+rootId=\{[^}]*\}/.test(consoleSrc),
   'WorkConsole RENDERS <Gantt projectId rootId> (rootId is ignored — the trace is the project plan)');

// ── 3. the rows come from /api/workflow/gantt — the browser derives no dates of its own ──
ok(/getWorkflowGantt\(/.test(gcode), 'the timeline calls getWorkflowGantt() (GET /api/workflow/gantt)');
ok(/\/api\/workflow\/gantt/.test(read('web/src/work/workApi.js')), 'workApi.js is where that URL lives');
for (const field of ['planned_start', 'planned_end', 'actual_start', 'actual_end', 'waiting_start', 'waiting_end']) {
  ok(gcode.includes(field), `the chart READS the server's ${field} rather than recomputing it`);
}
ok(!/Math\.min\(\s*\.\.\.[^)]*start/.test(gcode) && !/reduce\([^)]*planned_start/.test(gcode),
   'no roll-up is recomputed in the browser (the CPM pass and the execution/lease roll-up are the server\'s)');
ok(!/onReschedule|patchWorkItem|scheduleWindow\(/.test(gcode),
   'the model timeline NEVER proposes or writes dates — a CPM plan is computed, not dragged');

// ── 4. the colours are the shared fence's, not a second palette ──
ok(!/#[0-9a-fA-F]{3,8}\b/.test(gcode), 'Gantt.jsx defines no colours of its own (no hex literals)');
const css = read('web/src/styles.css');
const fenceAt = css.indexOf('══ WORK TRACKER');
ok(fenceAt > 0 && !/\.work-/.test(css.slice(0, fenceAt)), 'the timeline CSS lives in the one fenced WORK TRACKER section');
const fence = css.slice(fenceAt);
for (const sel of ['.work-gbar', '.work-gsum', '.work-gtip', '.work-garrow', '.work-gtoday',
                   '.work-gbar.waiting', '.work-gcrit', '.work-waterfall']) {
  ok(fence.includes(sel), `styles.css carries ${sel}`);
}

// ── 5. dialogs, waterfall, live ──
ok(/<WeldWaterfall/.test(gantt) && /export function WeldWaterfall/.test(gantt),
   'clicking a bar opens the WELD WATERFALL (execution → turn → gateway), defined and rendered here');
ok(!/(^|[^.\w])(window\.)?(confirm|alert|prompt)\s*\(/m.test(gcode.replace(/show(Confirm|Alert|Prompt)\s*\(/g, 'X(')),
   'no native window.confirm/alert/prompt (they park the event loop and freeze the SSE stream)');
ok(/subscribe\(/.test(gcode) && /onChange/.test(gcode),
   'the timeline refetches on the SSE `work` event, the way WorkConsole does');

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
  const none = ts.windowFor([], { today: D(2026, 7, 20), zoom: 'day' });
  ok(none.days >= 28, `an EMPTY plan still gets a readable ruler (${none.days} days), not a zero-width canvas`);
}
// bar geometry: inclusive of the last day, and honest about a missing end.
{
  const w = ts.windowFor([D(2026, 7, 20), D(2026, 7, 22)], { today: D(2026, 7, 20), zoom: 'day' });
  const b = ts.barSpan(D(2026, 7, 20), D(2026, 7, 22), w.start, 10);
  ok(b.w === 30, `a three-day bar is three days wide, ends included (${b.w}px at 10px/day)`);
  ok(ts.barSpan(D(2026, 7, 20), null, w.start, 10).open === true, 'a row with no due date draws open-ended, not guessed');
  ok(ts.barSpan(null, null, w.start, 10) === null, 'a row with no dates at all draws NO bar');
}
// THE CLAMP — one accepted-but-absurd date used to ask for three million DOM nodes
{
  const p1 = (x) => { const m = /^(\d{1,4})-(\d{2})-(\d{2})/.exec(x); return new Date(+m[1], +m[2] - 1, +m[3]); };
  const wild = ts.windowFor([p1('0001-01-01'), p1('9999-12-31')], { today: D(2026, 7, 29), zoom: 'day' });
  ok(wild.days <= ts.MAX_SPAN_DAYS + 31, `an 8000-year span is clamped to ${wild.days} days (cap ${ts.MAX_SPAN_DAYS})`);
  ok(wild.clamped && wild.clamped.requested > 2000000, 'and the clamp REPORTS what it refused to draw, so the UI can say so');
  ok(ts.bands(wild.start, wild.end, 'day', 30).minor.length < 1600, `the clamped axis is a bounded number of nodes`);
}

// ── 7. RENDER: the chart over a workflow fixture ─────────────────────────────────────────────
const ROWS = [
  // R — a freeform container: span is its subtree, critical, no own executions but rolls actuals
  { id: 'R', parent_id: null, depth: 1, name: 'R', kind: 'container', child_semantics: 'freeform',
    is_atom: false, critical: true, slack: null, duration_hours: 10,
    planned_start: '2026-08-01T09:00:00.000Z', planned_end: '2026-08-05T17:00:00.000Z',
    actual_start: '2026-08-02T09:00:00.000Z', actual_end: '2026-08-04T15:00:00.000Z',
    waiting_start: '2026-08-03T09:00:00.000Z', waiting_end: '2026-08-10T09:00:00.000Z',
    deps: [], executions: [] },
  // A1 — a done leaf: planned + actual
  { id: 'A1', parent_id: 'R', depth: 2, name: 'A1', kind: 'action', child_semantics: null,
    is_atom: true, critical: true, slack: '00:00:00', duration_hours: 2,
    planned_start: '2026-08-01T09:00:00.000Z', planned_end: '2026-08-01T11:00:00.000Z',
    actual_start: '2026-08-02T09:00:00.000Z', actual_end: '2026-08-02T11:00:00.000Z',
    waiting_start: null, waiting_end: null, deps: [], executions: [] },
  // A2 — a leaf waiting under a held lease (the gate wait)
  { id: 'A2', parent_id: 'R', depth: 2, name: 'A2', kind: 'action', child_semantics: null,
    is_atom: true, critical: true, slack: '00:00:00', duration_hours: 3,
    planned_start: '2026-08-01T11:00:00.000Z', planned_end: '2026-08-01T14:00:00.000Z',
    actual_start: null, actual_end: null,
    waiting_start: '2026-08-03T09:00:00.000Z', waiting_end: '2026-08-10T09:00:00.000Z',
    deps: ['A1'], executions: [] },
  // B1 — a leaf with slack, depending on A2; its ACTUAL pair is INVERTED (end before start) — a
  // bad derivation must be visible as the dashed `inverted` bar and a tooltip warning, not silent.
  { id: 'B1', parent_id: 'R', depth: 2, name: 'B1', kind: 'action', child_semantics: null,
    is_atom: true, critical: false, slack: '09:00:00', duration_hours: 1,
    planned_start: '2026-08-04T09:00:00.000Z', planned_end: '2026-08-04T10:00:00.000Z',
    actual_start: '2026-08-06T09:00:00.000Z', actual_end: '2026-08-04T10:00:00.000Z',
    waiting_start: null, waiting_end: null,
    deps: ['A2'], executions: [] },
];

const render = async () => {
  const esbuild = await import('esbuild');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  const out = resolve(tmpdir(), 'work-gantt-stage6.cjs');
  await esbuild.build({
    stdin: {
      contents: `
        const React = require('react');
        const { renderToString } = require('react-dom/server');
        const G = require('./Gantt.jsx');
        module.exports = { React, renderToString, Gantt: G.default, GanttChart: G.GanttChart,
                           WeldWaterfall: G.WeldWaterfall, hiddenTitle: G.hiddenTitle, Tip: G.Tip };
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
  const { React, renderToString, Gantt, GanttChart, WeldWaterfall, hiddenTitle, Tip } = await render();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"rows":[]}' });
  const el = (C, props) => React.createElement(C, props);
  const today = D(2026, 7, 29);

  const tab = renderToString(el(Gantt, { projectId: 'p' }));
  ok(true, 'the tab renders without throwing (free identifiers, bad hooks, first-paint crashes)');
  ok(/data-testid="work-gantt"/.test(tab), 'the first frame already carries data-testid="work-gantt"');
  ok(/loading the timeline/.test(tab), 'and says it is loading rather than showing an empty chart');

  const chart = renderToString(el(GanttChart, { rows: ROWS, planName: 'stage6', version: 1, today }));
  const count = (h, re) => (h.match(re) || []).length;
  const bars = count(chart, /data-testid="work-gbar"/g);
  const actualBars = count(chart, /data-testid="work-gbar-actual"/g);
  const waitingBars = count(chart, /data-testid="work-gbar-waiting"/g);
  ok(bars === 4, `one PLAN bar per row (${bars} — R, A1, A2, B1)`);
  ok(actualBars === 3, `one ACTUAL bar per row the record has dates for (${actualBars} — R rolled up, A1, and B1's inverted pair)`);
  ok(/work-gbar actual inverted/.test(chart),
     'an inverted actual pair renders the ACTUAL bar with the `inverted` class — the dashed outline makes a bad derivation visible, not silent');
  ok(waitingBars === 2, `one WAITING bar per row under a held lease (${waitingBars} — R rolled up, A2)`);
  ok(/work-gsum/.test(chart), 'a container draws as a SUMMARY bracket, not a solid bar');
  ok(/work-gbar[^"]*crit/.test(chart), 'a critical planned bar carries the `crit` class');
  ok(/work-gcrit/.test(chart), 'and the name column shows the critical chip');
  ok(count(chart, /work-garrow-line/g) === 2, `both leaf deps are drawn as arrows (${count(chart, /work-garrow-line/g)} — A1→A2, A2→B1)`);
  ok(/work-gtoday/.test(chart), 'the TODAY line is drawn');
  ok(/work-gwe/.test(chart) || /work-gmin[^"]*we/.test(chart), 'weekends are banded');

  // the tooltip names all three layers
  const tip = renderToString(el(Tip, { row: ROWS[2], x: 10, y: 10 })).replace(/<!-- -->/g, '');
  ok(/2026-08-01 11:00 → 2026-08-01 14:00/.test(tip), 'the tooltip shows the planned window');
  ok(/2026-08-03 09:00 → 2026-08-10 09:00/.test(tip), 'the tooltip shows the waiting window');
  ok(/on the critical path/.test(tip), 'the tooltip says the row is on the critical path');
  const invTip = renderToString(el(Tip, { row: ROWS[3], x: 10, y: 10 })).replace(/<!-- -->/g, '');
  ok(/⚠ inverted/.test(invTip) && /before the recorded start/.test(invTip),
     'the tooltip names an inverted actual pair — the impossible range is called out, not rendered as if it were real');

  // the WELD WATERFALL — click-through drill-down
  const rowWithExec = {
    ...ROWS[1],
    executions: [{
      id: 'ex1', state: 'done', started_at: '2026-08-02T09:00:00.000Z', finished_at: '2026-08-02T11:00:00.000Z',
      entity_name: 'hum', entity_kind_hint: 'human',
      turns: [{ id: 't1', kind: 'spawn', status: 'ended', model: 'opus', zee_name: 'z1',
                gateway_requests: [{ id: 'g1', status: 200, provider: 'claude', model: 'opus',
                                     method: 'POST', path: '/v1/messages', input_tokens: 100,
                                     output_tokens: 50, cost_usd: 0.0123, duration_ms: 1200 }] }],
    }],
  };
  const wf = renderToString(el(WeldWaterfall, { row: rowWithExec, onClose: () => {} }));
  ok(/work-waterfall/.test(wf) && />A1</.test(wf), 'the waterfall opens for the clicked row');
  ok(/st-done/.test(wf) && />hum</.test(wf), 'the waterfall lists the execution with its state and entity');
  ok(/spawn/.test(wf) && /turn/.test(wf) && /opus/.test(wf), 'the waterfall lists the execution\'s turn');
  ok(/claude/.test(wf) && /POST/.test(wf) && /\/v1\/messages/.test(wf), 'the waterfall lists the turn\'s gateway calls');

  // ── COLLAPSED-PARENT EDGE RE-ANCHORING ──────────────────────────────────────────────
  // A (container) holds A1/A2; B1 outside depends on A2. When A is COLLAPSED, A2 is hidden and
  // the edge A2→B1 must RE-ANCHOR onto A's bar (drawn as A→B1), NOT vanish.
  const RE = [
    { id: 'A', parent_id: null, depth: 1, name: 'A', kind: 'container', child_semantics: 'freeform',
      is_atom: false, critical: true, planned_start: '2026-08-01T00:00:00.000Z', planned_end: '2026-08-03T00:00:00.000Z', deps: [], executions: [] },
    { id: 'A1', parent_id: 'A', depth: 2, name: 'A1', kind: 'action', is_atom: true,
      planned_start: '2026-08-01T00:00:00.000Z', planned_end: '2026-08-01T12:00:00.000Z', deps: [], executions: [] },
    { id: 'A2', parent_id: 'A', depth: 2, name: 'A2', kind: 'action', is_atom: true,
      planned_start: '2026-08-02T00:00:00.000Z', planned_end: '2026-08-03T00:00:00.000Z', deps: ['A1'], executions: [] },
    { id: 'B1', parent_id: null, depth: 1, name: 'B1', kind: 'action', is_atom: true,
      planned_start: '2026-08-04T00:00:00.000Z', planned_end: '2026-08-05T00:00:00.000Z', deps: ['A2'], executions: [] },
  ];
  const exp = renderToString(el(GanttChart, { rows: RE, today }));
  ok(count(exp, /work-garrow-line/g) === 2, `EXPANDED: both leaf deps drawn (${count(exp, /work-garrow-line/g)} — A1→A2, A2→B1)`);
  const col = renderToString(el(GanttChart, { rows: RE, today, initialCollapsed: ['A'] }));
  ok(count(col, /work-garrow-line/g) === 1, `COLLAPSED: the external edge re-anchors onto A (${count(col, /work-garrow-line/g)} arrow, not 0 — it does NOT vanish)`);
  ok(!/>A1</.test(col) && !/>A2</.test(col), 'the collapsed children are hidden');
  ok(/work-gsum/.test(col), 'the collapsed parent still draws its bracket');
  ok(/B1 depends on A/.test(col), 'the re-anchored arrow runs from A\'s bar to B1\'s bar');

  // hiddenTitle — the marker for a truly undrawable dep
  ok(/waits for/.test(hiddenTitle([{ title: 'x', why: 'has no planned dates to draw an arrow from' }])),
     'an undrawable dependency is spelled out where a human is already looking');

  const emptyChart = renderToString(el(GanttChart, { rows: [], today }));
  ok(/No workflow plan/.test(emptyChart) && /work-gempty/.test(emptyChart),
     'an empty scope says what a workflow plan is, not a blank rectangle');

} catch (e) {
  console.error('  ✗ FAIL render block threw:', e.message);
  fail++;
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
