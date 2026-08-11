// WORK-NODE SYNC — the DUAL-WRITE half of REHAB 1/4.
//
// REHAB 1/4 (docs/hierarchical-workflow-adoption.md): the workflow model
// (plan/plan_version/work_node/dependency/run/execution, migrations 165…185) is now
// SHIPPED AND BACKFILLED, and every legacy writer must keep BOTH shapes true at once.
// This module is the bridge: given a work_item row (or the ids that identify one), it
// writes the matching row in the workflow model — a work_node for a work_item, a
// dependency row for a work_item_dep edge, an execution for a status change — in the
// SAME transaction as the legacy write (the caller is inside BEGIN; a failure here
// rolls the whole pair back, which is the point: a half-written pair is worse than no
// rehab).
//
// WHY THE WORK_ITEM ID IS THE KEY: every backfilled and dual-written node carries
// work_node.stable_key = 'work_item:<uuid>' (the migration's idempotency handle). The
// same key makes the dual-write an upsert, so it is safe to call on every write whether
// the node exists yet or not.
//
// WHAT THIS FILE DOES NOT DO: it never opens a transaction and never broadcasts. The
// caller (work-items.js / work-assign.js / worksync.js) owns the transaction and the
// SSE announcement; this module only writes rows. That keeps the dual-write invisible
// to callers — the existing broadcast shapes ({ kind, item }) are unchanged.
//
// The kind enum DIES: work_item.kind (project/activity/task) is a depth, not a node
// kind. node_kind is derived from SHAPE (has children => 'container', else 'action'),
// exactly as the backfill migration does.

const httpError = (status, message) => Object.assign(new Error(message), { status });
const bad = (m) => httpError(400, m);

// A container that is the LCA of an explicit dependency edge must be 'freeform' (the only
// child_semantics that permits dependency rows under the model's I5 trigger). Every other
// container is 'sequence' — a work_item's sort_order is a total order among siblings.
const SEQ = 'sequence';
const FREE = 'freeform';

// The zero-padded numeric sibling_rank used by the backfill (lexical order == numeric order,
// uuid suffix as a deterministic uniqueness tiebreaker). sort_order is a double precision;
// a NULL/undefined becomes 0.
function rankSql(order, id) {
  const n = order == null ? 0 : Number(order);
  const val = Number.isFinite(n) ? n : 0;
  return `lpad((${val})::numeric::text, 20, '0') || ':' || $${id}`;
}

// ── plan / plan_version / root node ─────────────────────────────────────────────
// Ensure a plan + plan_version exist for a project, and (lazily) that the project's ROOT
// work_node exists. Returns the plan_version id and the root node id. Called on every
// dual-write so a project created after the backfill materialises its plan on first write.
export async function ensurePlanVersion(db, projectId) {
  const project = await db.one(`SELECT id, name FROM project WHERE id=$1`, [projectId]);
  if (!project) throw bad(`project ${projectId} does not exist — cannot dual-write a work_node for it`);

  let plan = await db.one(`SELECT id FROM plan WHERE project_id=$1 ORDER BY created_at LIMIT 1`, [projectId]);
  if (!plan) {
    // Name the plan after the project's root work_item (the same source the backfill used),
    // falling back to the project name.
    const rootItem = await db.one(
      `SELECT id, title FROM work_item WHERE project_id=$1 AND kind='project' LIMIT 1`, [projectId]);
    plan = await db.one(
      `INSERT INTO plan (project_id, name, description) VALUES ($1,$2,$3) RETURNING id`,
      [projectId, rootItem?.title || project.name, rootItem?.title ? `Plan for ${rootItem.title}` : null]);
  }

  let pv = await db.one(`SELECT id FROM plan_version WHERE plan_id=$1 ORDER BY version DESC LIMIT 1`, [plan.id]);
  if (!pv) {
    pv = await db.one(`INSERT INTO plan_version (plan_id, version) VALUES ($1,1) RETURNING id`, [plan.id]);
  }

  // Lazy root node: the root work_item (created by the project trigger, 058) may predate this
  // project's first write. Materialise it once so the plan has a root.
  const rootItem = await db.one(
    `SELECT * FROM work_item WHERE project_id=$1 AND kind='project' LIMIT 1`, [projectId]);
  let rootNode = null;
  if (rootItem) {
    rootNode = await db.one(`SELECT id FROM work_node WHERE stable_key='work_item:'||$1`, [rootItem.id]);
    if (!rootNode) {
      const est = rootItem.estimate_hours == null ? null : rootItem.estimate_hours * 3600000; // ms → interval handled below
      rootNode = await db.one(
        `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, estimate, stable_key)
         VALUES ($1, NULL, ${rankSql(rootItem.sort_order, 5)}, $2, 'container', $3::child_semantics, $4, 'work_item:'||$5)
         RETURNING id`,
        [pv.id, rootItem.title, SEQ, est === null ? null : `${est} milliseconds`, rootItem.id]);
      await db.q(`UPDATE plan_version SET root_node_id=$2 WHERE id=$1 AND root_node_id IS DISTINCT FROM $2`,
        [pv.id, rootNode.id]);
    }
  }

  return { planVersionId: pv.id, rootNodeId: rootNode?.id || null };
}

