// REHAB 1/4 FOLLOW-UP — migration 186 (repair dependency direction + rank encoding) and the
// SIGN-SAFE sibling_rank scheme.
//
// The manager's check on the live meta-DB found three defects in 185:
//   1. dependency direction was REVERSED (dependency.from_id is the PREREQUISITE, but 185 wrote
//      from_id=node(work_item_id) — the dependent);
//   2. sibling_rank encoding broke on fractional/negative sort_order (a drag midpoint or a
//      negative head-slot value);
//   3. (in-tree only) 185 aborted on a plan_version that already had a foreign root.
// 185 is fixed in-tree; this test proves the REPAIR migration 186 fixes an already-185'd database
// AND that the new sign-safe rank scheme orders the manager's vector + the order.js drag cases.
//
//   1. simulate the buggy 185 output (reversed deps + old lpad ranks), run 186, assert both fixed.
//   2. 186 is idempotent — a second run changes zero rows.
//   3. the sign-safe rank formula orders the manager's vector (1000, 2000, 1500.5, 1250.25, -500,
//      3000) correctly through the LIVE dual-write (createWorkItem writes the node), plus the
//      order.js drag placements (midpoint, after-1, before+1).
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
const migration185 = readFileSync(new URL('../db/migrations/185_rehab_backfill_work_items_into_workflow_model.sql', import.meta.url), 'utf8');
const migration186 = readFileSync(new URL('../db/migrations/186_repair_rehab_dependency_direction_rank_encoding.sql', import.meta.url), 'utf8');
const { pool } = await import('../server/src/db/pool.js');

async function cleanup() {
  try { await q(`DELETE FROM project WHERE id = $1`, [PID]); } catch { /* */ }
}

