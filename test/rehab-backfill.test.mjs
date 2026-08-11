// REHAB 1/4 — the backfill migration (185_rehab_backfill_work_items_into_workflow_model.sql).
//
// Proves the migration against a REAL postgres with a fixture that mirrors prod's shape:
//
//   1. TOTAL — every non-project work_item becomes exactly one work_node (keyed by
//      work_node.stable_key = 'work_item:<uuid>'), every project root becomes a plan +
//      plan_version + ROOT work_node with plan_version.root_node_id set, and every
//      work_item_dep edge becomes an FS dependency row.
//   2. IDEMPOTENT — running the migration a SECOND time changes ZERO rows in
//      plan/plan_version/work_node/dependency/run/execution (the manager's exact check).
//   3. node_kind from shape: containers (have children) carry child_semantics; leaves are
//      'action'. A container that is the LCA of a dependency edge is 'freeform' (the only
//      semantics that permits explicit dependency rows under the model's I5 trigger).
//   4. executions: an item that ever ran (assigned/status event, zee_turn, or land_request)
//      gets an execution reconstructed from those timestamps; an item that never ran (only a
//      created/edited event, or nothing) gets NONE — no fabricated started_at.
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
const migrationSql = readFileSync(new URL('../db/migrations/185_rehab_backfill_work_items_into_workflow_model.sql', import.meta.url), 'utf8');

async function cleanup() {
  // run → execution (ON DELETE CASCADE via run_id), dependency (from/to ON DELETE CASCADE),
  // work_node (plan_version ON DELETE CASCADE), plan_version, plan, then project.
  // run.plan_version_id has NO cascade, so runs must go first.
  try { await q(`DELETE FROM run WHERE plan_version_id IN (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id=pv.plan_id WHERE p.project_id IN ($1,$2))`, [P1, P2]); } catch { /* */ }
  try { await q(`DELETE FROM project WHERE id = ANY($1::uuid[])`, [[P1, P2]]); } catch { /* */ }
  try { await q(`DELETE FROM session_event WHERE source='rehab-test'`); } catch { /* */ }
}

