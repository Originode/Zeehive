-- PROJECT ROOT WORK_NODE — "a project is just a work_node": give every project a root node
-- so a project-level gantt exists.
--
-- CONTEXT — measured on the live meta-DB: project=2, work_node with stable_key LIKE 'project:%'=0.
-- Migration 185 backfilled every work_item into the model under a per-plan root: the root
-- work_item node (stable_key='work_item:<root item id>') is the plan_version's single root, and
-- the whole project's tree hangs under it. But there is still NO node that IS the project — no
-- node whose span is the WHOLE project ("start to current to todo until end goal"). That absence
-- is exactly why there is no project-level gantt.
--
-- This migration adds ONE root work_node per project:
--
--   stable_key = 'project:<project_id>', kind container, child_semantics 'sequence', parent NULL.
--   The project's existing item root (the work_item:<root item id> node) becomes its child.
--   plan_version.root_node_id is re-pointed at the project node.
--
-- The same shape the dual-write maintains for new projects (work-node-sync.js) and the same
-- 'one plan_version per project, the project node as root_node_id' invariant.
--
-- THE ONE-ROOT SWAP — wn_one_root_per_version (166) forbids a version from holding two parentless
-- nodes, and the migration must turn the root work_item node (parentless today) into a CHILD of a
-- NEW parentless project node. The three steps below do it without dropping the index:
--
--   1. insert the project node as a CHILD of the root work_item node  (version still has one root);
--   2. re-parent the root work_item node under the project node         (a transient 2-cycle —
--      invisible outside this transaction, and work_node has no cycle guard to trip);
--   3. re-parent the project node to NULL                               (the version's single root).
--
-- IDEMPOTENT (the 185 style): the project node insert is an upsert on the (plan_version_id,
-- stable_key) unique index created in 185; the re-parent and root_node_id UPDATEs are guarded by
-- IS DISTINCT FROM. A second run changes ZERO rows.
--
-- TOTAL (asserted below): every project has exactly one parentless project node, every project's
-- root work_item node hangs under it, and the plan_version holding the tree has root_node_id
-- pointing at the project node. The migration REFUSES rather than half-apply.
--
-- FORWARD-ONLY. The DOWN (un-wrapping the tree) is deliberately never written: the project node is
-- the new root of record, and a second migrate pass is a clean no-op.

DO $project_root$
DECLARE
  v_project  record;
  v_plan_id  uuid;
  v_pv_id    uuid;
  v_proj_node uuid;
  v_root_item uuid;
  v_root_node uuid;
  v_rank     text;
BEGIN
  FOR v_project IN SELECT id, name FROM project ORDER BY created_at LOOP
    -- the root work_item (058 guarantees exactly one per project)
    SELECT id INTO v_root_item FROM work_item
      WHERE project_id = v_project.id AND kind = 'project' ORDER BY created_at LIMIT 1;
    IF v_root_item IS NULL THEN
      RAISE EXCEPTION 'project % has no root work_item — migration 058 should have created one', v_project.id;
    END IF;

    -- the plan for this project (185 created one per project root work_item)
    SELECT id INTO v_plan_id FROM plan WHERE project_id = v_project.id ORDER BY created_at LIMIT 1;
    IF v_plan_id IS NULL THEN
      INSERT INTO plan (project_id, name) VALUES (v_project.id, v_project.name)
      RETURNING id INTO v_plan_id;
    END IF;

    -- the plan_version holding the root work_item node (fall back to the latest, then create)
    SELECT wn.plan_version_id INTO v_pv_id FROM work_node wn
      WHERE wn.stable_key = 'work_item:' || v_root_item::text LIMIT 1;
    IF v_pv_id IS NULL THEN
      SELECT id INTO v_pv_id FROM plan_version WHERE plan_id = v_plan_id ORDER BY version DESC LIMIT 1;
      IF v_pv_id IS NULL THEN
        INSERT INTO plan_version (plan_id, version) VALUES (v_plan_id, 1)
        RETURNING id INTO v_pv_id;
      END IF;
    END IF;

    -- the root work_item node (may be null if the tree was never materialised)
    SELECT id INTO v_root_node FROM work_node
      WHERE stable_key = 'work_item:' || v_root_item::text LIMIT 1;

    -- the project node in this version
    SELECT id INTO v_proj_node FROM work_node
      WHERE plan_version_id = v_pv_id AND stable_key = 'project:' || v_project.id::text LIMIT 1;

    IF v_proj_node IS NULL THEN
      -- If the found plan_version has a parentless node that is NOT the root work_item node (a
      -- plan a workflow test — or any other writer — authored before this project was
      -- dual-written), inserting the project node as a second root would violate
      -- wn_one_root_per_version. Open a NEW version and put the project node there.
      IF v_root_node IS NOT NULL AND EXISTS (
        SELECT 1 FROM work_node WHERE plan_version_id = v_pv_id AND parent_id IS NULL
          AND id IS DISTINCT FROM v_root_node) THEN
        INSERT INTO plan_version (plan_id, version)
        VALUES (v_plan_id, (SELECT COALESCE(max(version),0)+1 FROM plan_version WHERE plan_id = v_plan_id))
        RETURNING id INTO v_pv_id;
      END IF;

      -- The sign-safe fixed-width sibling_rank (same formula as work-node-sync.js / 186), with
      -- the project id as the uniqueness tiebreaker so it cannot collide with a child rank.
      v_rank := to_char(0::numeric + 1000000000, 'FM00000000000000000000.000000') || ':' || v_project.id::text;

      IF v_root_node IS NOT NULL THEN
        -- STEP 1: the project node starts as a child of the root work_item node, so the version
        -- never holds two parentless nodes.
        INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
        VALUES (v_pv_id, v_root_node, v_rank, v_project.name, 'container', 'sequence',
                'project:' || v_project.id::text)
        RETURNING id INTO v_proj_node;
        -- STEP 2: re-parent the root work_item node under the project node (transient 2-cycle).
        UPDATE work_node SET parent_id = v_proj_node WHERE id = v_root_node;
        -- STEP 3: the project node becomes the version's single root.
        UPDATE work_node SET parent_id = NULL WHERE id = v_proj_node;
      ELSE
        -- No root work_item node yet — the version is empty (or just created); the project node
        -- can be the root directly.
        INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
        VALUES (v_pv_id, NULL, v_rank, v_project.name, 'container', 'sequence',
                'project:' || v_project.id::text)
        RETURNING id INTO v_proj_node;
      END IF;

      -- root_node_id → the project node (idempotent).
      UPDATE plan_version SET root_node_id = v_proj_node
        WHERE id = v_pv_id AND root_node_id IS DISTINCT FROM v_proj_node;
    END IF;

    -- The root work_item node must exist UNDER the project node (idempotent).
    IF v_root_node IS NULL THEN
      SELECT COALESCE(sort_order, 1000)::numeric + 1000000000 INTO v_rank
        FROM work_item WHERE id = v_root_item;
      INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, estimate, stable_key)
      VALUES (v_pv_id, v_proj_node,
              to_char(v_rank, 'FM00000000000000000000.000000') || ':' || v_root_item::text,
              v_project.name, 'container', 'sequence', NULL, 'work_item:' || v_root_item::text)
      RETURNING id INTO v_root_node;
    ELSE
      UPDATE work_node SET parent_id = v_proj_node
        WHERE id = v_root_node AND parent_id IS DISTINCT FROM v_proj_node;
    END IF;
  END LOOP;
