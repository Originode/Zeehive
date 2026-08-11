// A MANAGER CUTS ITS OWN PLAN — integration test for `zee work --new`, `zee breakdown` and
// `zee unassign` (TKT-52).
//
// The manager manual orders a manager to break a ticket down into work items BEFORE it dispatches
// anybody, and until these three verbs landed it could not: createWorkItem and breakdownTicket were
// reachable from the console only, and a card locked to a xell that died at spawn could not be
// freed at all — `zee assign` refused the replacement with "unassign it first", naming a verb no
// manager had.
//
// Stands up an ISOLATED throwaway project in the real meta DB (its own git repo, a manager xell, a
// worker xell, a ticket) and exercises the three self verbs directly — NO agent is spawned, nothing
// is dispatched, landed or shipped:
//
//   1. work --new: the card, the id it prints, --parent, --ticket (by CODE and by id), and the
//      defaults it takes from the domain (kind=task, status=queued, the project ROOT as parent);
//   2. breakdown: a whole tree in one call including a `ref` parent, the ticket link and its move
//      out of queued — and that a malformed entry creates NOTHING (one transaction);
//   3. unassign: the link goes, the STATUS stays, the xell is untouched, and `assign` works again;
//   4. THE REFUSALS, which are the point: a WORKER gets a sentence (never a 403/404), and every
//      cross-project reach — a parent, a ticket, an item in somebody else's project — is refused BY
//      NAME with nothing written;
//   5. the plumbing that makes the verbs reachable: the three routes, the three CLI cases and the
//      manager manual's own section (house rule 8 — the CLI and what a zee is TOLD move together).
//
// Everything it creates is torn down in a finally, whatever happens (house rule 1: no test data).
// If the work tracker's schema (058) is not present the suite SKIPS LOUDLY rather than pretending.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'planverbs-'));
const PID = '00000000-0000-4000-8000-00000000e331';   // this test's project
const FID = '00000000-0000-4000-8000-00000000e332';   // a FOREIGN project (the cross-project refusals)

