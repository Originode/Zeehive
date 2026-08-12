-- HIERARCHICAL WORKFLOW MODEL — PLANE 1 (work_node · dependency) + the union graph
--
-- Stage 1, second half (docs/hierarchical-workflow-adoption.md §5). 165 created the shared
-- enum types, `calendar` and PLANE 0 (plan/plan_version). This file creates PLANE 1 — the
-- single canonical work_node table, the explicit precedence `dependency` table, the tree
-- helpers (wn_ancestors/wn_lca/wn_is_ancestor_of/wn_is_atom/wn_first_leaves/wn_last_leaves),
-- the union_edge view (sequence order + expanded deps), leaf-expanded detect_cycles, the
-- I5/I6 dependency-legality trigger, and the two rollup helpers wn_effective_policy and
-- wn_duration.
--
-- DESIGN OF RECORD: docs/hierarchical-workflow-schema.sql. Departures, all stage boundaries:
--
--   • child_semantics is restricted to sequence/parallel/freeform by the stage-1 column
--     constraint wn_stage1_child_semantics. The full enum (choice/race/map/loop/try) already
--     exists from 165; a later stage DROPs this one constraint and the operators unlock.
--
--   • template_id/method_id are omitted — template/method (plane 0) are stage 9–14.
--     bindings/stable_key (provenance without an FK) ARE kept.
--
--   • union_edge has the sequence-order and dependency branches only. The DATA branch
--     (I14: every data edge implies precedence) is commented in place and UNIONs in with
--     stage 2 when port/data_edge land — the view will not need a rewrite, just an
--     appended UNION ALL branch.
--
--   • check_container_shape (I7/I8/I9 — choice/try/loop/map shape) is stage 4+ and NOT
--     here. Its loop/map single-child and bounded-loop rules cannot fire today because
--     child_semantics cannot be loop/map.
--
--   • The DDL's entity tables, detect_plan_call_cycles (E7), and the append-only event
--     trigger (I16) are stage 3/5 and NOT here.
--
-- FORWARD-ONLY. The DOWN thinking, in order (never run in prod): DROP TRIGGER
-- dependency_legality; DROP FUNCTION check_dependency_legality, wn_effective_policy,
-- wn_duration, detect_cycles; DROP VIEW union_edge; DROP FUNCTION wn_first_leaves,
-- wn_last_leaves, wn_is_atom, wn_is_ancestor_of, wn_lca, wn_ancestors; DROP TABLE
-- dependency, work_node; then 165's objects.

