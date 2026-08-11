// THE A2A READ SIDE — Phase P2 of the A2A adoption (docs/a2a-protocol-plan.md §3, DR-2/DR-3/DR-5).
//
// P2 ships the read surface the P1 envelope made readable: the fleet card + directory + per-agent
// cards (plan §3.1), and the JSON-RPC read methods GetTask / ListTasks / SubscribeToTask plus the
// two refusal methods with their exact spec codes (plan §3.2). The projection itself (rows ⇄
// Message/Task) is P1 and is asserted in a2a-envelope.test.mjs; this test asserts the P2 surface.
//
//   A. THE CARDS — the pure builders (lib/a2a.js), field by field against plan §3.1: name/description
//      from zee name + slug / task brief + harness label; supportedInterfaces with
//      url/protocolBinding/tenant/protocolVersion; provider ZEEHIVE; version = head commit short sha;
//      capabilities streaming:true pushNotifications:false extendedAgentCard:false; bearer
//      securitySchemes; defaultInputModes/defaultOutputModes ["text/plain"]; skills one AgentSkill
//      per harness skill + one for the zee's task.
//
//   B. THE ERROR CODES — the exact spec numbers for the refusal methods and the version gate
//      (plan §3.2): -32001 TaskNotFound, -32003 PushNotificationNotSupported, -32007
//      ExtendedAgentCardNotConfigured, -32009 VersionNotSupported.
//
//   C. THE READ METHODS, against a throwaway project in DATABASE_URL (skipped when unset, like the
//      stamp half of a2a-envelope.test.mjs):
//      C1 GetTask on an enveloped row returns the Task (a manager sees its crew's task; a worker
//         participant sees it).
//      C2 GetTask on a missing row → A2AError TaskNotFoundError (-32001); a task the caller is NOT
//         a participant of is equally invisible (-32001, never leaked).
//      C3 ListTasks is filtered to the caller's visibility: a manager sees its crew's task; a
//         sibling worker does not.
//      C4 The refusal methods' exact codes through the dispatch table (PushNotificationConfig
//         → -32003, GetExtendedAgentCard → -32007).
//      C5 A2A-Version handling — a2aVersionError answers null for "1.0" and the -32009 shape for a
//         wrong/missing version (the HTTP gate uses this pure function; the header check itself is
//         exercised against the built server).
//
// The project is deleted in a finally, whatever happens (house rule: tests clean up what they create).
import { buildFleetCard, buildAgentCard, A2A_ERROR, a2aVersionError } from '../server/src/lib/a2a.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (got, want, msg) => ok(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const deep = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg} (got ${JSON.stringify(got)})`);

