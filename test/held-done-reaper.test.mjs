// THE HELD-DONE REAPER — an approval that landed mid-turn is applied the moment the turn ends.
//
// Ticket #75: a human (or the auto-done policy) approving a done suggestion whose target is mid-turn
// used to be REFUSED and the row reverted to 'pending' — the decision was discarded and nothing
// retried it when the turn ended. A finished xell then held its slot for 42 and 67 minutes in one
// crew. Now the decision is HELD ('approved-held') and the reaper loop (queenzee/done-held.js →
// applyHeldDoneSuggestion) re-attempts the apply every tick.
//
// WHAT THIS FENCES
//   1. a mid-turn approval is HELD, and a re-check while the turn is still in flight does NOT apply
//      it (the refusal is kept — a live turn is never torn down without force);
//   2. the moment the turn ends (zee status → 'idle'), the SAME apply path the human's click takes
//      closes the xell — no human needed a second time, and the row is finalized 'approved';
//   3. the manager is told ONCE at hold time and ONCE at apply time — never per tick.
//
// Isolated throwaway project in the real meta DB; PROVISION_MODE=simulate so the reap retires rows
// and touches no machine. Everything it creates is torn down in a finally, whatever happens.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';   // never tear down a real machine
process.env.PRODRO_MODE = 'simulate';
process.env.TKB_NOTIFY = '0';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-0000000e5111';
const XID = '00000000-0000-4000-8000-0000000e5222';

const cleanup = async () => {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
};

try {
  await client.connect();
  await cleanup();

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'heldreap-test','/nonexistent/heldreap','master','heldreaptest','postgres')`, [PID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XID, PID]);

  const mkXell = async (slug, extra = {}) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled, zee_type, manager_xell_id)
       VALUES ($1,$2,$3,$4,'working',false,$5,$6) RETURNING *`,
    [PID, XID, slug, `spinoff/${slug}`, extra.zee_type || 'worker', extra.manager || null])).rows[0];
  const mkZee = async (xell, status) => (await client.query(
    `INSERT INTO zee (xell_id, attach_mode, status, kind, entrypoint, cli_active, monitor_source,
                      last_monitor_at, last_event_at, last_stop_reason, viewer_kind)
       VALUES ($1,'headless-spawn',$2,'cxell','cxell-cli',true,'cxell-pgrep',now(),now(),$3,'none')
     RETURNING *`,
    [xell.id, status, status === 'idle' ? 'end_turn' : null])).rows[0];
  const mkTask = async (xell) => (await client.query(
    `INSERT INTO task (project_id, xell_id, prompt_text, status) VALUES ($1,$2,'do the thing','working')
     RETURNING *`, [PID, xell.id])).rows[0];

  const mgr = await mkXell('hdmgr', { zee_type: 'manager' });
  const busy = await mkXell('hdbusy', { manager: mgr.id });   // genuinely MID-TURN
  await mkZee(busy, 'working');
  await mkTask(busy);

  const { suggestDone, decideDoneSuggestion, inboxFor } = await import('../server/src/lib/managers.js');
  const { heldDoneTick } = await import('../server/src/queenzee/done-held.js');
  const rowOf = async (id) => (await client.query(`SELECT * FROM done_suggestion WHERE id=$1`, [id])).rows[0];
  const xellStatus = async (id) => (await client.query(`SELECT status FROM xell WHERE id=$1`, [id])).rows[0].status;

  // ── 1. an approval that lands mid-turn is HELD ─────────────────────────────
  console.log('\n── hold the decision ──');
  const sug = await suggestDone({ manager: mgr, target: busy, reason: 'looks finished to me' });
  ok(sug.suggestion.status === 'pending', 'the manager raises a done suggestion');
  await inboxFor(mgr.id);  // drain, so the count below is only what THIS sequence produced

  const decided = await decideDoneSuggestion(sug.suggestion.id, 'approved', 'test@human');
  ok(decided.refused === true && decided.held === true,
     'the human approves a MID-TURN xell → refused and HELD, not discarded');
  const heldRow = await rowOf(sug.suggestion.id);
  ok(heldRow.status === 'approved-held' && heldRow.decided_by === 'test@human',
     'the row is approved-held and the decision is preserved (decided_by kept)');
  ok(await xellStatus(busy.id) === 'working', 'and the busy xell is untouched');
  const heldBox = await inboxFor(mgr.id);
  ok(heldBox.filter((m) => /HELD/.test(m.body) && /hdbusy/.test(m.body)).length === 1,
     'the manager is told ONCE at hold time — "the decision is HELD" (1 message, not per retry)');

  // ── 2. a re-check while the turn is still in flight stays HELD ─────────────
  console.log('\n── still mid-turn: the reaper holds ──');
  const stillTick = await heldDoneTick();
  ok(stillTick.scanned === 1 && stillTick.applied === 0,
     `a sweep while the turn is in flight scans it and applies nothing (scanned=${stillTick.scanned}, applied=${stillTick.applied})`);
  ok((await rowOf(sug.suggestion.id)).status === 'approved-held',
     'the row is STILL approved-held — the refusal is kept, no live turn torn down');
  ok(await xellStatus(busy.id) === 'working', 'the worker is untouched and still working');
  const boxAfterHoldTick = await inboxFor(mgr.id);
  ok(boxAfterHoldTick.length === 0, 'and NO new message from the re-check — told once at hold time, not per tick');

  // ── 3. the turn ends → the same apply path closes it, no human needed ───────
  console.log('\n── the turn ends: the reaper applies the held decision ──');
  await client.query(`UPDATE zee SET status='idle', last_stop_reason='end_turn' WHERE xell_id=$1`, [busy.id]);
  const applyTick = await heldDoneTick();
  ok(applyTick.scanned === 1 && applyTick.applied === 1,
     `the sweep after the turn ends APPLIES the held approval (scanned=${applyTick.scanned}, applied=${applyTick.applied})`);
  const doneRow = await rowOf(sug.suggestion.id);
  ok(doneRow.status === 'approved' && doneRow.result?.ok === true,
     'the row is finalized approved with the apply result recorded');
  ok(await xellStatus(busy.id) === 'retired', 'the xell is actually retired');
  ok((await client.query(`SELECT status FROM task WHERE xell_id=$1`, [busy.id])).rows[0].status === 'done',
     'and its task is marked done');
  ok((await client.query(
    `SELECT count(*) FROM done_suggestion WHERE id=$1 AND dismissed_at IS NULL`, [sug.suggestion.id]))
    .rows[0].count === '1', 'the finalized card is still there for the audit trail');

  // ── 4. the manager is told exactly twice: once HELD, once APPLIED ───────────
  const box = await inboxFor(mgr.id);
  ok(box.filter((m) => /closed automatically/.test(m.body) && /hdbusy/.test(m.body)).length === 1,
     'the apply sweep sends exactly ONE "closed automatically" message — not one per tick');
  ok(box.filter((m) => /HELD/.test(m.body)).length === 0,
     'and no duplicate HELD message from the apply sweep (that was already delivered once)');

  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
} catch (err) {
  console.error('\nTEST ERROR:', err);
  fail++;
} finally {
  await cleanup();
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);
