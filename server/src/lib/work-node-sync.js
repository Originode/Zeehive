// WORK-NODE SYNC — the DUAL-WRITE half of REHAB 1/4.
//
// REHAB 1/4 (docs/hierarchical-workflow-adoption.md): the workflow model
// (plan/plan_version/work_node/dependency/run/execution, migrations 165…185) is now
// SHIPPED AND BACKFILLED, and every legacy writer must keep BOTH shapes true at once.
// This module is the bridge: given a work_item row (or the ids that identify one), it
// writes the matching row in the workflow model — a work_node for a work_item, a
// dependency row for a dependency edge, an execution for a status change — in the
// SAME transaction as the legacy write (the caller is inside BEGIN; a failure here
// rolls the whole pair back, which is the point: a half-written pair is worse than no
// rehab).
//
// REHAB 3/4 — the legacy `work_item_dep` table is RETIRED (migration 188). The model's
// `dependency` table is the ONE source of truth for edges; this module's syncDependency /
// removeDependency are no longer the "model half" of a work_item_dep dual-write — they ARE the
// write, called directly by work-items.js addDep/removeDep. work_item itself stays as the
// ATTRIBUTE ANNEX (see work-item-model.js's header for the design), so syncWorkNode and
// syncExecutionState still keep the model in step with the surviving work_item attribute columns.
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

// The fixed-width, SIGN-SAFE numeric sibling_rank (lexical order == numeric order, uuid suffix
// as a deterministic uniqueness tiebreaker). sort_order is a double precision (a NULL/undefined
// becomes 0) and a drag can write a FRACTIONAL midpoint (web/src/work/order.js:36) or a
// NEGATIVE value (order.js:38 — `after - 1` into the first slot once a column head reaches 0),
// so the old lpad(n::text,20,'0') scheme is wrong for both: right-padding a decimal point
// misaligns the digits (1500.5 sorts after 3000) and a negative sign sorts before the digits.
//
// This scheme adds a +1e9 offset (cast to numeric FIRST so the double's exact value is
// preserved — 1500.5::numeric is 1500.5) and formats as a fixed 20-digit integer part + a
// 6-digit fractional part, which orders correctly for any sort_order in (-1e9, ~9.9e9) and
// keeps the '.' at the same character position on every rank so lexical order never crosses it.
// The SAME formula is used in migration 186 to re-encode existing ranks, so new writes and
// backfilled rows stay in one consistent format.
function rankSql(order, id) {
  const n = order == null ? 0 : Number(order);
  const val = Number.isFinite(n) ? n : 0;
  // FM (fill mode) strips the sign-position blank to_char otherwise emits for a positive number,
  // so the rank is exactly the fixed-width digits + '.000000' — a clean, uniform format.
  return `to_char((${val})::numeric + 1000000000, 'FM00000000000000000000.000000') || ':' || $${id}`;
}

