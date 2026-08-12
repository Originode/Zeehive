// WORKFLOW GANTT SCHEDULE — the gantt has something to draw (migrations 193 + 194).
//
// WHY THIS TEST EXISTS: measured on the live meta-DB, 0 of 514 work items carried an
// estimate, a start or a due date, so wn_cpm returned every node critical with ONE distinct
// slack value — the absence of a schedule. Migration 193 makes a PROJECT a work_node (the
// plan root is the project, the root item hangs beneath it), and migration 194 gives every
// atom a real duration: explicit estimate → measured actual from closed executions → a
// stated 1-day default. This test proves the SCHEDULE is non-degenerate on a realistic
// plan — MORE THAN ONE distinct slack value, and a critical path that is a genuine proper
// subset of the atoms — and that the duration fallback is what makes it so.
//
// It is the DONE-WHEN assertion of the gantt card, kept standalone (same shape as
// workflow-stage6.test.mjs): a real postgres with the full migration set, a throwaway
// project torn down in a finally. It SKIPs loudly on a database without migrations 193/194.
//
// Coverage:
//   A. (a) A PROJECT IS A WORK_NODE — ensurePlanVersion (the dual-write) roots the plan on
//      a 'project:<id>' node, points plan_version.root_node_id at it, and hangs the root
//      work_item beneath it. The CPM reports the project node as a container spanning the
//      whole plan.
//   B. (b) NON-DEGENERATE SLACK — on a plan with a chain (A1→A2→A3→B1→B2→C1) and an
//      independent branch (D1), wn_cpm returns MORE THAN ONE distinct atom slack value, and
//      the critical atoms are a proper subset of all atoms (the chain, not D1).
//   C. (c) DURATION FROM EVIDENCE — an unestimated atom with a closed execution schedules at
//      the measured actual (AVG(finished_at - started_at)); an unestimated atom with no
//      execution falls back to the stated 1-day default; a node with an explicit estimate
//      keeps it.
//   D. (d) A CONTAINER'S DURATION ROLLS UP — the sequence container's duration is the sum of
//      its atoms' effective durations, so the project node's span reaches the plan's end.
//   E. (e) EDGE ORIGIN IS VISIBLE — declared chains vs board-position inference.
//   F. (f) DURATION PROVENANCE is visible per node and per plan (estimate/actual/default/rollup).
//   G. (g) THE HISTORY AXIS — a DONE node draws on its ACTUAL dates, not forward from now();
//      past/current/future per plan; a done node with no recorded start is a visible GAP.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const client = new pg.Client({ connectionString: url });
const q = (t, p) => client.query(t, p);
const one = async (t, p) => (await client.query(t, p)).rows[0];
const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const projectId = randomUUID();

