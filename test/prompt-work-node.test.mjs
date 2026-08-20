// ANY NEW PROMPT IS A WORK_NODE — integration test for lib/prompt-work-node.js.
//
// Stands up an ISOLATED throwaway project in the real meta DB (no agent is ever spawned; the
// module under test runs AFTER a spawn, on ids alone) and asserts the dispatch → card contract:
//
//   1. a free prompt cuts a fresh task item under the PROJECT ROOT, with the xell assigned
//      (work_item.xell_id, status 'assigned') — and the dual-write created its work_node, hung
//      under the root item's node;
//   2. a prompt dispatched FROM a honeycomb context (parent_work_item) hangs under THAT node;
//   3. a dispatch that already names its card (work_item_id — deployWorkItem / `zee assign`)
//      gets NO second card;
//   4. a re-dispatch into a xell already carrying an OPEN item returns that item (no duplicate);
//   5. a bad/foreign context is ADVISORY: the card still lands, under the project root;
//   6. the title comes from the explicit title, else the prompt's first non-empty line.
//
// Everything it creates is torn down in a finally (house rule #1: no test data). If the work
// tracker schema (058) is absent the suite SKIPS LOUDLY.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-00000000f311';   // this test's project
const FID = '00000000-0000-4000-8000-00000000f312';   // a FOREIGN project (bad-context case)
const XO  = '00000000-0000-4000-8000-00000000f321';
const XOF = '00000000-0000-4000-8000-00000000f322';

async function cleanup() {
  try { await client.query('ROLLBACK'); } catch { /* not in a transaction */ }
  for (const sql of [
    `DELETE FROM work_item_event WHERE work_item_id IN (SELECT id FROM work_item WHERE project_id IN ($1,$2))`,
    `DELETE FROM work_item WHERE project_id IN ($1,$2)`,
  ]) { try { await client.query(sql, [PID, FID]); } catch { /* no such table */ } }
  try { await client.query(`DELETE FROM project WHERE id IN ($1,$2)`, [PID, FID]); } catch { /* */ }
}

await client.connect();
const haveSchema = (await client.query(
  `SELECT to_regclass('public.work_item') IS NOT NULL AS yes`)).rows[0].yes;
if (!haveSchema) {
  console.error('\n  ⚠ SKIPPED — no `work_item` table here (db/migrations/058 not applied). Migrate, re-run.');
  await client.end();
  process.exit(0);
}

