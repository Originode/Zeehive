-- A PROJECT IS A WORK_NODE — the plan's root is the PROJECT, not the root work_item.
--
-- WHY: the gantt is meant to span a whole project end to end ("a project is just a
-- work_node" — manager directive 2026-08-11). Until now the plan_version.root_node_id
-- pointed at the root WORK_ITEM's node (stable_key 'work_item:<root_item_id>', a
-- migration-058 artefact), so the timeline's top trace began at the project's root
-- work_item and there was no single node that WAS the project. This migration inserts a
-- project-level root node (stable_key 'project:<project_id>', kind container,
-- child_semantics 'sequence') above it, makes it plan_version.root_node_id, and hangs the
-- existing root-item node beneath it.
--
-- SHAPE AFTER THE MIGRATION, per project (newest plan_version):
--
--   project:<project_id>          ← the plan root (kind container, sequence)
--     └─ work_item:<root_item_id> ← the project's root work_item (058's singleton)
--          └─ work_item:<activity> …
--               └─ work_item:<task> …
--
-- The `project` table stays the ATTRIBUTE ANNEX, exactly as `work_item` was kept in rehab
-- 1/4: nothing here hollows it out, and no reader is re-pointed off it. The work_node is an
-- ADDITIVE model row the timeline can start from.
--
-- IDEMPOTENT — every insert is keyed by stable_key and guarded by existence checks; a second
-- pass changes ZERO rows. The re-root dance below is safe because work_node has no
-- update/insert triggers (only dependency does), and the whole file runs in ONE transaction
-- (migrate.js), so no reader ever sees the momentary cycle.
--
-- REFUSES RATHER THAN HALF-APPLIES — the mirror-check at the end asserts every project with
-- a plan_version has a project root node with the root item (when present) beneath it, and
-- raises (rolling the whole file back) if not. A version whose root is a FOREIGN node (a
-- workflow test's tree) is refused outright rather than silently re-rooted — the dual-write
-- (work-node-sync.js) opens a NEW version for foreign-rooted plans on the next write.
--
-- FORWARD-ONLY. The DOWN (re-pointing root_node_id back at the root-item node and deleting
-- the project nodes) is deliberately never written: every reader after this migration starts
-- from plan_version.root_node_id, and both shapes are one-way doors.
DO $projectnode$
DECLARE
  v_proj record;
  v_plan uuid;
  v_pv uuid;
  v_root_id uuid;
  v_root_key text;
  v_root_item uuid;
  v_root_item_node uuid;
  v_pnode uuid;
  v_bad int;
BEGIN
  FOR v_proj IN SELECT * FROM project ORDER BY created_at LOOP
    SELECT p.id INTO v_plan FROM plan p WHERE p.project_id = v_proj.id ORDER BY p.created_at LIMIT 1;
    IF v_plan IS NULL THEN CONTINUE; END IF;   -- no plan yet — the dual-write creates one on first write
    SELECT pv.id INTO v_pv FROM plan_version pv WHERE pv.plan_id = v_plan ORDER BY pv.version DESC LIMIT 1;
    IF v_pv IS NULL THEN CONTINUE; END IF;

    -- the project's root work_item (058's trigger guarantees exactly one per project)
    SELECT id INTO v_root_item FROM work_item WHERE project_id = v_proj.id AND kind = 'project' LIMIT 1;

    -- the version's single root (wn_one_root_per_version)
    SELECT id, stable_key INTO v_root_id, v_root_key
      FROM work_node WHERE plan_version_id = v_pv AND parent_id IS NULL;

    -- ── idempotent: the project node is ALREADY the root → ensure the root item hangs under it.
    IF v_root_key = 'project:' || v_proj.id::text THEN
      IF v_root_item IS NOT NULL THEN
        SELECT id INTO v_root_item_node
          FROM work_node
         WHERE plan_version_id = v_pv AND stable_key = 'work_item:' || v_root_item::text;
        IF v_root_item_node IS NULL THEN
          INSERT INTO work_node (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
          VALUES (v_pv, v_root_id, to_char(1000000000::numeric + 1000000000, 'FM00000000000000000000.000000') || ':' || v_root_item,
                  (SELECT title FROM work_item WHERE id = v_root_item), 'container', 'sequence', 'work_item:' || v_root_item::text);
        ELSE
          UPDATE work_node SET parent_id = v_root_id
           WHERE id = v_root_item_node AND parent_id IS DISTINCT FROM v_root_id;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    -- ── the current root must be THIS project's root-item node (the rehab's shape). ──
    IF v_root_id IS NULL OR v_root_key IS DISTINCT FROM 'work_item:' || v_root_item::text THEN
      RAISE EXCEPTION 'project-node backfill: version % has root % (%) which is not the project root-item node — refusing to re-root a foreign tree',
        v_pv, v_root_id, v_root_key;
    END IF;
    v_root_item_node := v_root_id;

    -- ── the re-root dance (safe: no work_node triggers, one transaction) ──
    -- 1. create the project node UNDER the root item (sentinel rank — no real rank starts with
    --    '@', so it cannot collide with the root item's activity children).
    v_pnode := gen_random_uuid();
    INSERT INTO work_node (id, plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, stable_key)
    VALUES (v_pnode, v_pv, v_root_item_node, '@pn:' || v_pnode, v_proj.name, 'container', 'sequence', 'project:' || v_proj.id::text);
    -- 2. re-parent the root item under the project node (keeps its existing rank; the project
    --    node has no children yet, so no wn_i4 collision).
    UPDATE work_node SET parent_id = v_pnode WHERE id = v_root_item_node;
    -- 3. lift the project node to the root. sibling_rank is NOT NULL, so give it a sentinel
    --    root rank (never used for ordering — a root has no siblings).
    UPDATE work_node SET parent_id = NULL, sibling_rank = 'root:' || v_pnode WHERE id = v_pnode;
    -- 4. the version's root pointer follows.
    UPDATE plan_version SET root_node_id = v_pnode WHERE id = v_pv AND root_node_id IS DISTINCT FROM v_pnode;
  END LOOP;

  -- ── MIRROR-CHECK — REFUSE rather than half-apply. ──────────────────────────
  -- Every project that HAS a plan_version must have its NEWEST version's root be a project
  -- node, and the project's root item (when one exists) must hang beneath it.
  SELECT count(*) INTO v_bad
    FROM plan p
    JOIN plan_version pv ON pv.id = (
      SELECT pv2.id FROM plan_version pv2 WHERE pv2.plan_id = p.id ORDER BY pv2.version DESC LIMIT 1)
    JOIN project pj ON pj.id = p.project_id
    LEFT JOIN work_node pn ON pn.id = pv.root_node_id AND pn.stable_key = 'project:' || pj.id::text
    LEFT JOIN work_item ri ON ri.project_id = pj.id AND ri.kind = 'project'
    LEFT JOIN work_node rn ON rn.stable_key = 'work_item:' || ri.id::text
                          AND rn.plan_version_id = pv.id AND rn.parent_id = pn.id
   WHERE pn.id IS NULL
      OR (ri.id IS NOT NULL AND rn.id IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'project-node backfill MIRROR: % plan_version(s) lack a project root node (with the root item beneath it) — nothing was applied', v_bad;
  END IF;
END $projectnode$;