// ── A. THE CARDS — plan §3.1, field by field ─────────────────────────────────────────────────
console.log('\n── A. the cards, field by field against plan §3.1 ──');
{
  const base = 'http://localhost:4800';
  const fleet = buildFleetCard({ base });
  eq(fleet.name, 'ZEEHIVE', 'fleet card: name is the service');
  eq(fleet.supportedInterfaces[0].url, `${base}/a2a/v1/agents`, 'fleet card: supportedInterfaces url points at the DIRECTORY');
  eq(fleet.supportedInterfaces[0].protocolBinding, 'JSONRPC', 'fleet card: protocolBinding JSONRPC');
  eq(fleet.supportedInterfaces[0].protocolVersion, '1.0', 'fleet card: protocolVersion 1.0');
  eq(fleet.provider.organization, 'ZEEHIVE', 'fleet card: provider.organization ZEEHIVE');
  deep(fleet.capabilities, { streaming: true, pushNotifications: false, extendedAgentCard: false },
       'fleet card: capabilities (streaming true, pushNotifications false, extendedAgentCard false)');
  deep(fleet.defaultInputModes, ['text/plain'], 'fleet card: defaultInputModes ["text/plain"]');
  deep(fleet.defaultOutputModes, ['text/plain'], 'fleet card: defaultOutputModes ["text/plain"]');
  ok(fleet.securitySchemes?.bearer?.type === 'http' && fleet.securitySchemes?.bearer?.scheme === 'bearer',
     'fleet card: securitySchemes declares HTTP bearer');
  ok(Array.isArray(fleet.securityRequirements) && fleet.securityRequirements.length, 'fleet card: securityRequirements present');

  const agent = buildAgentCard({
    xell: { slug: 'my-xell', head_commit: 'abcdef1234567890', harness_label: 'Builder' },
    base, zeeName: 'bob',
    skills: [{ name: 'orient-in-a-new-repo', when: 'Use at the START of any job in a codebase' }],
    taskBrief: 'Implement Phase P2\nsecond line',
  });
  eq(agent.name, 'bob · my-xell', 'per-agent card: name = zee name + xell slug (DR-4 seat identity)');
  eq(agent.description, 'Implement Phase P2 — Harness: Builder', 'per-agent card: description = task brief first line + harness label');
  eq(agent.supportedInterfaces[0].url, `${base}/a2a/v1/agents/my-xell`, 'per-agent card: supportedInterfaces url');
  eq(agent.supportedInterfaces[0].protocolBinding, 'JSONRPC', 'per-agent card: protocolBinding JSONRPC');
  eq(agent.supportedInterfaces[0].tenant, 'my-xell', 'per-agent card: tenant = the slug (a2a.proto AgentInterface.tenant)');
  eq(agent.supportedInterfaces[0].protocolVersion, '1.0', 'per-agent card: protocolVersion 1.0');
  eq(agent.provider.organization, 'ZEEHIVE', 'per-agent card: provider.organization ZEEHIVE');
  eq(agent.version, 'abcdef12', 'per-agent card: version = head_commit short sha (the honest version of a worktree)');
  deep(agent.capabilities, { streaming: true, pushNotifications: false, extendedAgentCard: false },
       'per-agent card: capabilities phase-gated (streaming true, rest false)');
  deep(agent.defaultInputModes, ['text/plain'], 'per-agent card: defaultInputModes ["text/plain"]');
  deep(agent.defaultOutputModes, ['text/plain'], 'per-agent card: defaultOutputModes ["text/plain"]');
  eq(agent.skills[0].id, 'orient-in-a-new-repo', 'per-agent card: skills[0].id = the harness skill key');
  eq(agent.skills[0].description, 'Use at the START of any job in a codebase',
     'per-agent card: skills[0].description = the skill\'s When: line');
  ok(agent.skills.length >= 2, 'per-agent card: a skill for the zee\'s task rides alongside the harness skills');
  eq(agent.skills[1].description, 'Implement Phase P2', 'per-agent card: the task skill carries the task brief first line');

  const bare = buildAgentCard({ xell: { slug: 'vacant', head_commit: null }, base });
  eq(bare.name, 'vacant', 'per-agent card: no zee name → the slug alone');
  eq(bare.version, 'unknown', 'per-agent card: no head_commit → "unknown", never a lie');
  eq(bare.skills.length, 0, 'per-agent card: no harness → no skills');
}

// ── B. THE ERROR CODES — plan §3.2, the exact numbers ─────────────────────────────────────────
console.log('\n── B. the exact spec error codes (plan §3.2) ──');
{
  eq(A2A_ERROR.TaskNotFound.code, -32001, 'TaskNotFoundError → -32001');
  eq(A2A_ERROR.PushNotificationNotSupported.code, -32003, 'PushNotificationNotSupportedError → -32003');
  eq(A2A_ERROR.ExtendedAgentCardNotConfigured.code, -32007, 'ExtendedAgentCardNotConfiguredError → -32007');
  eq(A2A_ERROR.VersionNotSupported.code, -32009, 'VersionNotSupportedError → -32009');
  eq(A2A_ERROR.TaskNotFound.name, 'TaskNotFoundError', 'the error message field is the spec type name');
  eq(A2A_ERROR.PushNotificationNotSupported.name, 'PushNotificationNotSupportedError', '…PushNotificationNotSupportedError');
  eq(A2A_ERROR.ExtendedAgentCardNotConfigured.name, 'ExtendedAgentCardNotConfiguredError', '…ExtendedAgentCardNotConfiguredError');
}

// ── C5. A2A-VERSION HANDLING — the pure gate the HTTP route uses ──────────────────────────────
console.log('\n── C5. A2A-Version handling (pure gate) ──');
{
  eq(a2aVersionError('1.0'), null, 'A2A-Version: 1.0 passes');
  const missing = a2aVersionError(null);
  eq(missing?.code, -32009, 'missing A2A-Version → VersionNotSupportedError -32009');
  eq(missing?.message, 'VersionNotSupportedError', '…message is the spec type name');
  const wrong = a2aVersionError('2.0');
  eq(wrong?.code, -32009, 'A2A-Version: 2.0 → VersionNotSupportedError -32009');
}

