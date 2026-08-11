// THE A2A READ SIDE — the DB half of the projection (docs/a2a-protocol-plan.md §3, P2).
//
// lib/a2a.js is the PURE half (rowToMessage / rowToTask / the card builders); THIS module is the
// non-pure half — the queries that gather rows from zee_message and turn them into A2A Tasks and
// cards. It exists so the read-model functions are testable standalone against DATABASE_URL (the
// same reason postMessage lives in lib/managers.js rather than in the routes). The HTTP wiring —
// auth (resolveSelf), A2A-Version, Content-Type, the SSE transport — lives in routes.js's a2aRouter.
//
// Scoping is plan §3.4, unchanged from zee say / zee report: a worker may READ its manager, a
// manager may read its CREW (cardVisibleXellIds — the directory and the per-agent cards). For
// TASKS the scope is the caller's own conversations (taskVisibleXellIds): a worker sees tasks it
// is a participant in, a manager sees tasks involving itself or any of its crew. A2A adds no reach
// that messagesForXell (lib/managers.js) does not already have.
import { q, one } from '../db/pool.js';
import { rowToTask, buildAgentCard, A2A_ERROR } from './a2a.js';
import { effectiveHarness } from './harness.js';
import { isManager } from './managers.js';

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

// Who may the caller READ as an AGENT (the directory + the per-agent cards)? Everyone reads
// itself; a worker may additionally read its manager; a manager may read its crew (plan §3.4).
export async function cardVisibleXellIds(caller) {
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
// messagesForXell does not have.
export async function taskVisibleXellIds(caller) {
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

// GetTask — returns { task } or throws A2AError(TaskNotFoundError, -32001).
export async function getTask(caller, taskId, { visible = null } = {}) {
  if (!taskId || typeof taskId !== 'string') throw new A2AError(JSONRPC_INVALID_PARAMS, 'params.taskId is required');
  const vis = visible || await taskVisibleXellIds(caller);
  const task = await loadTask(taskId, vis);
  if (!task) throw new A2AError(A2A_ERROR.TaskNotFound, `no task "${taskId}"`);
  return { task };
}

// ListTasks — returns { tasks }, filtered to the caller's visibility (plan §3.2).
export async function listTasks(caller, { visible = null } = {}) {
  const vis = visible || await taskVisibleXellIds(caller);
  return { tasks: await loadTasks(vis) };
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

// The A2A JSON-RPC dispatch table (plan §3.2) — the refusal methods answer with their exact spec
// codes, unknown methods with JSON-RPC MethodNotFound. SubscribeToTask returns its snapshot here;
// the route swaps the JSON response for an SSE stream. `visible` is an optional precomputed
// task-visible set (the route computes it once); the methods derive it when absent.
export async function dispatchA2A(caller, method, params = {}, { visible = null } = {}) {
  switch (method) {
    case 'GetTask': return getTask(caller, params?.taskId, { visible });
    case 'ListTasks': return listTasks(caller, { visible });
    case 'SubscribeToTask': return subscribeSnapshot(caller, params?.taskId, { visible });
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
