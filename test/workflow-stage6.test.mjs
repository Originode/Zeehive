// WORKFLOW STAGE 6 — CPM SCHEDULING + THE GANTT RE-POINTED AT THE MODEL
// (docs/hierarchical-workflow-model.md §7.2, stage 6 of the serial rollout).
//
// This test proves migration 184 (stage6_cpm_scheduling) against a REAL postgres with the
// full migration set applied, and then RENDERS the re-pointed gantt (web/src/work/Gantt.jsx)
// over a workflow-shaped fixture to prove the three layers and the re-anchoring. It is the
// stage-6 counterpart of test/workflow-stage1/3/5/weld .test.mjs and extends that suite's
// pattern — a standalone node script with a header documenting coverage, a loud SKIP on a
// non-stage6 db, and teardown in a finally. Coverage:
//
//   A. (a) CPM ON A KNOWN SMALL PLAN — a freeform root with a sequence container (A1→A2),
//      a dependency chain (A2→B1→B2) and an independent leaf (C). wn_cpm asserts the EXACT
//      earliest/latest start/finish timestamps, slack and critical flag for every atom, and
//      the critical path is exactly A1→A2→B1→B2 (C has 9h slack, NOT critical).
//   B. (b) A CONTAINER'S SPAN = ITS SUBTREE SPAN — the sequence container A reports the
//      span [min earliest_start … max earliest_finish] of its leaves, the freeform root R
//      reports the whole plan's span, and both are critical iff a leaf in the subtree is.
//   C. (a-cont.) LAG AND LINK TYPE — an SS edge with a 2h lag constrains START from START
//      (earliest_start moves, earliest_finish follows); the type column the CPM interprets is
//      what makes this exact.
//   D. CALENDARS HONOURED — a node with a 9–5 Mon–Fri calendar: a 2-hour task starting
//      Friday 16:00 finishes Monday 10:00 (the duration is WORKING time, not wall clock).
//   E. (c) PLANNED-VS-ACTUAL DUAL BARS RENDER — the re-pointed GanttChart renders one PLAN
//      bar and one ACTUAL bar per row the record has dates for, plus a WAITING bar for a held
//      lease, over a fixture with no network (component-level render).
//   F. (d) COLLAPSED-PARENT EDGE RE-ANCHORING — an edge that points at a CHILD of a collapsed
//      parent RE-ANCHORS onto the parent bar: with container A collapsed, the A2→B1 edge is
//      drawn A→B1, not vanished (the arrow count goes 2 → 1, never 0).
//
// Everything it creates is torn down in a finally. It SKIPs loudly on a database that has not
// run the stage-6 migration.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const admin = new pg.Client({ connectionString: url });
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const projectId = randomUUID();

