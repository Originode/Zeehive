// THE A2A ENVELOPE — Phase P1 of the A2A adoption (docs/a2a-protocol-plan.md §4, DR-3).
//
// What P1 ships is the ENVELOPE: postMessage stamps meta.a2a on every zee_message it inserts
// (ids only, plus the one stored flag canceled), and the zee say/report/inbox JSON answers carry
// the ids additively. The mapping module (server/src/lib/a2a.js) is PURE — the same shape as
// lib/zee-turn.js's decideMessageDelivery — so the hard part, the §3.3 task-state table, is
// checked here row for row with no database at all.
//
//   A. THE PURE MODULE, in three halves:
//      A1 buildEnvelope  — a directive mints a taskId (it OPENS a task); a report references the
//         task it answers and never mints one; contextId is reused when the caller found one and
//         minted when it did not; state is null except the one stored flag, canceled.
//      A2 deriveTaskState — the plan §3.3 table, every row: submitted (stored-not-delivered and
//         queued), working (resumed), input-required (tend while live), completed (a reply
//         references the taskId), rejected (decommissioned/retired at send), canceled (the stored
//         flag), failed (a delivery corrected to undelivered), and the KNOWN GAP — typed into a
//         no-turn-hook cage stays working and says "completion unobservable" in metadata, never
//         faked to completed.
//      A3 rowToMessage / rowToTask — the projection: role user when the message opened the task,
//         agent on replies; kind preserved in metadata; a Task's history and artifacts; and the
//         C7 seam (execution outputs ⇄ Artifacts) is a named stub returning nothing.
//
//   B. THE STAMP, against a throwaway project in DATABASE_URL: a manager directive gets
//      {messageId=row.id, taskId, contextId}; the worker's report back references that taskId and
//      mints its own contextId for the reverse ordered pair; a second directive reuses the first
//      one's contextId; and inboxFor carries the ids additively on each message. The project is
//      deleted in a finally, whatever happens (house rule: tests clean up what they create).
//
// The CLI text UX is deliberately NOT touched — this test asserts the additive JSON ids, not one
// word of what `zee say` / `zee report` / `zee inbox` print.
import { randomUUID } from 'node:crypto';

const { buildEnvelope, deriveTaskState, rowToMessage, rowToTask, executionOutputsToArtifacts }
  = await import('../server/src/lib/a2a.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (got, want, msg) => ok(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');

// The test mint: deterministic, so the envelope's ids are assertable. The real module defaults to
// randomUUID; the point of injecting it is that the function is pure, not that the ids are random.
let n = 0;
const mint = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// ── A1. buildEnvelope — the stamp's shape ────────────────────────────────────────────────────
console.log('\n── A1. buildEnvelope: a directive opens a task, a report answers one ──');
{
  const directive = buildEnvelope({ messageId: 'row-1', kind: 'directive', contextId: null, mint });
  ok(isUuid(directive.taskId), `a directive mints a taskId (${directive.taskId})`);
  ok(isUuid(directive.contextId), `…and a contextId for its (from,to) pair (${directive.contextId})`);
  eq(directive.messageId, 'row-1', 'messageId is the row id, reused');
  eq(directive.state, null, 'a fresh envelope stores state:null — every other state is derived');
  eq(directive.referencedTaskId, undefined, 'a directive references no task');

  const report = buildEnvelope({ messageId: 'row-2', kind: 'report', contextId: null,
                                 referencedTaskId: directive.taskId, mint });
  eq(report.taskId, undefined, 'a report does NOT mint a taskId — it does not open a task');
  eq(report.referencedTaskId, directive.taskId, 'a report references the task its answer belongs to');
  ok(report.contextId !== directive.contextId, 'a report in the REVERSE ordered pair mints its own contextId');

  const again = buildEnvelope({ messageId: 'row-3', kind: 'directive', contextId: directive.contextId, mint });
  eq(again.contextId, directive.contextId, 'the SAME ordered pair reuses its contextId');
  ok(again.taskId !== directive.taskId, '…but each directive still opens its OWN task');

  const canceled = buildEnvelope({ messageId: 'row-4', kind: 'directive', canceled: true, mint });
  eq(canceled.state, 'canceled', 'canceled is the one state that IS stored (plan §3.3)');

  const plain = buildEnvelope({ messageId: 'row-5', kind: 'message', contextId: 'ctx', mint });
  eq(plain.taskId, undefined, 'a plain message opens no task and references none');
  eq(plain.contextId, 'ctx', 'a reused contextId rides through untouched');
}

