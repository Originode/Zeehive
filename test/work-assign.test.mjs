// PUTTING A ZEE ON A WORK ITEM — integration test for part 3 of the work tracker.
//
// Stands up an ISOLATED throwaway project in the real meta DB (its own git repo, a plan of work
// items, a manager xell, worker xells, a production xell and a foreign project) and exercises the
// whole assignment layer WITHOUT SPAWNING A SINGLE AGENT:
//
//   1. assign: the link, the queued → assigned move, the ledger entry, the task stamp — and
//      idempotence, including the self-healing retry after a half-done assignment;
//   2. THE REFUSALS, which are the point: another project's xell, production, a MANAGER zee, a xell
//      already carrying an open item, a xell being torn down, an unknown item/xell — each with a
//      readable sentence and the right HTTP code;
//   3. unassign: the link goes, the STATUS STAYS (work that happened, happened);
//   4. candidates: the ready pool + free live workers, and nobody who would be refused;
//   5. deploy: the brief built FROM the item (ancestors, ticket, dates, extra), the assignment that
//      follows, and its refusals — with the dispatch path STUBBED, never a real zee;
//   6. worksync: a live hive status MOVES a card, and the fence holds — never to `done` (not even
//      from occ-done, which statusFromHive really does map there), never out of a terminal status,
//      never a queued card and never one nobody is on; a vanished zee clears the LINK only;
//   7. the cxell verbs' SCOPING: a worker may touch its OWN item and nothing else, a manager only
//      its own project — resolved from the caller's token, never from a parameter;
//   8. the manuals: migration 059 and the manager harness FILE say the same words (they are two
//      copies of one manual), it is idempotent, and it does not fire when a human has moved an
//      anchor. Plus the routes and the CLI actually carry the verbs.
//
// Everything it creates is torn down in a finally, whatever happens (HANDOFF house rule #1: no test
// data). If the work tracker's schema (058) is not present the whole suite SKIPS LOUDLY rather than
// pretending to pass.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';              // no desk pings from a test

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'workassign-'));
const PID = '00000000-0000-4000-8000-00000000e111';   // this test's project
const FID = '00000000-0000-4000-8000-00000000e112';   // a FOREIGN project (the cross-project refusal)

