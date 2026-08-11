// THE A2A WRITE SIDE — Phase P3 of the A2A adoption (docs/a2a-protocol-plan.md §3.2/§3.3, DR-3/DR-5).
//
// P3 ships the write methods the P1 envelope + P2 read side made possible: SendMessage /
// SendStreamingMessage / CancelTask (internal xell-token auth only; external zhk_ keys are PHASE 4).
// The pure write helpers live in lib/a2a.js (partsToBody / cancelVerdict — the same verdict shape
// as deriveTaskState); the DB half lives in lib/a2a-read.js beside the read methods (sendMessage /
// cancelTask, dispatched through the same dispatchA2A table).
//
//   A. THE PURE HELPERS:
//      A1 partsToBody — text parts concatenate into the body (joined, trimmed); an empty / malformed
//         parts array errors with InvalidParams; a DataPart ({ data }) or FilePart ({ file }) errors
//         with the EXACT spec code name ContentTypeNotSupportedError (-32005).
//      A2 cancelVerdict — allowed while the task is still undelivered/queued (delivery none/queued);
//         refused once delivery says 'resumed'/'typed' (the turn is running — CancelTask never
//         interrupts a turn, plan §3.2) and refused for a task that already has a reply.
//
//   B. THE WRITE METHODS against a throwaway project in DATABASE_URL (skipped when unset, like the
//      DB halves of a2a-envelope/a2a-read):
//      B1 SendMessage opens a task (no taskId → kind='directive' mints one) and returns the Message
//         with that taskId.
//      B2 The full send→deliver→reply→completed round-trip: the reply SendMessage names the taskId,
//         its envelope references it, and GetTask shows status completed with the reply as Artifact.
//      B3 DataPart/FilePart through the dispatch table → ContentTypeNotSupportedError -32005.
//      B4 Cancel-before-delivery success: a directive with a 'queued'/'none' delivery is canceled by
//         its sender; GetTask shows canceled.
//      B5 Cancel-refusal: a task whose delivery is 'resumed'/'typed' → TaskNotCancelableError -32002;
//         a task that already has a reply → -32002; a non-sender participant → -32002.
//      B6 SendStreamingMessage returns the sent Message (the SSE stream itself is the route's job).
//
// The project is deleted in a finally, whatever happens (house rule: tests clean up what they create).
import { partsToBody, cancelVerdict, A2A_ERROR } from '../server/src/lib/a2a.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (got, want, msg) => ok(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// ── A1. partsToBody — text parts only in v1 ────────────────────────────────────────────────
console.log('\n── A1. partsToBody: text concatenates; Data/File → ContentTypeNotSupported ──');
{
  const t = partsToBody([{ text: 'hello' }, { text: 'world' }]);
  eq(t.body, 'hello\nworld', 'text parts concatenate (newline-joined)');
  eq(t.error, undefined, '…with no error');

  const single = partsToBody([{ text: 'do the thing' }]);
  eq(single.body, 'do the thing', 'a single text part is the body');

  const data = partsToBody([{ text: 'hi' }, { data: { n: 1 } }]);
  eq(data.error, A2A_ERROR.ContentTypeNotSupported.name, 'a DataPart ({ data }) → ContentTypeNotSupportedError (-32005)');
  eq(data.body, null, '…and no body');

  const file = partsToBody([{ file: { name: 'x.png', mimeType: 'image/png' } }]);
  eq(file.error, A2A_ERROR.ContentTypeNotSupported.name, 'a FilePart ({ file }) → ContentTypeNotSupportedError (-32005)');

  const empty = partsToBody([]);
  eq(empty.error, 'message.parts must be a non-empty array', 'empty parts → InvalidParams shape');

  const blank = partsToBody([{ text: '   ' }]);
  eq(blank.error, 'message body is empty after trimming text parts', 'whitespace-only text → empty-body error');
}

// ── A2. cancelVerdict — the plan §3.2 rule, verbatim ──────────────────────────────────────
console.log('\n── A2. cancelVerdict: still undelivered/queued → allowed; turn running → refused ──');
{
  eq(cancelVerdict({ delivery: null }).allowed, true, 'no delivery verdict → allowed (stored-not-delivered)');
  eq(cancelVerdict({ delivery: { delivery: 'none' } }).allowed, true, 'delivery none → allowed');
  eq(cancelVerdict({ delivery: { delivery: 'queued' } }).allowed, true, 'delivery queued → allowed');
  eq(cancelVerdict({ delivery: { delivery: 'resumed' } }).allowed, false,
     'delivery resumed → refused (the turn is running — CancelTask never interrupts a turn)');
  eq(cancelVerdict({ delivery: { delivery: 'typed' } }).allowed, false, 'delivery typed → refused');
  eq(cancelVerdict({ delivery: { delivery: 'none' }, hasReply: true }).allowed, false,
     'a task with a reply already happened → refused');
}

