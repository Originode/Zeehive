// THE A2A CONVERSATION EXTENSION — DR-8: ALL zee conversations as A2A Tasks.
//
// The original scope (DR-1) is the zee_message plane. The human wants ALL zee conversations in
// A2A. This test holds the DR-8 decision true:
//
//   xell_conversation (112) archives   → one A2A Task per archive (deterministic id from the
//                                         archive row id; the transcript events become history;
//                                         status completed — the archive is a receipt).
//   zee_conversation (192) memory      → one A2A Task per xell (deterministic id from the xell
//                                         id; rows in seq order become history; status working —
//                                         the memory is the state the next turn reads).
//   zee_turn (153) ledger              → one A2A Task per turn (deterministic id from the turn
//                                         id; the summary is the single message; completed when
//                                         the turn ended, working while open).
//   session_event                      → OUT. It is the control-plane hook/play-by-play log, not a
//                                         conversation; the zee_turn Task already names its turn.
//
// Everything is a PROJECTION (DR-3): deterministic ids are minted at READ time (uuid v5 of a
// store-namespaced natural key) — nothing is written, no backfill, the same row always projects
// to the same id. Scope is the crew rule unchanged (taskVisibleXellIds): the caller may read its
// own + its crew's conversations. External callers (zhk_ a2a keys) see only their project's.
//
//   A. THE PURE BUILDERS (lib/a2a.js): conversationTaskId is deterministic; archiveRowToTask /
//      memoryRowsToTask / turnRowToTask shape the Tasks; conversationEventToMessage maps roles
//      and excludes non-speech events; sessionEventToTask is the named exclusion seam.
//   B. THE DB SURFACE (lib/a2a-read.js), against a throwaway project in DATABASE_URL (skipped
//      when unset): loadConversationTask finds an archive/memory/turn by its deterministic id;
//      loadConversationTasks lists the caller's conversation Tasks; listTasks now includes them;
//      scope holds (a sibling worker sees nothing of another worker's archive).
//   C. THE ROUTER INTAKE (C3 in the plan's §1 scope) now stamps the A2A envelope — a routing
//      request row carries meta.a2a with a minted taskId + contextId.
//
// The project is deleted in a finally, whatever happens (house rule: tests clean up what they create).
import { archiveRowToTask, memoryRowsToTask, turnRowToTask, sessionEventToTask,
         conversationTaskId, conversationEventToMessage } from '../server/src/lib/a2a.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (got, want, msg) => ok(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// ── A. the pure builders ────────────────────────────────────────────────────
