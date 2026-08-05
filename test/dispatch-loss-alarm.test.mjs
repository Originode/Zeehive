// A DISPATCH DESTROYED BEFORE ITS ZEE RAN MUST REACH WHOEVER DISPATCHED IT.
//
// THE SECOND HALF OF TKT-88-D6B4. Five dispatched tasks were torn down by the pool sweep in three
// minutes (2026-08-05T00:05:52–00:08:53Z) and the entire record was three log lines each, on a ring
// buffer nobody was watching. The dispatcher was never told: the hexagon simply vanished, and a
// human retried blind at least four times — each retry a fresh provision + warm cycle onto the same
// race. The race is now impossible (lib/xell-claim.js); this is the alarm for the day something
// else takes a dispatch out.
//
// WHAT IS ASSERTED, on real teardowns of throwaway xells (PROVISION_MODE=simulate, so the ROW
// retires and no machine is touched):
//   1. a MANAGER's worker, reaped by the queenzee before any zee ran → a message in the manager's
//      inbox, naming the xell, the job and the reason;
//   2. the same with no manager → an INCIDENT TICKET in the console, so a human sees a card rather
//      than a hexagon that quietly stopped existing;
//   3. a xell in which a zee actually RAN → nothing: how that turn ended belongs to the reviver;
//   4. a HUMAN's teardown ('task-done') → nothing: that is somebody's decision, made in front of
//      the console that shows it;
//   5. plain POOL STOCK trimmed away → nothing: nobody was waiting on it;
//   6. the rule itself is pure and reads the same off a table (decideDispatchLoss), including the
//      one case that decides everything — a zee row that is still 'spawning' with no session id is
//      a cage that was being built, i.e. nothing ran.
process.env.PROVISION_MODE = 'simulate';        // before any import: no machine may be touched

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { reapXell } = await import('../server/src/queenzee/reaper.js');
const { decideDispatchLoss, everRan, isQueenzeeDecided } = await import('../server/src/lib/dispatch-loss.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const tmp = mkdtempSync(join(tmpdir(), 'dloss-'));
let projId = null;
const madeTickets = [];

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`zt-dloss-${tag}`, join(tmp, 'repo')])).id;
  const xource = await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId]);
  const runtime = await one(`SELECT id FROM agent_runtime ORDER BY sort_order LIMIT 1`);

  // worktree_path points at nothing on disk: no despawn script can ever run against a real folder
  const mkXell = async (slug, { status = 'claimed', isPooled = false, managerId = null, zeeType = 'worker' } = {}) => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       manager_xell_id, zee_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [projId, xource.id, slug, `spinoff/${slug}`, join(tmp, `gone-${slug}`), status, isPooled, managerId, zeeType]);
  const mkTask = (xellId, text) => q(
    `INSERT INTO task (project_id, prompt_text, source, status, xell_id, assigned_at)
       VALUES ($1,$2,'dispatch','assigned',$3, now())`, [projId, text, xellId]);
  const inboxOf = (xellId) => q(
    `SELECT kind, body, from_slug FROM zee_message WHERE to_xell_id=$1 ORDER BY created_at DESC`, [xellId]);

  // ── 1. a MANAGER's worker, destroyed before it ran ───────────────────────────
  console.log('\n── a manager is told its dispatch never ran ──');
  const mgr = await mkXell(`crew-lead-${tag}`, { status: 'claimed', zeeType: 'manager' });
  const w = await mkXell(`fix-the-collect-step-${tag}`, { managerId: mgr.id });
  await mkTask(w.id, '# Self-heal a stale index.lock at the collect step\n\nmore text');
  const r1 = await reapXell(w.id, 'stale:no-worktree');
  ok(r1.ok === true, 'the reap itself still succeeds');
  ok(r1.dispatch_loss?.reported === true, 'the teardown reports that it raised the alarm');
  ok(r1.dispatch_loss?.to === 'manager', 'and that it went to the manager');
  const inbox = await inboxOf(mgr.id);
  ok(inbox.length === 1, "the manager has exactly one message in its inbox");
  ok(/DESTROYED BEFORE IT RAN/.test(inbox[0]?.body || ''), 'it leads with what happened');
  ok(inbox[0]?.body.includes(w.slug), 'it names the xell');
  ok(/Self-heal a stale index\.lock at the collect step/.test(inbox[0]?.body || ''),
     'it names the job that was lost');
  ok(/stale:no-worktree/.test(inbox[0]?.body || ''), 'and the reason the queenzee gave');
  ok(/Do not retry blind/.test(inbox[0]?.body || ''), 'and it says not to retry blind — the thing that cost four cycles');

  // ── 2. no manager → a card for a human ──────────────────────────────────────
  console.log('\n── with no manager, a human gets a card ──');
  const solo = await mkXell(`open-redirect-guard-${tag}`);
  await mkTask(solo.id, 'Harden the signin redirect');
  const r2 = await reapXell(solo.id, 'stale:no-worktree');
  ok(r2.dispatch_loss?.to === 'human', 'the alarm is addressed to a human');
  const t = await one(
    `SELECT id, number, title, body, kind, priority FROM ticket
       WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`, [projId]);
  if (t) madeTickets.push(t.id);
  ok(!!t && t.title.includes(solo.slug), 'a ticket is raised naming the xell');
  ok(t?.kind === 'incident' && t?.priority === 2, 'as a priority-2 incident');
  ok(/Harden the signin redirect/.test(t?.body || ''), 'carrying the job that was lost');

  // ── 3. a zee that actually ran is not this alarm's business ─────────────────
  console.log('\n── a xell whose zee ran is left to the reviver ──');
  const ran = await mkXell(`had-a-zee-${tag}`, { managerId: mgr.id });
  await mkTask(ran.id, 'something that started');
  await one(
    `INSERT INTO zee (xell_id, runtime_id, attach_mode, status, entrypoint, viewer_kind, claude_session_id)
       VALUES ($1,$2,'headless-spawn','errored','cxell-cli','ssh-terminal',$3) RETURNING id`,
    [ran.id, runtime.id, `sid-${tag}`]);
  const r3 = await reapXell(ran.id, 'stale:no-worktree');
  ok(r3.dispatch_loss === null, 'no alarm — a zee ran, and how its turn ended is the reviver\'s story');
  ok((await inboxOf(mgr.id)).length === 1, 'the manager got nothing new');

  // ── 4. a human's teardown is a decision, not a loss ─────────────────────────
  console.log('\n── a human marking it done raises nothing ──');
  const done = await mkXell(`human-said-done-${tag}`, { managerId: mgr.id });
  await mkTask(done.id, 'finished work');
  const r4 = await reapXell(done.id, 'task-done');
  ok(r4.dispatch_loss === null, "'task-done' is a human's call — no alarm");
  ok((await inboxOf(mgr.id)).length === 1, 'still nothing new in the manager inbox');

  // ── 5. pool stock is not a dispatch ─────────────────────────────────────────
  console.log('\n── trimming pool stock raises nothing ──');
  const stock = await mkXell(`calm-summit-${tag}`, { status: 'ready', isPooled: true });
  const r5 = await reapXell(stock.id, 'pool-surplus');
  ok(r5.dispatch_loss === null, 'a ready pooled xell is stock — nobody was waiting on it');
  ok((await one(`SELECT count(*)::int n FROM ticket WHERE project_id=$1`, [projId])).n === 1,
     'and no second ticket was raised');

  // ── 6. the rule, pure ───────────────────────────────────────────────────────
  console.log('\n── decideDispatchLoss, with no database in it ──');
  const base = { reason: 'stale:no-worktree', status: 'claimed', isPooled: false, zees: [], hasTask: true };
  ok(decideDispatchLoss(base).lost === true, 'dispatched + queenzee-decided + never ran → lost');
  ok(decideDispatchLoss({ ...base, managerXellId: 'm' }).to === 'manager', 'a manager is the recipient when there is one');
  ok(decideDispatchLoss(base).to === 'human', 'otherwise a human is');
  ok(decideDispatchLoss({ ...base, reason: 'human-cleanup' }).lost === false, 'a human reason is never a loss');
  ok(decideDispatchLoss({ ...base, status: 'ready', isPooled: true, hasTask: false }).lost === false,
     'pool stock is never a loss');
  ok(decideDispatchLoss({ ...base, zees: [{ status: 'spawning', claude_session_id: null }] }).lost === true,
     "a zee row still 'spawning' with no session is a cage being built — nothing ran");
  ok(decideDispatchLoss({ ...base, zees: [{ status: 'spawning', claude_session_id: 'abc' }] }).lost === false,
     'the same row WITH a session id means an agent existed');
  ok(decideDispatchLoss({ ...base, zees: [{ status: 'stopped', claude_session_id: null }] }).lost === false,
     'and any later status means it ran');
  ok(everRan([]) === false && everRan([{ status: 'working' }]) === true, 'everRan is the plain reading of it');
  ok(isQueenzeeDecided('stale:dirty') && isQueenzeeDecided('pool-surplus')
     && isQueenzeeDecided('stranded-teardown') && !isQueenzeeDecided('done-suggestion'),
     'the queenzee-decided reasons are exactly the automatic ones');
} finally {
  if (projId) {
    for (const id of madeTickets) await q(`DELETE FROM ticket WHERE id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM ticket WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM zee_message WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM zee WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
    await q(`DELETE FROM task WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM container WHERE owner_xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
    await q(`UPDATE xell SET manager_xell_id=NULL WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  rmSync(tmp, { recursive: true, force: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