-- ── PLANE 1 — PLAN: work_node ──────────────────────────────────────────────────
-- One table for containers and leaves (Composite pattern): rollup, dependencies,
-- scheduling and templates operate uniformly. A container HAS children; an action is
-- assigned to an entity; a signal emits an event other runs can wait on.
CREATE TABLE IF NOT EXISTS work_node (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES plan_version(id) ON DELETE CASCADE,
  parent_id        uuid REFERENCES work_node(id) ON DELETE CASCADE,
  sibling_rank     text NOT NULL,               -- lexorank / fractional; ordering among siblings
  name             text NOT NULL,

  -- STRUCTURE ------------------------------------------------------------
  kind             node_kind NOT NULL,
  child_semantics  child_semantics,             -- required iff kind = 'container'

  -- ENTITY BINDING (actions) ---------------------------------------------
  -- Nodes describe what they NEED, not who does it. Resolution happens at dispatch
  -- time. Swapping a person for a model is a capability registration, not a plan edit.
  req_capabilities text[] NOT NULL DEFAULT '{}',
  req_constraints  text,                        -- e.g. 'entity.reliability > 0.95'
  req_selection    selection_policy NOT NULL DEFAULT 'least_loaded',
  req_candidates   uuid[],                      -- optional narrowing of the pool
  req_quantity     numeric NOT NULL DEFAULT 1,
  req_mode         allocation_mode NOT NULL DEFAULT 'exclusive',

  -- OPERATOR-SPECIFIC (stage 4+/9 — inert today under wn_stage1_child_semantics) --
  guard            text,                        -- child of 'choice'
  loop_spec        jsonb,                       -- {while|until|count|forEach, max_iterations}
  map_spec         jsonb,                       -- {over, concurrency, reducer}
  try_role         try_role,                    -- child of 'try'
  signal_spec      jsonb,                       -- kind='signal': {name, payload_expr}

  -- POLICY (inheritable: resolve by walking up to nearest non-null ancestor) --
  retry_policy     jsonb,                       -- {max, backoff, jitter, retry_on[]}
  timeout          interval,
  on_error         error_policy,
  trigger_rule     trigger_rule NOT NULL DEFAULT 'all_success',
  idempotency      jsonb,                       -- {key_expr, effect_scope}
  priority         integer,
  calendar_id      uuid REFERENCES calendar(id),
  scope_vars       jsonb,                       -- variables visible to this subtree

  -- LIFECYCLE ------------------------------------------------------------
  expansion        expansion_state NOT NULL DEFAULT 'primitive',

  -- SCHEDULING -----------------------------------------------------------
  estimate         interval,                    -- point estimate
  estimate_dist    jsonb,                       -- {dist:'pert', optimistic, likely, pessimistic}
  deadline         timestamptz,
  earliest_start   timestamptz,                 -- computed by forward pass
  earliest_finish  timestamptz,
  latest_start     timestamptz,                 -- computed by backward pass
  latest_finish    timestamptz,
  slack            interval,

  -- PROVENANCE -----------------------------------------------------------
  -- (template_id/method_id arrive with template/method, stage 9–14)
  bindings         jsonb,
  stable_key       text,                        -- identity across plan versions

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- I2: leaves have no children and no child semantics
  CONSTRAINT wn_i2_leaf_has_no_semantics CHECK (kind = 'container' OR child_semantics IS NULL),
  -- I3: containers must declare their semantics
  CONSTRAINT wn_i3_container_has_semantics CHECK (kind <> 'container' OR child_semantics IS NOT NULL),
  -- loop_spec / map_spec belong only to their operator (vacuous until stage 4+)
  CONSTRAINT wn_loop_spec_scope CHECK (loop_spec IS NULL OR child_semantics = 'loop'),
  CONSTRAINT wn_map_spec_scope CHECK (map_spec IS NULL OR child_semantics = 'map'),
  CONSTRAINT wn_loop_needs_spec CHECK (child_semantics <> 'loop' OR loop_spec IS NOT NULL),
  CONSTRAINT wn_map_needs_spec CHECK (child_semantics <> 'map' OR map_spec IS NOT NULL),
  -- I8: unbounded loops are forbidden at the schema level (vacuous until stage 4+)
  CONSTRAINT wn_i8_loop_bounded CHECK (child_semantics <> 'loop' OR (loop_spec ? 'max_iterations')),
  CONSTRAINT wn_map_bounded CHECK (child_semantics <> 'map' OR (map_spec ? 'concurrency')),
  CONSTRAINT wn_signal_spec_scope CHECK (signal_spec IS NULL OR kind = 'signal'),
  -- only one of the two estimate forms
  CONSTRAINT wn_estimate_exclusive CHECK (estimate IS NULL OR estimate_dist IS NULL),
  -- I4 (partial): rank uniqueness among siblings
  CONSTRAINT wn_i4_rank_unique UNIQUE (parent_id, sibling_rank),
  -- STAGE-1 WELD: child_semantics may only be sequence/parallel/freeform today.
  -- choice/race/map/loop/try are stage 4+/9 — the enum values exist (165) so unlocking
  -- is a DROP of this constraint, not an ALTER TYPE.
  CONSTRAINT wn_stage1_child_semantics
    CHECK (child_semantics IS NULL OR child_semantics IN ('sequence', 'parallel', 'freeform'))
);