async function main() {
  await admin.connect();

  // This test needs the stage-6 schema: the union_edge link-type column and the wn_cpm pass.
  const hasTypeCol = (await admin.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name='union_edge' AND column_name='type'`)).rows[0].n;
  const hasCpm = (await admin.query(
    `SELECT count(*)::int AS n FROM pg_proc WHERE proname='wn_cpm'`)).rows[0].n;
  if (!hasTypeCol || !hasCpm) {
    console.log(`  SKIP: not a stage-6-workflow-migrated db (union_edge.type=${!!hasTypeCol}, wn_cpm=${!!hasCpm})`);
    return;
  }

  const q = (text, params) => admin.query(text, params);
  const one = async (text, params) => (await admin.query(text, params)).rows[0];

  // throwaway project → plan → plan_version (v1) → one freeform root
  await q(`INSERT INTO project (id, name, repo_root, db_user, db_name) VALUES ($1,$2,'/tmp','u','d')`,
    [projectId, `wf-stage6-${tag}`]);
  const planId = (await one(`INSERT INTO plan (project_id, name) VALUES ($1,'stage6') RETURNING id`, [projectId])).id;
  const ver = (await one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [planId])).id;
  const R = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
     VALUES ($1,NULL,'1','R','container','freeform') RETURNING id`, [ver])).id;
  const A = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics)
     VALUES ($1,$2,'1','A','container','sequence') RETURNING id`, [ver, R])).id;
  const node = async (name, parent, rank, estimate) =>
    (await one(
      `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, estimate)
       VALUES ($1,$2,$3,$4,'action',$5) RETURNING id`, [ver, parent, rank, name, estimate])).id;
  const A1 = await node('A1', A, '1', '2 hours');
  const A2 = await node('A2', A, '2', '3 hours');
  const B1 = await node('B1', R, '2', '4 hours');
  const B2 = await node('B2', R, '3', '1 hours');
  const C  = await node('C',  R, '4', '1 hours');
  // the dependency chain under the freeform root: A2→B1→B2 (LCA = R, freeform → legal)
  await q(`INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,'FS')`, [A2, B1]);
  await q(`INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,'FS')`, [B1, B2]);
  await q(`UPDATE plan_version SET root_node_id=$1 WHERE id=$2`, [R, ver]);

  // the plan starts at a fixed instant so the EXACT values are assertable
  const T0 = '2026-08-10T09:00:00.000Z';
  // slack::text so the assertion compares a plain 'HH:MM:SS' string, not a pg interval object
  const sched = (await q(`SELECT node_id, name, is_atom, parent_id, earliest_start, earliest_finish,
                                 latest_start, latest_finish, slack::text AS slack, critical
                            FROM wn_cpm($1, $2::timestamptz)`, [ver, T0])).rows;
  const byName = new Map(sched.map((s) => [s.name, s]));
  const T = (iso) => new Date(iso);

  try {
    // ── A. (a) CPM on a known small plan — EXACT values ──────────────────────
    console.log(`\nA. (a) CPM on a known small plan — exact earliest/latest/slack + critical path`);
    // expected: ES/EF/LS/LF for the chain A1→A2→B1→B2, all zero slack and critical; C floats
    // with 9h slack. p_start = Mon 09:00.
    const expect = (s, es, ef, ls, lf, slack, crit) => {
      const name = s.name;
      const same = (a, b) => (a === b) || (new Date(a).getTime() === new Date(b).getTime());
      ok(same(s.earliest_start, T(es)), `${name} earliest_start = ${es} (got ${s.earliest_start?.toISOString?.() ?? s.earliest_start})`);
      ok(same(s.earliest_finish, T(ef)), `${name} earliest_finish = ${ef} (got ${s.earliest_finish?.toISOString?.() ?? s.earliest_finish})`);
      ok(same(s.latest_start, T(ls)), `${name} latest_start = ${ls} (got ${s.latest_start?.toISOString?.() ?? s.latest_start})`);
      ok(same(s.latest_finish, T(lf)), `${name} latest_finish = ${lf} (got ${s.latest_finish?.toISOString?.() ?? s.latest_finish})`);
      ok(s.slack === slack, `${name} slack = ${slack} (got ${s.slack})`);
      ok(s.critical === crit, `${name} critical = ${crit} (got ${s.critical})`);
    };
    expect(byName.get('A1'), '2026-08-10T09:00:00.000Z', '2026-08-10T11:00:00.000Z',
           '2026-08-10T09:00:00.000Z', '2026-08-10T11:00:00.000Z', '00:00:00', true);
    expect(byName.get('A2'), '2026-08-10T11:00:00.000Z', '2026-08-10T14:00:00.000Z',
           '2026-08-10T11:00:00.000Z', '2026-08-10T14:00:00.000Z', '00:00:00', true);
    expect(byName.get('B1'), '2026-08-10T14:00:00.000Z', '2026-08-10T18:00:00.000Z',
           '2026-08-10T14:00:00.000Z', '2026-08-10T18:00:00.000Z', '00:00:00', true);
    expect(byName.get('B2'), '2026-08-10T18:00:00.000Z', '2026-08-10T19:00:00.000Z',
           '2026-08-10T18:00:00.000Z', '2026-08-10T19:00:00.000Z', '00:00:00', true);
    // C is independent: it may start at T0 and finish T0+1h, but its latest start is T0+9h
    expect(byName.get('C'), '2026-08-10T09:00:00.000Z', '2026-08-10T10:00:00.000Z',
           '2026-08-10T18:00:00.000Z', '2026-08-10T19:00:00.000Z', '09:00:00', false);
    // the critical path, named: exactly the zero-slack chain
    const critPath = sched.filter((s) => s.is_atom && s.critical).map((s) => s.name).sort();
    ok(critPath.join(',') === 'A1,A2,B1,B2',
      `the critical path is exactly A1→A2→B1→B2 (got ${critPath.join(',')})`);

    // ── B. (b) a container's span = its subtree span ─────────────────────────
    console.log(`\nB. (b) a container's span = its subtree span`);
    const a = byName.get('A');
    ok(a && a.is_atom === false, `A is reported as a container (not an atom)`);
    ok(new Date(a.earliest_start).getTime() === T('2026-08-10T09:00:00.000Z').getTime(),
      `A span starts at its subtree's min earliest_start (09:00)`);
    ok(new Date(a.earliest_finish).getTime() === T('2026-08-10T14:00:00.000Z').getTime(),
      `A span ends at its subtree's max earliest_finish (14:00 — A1 11:00, A2 14:00)`);
    ok(a.critical === true, `A is critical (its leaves A1/A2 are on the critical path)`);
    const rr = byName.get('R');
    ok(rr && rr.is_atom === false && new Date(rr.earliest_start).getTime() === T('2026-08-10T09:00:00.000Z').getTime()
       && new Date(rr.earliest_finish).getTime() === T('2026-08-10T19:00:00.000Z').getTime(),
      `R spans the whole plan (09:00 → 19:00)`);
    ok(rr.critical === true, `R is critical (its subtree contains the critical path)`);

    // ── C. (a-cont.) LAG + LINK TYPE — an SS edge constrains START from START ─
    console.log(`\nC. lag + link type — SS 2h lag shifts the successor's earliest_start`);
    // D depends on C with an SS edge + 2h lag: D may START 2h after C STARTS.
    const D = await node('D', R, '5', '1 hours');
    await q(`INSERT INTO dependency (from_id, to_id, type, lag) VALUES ($1,$2,'SS','2 hours')`, [C, D]);
    const dSched = (await q(`SELECT * FROM wn_cpm($1, $2::timestamptz)`, [ver, T0])).rows;
    const dRow = dSched.find((s) => s.name === 'D');
    ok(new Date(dRow.earliest_start).getTime() === T('2026-08-10T11:00:00.000Z').getTime(),
      `D earliest_start = 09:00 (C start) + 2h SS lag = 11:00 (got ${dRow.earliest_start?.toISOString?.()})`);
    ok(new Date(dRow.earliest_finish).getTime() === T('2026-08-10T12:00:00.000Z').getTime(),
      `D earliest_finish = 11:00 + 1h = 12:00 (got ${dRow.earliest_finish?.toISOString?.()})`);

    // ── D. calendars honoured ────────────────────────────────────────────────
    console.log(`\nD. calendars honoured — a 2h task from Friday 16:00 finishes Monday 10:00`);
    const cal = await one(
      `INSERT INTO calendar (name, timezone, working_hours)
       VALUES ('9-5','UTC','[{"dow":1,"from":"09:00","to":"17:00"},{"dow":2,"from":"09:00","to":"17:00"},{"dow":3,"from":"09:00","to":"17:00"},{"dow":4,"from":"09:00","to":"17:00"},{"dow":5,"from":"09:00","to":"17:00"}]')
       RETURNING id`);
    const K = await one(
      `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, estimate, calendar_id)
       VALUES ($1,$2,'6','K','action','2 hours',$3) RETURNING id`, [ver, R, cal.id]);
    const kSched = (await q(`SELECT * FROM wn_cpm($1, '2026-08-07T16:00:00.000Z'::timestamptz)`, [ver])).rows;
    const kRow = kSched.find((s) => s.name === 'K');
    ok(new Date(kRow.earliest_start).getTime() === T('2026-08-07T16:00:00.000Z').getTime(),
      `K earliest_start = Friday 16:00 (got ${kRow.earliest_start?.toISOString?.()})`);
    ok(new Date(kRow.earliest_finish).getTime() === T('2026-08-10T10:00:00.000Z').getTime(),
      `K earliest_finish = Monday 10:00 — 2 WORKING hours across the weekend (got ${kRow.earliest_finish?.toISOString?.()})`);
    ok(new Date(kRow.latest_finish).getTime() === T('2026-08-10T10:00:00.000Z').getTime(),
      `K latest_finish anchors the same calendar-aware finish (got ${kRow.latest_finish?.toISOString?.()})`);

    // ── E + F. the gantt RENDERS (three layers + re-anchoring) ───────────────
    await renderGanttAssertions();
  } finally {
    // tear down: the project cascade removes plan/version/nodes/deps; the calendar is
    // referenced by work_node.calendar_id (FK, no cascade) so it is deleted separately.
    try {
      // the project cascade removes plan/version/nodes/deps (including K, which references the
      // calendar) — only then is the calendar free to delete (work_node.calendar_id has no cascade)
      await q(`DELETE FROM project WHERE id=$1`, [projectId]);
      await q(`DELETE FROM calendar WHERE name='9-5'`);
      const residue = await one(
        `SELECT
           (SELECT count(*)::int FROM work_node  WHERE plan_version_id IN
             (SELECT id FROM plan_version WHERE plan_id IN (SELECT id FROM plan WHERE project_id=$1))) AS nodes,
           (SELECT count(*)::int FROM dependency WHERE from_id IN
             (SELECT id FROM work_node WHERE plan_version_id IN
               (SELECT id FROM plan_version WHERE plan_id IN (SELECT id FROM plan WHERE project_id=$1)))) AS deps,
           (SELECT count(*)::int FROM calendar WHERE name='9-5') AS cals,
           (SELECT count(*)::int FROM project WHERE id=$1) AS projects`,
        [projectId]);
      ok(residue.nodes === 0 && residue.deps === 0 && residue.cals === 0 && residue.projects === 0,
        `teardown leaves no residue (nodes=${residue.nodes} deps=${residue.deps} cals=${residue.cals} projects=${residue.projects})`);
    } catch (e) {
      console.error(`  ✗ FAIL teardown: ${e.message.split('\n')[0].slice(0, 100)}`);
      fail++;
    }
    await admin.end().catch(() => {});
  }
}

