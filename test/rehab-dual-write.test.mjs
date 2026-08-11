// REHAB 1/4 — the DUAL-WRITE half (every writer writes BOTH shapes in ONE transaction).
//
// Proves against a REAL postgres that every legacy writer keeps the workflow model in step:
//
//   1. CREATE — a work_item becomes a work_node (stable_key = 'work_item:<id>', name ← title,
//      kind from shape, child_semantics on containers, sibling_rank from sort_order, estimate
//      from estimate_hours) in the same transaction.
//   2. UPDATE — editing a work_item edits its work_node.
//   3. STATUS — a status change writes/updates the execution (the LIFECYCLE side).
//   4. DEP — a work_item_dep edge becomes a dependency row (type FS) and flips the LCA
//      container to freeform; removing it removes the dependency row.
//   5. DELETE — deleting a work_item deletes its work_node (and its subtree's executions).
//   6. THE TRANSACTIONAL PAIR — the whole point of the rehab: if the model half of a dual-write
//      fails, the legacy half fails with it. Proved twice, both by making the model write fail
//      on purpose:
//        a. CREATE: a BEFORE INSERT trigger on work_node that raises for one specific item —
//           createWorkItem must throw AND leave no work_item row behind.
//        b. DEP: a dependency edge whose endpoints are in an ancestor relationship is refused by
//           the model's I6 trigger — addDep must throw AND leave no work_item_dep row behind.
//
// Everything it creates is torn down in a finally, whatever happens.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const client = new pg.Client({ connectionString: url });
const PID = '11111111-1111-4111-8111-111111111111';
const TRIGGER_NAME = 'rehab_test_node_boom';

const q = (t, p) => client.query(t, p);
const one = async (t, p) => (await client.query(t, p)).rows[0];
const { pool } = await import('../server/src/db/pool.js');

