// WORK-ITEM MODEL — the workflow model read layer for the work tracker (REHAB 2/4).
//
// REHAB 2/4 re-points every work-tracker READER at the hierarchical workflow model: the tree the
// board and drawer draw, the order siblings sit in, the kind a node is, the dependency edges and
// the actuals all come from the model (work_node / dependency / execution / lease) instead of the
// legacy work_item tables.
//
// ── THE DESIGN (REHAB 3/4, option ii): work_item IS THE ATTRIBUTE ANNEX ────────
// The rehab retires the PLAN/RUN conflation, NOT the work_item table. work_item remains the
// annex that carries the attributes the model demonstrably does not own yet — body (work_node has
// no body column), ticket_id, xell_id/assignee (the lease plane is empty: 0 rows), progress, the
// exact stored status (the run plane collapses review/shipping to 'waiting'), the actual_* dates,
// created_by and the audit trail (work_item_event — the 244 human comments have no home in the
// model). The dual-write of those attribute columns therefore CONTINUES (title, body, status,
// priority, ticket_id, starts_on, due_on, progress, sort_order, parent_id, xell_id); stopping it
// would make a model-created work_node draw a BLANK CARD through the LEFT JOIN below.
//
// What IS retired is what the model demonstrably owns:
//   • work_item_dep — fully mirrored in `dependency` (3 rows); the writes stopped (addDep/
//     removeDep write the model edge only) and the table was dropped (migration 188).
//   • the plan shape (work_node.parent_id / sibling_rank) and run state (execution) — the readers
//     below read those from the model; work_item.parent_id and work_item.sort_order remain only
//     as the attribute store the console PATCHes (sort_order is the number a kanban drag writes,
//     and the API must keep returning it, so the columns stay until the model grows the field).
//   • "who has it" stays on work_item.xell_id — see lib/work-assign.js's REHAB 3/4 note: the lease
//     plane has no rows, so re-pointing the assignee reads there would render every card
//     unassigned. Writing leases is a WRITER change for a later card.
//
// work_item keeps being WRITTEN by rehab 1/4's dual-write (the annex columns above) and every
// re-pointed reader can be checked against the old shape side by side.
//
// ── WHAT COMES FROM WHERE ──────────────────────────────────────────────────────
//   MODEL (authoritative)                 LEGACY work_item (attribute lookup only)
//   ─────────────────────                 ─────────────────────────────────────
//   the tree: which rows exist, their     title, body, status, priority, ticket_id,
//     parentage, depth, sibling order       xell_id, assignee, starts_on, due_on,
//     (sibling_rank), node_kind from         estimate_hours, progress, sort_order,
//     shape (container vs action)            path, created_by, created_at/updated_at,
//   dependency edges (dependency)           closed_at, id (the API's identity — the
//   actuals (execution.started_at/          console PATCHes work_items, so the model
//     finished_at)                          read MUST return work_item ids)
//                                          the exact stored status (see the status
//                                          mapping below)
//
// ── WHAT REHAB 2/4 RE-POINTED, AND WHAT (HONESTLY) STAYS ON WORK_ITEM ─────────
// Re-pointed at the model (the PLAN SHAPE): lib/work-items.js listWorkItems, getWorkItem,
// boardModel, ganttModel — the tree, order, deps and actuals now come from the model tables, and
// the API routes those functions serve (GET /api/work-items, /:id, /board, /gantt) are the readers
// the console draws. lib/work-actuals.js's derivation functions are unchanged (they are the RULES
// the legacy actuals trigger implements, still used by refreshWorkItemActual).
//
// Still reading work_item (fields the model does NOT carry at rehab-2/4 fidelity), with the reason
// documented where each is:
//   • "who has it" — work_item.xell_id / assignee, read by lib/work-assign.js (busy check,
//     candidatesFor, itemForXell) and queenzee/worksync.js. The model's lease plane exists (179)
//     but the rehab 1/4 dual-write does NOT write leases for work items (it writes executions
//     only), so there is no lease data to read — re-pointing these to lease would show every card
//     unassigned. Writing leases is a WRITER change, deferred with the conflation retirement (3/4).
//   • ticket_id — the ticket link is a tracker noun; work_node has no ticket column and no join.
//   • work_item_event — the audit ledger; the model's append-only event table is not written by
//     the dual-write. getWorkItem still serves the tracker's own ledger.
//   • the exact stored status — the run plane collapses review/shipping to 'waiting'; see
//     lib/model-status.js for the ONE mapping and its documented limit.
//
// ── THE STATUS MAPPING (the trap REHAB 2/4 exists to defuse) ─────────────────
// work_item.status is a single column that conflates PLAN state and RUN state. The model splits
// them: plan shape on work_node, run state on execution.state, "who has it" on lease. The ONE
// mapping from the run plane back to the work vocabulary lives in lib/model-status.js and is used
// by every reader — never re-derived per file. See that module for the exact table and its known
// limit (the run plane cannot tell the tracker's `review` from `shipping` — both are 'waiting' —
// so a reader that renders a BOARD COLUMN still reads work_item.status, which is exactly the
// conflation rehab 3/4 will retire).
//
// ── THE KEY ───────────────────────────────────────────────────────────────────
// work_node.stable_key = 'work_item:<uuid>' is the identity bridge (migration 185). The join is
// wi.id::text = substring(wn.stable_key, 11) — 'work_item:' is 10 chars, the uuid starts at 11.
import { q as rawQ, one as rawOne } from '../db/pool.js';

