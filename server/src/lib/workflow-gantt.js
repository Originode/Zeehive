// WORKFLOW GANTT — the hierarchical-workflow model's timeline read model.
//
// The work tracker's gantt (work-items.js ganttModel) draws WORK_ITEM rows: the board's
// hierarchy read against time, with a human's dates. Stage 6 re-points the timeline at THE
// MODEL — the plan/work_node/execution/lease plane — so the same chart becomes the top-level
// trace from the plan's start to its end-goal root. Three layers per row:
//
//   PLANNED — from the CPM pass (wn_cpm, migration 184): earliest_start/finish for atoms,
//             subtree span for containers, plus slack + critical. The CPM is a READ model;
//             nothing here writes work_node.earliest_*/latest_*.
//   ACTUAL  — from execution.started_at/finished_at (what the record PROVES happened,
//             read-only). A container rolls its subtree's executions up the same way the
//             work-item gantt rolls actuals up.
//   WAITING — from leases HELD on executions in state 'waiting': a gate wait (a landing
//             held for a human, a holding pattern) becomes a visible bar. Claimed_at →
//             expires_at is the window; the layer must scale across the measured reality
//             (landings avg 10.7 min, max 15.2 h; holdings avg 6.5 DAYS), which is why the
//             timescale's clamp exists.
//
// DEPENDENCY EDGES come from union_edge (leaf-expanded). A collapsed parent hides its
// children; the CLIENT re-anchors an edge whose endpoint is hidden onto the nearest visible
// ancestor's bar rather than dropping the edge (Gantt.jsx does that walk). This read model
// serves the leaf-level edges and the tree; it does not pre-collapse anything.
//
// CLICK-THROUGH: each row carries its executions with their turns and gateway calls (the
// weld's nested read shape, same as workflowTreeForXell), so clicking a bar opens the
// execution → turn → gateway waterfall without a second round trip.
//
// READ-ONLY by construction: every SELECT here is a byproduct of doors (the CPM pass, the
// turn ledger, the gateway proxy). No new write paths.
import { q, one } from '../db/pool.js';
import { httpError } from './work-items.js';

export const bad = (m) => httpError(400, m);

// The project → plan → latest published version with a root. A project with several plans
// shows the NEWEST plan's newest version (the end-goal root is the latest expression of the
// project's plan). Returns null when the project has no usable plan.
export async function planVersionForProject(projectId) {
  return one(
    `SELECT pv.id AS plan_version_id, p.id AS plan_id, p.name AS plan_name,
            pv.version, pv.root_node_id
       FROM plan p
       JOIN plan_version pv ON pv.plan_id = p.id
      WHERE p.project_id = $1 AND pv.root_node_id IS NOT NULL
      ORDER BY p.created_at DESC, pv.version DESC
      LIMIT 1`, [projectId]);
}

// The full read model the timeline draws. Returns { ok, root, project_id, plan_version_id,
// plan_id, plan_name, version, rows, span } or throws bad('…') when there is no plan.
export async function workflowGanttModel({ projectId, rootId = null } = {}) {
  if (!projectId && !rootId) throw bad('project or root required');
  if (projectId) {
    // project-scoped: resolve the project's latest plan version
    const pv = await planVersionForProject(projectId);
    if (!pv) {
      return {
        ok: true, root: null, project_id: projectId, plan_version_id: null,
        plan_id: null, plan_name: null, version: null, rows: [], span: null,
      };
    }
    const { rows, span } = await rowsForVersion(pv.plan_version_id, pv.root_node_id, pv);
    return {
      ok: true,
      root: rows.find((r) => r.id === pv.root_node_id) || null,
      project_id: projectId,
      plan_version_id: pv.plan_version_id,
      plan_id: pv.plan_id, plan_name: pv.plan_name, version: pv.version,
      rows, span,
    };
  }
  // root-scoped: the caller named a work_node id directly
  const rootNode = await one(`SELECT id, name, plan_version_id FROM work_node WHERE id=$1`, [rootId]);
  if (!rootNode) throw bad('no such work node');
  const pv = await one(
    `SELECT pv.id AS plan_version_id, p.id AS plan_id, p.name AS plan_name,
            pv.version, pv.root_node_id
       FROM plan_version pv JOIN plan p ON p.id = pv.plan_id
      WHERE pv.id = $1`, [rootNode.plan_version_id]);
  const { rows, span } = await rowsForVersion(pv.plan_version_id, rootNode.id, pv);
  return {
    ok: true,
    root: rows.find((r) => r.id === rootNode.id) || null,
    project_id: null,
    plan_version_id: pv.plan_version_id,
    plan_id: pv.plan_id, plan_name: pv.plan_name, version: pv.version,
    rows, span,
  };
}