console.log('\n── A. the pure conversation builders (lib/a2a.js) ──');
{
  // conversationTaskId: deterministic, store-namespaced, v5-shaped.
  const id1 = conversationTaskId('xell_conversation', 'abc');
  const id2 = conversationTaskId('xell_conversation', 'abc');
  const id3 = conversationTaskId('xell_conversation', 'def');
  const id4 = conversationTaskId('zee_turn', 'abc');
  eq(id1, id2, 'conversationTaskId is deterministic (same store+key → same id)');
  ok(id1 !== id3, '…and differs across keys');
  ok(id1 !== id4, '…and differs across stores (store-namespaced)');
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id1),
     `…and is a v5 uuid (version nibble 5, got ${id1})`);

  // archiveRowToTask.
  const arch = {
    id: '11111111-1111-4111-8111-111111111111', xell_slug: 'a-xell', title: 'My Conv',
    line_count: 3, byte_count: 136, created_at: '2026-08-01T00:00:00Z',
    events: [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'custom-title', customTitle: 'My Conv', sessionId: 'abc' },
      'not-json',
    ],
  };
  const at = archiveRowToTask(arch);
  eq(at.status, 'completed', 'A: an archive Task is completed (a receipt)');
  eq(at.id, conversationTaskId('xell_conversation', arch.id), 'A: archive Task id is the deterministic v5 of the archive row id');
  eq(at.metadata.store, 'xell_conversation', 'A: archive Task metadata names its store');
  eq(at.metadata.title, 'My Conv', 'A: the archive title rides in metadata');
  ok(at.history.length >= 2, `A: transcript events became history (${at.history.length})`);
  eq(at.history[0].role, 'user', 'A: a user event → role user');
  eq(at.history[1].role, 'agent', 'A: an assistant event → role agent');
  ok(!at.history.some((m) => m.metadata?.kind === 'custom-title'), 'A: non-speech events are excluded from history');

  // memoryRowsToTask.
  const mem = memoryRowsToTask({
    xellId: '22222222-2222-4222-8222-222222222222',
    rows: [
      { role: 'system', content: 'You are a builder', created_at: '2026-08-01T00:00:00Z' },
      { role: 'user', content: 'do the thing', created_at: '2026-08-01T00:00:01Z' },
      { role: 'assistant', content: 'done', created_at: '2026-08-01T00:00:02Z' },
    ],
  });
  eq(mem.status, 'working', 'A: a working-memory Task is working (the state its next turn reads)');
  eq(mem.id, conversationTaskId('zee_conversation', '22222222-2222-4222-8222-222222222222'), 'A: memory Task id = v5 of the xell id');
  eq(mem.history.length, 3, 'A: all memory rows are history');
  eq(mem.history[0].role, 'user', 'A: a system row maps to user (input, not the agent speaking)');
  eq(mem.history[1].role, 'user', 'A: a user row stays user');
  eq(mem.history[2].role, 'agent', 'A: an assistant row maps to agent');
  eq(mem.history[0].metadata.kind, 'system', 'A: the store role rides in metadata.kind');

  // turnRowToTask.
  const openTurn = { id: '33333333-3333-4333-8333-333333333333', xell_id: '22222222-2222-4222-8222-222222222222',
    kind: 'spawn', model: 'claude', started_at: '2026-08-01T00:00:00Z', ended_at: null, summary: 'still working', cost_usd: '0.1' };
  const endedTurn = { ...openTurn, ended_at: '2026-08-01T00:01:00Z', stop_reason: 'end_turn' };
  eq(turnRowToTask(openTurn).status, 'working', 'A: an open turn is working');
  eq(turnRowToTask(endedTurn).status, 'completed', 'A: an ended turn is completed');
  eq(turnRowToTask(openTurn).id, conversationTaskId('zee_turn', openTurn.id), 'A: turn Task id = v5 of the turn row id');
  eq(turnRowToTask(openTurn).history[0].role, 'agent', 'A: the turn summary is an agent message');
  eq(turnRowToTask(openTurn).metadata.cost_usd, 0.1, 'A: the turn burn rides in metadata');

  // sessionEventToTask is the named exclusion.
  eq(sessionEventToTask({ type: 'tend-request', xell_id: 'x' }), null, 'A: session_event stays OUT (the named exclusion seam)');

  // conversationEventToMessage excludes non-speech and flattens tool events.
  eq(conversationEventToMessage({ store: 'x', event: { type: 'system' } }), null, 'A: a system event is not speech');
  const toolEv = conversationEventToMessage({ store: 'x', event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'bash' }] } } });
  ok(toolEv && /tool_use/.test(toolEv.parts[0].text), 'A: a tool_use block flattens to text, not lost');
}

