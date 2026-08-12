// REHAB 3/4 — the work_item_dep retirement (migration 188).
//
// Asserts the END STATE the drop leaves:
//   1. the work_item_dep table is GONE (to_regclass null), along with its guard trigger/function;
//   2. no database object (view, matview, function, trigger, FK) references work_item_dep;
//   3. re-applying migration 188 is a no-op and changes ZERO model rows (dependency/work_node/
//      execution) — the drop touches only the dead legacy table, never the model;
//   4. the model reader path still serves dependency edges (create + addDep → getWorkItem.deps),
//      which is the path that replaced work_item_dep.
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
const PID = '11111111-1111-4111-8111-111111111111';
const q = (t, p) => client.query(t, p);
const one = async (t, p) => (await client.query(t, p)).rows[0];

const migrationSql = readFileSync(new URL('../db/migrations/188_retire_work_item_dep.sql', import.meta.url), 'utf8');

async function cleanup() {
  try { await q(`DELETE FROM run WHERE plan_version_id IN (SELECT pv.id FROM plan_version pv JOIN plan p ON p.id=pv.plan_id WHERE p.project_id=$1)`, [PID]); } catch { /* */ }
  try { await q(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
}

// Model rows scoped to THIS project — a global count would be polluted by other tests sharing the db.
const modelCountsSql = `
  SELECT
    (SELECT count(*)::int FROM work_node wn
       JOIN work_item wi ON wi.id::text = substring(wn.stable_key, 11)
      WHERE wi.project_id = $1) AS nodes,
    (SELECT count(*)::int FROM execution e
       JOIN work_node wn ON wn.id = e.work_node_id
       JOIN work_item wi ON wi.id::text = substring(wn.stable_key, 11)
      WHERE wi.project_id = $1) AS execs,
    (SELECT count(*)::int FROM dependency d
       JOIN work_node a ON a.id = d.from_id
       JOIN work_node b ON b.id = d.to_id
       JOIN work_item wi ON wi.id::text = substring(b.stable_key, 11)
      WHERE wi.project_id = $1) AS deps`;

try {
  await client.connect();
  await cleanup();

  section('the legacy table is gone');
  const depTable = (await one(`SELECT to_regclass('public.work_item_dep') AS t`)).t;
  ok(depTable === null, 'work_item_dep table does not exist');
  const guard = await one(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='work_item_dep_guard'`);
  ok(guard.n === 0, 'work_item_dep_guard() function is gone');
  const trig = await one(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgname='work_item_dep_guard_trg'`);
  ok(trig.n === 0, 'work_item_dep_guard_trg trigger is gone');

  section('no database object references work_item_dep');
  const refs = await one(`
    SELECT
      (SELECT count(*)::int FROM pg_views WHERE schemaname='public' AND definition ILIKE '%work_item_dep%') AS views,
      (SELECT count(*)::int FROM pg_matviews WHERE schemaname='public' AND definition ILIKE '%work_item_dep%') AS matviews,
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
         WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ILIKE '%work_item_dep%') AS triggers,
      (SELECT count(*)::int FROM pg_constraint con WHERE con.contype='f' AND pg_get_constraintdef(con.oid) ILIKE '%work_item_dep%') AS fks`);
  ok(refs.views === 0 && refs.matviews === 0 && refs.triggers === 0 && refs.fks === 0,
    `no views/matviews/triggers/FKs reference work_item_dep (${JSON.stringify(refs)})`);

  section('re-applying the drop is a no-op and touches zero model rows');
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'RetireDep Test','/tmp/rd','main')`, [PID]);
  const W = await import('../server/src/lib/work-items.js');
  const root = await W.projectRoot(PID);
  const a = await W.createWorkItem({ project_id: PID, parent_id: root.id, kind: 'activity', title: 'Act', sort_order: 1000, actor: 'test' });
  const t1 = await W.createWorkItem({ project_id: PID, parent_id: a.id, kind: 'task', title: 'Task One', sort_order: 1000, actor: 'test' });
  const t2 = await W.createWorkItem({ project_id: PID, parent_id: a.id, kind: 'task', title: 'Task Two', sort_order: 2000, actor: 'test' });
  await W.addDep(t2.id, t1.id, { actor: 'test' });

  const before = await one(modelCountsSql, [PID]);
  const item = await W.getWorkItem(t2.id);
  ok(item.deps.some((d) => d.id === t1.id), 'getWorkItem reads the dependency edge from the model (not work_item_dep)');

  await client.query('BEGIN');
  await client.query(migrationSql);
  await client.query('COMMIT');
  const after = await one(modelCountsSql, [PID]);
  ok(before.nodes === after.nodes && before.execs === after.execs && before.deps === after.deps,
    `re-applying 188 changed zero model rows (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
  const item2 = await W.getWorkItem(t2.id);
  ok(item2.deps.some((d) => d.id === t1.id), 'the model edge still reads after the re-run');

  console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await cleanup().catch(() => {});
  await client.end();
}