try {
  await cleanup();

  // ── fixture: two projects, three xells, in ONE transaction ────────────────
  await client.query('BEGIN');
  for (const [id, name, dbn] of [[PID, 'promptnode-test', 'pntest'], [FID, 'promptnode-foreign', 'pnftest']]) {
    await client.query(
      `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
         VALUES ($1,$2,'/tmp/promptnode-nowhere','master',$3,'postgres')`, [id, name, dbn]);
  }
  await client.query(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0),($2,0)`, [PID, FID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master'),($3,$4,'master')`,
    [XO, PID, XOF, FID]);
  const mkXell = async (slug) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,'working',false,'worker') RETURNING *`,
    [PID, XO, slug, `spinoff/${slug}`, `/tmp/pn-${slug}`])).rows[0];
  const x1 = await mkXell('pn-one');
  const x2 = await mkXell('pn-two');
  const x3 = await mkXell('pn-three');
  await client.query('COMMIT');

  const { ensurePromptWorkItem } = await import('../server/src/lib/prompt-work-node.js');
  const { projectRoot, getWorkItem, createWorkItem } = await import('../server/src/lib/work-items.js');
  const root = await projectRoot(PID);
  ok(!!root, 'the project has its root work item (058 trigger)');

  const nodeOf = async (itemId) => (await client.query(
    `SELECT wn.id, wn.parent_id, p.stable_key AS parent_key
       FROM work_node wn LEFT JOIN work_node p ON p.id = wn.parent_id
      WHERE wn.stable_key = 'work_item:' || $1::text`, [itemId])).rows[0] || null;

  // ── 1. a free prompt cuts a card under the ROOT, xell assigned ────────────
  const a = await ensurePromptWorkItem({ projectId: PID, xellId: x1.id,
    title: 'fix the flaky build', prompt: 'fix the flaky build\n\nlonger brief here' });
  ok(!!a?.id, 'a free prompt cut a work item');
  const aRow = await getWorkItem(a.id);
  ok(aRow.parent_id === root.id, 'it hangs under the project root');
  ok(aRow.xell_id === x1.id, 'the dispatched xell is assigned to it');
  ok(aRow.status === 'assigned', `and the card starts life 'assigned' (${aRow.status})`);
  ok(aRow.title === 'fix the flaky build', 'the explicit title names the card');
  const aNode = await nodeOf(a.id);
  ok(!!aNode, 'the dual-write created its work_node');
  ok(aNode.parent_key === `work_item:${root.id}`, "and the node hangs under the root item's node");

  // ── 2. a prompt from a honeycomb CONTEXT hangs under that node ────────────
  const b = await ensurePromptWorkItem({ projectId: PID, xellId: x2.id,
    parentWorkItem: a.id, prompt: 'a follow-up under the first card' });
  const bRow = await getWorkItem(b.id);
  ok(bRow.parent_id === a.id, 'parent_work_item makes the new card a CHILD of the context node');
  ok(bRow.title === 'a follow-up under the first card', 'no explicit title → the prompt\'s first line');
  const bNode = await nodeOf(b.id);
  ok(bNode?.parent_key === `work_item:${a.id}`, "and its work_node hangs under the context's node");

  // ── 3. a dispatch already FOR a card cuts nothing ─────────────────────────
  const before = (await client.query(`SELECT count(*)::int AS n FROM work_item WHERE project_id=$1`, [PID])).rows[0].n;
  const c = await ensurePromptWorkItem({ projectId: PID, xellId: x3.id,
    workItemId: b.id, prompt: 'deployWorkItem owns this card' });
  const after = (await client.query(`SELECT count(*)::int AS n FROM work_item WHERE project_id=$1`, [PID])).rows[0].n;
  ok(c === null && after === before, 'work_item_id set → no card is cut (the caller assigns its own)');

  // ── 4. a re-dispatch into a xell with an OPEN card keeps that card ────────
  const d = await ensurePromptWorkItem({ projectId: PID, xellId: x1.id, prompt: 'swap / re-dispatch' });
  ok(d?.id === a.id && d.existing === true, 'a xell already carrying an open item gets THAT item back');
  const after2 = (await client.query(`SELECT count(*)::int AS n FROM work_item WHERE project_id=$1`, [PID])).rows[0].n;
  ok(after2 === after, 'and no duplicate was cut');

  // ── 5. a bad / foreign context is advisory — the card still lands ─────────
  const foreignRoot = await projectRoot(FID);
  const e1 = await ensurePromptWorkItem({ projectId: PID, xellId: x3.id,
    parentWorkItem: foreignRoot.id, prompt: 'foreign context prompt' });
  ok((await getWorkItem(e1.id)).parent_id === root.id,
     'a context in ANOTHER project falls back to this project\'s root');
  // close it so the next call does not just return it
  await client.query(`UPDATE work_item SET status='done' WHERE id=$1`, [e1.id]);
  const e2 = await ensurePromptWorkItem({ projectId: PID, xellId: x3.id,
    parentWorkItem: 'not-a-uuid', prompt: 'garbage context prompt' });
  ok((await getWorkItem(e2.id)).parent_id === root.id, 'a garbage context id falls back to the root too');

  // ── 6. a CLOSED card on the xell does not block a fresh one ───────────────
  ok(e2.id !== e1.id, 'a xell whose only card is done/cancelled gets a fresh card on the next prompt');

  console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ prompt → work_node: all green');
} finally {
  await cleanup();
  await client.end();
  // work-items.js keeps a pg pool open — let the process exit
  try { const { pool } = await import('../server/src/db/pool.js'); await pool.end(); } catch { /* */ }
}
process.exit(fail ? 1 : 0);
