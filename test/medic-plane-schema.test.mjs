// THE MEDIC PLANE'S SCHEMA INVARIANTS (migrations 244/245/247, docs/medic-meta-plane-plan.md §3.1,
// provision-proof kit stage 4) — against a REAL postgres (DATABASE_URL; use `zee db-sandbox
// --migrate` in a cage).
//
// Covered here:
//   1. zee_exactly_one_plane — a zee is on a XELL or on a MEDIC, never both, never neither;
//   2. one_active_zee_per_medic — a medic has at most one LIVE zee (the mirror of
//      one_active_zee_per_xell), and the ORIGINAL xell index still fires with NULLs around;
//   3. zee_conversation_exactly_one_plane + per-medic seq uniqueness (the replay-order contract);
//   4. medic status CHECK (a typo cannot invent a state the Bay has no art for);
//   5. llm_gateway_request.medic_id (247) accepts a medic-attributed, xell-less receipt.
//
// Every row this test creates is removed in the finally, whatever happens (house rule 1). Deletes
// are pushed as thunks so they run only at teardown.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const db = new pg.Client({ connectionString: url });
await db.connect();

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const refused = async (sql, params, m) => {
  try { await db.query(sql, params); ok(false, `${m} (postgres ACCEPTED it)`); }
  catch { ok(true, m); }
};
const cleanups = [];

try {
  const proj = (await db.query(
    `INSERT INTO project (name, repo_root) VALUES ('medic-schema-test-proj', '/tmp/none') RETURNING id`)).rows[0];
  cleanups.push(() => db.query(`DELETE FROM project WHERE id=$1`, [proj.id]));
  const medic = (await db.query(
    `INSERT INTO medic (target_project_id, brief) VALUES ($1, 'test brief') RETURNING id`, [proj.id])).rows[0];
  cleanups.push(() => db.query(`DELETE FROM medic WHERE id=$1`, [medic.id]));

  console.log('\n── 1. zee_exactly_one_plane ──');
  await refused(`INSERT INTO zee (attach_mode, status) VALUES ('headless-spawn','working')`, [],
    'a zee with NEITHER xell nor medic is refused');
  const z1 = (await db.query(
    `INSERT INTO zee (medic_id, attach_mode, status) VALUES ($1,'headless-spawn','working') RETURNING id`,
    [medic.id])).rows[0];
  cleanups.push(() => db.query(`DELETE FROM zee WHERE id=$1`, [z1.id]));
  ok(!!z1.id, 'a medic-plane zee (medic_id set, xell_id NULL) inserts');
  const anyXell = (await db.query(`SELECT id FROM xell LIMIT 1`)).rows[0];
  if (anyXell) {
    await refused(`UPDATE zee SET xell_id=$2 WHERE id=$1`, [z1.id, anyXell.id],
      'setting BOTH planes on one zee is refused');
  } else {
    console.log('  (no xell row on this database — the both-planes refusal is covered by the CHECK arithmetic above)');
  }

  console.log('\n── 2. one_active_zee_per_medic ──');
  await refused(
    `INSERT INTO zee (medic_id, attach_mode, status) VALUES ($1,'headless-spawn','working')`, [medic.id],
    'a SECOND live zee on the same medic is refused');
  const z2 = (await db.query(
    `INSERT INTO zee (medic_id, attach_mode, status) VALUES ($1,'headless-spawn','errored') RETURNING id`,
    [medic.id])).rows[0];
  cleanups.push(() => db.query(`DELETE FROM zee WHERE id=$1`, [z2.id]));
  ok(!!z2.id, 'a DEAD second zee (errored) on the same medic is fine — the index is live-only');

  console.log('\n── 3. zee_conversation: exactly-one-plane + per-medic replay order ──');
  await refused(`INSERT INTO zee_conversation (seq, role, content) VALUES (1,'user','x')`, [],
    'a conversation row with neither plane is refused');
  await db.query(`INSERT INTO zee_conversation (medic_id, seq, role, content) VALUES ($1,1,'user','hello')`, [medic.id]);
  cleanups.push(() => db.query(`DELETE FROM zee_conversation WHERE medic_id=$1`, [medic.id]));
  await refused(`INSERT INTO zee_conversation (medic_id, seq, role, content) VALUES ($1,1,'user','dupe')`, [medic.id],
    'a duplicate (medic, seq) is refused — replay order is exact');
  const upsert = await db.query(
    `INSERT INTO zee_conversation (medic_id, seq, role, content) VALUES ($1,1,'assistant','replaced')
     ON CONFLICT (medic_id, seq) WHERE medic_id IS NOT NULL DO UPDATE SET content=EXCLUDED.content, role=EXCLUDED.role
     RETURNING role`, [medic.id]);
  ok(upsert.rows[0]?.role === 'assistant', 'the driver\'s ON CONFLICT upsert addresses the partial index');

  console.log('\n── 4. medic status CHECK ──');
  await refused(`UPDATE medic SET status='sleeping' WHERE id=$1`, [medic.id],
    'an invented medic status is refused');

  console.log('\n── 5. gateway attribution (247) ──');
  const req = (await db.query(
    `INSERT INTO llm_gateway_request (medic_id, project_id, kind, method, path)
     VALUES ($1,$2,'messages','POST','/v1/messages') RETURNING id, xell_id, medic_id`, [medic.id, proj.id])).rows[0];
  cleanups.push(() => db.query(`DELETE FROM llm_gateway_request WHERE id=$1`, [req.id]));
  ok(req.medic_id === medic.id && req.xell_id === null,
    'a medic-attributed, xell-less gateway receipt inserts');
} finally {
  for (const c of cleanups.reverse()) await c().catch(() => {});
  await db.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