async function cleanup() {
  try { await q(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON work_node`); } catch { /* */ }
  try { await q(`DROP FUNCTION IF EXISTS rehab_test_node_boom()`); } catch { /* */ }
  try { await q(`DELETE FROM project WHERE id = $1`, [PID]); } catch { /* */ }
}

try {
  await client.connect();
  await cleanup();

  const W = await import('../server/src/lib/work-items.js');

  // ── 1. CREATE dual-write ───────────────────────────────────────────────────
  section('create: a work_item is also a work_node');
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'DualWrite Test','/tmp/dw','main')`, [PID]);
  const root = await W.projectRoot(PID);
  ok(root && root.kind === 'project', 'fixture: project has its root work_item');

  const act = await W.createWorkItem({
    project_id: PID, parent_id: root.id, kind: 'activity', title: 'Activity A',
    estimate_hours: 5, sort_order: 1000, actor: 'test',
  });
  const actNode = await one(`SELECT * FROM work_node WHERE stable_key=$1`, [`work_item:${act.id}`]);
  ok(!!actNode, 'creating an activity created its work_node');
  ok(actNode.name === 'Activity A' && actNode.kind === 'action' && actNode.child_semantics === null,
    'node name/kind from shape (leaf activity = action, no semantics)');
  ok(actNode.estimate && actNode.estimate.hours === 5, `estimate_hours 5 → node estimate 5h (got ${JSON.stringify(actNode.estimate)})`);
  ok(actNode.sibling_rank === '00000000000000001000:' + act.id, 'sibling_rank from sort_order (padded + id tiebreak)');

  const task = await W.createWorkItem({
    project_id: PID, parent_id: act.id, kind: 'task', title: 'Task One', sort_order: 1000,
  });
  const taskNode = await one(`SELECT * FROM work_node WHERE stable_key=$1`, [`work_item:${task.id}`]);
  ok(taskNode && taskNode.parent_id === actNode.id, 'a task under the activity hangs off the activity\'s node');
  const actNode2 = await one(`SELECT * FROM work_node WHERE stable_key=$1`, [`work_item:${act.id}`]);
  ok(actNode2.kind === 'container' && actNode2.child_semantics === 'sequence',
    'the parent node was promoted to a container once it gained a child');

  const planCount = (await one(`SELECT count(*)::int AS n FROM plan WHERE project_id=$1`, [PID])).n;
  const pvCount = (await one(`SELECT count(*)::int AS n FROM plan_version pv JOIN plan p ON p.id=pv.plan_id WHERE p.project_id=$1`, [PID])).n;
  ok(planCount === 1 && pvCount === 1, 'the project has exactly one plan + plan_version (lazily materialised)');

  // ── 2. UPDATE dual-write ───────────────────────────────────────────────────
  section('update: editing a work_item edits its work_node');
  const updated = await W.updateWorkItem(task.id, { title: 'Task One (renamed)', estimate_hours: 7 });
  const taskNode2 = await one(`SELECT * FROM work_node WHERE stable_key=$1`, [`work_item:${task.id}`]);
  ok(updated.title === 'Task One (renamed)', 'the work_item title changed');
  ok(taskNode2.name === 'Task One (renamed)' && taskNode2.estimate && taskNode2.estimate.hours === 7,
    'the work_node name and estimate followed');

  // ── 3. STATUS dual-write ───────────────────────────────────────────────────
  section('status: a status change is the lifecycle side (execution)');
  await W.setStatus(task.id, 'working', { actor: 'test' });
  const execRun = await one(
    `SELECT e.* FROM execution e JOIN work_node wn ON wn.id=e.work_node_id
      WHERE wn.stable_key=$1 AND e.state='running'`, [`work_item:${task.id}`]);
  ok(!!execRun, 'working → an execution row (state running)');
  ok(execRun.started_at != null, 'started_at stamped when the item left queued');
  await W.setStatus(task.id, 'done', { actor: 'test' });
  const execDone = await one(
    `SELECT e.* FROM execution e JOIN work_node wn ON wn.id=e.work_node_id
      WHERE wn.stable_key=$1 AND e.state='done'`, [`work_item:${task.id}`]);
  ok(!!execDone && execDone.finished_at != null, 'done → execution state done, finished_at stamped');

  // ── 4. DEP dual-write ─────────────────────────────────────────────────────
  section('dep: a work_item_dep edge is also a dependency row');
  const t2 = await W.createWorkItem({ project_id: PID, parent_id: act.id, kind: 'task', title: 'Task Two', sort_order: 2000 });
  await W.addDep(task.id, t2.id, { actor: 'test' });
  const depRow = await one(
    `SELECT d.* FROM dependency d
      JOIN work_node a ON a.id=d.from_id JOIN work_node b ON b.id=d.to_id
      WHERE a.stable_key=$1 AND b.stable_key=$2 AND d.type='FS'`,
    [`work_item:${task.id}`, `work_item:${t2.id}`]);
  ok(!!depRow, 'addDep → an FS dependency row');
  const lcaNode = await one(`SELECT child_semantics FROM work_node WHERE id=$1`,
    [(await one(`SELECT wn_lca((SELECT id FROM work_node WHERE stable_key=$1),(SELECT id FROM work_node WHERE stable_key=$2)) AS id`,
      [`work_item:${task.id}`, `work_item:${t2.id}`])).id]);
  ok(lcaNode.child_semantics === 'freeform', 'the LCA container flipped to freeform (I5)');
  await W.removeDep(task.id, t2.id, { actor: 'test' });
  const depGone = await one(
    `SELECT d.* FROM dependency d
      JOIN work_node a ON a.id=d.from_id JOIN work_node b ON b.id=d.to_id
      WHERE a.stable_key=$1 AND b.stable_key=$2`,
    [`work_item:${task.id}`, `work_item:${t2.id}`]);
  ok(!depGone, 'removeDep → the dependency row is gone');

  // ── 5. DELETE dual-write ──────────────────────────────────────────────────
  section('delete: deleting a work_item deletes its work_node');
  await W.deleteWorkItem(t2.id);
  const t2Node = await one(`SELECT * FROM work_node WHERE stable_key=$1`, [`work_item:${t2.id}`]);
  ok(!t2Node, 'deleting a work_item deleted its work_node');
  const actNode3 = await one(`SELECT * FROM work_node WHERE stable_key=$1`, [`work_item:${act.id}`]);
  ok(!!actNode3, 'the sibling work_node survives');

  // ── 6. THE TRANSACTIONAL PAIR ─────────────────────────────────────────────
  section('the pair is transactional — a model write failure rolls the legacy write back');
  // (a) CREATE: make the work_node insert fail on purpose.
  const boomId = 'aaaaaaaa-0000-4000-8000-0000000000dd';
  await q(`CREATE OR REPLACE FUNCTION rehab_test_node_boom() RETURNS trigger AS $func$
           BEGIN IF NEW.name = 'Doomed' THEN
             RAISE EXCEPTION 'rehab test: forced work_node failure';
           END IF; RETURN NEW; END $func$ LANGUAGE plpgsql`);
  await q(`CREATE TRIGGER ${TRIGGER_NAME} BEFORE INSERT ON work_node FOR EACH ROW EXECUTE FUNCTION rehab_test_node_boom()`);
  let createThrew = null;
  try {
    await W.createWorkItem({ project_id: PID, parent_id: root.id, kind: 'task', title: 'Doomed', id: boomId });
  } catch (e) { createThrew = e; }
  const doomedItem = await one(`SELECT * FROM work_item WHERE id=$1`, [boomId]);
  ok(createThrew && /forced work_node failure/.test(createThrew.message),
    `createWorkItem threw when the work_node insert failed (${createThrew ? createThrew.message.slice(0, 50) : 'no throw'})`);
  ok(!doomedItem, 'and the work_item row rolled back with it — no half-written pair');

  // (b) DEP: an ancestor-edge is refused by the model (I6) — the dep pair must roll back.
  let depThrew = null;
  try {
    await W.addDep(task.id, act.id, { actor: 'test' });  // task depends on its own parent → I6
  } catch (e) { depThrew = e; }
  const legDep = await one(`SELECT * FROM work_item_dep WHERE work_item_id=$1 AND depends_on_id=$2`, [task.id, act.id]);
  ok(depThrew, 'addDep threw when the dependency row violated I6 (ancestor edge)');
  ok(!legDep, 'and the work_item_dep row rolled back with it');

  await q(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON work_node`);
  await q(`DROP FUNCTION IF EXISTS rehab_test_node_boom()`);

  console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await cleanup().catch(() => {});
  await client.end();
  await pool.end();
}
