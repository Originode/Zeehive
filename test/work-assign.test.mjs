// PUTTING A ZEE ON A WORK ITEM — integration test for part 3 of the work tracker.
//
// Stands up an ISOLATED throwaway project in the real meta DB (its own git repo, a plan of work
// items, a manager xell, worker xells, a production xell and a foreign project) and exercises the
// whole assignment layer WITHOUT SPAWNING A SINGLE AGENT:
//
//   1. assign: the link, the queued → assigned move, the event, the task stamp — and idempotence;
//   2. THE REFUSALS, which are the point: another project's xell, production, a MANAGER zee, a xell
//      already carrying an open item, an unknown item/xell — each with a readable sentence and the
//      right HTTP code;
//   3. unassign: the link goes, the STATUS STAYS (work that happened, happened);
//   4. candidates: the ready pool + free live workers, and nobody who would be refused;
//   5. deploy: the brief built FROM the item (ancestors, ticket, acceptance, extra), the assignment
//      that follows, and its refusals — with the dispatch path STUBBED, never a real zee;
//   6. worksync: a live hive status MOVES a card, and the fence holds — never to `done`, never out
//      of a terminal status, never a card nobody is on; a vanished zee clears the LINK only;
//   7. the cxell verbs' SCOPING: a worker may touch its OWN item and nothing else, a manager only
//      its own project — resolved from the caller, never from a parameter;
//   8. the manuals and the CLI actually carry the verbs (a verb no manual mentions does not exist).
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
  // work items first in case 058 did not cascade them off the project.
  for (const sql of [
    `DELETE FROM work_item_event WHERE work_item_id IN (SELECT id FROM work_item WHERE project_id IN ($1,$2))`,
    `DELETE FROM work_item WHERE project_id IN ($1,$2)`,
  ]) { try { await client.query(sql, [PID, FID]); } catch { /* no such table yet */ } }
  try { await client.query(`DELETE FROM project WHERE id IN ($1,$2)`, [PID, FID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

await client.connect();
// Is the work tracker's schema here at all? (058 is part 1; this is part 3.)
const haveSchema = (await client.query(
  `SELECT to_regclass('public.work_item') IS NOT NULL AS yes`)).rows[0].yes;
if (!haveSchema) {
  console.error('\n  ⚠ SKIPPED — this database has no `work_item` table, so part 1 (db/migrations/058)');
  console.error('    is not applied here. Nothing was asserted. Run `zee sync` / migrate, then re-run:');
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
  const manager = await mkXell(PID, XO, 'wa-mgr', 'working', { zee_type: 'manager' });
  const prodXell = await mkXell(PID, XO, 'wa-prod', 'working', { is_production: true });
  const foreign = await mkXell(FID, XOF, 'wa-foreign', 'working');
  await client.query(`UPDATE xell SET manager_xell_id=$1 WHERE id IN ($2,$3)`, [manager.id, worker.id, spare.id]);
  const reread = async (x) => (await client.query(`SELECT * FROM xell WHERE id=$1`, [x.id])).rows[0];

  // a live zee on the worker, and a task for it (assign stamps task.work_item_id)
  const zee = (await client.query(
    `INSERT INTO zee (xell_id, status, model, attach_mode)
       VALUES ($1,'working','opus','headless-spawn') RETURNING *`, [worker.id])).rows[0];
  const task = (await client.query(
    `INSERT INTO task (project_id, xell_id, prompt_text, status) VALUES ($1,$2,'do the thing','working') RETURNING *`,
    [PID, worker.id])).rows[0];

  const WA = await import('../server/src/lib/work-assign.js');
  const worksync = await import('../server/src/queenzee/worksync.js');
  const workStatus = await import('../server/src/lib/work-status.js');
  const { HIVE_STATUS } = await import('../server/src/lib/hive-status.js');
  const { createWorkItem } = await import('../server/src/lib/work-items.js');

  // ── the ONE place part 1's create signature is assumed ────────────────────
  // Written against the contract while 058 was still held at the landing gate. If createWorkItem
  // turns out to take a different shape, THIS helper is the only thing to change in the suite.
  const mkItem = async (fields) => createWorkItem({ project_id: PID, ...fields });

  const root = await mkItem({ title: 'wa: the project', body: 'root of the test plan' });
  const activity = await mkItem({ parent_id: root.id, title: 'wa: an activity' });
  const item = await mkItem({
    parent_id: activity.id, title: 'wa: the task', body: 'the leaf a zee actually executes',
    acceptance: 'the board moves by itself and nothing is left behind' });

  // ── 0. the vocabulary this code fences against is the REAL one ───────────
  {
    const statuses = await client.query(`SELECT * FROM work_status`).catch(() => null);
    if (statuses) {
      const names = statuses.rows.map((r) => r.key || r.name || r.status);
      ok(WA.TERMINAL.every((s) => names.includes(s)),
         `work-assign's TERMINAL fence names real statuses (${WA.TERMINAL.join(', ')})`);
      ok(worksync.IN_FLIGHT.every((s) => names.includes(s)),
         `worksync's IN_FLIGHT window names real statuses (${worksync.IN_FLIGHT.join(', ')})`);
      ok(!worksync.IN_FLIGHT.some((s) => WA.TERMINAL.includes(s)),
         'the in-flight window and the terminal fence never overlap');
    } else {
      ok(true, '(no work_status table to pin the vocabulary against — skipped)');
    }
    // whatever the hive → work-status map says, a TICK can never produce a terminal status
    const reachable = Object.keys(HIVE_STATUS).map((k) => workStatus.statusFromHive(k)).filter(Boolean);
    ok(reachable.every((s) => !WA.TERMINAL.includes(s) || !worksync.IN_FLIGHT.includes(s)),
       'no hive status maps onto a terminal work status that the tick would be allowed to write');
  }

  // ── 1. assign ────────────────────────────────────────────────────────────
  const assigned = await WA.assignWorkItem(item.id, { xell_id: worker.id, actor: 'test@human' });
  ok(assigned.ok && assigned.item.xell_id === worker.id, 'assign links the xell to the work item');
  ok(assigned.item.status === 'assigned', `queued → assigned (${assigned.item.status})`);
  const stamped = (await client.query(`SELECT work_item_id FROM task WHERE id=$1`, [task.id])).rows[0];
  ok(stamped.work_item_id === item.id, "the zee's newest task is stamped with the work item");
  const ev = (await client.query(
    `SELECT * FROM work_item_event WHERE work_item_id=$1 ORDER BY created_at`, [item.id])).rows;
  ok(ev.some((e) => e.kind === 'assigned'), "the history records kind:'assigned'");
  ok(ev.some((e) => e.actor === 'test@human'), 'and who did it');

  const again = await WA.assignWorkItem(item.id, { xell_id: worker.id });
  ok(again.ok && again.already === true, 'assigning the same xell again is an idempotent no-op');
  const evCount = (await client.query(
    `SELECT count(*)::int n FROM work_item_event WHERE work_item_id=$1 AND kind='assigned'`, [item.id])).rows[0].n;
  ok(evCount === 1, 'and it does not write a second event');

  // ── 2. the refusals ──────────────────────────────────────────────────────
  const refusal = async (fn, re, what) => {
    const e = await caught(fn);
    ok(e && e.status === 409 && re.test(e.message), `${what} — 409: "${String(e?.message).slice(0, 72)}…"`);
  };
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: foreign.id }), /different project/i,
                "a xell from ANOTHER PROJECT cannot take an item");
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: prodXell.id }), /IS production/i,
                'PRODUCTION is not a worker');
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: manager.id }), /MANAGER/i,
                'a MANAGER zee cannot execute an item (it dispatches one that can)');
  await refusal(() => WA.assignWorkItem(activity.id, { xell_id: worker.id }), /already on an open work item/i,
                'a xell already carrying an open item is not free');
  const gone = await caught(() => WA.assignWorkItem('00000000-0000-4000-8000-0000000000ff', { xell_id: worker.id }));
  ok(gone?.status === 404, 'an unknown work item is 404, not 500');
  const noXell = await caught(() => WA.assignWorkItem(activity.id, { xell_id: '00000000-0000-4000-8000-0000000000fe' }));
  ok(noXell?.status === 404, 'an unknown xell is 404, not 500');
  const noArg = await caught(() => WA.assignWorkItem(activity.id, {}));
  ok(noArg?.status === 400 && /xell_id/.test(noArg.message), 'a missing xell_id is 400 with the reason');
  const notUuid = await caught(() => WA.getItem('banana'));
  ok(notUuid?.status === 400, 'a malformed id is 400, not a postgres error');

  // ── 3. unassign keeps the status ─────────────────────────────────────────
  await client.query(`UPDATE work_item SET status='working' WHERE id=$1`, [item.id]);
  const un = await WA.unassignWorkItem(item.id, { actor: 'test@human' });
  ok(un.ok && un.item.xell_id === null, 'unassign clears the link');
  ok(un.item.status === 'working', 'and LEAVES the status alone (work that happened, happened)');
  ok((await client.query(`SELECT work_item_id FROM task WHERE id=$1`, [task.id])).rows[0].work_item_id === null,
     "the zee's task stamp is cleared too");
  ok((await client.query(
    `SELECT count(*)::int n FROM work_item_event WHERE work_item_id=$1 AND kind='unassigned'`,
    [item.id])).rows[0].n === 1, 'and it is in the history');
  ok((await WA.unassignWorkItem(item.id)).already === true, 'unassigning nothing is an idempotent no-op');

  // ── 4. candidates ────────────────────────────────────────────────────────
  {
    const c = await WA.candidatesFor(item.id);
    const slugs = c.candidates.map((x) => x.slug);
    ok(slugs.includes('wa-worker') && slugs.includes('wa-spare'), 'candidates offer live workers with no open item');
    ok(slugs.includes('wa-ready'), 'and the ready pool');
    ok(!slugs.includes('wa-mgr'), 'never a manager zee');
    ok(!slugs.includes('wa-prod'), 'never production');
    ok(!slugs.includes('wa-foreign'), "never another project's xell");
    ok(c.candidates.every((x) => x.why), 'each candidate says WHY it is offered (a picker, not a uuid prompt)');
    // a xell carrying an open item drops out of the list — another item, or THIS one
    await WA.assignWorkItem(activity.id, { xell_id: spare.id });
    const c2 = await WA.candidatesFor(item.id);
    ok(!c2.candidates.map((x) => x.slug).includes('wa-spare'),
       'a xell that assign would refuse is never offered in the first place');
    await WA.assignWorkItem(item.id, { xell_id: worker.id });
    const c3 = await WA.candidatesFor(item.id);
    ok(!c3.candidates.map((x) => x.slug).includes('wa-worker'),
       'nor is the xell already ON this item (it cannot "take" what it is already doing)');
    await WA.unassignWorkItem(item.id);
    await WA.unassignWorkItem(activity.id);
  }

  // ── 5. deploy (dispatch STUBBED — no agent is ever spawned) ──────────────
  {
    // a ticket to be briefed from, if 058 models one
    let ticket = null;
    try {
      ticket = (await client.query(
        `INSERT INTO ticket (project_id, number, title, body) VALUES ($1, 4242, 'the ticket', 'why this exists')
         RETURNING *`, [PID])).rows[0];
      await client.query(`UPDATE work_item SET ticket_id=$2 WHERE id=$1`, [item.id, ticket.id]);
    } catch { /* no ticket table / different shape — the brief is simply thinner */ }

    let seen = null;
    const stub = async ({ task: brief, title }) => { seen = { brief, title }; return { xell_id: spare.id, slug: spare.slug }; };
    const out = await WA.deployWorkItem(item.id, { task: 'and mind the acceptance notes', actor: 'test@human', dispatchFn: stub });
    ok(out.ok && out.xell.id === spare.id, 'deploy assigns the dispatched worker to the item');
    ok(/wa: the task/.test(seen.brief), 'the brief carries the item itself');
    ok(/wa: the project/.test(seen.brief) && /wa: an activity/.test(seen.brief),
       'and its ANCESTOR chain (the worker knows what it sits under)');
    ok(/the board moves by itself/.test(seen.brief), 'and its acceptance notes ("what done means")');
    ok(/and mind the acceptance notes/.test(seen.brief), "and the deployer's extra instructions");
    ok(!ticket || /4242|the ticket/.test(seen.brief), 'and the linked ticket');
    ok(/zee item/.test(seen.brief) && /never marks/i.test(seen.brief) === false || /zee work/.test(seen.brief),
       'and tells the worker how to report progress');
    ok((await client.query(
      `SELECT count(*)::int n FROM work_item_event WHERE work_item_id=$1 AND kind='deployed'`,
      [item.id])).rows[0].n === 1, "the history records kind:'deployed'");

    const twice = await caught(() => WA.deployWorkItem(item.id, { dispatchFn: stub }));
    ok(twice?.status === 409 && /already deployed/i.test(twice.message),
       'deploying onto an item that already has a live zee is refused (no second agent on one job)');
    await WA.unassignWorkItem(item.id);

    await client.query(`UPDATE work_item SET status='done' WHERE id=$1`, [item.id]);
    const finished = await caught(() => WA.deployWorkItem(item.id, { dispatchFn: stub }));
    ok(finished?.status === 409 && /done/.test(finished.message),
       'and deploying onto a FINISHED item is refused (a whole worker on work somebody ended)');
    await client.query(`UPDATE work_item SET status='assigned' WHERE id=$1`, [item.id]);
  }

  // ── 6. worksync: the board moves itself, and the fence holds ─────────────
  {
    await WA.assignWorkItem(item.id, { xell_id: worker.id });
    await client.query(`UPDATE work_item SET status='assigned' WHERE id=$1`, [item.id]);

    // the zee is WORKING → the card follows it
    const t1 = await worksync.workSyncTick();
    const after1 = (await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status;
    const expect1 = workStatus.statusFromHive('occ-working');
    ok(after1 === expect1, `a working zee moves its card to '${expect1}' (got '${after1}', ${t1.moved} move(s))`);
    const qz = (await client.query(
      `SELECT * FROM work_item_event WHERE work_item_id=$1 AND actor='queenzee' ORDER BY created_at DESC`,
      [item.id])).rows;
    ok(qz.length >= 1, "each self-move is recorded with actor:'queenzee' (the board says it moved itself)");

    // a HELD LANDING is a different hive status → a different card position
    const land = (await client.query(
      `INSERT INTO land_request (project_id, xell_id, ref, new_sha, status)
         VALUES ($1,$2,'refs/heads/master','deadbeef','pending') RETURNING *`, [PID, worker.id])).rows[0];
    await worksync.workSyncTick();
    const after2 = (await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status;
    const expect2 = workStatus.statusFromHive('occ-landRequest');
    ok(after2 === expect2, `a held landing moves it to '${expect2}' (got '${after2}') — the same signal a human's hexagon shows`);
    await client.query(`DELETE FROM land_request WHERE id=$1`, [land.id]);

    // THE FENCE: a terminal card is never touched, whatever the zee is doing
    await client.query(`UPDATE work_item SET status='done' WHERE id=$1`, [item.id]);
    const evBefore = (await client.query(
      `SELECT count(*)::int n FROM work_item_event WHERE work_item_id=$1`, [item.id])).rows[0].n;
    await worksync.workSyncTick();
    const stayed = (await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status;
    const evAfter = (await client.query(
      `SELECT count(*)::int n FROM work_item_event WHERE work_item_id=$1`, [item.id])).rows[0].n;
    ok(stayed === 'done', 'the tick NEVER moves a card out of a terminal status');
    ok(evAfter === evBefore, 'and writes no event pretending it considered it');

    // …and it can never move one INTO done: the only statuses it writes are in-flight
    await client.query(`UPDATE work_item SET status='working' WHERE id=$1`, [item.id]);
    await client.query(`UPDATE xell SET status='tearing-down' WHERE id=$1`, [worker.id]);   // hive: occ-done
    await worksync.workSyncTick();
    const notDone = (await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status;
    ok(!WA.TERMINAL.includes(notDone),
       `a zee whose xell is being torn down does NOT finish the work item (still '${notDone}') — finishing is a decision`);
    await client.query(`UPDATE xell SET status='working' WHERE id=$1`, [worker.id]);

    // a card nobody is on is not touched at all
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
    ok((await client.query(
      `SELECT count(*)::int n FROM work_item_event WHERE work_item_id=$1 AND kind='unassigned' AND actor='queenzee'`,
      [item.id])).rows[0].n === 1, 'with an event saying the queenzee did it, and why');
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
    ok(mine.ancestors?.length === 2, 'with its ancestor chain');
    const plan = await selfWork(m);
    ok(plan.ok && plan.count >= 3 && plan.items[0].depth === 0,
       "`zee work` shows a MANAGER its project's plan in tree order");
    const board = await selfWork(m, { board: true });
    ok(board.items.every((i) => i.depth > 0), '--board drops the project root (a root is not a card)');

    const nosy = await selfWork(w, { item: activity.id });
    ok(nosy.ok === false && /not the work item you are assigned to/.test(nosy.error),
       "a worker cannot read another item — not even one in its own project");
    const stranger = await selfWorkItem(s, { id: item.id, status: 'blocked' });
    ok(stranger.ok === false && /not your work item/.test(stranger.error),
       'a worker cannot report on somebody else\'s item (the id it supplied is refused)');
    ok((await client.query(`SELECT status FROM work_item WHERE id=$1`, [item.id])).rows[0].status === 'assigned',
       'and nothing was written when it tried');

    const report = await selfWorkItem(w, { status: 'working', progress: 40, note: 'digging in' });
    ok(report.ok && report.item.status === 'working', 'a worker reports its OWN item without naming it at all');
    const bad = await selfWorkItem(w, { progress: 400 });
    ok(bad.ok === false && /0-100/.test(bad.error), 'a nonsense progress is refused with the range');

    const done = await selfWorkItem(w, { status: 'done', note: 'work finished' });
    ok(done.ok && done.item.status === 'done', 'a worker MAY report its work done (a fact, not a gate)');
    const xellAfter = await reread(worker);
    ok(xellAfter.status !== 'awaiting-done',
       'and that does NOT propose its xell done — done/land/ship stay its own verbs and a human\'s gates');
    ok(!(await client.query(`SELECT count(*)::int n FROM land_request WHERE xell_id=$1`, [w.id])).rows[0].n,
       'nor does it land anything');
    const reopen = await selfWorkItem(w, { status: 'working' });
    ok(reopen.ok === false && /human/.test(reopen.error), 'and it cannot REOPEN what it just finished');
    await client.query(`UPDATE work_item SET status='working' WHERE id=$1`, [item.id]);

    // manager scoping
    const notMine = await selfWork(m, { item: (await mkItemInForeign()).id });
    ok(notMine.ok === false && /another project/.test(notMine.error),
       "a manager cannot read another project's item");
    const workerAssign = await selfWorkAssign(w, { item: item.id, task: 'go' });
    ok(workerAssign.ok === false && /MANAGER verb/.test(workerAssign.error),
       '`zee assign` is refused for a worker, with the explanation (not a 404)');
    const noItem = await selfWorkAssign(m, {});
    ok(noItem.ok === false && /--item/.test(noItem.error), 'and it needs an item');
  }

  // ── 8. the verbs exist where a zee will look for them ────────────────────
  {
    const routes = readFileSync('server/src/api/routes.js', 'utf8');
    for (const r of ['/work-items/:id/assign', '/work-items/:id/deploy', '/work-items/:id/candidates',
                     '/xell/self/work', '/xell/self/work/assign', '/xell/self/work/item']) {
      ok(routes.includes(r), `routes.js serves ${r}`);
    }
    const cli = readFileSync('scripts/zee', 'utf8');
    for (const c of ["case 'work'", "case 'assign'", "case 'item'"]) ok(cli.includes(c), `the zee CLI has ${c}`);
    ok(/zee work \[--board\]/.test(cli) && /zee assign --item/.test(cli), 'and its usage text names them');

    const mgrManual = readFileSync('harnesses/manager/memory/manager-zee-manual.md', 'utf8');
    for (const s of ['zee work', 'zee assign --item', 'zee item', 'Break a ticket down into work items BEFORE you']) {
      ok(mgrManual.includes(s), `the manager manual teaches: ${s}`);
    }
    const mig = readFileSync('db/migrations/059_work_tracker_verbs.sql', 'utf8');
    ok(/key = 'zee-base'/.test(mig) && /key = 'manager'/.test(mig), '059 teaches BOTH manuals');
    ok(/IF txt IS NULL OR txt LIKE/.test(mig), 'and is guarded (idempotent, no-op when an anchor moved)');
    const stored = (await client.query(
      `SELECT bundle->'memory'->0->>'text' AS t FROM harness WHERE key='zee-base'`)).rows;
    if (stored.length && stored[0].t) {
      ok(/zee work \[--board\]/.test(stored[0].t) && /zee item/.test(stored[0].t),
         'and the WORKER manual in this database carries them (059 applied)');
    }
  }

  async function mkItemInForeign() {
    return createWorkItem({ project_id: FID, title: 'wa: somebody else\'s plan' });
  }

} finally {
  await cleanup({ files: true });
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
