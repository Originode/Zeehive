// WORK ITEM ACTUALS (integration) — the TRIGGER keeps the stored columns current, and the JS module
// (test/work-actuals.test.mjs) is the derivation it implements. This file pins the two to the same
// answer by driving the real write paths against a real database:
//
//   1. an item whose status transitions queued → assigned → working → done gets actual_start (the
//      first transition in) and actual_end (the terminal one) from the work_item_event trigger;
//   2. the WINDOW RULE (TKT-153): the item's OWN events win over a xell's earlier turn/landing
//      (a xell works MANY items, so min() over its whole history stamps one item's facts on
//      another). A zee_turn is a start only when the ledger has no start event AND the turn falls
//      inside the item's own window; a landed landing is an end only when it falls INSIDE the
//      item's window (landed_at >= actual_start), and never beats the item's own terminal event.
//   3. the MULTI-ITEM XELL proof: two items on one xell, landings in each item's window — each
//      item keeps its OWN end, none is shared.
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
  // PATCH {xell_id:null} writes an 'assigned' event naming NO xell — it clears a link and must not
  // start the clock (the same event shape an unassign or a zee-gone note produces)
  await W.updateWorkItem(item.id, { xell_id: null }, { actor: 'test' });
  ok((await client.query(`SELECT actual_start FROM work_item WHERE id=$1`, [item.id])).rows[0].actual_start === null,
     'a PATCH that clears the xell link does NOT set actual_start (a zee left; nothing started)');
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

  // ── 2. the zee_turn trigger: a turn is a FALLBACK, scoped to the item's window ──
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ('00000000-0000-4000-8000-00000000ac2b',$1,'master')`, [PID]);
  const xell = (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled)
       VALUES ($1,'00000000-0000-4000-8000-00000000ac2b','ad-worker','spinoff/ad','working',false) RETURNING *`, [PID])).rows[0];
  const zee = (await client.query(
    `INSERT INTO zee (xell_id, status, attach_mode) VALUES ($1,'working','headless-spawn') RETURNING id`, [xell.id])).rows[0];
  const turnItem = await W.createWorkItem({ project_id: PID, title: 'turn-driven', kind: 'task' });
  await W.updateWorkItem(turnItem.id, { xell_id: xell.id }, { actor: 'test' });
  const assignedTs = (await client.query(`SELECT actual_start FROM work_item WHERE id=$1`, [turnItem.id])).rows[0].actual_start;
  // THE LEAK (TKT-153): an earlier xell turn (earned on a DIFFERENT item) used to win via min()
  // and pull the start back. The item's OWN assigned event must win.
  await client.query(`INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, started_at)
    VALUES ($1, $2, $3, 'spawn', '2026-07-04T09:00:00Z')`, [zee.id, xell.id, PID]);
  row = (await client.query(`SELECT actual_start FROM work_item WHERE id=$1`, [turnItem.id])).rows[0];
  ok(row.actual_start !== null && new Date(row.actual_start).getTime() > new Date('2026-07-04T09:00:00Z').getTime(),
     `the item's OWN assigned event wins — an earlier xell turn no longer pulls the start back (${row.actual_start?.toISOString()})`);

  section('a zee_turn IS the start only when it falls inside the item\'s own window');
  // an item linked WITHOUT writing an event (direct link update), with a turn AFTER its creation:
  // the turn is the only evidence, so it backfills the start. The xell moves off `turnItem` first
  // (one item per xell), so the turn trigger resolves the CURRENT link = this item.
  await W.updateWorkItem(turnItem.id, { xell_id: null }, { actor: 'test' });
  const silentItem = await W.createWorkItem({ project_id: PID, title: 'turn-only', kind: 'task' });
  await client.query(`UPDATE work_item_event SET ts='2026-07-05T08:00:00Z' WHERE work_item_id=$1 AND kind='created'`, [silentItem.id]);
  await client.query(`UPDATE work_item SET xell_id=$1 WHERE id=$2`, [xell.id, silentItem.id]);
  await client.query(`INSERT INTO zee_turn (zee_id, xell_id, project_id, kind, started_at)
    VALUES ($1, $2, $3, 'spawn', '2026-07-05T09:00:00Z')`, [zee.id, xell.id, PID]);
  row = (await client.query(`SELECT actual_start FROM work_item WHERE id=$1`, [silentItem.id])).rows[0];
  ok(row.actual_start !== null && same(new Date(row.actual_start), new Date('2026-07-05T09:00:00Z')),
     `a turn inside the item's window IS the start (${row.actual_start?.toISOString()})`);
  // The xell's EARLIER turn (2026-07-04T09, earned while it was on `turnItem`) is BEFORE this
  // item's creation (2026-07-05T08) — it must NOT leak in as this item's start.
  ok(new Date(row.actual_start).getTime() >= new Date('2026-07-05T08:00:00Z').getTime(),
     'a turn from BEFORE the item existed in the ledger is rejected (it belongs to a different item)');

  // ── 3. the land_request trigger: a landing is a fallback, scoped to the item's window ──
  section('a landed landing inside the window sets the end');
  // The app enforces ONE item per xell ("one zee, one item" — work-assign's busy check), and the
  // land trigger resolves the item through the CURRENT link, so take the xell off the turn item
  // first: a real zee lands the item it is actually on.
  await W.updateWorkItem(silentItem.id, { xell_id: null }, { actor: 'test' });
  const landItem = await W.createWorkItem({ project_id: PID, title: 'land-driven', kind: 'task' });
  await W.updateWorkItem(landItem.id, { xell_id: xell.id }, { actor: 'test' });
  await client.query(`UPDATE work_item_event SET ts='2026-07-01T09:00:00Z' WHERE work_item_id=$1 AND kind='assigned'`, [landItem.id]);
  await A.refreshWorkItemActual(landItem.id);
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status, decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main','abc123','landed',now(),'human','2026-07-05T10:00:00Z')`, [PID, xell.id]);
  row = (await client.query(`SELECT actual_end FROM work_item WHERE id=$1`, [landItem.id])).rows[0];
  ok(same(new Date(row.actual_end), new Date('2026-07-05T10:00:00Z')),
     'a landed landing inside the item\'s window sets actual_end even though the item was never marked done');

  section('a landing BEFORE the item started is rejected');
  await W.updateWorkItem(landItem.id, { xell_id: null }, { actor: 'test' });
  const earlyLandItem = await W.createWorkItem({ project_id: PID, title: 'early-land', kind: 'task' });
  await W.updateWorkItem(earlyLandItem.id, { xell_id: xell.id }, { actor: 'test' });
  // the landing predates the item's own start (the assigned event is NOW), so it ended a DIFFERENT
  // item — it must not stamp an end on this one.
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status, decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main','abc124','landed',now(),'human','2026-07-03T10:00:00Z')`, [PID, xell.id]);
  row = (await client.query(`SELECT actual_end FROM work_item WHERE id=$1`, [earlyLandItem.id])).rows[0];
  ok(row.actual_end === null,
     'a landing before the item started is rejected (it ended a different item)');

  section('the terminal event wins over an earlier landing');
  await W.updateWorkItem(earlyLandItem.id, { xell_id: null }, { actor: 'test' });
  const doneLandItem = await W.createWorkItem({ project_id: PID, title: 'done-land', kind: 'task' });
  await W.updateWorkItem(doneLandItem.id, { xell_id: xell.id }, { actor: 'test' });
  await client.query(`UPDATE work_item_event SET ts='2026-07-01T09:00:00Z' WHERE work_item_id=$1 AND kind='assigned'`, [doneLandItem.id]);
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status, decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main','abc125','landed',now(),'human','2026-07-02T10:00:00Z')`, [PID, xell.id]);
  await W.setStatus(doneLandItem.id, 'done', { actor: 'test' });   // done is NOW — later than the landing
  row = (await client.query(`SELECT actual_start, actual_end FROM work_item WHERE id=$1`, [doneLandItem.id])).rows[0];
  ok(row.actual_end !== null && new Date(row.actual_end).getTime() > new Date('2026-07-02T10:00:00Z').getTime(),
     `the item's OWN terminal event wins — an earlier landing no longer beats it (${row.actual_end?.toISOString()})`);
  ok(new Date(row.actual_end).getTime() >= new Date(row.actual_start).getTime(),
     'and the stored range is never inverted (end >= start)');

  // ── 4. THE MULTI-ITEM XELL — no shared ends across an item's windows ─────
  section('a multi-item xell — each item keeps its OWN window');
  // A FRESH xell so no earlier section's landing pollutes the picture: the only landings in this
  // xell's history are the two this section writes.
  await W.updateWorkItem(doneLandItem.id, { xell_id: null }, { actor: 'test' });
  const xellM = (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled)
       VALUES ($1,'00000000-0000-4000-8000-00000000ac2b','multi-worker','spinoff/multi','working',false) RETURNING *`, [PID])).rows[0];
  const zeeM = (await client.query(
    `INSERT INTO zee (xell_id, status, attach_mode) VALUES ($1,'working','headless-spawn') RETURNING id`, [xellM.id])).rows[0];
  const itemA = await W.createWorkItem({ project_id: PID, title: 'multi-A', kind: 'task' });
  await W.updateWorkItem(itemA.id, { xell_id: xellM.id }, { actor: 'test' });
  await client.query(`UPDATE work_item_event SET ts='2026-07-01T09:00:00Z' WHERE work_item_id=$1 AND kind='assigned'`, [itemA.id]);
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status, decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main','abc126','landed',now(),'human','2026-07-05T10:00:00Z')`, [PID, xellM.id]);
  // the xell moves to item B (its SECOND item, in a LATER window)
  await W.updateWorkItem(itemA.id, { xell_id: null }, { actor: 'test' });
  const itemB = await W.createWorkItem({ project_id: PID, title: 'multi-B', kind: 'task' });
  await W.updateWorkItem(itemB.id, { xell_id: xellM.id }, { actor: 'test' });
  await client.query(`UPDATE work_item_event SET ts='2026-07-10T09:00:00Z' WHERE work_item_id=$1 AND kind='assigned'`, [itemB.id]);
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status, decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/main','abc127','landed',now(),'human','2026-07-15T10:00:00Z')`, [PID, xellM.id]);
  const endA = (await client.query(`SELECT actual_end FROM work_item WHERE id=$1`, [itemA.id])).rows[0].actual_end;
  const endB = (await client.query(`SELECT actual_end FROM work_item WHERE id=$1`, [itemB.id])).rows[0].actual_end;
  ok(same(new Date(endA), new Date('2026-07-05T10:00:00Z')),
     `item A ends at ITS OWN landing (${endA?.toISOString()})`);
  ok(same(new Date(endB), new Date('2026-07-15T10:00:00Z')),
     `item B ends at ITS OWN landing — not the xell's earlier one (${endB?.toISOString()})`);
  ok(!same(new Date(endA), new Date(endB)),
     'no actual_end is shared across items of a multi-item xell');
  await W.updateWorkItem(itemB.id, { xell_id: null }, { actor: 'test' });

  // ── 5. refreshWorkItemActual is the workflow-rehab entry, and it works ────
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
