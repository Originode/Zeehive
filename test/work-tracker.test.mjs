// WORK TRACKER (part 1: schema + libs) — the integration test for the layer ZEEHIVE was missing.
//
// Stands up TWO isolated throwaway projects in the real meta DB and exercises the whole work
// tracker without an HTTP server or a single agent:
//
//   1. the ROOT rule: a new project row gets exactly one kind='project' work item, by trigger, and
//      a second one is impossible;
//   2. tickets: per-project numbering by trigger, comments, the free-text list, work_items_count;
//   3. BREAKDOWN — a ticket becomes a project→activity→task tree in one call, is linked to every
//      item, and stops being 'queued';
//   4. the materialized path/depth: correct on insert, and rewritten for the WHOLE subtree when an
//      item moves;
//   5. the impossibilities, each refused by the DATABASE with a readable sentence: a cross-project
//      parent, an activity under a task, a cycle, a self-dependency, a cross-project dependency,
//      and (in the lib) deleting a project root;
//   6. statuses: the transition rules from work-status.js, closed_at stamped on a terminal status
//      and CLEARED on reopen, and that closing a parent does NOT close its children;
//   7. the read models: the board's columns/cards/breadcrumbs, and the gantt's date + progress
//      roll-ups with unscheduled rows flagged rather than invented;
//   8. work-status.js itself — the pure vocabulary both the server and the web read.
//
// Everything it creates is torn down in a finally, whatever happens. NO test data is left behind.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-0000000058a1';
const PID2 = '00000000-0000-4000-8000-0000000058a2';

// refuses(): run something that MUST fail, and assert the message is one a human can read.
const refuses = async (fn, re, what) => {
  try { await fn(); ok(false, `${what} — NOT refused (it succeeded)`); }
  catch (e) {
    const msg = String(e.message).split('\n')[0];
    ok(re.test(msg), `${what} — refused: "${msg.slice(0, 90)}"`);
  }
};

async function cleanup() {
  // session_event.xell_id is ON DELETE SET NULL, so dropping the project would leave our tend rows
  // behind as orphans nobody can trace. House rule #1 is "no test data" — they go first, found by
  // the source tag this test writes them with.
  try { await client.query(`DELETE FROM session_event WHERE source='worktracker-test'`); } catch { /* */ }
  try { await client.query(`DELETE FROM project WHERE id = ANY($1::uuid[])`, [[PID, PID2]]); } catch { /* */ }
}