// Resolve the work_node id for a work_item id (stable_key lookup).
async function nodeIdFor(db, workItemId) {
  if (!workItemId) return null;
  const r = await db.one(`SELECT id FROM work_node WHERE stable_key='work_item:'||$1`, [workItemId]);
  return r?.id || null;
}

// Whether a work_item currently has at least one child (=> its node is a container).
const hasChildren = (db, workItemId) => db.one(`SELECT 1 FROM work_item WHERE parent_id=$1 LIMIT 1`, [workItemId]);

// ── work_node upsert ────────────────────────────────────────────────────────────
// Write (create or update) the work_node for a work_item row. Recursively ensures the
// parent's node exists first, so a project whose plan has not materialised yet builds its
// chain on first write. Returns the work_node id.
export async function syncWorkNode(db, row) {
  if (!row?.id) return null;
  const existing = await db.one(`SELECT id FROM work_node WHERE stable_key='work_item:'||$1`, [row.id]);
  const est = row.estimate_hours == null ? null : `${row.estimate_hours * 3600000} milliseconds`;

  if (!existing) {
    // ensure plan_version (+ lazy root node) and the parent chain
    const { planVersionId } = await ensurePlanVersion(db, row.project_id);
    let parentNodeId = null;
    if (row.kind !== 'project' && row.parent_id) {
      const parent = await db.one(`SELECT * FROM work_item WHERE id=$1`, [row.parent_id]);
      if (parent) parentNodeId = await syncWorkNode(db, parent);
    }
    // node_kind from shape: a project root is always a container; otherwise container iff it
    // currently has at least one child work_item.
    const isContainer = row.kind === 'project' || !!(await hasChildren(db, row.id));
    const node = await db.one(
      `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, estimate, stable_key)
       VALUES ($1, $2, ${rankSql(row.sort_order, 7)}, $3, $4::node_kind, $5::child_semantics, $6, 'work_item:'||$7)
       RETURNING id`,
      [planVersionId, parentNodeId, row.title, isContainer ? 'container' : 'action',
       isContainer ? SEQ : null, est, row.id]);
    return node.id;
  }

  // Upsert path: keep the node in step with the work_item row. child_semantics PRESERVES
  // 'freeform' once set (a dependency LCA — see syncDependency); a sequence container stays
  // sequence unless a dep flips it.
  const isContainer = row.kind === 'project' || !!(await hasChildren(db, row.id));
  const parentNodeId = (row.kind !== 'project' && row.parent_id)
    ? await nodeIdFor(db, row.parent_id) : null;
  const node = await db.one(
    `UPDATE work_node SET
       parent_id = COALESCE($1, parent_id),
       sibling_rank = ${rankSql(row.sort_order, 6)},
       name = $2,
       kind = $3::node_kind,
       child_semantics = CASE WHEN $3::node_kind = 'container' THEN
                          (CASE WHEN work_node.child_semantics = 'freeform' THEN 'freeform' ELSE $4::child_semantics END)
                        ELSE NULL END,
       estimate = $5,
       updated_at = now()
     WHERE stable_key = 'work_item:'||$6
     RETURNING id`,
    [parentNodeId, row.title, isContainer ? 'container' : 'action',
     isContainer ? SEQ : null, est, row.id]);
  if (!node) {
    // The node existed a moment ago and vanished (a concurrent delete) — retry as an insert.
    return syncWorkNode(db, row);
  }
  return node.id;
}

// Ensure a node is a container (called when a child is created under an 'action' node).
export async function ensureContainer(db, workItemId) {
  const node = await db.one(`SELECT id, kind FROM work_node WHERE stable_key='work_item:'||$1`, [workItemId]);
  if (node && node.kind !== 'container') {
    await db.q(`UPDATE work_node SET kind='container', child_semantics=COALESCE(child_semantics,$2::child_semantics) WHERE id=$1`,
      [node.id, SEQ]);
  }
  return node?.id || null;
}

// ── delete ──────────────────────────────────────────────────────────────────────
// Delete the work_node for a work_item AND its whole subtree's executions (execution.
// work_node_id is RESTRICT, so a node with executions cannot be deleted) and then the node
// itself (work_node.parent_id ON DELETE CASCADE takes the subtree). dependency rows cascade.
export async function removeWorkNode(db, workItemId) {
  const node = await db.one(`SELECT id FROM work_node WHERE stable_key='work_item:'||$1`, [workItemId]);
  if (!node) return null;
  await db.q(
    `DELETE FROM execution WHERE work_node_id IN (
       WITH RECURSIVE sub AS (
         SELECT id FROM work_node WHERE id=$1
         UNION ALL SELECT w.id FROM work_node w JOIN sub ON w.parent_id = sub.id
       ) SELECT id FROM sub)`,
    [node.id]);
  const out = await db.q(`DELETE FROM work_node WHERE id=$1 RETURNING id`, [node.id]);
  return out[0]?.id || null;
}