async function cleanup({ files = false } = {}) {
  try { await client.query('ROLLBACK'); } catch { /* not in a transaction — fine */ }
  // TICKETS FIRST: ticket.work_item_id references work_item, so deleting the items first fails the
  // FK, and a swallowed failure there leaves the whole fixture — project, xells and all — behind on
  // a shared database. (Verified by counting rows afterwards; this order leaves none.)
  for (const sql of [
    `DELETE FROM work_item_event WHERE work_item_id IN (SELECT id FROM work_item WHERE project_id IN ($1,$2))`,
    `DELETE FROM ticket WHERE project_id IN ($1,$2)`,
    `DELETE FROM work_item WHERE project_id IN ($1,$2)`,
  ]) { try { await client.query(sql, [PID, FID]); } catch { /* no such table yet */ } }
  try { await client.query(`DELETE FROM project WHERE id IN ($1,$2)`, [PID, FID]); } catch { /* */ }
  // …and SAY SO if anything survived: a cleanup that quietly fails is how a "no test data" rule is
  // broken without anybody noticing.
  try {
    const left = (await client.query(
      `SELECT (SELECT count(*) FROM project WHERE id IN ($1,$2))
            + (SELECT count(*) FROM xell WHERE project_id IN ($1,$2))
            + (SELECT count(*) FROM work_item WHERE project_id IN ($1,$2))
            + (SELECT count(*) FROM ticket WHERE project_id IN ($1,$2)) AS n`, [PID, FID])).rows[0].n;
    if (Number(left)) console.error(`  ⚠ CLEANUP LEFT ${left} fixture row(s) behind — delete them by hand`);
  } catch { /* no schema — nothing was created either */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

await client.connect();
const haveSchema = (await client.query(
  `SELECT to_regclass('public.work_item') IS NOT NULL AS yes`)).rows[0].yes;
if (!haveSchema) {
  console.error('\n  ⚠ SKIPPED — this database has no `work_item` table, so the work tracker (058) is');
  console.error('    not applied here. Nothing was asserted. Migrate, then re-run:');
  console.error('    DATABASE_URL=… node test/manager-plan-verbs.test.mjs\n');
  await client.end();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

try {
  await cleanup();

  // ── the fixture: two projects, a manager and a worker, in ONE transaction ─
  // target_ready=0 on both: a running queenzee's pool tick reconciles every project, and a throwaway
  // project that took the column default (3) would have it PROVISIONING real xells (the flake
  // test/work-assign.test.mjs paid for).
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# plan verbs test\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');

  const XO = '00000000-0000-4000-8000-00000000e441';
  const XOF = '00000000-0000-4000-8000-00000000e442';
  await client.query('BEGIN');
  for (const [id, name, dbn] of [[PID, 'planverbs-test', 'pvtest'], [FID, 'planverbs-foreign', 'pvftest']]) {
    await client.query(
      `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
         VALUES ($1,$2,$3,'master',$4,'postgres')`, [id, name, repo, dbn]);
  }
  await client.query(`INSERT INTO pool_config (project_id, target_ready) VALUES ($1,0),($2,0)`, [PID, FID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master'),($3,$4,'master')`,
    [XO, PID, XOF, FID]);
  const mkXell = async (project, xource, slug, extra = {}) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,'working',false,$6) RETURNING *`,
    [project, xource, slug, `spinoff/${slug}`, join(tmp, slug), extra.zee_type || 'worker'])).rows[0];
  const manager = await mkXell(PID, XO, 'pv-mgr', { zee_type: 'manager' });
  const worker = await mkXell(PID, XO, 'pv-worker');
  const spare = await mkXell(PID, XO, 'pv-spare');
  const fmanager = await mkXell(FID, XOF, 'pv-foreign-mgr', { zee_type: 'manager' });
  await client.query(`UPDATE xell SET manager_xell_id=$1 WHERE id IN ($2,$3)`,
    [manager.id, worker.id, spare.id]);
  await client.query('COMMIT');
  await client.query(
    `INSERT INTO task (project_id, xell_id, prompt_text, status) VALUES ($1,$2,'do the thing','working')`,
    [PID, worker.id]);

  const { selfWorkNew, selfWorkBreakdown, selfWorkUnassign, selfWorkAssign, selfWork } =
    await import('../server/src/queenzee/self.js');
  const { createTicket, resolveTicket, ticketCode } = await import('../server/src/lib/tickets.js');
  const { projectRoot, getWorkItem } = await import('../server/src/lib/work-items.js');
  const WA = await import('../server/src/lib/work-assign.js');
  const items = async (pid = PID) => (await client.query(
    `SELECT count(*)::int n FROM work_item WHERE project_id=$1`, [pid])).rows[0].n;
  const events = async (id) => (await client.query(
    `SELECT kind, actor, from_status, to_status, detail FROM work_item_event
      WHERE work_item_id=$1 ORDER BY ts, id`, [id])).rows;

  const ticket = await createTicket({ project_id: PID, title: 'pv: the ask that becomes a plan',
    body: 'what came in', reporter: 'test@human' });
  // TWO foreign tickets, because ticket NUMBERS are per project and both refusals matter: the
  // foreign #1 collides with this project's own #1 (the code-mismatch sentence), the foreign #2
  // names a number this project does not have at all (the not-in-your-project sentence).
  const fticket = await createTicket({ project_id: FID, title: "pv: somebody else's ask",
    reporter: 'test@human' });
  const fticket2 = await createTicket({ project_id: FID, title: "pv: somebody else's second ask",
    reporter: 'test@human' });

  // ── 1. `zee work --new` — ONE card, and the id the next command needs ────
  {
    // PARENT-FIRST: a top-level cut establishes the parent work_node, so it must be an ACTIVITY.
    // A leaf task with no parent is refused below — the guard this suite is the contract for.
    const made = await selfWorkNew(manager, { title: 'pv: the activity', body: 'the plan', kind: 'activity' });
    ok(made.ok && made.item?.id, `\`zee work --new\` creates a work item (${made.item?.id})`);
    ok(made.id === made.item.id, 'and answers with the ID at the top level — what `zee assign --item` takes');
    ok(made.item.project_id === PID, "in the caller's OWN project, resolved from the token");
    const root = await projectRoot(PID);
    ok(made.item.parent_id === root.id, 'parented on the project ROOT when no --parent is given');
    ok(made.item.kind === 'activity' && made.item.status === 'queued',
       `with the domain's own defaults (${made.item.kind}, ${made.item.status})`);
    ok((await events(made.item.id)).some((e) => e.kind === 'created' && e.actor === manager.slug),
       "the ledger records who cut it (kind:'created', actor = the manager's slug)");
    ok(/zee assign --item/.test(made.message), 'and the answer names the very next verb, with the id in it');

    const stray = await selfWorkNew(manager, { title: 'pv: a task with no home' });
    ok(stray.ok === false && stray.status === 'refused'
       && /establish the parent work_node/.test(stray.error)
       && /--kind activity/.test(stray.error) && /--parent/.test(stray.error)
       && /zee ticket/.test(stray.error),
       'a parentless TASK is refused with a sentence: establish the parent activity, nest, or ticket it');
    const straySpelled = await selfWorkNew(manager, { title: 'pv: a task with no home', kind: 'task' });
    ok(straySpelled.ok === false && /establish the parent work_node/.test(straySpelled.error),
       '…and spelling --kind task out loud changes nothing — a task is a task');
    const strayAct = await selfWorkNew(manager, { title: 'pv: another top-level activity', kind: 'activity' });
    ok(strayAct.ok, 'a parentless ACTIVITY is still allowed — that is how a parent is established');

    const child = await selfWorkNew(manager, { title: 'pv: a task under it', parent: made.item.id });
    ok(child.ok && child.item.parent_id === made.item.id && child.item.depth === made.item.depth + 1,
       '--parent hangs the new card under an existing item (depth follows)');

    const byCode = await selfWorkNew(manager,
      { title: 'pv: linked by code', ticket: ticket.code, parent: made.item.id });
    ok(byCode.ok && byCode.item.ticket_id === ticket.id,
       `--ticket takes the CODE a human reads (${ticket.code})`);
    const byRef = await selfWorkNew(manager,
      { title: 'pv: linked by ref', ticket: `#${ticket.number}`, parent: made.item.id });
    ok(byRef.ok && byRef.item.ticket_id === ticket.id, `…the bare ref (#${ticket.number})…`);
    const byId = await selfWorkNew(manager, { title: 'pv: linked by id', ticket: ticket.id, parent: made.item.id });
    ok(byId.ok && byId.item.ticket_id === ticket.id, '…and the uuid');
    ok(byCode.ticket?.code === ticket.code, 'and it echoes which ticket it linked');

    const priority = await selfWorkNew(manager,
      { title: 'pv: urgent', priority: 1, status: 'blocked', parent: made.item.id });
    ok(priority.ok && priority.item.priority === 1 && priority.item.status === 'blocked',
       '--priority and --status are passed through to the domain');
  }

  // ── 1b. `--after <sibling-id>` — nest under the sibling's parent AND chain, in one call ────
  {
    const parent = (await selfWorkNew(manager, { title: 'pv: chain home', kind: 'activity' })).item;
    const first = (await selfWorkNew(manager, { title: 'pv: first in the chain', parent: parent.id })).item;
    const second = await selfWorkNew(manager, { title: 'pv: second in the chain', after: first.id });
    ok(second.ok && second.item?.id, '`--after <sibling-id>` creates the card in one call');
    ok(second.item.parent_id === parent.id,
       "…nested under the sibling's SAME parent (not under the sibling itself)");
    ok(second.after?.id === first.id && second.after?.title === first.title,
       '…and the answer echoes which sibling it was chained after');
    const read = await selfWork(manager, { item: second.item.id });
    ok(read.ok && read.item.deps?.some((d) => d.id === first.id),
       '…and the FS dependency is visible in `zee work` — the new card WAITS FOR the sibling');
    ok(/nested under/.test(second.message) && /waits for/.test(second.message),
       'and the answer names BOTH effects: the nesting and the chain');

    const root = await projectRoot(PID);
    const afterRoot = await selfWorkNew(manager, { title: 'pv: after the root', after: root.id });
    ok(afterRoot.ok === false && afterRoot.status === 'refused' && /no parent to nest a sibling under/.test(afterRoot.error),
       '--after the project ROOT is refused — a root is not a sibling');
    const other = (await selfWorkNew(manager, { title: 'pv: a different home', kind: 'activity' })).item;
    const disagree = await selfWorkNew(manager,
      { title: 'pv: two homes', after: first.id, parent: other.id });
    ok(disagree.ok === false && /disagree/.test(disagree.error) && /ONE home/.test(disagree.error),
       '--after with a --parent that names a DIFFERENT home is refused (one home, not two)');
    const afterForeign = await selfWorkNew(manager,
      { title: 'pv: reaching across', after: (await projectRoot(FID)).id });
    ok(afterForeign.ok === false && /another project/.test(afterForeign.error),
       '…and so is --after a sibling in another project');
    const afterGone = await selfWorkNew(manager,
      { title: 'pv: gone sibling', after: '00000000-0000-4000-8000-0000000000ff' });
    ok(afterGone.ok === false && /no work item/.test(afterGone.error),
       '…and an unknown sibling is a 404 sentence, like --parent');
  }

  // ── 2. `zee breakdown` — a ticket becomes a TREE, in one transaction ─────
  {
    const before = await items();
    const out = await selfWorkBreakdown(manager, { ticket: ticket.code, items: [
      { ref: 'act', title: 'pv: the activity', kind: 'activity' },
      { title: 'pv: first task', parent_id: 'act', body: 'do this' },
      { title: 'pv: second task', parent_id: 'act', priority: 2 },
    ] });
    ok(out.ok && out.count === 3, `\`zee breakdown\` cut ${out.count} items in one call`);
    ok(await items() === before + 3, 'and exactly that many rows exist');
    const act = out.created.find((i) => i.kind === 'activity');
    ok(out.created.filter((i) => i.parent_id === act.id).length === 2,
       "a later item's parent_id may name an EARLIER item's ref — one call builds a tree");
    ok(out.created.every((i) => i.ticket_id === ticket.id), 'every item is linked to the ticket');
    const t = await resolveTicket(ticket.id);
    ok(t.status === 'assigned' && t.work_item_id === act.id,
       `the ticket moved out of queued (${t.status}) and points at the top of what it became`);
    ok(/ADDITIVE/.test(out.message), 'and the answer warns that a second breakdown cuts a SECOND set');

    const mid = await items();
    const bust = await selfWorkBreakdown(manager, { ticket: ticket.code, items: [
      { title: 'pv: fine' }, { title: 'pv: broken', parent_id: 'never-declared' },
    ] });
    ok(bust.ok === false && /neither a work item id nor a ref/.test(bust.error),
       'a forward/typo ref is refused by name, naming the item that was wrong');
    ok(await items() === mid, 'and NOTHING was created — the whole breakdown is one transaction');

    const empty = await selfWorkBreakdown(manager, { ticket: ticket.code, items: [] });
    ok(empty.ok === false && /non-empty JSON array/.test(empty.error), 'an empty --items file is refused');
    const noTicket = await selfWorkBreakdown(manager, { items: [{ title: 'x' }] });
    ok(noTicket.ok === false && /--ticket/.test(noTicket.error), 'and so is a breakdown with no ticket');
    const ghost = await selfWorkBreakdown(manager, { ticket: 'TKT-9999', items: [{ title: 'x' }] });
    ok(ghost.ok === false && /no ticket TKT-9999 in your project/.test(ghost.error),
       'a ticket that does not exist is a sentence, not a stack trace');
    const wrongSuffix = await selfWorkBreakdown(manager,
      { ticket: `TKT-${ticket.number}-FFFF`, items: [{ title: 'x' }] });
    ok(wrongSuffix.ok === false && /does not name ticket/.test(wrongSuffix.error),
       'and a code whose suffix names a different ticket is refused rather than resolved by number');

    // ── the ITEM SHAPE is a whitelist, because the file is UNTRUSTED input ──
    // breakdownTicket spreads each entry into createWorkItem, which accepts more than this verb
    // advertises. Left open, `xell_id` in the file put a card in THIS project on a LIVE worker in
    // ANOTHER one (itemForXell resolves by work_item.xell_id first, so that worker's `zee work`
    // answered with this card and its `zee item` wrote to it) — with no `assigned` event to say who
    // did it, and none of assignWorkItem's guards run. So: the advertised keys, or a refusal.
    const beforeMass = await items();
    const massXell = await selfWorkBreakdown(manager, { ticket: ticket.code, items: [
      { title: 'pv: fine' },
      { title: 'pv: pre-stamped with a zee', xell_id: worker.id, progress: 90 },
    ] });
    ok(massXell.ok === false && /xell_id/.test(massXell.error) && /progress/.test(massXell.error)
       && /pv: pre-stamped with a zee/.test(massXell.error),
       'a breakdown item may not carry xell_id/progress — refused BY NAME, naming the item and the fields');
    ok(/zee assign/.test(massXell.error),
       '…and points at the verb that DOES put a zee on a card (which checks the project and logs it)');
    ok(await items() === beforeMass, 'and nothing was created — the refusal is before the transaction');
    const massMisc = await selfWorkBreakdown(manager, { ticket: ticket.code, items: [
      { title: 'pv: smuggling', assignee: 'someone', created_by: 'someone', sort_order: 1, status: 'working' },
    ] });
    ok(massMisc.ok === false && /assignee/.test(massMisc.error) && /created_by/.test(massMisc.error)
       && /sort_order/.test(massMisc.error) && /status/.test(massMisc.error),
       '…and neither assignee, created_by, sort_order nor status (a card is born queued)');
    ok(await items() === beforeMass, 'and still nothing was created');
    const shaped = await selfWorkBreakdown(manager, { ticket: ticket.code, items: [
      { title: 'pv: every advertised key', kind: 'activity', body: 'b', ref: 'a', priority: 2,
        starts_on: '2026-01-01', due_on: '2026-01-02' },
      { title: 'pv: under it', parent_id: 'a' },
    ] });
    ok(shaped.ok && shaped.count === 2,
       'every key the verb advertises still goes through (title, kind, body, parent_id, ref, priority, starts_on, due_on)');

    // A ticket that vanishes between resolve and breakdown makes breakdownTicket answer null; reading
    // out.count off it was a TypeError the route turned into "Cannot read properties of null".
    const self = readFileSync(join(ROOT, 'server/src/queenzee/self.js'), 'utf8');
    // CODE only — the comments around this guard name `out.count` while explaining it, and a search
    // over the prose finds the wrong occurrence first.
    const fn = self.slice(self.indexOf('export async function selfWorkBreakdown'),
                          self.indexOf('export async function selfWorkUnassign'))
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ok(fn.indexOf('if (!out)') > 0 && fn.indexOf('if (!out)') < fn.indexOf('out.count'),
       'breakdown handles a null answer from breakdownTicket BEFORE it reads out.count');
  }

  // ── 3. `zee unassign` — the card goes back to being plan ─────────────────
  {
    // A parent-first plan has ONE home activity; every card this section assigns lives under it.
    const home = (await selfWorkNew(manager, { title: 'pv: unassign home', kind: 'activity' })).item;
    const card = (await selfWorkNew(manager, { title: 'pv: the card a dead zee held', parent: home.id })).item;
    await WA.assignWorkItem(card.id, { xell_id: worker.id, actor: 'test@human' });
    await WA.reportItemStatus(card.id, { status: 'working', actor: 'test@human' });

    const taken = await selfWorkAssign(manager, { item: card.id, task: 'go' });
    ok(taken.ok === false && /unassign it first/.test(taken.error),
       'assign refuses a card that already has a zee — naming the verb this test is about');

    const freed = await selfWorkUnassign(manager, { item: card.id, reason: 'its zee died at spawn' });
    ok(freed.ok && freed.was?.slug === 'pv-worker', '`zee unassign` takes the zee off the card');
    const after = await getWorkItem(card.id);
    ok(after.xell_id === null && after.zee === null, 'the link is gone');
    ok(after.status === 'working', 'the STATUS is kept — work that happened, happened');
    ok((await client.query(`SELECT status FROM xell WHERE id=$1`, [worker.id])).rows[0].status === 'working',
       'and the xell it was on is untouched — unassigning reaps nobody');
    ok((await client.query(
      `SELECT count(*)::int n FROM task WHERE xell_id=$1 AND work_item_id=$2`, [worker.id, card.id]))
      .rows[0].n === 0, "the zee's task stamp is cleared too");
    const ev = (await events(card.id)).filter((e) => e.kind === 'assigned' && e.detail?.unassigned);
    ok(ev.length === 1 && ev[0].detail.reason === 'its zee died at spawn',
       '--reason rides in the ledger entry, so the card can be dated afterwards');

    const relet = await WA.assignWorkItem(card.id, { xell_id: spare.id, actor: 'test@human' });
    ok(relet.ok && relet.item.xell_id === spare.id, 'and a replacement zee can now take the card');
    const twice = await selfWorkUnassign(manager, { item: card.id });
    ok(twice.ok, 'unassigning is repeatable…');
    const noop = await selfWorkUnassign(manager, { item: card.id });
    ok(noop.ok && noop.already === true, '…and unassigning nothing is an idempotent no-op, not an error');

    // ── a LIVE zee is detached quietly, and quiet is the problem ────────────
    // The verb exists for a xell that died at spawn, so it must stay ONE call for that case. But it
    // will as readily detach a xell that is mid-turn: that worker's `zee work` goes blank and its
    // `zee item` is refused from then on, with nobody told. It is not refused — it is SAID.
    const live = (await selfWorkNew(manager, { title: 'pv: a running zee is on this', parent: home.id })).item;
    await WA.assignWorkItem(live.id, { xell_id: spare.id, actor: 'test@human' });
    const onLive = await selfWorkUnassign(manager, { item: live.id });
    ok(onLive.ok, 'unassigning a LIVE worker still WORKS (it is not refused)');
    // Matched on the WARNING's own words, not on "live|running" anywhere in the sentence: the
    // not-live branch ends "…so no running zee lost its card", which satisfies a loose regex while
    // saying the opposite. An assertion a regression passes is not an assertion.
    ok(/pv-spare is still LIVE \(status: working\)/.test(onLive.message)
       && /detached a card from a RUNNING zee/.test(onLive.message),
       '…but the answer NAMES the xell, its live status, and that a RUNNING zee was detached');
    ok(/zee say|zee work|report/.test(onLive.message),
       '…and says what the detached zee now sees, so the manager can tell it');
    ok(onLive.xell_was_live === true, 'and the answer carries the fact as data, not only prose');

    // …and the case it was built for stays a one-liner with no scolding.
    const dead = (await selfWorkNew(manager, { title: 'pv: the card of a xell that died', parent: home.id })).item;
    await WA.assignWorkItem(dead.id, { xell_id: spare.id, actor: 'test@human' });
    await client.query(`UPDATE xell SET status='retired' WHERE id=$1`, [spare.id]);
    const onDead = await selfWorkUnassign(manager, { item: dead.id, reason: 'died at spawn' });
    ok(onDead.ok && onDead.xell_was_live === false,
       'a xell that is GONE is reported as gone, not as a live zee you just detached');
    ok(!/still/i.test(onDead.message), '…and the live-zee warning is not printed for it');
    await client.query(`UPDATE xell SET status='working' WHERE id=$1`, [spare.id]);
  }

  // ── 4. the refusals: a WORKER, and every cross-project reach ─────────────
  {
    // A parent-first plan has ONE home activity; the cross-project/ticket/priority refusals below
    // are reached with a --parent (a parentless task would be refused by the parent-first guard
    // first, which is a DIFFERENT sentence and a different test).
    const home = (await selfWorkNew(manager, { title: 'pv: refusal home', kind: 'activity' })).item;
    const before = await items();
    const beforeF = await items(FID);
    for (const [what, answer] of [
      ['work --new', await selfWorkNew(worker, { title: 'pv: a worker tries to cut a card' })],
      ['breakdown', await selfWorkBreakdown(worker, { ticket: ticket.code, items: [{ title: 'x' }] })],
      ['unassign', await selfWorkUnassign(worker, { item: (await projectRoot(PID)).id })],
    ]) {
      ok(answer.ok === false && answer.status === 'refused' && /is a MANAGER verb/.test(answer.error),
         `a WORKER running \`zee ${what}\` gets a sentence explaining it is a manager verb`);
      ok(/zee report/.test(answer.error), '…and is pointed at the verb it does have (talk to your manager)');
    }
    ok(await items() === before, 'and a refused worker wrote nothing');

    const fRoot = await projectRoot(FID);
    const foreignParent = await selfWorkNew(manager, { title: 'pv: reaching across', parent: fRoot.id });
    ok(foreignParent.ok === false && /another project/.test(foreignParent.error),
       'a --parent in another project is refused BY NAME (it would move the whole item there)');
    // Numbers are per project, so a foreign code either COLLIDES with a number the caller does have
    // (and is refused as the wrong code for that ticket — never silently resolved to it) or names a
    // number it does not have (and is refused as missing). Both are exercised, because the collision
    // is the one that could have handed the caller a row it did not ask for.
    const foreignTicket = await selfWorkNew(manager,
      { title: 'pv: reaching across', ticket: fticket.code, parent: home.id });
    ok(foreignTicket.ok === false && /does not name ticket/.test(foreignTicket.error)
       && foreignTicket.error.includes(ticket.code),
       `…and so is another project's code that collides with one of ours (${fticket.code} → refused, `
       + `and told which ticket ${ticket.code} really is)`);
    const foreignTicket2 = await selfWorkNew(manager,
      { title: 'pv: reaching across', ticket: fticket2.code, parent: home.id });
    ok(foreignTicket2.ok === false && /no ticket .* in your project/.test(foreignTicket2.error),
       "…and a foreign code whose number we do not have at all");
    const foreignBreakdown = await selfWorkBreakdown(manager, { ticket: fticket2.code, items: [{ title: 'x' }] });
    ok(foreignBreakdown.ok === false && /your project/.test(foreignBreakdown.error),
       "…and breaking down another project's ticket");
    // …AND BY UUID, which is the handle the code path is different for: numbers are per project, ids
    // are not, so `--ticket <id>` read the whole ticket table. Unfixed, the first of these linked a
    // card in OUR project to somebody else's ticket (briefing its worker with that ticket's body) and
    // the second cut items into the OTHER project's plan and moved their ticket out of queued.
    const foreignTicketId = await selfWorkNew(manager,
      { title: 'pv: reaching across by id', ticket: fticket.id, parent: home.id });
    ok(foreignTicketId.ok === false && /no ticket .* in your project/.test(foreignTicketId.error),
       "…and a foreign ticket named by its UUID (--ticket <id>), not just by its code");
    const foreignBreakdownId = await selfWorkBreakdown(manager, { ticket: fticket.id, items: [{ title: 'x' }] });
    ok(foreignBreakdownId.ok === false && /your project/.test(foreignBreakdownId.error),
       "…and breaking down another project's ticket named by its UUID");
    ok((await client.query(`SELECT status, work_item_id FROM ticket WHERE id=$1`, [fticket.id])).rows[0].status === 'queued',
       'and that refused breakdown left the foreign ticket untouched (still queued, no work item)');
    const fItem = (await selfWorkNew(fmanager, { title: 'pv: their own card', kind: 'activity' })).item;
    const foreignUnassign = await selfWorkUnassign(manager, { item: fItem.id });
    ok(foreignUnassign.ok === false && /another project/.test(foreignUnassign.error),
       "…and unassigning a card on somebody else's plan");
    ok(await items() === before && await items(FID) === beforeF + 1,
       'nothing crossed a project boundary (the one new foreign row is its OWN manager\'s)');

    const noTitle = await selfWorkNew(manager, {});
    ok(noTitle.ok === false && /--title/.test(noTitle.error), 'work --new needs a title, and says so');
    const badKind = await selfWorkNew(manager, { title: 'pv: nonsense', kind: 'epic' });
    ok(badKind.ok === false && /unknown work item kind/.test(badKind.error),
       'an unknown kind is refused with the vocabulary (the domain\'s answer, not a second list)');
    const badParent = await selfWorkNew(manager, { title: 'pv: nonsense', parent: 'nope' });
    ok(badParent.ok === false && /not a valid/.test(badParent.error), 'a malformed --parent names the field');
    const goneParent = await selfWorkNew(manager,
      { title: 'pv: nonsense', parent: '00000000-0000-4000-8000-0000000000ff' });
    ok(goneParent.ok === false && /no work item/.test(goneParent.error), 'and an unknown one is a 404 sentence');
    const noItem = await selfWorkUnassign(manager, {});
    ok(noItem.ok === false && /--item/.test(noItem.error), 'unassign needs an item, and says so');
    ok(foreignUnassign.error.includes(fItem.title),
       "and the cross-project unassign NAMES the card, like the --parent refusal does");

    // Two refusals that reached the manager as raw postgres. A verb this careful about sentences
    // must not answer 'duplicate key value violates unique constraint "work_item_one_project_root"'
    // or '…violates check constraint "work_item_priority_check"' — neither says what to do.
    const secondRoot = await selfWorkNew(manager, { title: 'pv: a second root', kind: 'project' });
    ok(secondRoot.ok === false && !/constraint/.test(secondRoot.error) && /root/i.test(secondRoot.error),
       'kind=project is refused with a sentence (one root per project), not a unique-constraint error');
    const bigPriority = await selfWorkNew(manager, { title: 'pv: shouty', priority: 99, parent: home.id });
    ok(bigPriority.ok === false && !/constraint/.test(bigPriority.error) && /1(–|-| to )5/.test(bigPriority.error),
       'and priority 99 is refused with the range, not a check-constraint error');
    const zeroPriority = await selfWorkNew(manager, { title: 'pv: zero', priority: 0, parent: home.id });
    ok(zeroPriority.ok === false && /1(–|-| to )5/.test(zeroPriority.error), '…same at the other end (0)');
    const okPriority = await selfWorkNew(manager, { title: 'pv: legal priority', priority: 5, parent: home.id });
    ok(okPriority.ok && okPriority.item.priority === 5, '…and a legal one still goes through');
  }

  // ── 5. the plumbing: routes, CLI, manual (house rule 8) ──────────────────
  {
    const routes = readFileSync(join(ROOT, 'server/src/api/routes.js'), 'utf8');
    for (const p of ['/xell/self/work/new', '/xell/self/work/breakdown', '/xell/self/work/unassign']) {
      ok(routes.includes(`router.post('${p}'`), `the API carries POST ${p}`);
    }
    const cli = readFileSync(join(ROOT, 'scripts/zee'), 'utf8');
    ok(/case 'breakdown':/.test(cli) && /case 'unassign':/.test(cli),
       'the CLI implements `zee breakdown` and `zee unassign`');
    ok(/rest\.includes\('--new'\)/.test(cli), 'and `zee work --new`');
    ok(cli.includes('/api/xell/self/work/new') && cli.includes('/api/xell/self/work/breakdown')
       && cli.includes('/api/xell/self/work/unassign'), 'each posting to its own route');
    ok(/--after <sibling-id>/.test(cli) && /\bafter: flag\('after'\)/.test(cli),
       'the CLI advertises and sends --after <sibling-id>');
    ok(/after: b\.after/.test(routes), 'and the route passes it through to the verb');

    // The manual is a harness memory row (080), so this reads the DB — the same source
    // test/cxell-cli-drift.test.mjs lints. `dev-lead` and `queenzee-minister` inherit `manager`.
    const { effectiveHarness, harnessLayerText } = await import('../server/src/lib/harness.js');
    const rows = (await client.query(
      `SELECT * FROM harness WHERE enabled AND project_id IS NULL AND zee_type='manager'`)).rows;
    ok(rows.length >= 1, `there are system-wide manager harnesses to check (${rows.map((r) => r.key).join(', ')})`);
    for (const row of rows) {
      const text = harnessLayerText(await effectiveHarness(row));
      const gaps = ['work --new', 'breakdown', 'unassign'].filter((v) => !text.includes(`zee ${v}`));
      ok(!gaps.length, `${row.key} is briefed with all three verbs (missing: ${gaps.join(', ') || 'none'})`);
    }

    // `--priority high` is Number('high') → NaN → JSON null → the card silently took the default 3.
    // Run the real CLI: the guard is before the request, so no server and no token are needed.
    const bad = spawnSync(process.execPath, [join(ROOT, 'scripts/zee'), 'work', '--new',
      '--title', 'pv: cli', '--priority', 'high'], { encoding: 'utf8', env: { ...process.env, ZEEHIVE_API: 'http://127.0.0.1:1' } });
    ok(bad.status === 1 && /priority/i.test(`${bad.stderr}${bad.stdout}`)
       && /1(–|-| to )5/.test(`${bad.stderr}${bad.stdout}`),
       'the CLI refuses a non-numeric --priority before it sends anything (exit 1, naming the range)');

    // The manual's plan-cutting section is guarded so the migration is re-runnable. 123 guarded on the
    // string "zee breakdown", which a HUMAN could have typed into the manual while asking for the verb
    // — and then the section silently never lands, on a database nobody would think to check. The
    // guard belongs on the section's own heading.
    const guardOn = readFileSync(join(ROOT, 'db/migrations/124_manager_manual_plan_verbs_guard.sql'), 'utf8');
    ok(/txt LIKE '%### Cutting the plan yourself%'/.test(guardOn),
       '124 re-anchors the guard on the section HEADING, not on a verb name a human might mention');
    ok(guardOn.includes('harness_memory_put') && guardOn.includes('harness_memory_get')
       && !/jsonb_set/.test(guardOn), 'and edits harness memory BY PATH through the helper (house rule 9)');
    const manualBefore = (await client.query(
      `SELECT harness_memory_get('manager','memory/manager-zee-manual.md') t`)).rows[0].t;
    const memBefore = (await client.query(
      `SELECT jsonb_array_length(bundle->'memory') n FROM harness WHERE key='manager'`)).rows[0].n;
    await client.query(guardOn);
    const manualAfter = (await client.query(
      `SELECT harness_memory_get('manager','memory/manager-zee-manual.md') t`)).rows[0].t;
    ok(manualAfter === manualBefore, 're-running 124 on a manual that already has the section changes nothing');
    ok((await client.query(`SELECT jsonb_array_length(bundle->'memory') n FROM harness WHERE key='manager'`))
       .rows[0].n === memBefore, '…and every sibling memory entry is still there');
    ok(/### Cutting the plan yourself/.test(manualAfter),
       'and the section is in the manual this database holds');

    // THE HOLE ITSELF, exercised: a manual that MENTIONS the verb and has no section. 123 guards on
    // the verb NAME, so it RETURNS and the section never lands — silently, on that one database, with
    // cxell-cli-drift §e still green because it lints that the verb is mentioned. 124 guards on the
    // heading, so it lands the section anyway. Inside a transaction that is ROLLED BACK: the manager
    // harness is a real fleet row this test does not own (house rule 1).
    const m123 = readFileSync(join(ROOT, 'db/migrations/123_manager_manual_plan_verbs.sql'), 'utf8');
    const cut = manualAfter.indexOf('### Cutting the plan yourself');
    await client.query('BEGIN');
    try {
      await client.query(`SELECT harness_memory_put('manager','memory/manager-zee-manual.md',$1)`,
        [`${cut > 0 ? manualAfter.slice(0, cut) : manualAfter}\nA manager asked for \`zee breakdown\` here, in prose.\n`]);
      await client.query(m123);
      const after123 = (await client.query(
        `SELECT harness_memory_get('manager','memory/manager-zee-manual.md') t`)).rows[0].t;
      ok(!/### Cutting the plan yourself/.test(after123),
         '123 alone silently SKIPS a manual that merely mentions `zee breakdown` — the section never lands');
      await client.query(guardOn);
      const after124 = (await client.query(
        `SELECT harness_memory_get('manager','memory/manager-zee-manual.md') t`)).rows[0].t;
      ok(/### Cutting the plan yourself/.test(after124),
         '…and 124 lands it on that same manual, because its guard is the HEADING');
      ok(/A manager asked for `zee breakdown` here, in prose\./.test(after124),
         "…without touching what the human had written");
    } finally { await client.query('ROLLBACK'); }
    ok((await client.query(`SELECT harness_memory_get('manager','memory/manager-zee-manual.md') t`))
       .rows[0].t === manualAfter, 'and the manual this database holds is exactly as it was found');
  }
} catch (e) {
  console.error(`\n  ✗ THREW: ${e.stack || e.message}`);
  fail++;
} finally {
  await cleanup({ files: true });
  await client.end();
  const { pool } = await import('../server/src/db/pool.js');
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
