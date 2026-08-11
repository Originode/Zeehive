// PROJECT ROOT WORK_NODE — "a project is just a work_node" (migration 191).
//
// Proves against a REAL postgres that every project gets a root work_node
// (stable_key='project:<project_id>', kind container) with the project's item roots beneath it:
//
//   1. TOTAL — after the migration, every project has exactly ONE parentless project node, every
//      project's root work_item node hangs under it, plan_version.root_node_id points at the
//      project node, and every work_item's node is reachable from the project node by walking up.
//   2. IDEMPOTENT — running the migration a SECOND time changes ZERO rows in
//      plan/plan_version/work_node (the manager's exact check).
//   3. WHOLE-PROJECT SCHEDULE — wn_cpm(plan_version) returns the project node as a container
//      whose earliest_start/earliest_finish span the whole project (start → end of all atoms).
//   4. DUAL-WRITE — creating a project (projects.js createProject) materialises its root node in
//      the same transaction; renaming a project (updateProject) keeps the node's name in step.
//
// Everything it creates is torn down in a finally, whatever happens.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const client = new pg.Client({ connectionString: url });
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

const q = (t, p) => client.query(t, p);
const one = async (t, p) => (await client.query(t, p)).rows[0];
const migrationSql = readFileSync(new URL('../db/migrations/191_project_root_work_node.sql', import.meta.url), 'utf8');

async function cleanup() {
  try { await q(`DELETE FROM run WHERE plan_version_id IN (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id=pv.plan_id WHERE p.project_id IN ($1,$2))`, [P1, P2]); } catch { /* */ }
  try { await q(`DELETE FROM project WHERE id = ANY($1::uuid[])`, [[P1, P2]]); } catch { /* */ }
  try { await q(`DELETE FROM project WHERE name LIKE 'ProjectRoot Test%'`); } catch { /* */ }
}

const insItem = async (id, projectId, parentId, kind, title, sortOrder) => {
  await q(`INSERT INTO work_item (id, project_id, parent_id, kind, title, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`, [id, projectId, parentId, kind, title, sortOrder]);
};

async function counts() {
  const tables = ['plan', 'plan_version', 'work_node'];
  const out = {};
  for (const t of tables) out[t] = (await one(`SELECT count(*)::int AS n FROM ${t}`)).n;
  return out;
}

// The rank formula the backfill uses (sign-safe fixed width + id tiebreak).
const rank = (sortOrder, id) =>
  `${String(1000000000 + Number(sortOrder || 0)).padStart(20, '0')}.000000:${id}`;