// ── B. the DB surface ───────────────────────────────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n── B. the DB surface (SKIPPED — DATABASE_URL not set; use `zee db-sandbox --migrate`) ──');
} else {
  console.log('\n── B. the conversation surface against DATABASE_URL ──');
  const { q, one } = await import('../server/src/db/pool.js');
  const { getTask, listTasks, loadConversationTask, loadConversationTasks, taskVisibleXellIds } =
    await import('../server/src/lib/a2a-read.js');
  const { uploadConversationArchive } = await import('../server/src/lib/conversations.js');
  const { startTurn, endTurn } = await import('../server/src/lib/turn-ledger.js');
  const { postMessage } = await import('../server/src/lib/managers.js');

  const tag = `a2ac-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
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
    const managerVisible = await taskVisibleXellIds(manager);
    const siblingVisible = await taskVisibleXellIds(sibling);

    // B1. an archive → a Task the manager/worker can GetTask, a sibling cannot.
    const sample = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'build it' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'built' }] } }),
    ].join('\n');
    const up = await uploadConversationArchive(worker, { content: sample, sessionId: 's1', title: 'B1 conv', uploadedBy: 'verb' });
    ok(up.ok === true, `B1: an archive was uploaded (${up.conversation_id?.slice(0, 8)})`);
    const archTaskId = conversationTaskId('xell_conversation', up.conversation_id);
    const archTask = await loadConversationTask(worker, archTaskId);
    ok(!!archTask && archTask.status === 'completed', 'B1: the archive loads as a completed Task');
    eq(archTask.id, archTaskId, 'B1: the archive Task id is the deterministic v5 of the archive row id');
    const mgrGot = await getTask(manager, archTaskId);
    ok(mgrGot.task?.id === archTaskId, 'B1: GetTask on the archive id works for the manager');
    let sibErr = null;
    try { await getTask(sibling, archTaskId); } catch (e) { sibErr = e; }
    ok(sibErr?.code === -32001, 'B1: a sibling worker cannot GetTask another worker\'s archive (scope holds)');

    // B2. a zee_conversation memory → a Task by its v5-of-xell id.
    await q(`INSERT INTO zee_conversation (xell_id, zee_id, seq, role, content) VALUES ($1,NULL,1,'user','remember this'),($1,NULL,2,'assistant','remembered')`, [worker.id]);
    const memTask = await loadConversationTask(worker, conversationTaskId('zee_conversation', worker.id));
    ok(!!memTask && memTask.status === 'working', 'B2: the memory loads as a working Task');
    eq(memTask.history.length, 2, 'B2: both memory rows are history');
    const memByGet = await getTask(worker, conversationTaskId('zee_conversation', worker.id));
    ok(memByGet.task?.id === memTask.id, 'B2: GetTask resolves the memory by its deterministic id');

    // B3. a zee_turn → a Task by its v5-of-turn-id.
    const zeeRow = await one(`INSERT INTO zee (xell_id, name, status, kind, attach_mode) VALUES ($1,'bob','working','headless','headless-spawn') RETURNING id`, [worker.id]);
    const turn = await startTurn({ zee: zeeRow, xell: worker, kind: 'spawn', sessionId: 's1', model: 'claude' });
    await endTurn(turn.id, { status: 'ended', summary: 'turn summary', stopReason: 'end_turn' });
    const turnTask = await loadConversationTask(worker, conversationTaskId('zee_turn', turn.id));
    ok(!!turnTask && turnTask.status === 'completed', 'B3: an ended turn loads as a completed Task');
    eq(turnTask.history[0].parts[0].text, 'turn summary', 'B3: the summary is the single message');

    // B4. loadConversationTasks lists all three, and listTasks includes them.
    const convs = await loadConversationTasks(worker, { visible: workerVisible });
    ok(convs.some((t) => t.id === archTaskId), 'B4: loadConversationTasks lists the archive');
    ok(convs.some((t) => t.id === memTask.id), 'B4: …and the memory');
    ok(convs.some((t) => t.id === turnTask.id), 'B4: …and the turn');
    const all = await listTasks(worker);
    ok(all.tasks.some((t) => t.id === archTaskId) && all.tasks.some((t) => t.id === turnTask.id),
       'B4: listTasks now includes the conversation Tasks alongside the zee_message Tasks');
    const sibAll = await listTasks(sibling);
    ok(!sibAll.tasks.some((t) => t.id === archTaskId) && !sibAll.tasks.some((t) => t.id === memTask.id),
       'B4: a sibling worker sees none of another worker\'s conversations');

    // B5. the manager sees its crew's conversations (crew scope).
    const mgrConvs = await loadConversationTasks(manager, { visible: managerVisible });
    ok(mgrConvs.some((t) => t.id === archTaskId), 'B5: a manager sees its worker\'s archive');

    // B6. the zee_message round-trip still works (the extension is additive).
    const d = await postMessage({ from: manager, to: worker, body: 'still a directive', kind: 'directive', deliver: false });
    const got = await getTask(manager, d.message.meta.a2a.taskId);
    eq(got.task.status, 'submitted', 'B6: the zee_message GetTask path is untouched (additive)');

    // B7. EXTERNAL (zhk_ a2a) views of the conversation Tasks are id-scrubbed (DR-6): no xell
    // uuids, no key material. The metadata.xell is a SLUG, never an internal id.
    const { createProjectApiKey, authenticateApiKey } = await import('../server/src/lib/project-api-keys.js');
    const { externalCaller } = await import('../server/src/lib/a2a-read.js');
    const keyRow = await createProjectApiKey(projectId, { label: 'conv a2a', scopes: ['a2a'] });
    const auth = await authenticateApiKey(keyRow.key, { scope: 'a2a' });
    const ext = externalCaller(auth);
    const extMem = await loadConversationTask(ext, memTask.id);
    ok(!!extMem && extMem.metadata.xell === worker.slug, 'B7: an external caller sees the memory Task, and metadata.xell is the SLUG');
    const extAll = await listTasks(ext);
    const extText = JSON.stringify(extAll);
    ok(!extText.includes(worker.id), 'B7: the external conversation views leak no xell uuid');
    ok(!extText.includes(keyRow.key), 'B7: …and no key material');
    ok(extAll.tasks.some((t) => t.id === archTaskId) && extAll.tasks.some((t) => t.id === turnTask.id),
       'B7: an external caller sees its project\'s archive + turn Tasks');

    console.log(`    (project=zt-${tag}, archive=${up.conversation_id?.slice(0, 8)}…, mem=${memTask.id?.slice(0, 8)}…, turn=${turnTask.id?.slice(0, 8)}…)`);
  } finally {
    if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
