// THE A2A READ + WRITE SIDE — the DB half of the projection (docs/a2a-protocol-plan.md §3, P2 + P3).
//
// lib/a2a.js is the PURE half (rowToMessage / rowToTask / the card builders / partsToBody /
// cancelVerdict); THIS module is the non-pure half — the queries that gather rows from zee_message
// and turn them into A2A Tasks and cards, and the write methods (SendMessage / SendStreamingMessage
// / CancelTask) that map an A2A call onto postMessage and the canceled envelope state. It exists so
// the read/write-model functions are testable standalone against DATABASE_URL (the same reason
// postMessage lives in lib/managers.js rather than in the routes). The HTTP wiring — auth
// (resolveSelf), A2A-Version, Content-Type, the SSE transport — lives in routes.js's a2aRouter.
//
// Scoping is plan §3.4, unchanged from zee say / zee report: a worker may ADDRESS its manager, a
// manager may address its CREW (cardVisibleXellIds — the directory, the per-agent cards, and who a
// SendMessage may be sent to). For TASKS the scope is the caller's own conversations
// (taskVisibleXellIds): a worker sees tasks it is a participant in, a manager sees tasks involving
// itself or any of its crew. A2A adds no reach that messagesForXell (lib/managers.js) does not
// already have. CancelTask is sender-only on top of that (plan §3.2): only the xell that OPENED the
// task may cancel it, and only while it is still undelivered/queued.
import { q, one } from '../db/pool.js';
import { rowToTask, rowToMessage, buildAgentCard, A2A_ERROR, partsToBody, cancelVerdict,
         archiveRowToTask, memoryRowsToTask, turnRowToTask, conversationTaskId } from './a2a.js';
import { broadcast } from './events.js';
import { effectiveHarness } from './harness.js';
import { isManager, postMessage } from './managers.js';

const JSONRPC_INVALID_PARAMS = { code: -32602, name: 'InvalidParams' };
const JSONRPC_METHOD_NOT_FOUND = { code: -32601, name: 'MethodNotFound' };

// A JSON-RPC error carrying the spec's code/name — thrown by the read methods, caught by the route
// and answered as { jsonrpc, id, error: { code, message, data } } (plan §3.2, DR-5).
export class A2AError extends Error {
  constructor(spec, message) {
    super(message);
    this.code = spec.code;
    this.errorName = spec.name;
    this.data = { message };
  }
  toJSONRPC(id) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: this.code, message: this.errorName, data: this.data } };
  }
}

// The EXTERNAL caller (phase 4) — a project API key with the `a2a` scope (plan §3.4, DR-6). A key
// is a PROJECT, not a xell: it may see and address only the agents its project owns, and its task
// views carry no xell ids, no tokens, no internal counts (the ticketing API's id-scrub precedent,
// lib/ticket-intake.js externalView). `id` is deliberately null — the read methods scope by
// project (projectXellIds below) and the write methods stamp the message's provenance as
// `ext:<project name>` rather than fabricate a xell.
export function externalCaller(auth) {
  return {
    kind: 'external',
    id: null,
    project_id: auth.project.id,
    project_name: auth.project.name,
    key: auth.key,
    slug: `ext:${auth.project.name}`,
    manager_xell_id: null,
  };
}

// Every non-retired xell of one project — the whole of what an external caller may see and address
// ("an A2A-scoped key sees and may address only agents its project owns", plan §3.4).
async function projectXellIds(projectId) {
  const rows = await q(`SELECT id FROM xell WHERE project_id=$1 AND status <> 'retired'`, [projectId]);
  return new Set(rows.map((r) => r.id));
}

// Who may the caller READ as an AGENT (the directory + the per-agent cards)? Everyone reads
// itself; a worker may additionally read its manager; a manager may read its crew (plan §3.4).
// An external caller reads the agents its project owns.
export async function cardVisibleXellIds(caller) {
  if (caller.kind === 'external') return projectXellIds(caller.project_id);
  const ids = new Set([caller.id]);
  if (caller.manager_xell_id) ids.add(caller.manager_xell_id);
  const rows = await q(`SELECT id FROM xell WHERE manager_xell_id=$1 AND status <> 'retired'`, [caller.id]);
  for (const r of rows) ids.add(r.id);
  return ids;
}