const q = rawQ;
const one = rawOne;

// The project → plan → latest published version's root work_node, or null when the project has no
// usable plan. Mirrors lib/workflow-gantt.js planVersionForProject.
export async function modelRootForProject(projectId) {
  return one(
    `SELECT pv.id AS plan_version_id, p.id AS plan_id, p.name AS plan_name,
            pv.version, pv.root_node_id
       FROM plan p
       JOIN plan_version pv ON pv.plan_id = p.id
      WHERE p.project_id = $1 AND pv.root_node_id IS NOT NULL
      ORDER BY p.created_at DESC, pv.version DESC
      LIMIT 1`, [projectId]);
}

// The root work_node for a work_item id (the node whose stable_key names that item), or null.
export async function modelNodeForWorkItem(workItemId) {
  if (!workItemId) return null;
  return one(`SELECT * FROM work_node WHERE stable_key = 'work_item:' || $1::text`, [workItemId]);
}

// ── the tree ──────────────────────────────────────────────────────────────────
// The whole subtree under a root node in MODEL tree order (depth-first by sibling_rank), each row
// carrying the work_node columns + the joined work_item row. `model_depth` is 1-based (the root is
// 1); the API convention is 0-based, so readers subtract 1.
//
// `rootItemId` is a work_item id (the API's identity); when given, the walk starts at that item's
// node. Otherwise `projectId` resolves the project's WORK ITEM tree root — the root work_item node
// (stable_key='work_item:<root item id>'), NOT the project node (stable_key='project:<project_id>'
// — the model's plan root, which the board/gantt/list must skip: a project node has no work_item
// row to join to).
export async function modelTree({ projectId, rootItemId } = {}) {
  const params = [];
  let rootCte;
  if (rootItemId) {
    params.push(rootItemId);
    rootCte = `
      root AS (
        SELECT id AS root_node_id FROM work_node WHERE stable_key = 'work_item:' || $1::text
      )`;
  } else {
    params.push(projectId);
    rootCte = `
      root AS (
        SELECT wn.id AS root_node_id
        FROM plan p
        JOIN plan_version pv ON pv.plan_id = p.id
        JOIN work_node pn ON pn.plan_version_id = pv.id
                         AND pn.stable_key = 'project:' || p.project_id::text
        JOIN work_node wn ON wn.parent_id = pn.id AND wn.stable_key LIKE 'work_item:%'
        WHERE p.project_id = $1
        ORDER BY p.created_at DESC, pv.version DESC
        LIMIT 1
      )`;
  }
  const rows = await q(`
    WITH RECURSIVE ${rootCte},
    t AS (
      SELECT wn.id AS node_id, wn.parent_id AS node_parent_id, wn.sibling_rank,
             wn.plan_version_id, wn.kind AS node_kind, wn.child_semantics,
             wn.stable_key, wn.estimate AS node_estimate, wn.priority AS node_priority,
             substring(pwn.stable_key, 11) AS model_parent_item_id,
             wi.*,
             1 AS model_depth
      FROM work_node wn
      JOIN root ON wn.id = root.root_node_id
      LEFT JOIN work_node pwn ON pwn.id = wn.parent_id
      LEFT JOIN work_item wi ON wi.id::text = substring(wn.stable_key, 11)
      UNION ALL
      SELECT wn.id, wn.parent_id, wn.sibling_rank,
             wn.plan_version_id, wn.kind, wn.child_semantics,
             wn.stable_key, wn.estimate, wn.priority,
             substring(pwn.stable_key, 11),
             wi.*,
             t.model_depth + 1
      FROM work_node wn
      JOIN t ON wn.parent_id = t.node_id
      LEFT JOIN work_node pwn ON pwn.id = wn.parent_id
      LEFT JOIN work_item wi ON wi.id::text = substring(wn.stable_key, 11)
    )
    SELECT * FROM t
    ORDER BY model_depth, sibling_rank`, params);
  return rows;
}