CREATE INDEX IF NOT EXISTS wn_parent_idx       ON work_node (parent_id, sibling_rank);
CREATE INDEX IF NOT EXISTS wn_version_idx      ON work_node (plan_version_id);
-- The two indexes below reference columns 172 (the sibling stage-1 set) never created on
-- work_node. On a narrow-first database (167…175 applied before this file), those columns
-- do not exist yet — 176 adds them — so the index is guarded: if the column is missing the
-- CREATE raises undefined_column, which the DO-block swallows and 176's convergence brings
-- the index in. On a fresh database (165/166 first) the columns exist and the index is
-- created as before. 176 remains the single place convergence happens; this is only
-- tolerance for the narrow shape.
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS wn_capabilities_idx ON work_node USING gin (req_capabilities);
EXCEPTION WHEN undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS wn_stable_key_idx   ON work_node (plan_version_id, stable_key);
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- Root nodes: exactly one per plan_version.
CREATE UNIQUE INDEX IF NOT EXISTS wn_one_root_per_version
  ON work_node (plan_version_id)
  WHERE parent_id IS NULL;

-- plan_version.root_node_id's FK, deferred so a version can be created before its tree.
-- DO-blocked for re-run safety, like every other ADD CONSTRAINT in this repo.
DO $$ BEGIN
  ALTER TABLE plan_version
    ADD CONSTRAINT plan_version_root_fk
    FOREIGN KEY (root_node_id) REFERENCES work_node(id) DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Explicit precedence ─────────────────────────────────────────────────────────