// ── B. THE WRITE METHODS — against a throwaway project in DATABASE_URL ─────────────────────
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n── B. SendMessage/CancelTask (SKIPPED — DATABASE_URL not set; use `zee db-sandbox --migrate`) ──');
} else {
  console.log('\n── B. the write methods against DATABASE_URL ──');
  const { q, one } = await import('../server/src/db/pool.js');
  const { getTask, dispatchA2A, taskVisibleXellIds } = await import('../server/src/lib/a2a-read.js');
  const { A2AError } = await import('../server/src/lib/a2a-read.js');
  const { postMessage } = await import('../server/src/lib/managers.js');

  const tag = `a2aw-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  let projectId = null;
  try {
    const proj = await one(
      `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'main') RETURNING id`,
      [`zt-${tag}`, `/tmp/${tag}`]);
    projectId = proj.id;
    const xource = await one(
      `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
      [projectId]);
    const mkXell = async (slug, zeeType, managerId = null) => (await one(
      `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, manager_xell_id, head_commit)
         VALUES ($1,$2,$3,'spinoff/t','claimed',$4,$5,'abcdef1234567890') RETURNING *`,
      [projectId, xource.id, `${tag}-${slug}`, zeeType, managerId]));
    const manager = await mkXell('mgr', 'manager');
    const worker = await mkXell('wrk', 'worker', manager.id);
    const sibling = await mkXell('sib', 'worker', manager.id);
    const workerVisible = await taskVisibleXellIds(worker);

    // B1. SendMessage opens a task (no taskId → kind='directive' mints one) and returns the Message.
    const sent = await dispatchA2A(manager, 'SendMessage', {
      message: { role: 'user', parts: [{ text: 'do the thing' }] },
    }, { visible: workerVisible, agent: worker });
    const taskId = sent.message.taskId;
    ok(sent.message && typeof sent.message.messageId === 'string' && sent.message.messageId.length > 0,
       'B1: SendMessage returns the sent Message');
    eq(sent.message.taskId, taskId, 'B1: the sent Message carries the minted taskId');
    eq(sent.message.parts[0].text, 'do the thing', 'B1: the body became the Message\'s text part');
    const openingRow = await one(`SELECT * FROM zee_message WHERE id=$1`, [sent.message.messageId]);
    eq(openingRow.kind, 'directive', 'B1: a task-opening SendMessage writes kind=directive');

    // B2. Full send→deliver→reply→completed round-trip.
    const reply = await dispatchA2A(worker, 'SendMessage', {
      message: { role: 'agent', taskId, parts: [{ text: 'done' }] },
    }, { visible: workerVisible, agent: manager });
    eq(reply.message.taskId, taskId, 'B2: the reply Message references the same taskId');
    const replyRow = await one(`SELECT * FROM zee_message WHERE id=$1`, [reply.message.messageId]);
    eq(replyRow.meta.a2a.referencedTaskId, taskId, 'B2: the reply row\'s envelope references the taskId');
    eq(replyRow.meta.a2a.taskId, undefined, 'B2: a reply mints no taskId (it does not open a task)');
    const completed = await getTask(manager, taskId);
    eq(completed.task.status, 'completed', 'B2: GetTask shows the task completed after the reply');
    eq(completed.task.history.length, 2, 'B2: history = the opening message + the reply');
    eq(completed.task.artifacts[0].parts[0].text, 'done', 'B2: the reply body is the task\'s Artifact');

    // B3. DataPart/FilePart through the dispatch table → -32005.
    let dataErr = null;
    try {
      await dispatchA2A(manager, 'SendMessage', { message: { role: 'user', parts: [{ data: { n: 1 } }] } },
        { visible: workerVisible, agent: worker });
    } catch (e) { dataErr = e; }
    ok(dataErr instanceof A2AError && dataErr.code === -32005 && dataErr.errorName === 'ContentTypeNotSupportedError',
       `B3: DataPart via SendMessage → ContentTypeNotSupportedError -32005 (got ${dataErr?.code})`);

    // B4. Cancel-before-delivery success: a directive with a 'queued' delivery is canceled by its sender.
    const queued = await postMessage({ from: manager, to: worker, body: 'still queued', kind: 'directive', deliver: false });
    await q(`UPDATE zee_message SET delivery=$2::jsonb WHERE id=$1`,
      [queued.message.id, JSON.stringify({ delivery: 'queued' })]);
    const queuedTaskId = queued.message.meta.a2a.taskId;
    const canceled = await dispatchA2A(manager, 'CancelTask', { taskId: queuedTaskId }, { visible: workerVisible });
    eq(canceled.task.status, 'canceled', 'B4: CancelTask before delivery → task canceled');
    const canceledRow = await one(`SELECT * FROM zee_message WHERE id=$1`, [queued.message.id]);
    eq(canceledRow.meta.a2a.state, 'canceled', 'B4: the envelope stores state=canceled (the ONLY stored state)');

    // B5. Cancel-refusal.
    // B5a. A task whose delivery is 'resumed' (the turn is running) → -32002.
    const resumed = await postMessage({ from: manager, to: worker, body: 'running now', kind: 'directive', deliver: false });
    await q(`UPDATE zee_message SET delivery=$2::jsonb WHERE id=$1`,
      [resumed.message.id, JSON.stringify({ delivery: 'resumed' })]);
    const resumedTaskId = resumed.message.meta.a2a.taskId;
    let resumedErr = null;
    try {
      await dispatchA2A(manager, 'CancelTask', { taskId: resumedTaskId }, { visible: workerVisible });
    } catch (e) { resumedErr = e; }
    ok(resumedErr instanceof A2AError && resumedErr.code === -32002 && resumedErr.errorName === 'TaskNotCancelableError',
       `B5a: CancelTask on a resumed task → TaskNotCancelableError -32002 (got ${resumedErr?.code})`);

    // B5b. A task that already has a reply → -32002 (the work already happened).
    let doneErr = null;
    try {
      await dispatchA2A(manager, 'CancelTask', { taskId }, { visible: workerVisible });
    } catch (e) { doneErr = e; }
    ok(doneErr instanceof A2AError && doneErr.code === -32002,
       `B5b: CancelTask on a completed task → TaskNotCancelableError -32002 (got ${doneErr?.code})`);

    // B5c. Sender-only: a non-sender participant (the worker) cannot cancel the manager's task.
    let senderErr = null;
    try {
      await dispatchA2A(worker, 'CancelTask', { taskId: queuedTaskId }, { visible: workerVisible });
    } catch (e) { senderErr = e; }
    ok(senderErr instanceof A2AError && senderErr.code === -32002,
       `B5c: CancelTask by a non-sender participant → TaskNotCancelableError -32002 (got ${senderErr?.code})`);

    // B5d. A task the caller is not a participant of → -32001 (never leaked).
    const strangerVisible = await taskVisibleXellIds(sibling);
    let leakErr = null;
    try {
      await dispatchA2A(sibling, 'CancelTask', { taskId: queuedTaskId }, { visible: strangerVisible });
    } catch (e) { leakErr = e; }
    ok(leakErr instanceof A2AError && leakErr.code === -32001,
       `B5d: CancelTask on a task the caller is NOT a participant of → TaskNotFoundError -32001 (never leaked; got ${leakErr?.code})`);

    // B6. SendStreamingMessage returns the sent Message (the SSE stream itself is the route's job).
    const streamed = await dispatchA2A(manager, 'SendStreamingMessage', {
      message: { role: 'user', parts: [{ text: 'stream me' }] },
    }, { visible: workerVisible, agent: worker });
    ok(streamed.message && streamed.message.taskId && streamed.message.taskId !== taskId,
       'B6: SendStreamingMessage sends and returns the Message (a new task, distinct from the round-trip one)');

    // Missing / malformed params → -32602.
    let noMsgErr = null;
    try { await dispatchA2A(manager, 'SendMessage', {}, { visible: workerVisible, agent: worker }); }
    catch (e) { noMsgErr = e; }
    ok(noMsgErr instanceof A2AError && noMsgErr.code === -32602,
       'B7: SendMessage without params.message → InvalidParams -32602');
    let noIdErr = null;
    try { await dispatchA2A(manager, 'CancelTask', {}, { visible: workerVisible }); }
    catch (e) { noIdErr = e; }
    ok(noIdErr instanceof A2AError && noIdErr.code === -32602,
       'B7: CancelTask without params.taskId → InvalidParams -32602');

    console.log(`    (taskId=${taskId.slice(0, 8)}…, queued=${queuedTaskId.slice(0, 8)}…, resumed=${resumedTaskId.slice(0, 8)}…)`);
  } finally {
    if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