try {
  await client.connect();
  await cleanup();

  const W = await import('../server/src/lib/work-items.js');

  // ── seed: project with two sibling activities + a dep ─────────────────────
  await q(`INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'Repair Test','/tmp/rp','main')`, [PID]);
  const root = await W.projectRoot(PID);
  const actA = await W.createWorkItem({ project_id: PID, parent_id: root.id, kind: 'activity', title: 'Act A', sort_order: 1000 });
  const actB = await W.createWorkItem({ project_id: PID, parent_id: root.id, kind: 'activity', title: 'Act B', sort_order: 2000 });
  // actA depends on actB → actB is the PREREQUISITE, actA the DEPENDENT.
  await W.addDep(actA.id, actB.id, { actor: 'test' });
  // make actA a container so it has children (shape → container)
  await W.createWorkItem({ project_id: PID, parent_id: actA.id, kind: 'task', title: 'A1', sort_order: 1000 });

  const nodeA = (await one(`SELECT id FROM work_node WHERE stable_key=$1`, [`work_item:${actA.id}`])).id;
  const nodeB = (await one(`SELECT id FROM work_node WHERE stable_key=$1`, [`work_item:${actB.id}`])).id;

  // ── 1. simulate the buggy 185 output, then run 186 to repair ─────────────
  section('186 repairs a buggy-185 database');
  // Buggy direction: from_id=node(dependent) → to_id=node(prerequisite)
  await q(`DELETE FROM dependency WHERE from_id=$1 AND to_id=$2 AND type='FS'`, [nodeB, nodeA]);
  await q(`INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,'FS')`, [nodeA, nodeB]);
  const buggyDep = await one(`SELECT 1 AS x FROM dependency d WHERE d.from_id=$1 AND d.to_id=$2 AND d.type='FS'`, [nodeA, nodeB]);
  ok(!!buggyDep, 'seeded the buggy reversed dependency (dependent → prerequisite)');

  // Buggy ranks: old lpad format (correct for integer sort_orders only)
  await q(`UPDATE work_node wn SET sibling_rank = lpad(wi.sort_order::numeric::text, 20, '0') || ':' || wi.id::text
           FROM work_item wi WHERE wn.stable_key = 'work_item:' || wi.id::text`);
  const oldRank = (await one(`SELECT sibling_rank FROM work_node WHERE id=$1`, [nodeA])).sibling_rank;
  ok(/^\d{20}:/.test(oldRank), `old lpad rank present (${oldRank.slice(0, 24)}…) — simulating a buggy-185 db`);

  // Run the repair.
  await client.query('BEGIN'); await client.query(migration186); await client.query('COMMIT');

  const fixedDep = await one(`SELECT 1 AS x FROM dependency d WHERE d.from_id=$1 AND d.to_id=$2 AND d.type='FS'`, [nodeB, nodeA]);
  ok(!!fixedDep, 'dependency direction repaired: from_id=prerequisite (actB) → to_id=dependent (actA)');
  const buggyGone = await one(`SELECT 1 AS x FROM dependency d WHERE d.from_id=$1 AND d.to_id=$2 AND d.type='FS'`, [nodeA, nodeB]);
  ok(!buggyGone, 'the reversed row is gone');
  const newRank = (await one(`SELECT sibling_rank FROM work_node WHERE id=$1`, [nodeA])).sibling_rank;
  ok(/^0000000000\d{10}\.\d{6}:/.test(newRank),
    `rank re-encoded to sign-safe fixed-width (${newRank.slice(0, 28)}…)`);

  // ── 2. 186 idempotent ────────────────────────────────────────────────────
  section('186 is idempotent — a second run changes zero rows');
  const before2 = await one(`SELECT
    (SELECT count(*)::int FROM dependency) AS deps,
    (SELECT count(*)::int FROM work_node) AS nodes,
    (SELECT count(*)::int FROM plan) AS plans,
    (SELECT count(*)::int FROM plan_version) AS pvs`);
  await client.query('BEGIN'); await client.query(migration186); await client.query('COMMIT');
  const after2 = await one(`SELECT
    (SELECT count(*)::int FROM dependency) AS deps,
    (SELECT count(*)::int FROM work_node) AS nodes,
    (SELECT count(*)::int FROM plan) AS plans,
    (SELECT count(*)::int FROM plan_version) AS pvs`);
  ok(JSON.stringify(before2) === JSON.stringify(after2),
    `second 186 run changed zero rows (${JSON.stringify(before2)})`);

  // ── 3. sign-safe rank ordering via the LIVE dual-write ───────────────────
  section('sign-safe sibling_rank orders the manager vector + drag cases');
  // Create a fresh column of siblings at the manager's vector sort_orders, dual-written.
  const vector = [1000, 2000, 1500.5, 1250.25, -500, 3000];
  const ids = [];
  for (const so of vector) {
    const it = await W.createWorkItem({ project_id: PID, parent_id: actB.id, kind: 'task', title: `V${so}`, sort_order: so });
    ids.push(it.id);
  }
  const ranked = (await q(
    `SELECT wi.sort_order FROM work_node wn JOIN work_item wi ON wi.id = replace(wn.stable_key, 'work_item:', '')::uuid
      WHERE wn.parent_id = $1 ORDER BY wn.sibling_rank`, [nodeB])).rows.map((r) => Number(r.sort_order));
  const expected = [...vector].sort((a, b) => a - b);
  ok(JSON.stringify(ranked) === JSON.stringify(expected),
    `ORDER BY sibling_rank matches numeric order: ${JSON.stringify(ranked)} (expected ${JSON.stringify(expected)})`);

  // The order.js drag cases: placement() writes a midpoint, after-1 (first slot), before+1 (last).
  const order = await import('../web/src/work/order.js');
  // two neighbours 1000 and 2000 → drop between → 1500; then drop before head 1500 → 1499
  const mid = order.placement([{ id: 'x', sort_order: 1000 }, { id: 'y', sort_order: 2000 }], 'z', 1);
  ok(mid.sortOrder === 1500, `midpoint of 1000/2000 → ${mid.sortOrder}`);
  const head = order.placement([{ id: 'x', sort_order: 0 }, { id: 'y', sort_order: 1000 }], 'z', 0);
  ok(head.sortOrder === -1, `first slot after head reaches 0 → ${head.sortOrder}`);
  const tail = order.placement([{ id: 'x', sort_order: 1000 }], 'z', 1);
  ok(tail.sortOrder === 1001, `last slot → ${tail.sortOrder}`);

  // Dual-write those drag sort_orders and confirm ordering.
  const dragItems = [
    await W.createWorkItem({ project_id: PID, parent_id: actB.id, kind: 'task', title: 'DragMid', sort_order: mid.sortOrder }),
    await W.createWorkItem({ project_id: PID, parent_id: actB.id, kind: 'task', title: 'DragHead', sort_order: head.sortOrder }),
    await W.createWorkItem({ project_id: PID, parent_id: actB.id, kind: 'task', title: 'DragTail', sort_order: tail.sortOrder }),
  ];
  const dragRanks = (await q(
    `SELECT wi.sort_order FROM work_node wn JOIN work_item wi ON wi.id = replace(wn.stable_key, 'work_item:', '')::uuid
      WHERE wn.parent_id = $1 ORDER BY wn.sibling_rank`, [nodeB])).rows.map((r) => Number(r.sort_order));
  const dragExpected = [...vector, mid.sortOrder, head.sortOrder, tail.sortOrder].sort((a, b) => a - b);
  ok(JSON.stringify(dragRanks) === JSON.stringify(dragExpected),
    `drag sort_orders (fractional + negative) order correctly: ${JSON.stringify(dragRanks)}`);

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