END $project_root$;

-- ── PART 2: the migration asserts its own TOTAL ─────────────────────────────────
-- Every project has exactly one parentless project node; every project's root work_item node
-- hangs under it; and every plan_version that carries a project node has root_node_id pointing
-- at that project node (the version's single root).
DO $project_root_assert$
DECLARE
  v_bad int;
BEGIN
  -- 1. every project has exactly one parentless 'project:<id>' node
  SELECT count(*) INTO v_bad FROM project p
    WHERE (SELECT count(*) FROM work_node wn
            WHERE wn.stable_key = 'project:' || p.id::text AND wn.parent_id IS NULL) <> 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'PROJECT ROOT backfill TOTAL: % project(s) do not have exactly one parentless project node', v_bad;
  END IF;

  -- 2. every project's root work_item node hangs under its project node
  SELECT count(*) INTO v_bad FROM work_item ri
    WHERE ri.kind = 'project'
      AND NOT EXISTS (
        SELECT 1 FROM work_node rn
        JOIN work_node pn ON pn.id = rn.parent_id
        WHERE rn.stable_key = 'work_item:' || ri.id::text
          AND pn.stable_key = 'project:' || ri.project_id::text);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'PROJECT ROOT backfill TOTAL: % root work_item node(s) do not hang under their project node', v_bad;
  END IF;

  -- 3. every plan_version carrying a project node has root_node_id = that project node
  SELECT count(*) INTO v_bad FROM plan_version pv
    WHERE EXISTS (SELECT 1 FROM work_node pn
                   WHERE pn.plan_version_id = pv.id AND pn.stable_key LIKE 'project:%')
      AND NOT EXISTS (SELECT 1 FROM work_node pn
                       WHERE pn.id = pv.root_node_id
                         AND pn.plan_version_id = pv.id
                         AND pn.stable_key LIKE 'project:%');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'PROJECT ROOT backfill TOTAL: % plan_version(s) carry a project node but root_node_id is not that node', v_bad;
  END IF;
END $project_root_assert$;