try {
  await client.connect();
  await cleanup();

  section('seed the fixture (2 projects, post-185 shape: root work_item node is the version root)');
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'Project One','/tmp/p1','main')`, [P1]);
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'Project Two','/tmp/p2','main')`, [P2]);
  await q(`UPDATE work_item SET title='Project One' WHERE project_id=$1 AND kind='project'`, [P1]);
  await q(`UPDATE work_item SET title='Project Two' WHERE project_id=$1 AND kind='project'`, [P2]);
  const root1 = (await one(`SELECT id FROM work_item WHERE project_id=$1 AND kind='project'`, [P1])).id;
  const root2 = (await one(`SELECT id FROM work_item WHERE project_id=$1 AND kind='project'`, [P2])).id;

  // plans + plan_versions + root work_item nodes (parent NULL, the 185 shape)
  const plan1 = (await one(`INSERT INTO plan (project_id, name) VALUES ($1,'Project One') RETURNING id`, [P1])).id;
  const pv1 = (await one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [plan1])).id;
  const rootNode1 = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
     VALUES ($1,NULL,$2,'Project One','container','sequence',$3) RETURNING id`,
    [pv1, rank(1000, root1), `work_item:${root1}`])).id;
  await q(`UPDATE plan_version SET root_node_id=$1 WHERE id=$2`, [rootNode1, pv1]);

  const plan2 = (await one(`INSERT INTO plan (project_id, name) VALUES ($1,'Project Two') RETURNING id`, [P2])).id;
  const pv2 = (await one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [plan2])).id;
  const rootNode2 = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
     VALUES ($1,NULL,$2,'Project Two','container','sequence',$3) RETURNING id`,
    [pv2, rank(1000, root2), `work_item:${root2}`])).id;
  await q(`UPDATE plan_version SET root_node_id=$1 WHERE id=$2`, [rootNode2, pv2]);

  // a small tree under each root (activity → task)
  const a1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const t1 = 'bbbbbbbb-0000-4000-8000-000000000001';
  const a2 = 'aaaaaaaa-0000-4000-8000-000000000002';
  const t2 = 'bbbbbbbb-0000-4000-8000-000000000002';
  await insItem(a1, P1, root1, 'activity', 'Activity One', 1000);
  await insItem(t1, P1, a1, 'task', 'Task One', 1000);
  await insItem(a2, P2, root2, 'activity', 'Beta One', 1000);
  await insItem(t2, P2, a2, 'task', 'Unit One', 1000);
  await q(`UPDATE work_item SET estimate_hours=8 WHERE id=$1`, [t1]);
  await q(`UPDATE work_item SET estimate_hours=4 WHERE id=$1`, [t2]);
  const nA1 = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
     VALUES ($1,$2,$3,'Activity One','container','sequence',$4) RETURNING id`,
    [pv1, rootNode1, rank(1000, a1), `work_item:${a1}`])).id;
  await q(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, estimate, stable_key)
     VALUES ($1,$2,$3,'Task One','action',interval '8 hours',$4)`,
    [pv1, nA1, rank(1000, t1), `work_item:${t1}`]);
  const nA2 = (await one(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
     VALUES ($1,$2,$3,'Beta One','container','sequence',$4) RETURNING id`,
    [pv2, rootNode2, rank(1000, a2), `work_item:${a2}`])).id;
  await q(
    `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, estimate, stable_key)
     VALUES ($1,$2,$3,'Unit One','action',interval '4 hours',$4)`,
    [pv2, nA2, rank(1000, t2), `work_item:${t2}`]);

  ok((await one(`SELECT count(*)::int n FROM project`)).n === 2, 'fixture: 2 projects');
  ok((await one(`SELECT count(*)::int n FROM work_node`)).n === 6, 'fixture: 6 work_nodes (2 roots + 4 items)');
  ok((await one(`SELECT count(*)::int n FROM work_node WHERE stable_key LIKE 'project:%'`)).n === 0,
    'fixture: no project nodes before the migration (the measured absence)');

  section('first migration run — TOTAL');
  await q('BEGIN');
  await q(migrationSql);
  await q('COMMIT');

  // every project has exactly ONE parentless project node
  const badRoots = (await one(`SELECT count(*)::int n FROM project p
    WHERE (SELECT count(*) FROM work_node wn
            WHERE wn.stable_key='project:'||p.id::text AND wn.parent_id IS NULL) <> 1`)).n;
  ok(badRoots === 0, `every project has exactly one parentless project node (${badRoots} bad)`);

  // every project's root work_item node hangs under its project node
  const badParent = (await one(`SELECT count(*)::int n FROM work_item ri
    WHERE ri.kind='project' AND NOT EXISTS (
      SELECT 1 FROM work_node rn JOIN work_node pn ON pn.id=rn.parent_id
       WHERE rn.stable_key='work_item:'||ri.id::text
         AND pn.stable_key='project:'||ri.project_id::text)`)).n;
  ok(badParent === 0, `every root work_item node hangs under its project node (${badParent} bad)`);

  // plan_version.root_node_id points at the project node
  const badRni = (await one(`SELECT count(*)::int n FROM plan_version pv
    WHERE EXISTS (SELECT 1 FROM work_node pn
                   WHERE pn.plan_version_id=pv.id AND pn.stable_key LIKE 'project:%')
      AND NOT EXISTS (SELECT 1 FROM work_node pn
                       WHERE pn.id=pv.root_node_id AND pn.plan_version_id=pv.id
                         AND pn.stable_key LIKE 'project:%')`)).n;
  ok(badRni === 0, `plan_version.root_node_id points at the project node (${badRni} bad)`);

  // every work_item's node is reachable from its project node by walking UP
  const badReach = (await one(`SELECT count(*)::int n FROM work_node wn
    JOIN plan_version pv ON pv.id=wn.plan_version_id
    JOIN plan p ON p.id=pv.plan_id
    WHERE wn.stable_key LIKE 'work_item:%'
      AND NOT EXISTS (
        WITH RECURSIVE up AS (
          SELECT wn.id AS id, wn.parent_id AS parent_id
          UNION ALL
          SELECT u.parent_id, w.parent_id FROM up u JOIN work_node w ON w.id=u.parent_id
        )
        SELECT 1 FROM up u JOIN work_node pn ON pn.id=u.parent_id
         WHERE pn.stable_key='project:'||p.project_id::text)`)).n;
  ok(badReach === 0, `every work_item node is reachable from its project node (${badReach} bad)`);

  // exactly one project node per project, total
  ok((await one(`SELECT count(*)::int n FROM work_node WHERE stable_key LIKE 'project:%'`)).n === 2,
    'exactly 2 project nodes exist');

  section('wn_cpm returns a whole-project schedule');
  const pv1Again = (await one(`SELECT id FROM plan_version WHERE id=$1`, [pv1])).id;
  const projectNodeId = (await one(`SELECT id FROM work_node WHERE stable_key=$1`, [`project:${P1}`])).id;
  const cpm = (await q(`SELECT node_id, name, kind, is_atom, earliest_start, earliest_finish FROM wn_cpm($1,'2026-01-01T00:00:00Z')`, [pv1Again])).rows;
  const projRow = cpm.find((r) => r.name === 'Project One' && !r.is_atom && r.node_id === projectNodeId);
  const taskRow = cpm.find((r) => r.name === 'Task One');
  ok(!!projRow && !!taskRow, `wn_cpm returns the project node AND the project's task`);
  if (projRow && taskRow) {
    const sameStart = +new Date(projRow.earliest_start) === +new Date(taskRow.earliest_start);
    const sameFinish = +new Date(projRow.earliest_finish) === +new Date(taskRow.earliest_finish);
    ok(sameStart && sameFinish,
      `project node span covers the whole project (start ${projRow.earliest_start?.toISOString()}, finish ${projRow.earliest_finish?.toISOString()})`);
  }

  section('second migration run — IDEMPOTENT (zero rows changed)');
  const before2 = await counts();
  await q('BEGIN');
  await q(migrationSql);
  await q('COMMIT');
  const after2 = await counts();
  const keys = Object.keys(before2);
  ok(keys.every((k) => before2[k] === after2[k]),
    `second run changed zero rows: ${JSON.stringify(before2)} → ${JSON.stringify(after2)}`);

  section('dual-write: createProject and rename maintain the root node');
  const { createProject, updateProject } = await import('../server/src/lib/projects.js');
  const created = await createProject({ name: 'ProjectRoot Test One', repo_root: '/work/repo' });
  const cn = await one(`SELECT * FROM work_node WHERE stable_key=$1`, [`project:${created.id}`]);
  ok(!!cn && cn.kind === 'container' && cn.parent_id === null && cn.child_semantics === 'sequence',
    `createProject materialises the project root node (kind container, parent NULL, sequence)`);
  const createdRootItem = await one(`SELECT id FROM work_item WHERE project_id=$1 AND kind='project'`, [created.id]);
  const createdRootNode = await one(`SELECT parent_id FROM work_node WHERE stable_key=$1`, [`work_item:${createdRootItem.id}`]);
  ok(createdRootNode && createdRootNode.parent_id === cn.id,
    'createProject: the root work_item node hangs under the project node');
  const createdPv = await one(`SELECT pv.root_node_id FROM plan_version pv JOIN plan p ON p.id=pv.plan_id WHERE p.project_id=$1`, [created.id]);
  ok(createdPv && createdPv.root_node_id === cn.id, 'createProject: plan_version.root_node_id is the project node');

  const renamed = await updateProject(created.id, { name: 'ProjectRoot Test Renamed' });
  const cn2 = await one(`SELECT name FROM work_node WHERE stable_key=$1`, [`project:${created.id}`]);
  ok(cn2.name === 'ProjectRoot Test Renamed' && renamed.name === 'ProjectRoot Test Renamed',
    `updateProject (rename) keeps the project node name in step`);

  console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await cleanup().catch(() => {});
  await client.end();
}