// ── A2. deriveTaskState — the plan §3.3 table, every row ─────────────────────────────────────
console.log('\n── A2. deriveTaskState: the §3.3 table, row by row ──');
{
  const d = (over = {}) => deriveTaskState({ delivery: 'none', ...over });
  eq(d().state, 'submitted', 'row stored, delivery none → submitted (the durable inbox IS submission)');
  eq(d({ delivery: 'queued' }).state, 'submitted', 'delivery queued (recipient mid-turn) → submitted');
  eq(d({ delivery: 'resumed' }).state, 'working', 'delivery resumed → working');
  eq(d({ delivery: 'typed' }).state, 'working', 'delivery typed → working');
  eq(d({ delivery: 'none', deliveryReason: 'this zee has been decommissioned — no session left' }).state, 'rejected',
     'recipient DECOMMISSIONED at send time → rejected (the reason on a none verdict)');
  eq(d({ delivery: 'none', deliveryReason: 'this xell has been retired — its cxell is gone' }).state, 'rejected',
     '…and so is a RETIRED xell at send time');
  eq(d({ canceled: true }).state, 'canceled', 'sender-cancel before delivery → canceled (the stored flag)');
  eq(d({ undelivered: true }).state, 'failed', 'a delivery corrected to undelivered (it reported sent, then died) → failed');
  eq(d({ hasReply: true }).state, 'completed', 'a reply row referencing the taskId → completed (the reply is the artifact)');
  eq(d({ tendOpen: true, delivery: 'resumed' }).state, 'input-required',
     'recipient raised a zee tend while the task is live → input-required');
  eq(d({ tendOpen: true, delivery: 'queued' }).state, 'input-required', '…a tend applies to any live state, not just working');
  eq(d({ hasReply: true, tendOpen: true }).state, 'completed', 'a reply outranks an open tend — the work happened');
  eq(d({ canceled: true, hasReply: true }).state, 'canceled', 'the stored cancel flag outranks a stale delivery verdict');
  eq(d({ undelivered: true, delivery: 'resumed' }).state, 'failed', 'a lie about delivery outranks the delivery verdict');

  const gap = d({ delivery: 'typed' });
  eq(gap.state, 'working', 'typed into a no-turn-hook cage STAYS working — the KNOWN GAP is never faked to completed');
  ok(/completion unobservable/.test(gap.metadata?.note || ''),
     `…and the honest note rides in metadata (${gap.metadata?.note})`);
}

// ── A3. rowToMessage / rowToTask — the projection ─────────────────────────────────────────────
console.log('\n── A3. the projection: Message / Task / the C7 seam ──');
{
  const directiveRow = { id: 'row-1', kind: 'directive', body: 'do the thing',
    delivered: true, delivery: { delivery: 'resumed' },
    meta: { a2a: { messageId: 'row-1', taskId: 'task-1', contextId: 'ctx-1', state: null } } };
  const replyRow = { id: 'row-2', kind: 'report', body: 'done',
    delivered: true, delivery: { delivery: 'resumed' },
    meta: { a2a: { messageId: 'row-2', contextId: 'ctx-2', referencedTaskId: 'task-1', state: null } } };

  const m1 = rowToMessage(directiveRow);
  eq(m1.role, 'user', 'the message that OPENS the task is role user');
  eq(m1.taskId, 'task-1', '…and it names its own taskId');
  eq(m1.metadata.kind, 'directive', 'the ZEEHIVE kind is preserved in metadata (nothing of the taxonomy is lost)');
  eq(m1.parts[0].text, 'do the thing', 'the body becomes a single text part');

  const m2 = rowToMessage(replyRow);
  eq(m2.role, 'agent', 'a reply is role agent');
  eq(m2.taskId, 'task-1', '…and it belongs to the task it references');
  eq(m2.metadata.kind, 'report', 'the reply kind rides along too');
  eq(rowToMessage({ id: 'old', kind: 'message', body: 'pre-A2A' }), null,
     'an un-enveloped row maps to null — old rows are invisible to A2A, never backfilled (DR-4)');

  const task = rowToTask({ opening: directiveRow, replies: [replyRow] });
  eq(task.id, 'task-1', 'the Task id is the opening row\'s taskId');
  eq(task.status, 'completed', 'a task with a reply is completed');
  eq(task.history.length, 2, 'history is the opening message + the reply, in order');
  eq(task.history[1].messageId, 'row-2', '…the reply is in the history');
  eq(task.artifacts[0].parts[0].text, 'done', 'the reply body is the task\'s Artifact');
  eq(task.metadata, undefined, 'a completed task carries no extra metadata');

  const stuck = rowToTask({ opening: { ...directiveRow, delivery: { delivery: 'typed' } } });
  eq(stuck.status, 'working', 'a typed-only task stays working…');
  ok(/completion unobservable/.test(stuck.metadata?.note || ''), '…and says why in metadata');

  eq(rowToTask({ opening: replyRow }), null, 'a reply row does not make a Task — only a task-opening row does');
  eq(executionOutputsToArtifacts({ id: 'exec-1', outputs: { n: 1 } }).length, 0,
     'the C7 seam is a named stub — execution outputs ⇄ Artifacts ships nothing in P1');
}