-- Control-only ordering: "do this after that, for reasons the data does not capture."
-- Most real dependencies are data edges instead (plane 2, stage 2), which generate their
-- own ordering (I14).
CREATE TABLE IF NOT EXISTS dependency (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid NOT NULL REFERENCES work_node(id) ON DELETE CASCADE,
  to_id      uuid NOT NULL REFERENCES work_node(id) ON DELETE CASCADE,
  type       dependency_type NOT NULL DEFAULT 'FS',
  lag        interval NOT NULL DEFAULT '0',     -- negative = lead
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dep_i6_no_self CHECK (from_id <> to_id),
  CONSTRAINT dependency_from_to_type_unique UNIQUE (from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS dep_from_idx ON dependency (from_id);
CREATE INDEX IF NOT EXISTS dep_to_idx   ON dependency (to_id);

-- ── TREE FUNCTIONS ─────────────────────────────────────────────────────────────
-- Ancestors of a node, nearest first.
CREATE OR REPLACE FUNCTION wn_ancestors(p_node uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE up AS (
        SELECT w.parent_id AS id, 1 AS depth
        FROM work_node w WHERE w.id = p_node AND w.parent_id IS NOT NULL
        UNION ALL
        SELECT w.parent_id, up.depth + 1
        FROM up JOIN work_node w ON w.id = up.id
        WHERE w.parent_id IS NOT NULL
    )
    SELECT id, depth FROM up ORDER BY depth;
$$;

-- Lowest common ancestor. The basis of invariant I5.
CREATE OR REPLACE FUNCTION wn_lca(p_a uuid, p_b uuid)
RETURNS uuid
LANGUAGE sql STABLE AS $$
    WITH a AS (SELECT p_a AS id, 0 AS depth UNION ALL SELECT id, depth FROM wn_ancestors(p_a)),
         b AS (SELECT p_b AS id, 0 AS depth UNION ALL SELECT id, depth FROM wn_ancestors(p_b))
    SELECT a.id FROM a JOIN b ON a.id = b.id ORDER BY a.depth LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION wn_is_ancestor_of(p_maybe_ancestor uuid, p_node uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM wn_ancestors(p_node) WHERE id = p_maybe_ancestor);
$$;

-- An "atom" is a vertex of the union graph: any leaf, plus loop and map containers
-- (whose bodies are contracted to a single vertex so that repetition does not make the
-- graph cyclic). With child_semantics restricted to sequence/parallel/freeform today,
-- loop/map are unreachable — the function is written to the full design so stage 4+
-- unlocks it without a rewrite.
CREATE OR REPLACE FUNCTION wn_is_atom(p_node uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT kind <> 'container' OR child_semantics::text IN ('loop', 'map')
    FROM work_node WHERE id = p_node;
$$;

-- Entry leaves of a subtree. Under 'sequence' only the first child can start; under
-- every other operator any child may.
CREATE OR REPLACE FUNCTION wn_first_leaves(p_node uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_sem child_semantics;
    v_child uuid;
BEGIN
    IF wn_is_atom(p_node) THEN
        RETURN QUERY SELECT p_node; RETURN;
    END IF;

    SELECT child_semantics INTO v_sem FROM work_node WHERE work_node.id = p_node;

    IF v_sem = 'sequence' THEN
        SELECT w.id INTO v_child FROM work_node w
        WHERE w.parent_id = p_node ORDER BY w.sibling_rank LIMIT 1;
        IF v_child IS NULL THEN RETURN QUERY SELECT p_node; RETURN; END IF;
        RETURN QUERY SELECT * FROM wn_first_leaves(v_child);
    ELSIF v_sem = 'try' THEN
        FOR v_child IN
            SELECT w.id FROM work_node w
            WHERE w.parent_id = p_node AND w.try_role = 'body' ORDER BY w.sibling_rank
        LOOP
            RETURN QUERY SELECT * FROM wn_first_leaves(v_child);
        END LOOP;
    ELSE
        FOR v_child IN
            SELECT w.id FROM work_node w WHERE w.parent_id = p_node ORDER BY w.sibling_rank
        LOOP
            RETURN QUERY SELECT * FROM wn_first_leaves(v_child);
        END LOOP;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION wn_last_leaves(p_node uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_sem child_semantics;
    v_child uuid;
BEGIN
    IF wn_is_atom(p_node) THEN
        RETURN QUERY SELECT p_node; RETURN;
    END IF;

    SELECT child_semantics INTO v_sem FROM work_node WHERE work_node.id = p_node;

    IF v_sem = 'sequence' THEN
        SELECT w.id INTO v_child FROM work_node w
        WHERE w.parent_id = p_node ORDER BY w.sibling_rank DESC LIMIT 1;
        IF v_child IS NULL THEN RETURN QUERY SELECT p_node; RETURN; END IF;
        RETURN QUERY SELECT * FROM wn_last_leaves(v_child);
    ELSE
        FOR v_child IN
            SELECT w.id FROM work_node w WHERE w.parent_id = p_node ORDER BY w.sibling_rank
        LOOP
            RETURN QUERY SELECT * FROM wn_last_leaves(v_child);
        END LOOP;
    END IF;
END;
$$;

-- ── THE UNION GRAPH ─────────────────────────────────────────────────────────────
-- Scheduling and cycle detection NEVER look at the dependency table alone. Edges come
-- from three sources:
--   1. sibling order under 'sequence'
--   2. explicit dependency rows
--   3. every data edge (I14) — STAGE 2, when port/data_edge land.
--
-- Leaf expansion is NOT optional. Contracting each subtree to one vertex reports false
-- cycles. Counterexample: A = sequence[A1,A2], B = sequence[B1,B2], edges A1->B1 and
-- B2->A2. Contracted you see A->B and B->A, a cycle. Expanded you see the path
-- A1->B1->B2->A2, perfectly acyclic.
CREATE OR REPLACE VIEW union_edge AS
    -- (1) sibling order under 'sequence'
    SELECT p.plan_version_id,
           lf.id  AS from_id,
           ff.id  AS to_id,
           'sequence'::text AS origin,
           '0'::interval    AS lag
    FROM work_node p
    JOIN work_node a ON a.parent_id = p.id
    JOIN LATERAL (
        SELECT b.id, b.sibling_rank FROM work_node b
        WHERE b.parent_id = p.id AND b.sibling_rank > a.sibling_rank
        ORDER BY b.sibling_rank LIMIT 1
    ) nxt ON true
    CROSS JOIN LATERAL wn_last_leaves(a.id)  lf
    CROSS JOIN LATERAL wn_first_leaves(nxt.id) ff
    WHERE p.child_semantics = 'sequence'

    UNION ALL

    -- (2) explicit dependency rows, expanded per link type
    SELECT w.plan_version_id, e.from_leaf, e.to_leaf, 'dependency', d.lag
    FROM dependency d
    JOIN work_node w ON w.id = d.from_id
    CROSS JOIN LATERAL (
        SELECT lf.id AS from_leaf, tf.id AS to_leaf
        FROM (SELECT id FROM wn_last_leaves(d.from_id)  WHERE d.type IN ('FS','FF')
              UNION ALL
              SELECT id FROM wn_first_leaves(d.from_id) WHERE d.type IN ('SS','SF')) lf
        CROSS JOIN
             (SELECT id FROM wn_first_leaves(d.to_id) WHERE d.type IN ('FS','SS')
              UNION ALL
              SELECT id FROM wn_last_leaves(d.to_id)  WHERE d.type IN ('FF','SF')) tf
    ) e;

    -- (3) I14: every data edge implies precedence — STAGE 2.
    -- SELECT wf.plan_version_id, lf.id, ff.id, 'data', '0'::interval
    -- FROM data_edge de
    -- JOIN port pf ON pf.id = de.from_port_id
    -- JOIN port pt ON pt.id = de.to_port_id
    -- JOIN work_node wf ON wf.id = pf.work_node_id
    -- JOIN work_node wt ON wt.id = pt.work_node_id
    -- CROSS JOIN LATERAL wn_last_leaves(wf.id)  lf
    -- CROSS JOIN LATERAL wn_first_leaves(wt.id) ff
    -- WHERE wf.id <> wt.id;

-- Cycle detection over the union graph (I10). Returns offending edges.
CREATE OR REPLACE FUNCTION detect_cycles(p_version uuid)
RETURNS TABLE (from_id uuid, to_id uuid, path uuid[])
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE e AS (
        SELECT ue.from_id, ue.to_id FROM union_edge ue
        WHERE ue.plan_version_id = p_version
    ),
    walk AS (
        SELECT e.from_id AS root, e.to_id AS node,
               ARRAY[e.from_id, e.to_id] AS path, false AS cyc
        FROM e
        UNION ALL
        SELECT w.root, e.to_id, w.path || e.to_id, e.to_id = ANY(w.path)
        FROM walk w JOIN e ON e.from_id = w.node
        WHERE NOT w.cyc AND array_length(w.path, 1) < 10000
    )
    SELECT path[array_length(path,1)-1], node, path
    FROM walk WHERE cyc;
$$;

-- ── INVARIANT TRIGGERS ──────────────────────────────────────────────────────────
-- I5: an explicit dependency is legal iff LCA(from, to).child_semantics = 'freeform'.
-- Under 'sequence' the edge is implied or contradicts rank; under 'parallel' it
-- contradicts parallelism; under 'choice'/'race' only one branch survives, so a
-- cross-branch edge is incoherent. Data edges are exempt — they carry their own
-- meaning and generate their own ordering.
-- I6: neither endpoint may be an ancestor of the other.
CREATE OR REPLACE FUNCTION check_dependency_legality()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_lca uuid; v_sem child_semantics;
BEGIN
    IF wn_is_ancestor_of(NEW.from_id, NEW.to_id)
       OR wn_is_ancestor_of(NEW.to_id, NEW.from_id) THEN
        RAISE EXCEPTION 'I6 violated: % and % are in an ancestor relationship',
            NEW.from_id, NEW.to_id;
    END IF;

    v_lca := wn_lca(NEW.from_id, NEW.to_id);
    IF v_lca IS NULL THEN
        RAISE EXCEPTION 'I5 violated: % and % share no common ancestor',
            NEW.from_id, NEW.to_id;
    END IF;

    SELECT child_semantics INTO v_sem FROM work_node WHERE id = v_lca;
    IF v_sem IS DISTINCT FROM 'freeform' THEN
        RAISE EXCEPTION
            'I5 violated: dependency %->% has LCA % with semantics %; only freeform permits explicit dependencies',
            NEW.from_id, NEW.to_id, v_lca, v_sem;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER dependency_legality
    BEFORE INSERT OR UPDATE ON dependency
    FOR EACH ROW EXECUTE FUNCTION check_dependency_legality();

-- ── ROLLUP ─────────────────────────────────────────────────────────────────────
-- Duration per operator:
--   sequence  Σ children        parallel  max children
--   choice    selected child    race      min children
--   map       max instances     loop      body × expected iterations
--   try       body (+ catch on the failure path)
--   freeform  longest path through children in the union graph
CREATE OR REPLACE FUNCTION wn_duration(p_node uuid)
RETURNS interval
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_kind node_kind; v_sem child_semantics;
    v_est interval;   v_spec jsonb;
    v_total interval := '0'; v_child_dur interval; v_child uuid;
BEGIN
    SELECT kind, child_semantics, estimate,
           COALESCE(loop_spec, map_spec)
      INTO v_kind, v_sem, v_est, v_spec
    FROM work_node WHERE id = p_node;

    IF v_kind <> 'container' THEN
        RETURN COALESCE(v_est, '0'::interval);
    END IF;

    IF v_sem = 'sequence' THEN
        SELECT COALESCE(sum(wn_duration(w.id)), '0') INTO v_total
        FROM work_node w WHERE w.parent_id = p_node;
    ELSIF v_sem IN ('parallel', 'map', 'try') THEN
        SELECT COALESCE(max(wn_duration(w.id)), '0') INTO v_total
        FROM work_node w WHERE w.parent_id = p_node;
    ELSIF v_sem = 'choice' THEN
        -- worst case for planning; substitute the selected branch at runtime
        SELECT COALESCE(max(wn_duration(w.id)), '0') INTO v_total
        FROM work_node w WHERE w.parent_id = p_node;
    ELSIF v_sem = 'race' THEN
        SELECT COALESCE(min(wn_duration(w.id)), '0') INTO v_total
        FROM work_node w WHERE w.parent_id = p_node;
    ELSIF v_sem = 'loop' THEN
        SELECT wn_duration(w.id) INTO v_child_dur
        FROM work_node w WHERE w.parent_id = p_node LIMIT 1;
        v_total := COALESCE(v_child_dur, '0') *
                   COALESCE((v_spec->>'expected_iterations')::numeric,
                            (v_spec->>'max_iterations')::numeric, 1);
    ELSE  -- freeform: CPM longest path is computed by the scheduler, not here
        SELECT COALESCE(max(wn_duration(w.id)), '0') INTO v_total
        FROM work_node w WHERE w.parent_id = p_node;
    END IF;

    RETURN v_total;
END;
$$;

-- ── OPERATIONAL VIEWS ───────────────────────────────────────────────────────────
-- Policy inheritance: resolve by walking up to the nearest ancestor that sets the
-- field. Configure once at the root, override at three nodes, not at four hundred leaves.
CREATE OR REPLACE FUNCTION wn_effective_policy(p_node uuid)
RETURNS TABLE (retry_policy jsonb, timeout interval, on_error error_policy,
               priority integer, calendar_id uuid)
LANGUAGE sql STABLE AS $$
    WITH chain AS (
        SELECT p_node AS id, 0 AS depth
        UNION ALL SELECT id, depth FROM wn_ancestors(p_node)
    ),
    vals AS (
        SELECT w.*, c.depth FROM chain c JOIN work_node w ON w.id = c.id
    )
    SELECT
        (SELECT v.retry_policy FROM vals v WHERE v.retry_policy IS NOT NULL ORDER BY v.depth LIMIT 1),
        (SELECT v.timeout      FROM vals v WHERE v.timeout      IS NOT NULL ORDER BY v.depth LIMIT 1),
        (SELECT v.on_error     FROM vals v WHERE v.on_error     IS NOT NULL ORDER BY v.depth LIMIT 1),
        (SELECT v.priority     FROM vals v WHERE v.priority     IS NOT NULL ORDER BY v.depth LIMIT 1),
        (SELECT v.calendar_id  FROM vals v WHERE v.calendar_id  IS NOT NULL ORDER BY v.depth LIMIT 1);
$$;
