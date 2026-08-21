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
//   3. a held approval is NEVER silently lost: after the refusal it is still queryable with its
//      approver (decided_by) and timestamp (decided_at);
//   4. the gate (STRICTER than a fresh approval): an idle xell that still holds UNLANDED commits or
//      DIRTY files is NOT applied — the held approval stays held, with a legible reason;
//   5. the manager is told ONCE at hold time and ONCE at apply time — never per tick.
//
// Isolated throwaway project in the real meta DB; PROVISION_MODE=simulate so the reap retires rows
// and touches no machine. Everything it creates is torn down in a finally, whatever happens.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

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

  // A real repo: the main branch + one shared worktree, so the diff gate can measure unlanded/dirty
  // work against something that actually exists (simulate never touches a machine, but git reads do).
  const tmp = mkdtempSync(join(tmpdir(), 'heldreap-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const mainHead = git(repo, 'rev-parse', 'HEAD');
  const wtBusy = join(tmp, 'wt-busy');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/hdbusy', wtBusy, 'master');
  const wtDirty = join(tmp, 'wt-dirty');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/hddirty', wtDirty, 'master');

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'heldreap-test',$2,'master','heldreaptest','postgres')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XID, PID]);

  const mkXell = async (slug, extra = {}) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled, zee_type, manager_xell_id, worktree_path, head_commit)
       VALUES ($1,$2,$3,$4,'working',false,$5,$6,$7,$8) RETURNING *`,
    [PID, XID, slug, `spinoff/${slug}`, extra.zee_type || 'worker', extra.manager || null,
     extra.worktree || null, extra.head || mainHead])).rows[0];
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
  const busy = await mkXell('hdbusy', { manager: mgr.id, worktree: wtBusy });   // genuinely MID-TURN
  await mkZee(busy, 'working');
  await mkTask(busy);
  // Evidence at approval time: the busy worker has LANDED work on master — clean, so a close is safe.
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, ref, status, new_sha, decided_at, decided_by, landed_at)
       VALUES ($1,$2,'refs/heads/master','landed',$3,now(),'test@human',now())`, [PID, busy.id, mainHead]);

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
  ok(heldRow.decided_at != null, '…and the timestamp of the approval is preserved (never silently lost)');
  ok(await xellStatus(busy.id) === 'working', 'and the busy xell is untouched');
  const heldBox = await inboxFor(mgr.id);
  ok(heldBox.filter((m) => /HELD/.test(m.body) && /hdbusy/.test(m.body)).length === 1,
     'the manager is told ONCE at hold time — "the decision is HELD" (1 message, not per retry)');

  // ── 2. a re-check while the turn is still in flight stays HELD ─────────────
  // This is the manager's live repro (message 16:41): a manager speaking to a finished zee RESUMES it
  // (idle → working, TKT-57), so the teardown reads 'working' and the ACTIVE guard refuses. The held
  // intent must survive that flicker — for as long as ANYONE speaks to it — and apply the moment the
  // turn actually ends. Not a single retry: PERSIST until it executes or a human withdraws it.
  console.log('\n── still mid-turn: the reaper holds ──');
  // Deliver the resume itself: a manager's message is what flips a finished zee back to working.
  await client.query(
    `INSERT INTO zee_message (project_id, from_xell_id, to_xell_id, body, kind, delivered)
       VALUES ($1,$2,$3,'status check?','message',true)`, [PID, mgr.id, busy.id]);
  const stillTick = await heldDoneTick();
  ok(stillTick.scanned === 1 && stillTick.applied === 0,
     `a sweep while the turn is in flight scans it and applies nothing (scanned=${stillTick.scanned}, applied=${stillTick.applied})`);
  ok((await rowOf(sug.suggestion.id)).status === 'approved-held',
     'the row is STILL approved-held after the resume — the intent was NOT lost');
  ok((await rowOf(sug.suggestion.id)).decided_by === 'test@human',
     '…and the approver survives the flicker (the decision was not reverted or dropped)');
  ok(await xellStatus(busy.id) === 'working', 'the worker is untouched and still working');
  // A SECOND flicker — the xell bounces idle→working→working: still held, still not lost.
  const stillTick2 = await heldDoneTick();
  ok(stillTick2.applied === 0 && (await rowOf(sug.suggestion.id)).status === 'approved-held',
     'a second sweep over the resumed turn also holds — the intent PERSISTS across flickers');
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
  ok(doneRow.result?.applied_by === 'reaper@queenzee' && doneRow.decided_by === 'test@human',
     '…applied AUTOMATICALLY by the reaper — nobody re-approved; the human approved exactly once');
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

  // ── 5. the gate: an IDLE xell with UNLANDED work is NOT applied ─────────────
  // A second worker, approved mid-turn, whose turn ends but which STILL holds unlanded commits or
  // dirty files. The reap's ACTIVE guard would no longer refuse (it is idle), so the GATE must.
  console.log('\n── idle but UNLANDED: the gate holds ──');
  const wDirty = await mkXell('hddirty', { manager: mgr.id, worktree: wtDirty });
  await mkZee(wDirty, 'working');
  await mkTask(wDirty);
  const dirtySug = await suggestDone({ manager: mgr, target: wDirty, reason: 'finished?' });
  await inboxFor(mgr.id);   // drain
  const dirtyDecided = await decideDoneSuggestion(dirtySug.suggestion.id, 'approved', 'test@human');
  ok(dirtyDecided.refused === true && dirtyDecided.held === true,
     'the human approves a MID-TURN xell → HELD');
  await client.query(`UPDATE zee SET status='idle', last_stop_reason='end_turn' WHERE xell_id=$1`, [wDirty.id]);
  // Now the worktree holds a REAL UNLANDED COMMIT — the branch is ahead of master, but nothing landed.
  writeFileSync(join(wtDirty, 'unlanded.txt'), 'not on master yet\n');
  git(wtDirty, 'add', '-A'); git(wtDirty, 'commit', '-qm', 'unlanded work');
  const dirtyTick = await heldDoneTick();
  ok(dirtyTick.scanned === 1 && dirtyTick.applied === 0,
     `a sweep over an idle-but-unlanded xell applies NOTHING (scanned=${dirtyTick.scanned}, applied=${dirtyTick.applied})`);
  const dirtyRow = await rowOf(dirtySug.suggestion.id);
  ok(dirtyRow.status === 'approved-held',
     'the row is STILL approved-held — the approval was NOT applied over unlanded work');
  ok(dirtyRow.result?.gate?.clean === false && /unlanded commit/.test(dirtyRow.result?.gate?.reason || ''),
     `…and the reason it stayed held is legible (unlanded commits): "${dirtyRow.result?.gate?.reason}"`);
  ok(await xellStatus(wDirty.id) !== 'retired', 'and the dirty xell is NOT retired');

  // ── 6. evidence captured AT APPROVAL TIME is on the held row ───────────────
  console.log('\n── approval-time evidence ──');
  // The busy worker was approved mid-turn while CLEAN and had LANDED work. Its held row must carry
  // that evidence: why the close was safe, even though the apply is still waiting on the turn.
  ok(heldRow.result?.evidence?.clean === true,
     'the held row records that the xell was CLEAN at approval time');
  ok(heldRow.result?.evidence?.landed?.count >= 1 && heldRow.result?.evidence?.landed?.last_sha,
     '…and what had landed (the last sha on master)');
  ok(heldRow.result?.evidence?.ahead === 0 && heldRow.result?.evidence?.dirty === 0,
     '…with zero unlanded and zero dirty at that moment');
  ok(heldRow.result?.evidence?.at != null, '…stamped with when the evidence was taken');

  // ── 7. the crew view is LEGIBLE: `zee zees` says APPROVED & HELD, not "awaiting a human" ──
  console.log('\n── crew-view legibility ──');
  const { crewFor } = await import('../server/src/lib/managers.js');
  const crew = await crewFor(mgr.id);
  const dirtyCrew = crew.find((c) => c.slug === 'hddirty');
  ok(dirtyCrew?.done_held === true,
     'the crew row for a held approval carries done_held:true (it is decided, not awaiting a human)');
  ok(/APPROVED and HELD/.test(dirtyCrew.waiting_on_human.join('; ')),
     '…and zee zees says "APPROVED and HELD" with the legible reason');
  ok(/1 unlanded commit/.test(dirtyCrew.waiting_on_human.join('; ')),
     '…naming exactly what it waits for (the unlanded commits)');
  const doneHeldText = dirtyCrew.waiting_on_human.join('; ');
  ok(!/a human must confirm/.test(doneHeldText) && !/awaiting a human/.test(doneHeldText),
     '…and it does NOT say "a human must confirm" (the human already approved)');

  console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
} catch (err) {
  console.error('\nTEST ERROR:', err);
  fail++;
} finally {
  await cleanup();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await client.end().catch(() => {});
}
process.exit(fail ? 1 : 0);