// ── E + F. render the re-pointed gantt over a workflow fixture (no network) ──────
async function renderGanttAssertions() {
  console.log(`\nE. (c) planned-vs-actual-vs-waiting dual bars render`);
  const here = dirname(fileURLToPath(import.meta.url));
  const { build } = await import('esbuild');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  const out = resolve(tmpdir(), 'workflow-stage6-gantt.cjs');
  await build({
    stdin: {
      contents: `
        const React = require('react');
        const { renderToString } = require('react-dom/server');
        const G = require('./Gantt.jsx');
        module.exports = { React, renderToString, GanttChart: G.GanttChart };
      `,
      resolveDir: resolve(here, '..', 'web/src/work'),
      loader: 'js',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
  });
  const { React, renderToString, GanttChart } = createRequire(out)(out);
  const el = (C, props) => React.createElement(C, props);
  const today = new Date(2026, 7, 1);

  const ROWS = [
    { id: 'R', parent_id: null, depth: 1, name: 'R', kind: 'container', child_semantics: 'freeform',
      is_atom: false, critical: true, slack: null, duration_hours: 10,
      planned_start: '2026-08-01T09:00:00.000Z', planned_end: '2026-08-05T17:00:00.000Z',
      actual_start: '2026-08-02T09:00:00.000Z', actual_end: '2026-08-04T15:00:00.000Z',
      waiting_start: '2026-08-03T09:00:00.000Z', waiting_end: '2026-08-10T09:00:00.000Z',
      deps: [], executions: [] },
    { id: 'A1', parent_id: 'R', depth: 2, name: 'A1', kind: 'action', child_semantics: null,
      is_atom: true, critical: true, slack: '00:00:00', duration_hours: 2,
      planned_start: '2026-08-01T09:00:00.000Z', planned_end: '2026-08-01T11:00:00.000Z',
      actual_start: '2026-08-02T09:00:00.000Z', actual_end: '2026-08-02T11:00:00.000Z',
      waiting_start: null, waiting_end: null, deps: [], executions: [] },
    { id: 'A2', parent_id: 'R', depth: 2, name: 'A2', kind: 'action', child_semantics: null,
      is_atom: true, critical: true, slack: '00:00:00', duration_hours: 3,
      planned_start: '2026-08-01T11:00:00.000Z', planned_end: '2026-08-01T14:00:00.000Z',
      actual_start: null, actual_end: null,
      waiting_start: '2026-08-03T09:00:00.000Z', waiting_end: '2026-08-10T09:00:00.000Z',
      deps: ['A1'], executions: [] },
    { id: 'B1', parent_id: 'R', depth: 2, name: 'B1', kind: 'action', child_semantics: null,
      is_atom: true, critical: false, slack: '09:00:00', duration_hours: 1,
      planned_start: '2026-08-04T09:00:00.000Z', planned_end: '2026-08-04T10:00:00.000Z',
      actual_start: null, actual_end: null, waiting_start: null, waiting_end: null,
      deps: ['A2'], executions: [] },
  ];
  const count = (h, re) => (h.match(re) || []).length;
  const chart = renderToString(el(GanttChart, { rows: ROWS, planName: 'stage6', version: 1, today }));
  const planBars = count(chart, /data-testid="work-gbar"/g);
  const actualBars = count(chart, /data-testid="work-gbar-actual"/g);
  const waitingBars = count(chart, /data-testid="work-gbar-waiting"/g);
  ok(planBars === 4, `one PLAN bar per dated row (${planBars})`);
  ok(actualBars === 2, `one ACTUAL bar per row the record has dates for (${actualBars} — R rolled up, A1)`);
  ok(waitingBars === 2, `one WAITING bar per row under a held lease (${waitingBars} — R rolled up, A2)`);
  ok(/work-gbar[^"]*crit/.test(chart), `the critical planned bar carries the 'crit' class`);
  ok(count(chart, /work-garrow-line/g) === 2, `both leaf deps are drawn as arrows (${count(chart, /work-garrow-line/g)})`);

  console.log(`\nF. (d) collapsed-parent edge re-anchoring`);
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
  ok(count(exp, /work-garrow-line/g) === 2, `EXPANDED: both leaf deps drawn (${count(exp, /work-garrow-line/g)})`);
  const col = renderToString(el(GanttChart, { rows: RE, today, initialCollapsed: ['A'] }));
  const colArrows = count(col, /work-garrow-line/g);
  ok(colArrows === 1, `COLLAPSED: the A2→B1 edge RE-ANCHORS onto A (${colArrows} arrow — it does NOT vanish to 0)`);
  ok(!/>A1</.test(col) && !/>A2</.test(col), `the collapsed children are hidden`);
  ok(/B1 depends on A/.test(col), `the re-anchored arrow runs from A's bar to B1's bar`);
}

await main().catch((e) => { console.error('TEST ERROR:', e); fail++; });
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