async function cleanup({ files = false } = {}) {
  // work_item cascades off project; the ledger cascades off work_item. Belt and braces anyway.
  for (const sql of [
    `DELETE FROM work_item_event WHERE work_item_id IN (SELECT id FROM work_item WHERE project_id IN ($1,$2))`,
    `DELETE FROM work_item WHERE project_id IN ($1,$2)`,
    `DELETE FROM ticket WHERE project_id IN ($1,$2)`,
  ]) { try { await client.query(sql, [PID, FID]); } catch { /* no such table yet */ } }
  try { await client.query(`DELETE FROM project WHERE id IN ($1,$2)`, [PID, FID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

await client.connect();
const haveSchema = (await client.query(
  `SELECT to_regclass('public.work_item') IS NOT NULL AS yes`)).rows[0].yes;
if (!haveSchema) {
  console.error('\n  ⚠ SKIPPED — this database has no `work_item` table, so part 1 (db/migrations/058)');
  console.error('    is not applied here. Nothing was asserted. Migrate, then re-run:');
  console.error('    DATABASE_URL=… node test/work-assign.test.mjs\n');
  await client.end();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

try {
  await cleanup();

  // ── a real repo + the fleet this plan is executed by ─────────────────────
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# work tracker test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  const XO = '00000000-0000-4000-8000-00000000e222';
  const XOF = '00000000-0000-4000-8000-00000000e223';
  for (const [id, name, dbn] of [[PID, 'workassign-test', 'watest'], [FID, 'workassign-foreign', 'wftest']]) {
    await client.query(
      `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
         VALUES ($1,$2,$3,'master',$4,'postgres')`, [id, name, repo, dbn]);
  }
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master'),($3,$4,'master')`,
    [XO, PID, XOF, FID]);

  const mkXell = async (project, xource, slug, status, extra = {}) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, is_production)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8) RETURNING *`,
    [project, xource, slug, `spinoff/${slug}`, join(tmp, slug), status,
     extra.zee_type || 'worker', !!extra.is_production])).rows[0];

  const worker = await mkXell(PID, XO, 'wa-worker', 'working');
  const spare = await mkXell(PID, XO, 'wa-spare', 'working');
  const pooled = await mkXell(PID, XO, 'wa-ready', 'ready');
  const dying = await mkXell(PID, XO, 'wa-dying', 'tearing-down');
  const manager = await mkXell(PID, XO, 'wa-mgr', 'working', { zee_type: 'manager' });
  const prodXell = await mkXell(PID, XO, 'wa-prod', 'working', { is_production: true });
  const foreign = await mkXell(FID, XOF, 'wa-foreign', 'working');
  await client.query(`UPDATE xell SET manager_xell_id=$1 WHERE id IN ($2,$3)`, [manager.id, worker.id, spare.id]);
  const reread = async (x) => (await client.query(`SELECT * FROM xell WHERE id=$1`, [x.id])).rows[0];

  // a live zee on the worker, and a task for it (assign stamps task.work_item_id)
  await client.query(
    `INSERT INTO zee (xell_id, status, model, attach_mode)
       VALUES ($1,'working','opus','headless-spawn') RETURNING *`, [worker.id]);
  const task = (await client.query(
    `INSERT INTO task (project_id, xell_id, prompt_text, status) VALUES ($1,$2,'do the thing','working') RETURNING *`,
    [PID, worker.id])).rows[0];

  const WA = await import('../server/src/lib/work-assign.js');
  const worksync = await import('../server/src/queenzee/worksync.js');
  const WS = await import('../server/src/lib/work-status.js');
  const { HIVE_STATUS } = await import('../server/src/lib/hive-status.js');
  const { createWorkItem, projectRoot, getWorkItem } = await import('../server/src/lib/work-items.js');

  // The plan: every project gets its ROOT item by trigger (058), so the test adds the branch below it.
  const root = await projectRoot(PID);
  ok(!!root && root.kind === 'project', 'the project has its root work item (created by 058, not by us)');
  const activity = await createWorkItem({ project_id: PID, parent_id: root.id, kind: 'activity',
    title: 'wa: an activity' });
  const item = await createWorkItem({ project_id: PID, parent_id: activity.id, kind: 'task',
    title: 'wa: the task', body: 'the leaf a zee actually executes' });
  const events = async (id, kind = null) => (await client.query(
    `SELECT kind, actor, from_status, to_status, detail FROM work_item_event
      WHERE work_item_id=$1 ${kind ? 'AND kind=$2' : ''} ORDER BY ts, id`,
    kind ? [id, kind] : [id])).rows;

  // ── 0. the fences are built from the REAL vocabulary ─────────────────────
  {
    const vocab = WS.workStatusVocabulary().statuses;
    const terminal = vocab.filter((s) => s.terminal).map((s) => s.key);
    ok(WA.TERMINAL.join() === terminal.join(),
       `work-assign's TERMINAL fence IS the vocabulary's terminal set (${WA.TERMINAL.join(', ')})`);
    ok(worksync.IN_FLIGHT.join() === 'assigned,working,blocked,review,shipping',
       `worksync's in-flight window is exactly the middle of the vocabulary (${worksync.IN_FLIGHT.join(', ')})`);
    ok(!worksync.IN_FLIGHT.some((s) => WA.TERMINAL.includes(s)) && !worksync.IN_FLIGHT.includes('queued'),
       'and it contains neither a terminal status nor the not-started one');
    // the hazard this fence exists for, stated as an assertion
    ok(WS.statusFromHive('occ-done') === 'done' && WS.statusFromHive('occ-doneRequest') === 'done',
       'statusFromHive DOES map occ-done / occ-doneRequest to `done` — which is exactly why the tick is fenced');
    const reachable = Object.keys(HIVE_STATUS).map(WS.statusFromHive).filter(Boolean);
    ok(reachable.some((s) => WA.TERMINAL.includes(s)) && !worksync.IN_FLIGHT.some((s) => WA.TERMINAL.includes(s)),
       'so a terminal status IS reachable from a hive key, and the tick is the thing that refuses to write it');
  }

  // ── 1. assign ────────────────────────────────────────────────────────────
  const assigned = await WA.assignWorkItem(item.id, { xell_id: worker.id, actor: 'test@human' });
  ok(assigned.ok && assigned.item.xell_id === worker.id, 'assign links the xell to the work item');
  ok(assigned.item.status === 'assigned', `queued → assigned (${assigned.item.status})`);
  ok(assigned.item.zee?.slug === 'wa-worker',
     "the item read model carries the zee CHIP the board card renders (slug + hive status)");
  const stamped = (await client.query(`SELECT work_item_id FROM task WHERE id=$1`, [task.id])).rows[0];
  ok(stamped.work_item_id === item.id, "the zee's newest task is stamped with the work item");
  const ev = await events(item.id);
  ok(ev.some((e) => e.kind === 'assigned' && e.actor === 'test@human'),
     "the ledger records kind:'assigned' and who did it");
  ok(ev.some((e) => e.kind === 'status' && e.from_status === 'queued' && e.to_status === 'assigned'),
     'and the status move with BOTH ends of it (part 1\'s event shape, not a second dialect)');

  const again = await WA.assignWorkItem(item.id, { xell_id: worker.id });
  ok(again.ok && again.already === true, 'assigning the same xell again is an idempotent no-op');
  ok((await events(item.id, 'assigned')).length === 1, 'and it does not write a second event');
  // self-healing: a half-done assignment (linked, never moved) is completed by a retry
  await client.query(`UPDATE work_item SET status='queued' WHERE id=$1`, [item.id]);
  const healed = await WA.assignWorkItem(item.id, { xell_id: worker.id, actor: 'test@human' });
  ok(healed.status_moved === true && healed.item.status === 'assigned',
     'a retry after a half-done assignment finishes the queued → assigned move (self-healing)');

  // ── 2. the refusals ──────────────────────────────────────────────────────
  const refusal = async (fn, re, what) => {
    const e = await caught(fn);
    ok(e && e.status === 409 && re.test(e.message), `${what} — 409: "${String(e?.message).slice(0, 70)}…"`);
  };
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: foreign.id }), /different project/i,
                "a xell from ANOTHER PROJECT cannot take an item");
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: prodXell.id }), /IS production/i,
                'PRODUCTION is not a worker');
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: manager.id }), /MANAGER/i,
                'a MANAGER zee cannot execute an item (it dispatches one that can)');
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: dying.id }), /torn down/i,
                'a xell being TORN DOWN cannot be handed work');
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: worker.id }), /already on an open work item/i,
                'a xell already carrying an open item is not free');
  const gone = await caught(() => WA.assignWorkItem('00000000-0000-4000-8000-0000000000ff', { xell_id: worker.id }));
  ok(gone?.status === 404, 'an unknown work item is 404, not 500');
  const noXell = await caught(() => WA.assignWorkItem(activity.id, { xell_id: '00000000-0000-4000-8000-0000000000fe' }));
  ok(noXell?.status === 404, 'an unknown xell is 404, not 500');
  const noArg = await caught(() => WA.assignWorkItem(activity.id, {}));
  ok(noArg?.status === 400 && /xell_id/.test(noArg.message), 'a missing xell_id is 400 with the reason');
  const notUuid = await caught(() => WA.getItem('banana'));
  ok(notUuid?.status === 400 && /not a valid work item id/.test(notUuid.message),
     "a malformed id is 400 in part 1's own words, not a postgres cast error");

  // ── 3. unassign keeps the status ─────────────────────────────────────────
  await client.query(`UPDATE work_item SET status='working' WHERE id=$1`, [item.id]);
  const un = await WA.unassignWorkItem(item.id, { actor: 'test@human' });
  ok(un.ok && un.item.xell_id === null, 'unassign clears the link');
  ok(un.item.status === 'working', 'and LEAVES the status alone (work that happened, happened)');
  ok((await client.query(`SELECT work_item_id FROM task WHERE id=$1`, [task.id])).rows[0].work_item_id === null,
     "the zee's task stamp is cleared too");
  ok((await events(item.id, 'assigned')).some((e) => e.detail?.unassigned === true),
     "it is in the ledger as an 'assigned' event saying it was cleared (no invented event kind)");
  ok((await WA.unassignWorkItem(item.id)).already === true, 'unassigning nothing is an idempotent no-op');

  // ── 4. candidates ────────────────────────────────────────────────────────
  {
    const c = await WA.candidatesFor(item.id);
    const slugs = c.candidates.map((x) => x.slug);
    ok(slugs.includes('wa-worker') && slugs.includes('wa-spare'), 'candidates offer live workers with no open item');
    ok(slugs.includes('wa-ready'), 'and the ready pool');
    ok(!slugs.includes('wa-mgr'), 'never a manager zee');
    ok(!slugs.includes('wa-prod'), 'never production');
    ok(!slugs.includes('wa-dying'), 'never one being torn down');
    ok(!slugs.includes('wa-foreign'), "never another project's xell");
    ok(c.candidates.every((x) => x.why), 'each candidate says WHY it is offered (a picker, not a uuid prompt)');
    await WA.assignWorkItem(activity.id, { xell_id: spare.id });
    ok(!(await WA.candidatesFor(item.id)).candidates.map((x) => x.slug).includes('wa-spare'),
       'a xell that assign would refuse is never offered in the first place');
    await WA.assignWorkItem(item.id, { xell_id: worker.id });
    ok(!(await WA.candidatesFor(item.id)).candidates.map((x) => x.slug).includes('wa-worker'),
       'nor is the xell already ON this item (it cannot "take" what it is already doing)');
    await WA.unassignWorkItem(item.id);
    await WA.unassignWorkItem(activity.id);
  }

  // ── 5. deploy (dispatch STUBBED — no agent is ever spawned) ──────────────
  {
    const ticket = (await client.query(
      `INSERT INTO ticket (project_id, title, body, kind) VALUES ($1,'the ticket','why this exists','feature')
       RETURNING *`, [PID])).rows[0];
    await client.query(`UPDATE work_item SET ticket_id=$2, due_on='2026-08-01' WHERE id=$1`, [item.id, ticket.id]);

    let seen = null;
    const stub = async ({ task: brief, title }) => { seen = { brief, title }; return { xell_id: spare.id, slug: spare.slug }; };
    const out = await WA.deployWorkItem(item.id, { task: 'and mind the dates', actor: 'test@human', dispatchFn: stub });
    ok(out.ok && out.xell.id === spare.id, 'deploy assigns the dispatched worker to the item');
    ok(/wa: the task/.test(seen.brief), 'the brief carries the item itself');
    ok(/wa: an activity/.test(seen.brief) && /YOUR item/.test(seen.brief),
       'and its ANCESTOR chain (the worker knows what it sits under)');
    ok(new RegExp(`#${ticket.number}`).test(seen.brief) && /why this exists/.test(seen.brief),
       `and the linked ticket (#${ticket.number}, with its body)`);
    ok(/due 2026-08-01/.test(seen.brief), 'and the dates it is actually held to');
    ok(/and mind the dates/.test(seen.brief), "and the deployer's extra instructions");
    ok(/zee work/.test(seen.brief) && /zee item/.test(seen.brief), 'and how to report progress');
    ok(/never marks your xell done/.test(seen.brief),
       'while saying plainly that reporting the item is NOT landing, shipping or being done');
    ok((await events(item.id, 'assigned')).some((e) => e.detail?.deployed === true),
       'the ledger records the deployment (an assigned event whose detail says it was deployed)');

    const twice = await caught(() => WA.deployWorkItem(item.id, { dispatchFn: stub }));
    ok(twice?.status === 409 && /already deployed/i.test(twice.message),
       'deploying onto an item that already has a live zee is refused (no second agent on one job)');
    await WA.unassignWorkItem(item.id);

    await client.query(`UPDATE work_item SET status='done' WHERE id=$1`, [item.id]);
    const finished = await caught(() => WA.deployWorkItem(item.id, { dispatchFn: stub }));
    ok(finished?.status === 409 && /done/.test(finished.message),
       'and deploying onto a FINISHED item is refused (a whole worker on work somebody ended)');
    await client.query(`UPDATE work_item SET status='queued' WHERE id=$1`, [item.id]);
  }

  // ── 6. worksync: the board moves itself, and the fence holds ─────────────
  {
    await WA.assignWorkItem(item.id, { xell_id: worker.id });

    const t1 = await worksync.workSyncTick();
    const after1 = (await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status;
    ok(after1 === WS.statusFromHive('occ-working'),
       `a working zee moves its card to '${WS.statusFromHive('occ-working')}' (got '${after1}', ${t1.moved} move(s))`);
    ok((await events(item.id, 'status')).some((e) => e.actor === 'queenzee' && e.to_status === after1),
       "each self-move is in the ledger with actor:'queenzee' (the board says it moved itself)");

    const land = (await client.query(
      `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status)
         VALUES ($1,$2,'refs/heads/master','deadbeef','pending') RETURNING *`, [PID, worker.id])).rows[0];
    await worksync.workSyncTick();
    const after2 = (await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status;
    ok(after2 === WS.statusFromHive('occ-landRequest'),
       `a held landing moves it to '${WS.statusFromHive('occ-landRequest')}' (got '${after2}') — the same signal the hexagon shows`);
    await client.query(`DELETE FROM land_request WHERE id=$1`, [land.id]);

    // THE FENCE: never OUT of a terminal status
    await client.query(`UPDATE work_item SET status='done' WHERE id=$1`, [item.id]);
    const evBefore = (await events(item.id)).length;
    await worksync.workSyncTick();
    ok((await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status === 'done',
       'the tick NEVER moves a card out of a terminal status');
    ok((await events(item.id)).length === evBefore, 'and writes no event pretending it considered it');

    // THE FENCE: never INTO one, even when the hive says 'done'
    await client.query(`UPDATE work_item SET status='working' WHERE id=$1`, [item.id]);
    await client.query(`UPDATE xell SET status='tearing-down' WHERE id=$1`, [worker.id]);
    await worksync.workSyncTick();
    const notDone = (await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status;
    ok(notDone === 'working',
       `a zee whose xell is being torn down (hive occ-done → statusFromHive 'done') does NOT finish the item (still '${notDone}')`);
    await client.query(`UPDATE xell SET status='working' WHERE id=$1`, [worker.id]);

    // THE FENCE: a QUEUED card is not started by a tick — assignment does that
    await client.query(`UPDATE work_item SET status='queued' WHERE id=$1`, [item.id]);
    await worksync.workSyncTick();
    ok((await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status === 'queued',
       'a queued card is left alone (starting work is assignment, not a tick)');
    await client.query(`UPDATE work_item SET status='working' WHERE id=$1`, [item.id]);

    // an item nobody is on
    const idle = (await client.query(`SELECT status FROM work_item WHERE id=$1`, [activity.id])).rows[0].status;
    await worksync.workSyncTick();
    ok((await client.query(`SELECT status FROM work_item WHERE id=$1`, [activity.id])).rows[0].status === idle,
       'an item with no zee on it is left alone (no fact, no move)');

    // the zee is GONE → clear the LINK, keep the status
    await client.query(`UPDATE work_item SET status='review' WHERE id=$1`, [item.id]);
    await client.query(`UPDATE xell SET status='retired' WHERE id=$1`, [worker.id]);
    const t3 = await worksync.workSyncTick();
    const orphan = (await client.query(`SELECT status, xell_id FROM work_item WHERE id=$1`, [item.id])).rows[0];
    ok(orphan.xell_id === null && orphan.status === 'review',
       `a retired zee clears the assignment and KEEPS the status (${t3.cleared} cleared)`);
    ok((await events(item.id, 'assigned')).some((e) => e.actor === 'queenzee' && e.detail?.unassigned === true),
       'with a ledger entry saying the queenzee did it, and why');
    await client.query(`UPDATE xell SET status='working' WHERE id=$1`, [worker.id]);
  }

  // ── 7. the cxell verbs are SCOPED from the caller, never a parameter ─────
  {
    const { selfWork, selfWorkAssign, selfWorkItem } = await import('../server/src/queenzee/self.js');
    const w = await reread(worker); const m = await reread(manager); const s = await reread(spare);
    await WA.assignWorkItem(item.id, { xell_id: w.id });
    await client.query(`UPDATE work_item SET status='assigned' WHERE id=$1`, [item.id]);

    const mine = await selfWork(w);
    ok(mine.ok && mine.item?.id === item.id, '`zee work` shows a worker the item it is executing');
    ok(mine.item.breadcrumb?.length === 2 && mine.item.ticket, 'with its ancestor chain and its ticket');
    const plan = await selfWork(m);
    ok(plan.ok && plan.count >= 3 && plan.items[0].kind === 'project',
       "`zee work` shows a MANAGER its project's plan in tree order, root first");
    ok(plan.items.some((i) => i.zee?.slug === 'wa-worker'), 'with the live zee on the item that has one');
    const board = await selfWork(m, { board: true });
    ok(board.items.every((i) => i.kind !== 'project'), '--board drops the project root (a root is not a card)');

    const nosy = await selfWork(w, { item: activity.id });
    ok(nosy.ok === false && /not the work item you are assigned to/.test(nosy.error),
       "a worker cannot read another item — not even one in its own project");
    const stranger = await selfWorkItem(s, { id: item.id, status: 'blocked' });
    ok(stranger.ok === false && /not your work item/.test(stranger.error),
       "a worker cannot report on somebody else's item (the id it supplied is refused)");
    ok((await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status === 'assigned',
       'and nothing was written when it tried');

    const report = await selfWorkItem(w, { status: 'working', progress: 40, note: 'digging in' });
    ok(report.ok && report.item.status === 'working' && report.item.progress === 40,
       'a worker reports its OWN item without naming it at all');
    const bad = await selfWorkItem(w, { progress: 400 });
    ok(bad.ok === false && /0-100/.test(bad.error), 'a nonsense progress is refused with the range');
    const nonsense = await selfWorkItem(w, { status: 'nearly' });
    ok(nonsense.ok === false && /unknown status/.test(nonsense.error),
       'and an unknown status is refused with the vocabulary');

    const done = await selfWorkItem(w, { status: 'done', note: 'work finished' });
    ok(done.ok && done.item.status === 'done', 'a worker MAY report its work done (a fact, not a gate)');
    const xellAfter = await reread(worker);
    ok(xellAfter.status !== 'awaiting-done',
       'and that does NOT propose its xell done — done/land/ship stay its own verbs and a human\'s gates');
    ok(!(await client.query(`SELECT count(*)::int n FROM land_request WHERE xell_id=$1`, [w.id])).rows[0].n,
       'nor does it land anything');
    const reopen = await selfWorkItem(w, { status: 'working' });
    ok(reopen.ok === false && /legal next statuses/.test(reopen.error),
       'and what it may do next comes from the VOCABULARY, not from a rule this file invented');
    await client.query(`UPDATE work_item SET status='working' WHERE id=$1`, [item.id]);

    const other = await createWorkItem({ project_id: FID, kind: 'task', title: "wa: somebody else's plan" });
    const notMine = await selfWork(m, { item: other.id });
    ok(notMine.ok === false && /another project/.test(notMine.error),
       "a manager cannot read another project's item");
    const mgrMove = await selfWorkItem(m, { id: activity.id, status: 'blocked', note: 'waiting on a human' });
    ok(mgrMove.ok && mgrMove.item.status === 'blocked', 'a manager may move a card in its own project');
    const workerAssign = await selfWorkAssign(w, { item: item.id, task: 'go' });
    ok(workerAssign.ok === false && /MANAGER verb/.test(workerAssign.error),
       '`zee assign` is refused for a worker, with the explanation (not a 404)');
    const noItem = await selfWorkAssign(m, {});
    ok(noItem.ok === false && /--item/.test(noItem.error), 'and it needs an item');
    const foreignAssign = await selfWorkAssign(m, { item: other.id, task: 'go' });
    ok(foreignAssign.ok === false && /another project/.test(foreignAssign.error),
       "and a manager cannot deploy onto another project's plan");
  }

  // ── 7b. the SSE payloads keep part 1's documented shape ─────────────────
  {
    const { bus } = await import('../server/src/lib/events.js');
    const seen = [];
    const listen = (e) => { if (e.type === 'work') seen.push(e.payload); };
    bus.on('event', listen);
    await WA.unassignWorkItem(item.id, { actor: 'test@human' });
    await WA.assignWorkItem(item.id, { xell_id: (await reread(worker)).id, actor: 'test@human' });
    await client.query(`UPDATE work_item SET status='assigned' WHERE id=$1`, [item.id]);
    await worksync.workSyncTick();
    bus.off('event', listen);
    ok(seen.length >= 3, `the work channel carried ${seen.length} events`);
    ok(seen.every((p) => p.kind && p.item && p.item.id),
       "every one is { kind, item } — the shape part 1's doc pins for 'assigned' and 'status'");
    ok(seen.every((p) => p.item.status_label && Array.isArray(p.item.next_statuses)),
       'and the item is SHAPED (labels + legal next statuses), not a raw row');
    ok(seen.some((p) => p.kind === 'status' && p.item.status === 'working'),
       'including the tick\'s own move — the console can patch a self-moving card without a refresh');
  }

  // ── 8. the manuals, the routes and the CLI ───────────────────────────────
  {
    const routes = readFileSync('server/src/api/routes.js', 'utf8');
    for (const r of ['/work-items/:id/assign', '/work-items/:id/deploy', '/work-items/:id/candidates',
                     '/xell/self/work', '/xell/self/work/assign', '/xell/self/work/item']) {
      ok(routes.includes(r), `routes.js serves ${r}`);
    }
    const cli = readFileSync('scripts/zee', 'utf8');
    for (const c of ["case 'work'", "case 'assign'", "case 'item'"]) ok(cli.includes(c), `the zee CLI has ${c}`);
    ok(/zee work \[--board\]/.test(cli) && /zee assign --item/.test(cli), 'and its usage text names them');

    // 059 and the manager harness FILE are two copies of ONE manual — they must say the same words.
    const sql = readFileSync('db/migrations/059_work_tracker_verbs.sql', 'utf8');
    const manualPath = 'harnesses/manager/memory/manager-zee-manual.md';
    const manual = readFileSync(manualPath, 'utf8');
    const decode = (s) => s.replace(/''/g, "'").replace(/\\n/g, '\n');
    // Each `txt := replace(txt, E'anchor', E'…' || E'…')` call: the first E-literal is the anchor,
    // the rest are the replacement. Split on the CALLS (not on a ');' inside the markdown — the
    // manual says "a card); `--item <id>`", and truncating there silently parsed half a section).
    const replacementsIn = (text) => text.split('txt := replace(txt,').slice(1).map((chunk) => {
      const lits = [...chunk.matchAll(/E'((?:[^']|'')*)'/g)].map((m) => decode(m[1]));
      return { anchor: lits[0], replacement: lits.slice(1).join('') };
    });
    const mgrReps = replacementsIn(sql.slice(sql.indexOf('-- ── (2)')));
    ok(mgrReps.length === 2, `059's manager block makes ${mgrReps.length} anchored replacements`);
    for (const r of mgrReps) {
      ok(manual.includes(r.replacement),
         `what 059 writes is VERBATIM in the harness file ("${r.replacement.split('\n')[0].slice(0, 46)}…")`);
    }
    // …and prove it end to end: reverse-apply 059 to the file to get the manual as it stood BEFORE,
    // seed the row with that, run the block, and the row must come back byte-for-byte the file.
    const before = mgrReps.reduce((t, r) => t.split(r.replacement).join(r.anchor), manual);
    ok(before !== manual, 'the migration is reversible on the file (so the "before" text is exact)');
    const saved = (await client.query(`SELECT bundle FROM harness WHERE key='manager'`)).rows[0]?.bundle ?? null;
    try {
      const block2 = sql.slice(sql.indexOf('-- ── (2)'));
      await client.query(`UPDATE harness SET bundle = jsonb_build_object('memory',
          jsonb_build_array(jsonb_build_object('path','memory/manager-zee-manual.md','text',$1::text)))
        WHERE key='manager'`, [before]);
      await client.query(block2);
      const got = async () => (await client.query(
        `SELECT bundle->'memory'->0->>'text' AS t FROM harness WHERE key='manager'`)).rows[0]?.t;
      ok((await got()) === manual, 'applying 059 to that text reproduces the FILE exactly — the two cannot drift');
      await client.query(block2);
      ok((await got()) === manual, 're-running it changes nothing (guarded, idempotent)');
      const edited = before.replace(mgrReps[1].anchor, '### a human renamed this section');
      await client.query(`UPDATE harness SET bundle = jsonb_set(bundle,'{memory,0,text}',to_jsonb($1::text)) WHERE key='manager'`, [edited]);
      await client.query(block2);
      ok((await got()).includes('### a human renamed this section'),
         'an anchor a human has MOVED makes that replacement not fire (no half-rewritten manual)');
      await client.query(`UPDATE harness SET bundle='{}'::jsonb WHERE key='manager'`);
      await client.query(block2);
      ok(true, 'a harness row with no manual at all is a clean no-op, not a crash');
    } finally {
      if (saved !== null) await client.query(`UPDATE harness SET bundle=$1 WHERE key='manager'`, [saved]);
    }

    const stored = (await client.query(
      `SELECT bundle->'memory'->0->>'text' AS t FROM harness WHERE key='zee-base'`)).rows[0]?.t;
    if (stored) {
      ok(/zee work \[--board\]/.test(stored) && /may only ever touch YOUR OWN item/.test(stored),
         'and the WORKER manual in this database carries the verbs and the own-item rule (059 applied)');
    }
  }

} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