try {
  await client.connect();
  await cleanup();

  const W = await import('../server/src/lib/work-items.js');
  const T = await import('../server/src/lib/tickets.js');
  const S = await import('../server/src/lib/work-status.js');
  const { pool } = await import('../server/src/db/pool.js');

  // ── 8 (first, it is pure): the vocabulary ────────────────────────────────
  section('the vocabulary (work-status.js)');
  ok(S.WORK_STATUS_KEYS.join(',') === 'queued,assigned,working,blocked,review,shipping,done,cancelled',
     'work_status is the zee lifecycle plus blocked/review/shipping, in column order');
  ok(S.isTerminal('done') && S.isTerminal('cancelled') && !S.isTerminal('working'),
     'done and cancelled are the terminal states, nothing else is');
  ok(S.workLabel('shipping') === 'shipping' && S.workLabel(null) === '—', 'workLabel answers for every key');
  ok(S.statusFromHive('occ-working') === 'working' && S.statusFromHive('occ-claimed') === 'assigned'
     && S.statusFromHive('occ-idle') === 'assigned' && S.statusFromHive('occ-tendRequest') === 'blocked',
     'a live hive status maps onto the work vocabulary (working/assigned/blocked)');
  ok(S.statusFromHive('occ-landRequest') === 'review' && S.statusFromHive('occ-landHint') === 'review'
     && S.statusFromHive('occ-shipRequest') === 'shipping' && S.statusFromHive('occ-shipHint') === 'shipping'
     && S.statusFromHive('occ-done') === 'done' && S.statusFromHive('occ-doneRequest') === 'done',
     'land/ship/done — request AND hint — map to review/shipping/done');
  ok(S.statusFromHive('vac-ready') === null && S.statusFromHive('live-protected') === null
     && S.statusFromHive(undefined) === null,
     'anything else maps to NULL — a status is never invented from a hive state that implies none');
  ok(S.nextStatuses('working').includes('cancelled') && S.nextStatuses('done').join(',') === 'queued,review,cancelled',
     'anything may be cancelled; a terminal item reopens to queued — and done may reopen to review (ticket #56)');
  ok(!S.canTransition('done', 'working') && S.canTransition('done', 'queued') && S.canTransition('queued', 'working'),
     'a done item cannot jump straight back to working — it reopens through queued');
  const vocab = S.workStatusVocabulary();
  ok(vocab.statuses.length === 8 && vocab.statuses[0].key === 'queued' && vocab.item_kinds.length === 3
     && vocab.ticket_kinds.length === 5,
     'the vocabulary endpoint payload carries statuses + item kinds + ticket kinds');

  // ── 1: the project ROOT, by trigger ──────────────────────────────────────
  section('every project gets exactly one root');
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'worktracker-test',$2,'master')`,
    [PID, '/tmp/worktracker-test']);
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'worktracker-test-2',$2,'master')`,
    [PID2, '/tmp/worktracker-test-2']);

  const root = await W.projectRoot(PID);
  ok(root && root.kind === 'project' && root.title === 'worktracker-test' && root.parent_id === null
     && root.path === '' && root.depth === 0,
     `a new project row gets its root work item by trigger (title "${root?.title}", depth ${root?.depth})`);
  await refuses(() => client.query(
    `INSERT INTO work_item (project_id, kind, title) VALUES ($1,'project','a second root')`, [PID]),
    /duplicate key|unique/i, 'a SECOND project-kind root in the same project');
  await refuses(() => client.query(
    `INSERT INTO work_item (project_id, parent_id, kind, title) VALUES ($1,$2,'project','nested project')`,
    [PID, root.id]), /work_item_project_is_root|violates check/i, 'a project-kind item with a parent');

  // ── 2: tickets ───────────────────────────────────────────────────────────
  section('tickets');
  const t1 = await T.createTicket({ project_id: PID, title: 'Board flickers on drag', kind: 'bug',
                                    reporter: 'mark', priority: 2, labels: ['ui'] });
  const t2 = await T.createTicket({ project_id: PID, title: 'Gantt for the roadmap', kind: 'feature' });
  const other = await T.createTicket({ project_id: PID2, title: 'unrelated', kind: 'chore' });
  ok(t1.number === 1 && t2.number === 2, `ticket numbers are a per-project sequence (#${t1.number}, #${t2.number})`);
  ok(other.number === 1, 'and they restart per project — the other project also starts at #1');
  ok(t1.ref === '#1' && t1.status === 'queued' && t1.labels.join() === 'ui', 'a new ticket is queued, with its labels');

  await T.addComment(t1.id, { author: 'mark', body: 'happens only in Chrome' });
  const listed = await T.listTickets({ projectId: PID });
  ok(listed.length === 2 && listed.every((t) => t.work_items_count === 0), 'the list is project-scoped, with work_items_count');
  const searched = await T.listTickets({ projectId: PID, q: 'gantt' });
  ok(searched.length === 1 && searched[0].id === t2.id, 'the free-text search finds a ticket by title');
  ok((await T.listTickets({ projectId: PID, kind: 'bug' })).length === 1, 'and it filters by kind');

  // ── 3: BREAKDOWN — a ticket becomes a plan ───────────────────────────────
  section('breakdown: a ticket becomes a tree');
  const bd = await T.breakdownTicket(t1.id, {
    actor: 'test',
    items: [
      { ref: 'act', kind: 'activity', title: 'Fix the board drag', priority: 2, starts_on: '2026-08-03', due_on: '2026-08-07' },
      { ref: 'a', kind: 'task', parent_id: 'act', title: 'Reproduce the flicker', estimate_hours: 2, progress: 100, status: 'done', starts_on: '2026-08-03', due_on: '2026-08-04' },
      { ref: 'b', kind: 'task', parent_id: 'act', title: 'Fix the reorder write', estimate_hours: 5, progress: 50, starts_on: '2026-08-05', due_on: '2026-08-07' },
      { ref: 'c', kind: 'task', parent_id: 'b', title: 'Regression test' },
    ],
  });
  ok(bd.count === 4 && bd.created.every((i) => i.ticket_id === t1.id), 'four items created, all linked to the ticket');
  const act = bd.created.find((i) => i.title === 'Fix the board drag');
  const taskA = bd.created.find((i) => i.title === 'Reproduce the flicker');
  const taskB = bd.created.find((i) => i.title === 'Fix the reorder write');
  const taskC = bd.created.find((i) => i.title === 'Regression test');
  ok(act.parent_id === root.id && act.depth === 1 && act.path === `${root.id}/`,
     'the activity defaulted to the PROJECT ROOT as its parent (depth 1)');
  ok(taskA.parent_id === act.id && taskA.depth === 2 && taskA.path === `${root.id}/${act.id}/`,
     'a task named its sibling by local ref and landed under the activity (depth 2)');
  ok(taskC.depth === 3 && taskC.path === `${root.id}/${act.id}/${taskB.id}/`,
     'a subtask under a task is depth 3, with the full ancestor path');
  ok(bd.ticket.status === 'assigned' && bd.ticket.work_item_id === act.id,
     'the ticket left queued and now points at the top of what it became');
  ok(bd.tree.length === 1 && bd.tree[0].children.length === 2,
     'the answer carries the created TREE, not just a flat list');
  ok((await T.listTickets({ projectId: PID })).find((t) => t.id === t1.id).work_items_count === 4,
     'the ticket list now counts four work items on it');

  // a plain create with no parent also lands under the root — "everything is a descendant"
  const loose = await W.createWorkItem({ project_id: PID, title: 'Loose end', kind: 'task' });
  ok(loose.parent_id === root.id && loose.depth === 1, 'a work item created with NO parent is attached to the project root');

  // ── 4: the move rewrites the whole subtree ───────────────────────────────
  section('a move takes the whole subtree with it');
  const act2 = await W.createWorkItem({ project_id: PID, title: 'Ship it', kind: 'activity', actor: 'test' });
  const movedB = await W.moveWorkItem(taskB.id, { parent_id: act2.id }, { actor: 'test' });
  ok(movedB.parent_id === act2.id && movedB.depth === 2 && movedB.path === `${root.id}/${act2.id}/`,
     'the moved task hangs off its new parent, with a new path and depth');
  const afterC = await W.getWorkItem(taskC.id);
  ok(afterC.path === `${root.id}/${act2.id}/${taskB.id}/` && afterC.depth === 3,
     'and its DESCENDANT followed — path/depth rewritten by the trigger, not by the caller');
  ok(afterC.breadcrumb.join(' / ') === `worktracker-test / Ship it / Fix the reorder write`,
     `the descendant's breadcrumb reads down the new lineage (${afterC.breadcrumb.join(' / ')})`);
  ok(afterC.ancestors.length === 3 && afterC.ancestors[0].id === root.id,
     'ancestors come back in path order, root first');

  // ── 5: the impossibilities ───────────────────────────────────────────────
  section('the impossibilities (enforced in the database)');
  const root2 = await W.projectRoot(PID2);
  await refuses(() => W.createWorkItem({ project_id: PID, parent_id: root2.id, title: 'cross', kind: 'task' }),
    /same project/i, 'a child whose parent is in ANOTHER project');
  await refuses(() => client.query(
    `INSERT INTO work_item (project_id, parent_id, kind, title) VALUES ($1,$2,'activity','upward')`,
    [PID, taskC.id]), /cannot be nested under/i, 'an ACTIVITY under a task (nesting upward)');
  // taskC is taskB's child, and both are tasks — so the RANK check passes and the cycle check is
  // the only thing that can refuse this.
  await refuses(() => W.moveWorkItem(taskB.id, { parent_id: taskC.id }),
    /descendant of itself|cycle/i, 'a move that would make an item its own descendant (a cycle)');
  await refuses(() => W.moveWorkItem(act2.id, { parent_id: act2.id }),
    /own parent|cycle|descendant/i, 'an item parented to ITSELF');
  await refuses(() => W.deleteWorkItem(root.id), /root item/i, "deleting the project's ROOT item");
  await refuses(() => W.moveWorkItem(root.id, { parent_id: act2.id }), /root item/i, 'moving the project root under something');
  await refuses(() => W.addDep(taskC.id, taskC.id), /itself/i, 'a work item depending on itself');
  const foreign = await W.createWorkItem({ project_id: PID2, title: 'foreign task', kind: 'task' });
  await refuses(() => W.addDep(taskC.id, foreign.id), /cross projects/i, 'a dependency across projects');

  // the legal dependency works, and reads from both ends
  await W.addDep(taskB.id, taskA.id, { actor: 'test' });
  const bView = await W.getWorkItem(taskB.id);
  const aView = await W.getWorkItem(taskA.id);
  ok(bView.deps.length === 1 && bView.deps[0].id === taskA.id, 'a finish→start dependency is recorded');
  ok(aView.dependents.length === 1 && aView.dependents[0].id === taskB.id, 'and the other end sees its dependent');
  ok((await W.removeDep(taskB.id, taskA.id))?.ok === true, 'and it can be removed');
  await W.addDep(taskB.id, taskA.id);   // put it back for the gantt

  // ── 6: statuses ──────────────────────────────────────────────────────────
  section('statuses, closed_at and NO auto-closing of children');
  await refuses(() => W.setStatus(taskC.id, 'finished'), /unknown status/i, 'an unknown status');
  await refuses(() => W.setStatus(taskA.id, 'working'),
    /cannot move|legal next/i, 'a done item jumping straight back to working');
  const rowA0 = await client.query(`SELECT closed_at FROM work_item WHERE id=$1`, [taskA.id]);
  ok(rowA0.rows[0].closed_at !== null, 'a terminal status stamped closed_at');
  await W.setStatus(taskA.id, 'queued', { actor: 'test' });
  const rowA1 = await client.query(`SELECT closed_at, status FROM work_item WHERE id=$1`, [taskA.id]);
  ok(rowA1.rows[0].closed_at === null && rowA1.rows[0].status === 'queued',
     'reopening it CLEARED closed_at — "closed" and "terminal" can never disagree');

  await W.setStatus(taskB.id, 'working', { actor: 'test' });
  const act2View = await W.getWorkItem(act2.id);
  await W.setStatus(act2.id, 'done', { actor: 'test' });
  const stillOpen = await W.getWorkItem(taskB.id);
  ok(stillOpen.status === 'working', 'closing a PARENT did not close its child');
  const parentView = await W.getWorkItem(act2.id);
  ok(parentView.open_children === 1 && parentView.open_descendant_count === 2,
     `the read model reports open_children (${parentView.open_children}) so a UI can warn instead`);
  await W.setStatus(act2.id, 'queued');
  const casc = await W.setStatus(act2.id, 'cancelled', { actor: 'test', cascade: true });
  ok(casc.cascaded === 2, `cascade is OPT-IN and, when asked for, took the subtree with it (${casc.cascaded} items)`);
  // …and reopening is the only way back out of a terminal status (queued first, then onward)
  for (const id of [act2.id, taskB.id, taskC.id]) await W.setStatus(id, 'queued');
  await W.setStatus(taskB.id, 'working');

  const events = (await W.getWorkItem(taskB.id)).events;
  ok(events.some((e) => e.kind === 'created') && events.some((e) => e.kind === 'moved')
     && events.some((e) => e.kind === 'status' && e.to_status === 'working'),
     'every mutation left an event: created, moved, status');

  // ── a LIVE zee on a work item ────────────────────────────────────────────
  section('the zee on an item');
  // A real xell row (its own xource), put on a work item exactly as part 2 will. This is what makes
  // live_status meaningful: the card shows what the zee is ACTUALLY doing, derived by
  // lib/hive-status.js from the same signals the honeycomb reads — never written back to status.
  const XOID = '00000000-0000-4000-8000-0000000058b1';
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [XOID, PID]);
  const xell = (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, is_pooled)
       VALUES ($1,$2,'wt-worker','spinoff/wt-worker','working',false) RETURNING *`, [PID, XOID])).rows[0];
  await W.updateWorkItem(loose.id, { xell_id: xell.id }, { actor: 'test' });

  const withZee = await W.getWorkItem(loose.id);
  ok(withZee.zee && withZee.zee.slug === 'wt-worker' && withZee.zee.hive_status === 'occ-working'
     && withZee.zee.hive_status_label === 'working',
     `the item carries the LIVE xell row, in the hive's own words (${withZee.zee?.hive_status})`);
  ok(withZee.live_status === 'working', 'and live_status is what that hive status implies for the work');
  ok(withZee.status === 'queued',
     'while the STORED status is untouched — a live zee never silently moves a card between columns');
  ok(withZee.events.some((e) => e.kind === 'assigned'),
     'putting a zee on an item is its own event kind (assigned), not an anonymous edit');

  // a tend (a zee stopped, waiting on a human) reads as BLOCKED on the board
  await client.query(
    `INSERT INTO session_event (xell_id, source, hook_event_name, raw)
       VALUES ($1,'worktracker-test','tend-request','{"reason":"which db?"}'::jsonb)`, [xell.id]);
  const blocked = await W.getWorkItem(loose.id);
  ok(blocked.zee.hive_status === 'occ-tendRequest' && blocked.live_status === 'blocked',
     'a zee raising a tend makes the item read live_status=blocked (it is waiting on a human)');

  // ── REGRESSION: a REAPED xell must not keep answering for the item ───────
  //
  // reapXell never deletes the xell row — it sets status='retired' — so work_item.xell_id keeps
  // pointing at a corpse and ON DELETE SET NULL never fires. The corpse used to answer: hiveStatus
  // had no case for 'retired' and fell through to its 'occ-claimed' fallback, so a card reported a
  // live zee ('assigned') on work whose agent had been gone for a week. Worse with an open landing:
  // the reaper releases open SHIPS but never land requests, so it read 'review' instead.
  //
  // This replays exactly what reapXell writes, in its order, rather than trusting a description of
  // it: zee → stopped/decommissioned, owned containers deleted, xell → retired.
  section('a reaped xell stops speaking for the work');
  await client.query(
    `INSERT INTO land_request (project_id, xell_id, status, new_sha, ref)
       VALUES ($1,$2,'pending','deadbeef','refs/heads/main')`, [PID, xell.id]);
  const midLanding = await W.getWorkItem(loose.id);
  ok(midLanding.zee.hive_status === 'occ-landRequest' && midLanding.live_status === 'review',
     'while the xell is ALIVE, a held landing legitimately reads live_status=review');

  await client.query(`UPDATE zee SET status='stopped', name=NULL, decommissioned_at=now() WHERE xell_id=$1`, [xell.id]);
  await client.query(`DELETE FROM container WHERE owner_xell_id=$1`, [xell.id]);
  await client.query(`UPDATE xell SET status='retired', retired_at=now(), is_pooled=false WHERE id=$1`, [xell.id]);

  const reaped = await W.getWorkItem(loose.id);
  ok(reaped.zee === null, 'after the reap the item reports NO zee (not a corpse that answers)');
  ok(reaped.live_status === null, 'and live_status is null — no invented "assigned"');
  ok(reaped.status === 'queued',
     'while the STORED status is untouched: the AGENT is gone, the WORK is not finished');
  ok(reaped.xell_id === xell.id,
     'the xell_id stays on the row as HISTORY (part 2/3 builds "was: <slug>" from it + the ledger)');
  ok((await client.query(
    `SELECT count(*)::int n FROM land_request WHERE xell_id=$1 AND status='pending'`, [xell.id])).rows[0].n === 1,
     'the land request really is still open — the reaper never dismisses one');
  ok(reaped.live_status !== 'review',
     '…yet "blocked on a human" does NOT outlive the agent: a dead xell lends the item no signal at all');

  const reapedBoard = await W.boardModel({ projectId: PID });
  const reapedCard = reapedBoard.columns.flatMap((c) => c.items).find((c) => c.id === loose.id);
  ok(reapedCard.zee === null && reapedCard.live_status === null, 'and the BOARD card says the same');
  ok((await W.liveZees([xell.id])).size === 0, 'liveZees resolves a retired xell to nothing at all');

  // hive-status.js keeps its contract for everyone who already filters retired (fleet.js,
  // managers.crewFor); the new case only stops the fallback speaking for a row it knows nothing of.
  const { hiveStatus, hiveLabel } = await import('../server/src/lib/hive-status.js');
  ok(hiveStatus({ status: 'retired' }) === null, 'hiveStatus answers NULL for a retired xell, not occ-claimed');
  ok(hiveLabel(null) === '—', 'and hiveLabel(null) was already the dash — no new vocabulary needed');
  ok(hiveStatus({ status: 'working', zee_status: 'working' }) === 'occ-working'
     && hiveStatus({ status: 'claimed' }) === 'occ-claimed'
     && hiveStatus({ status: 'ready' }) === 'vac-ready'
     && hiveStatus({ status: 'husk' }) === 'vac-dirty'
     && hiveStatus({ status: 'tearing-down' }) === 'occ-done'
     && hiveStatus({ status: 'awaiting-done' }) === 'occ-doneRequest'
     && hiveStatus({ is_production: true }, { prodUnprotected: true }) === 'live-unprotected',
     'every OTHER derivation is byte-for-byte unchanged (fleet.js cannot have shifted)');
  ok(hiveStatus({ status: 'working' }, { landPending: true }) === 'occ-landRequest'
     && hiveStatus({ status: 'working' }, { tendPending: true }) === 'occ-tendRequest',
     'and the signal precedence is untouched');

  // put the xell back so the rest of the file exercises a LIVE zee as before
  await client.query(`DELETE FROM land_request WHERE xell_id=$1`, [xell.id]);
  await client.query(`UPDATE xell SET status='working', retired_at=NULL WHERE id=$1`, [xell.id]);
  await client.query(`UPDATE zee SET status='working', decommissioned_at=NULL WHERE xell_id=$1`, [xell.id]);
  ok((await W.getWorkItem(loose.id)).zee?.hive_status === 'occ-tendRequest',
     'and a xell brought back to life resolves again (the filter is on state, not a tombstone)');

  // ── 7: the read models ───────────────────────────────────────────────────
  section('the board');
  const board = await W.boardModel({ projectId: PID });
  ok(board.columns.length === 8 && board.columns[0].key === 'queued' && board.columns[7].key === 'cancelled',
     'one column per work_status, in the vocabulary order');
  ok(board.root.id === root.id, 'the board is rooted on the project root');
  const allCards = board.columns.flatMap((c) => c.items);
  ok(allCards.length === 6 && !allCards.some((c) => c.kind === 'project'),
     `cards are the whole subtree of the root, excluding the root itself (${allCards.length} cards)`);
  const cardB = allCards.find((c) => c.id === taskB.id);
  ok(cardB && board.columns.find((c) => c.key === 'working').items.some((i) => i.id === taskB.id),
     "a card sits in the column of its STORED status");
  ok(cardB.breadcrumb.join(' / ') === 'worktracker-test / Ship it', 'a card carries its ancestor breadcrumb');
  ok(cardB.ticket && cardB.ticket.number === 1, 'and the ticket it came from (number + title)');
  ok(cardB.zee === null && cardB.live_status === null,
     'with no zee on it, zee and live_status are null (never invented)');
  const cardLoose = allCards.find((c) => c.id === loose.id);
  ok(cardLoose.zee?.slug === 'wt-worker' && cardLoose.live_status === 'blocked'
     && cardLoose.status === 'queued',
     'a card with a zee on it carries the zee AND an advisory live_status, in its stored column');
  ok(board.columns.find((c) => c.key === 'queued').items.some((i) => i.id === loose.id),
     'a queued item is in the queued column');

  section('the gantt');
  // A genuinely dateless row, created BEFORE the model so it is in the rows below — its ledger has
  // a 'created' event and nothing else, so it has no actual and no plan, and the gantt must list it
  // rather than invent dates for it.
  const noDates = await W.createWorkItem({ project_id: PID, title: 'never started', kind: 'task' });
  const gantt = await W.ganttModel({ projectId: PID });
  const byId = new Map(gantt.rows.map((r) => [r.id, r]));
  ok(gantt.rows[0].id === root.id && gantt.rows[0].depth === 0, 'rows come back in TREE order, root first');
  const idx = (id) => gantt.rows.findIndex((r) => r.id === id);
  ok(idx(act.id) < idx(taskA.id) && idx(act2.id) < idx(taskB.id) && idx(taskB.id) < idx(taskC.id),
     'depth-first: every parent immediately precedes its own children');
  ok(byId.get(act.id).computed_start === '2026-08-03' && byId.get(act.id).computed_end === '2026-08-07',
     'an item with its OWN dates keeps them');
  ok(byId.get(act2.id).starts_on === null && byId.get(act2.id).computed_start === '2026-08-05'
     && byId.get(act2.id).computed_end === '2026-08-07',
     'a parent with no dates spans min(children start) … max(children end)');
  ok(byId.get(root.id).computed_start === '2026-08-03' && byId.get(root.id).computed_end === '2026-08-07',
     'and the roll-up climbs all the way to the root');
  // taskC was cancelled (and reopened) by the cascade test above, so the RECORD proves it ended once
  // — it is no longer "undated". The genuinely dateless row created above is what the unscheduled
  // flag is for: its ledger has no start AND no end, so the gantt has nothing to draw and lists it.
  ok(byId.get(noDates.id).unscheduled === true && byId.get(noDates.id).computed_start === null
     && byId.get(noDates.id).actual_start === null && byId.get(noDates.id).actual_end === null,
     'a row with no dates anywhere (no plan, no actual) is FLAGGED unscheduled — no invented dates');
  ok(byId.get(taskC.id).unscheduled === false && byId.get(taskC.id).actual_end !== null,
     'a row the RECORD ended (a terminal event, even one later reopened) is not undated');
  ok(gantt.unscheduled_count >= 1, `the model counts them (${gantt.unscheduled_count}) so the UI can list them`);
  await W.deleteWorkItem(noDates.id);   // it served its assertion; the tree below expects its original shape
  ok(byId.get(taskB.id).rolled_progress === 50 && byId.get(taskB.id).progress === 50,
     'a leaf rolls up to its own progress');
  ok(byId.get(act2.id).progress === 0 && byId.get(act2.id).rolled_progress > 0,
     `a parent with no explicit progress averages its children (${byId.get(act2.id).rolled_progress}%)`);
  ok(byId.get(taskB.id).deps.includes(taskA.id), 'dependency edges ride on the row that depends');

  // ── REGRESSION: a work item may not finish before it starts ──────────────
  //
  // The API used to accept PATCH {starts_on:'2026-08-10', due_on:'2026-08-01'} with a 200, and the
  // gantt then reported computed 2026-08-10 → 2026-08-01. A chart cannot draw a negative bar, so it
  // renders a stub — visually IDENTICAL to a legitimate one-day task. The schedule was wrong and the
  // picture looked right, which is the worst pair of properties a read model can have.
  section('the schedule cannot run backwards');
  const sched = await W.createWorkItem({ project_id: PID, title: 'scheduled thing', kind: 'task',
                                         starts_on: '2026-08-10', due_on: '2026-08-20' });
  await refuses(() => W.updateWorkItem(sched.id, { starts_on: '2026-08-10', due_on: '2026-08-01' }),
    /may not finish before it starts/, 'PATCHing an inverted pair');
  await refuses(() => W.createWorkItem({ project_id: PID, title: 'born backwards', kind: 'task',
                                         starts_on: '2026-08-10', due_on: '2026-08-01' }),
    /may not finish before it starts/, 'CREATING an item already inverted');
  // half a pair is the sneaky one: patching ONE date must be checked against the STORED other
  await refuses(() => W.updateWorkItem(sched.id, { due_on: '2026-08-01' }),
    /may not finish before it starts/, 'PATCHing due_on ALONE back past the stored starts_on');
  await refuses(() => W.updateWorkItem(sched.id, { starts_on: '2026-09-01' }),
    /may not finish before it starts/, 'PATCHing starts_on ALONE forward past the stored due_on');
  ok((await W.getWorkItem(sched.id)).due_on === '2026-08-20', 'and none of those refusals changed the row');

  // the DATABASE is the wall, not the lib: a direct UPDATE is refused too
  try {
    await client.query(`UPDATE work_item SET due_on='2026-01-01' WHERE id=$1`, [sched.id]);
    ok(false, 'a direct UPDATE bypassing the lib is refused by the DB');
  } catch (e) {
    ok(/work_item_dates_ordered/.test(e.message), 'a direct UPDATE bypassing the lib is refused by the DB (060)');
  }

  // what remains LEGAL: equal dates (a one-day task), and either end missing
  const oneDay = await W.updateWorkItem(sched.id, { starts_on: '2026-08-10', due_on: '2026-08-10' });
  ok(oneDay.due_on === '2026-08-10', 'equal dates are fine — that is a real one-day task');
  ok((await W.updateWorkItem(sched.id, { due_on: '' })).due_on === null,
     'clearing due_on is fine — "starts then, no end yet" is an ordinary state');

  // ── span: a FACT the client can clamp on, never a truncation ─────────────
  section('the gantt states its span instead of guessing');
  ok(W.spanDays('2026-08-01', '2026-08-01') === 1, 'a task starting and ending the same day spans 1 day, not 0');
  ok(W.spanDays('2026-08-01', '2026-08-31') === 31, 'an inclusive month spans 31');
  ok(W.spanDays('2026-08-01', null) === null && W.spanDays(null, null) === null, 'a missing end has no span');
  // the absurd-but-legal schedule is returned FAITHFULLY, with its size stated
  await W.updateWorkItem(sched.id, { starts_on: '0001-01-01', due_on: '9999-12-31' });
  const wide = await W.ganttModel({ projectId: PID });
  const wideRow = wide.rows.find((r) => r.id === sched.id);
  ok(wideRow.computed_start === '0001-01-01' && wideRow.computed_end === '9999-12-31',
     'an absurd span is returned faithfully — the year is 4-digit padded, so it actually parses');
  ok(wideRow.span_days === 2958099, `and its size is STATED (${wideRow.span_days} days) so a chart can clamp knowingly`);
  ok(wide.span.days === 2958099 && wide.span.start === '0001-01-01',
     'the model states the whole chart extent too, so a client need not min/max the rows itself');
  ok(wide.rows.filter((r) => r.unscheduled).every((r) => r.span_days === null),
     'an unscheduled row has no span (null), never a fabricated zero');
  await W.deleteWorkItem(sched.id);
  const normal = await W.ganttModel({ projectId: PID });
  ok(normal.span.days > 0 && normal.span.days < 100, `with the absurd row gone the chart is ordinary again (${normal.span.days} days)`);

  section('scoping a view to one branch');
  const sub = await W.ganttModel({ rootId: act2.id });
  ok(sub.rows.length === 3 && sub.rows[0].id === act2.id, 'a gantt can be rooted on any item (its own subtree)');
  const subBoard = await W.boardModel({ rootId: act2.id });
  ok(subBoard.columns.flatMap((c) => c.items).length === 2, 'and so can a board');
  const listedTree = await W.listWorkItems({ projectId: PID, tree: true });
  ok(listedTree.length === 1 && listedTree[0].id === root.id && listedTree[0].children.length === 3,
     'listWorkItems({tree}) nests the whole project under its root');
  ok((await W.listWorkItems({ projectId: PID, status: 'working' })).length === 1, 'and filters flat by status');
  ok((await W.listWorkItems({ projectId: PID, ticketId: t1.id })).length === 4, 'and by ticket');
  ok((await W.listWorkItems({ rootId: act2.id })).length === 3, 'and by root (the subtree, inclusive)');

  // ── REGRESSION: the silent sort_order drop ───────────────────────────────
  //
  // A kanban drag WITHIN one column sends {parent_id: <unchanged>, sort_order: N} — the natural
  // shape for "this card moved, here is where it sits now". The first cut skipped the sort_order
  // write whenever parent_id was merely PRESENT in the patch, and skipped the move because the
  // parent had not changed, so the reorder was dropped: HTTP 200, no error, and the card snapped
  // back on the next reload. Silent wrong answers are the worst failure mode this API can have,
  // and a board is its primary consumer — so it is pinned here.
  section('reordering (the drag a board actually sends)');
  const sibA = await W.createWorkItem({ project_id: PID, title: 'sibling A', kind: 'task' });
  const sibB = await W.createWorkItem({ project_id: PID, title: 'sibling B', kind: 'task' });
  ok(sibB.sort_order > sibA.sort_order, 'a new sibling lands after the existing ones');

  const sameParent = await W.updateWorkItem(sibB.id, { parent_id: sibB.parent_id, sort_order: 500 }, { actor: 'test' });
  ok(sameParent.sort_order === 500,
     `PATCH {parent_id: <UNCHANGED>, sort_order: 500} PERSISTS the rank (got ${sameParent.sort_order})`);
  ok((await W.getWorkItem(sibB.id)).sort_order === 500, 'and it is in the database, not just the answer');
  ok((await W.listWorkItems({ rootId: sibB.parent_id }))
       .filter((i) => i.id !== sibB.parent_id).map((i) => i.title)[0] === 'sibling B',
     'so the reordered card really does sort first among its siblings');

  const alone = await W.updateWorkItem(sibA.id, { sort_order: 250 }, { actor: 'test' });
  ok(alone.sort_order === 250, 'sort_order ALONE (no parent_id) still works');

  const bothMoved = await W.updateWorkItem(sibB.id, { parent_id: act.id, sort_order: 90 }, { actor: 'test' });
  ok(bothMoved.parent_id === act.id && bothMoved.sort_order === 90,
     'a real move carrying a rank applies BOTH (the move places it; the field loop must not re-apply)');
  const movedEvents = (await W.getWorkItem(sibB.id)).events.filter((e) => e.kind === 'moved');
  ok(movedEvents.length === 1, 'and it produced exactly ONE moved event, not two writes');

  // parent_id:null means "move to the project root", not "become a second root"
  const toTop = await W.updateWorkItem(sibB.id, { parent_id: null }, { actor: 'test' });
  ok(toTop.parent_id === root.id && toTop.depth === 1,
     'PATCH {parent_id: null} moves an item to the PROJECT ROOT (it never becomes a root itself)');

  // ── REGRESSION: ids and refs answer like a person, not like postgres ──────
  section('bad ids and bad refs get a sentence, not a cast error');
  await refuses(() => W.getWorkItem('not-a-uuid'), /is not a valid work item id/,
    'a malformed work item id');
  await refuses(() => T.getTicket('nope'), /is not a valid ticket id/, 'a malformed ticket id');
  await refuses(() => W.createWorkItem({ project_id: PID, title: 'x', parent_id: 'bogus' }),
    /is not a valid parent work item id/, 'a malformed parent_id in a create');
  await refuses(() => W.addDep(sibA.id, 'bogus'), /is not a valid depends_on_id/, 'a malformed depends_on_id');
  await refuses(() => W.boardModel({ projectId: 'bogus' }), /is not a valid project id/, 'a malformed project on the board');
  await refuses(() => W.listWorkItems({ projectId: PID, status: 'nonsense' }), /unknown status/, 'an unknown ?status= filter');
  ok((await W.getWorkItem('00000000-0000-4000-8000-00000000dead')) === null,
     'a WELL-FORMED id that names nothing is still simply not found (a 404, not a 400)');

  await refuses(() => T.breakdownTicket(t1.id, { items: [{ title: 'child', parent_id: 'no-such-ref' }] }),
    /neither a work item id nor a ref/, 'a breakdown naming an unknown ref');
  await refuses(() => T.breakdownTicket(t1.id, {
    items: [{ title: 'child', parent_id: 'later' }, { ref: 'later', title: 'parent', kind: 'activity' }],
  }), /neither a work item id nor a ref/, 'a breakdown naming a ref declared LATER (refs resolve backwards only)');

  // ── REGRESSION: the HTTP status is CARRIED, not matched out of the prose ─
  //
  // This used to be a regex over the message text ("cannot", "cycle", "root item"…). That made every
  // refusal sentence load-bearing: reword one and its status flipped silently — no test failing, no
  // log line, and every client branching on 409-vs-400 wrong from then on. The wording and the
  // status are now independent, and these assertions are what keep them that way.
  section('a status is a tag, not a word in a sentence');
  const statusOf = async (fn) => { try { await fn(); return null; } catch (e) { return W.httpStatusOf(e); } };

  ok(await statusOf(() => W.getWorkItem('not-a-uuid')) === 400, 'a malformed id is 400');
  ok(await statusOf(() => W.createWorkItem({ project_id: PID })) === 400, 'a missing title is 400');
  ok(await statusOf(() => W.createWorkItem({ project_id: PID, title: 'x', status: 'nonsense' })) === 400,
     'an unknown status is 400');
  ok(await statusOf(() => W.deleteWorkItem(root.id)) === 409, 'deleting the project root is 409');
  ok(await statusOf(() => W.moveWorkItem(root.id, { parent_id: act.id })) === 409, 'moving the root is 409');
  const doneItem = await W.createWorkItem({ project_id: PID, title: 'finished', kind: 'task', status: 'done' });
  ok(await statusOf(() => W.setStatus(doneItem.id, 'working')) === 409, 'a done item jumping to working is 409');
  await W.deleteWorkItem(doneItem.id);

  // the DATABASE's own refusals are tagged by postgres ERROR CODE (P0001 = our guard triggers),
  // never by their wording — so a trigger message could be rewritten in any language and stay 409
  ok(await statusOf(() => W.createWorkItem({ project_id: PID, parent_id: root2.id, title: 'x', kind: 'task' })) === 409,
     'a cross-project parent (raised by a TRIGGER) is 409, classified by pg error code');
  ok(await statusOf(() => W.addDep(taskC.id, taskC.id)) === 409, 'a self-dependency (trigger) is 409');
  ok(await statusOf(() => W.updateWorkItem(taskC.id, { starts_on: '2026-08-10', due_on: '2026-08-01' })) === 400,
     'an inverted schedule is 400 — bad input, not a conflict');

  // THE POINT: the text cannot move the status, in either direction.
  ok(W.httpStatusOf(Object.assign(new Error('cannot cycle under the root item — legal next'), { status: 400 })) === 400,
     'an error stuffed with every old trigger word stays 400 when it is TAGGED 400');
  ok(W.httpStatusOf(Object.assign(new Error('a perfectly bland sentence'), { status: 409 })) === 409,
     'and a bland sentence is still 409 when it is TAGGED 409');
  ok(W.httpStatusOf(new Error('cannot cycle root item same project nested under cross projects')) === 400,
     'an UNTAGGED error is 400 however many of the old regex words it contains');
  ok(W.httpStatusOf(new Error('anything')) === 400 && W.httpStatusOf(null) === 400,
     'and the fallback for anything untagged is 400, as it always was');
  ok(W.refuse('x').status === 409 && W.bad('x').status === 400 && W.notFound('x').status === 404,
     'the three constructors carry 409 / 400 / 404');
  ok(!readFileSync('server/src/api/routes.js', 'utf8').includes('const CONFLICT ='),
     'and routes.js no longer carries a regex that reads refusal text at all');

  // ── ATOMICITY: a breakdown is ALL or NOTHING ─────────────────────────────
  //
  // A manager breaking a ticket into a plan and getting four of six items, with no error path back
  // to a clean state, is the kind of half-truth this repo refuses everywhere else — a landing is one
  // sha, a seed runs in its own transaction, a ship is all-or-nothing. So is this.
  section('a breakdown is one transaction');
  const atomicTicket = await T.createTicket({ project_id: PID, title: 'atomic breakdown', kind: 'chore' });
  const before6 = (await client.query(`SELECT count(*)::int n FROM work_item WHERE project_id=$1`, [PID])).rows[0].n;
  const sixWithABadFifth = [
    { ref: 'p', kind: 'activity', title: 'one' },
    { kind: 'task', parent_id: 'p', title: 'two' },
    { kind: 'task', parent_id: 'p', title: 'three' },
    { kind: 'task', parent_id: 'p', title: 'four' },
    { kind: 'task', parent_id: 'ref-that-does-not-exist', title: 'five — the bad one' },
    { kind: 'task', parent_id: 'p', title: 'six' },
  ];
  await refuses(() => T.breakdownTicket(atomicTicket.id, { items: sixWithABadFifth, actor: 'test' }),
    /neither a work item id nor a ref/, 'the 5th of 6 entries is rejected');
  const after6 = (await client.query(`SELECT count(*)::int n FROM work_item WHERE project_id=$1`, [PID])).rows[0].n;
  ok(after6 === before6,
     `and ZERO work items survive — the first four were rolled back too (${before6} before, ${after6} after)`);
  ok((await client.query(`SELECT count(*)::int n FROM work_item WHERE ticket_id=$1`, [atomicTicket.id])).rows[0].n === 0,
     'nothing is linked to the ticket');
  const untouched = await T.getTicket(atomicTicket.id);
  ok(untouched.status === 'queued' && untouched.work_item_id === null,
     'and the TICKET is untouched — still queued, still pointing at nothing');
  ok((await client.query(
    `SELECT count(*)::int n FROM work_item_event e LEFT JOIN work_item w ON w.id=e.work_item_id
      WHERE w.id IS NULL`)).rows[0].n === 0,
     'no orphan events were left behind by the rolled-back inserts');

  // the SAME six with the ref fixed builds the whole plan
  sixWithABadFifth[4].parent_id = 'p';
  const good6 = await T.breakdownTicket(atomicTicket.id, { items: sixWithABadFifth, actor: 'test' });
  ok(good6.count === 6, 'the same six, with the ref corrected, all land in one call');
  ok((await T.getTicket(atomicTicket.id)).status === 'assigned', 'and the ticket moves to assigned');
  // The five tasks all hang off ref 'p' and are created one after another INSIDE the transaction,
  // so each one's nextSortOrder() must see the uncommitted siblings the same transaction just
  // inserted. Read through the pool (they are committed now) they must be strictly increasing —
  // if the ranks had been computed off a pool connection outside the transaction they would all
  // have collided on the same number.
  const sibs = good6.created.filter((i) => i.depth === 2).map((i) => i.sort_order);
  ok(sibs.length === 5 && sibs.every((v, n) => n === 0 || v > sibs[n - 1]),
     `siblings created inside one transaction get strictly increasing ranks (${sibs.join(' < ')})`);
  await T.deleteTicket(atomicTicket.id);
  for (const i of good6.created.filter((x) => x.depth === 1)) await W.deleteWorkItem(i.id);

  await W.deleteWorkItem(sibA.id); await W.deleteWorkItem(sibB.id);

  // ── deleting a subtree says what went with it ────────────────────────────
  section('delete');
  const del = await W.deleteWorkItem(taskB.id);
  ok(del.ok === true && del.descendants === 1,
     `deleting a task took its subtree and the answer SAYS how many went with it (${del.descendants})`);
  ok((await W.getWorkItem(taskC.id)) === null, 'the descendant really is gone');
  ok((await W.getWorkItem(taskB.id)) === null, 'and so is the item itself');

  // a deleted ticket keeps the plan
  const dt = await T.deleteTicket(t2.id);
  ok(dt.ok === true, 'a ticket can be deleted');
  const bd1 = await T.getTicket(t1.id);
  ok(bd1.work_items.length === 2 && bd1.comments.length === 1,
     'the surviving ticket still carries its remaining work items and its comment');

  await pool.end().catch(() => {});
} finally {
  await cleanup();
  await client.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