// The work_item id a node's stable_key names, or null for a foreign node.
export function workItemIdOf(node) {
  const s = node?.stable_key;
  return (typeof s === 'string' && s.startsWith('work_item:')) ? s.slice(10) : null;
}

// The ancestors of a work_item, nearest-first, as work_item rows (the model's parent chain). A
// foreign ancestor (a work_node with no work_item) contributes nothing — the tracker's breadcrumb
// is made of tracker items.
export async function modelAncestorsForWorkItem(workItemId) {
  const rows = await q(
    `WITH RECURSIVE up AS (
       SELECT wn.parent_id AS node_id, 1 AS depth
       FROM work_node wn WHERE wn.stable_key = 'work_item:' || $1::text AND wn.parent_id IS NOT NULL
       UNION ALL
       SELECT wn.parent_id, up.depth + 1
       FROM up JOIN work_node wn ON wn.id = up.node_id
       WHERE wn.parent_id IS NOT NULL
     )
     SELECT wi.*, up.depth
       FROM up
       JOIN work_node wn ON wn.id = up.node_id
       JOIN work_item wi ON wi.id::text = substring(wn.stable_key, 11)
      ORDER BY up.depth`, [workItemId]);
  return rows;
}

// ── dependency edges ──────────────────────────────────────────────────────────
// dependency.from_id is the PREREQUISITE, to_id the DEPENDENT (the 186 repair fixed 185's reversal
// and the dual-write has written it this way ever since). Map the model's node-level edges onto
// work_item ids so the API can keep naming items.
//
// Returns { depsBy, dependentsBy } where depsBy.get(itemId) = [prereq itemIds...] and
// dependentsBy.get(itemId) = [dependent itemIds...].
export async function modelDepsForItems(itemIds) {
  const depsBy = new Map();
  const dependentsBy = new Map();
  if (!itemIds || !itemIds.length) return { depsBy, dependentsBy };
  // Edges where EITHER end is one of the given items: an edge (from=prereq → to=dependent) both
  // makes `to` depend on `from` AND makes `from` a prerequisite of `to` — a reader asking about a
  // single item needs both halves (getWorkItem's deps AND dependents).
  const rows = await q(
    `SELECT d.from_id, d.to_id,
            substring(wf.stable_key, 11) AS from_item_id,
            substring(wt.stable_key, 11) AS to_item_id
       FROM dependency d
       JOIN work_node wf ON wf.id = d.from_id
       JOIN work_node wt ON wt.id = d.to_id
      WHERE wf.stable_key LIKE 'work_item:%' AND wt.stable_key LIKE 'work_item:%'
        AND (wf.stable_key IN (SELECT 'work_item:' || unnest($1::uuid[])::text)
          OR wt.stable_key  IN (SELECT 'work_item:' || unnest($1::uuid[])::text))`,
    [itemIds]);
  for (const r of rows) {
    const dep = r.to_item_id;       // the item that WAITS
    const prereq = r.from_item_id;  // the item it waits on
    if (!depsBy.has(dep)) depsBy.set(dep, []);
    depsBy.get(dep).push(prereq);
    if (!dependentsBy.has(prereq)) dependentsBy.set(prereq, []);
    dependentsBy.get(prereq).push(dep);
  }
  return { depsBy, dependentsBy };
}

