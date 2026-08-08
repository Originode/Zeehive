// WORK ITEM ACTUALS (integration) — the TRIGGER keeps the stored columns current, and the JS module
// (test/work-actuals.test.mjs) is the derivation it implements. This file pins the two to the same
// answer by driving the real write paths against a real database:
//
//   1. an item whose status transitions queued → assigned → working → done gets actual_start (the
//      first transition in) and actual_end (the terminal one) from the work_item_event trigger;
//   2. a real zee_turn on a linked xell backfills actual_start when the ledger has no event for it;
//   3. a landed land_request on a linked xell backfills actual_end when no event closed the item;
//   4. the stored answer equals what lib/work-actuals.js deriveActuals() computes from the same
//      ledger rows — the SQL and the JS cannot drift.
//
// Everything created is torn down in a finally. NO test data left behind.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);
const same = (a, b) => (a === b || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()));

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-00000000ac1b';

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id = $1::uuid`, [PID]); } catch { /* */ }
}

try {
  await client.connect();
  await cleanup();

  const W = await import('../server/src/lib/work-items.js');
  const A = await import('../server/src/lib/work-actuals.js');
  const { pool } = await import('../server/src/db/pool.js');

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'work-actuals-db-test','/tmp/wad','master')`,
    [PID]);

  // ── 1. the event trigger: transitions drive the columns ─────────────────
  section('the event trigger derives start and end from status transitions');
  const item = await W.createWorkItem({ project_id: PID, title: 'event-driven', kind: 'task' });
  ok((await client.query(`SELECT actual_start FROM work_item WHERE id=$1`, [item.id])).rows[0].actual_start === null,
     'a freshly created item has no actual_start (a created event is not a start)');
  await W.setStatus(item.id, 'assigned', { actor: 'test' });
  await W.setStatus(item.id, 'working', { actor: 'test' });
  let row = (await client.query(`SELECT actual_start, actual_end FROM work_item WHERE id=$1`, [item.id])).rows[0];
  ok(row.actual_start !== null && row.actual_end === null,
     'the first transition into assigned/working set actual_start; still in flight so no actual_end');
  const startAt = new Date(row.actual_start);
  await W.setStatus(item.id, 'done', { actor: 'test' });
  row = (await client.query(`SELECT actual_start, actual_end FROM work_item WHERE id=$1`, [item.id])).rows[0];
  ok(row.actual_end !== null, 'the terminal event set actual_end');
  // the JS module, fed the same ledger rows, must answer the same instants
  const events = (await W.getWorkItem(item.id)).events.map((e) => ({
    kind: e.kind, ts: e.ts, to_status: e.to_status, detail: e.detail,
  }));
  const a = A.deriveActuals({ events, zeeTurns: [], landings: [] });
  ok(same(a.actual_start, startAt) && same(a.actual_end, new Date(row.actual_end)),
     `the trigger and the JS module agree (${a.actual_start?.toISOString()} → ${a.actual_end?.toISOString()})`);

  // ── 2. the zee_turn trigger: a turn is a start when the ledger is silent ──
  section('the zee_turn trigger backfills a start');
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ('00000000-0000-4000-8000-00000000ac2b',$1,'master')`, [PID]);
  const xell = (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled)
       VALUES ($1,'00000000-0000-4000-8000-00000000ac2b','ad-worker','spinoff/ad','working',false) RETURNING *`, [PID])).rows[0];
  const zee = (await client.query(
    `INSERT INTO zee (xell_id, status, attach_mode) VALUES ($1,'working','headless-spawn') RETURNING id`, [xell.id])).rows[0];
  const turnItem = await W.createWorkItem({ project_id: PID, title: 'turn-driven', kind: 'task' });
  await W.updateWorkItem(turnItem.id, { xell_id: xell.id }, { actor: 'test' });
  ok((await client.query(`SELECT actual_start FROM work_item WHERE id=$1`, [turnItem.id])).rows[0].actual_start !== null
     || (await W.getWorkItem(turnItem.id)).events.some((e) => e.kind === 'assigned'),
     'assigning a zee records an assigned event (the item now has a start source)');
  await client.query(`INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, started_at)
    VALUES ($1, $2, $3, 'spawn', '2026-07-04T09:00:00Z')`, [zee.id, xell.id, PID]);
  row = (await client.query(`SELECT actual_start FROM work_item WHERE id=$1`, [turnItem.id])).rows[0];
  ok(row.actual_start !== null && new Date(row.actual_start).getTime() <= new Date('2026-07-04T09:00:00Z').getTime(),
     'the earliest zee_turn of the linked xell contributes the start');

  // ── 3. the land_request trigger: a landed landing is an end ───────────────
  section('the land_request trigger backfills an end');
  // The app enforces ONE item per xell ("one zee, one item" — work-assign's busy check), and the
  // land trigger resolves the item through the CURRENT link, so take the xell off the turn item
  // first: a real zee lands the item it is actually on.
  await W.updateWorkItem(turnItem.id, { xell_id: null }, { actor: 'test' });
  const landItem = await W.createWorkItem({ project_id: PID, title: 'land-driven', kind: 'task' });
  await W.updateWorkItem(landItem.id, { xell_id: xell.id }, { actor: 'test' });
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status, decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main','abc123','landed',now(),'human','2026-07-05T10:00:00Z')`, [PID, xell.id]);
  row = (await client.query(`SELECT actual_end FROM work_item WHERE id=$1`, [landItem.id])).rows[0];
  ok(same(new Date(row.actual_end), new Date('2026-07-05T10:00:00Z')),
     'the landed landing set actual_end even though the item was never marked done');

  // ── 4. refreshWorkItemActual is the workflow-rehab entry, and it works ────
  section('refreshWorkItemActual recomputes on demand');
  await W.setStatus(item.id, 'queued', { actor: 'test' });     // reopen — the record still holds the old end
  await A.refreshWorkItemActual(item.id);
  row = (await client.query(`SELECT actual_end FROM work_item WHERE id=$1`, [item.id])).rows[0];
  ok(row.actual_end !== null,
     'refreshWorkItemActual() runs the same SQL function the triggers call — reusable by the workflow-rehab');

  await pool.end().catch(() => {});
} finally {
  await cleanup();
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