// ── rows ────────────────────────────────────────────────────────────────────────
async function rowsForVersion(versionId, rootId, pv) {
  const versionIdArg = versionId;
  // The whole tree under the root, in tree order (depth-first by sibling_rank).
  const tree = await q(
    `WITH RECURSIVE t AS (
        SELECT w.*, 1 AS depth FROM work_node w WHERE w.id = $1
        UNION ALL
        SELECT w.*, t.depth + 1 FROM work_node w JOIN t ON w.parent_id = t.id
     )
     SELECT id, parent_id, name, kind, child_semantics, sibling_rank, estimate, depth
       FROM t ORDER BY depth, sibling_rank`, [rootId]);

  // The CPM schedule (atoms + container spans) for the same version.
  const schedule = await q(
    `SELECT node_id, name, is_atom, parent_id, duration,
            earliest_start, earliest_finish, latest_start, latest_finish,
            slack, critical
       FROM wn_cpm($1::uuid, NULL)`, [versionIdArg]);
  const schedBy = new Map(schedule.map((s) => [s.node_id, s]));

  // The union graph's leaf-level dependency edges for this version (origin + lag + type).
  const edges = await q(
    `SELECT from_id, to_id, type, lag FROM union_edge WHERE plan_version_id = $1`, [versionIdArg]);

  const nodeIds = tree.map((n) => n.id);

  // Executions for every node in the tree, plus their entity.
  const executions = nodeIds.length
    ? await q(
        `SELECT e.id, e.work_node_id, e.run_id, e.state, e.attempt, e.map_index, e.loop_iteration,
                e.started_at, e.finished_at, e.outputs, e.error,
                en.name AS entity_name, en.kind_hint AS entity_kind_hint
           FROM execution e
           LEFT JOIN entity en ON en.id = e.entity_id
          WHERE e.work_node_id = ANY($1::uuid[])
          ORDER BY e.started_at ASC NULLS LAST, e.id`, [nodeIds])
    : [];
  const execsByNode = new Map();
  for (const ex of executions) {
    if (!execsByNode.has(ex.work_node_id)) execsByNode.set(ex.work_node_id, []);
    execsByNode.get(ex.work_node_id).push(ex);
  }

  // Leases on those executions (the WAITING layer: held leases on 'waiting' executions).
  const execIds = executions.map((e) => e.id);
  const leases = execIds.length
    ? await q(
        `SELECT l.id, l.execution_id, l.entity_id, l.state, l.claimed_at, l.expires_at, l.released_at,
                en.name AS entity_name, en.kind_hint AS entity_kind_hint
           FROM lease l
           LEFT JOIN entity en ON en.id = l.entity_id
          WHERE l.execution_id = ANY($1::uuid[])
          ORDER BY l.claimed_at ASC`, [execIds])
    : [];
  const leasesByExec = new Map();
  for (const l of leases) {
    if (!leasesByExec.has(l.execution_id)) leasesByExec.set(l.execution_id, []);
    leasesByExec.get(l.execution_id).push(l);
  }

  // The weld drill-down: turns for the executions, and gateway calls for those turns.
  const turns = execIds.length
    ? await q(
        `SELECT t.id, t.execution_id, t.kind, t.status, t.model, t.started_at, t.ended_at,
                t.stop_reason, t.summary, z.name AS zee_name
           FROM zee_turn t LEFT JOIN zee z ON z.id = t.zee_id
          WHERE t.execution_id = ANY($1::uuid[])
          ORDER BY t.started_at ASC`, [execIds])
    : [];
  const turnIds = [...new Set(turns.map((t) => t.id))];
  const reqs = turnIds.length
    ? await q(
        `SELECT id, turn_id, provider, model, method, path, status,
                input_tokens, output_tokens, cost_usd, duration_ms, requested_at, completed_at
           FROM llm_gateway_request WHERE turn_id = ANY($1::uuid[])
          ORDER BY requested_at ASC`, [turnIds])
    : [];
  const reqsByTurn = new Map();
  for (const r of reqs) {
    if (!reqsByTurn.has(r.turn_id)) reqsByTurn.set(r.turn_id, []);
    reqsByTurn.get(r.turn_id).push(r);
  }
  const turnsByExec = new Map();
  for (const t of turns) {
    if (!turnsByExec.has(t.execution_id)) turnsByExec.set(t.execution_id, []);
    turnsByExec.get(t.execution_id).push({ ...t, gateway_requests: reqsByTurn.get(t.id) || [] });
  }

  // deps by successor (leaf-level): a row lists the ids it waits on
  const depsBy = new Map();
  for (const e of edges) {
    if (!depsBy.has(e.to_id)) depsBy.set(e.to_id, []);
    depsBy.get(e.to_id).push(e.from_id);
  }

  // parent map + subtree leaf lists for ACTUAL/WAITING roll-up to containers.
  const parentOf = new Map(tree.map((n) => [n.id, n.parent_id]));
  const childrenOf = new Map();
  for (const n of tree) {
    if (!n.parent_id) continue;
    if (!childrenOf.has(n.parent_id)) childrenOf.set(n.parent_id, []);
    childrenOf.get(n.parent_id).push(n.id);
  }

  // subtree = the node and all its descendants (ids)
  const subtree = (id) => {
    const out = new Set([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const c of childrenOf.get(cur) || []) { if (!out.has(c)) { out.add(c); stack.push(c); } }
    }
    return out;
  };

  // Roll actuals + waiting up: for each row, min/max over its subtree's executions.
  const actualOf = new Map();   // node id -> { start, end }
  const waitingOf = new Map();  // node id -> { start, end }
  for (const n of tree) {
    let aStart = null, aEnd = null, wStart = null, wEnd = null;
    for (const sid of subtree(n.id)) {
      for (const ex of execsByNode.get(sid) || []) {
        if (ex.started_at && (aStart === null || ex.started_at < aStart)) aStart = ex.started_at;
        if (ex.finished_at && (aEnd === null || ex.finished_at > aEnd)) aEnd = ex.finished_at;
        // WAITING = a HELD lease on a 'waiting' execution (the gate-wait window)
        if (ex.state === 'waiting') {
          for (const l of leasesByExec.get(ex.id) || []) {
            if (l.state !== 'held') continue;
            if (wStart === null || l.claimed_at < wStart) wStart = l.claimed_at;
            if (wEnd === null || l.expires_at > wEnd) wEnd = l.expires_at;
          }
        }
      }
    }
    actualOf.set(n.id, { start: aStart, end: aEnd });
    waitingOf.set(n.id, { start: wStart, end: wEnd });
  }

  const rows = tree.map((n) => {
    const s = schedBy.get(n.id);
    const a = actualOf.get(n.id) || { start: null, end: null };
    const w = waitingOf.get(n.id) || { start: null, end: null };
    const exs = execsByNode.get(n.id) || [];
    return {
      id: n.id, parent_id: n.parent_id, depth: n.depth, name: n.name,
      kind: n.kind, child_semantics: n.child_semantics,
      is_atom: !!(s && s.is_atom),
      duration_hours: s && s.duration ? intervalHours(s.duration) : null,
      critical: !!(s && s.critical),
      slack: s && s.slack ? s.slack : null,
      // PLANNED (CPM). Atoms carry their own earliest window; containers the subtree span.
      planned_start: s && s.earliest_start ? iso(s.earliest_start) : null,
      planned_end: s && s.earliest_finish ? iso(s.earliest_finish) : null,
      latest_start: s && s.latest_start ? iso(s.latest_start) : null,
      latest_finish: s && s.latest_finish ? iso(s.latest_finish) : null,
      // ACTUAL (execution ledger, rolled to containers)
      actual_start: a.start ? iso(a.start) : null,
      actual_end: a.end ? iso(a.end) : null,
      // WAITING (held leases on waiting executions, rolled to containers)
      waiting_start: w.start ? iso(w.start) : null,
      waiting_end: w.end ? iso(w.end) : null,
      deps: depsBy.get(n.id) || [],
      executions: exs.map((ex) => ({
        id: ex.id, state: ex.state, attempt: ex.attempt, map_index: ex.map_index,
        loop_iteration: ex.loop_iteration, started_at: ex.started_at ? iso(ex.started_at) : null,
        finished_at: ex.finished_at ? iso(ex.finished_at) : null,
        entity_name: ex.entity_name, entity_kind_hint: ex.entity_kind_hint,
        turns: turnsByExec.get(ex.id) || [],
      })),
    };
  });

  // whole-chart extent for the timescale's window
  const scheduled = rows.filter((r) =>
    (r.planned_start && r.planned_end) || (r.actual_start && r.actual_end)
    || (r.waiting_start && r.waiting_end));
  const span = scheduled.length
    ? {
        start: minOf(scheduled.flatMap((r) => [r.planned_start, r.actual_start, r.waiting_start]).filter(Boolean)),
        end: maxOf(scheduled.flatMap((r) => [r.planned_end, r.actual_end, r.waiting_end]).filter(Boolean)),
      }
    : null;

  return { rows, span };
}

const iso = (d) => (d instanceof Date ? d.toISOString() : String(d));
const intervalHours = (iv) => {
  // a pg interval from node-postgres: { days, hours, minutes, seconds, ... } or a string
  if (iv && typeof iv === 'object') {
    const days = Number(iv.days) || 0, hours = Number(iv.hours) || 0,
          mins = Number(iv.minutes) || 0, secs = Number(iv.seconds) || 0;
    return Math.round((days * 24 + hours + mins / 60 + secs / 3600) * 100) / 100;
  }
  if (typeof iv === 'string') {
    const m = /(?:(\d+) days?)?\s*(?:(\d+):)?(\d+):(\d+)/.exec(iv);
    if (m) return Number(m[1] || 0) * 24 + Number(m[2] || 0) + Number(m[3] || 0) / 60 + Number(m[4] || 0) / 3600;
  }
  return null;
};
const minOf = (arrs) => { let m = null; for (const x of arrs) if (x !== null && x !== undefined && (m === null || x < m)) m = x; return m; };
const maxOf = (arrs) => { let m = null; for (const x of arrs) if (x !== null && x !== undefined && (m === null || x > m)) m = x; return m; };