// ── actuals from the run plane ────────────────────────────────────────────────
// execution.started_at / finished_at are the record's proof of when a work_item RAN. A container
// node's actuals roll up from its subtree (the same rule the work-item gantt applied to work_item
// actuals). Returns Map<itemId, { start, end }> where start/end are Date or null.
export async function modelActualsForItems(itemIds) {
  const actuals = new Map();
  if (!itemIds || !itemIds.length) return actuals;
  const rows = await q(
    `SELECT substring(wn.stable_key, 11) AS item_id,
            min(e.started_at) AS started_at,
            max(e.finished_at) AS finished_at
       FROM execution e
       JOIN work_node wn ON wn.id = e.work_node_id
      WHERE wn.stable_key LIKE 'work_item:%'
        AND wn.stable_key IN (SELECT 'work_item:' || unnest($1::uuid[])::text)
      GROUP BY 1`, [itemIds]);
  for (const r of rows) actuals.set(r.item_id, { start: r.started_at || null, end: r.finished_at || null });
  return actuals;
}

// ── executions + leases for a set of items (the run plane, for the drawer's waterfall / the
//    gantt's waiting layer). Returns { execsByItem, leasesByExec }.
export async function modelExecutionsForItems(itemIds) {
  const execsByItem = new Map();
  if (!itemIds || !itemIds.length) return { execsByItem, leasesByExec: new Map() };
  const execs = await q(
    `SELECT e.id, e.run_id, e.work_node_id, e.state, e.attempt, e.started_at, e.finished_at,
            e.outputs, e.error,
            en.name AS entity_name, en.kind_hint AS entity_kind_hint,
            substring(wn.stable_key, 11) AS item_id
       FROM execution e
       JOIN work_node wn ON wn.id = e.work_node_id
       LEFT JOIN entity en ON en.id = e.entity_id
      WHERE wn.stable_key LIKE 'work_item:%'
        AND wn.stable_key IN (SELECT 'work_item:' || unnest($1::uuid[])::text)
      ORDER BY e.started_at ASC NULLS LAST, e.id`, [itemIds]);
  for (const ex of execs) {
    if (!execsByItem.has(ex.item_id)) execsByItem.set(ex.item_id, []);
    execsByItem.get(ex.item_id).push(ex);
  }
  const execIds = execs.map((e) => e.id);
  const leases = execIds.length
    ? await q(
        `SELECT l.id, l.execution_id, l.entity_id, l.state, l.claimed_at, l.expires_at,
                l.released_at, en.name AS entity_name
           FROM lease l LEFT JOIN entity en ON en.id = l.entity_id
          WHERE l.execution_id = ANY($1::uuid[])`, [execIds])
    : [];
  const leasesByExec = new Map();
  for (const l of leases) {
    if (!leasesByExec.has(l.execution_id)) leasesByExec.set(l.execution_id, []);
    leasesByExec.get(l.execution_id).push(l);
  }
  return { execsByItem, leasesByExec };
}