// Which PARTICIPANTS may the caller's TASKS involve? A worker's own conversations only (a task
// must name it as a participant); a manager may additionally read its crew's conversations. This
// is deliberately narrower than cardVisible: "a worker may read its manager" means it may ADDRESS
// its manager, not that it may read all of the manager's conversations — A2A adds no reach that
// messagesForXell does not have. An external caller's tasks involve its project's agents.
export async function taskVisibleXellIds(caller) {
  if (caller.kind === 'external') return projectXellIds(caller.project_id);
  const ids = new Set([caller.id]);
  if (isManager(caller)) {
    const rows = await q(`SELECT id FROM xell WHERE manager_xell_id=$1 AND status <> 'retired'`, [caller.id]);
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

// Whether the recipient has an open zee tend right now (plan §3.3: a live task the recipient
// flagged as needing a human → input-required). Same read as crewFor: the latest tend-request /
// tend-clear session_event decides.
export async function tendOpenFor(xellId) {
  if (!xellId) return false;
  const r = await one(
    `SELECT se.hook_event_name FROM session_event se
      WHERE se.xell_id=$1 AND se.hook_event_name IN ('tend-request','tend-clear')
      ORDER BY se.ts DESC LIMIT 1`, [xellId]);
  return r?.hook_event_name === 'tend-request';
}

// One Task by id, or null. `visible` is a Set of participant xell ids the caller may see; a task
// whose opening row names no visible participant is treated as not found (never leaked). The Task
// is built by the pure rowToTask (lib/a2a.js) — the projection, never a second store (DR-3).
export async function loadTask(taskId, visible) {
  const opening = await one(
    `SELECT * FROM zee_message WHERE meta->'a2a'->>'taskId'=$1 AND kind='directive'`, [taskId]);
  if (!opening) return null;
  if (!visible.has(opening.from_xell_id) && !visible.has(opening.to_xell_id)) return null;
  const replies = await q(
    `SELECT * FROM zee_message WHERE meta->'a2a'->>'referencedTaskId'=$1 ORDER BY created_at ASC`, [taskId]);
  const tendOpen = opening.to_xell_id ? await tendOpenFor(opening.to_xell_id) : false;
  return rowToTask({ opening, replies, tendOpen });
}

// Every task in the caller's visible set, newest first. Seq scan on meta->a2a — the plan's P2 row
// says it is acceptable at current volumes (the fleet's measured turn count is 520 rows).
export async function loadTasks(visible) {
  if (!visible.size) return [];
  const openings = await q(
    `SELECT * FROM zee_message
      WHERE kind='directive' AND meta->'a2a'->>'taskId' IS NOT NULL
        AND (from_xell_id = ANY($1::uuid[]) OR to_xell_id = ANY($1::uuid[]))
      ORDER BY created_at DESC`, [Array.from(visible)]);
  const tasks = [];
  for (const opening of openings) {
    const replies = await q(
      `SELECT * FROM zee_message WHERE meta->'a2a'->>'referencedTaskId'=$1 ORDER BY created_at ASC`,
      [opening.meta.a2a.taskId]);
    const tendOpen = opening.to_xell_id ? await tendOpenFor(opening.to_xell_id) : false;
    const task = rowToTask({ opening, replies, tendOpen });
    if (task) tasks.push(task);
  }
  return tasks;
}

// ── EXTENSION (DR-8): the other conversation stores as A2A Tasks ─────────────
// "All zee conversations" is decided (DR-8) as: xell_conversation archives (112), zee_conversation
// working memory (192), and zee_turn ledger rows (153) each project onto A2A Tasks with
// DETERMINISTIC ids (uuid v5 of a store-namespaced natural key, minted at READ time — nothing is
// written, no backfill, the same row always projects to the same id). session_event stays OUT: it
// is the control-plane hook/play-by-play log, not a conversation (DR-8; the zee_turn Task's
// metadata already names its turn). Scope is the same crew rule as the zee_message plane: the
// caller may read conversations OF itself and its crew (taskVisibleXellIds).

// A store row id → { kind, id } when the row's store row is a conversation the caller may read.
// The deterministic task id is computed and returned as a POJO (the caller's loadTask consumes a
// zee_message-shaped row; these are separate lookups).
const CONVERSATION_LOADERS = [
  { store: 'xell_conversation', sql: `SELECT * FROM xell_conversation WHERE id=$1`, build: archiveRowToTask },
  { store: 'zee_turn', sql: `SELECT * FROM zee_turn WHERE id=$1`, build: turnRowToTask },
];

// One conversation Task by its DETERMINISTIC id (uuid v5 of `store:naturalKey`). The id is derived,
// not stored — so lookups must reverse it. We cannot reverse a v5 id, so the route resolves a
// conversation id by scanning the caller's visible xells' stores (volumes are small: archives and
// turns per xell, and the zee_message seq-scan precedent already accepts this at fleet volume).
export async function loadConversationTask(caller, taskId, { visible = null } = {}) {
  const vis = visible || await taskVisibleXellIds(caller);
  if (!vis.size) return null;
  const xellIds = Array.from(vis);
  // The lookup is by the DETERMINISTIC id, which is NOT the store row id — it is a v5 of it. To
  // reverse it we scan the caller's visible rows and compute the v5 for each, matching the caller's
  // taskId (the same approach loadConversationTasks uses to list them). This is the cost of "no
  // second store" (DR-3): the ids are derived, never stored, so a reverse lookup is a scan. At
  // fleet volume (archives + turns per xell, the 520-row zee_message precedent) this is fine.
  const archs = await q(
    `SELECT * FROM xell_conversation WHERE xell_id = ANY($1::uuid[])`, [xellIds]);
  for (const a of archs) {
    if (conversationTaskId('xell_conversation', a.id) === taskId) return archiveRowToTask(a);
  }
  // zee_conversation — natural key is the XELL id, so the deterministic task id is v5("zee_conversation", xell_id).
  const mems = await q(`SELECT DISTINCT xell_id FROM zee_conversation WHERE xell_id = ANY($1::uuid[])`, [xellIds]);
  for (const m of mems) {
    if (conversationTaskId('zee_conversation', m.xell_id) === taskId) {
      const rows = await q(
        `SELECT role, content, name, created_at FROM zee_conversation WHERE xell_id=$1 ORDER BY seq ASC`, [m.xell_id]);
      return memoryRowsToTask({ xellId: m.xell_id, rows });
    }
  }
  const turns = await q(
    `SELECT * FROM zee_turn WHERE xell_id = ANY($1::uuid[])`, [xellIds]);
  for (const t of turns) {
    if (conversationTaskId('zee_turn', t.id) === taskId) return turnRowToTask(t);
  }
  return null;
}

// Every conversation Task the caller may read (archives, working memories, turns), newest first.
export async function loadConversationTasks(caller, { visible = null, limit = 50 } = {}) {
  const vis = visible || await taskVisibleXellIds(caller);
  if (!vis.size) return [];
  const xellIds = Array.from(vis);
  const out = [];
  // Archives of the caller's visible xells.
  const archs = await q(
    `SELECT * FROM xell_conversation WHERE xell_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT $2`,
    [xellIds, Math.min(Math.max(Number(limit) || 50, 1), 500)]);
  for (const a of archs) { const t = archiveRowToTask(a); if (t) out.push(t); }
  // Working memories — one per visible xell (only when it has rows).
  const mems = await q(
    `SELECT DISTINCT xell_id FROM zee_conversation WHERE xell_id = ANY($1::uuid[])`, [xellIds]);
  for (const m of mems) {
    const rows = await q(
      `SELECT role, content, name, created_at FROM zee_conversation WHERE xell_id=$1 ORDER BY seq ASC`, [m.xell_id]);
    const t = memoryRowsToTask({ xellId: m.xell_id, rows });
    if (t) out.push(t);
  }
  // Turns of the caller's visible xells.
  const turns = await q(
    `SELECT * FROM zee_turn WHERE xell_id = ANY($1::uuid[]) ORDER BY started_at DESC LIMIT $2`,
    [xellIds, Math.min(Math.max(Number(limit) || 50, 1), 500)]);
  for (const t of turns) { const tt = turnRowToTask(t); if (tt) out.push(tt); }
  return out.slice(0, Math.min(Number(limit) || 50, 500));
}

// GetTask — returns { task } or throws A2AError(TaskNotFoundError, -32001).
export async function getTask(caller, taskId, { visible = null } = {}) {
  if (!taskId || typeof taskId !== 'string') throw new A2AError(JSONRPC_INVALID_PARAMS, 'params.taskId is required');
  const vis = visible || await taskVisibleXellIds(caller);
  const task = await loadTask(taskId, vis) || await loadConversationTask(caller, taskId, { visible: vis });
  if (!task) throw new A2AError(A2A_ERROR.TaskNotFound, `no task "${taskId}"`);
  return { task };
}

// ListTasks — returns { tasks }, filtered to the caller's visibility (plan §3.2). The extension
// (DR-8) adds the caller's conversation Tasks (archives, working memories, turns) after the
// zee_message Tasks — the whole conversation set in one read.
export async function listTasks(caller, { visible = null, limit = 50 } = {}) {
  const vis = visible || await taskVisibleXellIds(caller);
  const tasks = await loadTasks(vis);
  const conv = await loadConversationTasks(caller, { visible: vis, limit });
  return { tasks: [...tasks, ...conv].slice(0, Math.min(Math.max(Number(limit) || 50, 1), 500)) };
}

// SubscribeToTask — the read half: return the current Task snapshot (the stream itself is the
// route's job, riding the existing zee-message broadcast bus). Throws TaskNotFoundError for an
// id with no enveloped row (plan §3.2, same visibility rule as GetTask).
export async function subscribeSnapshot(caller, taskId, { visible = null } = {}) {
  if (!taskId || typeof taskId !== 'string') throw new A2AError(JSONRPC_INVALID_PARAMS, 'params.taskId is required');
  const vis = visible || await taskVisibleXellIds(caller);
  const task = await loadTask(taskId, vis);
  if (!task) throw new A2AError(A2A_ERROR.TaskNotFound, `no task "${taskId}"`);
  return { task };
}

// SendMessage — plan §3.2, DR-3/DR-6. The SENDER is the caller resolved from the credential (the
// route's resolveSelf), NEVER the payload; the RECIPIENT is the agent at the :slug the route
// already card-checked. Text parts are concatenated into the body; DataPart/FilePart answer
// ContentTypeNotSupportedError (-32005). A message with no taskId OPENS a task (kind='directive',
// which mints the taskId); a message that names an existing task is a REPLY (kind='message', and
// its referencedTaskId is the named task — honored over the derived one so a reply can never be
// orphaned by an intervening directive). The row is written by the UNCHANGED postMessage — the
// envelope is the only A2A mark (DR-3).
export async function sendMessage(caller, agent, message = {}, { visible = null } = {}) {
  if (!message || typeof message !== 'object') throw new A2AError(JSONRPC_INVALID_PARAMS, 'params.message is required');
  const parsed = partsToBody(message?.parts);
  if (parsed.error) {
    if (parsed.error === A2A_ERROR.ContentTypeNotSupported.name) {
      throw new A2AError(A2A_ERROR.ContentTypeNotSupported,
        'v1 supports text parts only — DataPart/FilePart are not supported');
    }
    throw new A2AError(JSONRPC_INVALID_PARAMS, parsed.error);
  }
  const taskId = message?.taskId || null;
  const kind = taskId ? 'message' : 'directive';
  let referencedTaskId = null;
  if (kind === 'message') {
    const vis = visible || await taskVisibleXellIds(caller);
    const task = await loadTask(taskId, vis);
    if (!task) throw new A2AError(A2A_ERROR.TaskNotFound, `no task "${taskId}"`);
    referencedTaskId = taskId;
  }
  const result = await postMessage({ from: caller, to: agent, body: parsed.body, kind, referencedTaskId });
  return { message: rowToMessage(result.message) };
}

// CancelTask — plan §3.2. Sender-only: only the xell that OPENED the task may cancel it, and only
// while the task is still undelivered/queued (cancelVerdict — the moment delivery says
// 'resumed'/'typed' the turn is running and a peer's RPC must never interrupt it). Marks the
// envelope's stored state 'canceled' (the ONLY stored state; every other state is derived, §3.3).
// Cancel never interrupts a turn. Visibility is the read side's rule — a task the caller is not a
// participant of is TaskNotFound (-32001, never leaked); a visible task it did not send is
// TaskNotCancelableError (-32002).
export async function cancelTask(caller, taskId, { visible = null } = {}) {
  if (!taskId || typeof taskId !== 'string') throw new A2AError(JSONRPC_INVALID_PARAMS, 'params.taskId is required');
  const vis = visible || await taskVisibleXellIds(caller);
  const opening = await one(
    `SELECT * FROM zee_message WHERE meta->'a2a'->>'taskId'=$1 AND kind='directive'`, [taskId]);
  if (!opening) throw new A2AError(A2A_ERROR.TaskNotFound, `no task "${taskId}"`);
  if (!vis.has(opening.from_xell_id) && !vis.has(opening.to_xell_id)) {
    throw new A2AError(A2A_ERROR.TaskNotFound, `no task "${taskId}"`);
  }
  if (opening.from_xell_id !== caller.id) {
    throw new A2AError(A2A_ERROR.TaskNotCancelable, `task "${taskId}" can only be canceled by its sender`);
  }
  const replies = await q(
    `SELECT id FROM zee_message WHERE meta->'a2a'->>'referencedTaskId'=$1`, [taskId]);
  const verdict = cancelVerdict({ delivery: opening.delivery, hasReply: replies.length > 0 });
  if (!verdict.allowed) {
    throw new A2AError(A2A_ERROR.TaskNotCancelable, `task "${taskId}" is not cancelable — ${verdict.reason}`);
  }
  await q(
    `UPDATE zee_message SET meta = jsonb_set(meta, '{a2a,state}', '"canceled"') WHERE id=$1`, [opening.id]);
  // Let a streaming client see the state change: the SubscribeToTask/SendStreamingMessage SSE
  // handler filters the zee-message bus and re-loads the task from this row.
  broadcast('zee-message', { id: opening.id, to_xell_id: opening.to_xell_id,
                             from_xell_id: opening.from_xell_id, kind: opening.kind });
  const task = await loadTask(taskId, vis);
  return { task };
}

// The A2A JSON-RPC dispatch table (plan §3.2) — the refusal methods answer with their exact spec
// codes, unknown methods with JSON-RPC MethodNotFound. SubscribeToTask returns its snapshot here
// and SendStreamingMessage returns its sent Message here; the route swaps the JSON response for an
// SSE stream for both. `visible` is an optional precomputed task-visible set (the route computes it
// once); the methods derive it when absent. `agent` is the addressed xell (the :slug) the write
// methods send to — already card-checked by the route.
export async function dispatchA2A(caller, method, params = {}, { visible = null, agent = null } = {}) {
  switch (method) {
    case 'GetTask': return getTask(caller, params?.taskId, { visible });
    case 'ListTasks': return listTasks(caller, { visible });
    case 'SubscribeToTask': return subscribeSnapshot(caller, params?.taskId, { visible });
    case 'SendMessage':
    case 'SendStreamingMessage':
      return sendMessage(caller, agent, params?.message, { visible });
    case 'CancelTask': return cancelTask(caller, params?.taskId, { visible });
    case 'PushNotificationConfig':
      throw new A2AError(A2A_ERROR.PushNotificationNotSupported,
        'push notifications are not supported by this server');
    case 'GetExtendedAgentCard':
      throw new A2AError(A2A_ERROR.ExtendedAgentCardNotConfigured,
        'no extended agent card is configured for this agent');
    default:
      throw new A2AError(JSONRPC_METHOD_NOT_FOUND, `unknown method "${method}"`);
  }
}

// The merged skills a harness contributes to a card (plan §3.1: one AgentSkill per harness skill,
// id = the skill key, description = its When: line). effectiveHarness unions the inheritance chain.
export async function skillsForHarness(harnessId) {
  if (!harnessId) return [];
  const h = await one(`SELECT * FROM harness WHERE id=$1 AND enabled`, [harnessId]);
  if (!h) return [];
  const eff = await effectiveHarness(h);
  return eff?.skills || [];
}

// The per-agent card, GENERATED per request from live rows (house rule 7). One query gathers the
// xell + its latest live zee's name + its harness label + its latest task brief; the skills come
// from the harness row. Pure buildAgentCard (lib/a2a.js) does the shaping.
export async function agentCardFor(xell, base, { consoleUrl = null } = {}) {
  const row = await one(
    `SELECT x.*, z.name AS zee_name, h.key AS harness_key, h.label AS harness_label,
            (SELECT prompt_text FROM task t WHERE t.xell_id=x.id ORDER BY t.created_at DESC LIMIT 1) AS task_brief
       FROM xell x
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id=x.id AND zz.decommissioned_at IS NULL
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC LIMIT 1) z ON true
       LEFT JOIN harness h ON h.id = x.harness_id
      WHERE x.id=$1`, [xell.id]);
  if (!row) return null;
  const skills = await skillsForHarness(row.harness_id);
  return buildAgentCard({
    xell: { ...row, harness_label: row.harness_label || null },
    base,
    consoleUrl,
    zeeName: row.zee_name || null,
    skills,
    taskBrief: row.task_brief || null,
  });
}

// The directory (plan §3.1 extension — A2A defines no registry): live agents the caller's
// credential may see, each with its card URL.
export async function directoryFor(caller, base) {
  const visible = await cardVisibleXellIds(caller);
  if (!visible.size) return { agents: [], count: 0 };
  const rows = await q(
    `SELECT x.id, x.slug, z.name AS zee_name
       FROM xell x
       LEFT JOIN LATERAL (
         SELECT * FROM zee zz WHERE zz.xell_id=x.id AND zz.decommissioned_at IS NULL
          ORDER BY CASE WHEN zz.status IN ('spawning','online','working','idle') THEN 0 ELSE 1 END,
                   zz.created_at DESC LIMIT 1) z ON true
      WHERE x.id = ANY($1::uuid[]) AND x.status <> 'retired'
      ORDER BY x.slug`, [Array.from(visible)]);
  const agents = rows.map((r) => ({
    slug: r.slug,
    name: r.zee_name ? `${r.zee_name} · ${r.slug}` : r.slug,
    url: `${base}/a2a/v1/agents/${r.slug}/card`,
  }));
  return { agents, count: agents.length };
}