async function main() {
  await client.connect();

  // The test needs migration 194: the duration fallback ('1 day' + the closed-execution AVG)
  // in wn_duration. The project-node root (193) is created by the DUAL-WRITE this test
  // imports from the repo, so the db schema alone cannot gate it.
  const durSrc = (await one(`SELECT prosrc FROM pg_proc WHERE proname='wn_duration'`)).prosrc;
  const cpmSrc = (await one(`SELECT prosrc FROM pg_proc WHERE proname='wn_cpm'`)).prosrc;
  if (!durSrc || !/'1 day'/.test(durSrc) || !cpmSrc || !/'1 day'/.test(cpmSrc)) {
    console.log('  SKIP: this db predates migration 194 (wn_duration/wn_cpm have no duration fallback)');
    return;
  }

  const { ensurePlanVersion } = await import(resolve(dirname(fileURLToPath(import.meta.url)), '../server/src/lib/work-node-sync.js'));
  const { dbRunner } = await import(resolve(dirname(fileURLToPath(import.meta.url)), '../server/src/lib/work-items.js'));

  try {
    section('A. (a) a project is a work_node — the plan root is the project');
    await q(`INSERT INTO project (id, name, repo_root, db_user, db_name) VALUES ($1,$2,'/tmp','u','d')`,
      [projectId, `gantt-sched-${tag}`]);
    const rootItem = await one(`SELECT id FROM work_item WHERE project_id=$1 AND kind='project'`, [projectId]);

    // The dual-write (createProject → syncProjectNode → ensurePlanVersion) materialises the
    // plan root: project node → root item node.
    const { planVersionId, rootNodeId } = await ensurePlanVersion(dbRunner(), projectId);
    const projNode = await one(`SELECT * FROM work_node WHERE id=$1`, [rootNodeId]);
    const pv = await one(`SELECT * FROM plan_version WHERE id=$1`, [planVersionId]);
    ok(projNode.stable_key === 'project:' + projectId && projNode.parent_id === null,
      `the plan root is the PROJECT node (stable_key ${projNode.stable_key}, parent NULL)`);
    ok(pv.root_node_id === projNode.id, `plan_version.root_node_id points at the project node`);
    const rootItemNode = await one(`SELECT * FROM work_node WHERE stable_key='work_item:'||$1`, [rootItem.id]);
    ok(rootItemNode.parent_id === projNode.id, `the root work_item hangs beneath the project node`);

    section('B. (b) non-degenerate schedule — >1 distinct slack, critical path a proper subset');
    // The realistic plan: a chain A1→A2→A3→B1→B2→C1 plus an INDEPENDENT branch D1 (float).
    const node = async (parent, name, rank, kind, est = null, sem = null) =>
      (await one(
        `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, estimate, stable_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'n:'||$8) RETURNING id`,
        [planVersionId, parent, rank, name, kind, sem, est, 'x' + randomUUID().slice(0, 8)])).id;
    const A = await node(rootItemNode.id, 'Act A', '1', 'container', null, 'sequence');
    await node(A, 'A1', '1', 'action', null);   // no estimate, no execution → 1-day default
    await node(A, 'A2', '2', 'action', null);
    const A3 = await node(A, 'A3', '3', 'action', null);
    const B = await node(rootItemNode.id, 'Act B', '2', 'container', null, 'sequence');
    const B1 = await node(B, 'B1', '1', 'action', '2 hours');   // explicit estimate wins
    const B2 = await node(B, 'B2', '2', 'action', null);
    const C = await node(rootItemNode.id, 'Act C', '3', 'container', null, 'sequence');
    const C1 = await node(C, 'C1', '1', 'action', null);        // closed execution → actual
    const D = await node(rootItemNode.id, 'Act D', '4', 'container', null, 'sequence');
    const D1 = await node(D, 'D1', '1', 'action', null);        // independent → float

    // the chain across activities (LCA = root item, which ensurePlanVersion made... sequence —
    // flip it to freeform, exactly as syncDependency does, so the dependency is legal).
    await q(`UPDATE work_node SET child_semantics='freeform' WHERE id=$1`, [rootItemNode.id]);
    await q(`INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,'FS')`, [A3, B1]);
    await q(`INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,'FS')`, [B2, C1]);

    // a closed execution for C1: 09:00 → 13:00 = 4h measured actual.
    const run = (await one(`INSERT INTO run (plan_version_id, state) VALUES ($1,'succeeded') RETURNING id`, [planVersionId])).id;
    await q(`INSERT INTO execution (run_id, work_node_id, state, started_at, finished_at)
             VALUES ($1,$2,'done','2026-08-10T09:00:00.000Z','2026-08-10T13:00:00.000Z')`, [run, C1]);

    const T0 = '2026-08-10T09:00:00.000Z';
    const sched = (await q(
      `SELECT node_id, name, is_atom, duration, slack::text AS slack, critical
         FROM wn_cpm($1::uuid, $2::timestamptz)`, [planVersionId, T0])).rows;
    const atoms = sched.filter((s) => s.is_atom);
    const slacks = new Set(atoms.map((s) => s.slack));
    const crit = atoms.filter((s) => s.critical);
    ok(slacks.size > 1, `wn_cpm returns >1 distinct atom slack value (got ${[...slacks].join(', ')})`);
    ok(crit.length > 0 && crit.length < atoms.length,
      `the critical path is a proper subset of the atoms (${crit.length} of ${atoms.length})`);
    ok(atoms.find((s) => s.name === 'D1') && !atoms.find((s) => s.name === 'D1').critical,
      `the independent branch D1 has float and is NOT critical`);
    const chain = ['A1', 'A2', 'A3', 'B1', 'B2', 'C1'];
    ok(chain.every((n) => atoms.find((s) => s.name === n)?.critical),
      `the chain A1→A2→A3→B1→B2→C1 is exactly the critical path`);

    section('C. (c) duration from evidence — estimate → closed-execution actual → 1-day default');
    const dur = (s) => {
      const d = s.duration;
      if (typeof d === 'object') return (Number(d.days) || 0) * 24 + (Number(d.hours) || 0) + (Number(d.minutes) || 0) / 60;
      return null;
    };
    const a1 = atoms.find((s) => s.name === 'A1');
    ok(a1 && Math.abs(dur(a1) - 24) < 0.01, `A1 (no estimate, no execution) defaults to 1 day (got ${dur(a1)}h)`);
    const b1 = atoms.find((s) => s.name === 'B1');
    ok(b1 && Math.abs(dur(b1) - 2) < 0.01, `B1 (explicit estimate) schedules at 2h (got ${dur(b1)}h)`);
    const c1 = atoms.find((s) => s.name === 'C1');
    ok(c1 && Math.abs(dur(c1) - 4) < 0.01, `C1 (closed execution 09:00→13:00) derives 4h (got ${dur(c1)}h)`);

    section('D. (d) a container rolls its subtree up — the project spans the whole plan');
    const projRow = sched.find((s) => s.name === `gantt-sched-${tag}`);
    ok(projRow && projRow.is_atom === false, `the project node is reported as a container`);
    const actA = sched.find((s) => s.name === 'Act A');
    ok(actA && Math.abs(dur(actA) - 72) < 0.01, `Act A (sequence of 3×1-day) rolls up to 3 days (got ${dur(actA)}h)`);

    section('E. (e) edge ORIGIN is visible — declared chains vs board-position inference');
    // The read model carries, per row, its edges WITH their origin (the ruling's contract):
    // 'dependency' = a declared zee-dep chain; 'sequence' = sibling display order the CPM
    // schedules but nobody declared. The union graph for this plan is: A1→A2, A2→A3, B1→B2
    // (sequence-origin, from the sequence containers) + A3→B1, B2→C1 (dependency-origin, the
    // two edges the test declared) — so edge_counts = {total:5, sequence:3, dependency:2} and
    // has_declared_order is true. The chart's banner (ratio) and the dashed-vs-arrowhead edge
    // drawing both read from these two fields.
    const { workflowGanttModel } = await import(resolve(dirname(fileURLToPath(import.meta.url)), '../server/src/lib/workflow-gantt.js'));
    const g = await workflowGanttModel({ projectId });
    ok(g.has_declared_order === true, `has_declared_order is true (2 declared chains exist)`);
    ok(g.edge_counts && g.edge_counts.total === 5 && g.edge_counts.sequence === 3 && g.edge_counts.dependency === 2,
      `edge_counts = {total:5, sequence:3, dependency:2} (got ${JSON.stringify(g.edge_counts)})`);
    const byNameG = new Map(g.rows.map((r) => [r.name, r]));
    const b1Dep = (byNameG.get('B1')?.deps || []).find((d) => d.id === byNameG.get('A3')?.id);
    ok(b1Dep && b1Dep.origin === 'dependency', `B1's edge from A3 is a DECLARED dependency (got ${b1Dep?.origin})`);
    const a2Dep = (byNameG.get('A2')?.deps || []).find((d) => d.id === byNameG.get('A1')?.id);
    ok(a2Dep && a2Dep.origin === 'sequence', `A2's edge from A1 is board-position inference (sequence), not a declared chain (got ${a2Dep?.origin})`);
    // The declared-vs-inference property is carried by EDGE ORIGIN (the design d497f912 landed):
    // a declared chain's edges read 'dependency', a board-order-only row has no edges at all.
    // D1 (independent) has no edges — it is board order, not a schedule, exactly as the retired
    // 'scheduled' flag used to say; B1's predecessor is a declared edge. (Section B already
    // proves D1 is NOT critical — a board-order-only row gets no false critical claim.)
    ok((byNameG.get('D1')?.deps || []).length === 0, `D1 (independent) has no edges — board-order only (got ${(byNameG.get('D1')?.deps || []).length})`);

    section('F. (f) duration PROVENANCE is visible per node and per plan');
    // The read model must tell the three sources apart (migration 194's chain), per node and
    // as a plan mix — a default bar is never dressed up as an estimate. This plan's 7 atoms:
    // A1/A2/A3/B2/D1 (unestimated, no execution) → default; B1 (estimate 2h) → estimate; C1
    // (closed execution 09:00→13:00) → actual. So the mix is {default:5, estimate:1, actual:1,
    // atoms:7, on_default:71} — the honest headline "5 of 7 bars are guesswork".
    ok(byNameG.get('A1')?.duration_source === 'default', `A1 (no estimate, no execution) → default (got ${byNameG.get('A1')?.duration_source})`);
    ok(byNameG.get('B1')?.duration_source === 'estimate', `B1 (explicit estimate) → estimate (got ${byNameG.get('B1')?.duration_source})`);
    ok(byNameG.get('C1')?.duration_source === 'actual', `C1 (closed execution) → actual (got ${byNameG.get('C1')?.duration_source})`);
    ok(byNameG.get('D1')?.duration_source === 'default', `D1 (independent, unestimated) → default (got ${byNameG.get('D1')?.duration_source})`);
    const mix = g.duration_mix;
    ok(mix && mix.estimate === 1 && mix.actual === 1 && mix.default === 5 && mix.atoms === 7,
      `duration_mix = {estimate:1, actual:1, default:5, atoms:7} (got ${JSON.stringify(mix)})`);
    ok(mix && mix.on_default === 71, `on_default = 71% (got ${mix?.on_default}%)`);
    // a container is a rollup, never an estimate/default — the provenance is the tree, not a lie
    ok(byNameG.get('Act A')?.duration_source === 'rollup', `Act A (a container) → rollup (got ${byNameG.get('Act A')?.duration_source})`);

    section('G. (g) THE HISTORY AXIS — done nodes draw on their ACTUAL dates, not forward from now');
    // The regression the directive's acceptance test caught: wn_cpm schedules EVERYTHING
    // forward from now(), so completed work drew as if it starts today and past was always 0.
    // The read model now anchors a DONE node on its measured actuals (work_item.actual_start/
    // end — migration 159 — or the rolled execution actuals), keeps forward projection only for
    // work that has not happened, and classifies each atom past/current/future with a `gap`
    // flag for a done node whose start was never recorded (never invented).
    // Seed, on the same project: 3 done items with real past actuals, 1 done with NO start
    // (the gap), 1 in-flight (started, no end), 1 queued (no actuals).
    const histRoot = await one(`SELECT id FROM work_node WHERE stable_key='work_item:'||$1`, [rootItem.id]);
    const histNode = async (title, status, aS, aE, rank) => {
      const wi = await one(
        `INSERT INTO work_item (project_id, parent_id, kind, title, status, sort_order, actual_start, actual_end, estimate_hours)
         VALUES ($1,$2,'task',$3,$4,$5,$6,$7,8) RETURNING id`,
        [projectId, rootItem.id, title, status, rank, aS, aE]);
      await one(
        `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, estimate, stable_key)
         VALUES ($1,$2,$3,$4,'action','8 hours','work_item:'||$5) RETURNING id`,
        [planVersionId, histRoot.id, String(rank), title, wi.id]);
    };
    await histNode('HDone A', 'done', '2026-07-29T09:00:00.000Z', '2026-07-30T17:00:00.000Z', 101);
    await histNode('HDone B', 'done', '2026-08-01T09:00:00.000Z', '2026-08-02T17:00:00.000Z', 102);
    await histNode('HGap', 'done', null, '2026-08-03T17:00:00.000Z', 103);      // done, no start
    await histNode('HCurrent', 'working', '2026-08-10T09:00:00.000Z', null, 104); // in flight
    await histNode('HFuture', 'queued', null, null, 105);                         // not started
    const g2 = await workflowGanttModel({ projectId });
    const h = g2.time_axis;
    // The plan has 12 atoms now: the original 7 (A1,A2,A3,B1,B2,C1,D1 — C1 has a closed
    // execution, so it is DONE) + the 5 history items. past = C1, HDone A, HDone B, HGap (4);
    // current = HCurrent (1); future = the 7 not-started (A1,A2,A3,B1,B2,D1,HFuture).
    ok(h && h.past === 4 && h.current === 1 && h.future === 7 && h.gaps === 1,
      `time_axis = {past:4, current:1, future:7, gaps:1} — done in the past (incl. C1's closed execution), in-flight current, queued future, the startless done node a gap (got ${JSON.stringify(h)})`);
    const byNameG2 = new Map(g2.rows.map((r) => [r.name, r]));
    ok(byNameG2.get('HDone A')?.timing_source === 'actual' && byNameG2.get('HDone A')?.drawn_start === '2026-07-29T09:00:00.000Z',
      `HDone A is drawn on its ACTUAL start (${byNameG2.get('HDone A')?.drawn_start}) — provenance 'actual'`);
    ok(byNameG2.get('HDone A')?.time_state === 'past', `HDone A (ended 2026-07-30) is PAST (got ${byNameG2.get('HDone A')?.time_state})`);
    ok(byNameG2.get('HGap')?.drawn_start === null && byNameG2.get('HGap')?.drawn_end && byNameG2.get('HGap')?.gap === true,
      `HGap (done, no actual_start) shows the GAP — drawn_start null, end set, gap=true`);
    ok(byNameG2.get('HCurrent')?.time_state === 'current'
       && byNameG2.get('HCurrent')?.drawn_start === '2026-08-10T09:00:00.000Z',
      `HCurrent (in flight) is CURRENT, drawn from its measured start (${byNameG2.get('HCurrent')?.drawn_start})`);
    ok(byNameG2.get('HFuture')?.time_state === 'future' && byNameG2.get('HFuture')?.timing_source === 'projected',
      `HFuture (queued) stays FUTURE / projected — forward scheduling only for not-yet-done work`);
  } finally {
    try {
      await q(`DELETE FROM project WHERE id=$1`, [projectId]);
      const residue = await one(
        `SELECT
           (SELECT count(*)::int FROM work_node WHERE plan_version_id IN
             (SELECT id FROM plan_version WHERE plan_id IN (SELECT id FROM plan WHERE project_id=$1))) AS nodes,
           (SELECT count(*)::int FROM project WHERE id=$1) AS projects`, [projectId]);
      ok(residue.nodes === 0 && residue.projects === 0,
        `teardown leaves no residue (nodes=${residue.nodes} projects=${residue.projects})`);
    } catch (e) {
      console.error(`  ✗ FAIL teardown: ${e.message.split('\n')[0].slice(0, 100)}`);
      fail++;
    }
    await client.end().catch(() => {});
  }
}

await main().catch((e) => { console.error('TEST ERROR:', e); fail++; });
console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