const insItem = async (id, projectId, parentId, kind, title, sortOrder, status, estimate, xellId = null, extra = {}) => {
  const cols = ['id','project_id','parent_id','kind','title','sort_order','status','estimate_hours','xell_id','starts_on','due_on','actual_start','actual_end'];
  const vals = [id, projectId, parentId, kind, title, sortOrder, status, estimate, xellId,
    extra.starts_on || null, extra.due_on || null, extra.actual_start || null, extra.actual_end || null];
  await q(`INSERT INTO work_item (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
};

const ev = async (itemId, kind, ts, from = null, to = null, actor = 'queenzee', detail = null) => {
  await q(`INSERT INTO work_item_event (work_item_id, kind, from_status, to_status, actor, ts, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [itemId, kind, from, to, actor, ts, detail ? JSON.stringify(detail) : null]);
};

async function counts() {
  const tables = ['plan','plan_version','work_node','dependency','run','execution'];
  const out = {};
  for (const t of tables) out[t] = (await one(`SELECT count(*)::int AS n FROM ${t}`)).n;
  return out;
}

try {
  await client.connect();
  await cleanup();

  section('seed the fixture (2 projects, 13 work_items, 3 deps, 14 events)');
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'Project One','/tmp/p1','main')`, [P1]);
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'Project Two','/tmp/p2','main')`, [P2]);
  await q(`UPDATE work_item SET title='Project One' WHERE project_id=$1 AND kind='project'`, [P1]);
  await q(`UPDATE work_item SET title='Project Two' WHERE project_id=$1 AND kind='project'`, [P2]);
  const root1 = (await one(`SELECT id FROM work_item WHERE project_id=$1 AND kind='project'`, [P1])).id;
  const root2 = (await one(`SELECT id FROM work_item WHERE project_id=$1 AND kind='project'`, [P2])).id;

  const a1 = 'b0000000-0000-4000-8000-000000000001';
  const a2 = 'b0000000-0000-4000-8000-000000000002';
  const a3 = 'b0000000-0000-4000-8000-000000000003';
  const t1 = 'c0000000-0000-4000-8000-000000000001';
  const t2 = 'c0000000-0000-4000-8000-000000000002';
  const t3 = 'c0000000-0000-4000-8000-000000000003';
  const t4 = 'c0000000-0000-4000-8000-000000000004';
  const b1 = 'b0000000-0000-4000-8000-000000000004';
  const u1 = 'c0000000-0000-4000-8000-000000000005';
  const u2 = 'd0000000-0000-4000-8000-000000000001';
  const u3 = 'd0000000-0000-4000-8000-000000000002';

  await insItem(a1, P1, root1, 'activity', 'Activity One', 1000, 'done', 8, null, { starts_on: '2026-01-01', due_on: '2026-01-05' });
  await insItem(a2, P1, root1, 'activity', 'Activity Two', 2000, 'working', 12, null, { starts_on: '2026-01-06', due_on: '2026-01-20' });
  await insItem(a3, P1, root1, 'activity', 'Activity Three (leaf)', 3000, 'queued', 4);
  await insItem(t1, P1, a1, 'task', 'Task One', 1000, 'done', 3, null, { starts_on: '2026-01-02', due_on: '2026-01-03' });
  await insItem(t2, P1, a1, 'task', 'Task Two', 2000, 'done', 5, null, { starts_on: '2026-01-04', due_on: '2026-01-05' });
  await insItem(t3, P1, a2, 'task', 'Task Three', 1000, 'working', 6, null, { starts_on: '2026-01-06', due_on: '2026-01-12' });
  await insItem(t4, P1, a2, 'task', 'Task Four', 2000, 'queued', 6);
  await insItem(b1, P2, root2, 'activity', 'Beta One', 1000, 'cancelled', 10, null, { starts_on: '2026-02-01', due_on: '2026-02-15' });
  await insItem(u1, P2, b1, 'task', 'Unit One', 1000, 'cancelled', 6, null, { starts_on: '2026-02-01', due_on: '2026-02-10' });
  await insItem(u2, P2, u1, 'task', 'Unit Two (nested)', 1000, 'queued', 2);
  await insItem(u3, P2, b1, 'task', 'Unit Three', 2000, 'cancelled', 4, null, { starts_on: '2026-02-02', due_on: '2026-02-05' });

  await q(`INSERT INTO work_item_dep (work_item_id, depends_on_id) VALUES ($1,$2)`, [t2, t1]);
  await q(`INSERT INTO work_item_dep (work_item_id, depends_on_id) VALUES ($1,$2)`, [t4, t3]);
  await q(`INSERT INTO work_item_dep (work_item_id, depends_on_id) VALUES ($1,$2)`, [u1, u3]);

  await ev(t1, 'assigned', '2026-01-02T08:00:00Z', null, null, 'human@console', { xell_slug: 'xell-t1' });
  await ev(t1, 'status', '2026-01-03T16:00:00Z', 'assigned', 'done', 'queenzee');
  await ev(t2, 'assigned', '2026-01-04T07:30:00Z', null, null, 'human@console', { xell_slug: 'xell-t2' });
  await ev(t2, 'status', '2026-01-05T15:00:00Z', 'assigned', 'done', 'queenzee');
  await ev(t3, 'assigned', '2026-01-06T08:00:00Z', null, null, 'human@console', { xell_slug: 'xell-t3' });
  await ev(t3, 'status', '2026-01-07T10:00:00Z', 'assigned', 'working', 'queenzee');
  await ev(a1, 'status', '2026-01-05T17:00:00Z', 'working', 'done', 'queenzee');
  await ev(a2, 'status', '2026-01-06T09:00:00Z', 'assigned', 'working', 'queenzee');
  await ev(b1, 'assigned', '2026-02-01T08:30:00Z', null, null, 'human@console', { xell_slug: 'xell-b1' });
  await ev(b1, 'status', '2026-02-03T13:00:00Z', 'working', 'cancelled', 'queenzee');
  await ev(u1, 'assigned', '2026-02-01T09:00:00Z', null, null, 'human@console', { xell_slug: 'xell-u1' });
  await ev(u1, 'status', '2026-02-03T12:00:00Z', 'working', 'cancelled', 'queenzee');
  await ev(u3, 'assigned', '2026-02-02T08:00:00Z', null, null, 'human@console', { xell_slug: 'xell-u3' });
  await ev(u3, 'status', '2026-02-03T11:00:00Z', 'working', 'cancelled', 'queenzee');

  // zee_turn for t3; land_request for t2 — the non-event evidence paths.
  const xellT3 = 'eeeeeeee-0000-4000-8000-000000000001';
  const xellT2 = 'eeeeeeee-0000-4000-8000-000000000002';
  const xc1 = (await q(`INSERT INTO xource (project_id, ref) VALUES ($1,'main') RETURNING id`, [P1])).rows[0].id;
  await q(`INSERT INTO xell (id, project_id, xource_id, slug, branch, status, is_production, zee_type)
           VALUES ($1,$2,$3,'xell-t3','spinoff/test','ready',false,'worker')`, [xellT3, P1, xc1]);
  await q(`INSERT INTO xell (id, project_id, xource_id, slug, branch, status, is_production, zee_type)
           VALUES ($1,$2,$3,'xell-t2','spinoff/test','ready',false,'worker')`, [xellT2, P1, xc1]);
  const zeeT3 = 'ffffffff-0000-4000-8000-000000000001';
  await q(`INSERT INTO zee (id, xell_id, attach_mode, status) VALUES ($1,$2,'headless-spawn','idle')`, [zeeT3, xellT3]);
  await q(`INSERT INTO zee_turn (id, zee_id, xell_id, project_id, kind, status, started_at, ended_at)
           VALUES (gen_random_uuid(), $1,$2,$3,'spawn','ended',$4,$5)`,
    [zeeT3, xellT3, P1, '2026-01-07T10:00:00Z', '2026-01-07T11:00:00Z']);
  await q(`UPDATE work_item SET xell_id=$1 WHERE id=$2`, [xellT3, t3]);
  await q(`INSERT INTO land_request (id, project_id, xell_id, ref, old_sha, new_sha, status, requested_at)
           VALUES (gen_random_uuid(), $1,$2,'refs/heads/main','old','new','pending',$3)`,
    [P1, xellT2, '2026-01-05T14:00:00Z']);

  const nItems = (await one(`SELECT count(*)::int AS n FROM work_item`)).n;
  const nNonProject = (await one(`SELECT count(*)::int AS n FROM work_item WHERE kind <> 'project'`)).n;
  ok(nItems === 13 && nNonProject === 11, `fixture: 13 work_items, 11 non-project (got ${nItems}/${nNonProject})`);

  section('first migration run — TOTAL');
  await client.query('BEGIN');
  await client.query(migrationSql);
  await client.query('COMMIT');

  const after1 = await counts();
  ok(after1.plan === 2 && after1.plan_version === 2, `2 project roots → 2 plans + 2 plan_versions (got ${after1.plan}/${after1.plan_version})`);
  ok(after1.work_node === nItems, `every work_item (incl. roots) has exactly one work_node: ${nItems} (got ${after1.work_node})`);
  ok(after1.dependency === 3, `3 work_item_dep edges → 3 dependency rows (got ${after1.dependency})`);

  const missing = (await one(`SELECT count(*)::int AS n FROM work_item wi WHERE wi.kind <> 'project'
    AND NOT EXISTS (SELECT 1 FROM work_node wn WHERE wn.stable_key = 'work_item:' || wi.id::text)`)).n;
  ok(missing === 0, `every non-project work_item has a node (${missing} missing)`);

  const roots = (await one(`SELECT count(*)::int AS n FROM work_item r WHERE r.kind = 'project'
    AND NOT EXISTS (SELECT 1 FROM plan p JOIN plan_version pv ON pv.plan_id=p.id AND pv.root_node_id IS NOT NULL
                    JOIN work_node rn ON rn.id=pv.root_node_id
                    WHERE p.project_id=r.project_id AND rn.stable_key='work_item:'||r.id::text)`)).n;
  ok(roots === 0, `every project root has a plan+plan_version+root_node with root_node_id set (${roots} bad)`);

  // node_kind from shape: containers carry semantics, leaves are action
  const container = (await one(`SELECT count(*)::int AS n FROM work_node WHERE kind='container' AND child_semantics IS NOT NULL`)).n;
  const leafSem = (await one(`SELECT count(*)::int AS n FROM work_node WHERE kind='action' AND child_semantics IS NOT NULL`)).n;
  ok(container === 6, `6 containers each carry child_semantics (got ${container})`);
  ok(leafSem === 0, `no action node carries child_semantics (got ${leafSem})`);
  // LCA-of-dep containers flipped to freeform
  const freeform = (await one(`SELECT count(*)::int AS n FROM work_node WHERE child_semantics='freeform'`)).n;
  ok(freeform === 3, `the 3 dep-LCA containers are freeform (got ${freeform})`);

  // executions: 8 items ran (t1,t2,t3,a1,a2,b1,u1,u3); a3,t4,u2 and both roots did NOT
  const execs = (await one(`SELECT count(*)::int AS n FROM execution`)).n;
  ok(execs === 8, `exactly the 8 items that ever ran get executions (got ${execs})`);
  const noExec = (await one(`SELECT count(*)::int AS n FROM work_item wi WHERE wi.kind <> 'project'
    AND NOT EXISTS (SELECT 1 FROM work_node wn JOIN execution e ON e.work_node_id=wn.id WHERE wn.stable_key='work_item:'||wi.id::text)
    AND wi.title IN ('Activity Three (leaf)','Task Four','Unit Two (nested)')`)).n;
  ok(noExec === 3, `a3/t4/u2 (never ran) get NO execution (got ${noExec})`);
  const ran = (await one(`SELECT count(*)::int AS n FROM execution e JOIN work_node wn ON wn.id=e.work_node_id
    WHERE wn.stable_key='work_item:b0000000-0000-4000-8000-000000000001' AND e.state='done' AND e.started_at='2026-01-05T17:00:00Z'`)).n;
  ok(ran === 1, `a1 (done) execution reconstructed with started_at from its status event`);

  section('second migration run — IDEMPOTENT (zero rows changed)');
  const before2 = await counts();
  await client.query('BEGIN');
  await client.query(migrationSql);
  await client.query('COMMIT');
  const after2 = await counts();
  const keys = Object.keys(before2);
  ok(keys.every((k) => before2[k] === after2[k]),
    `second run changed zero rows: ${JSON.stringify(before2)} → ${JSON.stringify(after2)}`);

  console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await cleanup().catch(() => {});
  await client.end();
}