// ── dependency ──────────────────────────────────────────────────────────────────
// Add a dependency row for a work_item_dep edge. The model refuses an explicit dependency
// unless its LCA container is 'freeform' (I5), so the LCA is flipped first — the same rule
// the backfill used to choose child_semantics. An ancestor-edge (I6) fails loudly, which is
// correct: a legacy edge that was silently legal must not half-land here.
export async function syncDependency(db, workItemId, dependsOnId) {
  const fromId = await nodeIdFor(db, workItemId);
  const toId = await nodeIdFor(db, dependsOnId);
  if (!fromId || !toId) {
    throw bad(`cannot dual-write dependency ${workItemId} → ${dependsOnId}: one end has no work_node yet`);
  }
  const lca = await db.one(`SELECT wn_lca($1, $2) AS id`, [fromId, toId]);
  if (lca?.id) {
    await db.q(`UPDATE work_node SET child_semantics='freeform' WHERE id=$1 AND kind='container'`, [lca.id]);
  }
  await db.q(
    `INSERT INTO dependency (from_id, to_id, type) VALUES ($1,$2,'FS')
     ON CONFLICT (from_id, to_id, type) DO NOTHING`,
    [fromId, toId]);
  return { ok: true, fromId, toId };
}

export async function removeDependency(db, workItemId, dependsOnId) {
  const fromId = await nodeIdFor(db, workItemId);
  const toId = await nodeIdFor(db, dependsOnId);
  if (!fromId || !toId) return null;
  await db.q(`DELETE FROM dependency WHERE from_id=$1 AND to_id=$2 AND type='FS'`, [fromId, toId]);
  return { ok: true, fromId, toId };
}

// ── execution (status changes) ──────────────────────────────────────────────────
// Write an execution reflecting a work_item status change, under ONE run per plan_version.
// An item that never starts (status stays 'queued') gets NO execution — the rehab's rule.
// The state mapping is the lifecycle side of the legacy work_status vocabulary.
export const STATUS_TO_LIFECYCLE = {
  queued: 'pending',
  assigned: 'ready',
  working: 'running',
  blocked: 'blocked',
  review: 'waiting',
  shipping: 'waiting',
  done: 'done',
  cancelled: 'cancelled',
};

export async function syncExecutionState(db, workItemId, status) {
  const node = await db.one(`SELECT id, plan_version_id FROM work_node WHERE stable_key='work_item:'||$1`, [workItemId]);
  if (!node) return null;   // no node → nothing to run (should not happen once dual-write is in)
  const state = STATUS_TO_LIFECYCLE[status];
  if (!state) return null;

  // ONE run per plan_version (the production instantiation). Reuse the backfill's run if it
  // exists, else create one.
  let run = await db.one(`SELECT id FROM run WHERE plan_version_id=$1 ORDER BY created_at LIMIT 1`, [node.plan_version_id]);
  if (!run) {
    run = await db.one(`INSERT INTO run (plan_version_id, state) VALUES ($1,'running') RETURNING id`, [node.plan_version_id]);
  }

  const exec = await db.one(
    `SELECT id FROM execution WHERE run_id=$1 AND work_node_id=$2 AND attempt=1`, [run.id, node.id]);
  if (!exec) {
    // The caller invokes this on a status change to a non-queued state, so creating one here
    // is correct (an item that never ran gets NO execution — the migration's rule).
    await db.q(
      `INSERT INTO execution (run_id, work_node_id, state, effect_key, started_at)
       VALUES ($1,$2,$3::lifecycle_state,'work_item:'||$4, CASE WHEN $3 IN ('pending') THEN NULL ELSE now() END)`,
      [run.id, node.id, state, workItemId]);
  } else {
    await db.q(
      `UPDATE execution SET
         state = $2::lifecycle_state,
         started_at = CASE WHEN $2 IN ('pending') THEN started_at ELSE COALESCE(started_at, now()) END,
         finished_at = CASE WHEN $2 IN ('done','cancelled') THEN now() ELSE NULL END
       WHERE id=$1`,
      [exec.id, state]);
  }

  // Roll the run state up from its executions.
  await db.q(
    `UPDATE run SET state = CASE
       WHEN EXISTS (SELECT 1 FROM execution e WHERE e.run_id=run.id AND e.state='cancelled')
        AND NOT EXISTS (SELECT 1 FROM execution e WHERE e.run_id=run.id AND e.state<>'cancelled')
         THEN 'cancelled'::run_state
       WHEN NOT EXISTS (SELECT 1 FROM execution e WHERE e.run_id=run.id AND e.state NOT IN ('done','cancelled'))
         THEN 'succeeded'::run_state
       ELSE 'running'::run_state END
     WHERE id=$1`, [run.id]);
  return { ok: true, runId: run.id };
}
