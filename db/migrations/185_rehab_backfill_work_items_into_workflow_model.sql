-- REHAB 1/4 — BACKFILL THE LIVE WORK_ITEM TREE INTO THE HIERARCHICAL WORKFLOW MODEL
-- (plan · plan_version · work_node · dependency · run · execution)
--
-- CONTEXT — measured on prod 2026-08-10 by the manager: work_item=503 (kind='project': 2),
-- work_item_event=1744, work_item_dep=3, work_node=0, execution=0. The workflow model
-- (migrations 165…184) is SHIPPED BUT EMPTY. This migration backfills it so that after this
-- file BOTH shapes are true at once — the legacy work_item tree and the workflow model —
-- which is what makes a mistake recoverable (nothing is retired here, and no reader changes).
--
-- MAPPING (the kind enum DIES — activity/task are depths, not kinds):
--
--   • every work_item kind='project' root becomes a plan (plan.project_id = the matching project
--     row), a plan_version (v1), and a ROOT work_node; plan_version.root_node_id is set.
--     HOW WE MATCHED: a kind='project' work_item's project_id column IS the project row's id.
--     Migration 058 guarantees exactly one such root per project (the partial unique index
--     work_item_one_project_root), so the match is identity, not a name or title guess — we
--     never invent a project row. There are 2 such roots on prod.
--
--   • every OTHER work_item becomes a work_node under its parent's work_node. node_kind is
--     picked from SHAPE (has children => 'container', else 'action'). Every container gets a
--     child_semantics: 'sequence' normally (the work_item sort_order is a total order among
--     siblings — exactly sequence semantics), and 'freeform' exactly when the container is the
--     LCA of an explicit work_item_dep edge (the only semantics that permits explicit dependency
--     rows under the model's I5 dependency-legality trigger).
--
--   • sibling_rank ← sort_order (zero-padded numeric text + the item's own id as a deterministic
--     tiebreaker, so lexical order == numeric order and wn_i4_rank_unique can never collide);
--     name ← title; estimate ← estimate_hours × 1 hour.
--
--   • the work_item_dep edges become dependency rows (type 'FS'). The model refuses a dependency
--     whose endpoints are in an ancestor relationship (I6) — if a legacy edge were such a pair
--     this migration FAILS rather than silently dropping it (TOTAL means the 3 edges are 3 rows).
--
--   • each item that EVER RAN gets an execution reconstructed under ONE run per plan_version.
--
-- IDEMPOTENCY IS A COLUMN, NOT A HOPE — work_node.stable_key is keyed 'work_item:<uuid>' and the
-- inserts are upserts on the unique index (plan_version_id, stable_key) created below. Running
-- this migration twice changes ZERO rows: every node insert conflicts and no-ops, the plan and
-- plan_version lookups find the rows the first run created, the execution inserts are guarded by
-- an effect_key existence check, and the plan_version.root_node_id UPDATE is guarded by
-- IS DISTINCT FROM. The migration also ASSERTS its own total at the end (see the final DO block).
--
-- TRUSTED TIMESTAMP for executions — the EARLIEST evidence timestamp across:
--   • work_item_event.ts for kinds 'assigned' and 'status' (the item's own audit trail; every
--     mutation writes one, and 'created'/'edited'/'moved'/'comment' are deliberately NOT
--     evidence that the item RAN — a created-but-never-touched item gets no execution);
--   • zee_turn.started_at for the item's xell (the zee actually consumed turns);
--   • land_request.requested_at for the item's xell (the zee asked to land).
-- started_at = that minimum. finished_at = the LATEST evidence timestamp ONLY when the item's
-- stored status is terminal (done/cancelled — a decision that the work stopped); otherwise NULL.
-- We do not fabricate a finish: an item that never reached a terminal status keeps an open bar.

-- ── the idempotency handle: one node per (plan_version, stable_key) ─────────────
-- The model's stable_key column exists for exactly this ("identity across plan versions"); within
-- ONE plan_version a stable_key must be unique. The existing wn_stable_key_idx is non-unique, so
-- this adds the unique index that lets every backfilled insert be an ON CONFLICT upsert.
CREATE UNIQUE INDEX IF NOT EXISTS wn_stable_key_version_uniq
  ON work_node (plan_version_id, stable_key);

-- ── runs follow their plan_version when a project is deleted ────────────────────
-- 177 created run.plan_version_id with NO ON DELETE CASCADE ("history is preserved on purpose").
-- The rehab's dual-write changes the bargain: from this migration on, EVERY project that works an
-- item accumulates run/execution rows, and the legacy model cascades a project's deletion to ALL
-- of its work (work_item, work_item_event, work_item_dep). Leaving runs RESTRICT would make the
-- most ordinary cleanup — delete a project — fail with an FK violation the moment a single item
-- changed status. So runs now follow the plan_version's deletion, matching the legacy cascade.
DO $$ BEGIN
  ALTER TABLE run DROP CONSTRAINT run_plan_version_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE run ADD CONSTRAINT run_plan_version_id_fkey
    FOREIGN KEY (plan_version_id) REFERENCES plan_version(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- execution.work_node_id is RESTRICT (a node with executions cannot be deleted), which is right
-- for a DIRECT delete but breaks the multi-path cascade a project deletion now triggers: the
-- project cascade removes plan_version → run (→ execution) AND plan_version → work_node in ONE
-- statement, and an immediate FK would refuse the work_node half while the execution half is still
-- mid-cascade. DEFERRABLE INITIALLY DEFERRED moves the check to statement end — the RESTRICT
-- semantics for a direct single-row delete are unchanged, and the interleaved cascade passes.
DO $$ BEGIN
  ALTER TABLE execution DROP CONSTRAINT execution_work_node_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE execution ADD CONSTRAINT execution_work_node_id_fkey
    FOREIGN KEY (work_node_id) REFERENCES work_node(id) DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── PART 1: work_node backfill (plans, plan_versions, the whole tree) ──────────
DO $backfill$
DECLARE
  v_plan_id   uuid;
  v_pv_id     uuid;
  v_parent_id uuid;
  v_node_id   uuid;
  v_kind      node_kind;
  v_sem       child_semantics;
  v_rank      text;
  v_est       interval;
  v_lin_a     text[];
  v_lin_b     text[];
  v_lca       text;
  v_i         int;
  wi          record;
  dep         record;
BEGIN
  -- ── which containers must be 'freeform': the LCA of each dependency edge ──
  -- Materialized once so the node inserts below can read it. The LCA of two work_items is the
  -- longest common prefix of their materialized-path lineages (path segments + the item's own id).
  CREATE TEMP TABLE wn_freeform_lca (work_item_id uuid PRIMARY KEY) ON COMMIT DROP;
  FOR dep IN SELECT * FROM work_item_dep LOOP
    SELECT string_to_array(trim(both '/' FROM (a.path || a.id::text)), '/') INTO v_lin_a
      FROM work_item a WHERE a.id = dep.work_item_id;
    SELECT string_to_array(trim(both '/' FROM (b.path || b.id::text)), '/') INTO v_lin_b
      FROM work_item b WHERE b.id = dep.depends_on_id;
    v_lca := NULL;
    IF v_lin_a IS NOT NULL AND v_lin_b IS NOT NULL THEN
      FOR v_i IN 1..LEAST(array_length(v_lin_a, 1), array_length(v_lin_b, 1)) LOOP
        IF v_lin_a[v_i] = v_lin_b[v_i] THEN v_lca := v_lin_a[v_i]; ELSE EXIT; END IF;
      END LOOP;
    END IF;
    IF v_lca IS NOT NULL THEN
      BEGIN
        INSERT INTO wn_freeform_lca (work_item_id) VALUES (v_lca::uuid) ON CONFLICT DO NOTHING;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE NOTICE 'work_item_dep %: could not resolve LCA "%" to a work_item id — the dependency row will fail if it is an ancestor-edge',
          dep.work_item_id, v_lca;
      END;
    END IF;
  END LOOP;

  -- ── the tree, in depth order (parents strictly before children) ──────────
  FOR wi IN SELECT * FROM work_item ORDER BY depth, sort_order, created_at LOOP
    IF wi.kind = 'project' THEN
      -- root of a project: find/create plan + plan_version for this project
      SELECT id INTO v_plan_id FROM plan WHERE project_id = wi.project_id ORDER BY created_at LIMIT 1;
      IF v_plan_id IS NULL THEN
        INSERT INTO plan (project_id, name, description)
        VALUES (wi.project_id, wi.title, wi.body)
        RETURNING id INTO v_plan_id;
      END IF;
      SELECT id INTO v_pv_id FROM plan_version WHERE plan_id = v_plan_id ORDER BY version DESC LIMIT 1;
      IF v_pv_id IS NULL THEN
        INSERT INTO plan_version (plan_id, version) VALUES (v_plan_id, 1)
        RETURNING id INTO v_pv_id;
      END IF;
      v_parent_id := NULL;
    ELSE
      -- a non-root: inherit the project's plan_version from its root node, and parent from its
      -- parent item's node. Both must already exist (depth ordering guarantees it).
      SELECT wn.plan_version_id INTO v_pv_id
        FROM work_node wn
        JOIN work_item r ON r.kind = 'project' AND r.project_id = wi.project_id
        WHERE wn.stable_key = 'work_item:' || r.id::text
        LIMIT 1;
      SELECT id INTO v_parent_id
        FROM work_node WHERE stable_key = 'work_item:' || wi.parent_id::text LIMIT 1;
      IF v_parent_id IS NULL THEN
        RAISE EXCEPTION 'work_item % (%): parent work_item % has no work_node yet — the tree is not in depth order',
          wi.id, wi.title, wi.parent_id;
      END IF;
    END IF;

    -- node_kind from shape: a project root is always a container; otherwise container iff it has
    -- at least one child work_item.
    IF wi.kind = 'project' OR EXISTS (SELECT 1 FROM work_item c WHERE c.parent_id = wi.id) THEN
      v_kind := 'container';
      IF EXISTS (SELECT 1 FROM wn_freeform_lca WHERE work_item_id = wi.id) THEN
        v_sem := 'freeform';
      ELSE
        v_sem := 'sequence';
      END IF;
    ELSE
      v_kind := 'action';
      v_sem := NULL;
    END IF;

    v_rank := lpad(wi.sort_order::numeric::text, 20, '0') || ':' || wi.id::text;
    v_est  := wi.estimate_hours * interval '1 hour';

    INSERT INTO work_node
      (plan_version_id, parent_id, sibling_rank, name, kind, child_semantics, estimate, stable_key)
    VALUES
      (v_pv_id, v_parent_id, v_rank, wi.title, v_kind, v_sem, v_est, 'work_item:' || wi.id::text)
    ON CONFLICT (plan_version_id, stable_key) DO NOTHING;

    -- a project root is the version's single root: point root_node_id at it (idempotently).
    IF wi.kind = 'project' THEN
      SELECT id INTO v_node_id FROM work_node WHERE stable_key = 'work_item:' || wi.id::text;
      UPDATE plan_version SET root_node_id = v_node_id
        WHERE id = v_pv_id AND root_node_id IS DISTINCT FROM v_node_id;
    END IF;
  END LOOP;

  -- ── the dependency edges ──────────────────────────────────────────────────
  -- LCA containers were flipped to 'freeform' above, so the model's I5 trigger passes. An
  -- ancestor-edge (I6) fails loudly — TOTAL means the 3 edges are 3 dependency rows.
  FOR dep IN SELECT * FROM work_item_dep LOOP
    SELECT id INTO v_node_id FROM work_node WHERE stable_key = 'work_item:' || dep.work_item_id::text;
    SELECT id INTO v_parent_id FROM work_node WHERE stable_key = 'work_item:' || dep.depends_on_id::text;
    INSERT INTO dependency (from_id, to_id, type) VALUES (v_node_id, v_parent_id, 'FS')
    ON CONFLICT (from_id, to_id, type) DO NOTHING;
  END LOOP;
END $backfill$;

-- ── PART 2: executions for items that EVER RAN ─────────────────────────────────
DO $exec$
DECLARE
  r          record;
  v_node_id  uuid;
  v_pv_id    uuid;
  v_run_id   uuid;
  v_exec_id  uuid;
  v_status   work_status;
BEGIN
  -- evidence of "ran": an assigned/status audit event, a zee_turn, or a land_request.
  -- (created/edited/moved/comment events are NOT evidence — see the header.)
  CREATE TEMP TABLE wn_ran (
    work_item_id uuid PRIMARY KEY,
    started_at   timestamptz,
    finished_at  timestamptz
  ) ON COMMIT DROP;

  INSERT INTO wn_ran (work_item_id, started_at, finished_at)
  SELECT wi.id,
         LEAST(
           (SELECT min(e.ts)   FROM work_item_event e WHERE e.work_item_id = wi.id AND e.kind IN ('assigned','status')),
           (SELECT min(z.started_at)    FROM zee_turn z   WHERE z.xell_id = wi.xell_id),
           (SELECT min(lr.requested_at) FROM land_request lr WHERE lr.xell_id = wi.xell_id)
         ),
         CASE WHEN wi.status IN ('done','cancelled') THEN
           GREATEST(
             (SELECT max(e.ts)   FROM work_item_event e WHERE e.work_item_id = wi.id AND e.kind IN ('assigned','status')),
             (SELECT max(z.started_at)    FROM zee_turn z   WHERE z.xell_id = wi.xell_id),
             (SELECT max(lr.requested_at) FROM land_request lr WHERE lr.xell_id = wi.xell_id)
           )
         ELSE NULL END
    FROM work_item wi
   WHERE EXISTS (SELECT 1 FROM work_item_event e WHERE e.work_item_id = wi.id AND e.kind IN ('assigned','status'))
      OR (wi.xell_id IS NOT NULL AND EXISTS (SELECT 1 FROM zee_turn z WHERE z.xell_id = wi.xell_id))
      OR (wi.xell_id IS NOT NULL AND EXISTS (SELECT 1 FROM land_request lr WHERE lr.xell_id = wi.xell_id));

  FOR r IN SELECT * FROM wn_ran LOOP
    SELECT wn.id, wn.plan_version_id INTO v_node_id, v_pv_id
      FROM work_node wn WHERE wn.stable_key = 'work_item:' || r.work_item_id::text;
    IF v_node_id IS NULL THEN
      RAISE EXCEPTION 'REHAB backfill: ran work_item % has no work_node — node backfill is incomplete', r.work_item_id;
    END IF;

    -- ONE run per plan_version (the production instantiation of that plan).
    SELECT id INTO v_run_id FROM run WHERE plan_version_id = v_pv_id ORDER BY created_at LIMIT 1;
    IF v_run_id IS NULL THEN
      INSERT INTO run (plan_version_id, state, correlation_id)
      VALUES (v_pv_id, 'running', 'rehab-backfill')
      RETURNING id INTO v_run_id;
    END IF;

    -- idempotent on effect_key (same trick as work_node.stable_key).
    SELECT id INTO v_exec_id FROM execution
      WHERE run_id = v_run_id AND effect_key = 'work_item:' || r.work_item_id::text;
    IF v_exec_id IS NULL THEN
      SELECT status INTO v_status FROM work_item WHERE id = r.work_item_id;
      INSERT INTO execution (run_id, work_node_id, state, effect_key, started_at, finished_at)
      VALUES (v_run_id, v_node_id,
              CASE v_status WHEN 'done' THEN 'done'::lifecycle_state WHEN 'cancelled' THEN 'cancelled'::lifecycle_state ELSE 'running'::lifecycle_state END,
              'work_item:' || r.work_item_id::text,
              r.started_at, r.finished_at);
    END IF;
  END LOOP;

  -- roll the run's own timestamps and state up from its executions.
  UPDATE run SET
    started_at  = (SELECT min(e.started_at) FROM execution e WHERE e.run_id = run.id),
    finished_at = (SELECT max(e.finished_at) FROM execution e WHERE e.run_id = run.id),
    state = CASE
      WHEN EXISTS (SELECT 1 FROM execution e WHERE e.run_id = run.id AND e.state = 'cancelled')
       AND NOT EXISTS (SELECT 1 FROM execution e WHERE e.run_id = run.id AND e.state <> 'cancelled')
        THEN 'cancelled'::run_state
      WHEN NOT EXISTS (SELECT 1 FROM execution e WHERE e.run_id = run.id AND e.state NOT IN ('done','cancelled'))
        THEN 'succeeded'::run_state
      ELSE 'running'::run_state END
    WHERE correlation_id = 'rehab-backfill';
END $exec$;

-- ── PART 3: the migration asserts its own TOTAL ────────────────────────────────
-- Every non-project work_item has exactly one work_node, every project root has a plan +
-- plan_version + root node with root_node_id set, and the work_item_dep edges are dependency rows.
DO $assert$
DECLARE
  v_items  int;
  v_nodes  int;
  v_bad    int;
BEGIN
  SELECT count(*) INTO v_items FROM work_item WHERE kind <> 'project';
  SELECT count(*) INTO v_nodes FROM work_node wn
    WHERE wn.stable_key LIKE 'work_item:%'
      AND EXISTS (SELECT 1 FROM work_item wi
                   WHERE wi.kind <> 'project' AND 'work_item:' || wi.id::text = wn.stable_key);
  IF v_items IS DISTINCT FROM v_nodes THEN
    RAISE EXCEPTION 'REHAB backfill TOTAL mismatch: % non-project work_items but % backfilled work_nodes',
      v_items, v_nodes;
  END IF;

  SELECT count(*) INTO v_bad FROM work_item r
    WHERE r.kind = 'project'
      AND NOT EXISTS (
        SELECT 1 FROM plan p
        JOIN plan_version pv ON pv.plan_id = p.id AND pv.root_node_id IS NOT NULL
        JOIN work_node rn ON rn.id = pv.root_node_id
        WHERE p.project_id = r.project_id AND rn.stable_key = 'work_item:' || r.id::text);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'REHAB backfill: % project root(s) lack a plan+plan_version+root_node with root_node_id set', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM work_item_dep d
    WHERE NOT EXISTS (
      SELECT 1 FROM work_node a JOIN work_node b ON true
      JOIN dependency dp ON dp.from_id = a.id AND dp.to_id = b.id AND dp.type = 'FS'
      WHERE a.stable_key = 'work_item:' || d.work_item_id::text
        AND b.stable_key = 'work_item:' || d.depends_on_id::text);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'REHAB backfill: % work_item_dep edge(s) have no FS dependency row', v_bad;
  END IF;
END $assert$;
