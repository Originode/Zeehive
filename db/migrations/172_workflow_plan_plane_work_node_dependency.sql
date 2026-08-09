-- HIERARCHICAL WORKFLOW MODEL — PLANE 1 (PLAN): work_node, dependency.
--
-- work_node is the single canonical structural entity (Composite pattern):
-- containers and actions share one table so rollup, dependencies, scheduling and
-- templates all operate uniformly. A node is a container (has children), an
-- action (assigned to an entity — entities arrive in a later stage) or a signal
-- (emits an event other runs can wait on). child_semantics is required iff
-- kind='container', and carries the ordering semantics, the completion rule, the
-- duration rollup formula and whether explicit dependencies are legal inside.
--
-- This stage carries the three semantics sequence/parallel/freeform and their
-- invariants (I2 leaf has no semantics, I3 container has semantics, I4 rank
-- unique among siblings). The operator-specific columns (guard/loop_spec/map_spec/
-- try_role) and the container-shape trigger (I7/I8/I9) arrive with the stages
-- that implement choice/loop/map/try — the child_semantics enum does not even
-- have those values yet, so the schema refuses the node before the shape rules
-- are needed. signal_spec IS kept because the signal KIND is in scope.
--
-- calendar_id is a plain uuid for now: it is part of the policy-inheritance
-- machinery (wn_effective_policy), but the calendar table itself lands with the
-- entities stage. Its FK is added there.
--
-- I5/I6 (dependency legality) are enforced by a trigger that needs wn_lca and
-- wn_is_ancestor_of, so it lives with the tree functions in a later migration.
--
-- Idempotent, additive, forward-only.
CREATE TABLE IF NOT EXISTS work_node (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES plan_version(id) ON DELETE CASCADE,
  parent_id        uuid REFERENCES work_node(id) ON DELETE CASCADE,
  sibling_rank     text NOT NULL,             -- lexorank / fractional; ordering among siblings
  name             text NOT NULL,

  -- STRUCTURE ------------------------------------------------------------
  kind             node_kind NOT NULL,
  child_semantics  child_semantics,           -- required iff kind = 'container'

  -- OPERATOR-SPECIFIC (signal only at this stage) -------------------------
  signal_spec      jsonb,                     -- kind='signal': {name, payload_expr}

  -- POLICY (inheritable: resolve by walking up to nearest non-null ancestor)
  retry_policy     jsonb,                     -- {max, backoff, jitter, retry_on[]}
  timeout          interval,
  on_error         error_policy,
  trigger_rule     trigger_rule NOT NULL DEFAULT 'all_success',
  priority         integer,
  calendar_id      uuid,                      -- FK to calendar() lands with entities

  -- DURATION --------------------------------------------------------------
  estimate         interval,                  -- point estimate (non-container)
  estimate_dist    jsonb,                     -- {dist:'pert', optimistic, likely, pessimistic}

  -- PROVENANCE ------------------------------------------------------------
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- I2: leaves have no children and no child semantics
  CONSTRAINT wn_i2_leaf_has_no_semantics
    CHECK (kind = 'container' OR child_semantics IS NULL),
  -- I3: containers must declare their semantics
  CONSTRAINT wn_i3_container_has_semantics
    CHECK (kind <> 'container' OR child_semantics IS NOT NULL),
  -- signal_spec belongs only to signal nodes
  CONSTRAINT wn_signal_spec_scope
    CHECK (signal_spec IS NULL OR kind = 'signal'),
  -- only one of the two estimate forms
  CONSTRAINT wn_estimate_exclusive
    CHECK (estimate IS NULL OR estimate_dist IS NULL),
  -- I4 (partial): rank uniqueness among siblings
  CONSTRAINT wn_i4_rank_unique UNIQUE (parent_id, sibling_rank)
);

CREATE INDEX IF NOT EXISTS wn_parent_idx       ON work_node (parent_id, sibling_rank);
CREATE INDEX IF NOT EXISTS wn_version_idx      ON work_node (plan_version_id);

-- Root nodes: exactly one per plan_version.
CREATE UNIQUE INDEX IF NOT EXISTS wn_one_root_per_version
  ON work_node (plan_version_id)
  WHERE parent_id IS NULL;

-- plan_version.root_node_id → work_node. DEFERRABLE INITIALLY DEFERRED so the
-- two tables can reference each other (plan_version was created in 167, before
-- work_node existed).
DO $$ BEGIN
  ALTER TABLE plan_version
    ADD CONSTRAINT plan_version_root_fk
    FOREIGN KEY (root_node_id) REFERENCES work_node(id) DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── EXPLICIT PRECEDENCE ──────────────────────────────────────────────────────
-- Control-only ordering: "do this after that, for reasons the data does not
-- capture." Most real dependencies become data edges (stage 2), which carry
-- their own ordering. dep_i6_no_self + the dependency_legality trigger (I5/I6)
-- are the structural guards; the trigger arrives with the tree functions it
-- depends on.
CREATE TABLE IF NOT EXISTS dependency (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid NOT NULL REFERENCES work_node(id) ON DELETE CASCADE,
  to_id      uuid NOT NULL REFERENCES work_node(id) ON DELETE CASCADE,
  type       dependency_type NOT NULL DEFAULT 'FS',
  lag        interval NOT NULL DEFAULT '0',   -- negative = lead
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dep_i6_no_self CHECK (from_id <> to_id),
  UNIQUE (from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS dep_from_idx ON dependency (from_id);
CREATE INDEX IF NOT EXISTS dep_to_idx   ON dependency (to_id);