// ── plan / plan_version / project root node ─────────────────────────────────────
// Ensure a plan + plan_version exist for a project, and (lazily) that the project's ROOT
// work_node (stable_key='project:<project_id>', kind container) exists. Returns the plan_version
// id and the project root node id. Called on every dual-write so a project created after the
// backfill materialises its plan on first write.
//
// THE PROJECT ROOT NODE — "a project is just a work_node": the project node is the version's
// single root (parent NULL, plan_version.root_node_id), and the project's root work_item node
// (stable_key='work_item:<root item id>') hangs under it. Migration 191 backfilled the existing
// projects; this is the same shape for new ones. The ONE-ROOT SWAP below is the code mirror of
// the migration's: when the root work_item node already exists as the version's root, the project
// node is inserted as its child first (the version still has one root), the root work_item node is
// re-parented under it, then the project node is made the root — never two parentless nodes at
// once, so wn_one_root_per_version (166) is never violated.
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

  // The root work_item (created by the project trigger, 058) and its node, which hangs under the
  // project node. Both may be missing on a project whose plan was only just materialised.
  const rootItem = await db.one(
    `SELECT * FROM work_item WHERE project_id=$1 AND kind='project' LIMIT 1`, [projectId]);
  let rootNode = rootItem ? await db.one(
    `SELECT id, parent_id, plan_version_id FROM work_node WHERE stable_key='work_item:'||$1`, [rootItem.id]) : null;

  // The project's ROOT node: stable_key='project:<project_id>', kind container, parent NULL.
  let projectNode = await db.one(`SELECT id FROM work_node WHERE stable_key='project:'||$1`, [projectId]);

  if (!projectNode) {
    // If the found plan_version already has a parentless node that is neither the project node
    // nor the root work_item node (a plan a workflow test — or any other writer — authored before
    // this project was dual-written), inserting a second parentless node would violate
    // wn_one_root_per_version. Open a NEW version and put our tree there, leaving the foreign
    // version untouched. Idempotent: on a re-run OUR node is already in this version, so no new
    // version is opened.
    const ourRootInVersion = rootNode ? (await db.one(
      `SELECT id FROM work_node WHERE plan_version_id=$1 AND stable_key='work_item:'||$2`, [pv.id, rootItem.id])) : null;
    const foreignRoot = !ourRootInVersion && (await db.one(
      `SELECT id FROM work_node WHERE plan_version_id=$1 AND parent_id IS NULL`, [pv.id]));
    if (foreignRoot) {
      pv = await db.one(
        `INSERT INTO plan_version (plan_id, version)
         VALUES ($1, (SELECT COALESCE(max(version),0)+1 FROM plan_version WHERE plan_id=$1))
         RETURNING id`, [plan.id]);
    }

    // Only the root work_item node that lives in THIS version can take part in the one-root swap.
    // A root work_item node in an older version belongs to that version's tree — after opening a
    // new version the new tree is empty, so the project node can be the root directly.
    const rootInThisVersion = rootNode && rootNode.plan_version_id === pv.id ? rootNode : null;

    if (rootInThisVersion) {
      // ONE-ROOT SWAP (mirror of migration 191): the project node starts as a child of the root
      // work_item node so the version never holds two parentless nodes; the root work_item node
      // is re-parented under it; then the project node becomes the single root.
      projectNode = await db.one(
        `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
         VALUES ($1, $2, ${rankSql(0, 4)}, $3, 'container', 'sequence', 'project:'||$4)
         RETURNING id`,
        [pv.id, rootInThisVersion.id, project.name, projectId]);
      await db.q(`UPDATE work_node SET parent_id=$2 WHERE id=$1`, [rootInThisVersion.id, projectNode.id]);
      await db.q(`UPDATE work_node SET parent_id=NULL WHERE id=$1`, [projectNode.id]);
    } else {
      // No root work_item node in this version — the version is empty (or just created); the
      // project node can be the root directly.
      projectNode = await db.one(
        `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
         VALUES ($1, NULL, ${rankSql(0, 3)}, $2, 'container', 'sequence', 'project:'||$3)
         RETURNING id`,
        [pv.id, project.name, projectId]);
    }
    await db.q(`UPDATE plan_version SET root_node_id=$2 WHERE id=$1 AND root_node_id IS DISTINCT FROM $2`,
      [pv.id, projectNode.id]);
  }

  // The root work_item node hangs UNDER the project node (lazily created if missing in this
  // version, re-parented if a pre-project-node writer left it as this version's root).
  if (rootItem) {
    const rootInThisVersion = rootNode && rootNode.plan_version_id === pv.id ? rootNode : null;
    if (!rootInThisVersion) {
      const est = rootItem.estimate_hours == null ? null : `${rootItem.estimate_hours * 3600000} milliseconds`;
      rootNode = await db.one(
        `INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, estimate, stable_key)
         VALUES ($1, $2, ${rankSql(rootItem.sort_order, 6)}, $3, 'container', $4::child_semantics, $5, 'work_item:'||$6)
         RETURNING id`,
        [pv.id, projectNode.id, rootItem.title, SEQ, est, rootItem.id]);
    } else if (rootInThisVersion.parent_id !== projectNode.id) {
      // Re-parent under the project node (idempotent — a no-op when already correct).
      await db.q(`UPDATE work_node SET parent_id=$2 WHERE id=$1`, [rootInThisVersion.id, projectNode.id]);
    }
  }

  return { planVersionId: pv.id, rootNodeId: projectNode.id };
}

// ── project dual-write (create / rename) ─────────────────────────────────────────
// Maintain the project's ROOT node in step with the `project` row. Creating or renaming a project
// calls this in the same transaction (projects.js) — the project row is the attribute annex, the
// node is the model half, exactly as work_item ↔ work_node. The node's name follows the project
// name; the plan/plan_version/root work_item node are materialised lazily on first need.
export async function syncProjectNode(db, projectId) {
  const project = await db.one(`SELECT id, name FROM project WHERE id=$1`, [projectId]);
  if (!project) throw bad(`project ${projectId} does not exist — cannot dual-write its root work_node`);
  const { planVersionId, rootNodeId } = await ensurePlanVersion(db, projectId);
  if (rootNodeId) {
    await db.q(`UPDATE work_node SET name=$2, updated_at=now() WHERE id=$1 AND name IS DISTINCT FROM $2`,
      [rootNodeId, project.name]);
  }
  return { planVersionId, rootNodeId };
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
  let existing = await db.one(`SELECT id FROM work_node WHERE stable_key='work_item:'||$1`, [row.id]);
  const est = row.estimate_hours == null ? null : `${row.estimate_hours * 3600000} milliseconds`;

  if (!existing) {
    // ensure plan_version (+ lazy project root node) and the parent chain
    const { planVersionId } = await ensurePlanVersion(db, row.project_id);
    // ensurePlanVersion materialises the project root work_item node — re-check so we don't
    // insert a duplicate of a node it just created (the project root's own sync).
    existing = await db.one(`SELECT id FROM work_node WHERE stable_key='work_item:'||$1`, [row.id]);
    if (!existing) {
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
// Add a dependency row for a work_item dependency edge (workItemId depends on dependsOnId).
// The model refuses an explicit dependency unless its LCA container is 'freeform' (I5), so the
// LCA is flipped first — the same rule the backfill used to choose child_semantics. An
// ancestor-edge (I6) fails loudly, which is correct: an edge the model cannot hold must not
// half-land here.
//
// DIRECTION IS LOAD-BEARING. dependency.from_id is the PREDECESSOR (the thing that must finish
// before the dependent starts); dependency.to_id is the DEPENDENT (successor). The retired
// work_item_dep table meant the opposite of its write order — work_item_id was the DEPENDENT and
// depends_on_id the PREREQUISITE — so the model edge is from_id=node(depends_on_id) →
// to_id=node(work_item_id).
export async function syncDependency(db, workItemId, dependsOnId) {
  // prerequisite (predecessor) → dependent (successor)
  const fromId = await nodeIdFor(db, dependsOnId);
  const toId = await nodeIdFor(db, workItemId);
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
  const fromId = await nodeIdFor(db, dependsOnId);
  const toId = await nodeIdFor(db, workItemId);
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