// ── C. THE READ METHODS — against a throwaway project in DATABASE_URL ─────────────────────────
const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n── C. GetTask / ListTasks / refusals (SKIPPED — DATABASE_URL not set; use `zee db-sandbox --migrate`) ──');
} else {
  console.log('\n── C. the read methods against DATABASE_URL ──');
  const { q, one } = await import('../server/src/db/pool.js');
  const { postMessage } = await import('../server/src/lib/managers.js');
  const { getTask, listTasks, dispatchA2A, cardVisibleXellIds, taskVisibleXellIds } = await import('../server/src/lib/a2a-read.js');
  const { A2AError } = await import('../server/src/lib/a2a-read.js');

  const tag = `a2ar-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
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

    // A manager→worker directive opens a task; the worker's report completes it.
    const d = await postMessage({ from: manager, to: worker, body: 'do the thing', kind: 'directive', deliver: false });
    const taskId = d.message.meta.a2a.taskId;
    await postMessage({ from: worker, to: manager, body: 'done', kind: 'report', deliver: false });

    // C1. GetTask on an enveloped row.
    const mgrGet = await getTask(manager, taskId);
    eq(mgrGet.task.id, taskId, 'C1: GetTask returns the task to its manager (crew scope)');
    eq(mgrGet.task.status, 'completed', 'C1: the task with a reply is completed');
    const wrkGet = await getTask(worker, taskId);
    eq(wrkGet.task.id, taskId, 'C1: GetTask returns the task to a worker participant');
    eq(wrkGet.task.history.length, 2, 'C1: history = the directive + the reply');

    // C2. GetTask on a missing / invisible row → -32001.
    let missingErr = null;
    try { await getTask(manager, '00000000-0000-4000-8000-000000000000'); } catch (e) { missingErr = e; }
    ok(missingErr instanceof A2AError && missingErr.code === -32001,
       `C2: GetTask on a missing id → TaskNotFoundError -32001 (got ${missingErr?.code})`);
    let siblingErr = null;
    try { await getTask(sibling, taskId); } catch (e) { siblingErr = e; }
    ok(siblingErr instanceof A2AError && siblingErr.code === -32001,
       'C2: GetTask on a task the caller is NOT a participant of → -32001 (never leaked)');

    // C3. ListTasks visibility.
    const mgrTasks = await listTasks(manager);
    ok(mgrTasks.tasks.some((t) => t.id === taskId), 'C3: a manager\'s ListTasks includes its crew\'s task');
    const sibTasks = await listTasks(sibling);
    ok(!sibTasks.tasks.some((t) => t.id === taskId), 'C3: a sibling worker\'s ListTasks does NOT include the task');
    const wrkTasks = await listTasks(worker);
    ok(wrkTasks.tasks.some((t) => t.id === taskId), 'C3: a worker participant\'s ListTasks includes the task');

    // C4. Refusal methods through the dispatch table → exact spec codes.
    let pushErr = null;
    try { await dispatchA2A(manager, 'PushNotificationConfig', {}); } catch (e) { pushErr = e; }
    ok(pushErr instanceof A2AError && pushErr.code === -32003 && pushErr.errorName === 'PushNotificationNotSupportedError',
       `C4: PushNotificationConfig → PushNotificationNotSupportedError -32003 (got ${pushErr?.code})`);
    let extErr = null;
    try { await dispatchA2A(manager, 'GetExtendedAgentCard', {}); } catch (e) { extErr = e; }
    ok(extErr instanceof A2AError && extErr.code === -32007 && extErr.errorName === 'ExtendedAgentCardNotConfiguredError',
       `C4: GetExtendedAgentCard → ExtendedAgentCardNotConfiguredError -32007 (got ${extErr?.code})`);

    // The JSON-RPC error envelope a client receives carries the exact shape (code/message/data).
    const wire = mgrGet ? new A2AError({ code: -32001, name: 'TaskNotFoundError' }, 'no task').toJSONRPC(7) : null;
    ok(wire && wire.jsonrpc === '2.0' && wire.id === 7 && wire.error.code === -32001
       && wire.error.message === 'TaskNotFoundError' && wire.error.data?.message,
       'the JSON-RPC error envelope is { jsonrpc, id, error: { code, message, data } }');

    // Scoping sanity: a worker's card-visible set = {itself, its manager}; a manager's = itself + crew.
    const wv = await cardVisibleXellIds(worker);
    ok(wv.has(worker.id) && wv.has(manager.id) && !wv.has(sibling.id),
       'card scope: a worker may read itself + its manager, not a sibling');
    const mv = await cardVisibleXellIds(manager);
    ok(mv.has(manager.id) && mv.has(worker.id) && mv.has(sibling.id),
       'card scope: a manager may read itself + its crew');
    const wtv = await taskVisibleXellIds(worker);
    ok(wtv.has(worker.id) && !wtv.has(manager.id), 'task scope: a worker\'s tasks are its own conversations only');

    console.log(`    (taskId=${taskId.slice(0, 8)}…, manager=${manager.slug}, worker=${worker.slug}, sibling=${sibling.slug})`);
  } finally {
    if (projectId) await q(`DELETE FROM project WHERE id=$1`, [projectId]).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