// ── B. THE STAMP — postMessage writes meta.a2a on every message it inserts ────────────────────
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n── B. postMessage stamp (SKIPPED — DATABASE_URL not set; use `zee db-sandbox --migrate`) ──');
} else {
  console.log('\n── B. postMessage stamps meta.a2a, and inboxFor carries the ids additively ──');
  const { q, one } = await import('../server/src/db/pool.js');
  const { postMessage, inboxFor } = await import('../server/src/lib/managers.js');

  const tag = `a2a-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  let projectId = null;
  try {
    const proj = await one(
      `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id`,
      [`zt-${tag}`, `/tmp/${tag}`]);
    projectId = proj.id;
    const xource = await one(
      `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
      [projectId]);
    const mkXell = async (slug, zeeType) => (await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type)
         VALUES ($1,$2,$3,'spinoff/t','claimed',$4) RETURNING *`,
      [projectId, xource.id, `${tag}-${slug}`, zeeType]));
    const manager = await mkXell('mgr', 'manager');
    const worker = await mkXell('wrk', 'worker');

    // 1. a MANAGER DIRECTIVE opens a task: messageId = the row id, taskId + contextId minted.
    const d = await postMessage({ from: manager, to: worker, body: 'do the thing', kind: 'directive', deliver: false });
    const dA2a = d.message.meta.a2a;
    ok(dA2a && dA2a.messageId === d.message.id, `a directive stamps messageId = the row id (${d.message.id.slice(0, 8)}…)`);
    ok(isUuid(dA2a.taskId), `a directive mints a taskId (${dA2a.taskId})`);
    ok(isUuid(dA2a.contextId), `a directive mints a contextId (${dA2a.contextId})`);
    eq(dA2a.referencedTaskId, undefined, 'a directive references no task');
    eq(dA2a.state, null, 'the envelope stores state:null');

    // 2. a WORKER REPORT back: references the directive's taskId; the REVERSE ordered pair mints
    //    its own contextId (the (worker,manager) pair has never exchanged before).
    const r = await postMessage({ from: worker, to: manager, body: 'done', kind: 'report', deliver: false });
    const rA2a = r.message.meta.a2a;
    ok(rA2a && rA2a.referencedTaskId === dA2a.taskId, `a report references the directive it answers (${dA2a.taskId.slice(0, 8)}…)`);
    eq(rA2a.taskId, undefined, 'a report mints no taskId');
    ok(rA2a.contextId && rA2a.contextId !== dA2a.contextId, 'the reverse ordered pair mints its own contextId');

    // 3. a SECOND directive on the SAME ordered pair reuses the first directive's contextId —
    //    "per ordered (from_xell,to_xell) pair, then reused" (plan §4).
    const d2 = await postMessage({ from: manager, to: worker, body: 'also this', kind: 'directive', deliver: false });
    const d2A2a = d2.message.meta.a2a;
    eq(d2A2a.contextId, dA2a.contextId, 'the same ordered pair REUSES its contextId');
    ok(d2A2a.taskId && d2A2a.taskId !== dA2a.taskId, '…but the second directive opens its own task');

    // 4. a message with no xell on one side still gets an envelope (a console note, a reflection
    //    with no manager) — ids minted, nothing referenced.
    const solo = await postMessage({ from: worker, to: null, body: 'noted', kind: 'report', deliver: false });
    const soloA2a = solo.message.meta.a2a;
    ok(soloA2a && isUuid(soloA2a.contextId) && soloA2a.messageId === solo.message.id,
       'a message with a null recipient still gets an envelope (messageId + contextId)');
    eq(soloA2a.referencedTaskId, undefined, '…and nothing to reference');

    // 5. inboxFor carries the ids additively — the zee inbox answer gains a2a per message.
    //    The directive was sent TO the worker, so it is the worker's inbox that holds it; the
    //    report was sent TO the manager, and it surfaces the task it ANSWERS as its taskId.
    const inbox = await inboxFor(worker.id, { all: true });
    const dir = inbox.find((m) => m.id === d.message.id);
    ok(dir && dir.a2a && dir.a2a.taskId === dA2a.taskId && dir.a2a.contextId === dA2a.contextId,
       'inboxFor includes a2a:{taskId, contextId} on an enveloped message');
    const mgrInbox = await inboxFor(manager.id, { all: true });
    const rep = mgrInbox.find((m) => m.id === r.message.id);
    ok(rep && rep.a2a && rep.a2a.taskId === dA2a.taskId,
       '…and a REPLY surfaces the task it references as its taskId (a2a.taskId || referencedTaskId)');

    console.log(`    (directive taskId=${dA2a.taskId.slice(0, 8)}…, contextId=${dA2a.contextId.slice(0, 8)}…, `
      + `report referenced=${rA2a.referencedTaskId.slice(0, 8)}…)`);
  } finally {
    if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
