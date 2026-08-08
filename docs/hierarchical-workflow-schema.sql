-- =============================================================================
-- HIERARCHICAL WORKFLOW MODEL — PostgreSQL 15+
--
-- Four planes:
--   PLANE 0  DEFINITION  plan, plan_version, template, method   (immutable once published)
--   PLANE 1  PLAN        work_node, dependency                  (mutable, schedulable)
--   PLANE 2  DATA        port, data_edge                        (typed flow)
--   PLANE 3  RUN         run, execution, lease, allocation,     (append-only, durable)
--                        checkpoint, event
--
-- Cross-cutting: entity (anything that can be assigned work — person, model,
-- script, service, pool, or another plan).
--
-- Referencing rule: a plane may reference the plane below it, never above.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- ENUM TYPES
-- =============================================================================

-- A work_node is a container (has children), an action (assigned to an entity),
-- or a signal (emits an event other runs can wait on). There is deliberately no
-- 'wait' kind and no 'subprocess' kind: waiting is a long lease held by a pull
-- entity, and a subprocess is an action bound to a plan-backed entity.
CREATE TYPE node_kind AS ENUM ('container', 'action', 'signal');

-- How a container's children relate to each other. This single field carries
-- the ordering semantics, the completion rule, the duration rollup formula, and
-- whether explicit dependencies are legal inside.
CREATE TYPE child_semantics AS ENUM (
    'sequence',   -- total order by sibling_rank; completes when all done
    'parallel',   -- unordered, concurrent, static width; all done
    'choice',     -- exactly one child by guard; others skipped
    'race',       -- all start, first to finish wins; others cancelled
    'map',        -- dynamic fan-out, one instance per item in map_spec.over
    'loop',       -- one child, repeated per loop_spec
    'try',        -- error boundary; children tagged by try_role
    'freeform'    -- partial order defined by explicit dependency rows
);

CREATE TYPE try_role AS ENUM ('body', 'catch', 'finally', 'compensate');

CREATE TYPE expansion_state AS ENUM (
    'primitive',    -- no further decomposition
    'unexpanded',   -- template bound, not yet expanded
    'expanded',     -- children materialised
    'stale'         -- guard that selected the method is no longer true
);

CREATE TYPE lifecycle_state AS ENUM (
    'pending',      -- not yet eligible
    'ready',        -- predecessors satisfied, guard true, entity allocatable
    'running',      -- lease held, work in flight
    'waiting',      -- lease held, blocked on external signal/timer/human
    'done',
    'failed',
    'skipped',      -- choice branch not selected, or upstream skip propagated
    'cancelled',    -- race loser, or explicit cancellation
    'blocked',      -- requirements unsatisfiable (no matching entity)
    'compensated'   -- completed then rolled back; distinct from done and failed
);

-- What a node does when predecessors did not all succeed.
CREATE TYPE trigger_rule AS ENUM (
    'all_success',  -- default; blocks on skipped or failed predecessors
    'none_failed',  -- runs if predecessors are done or skipped, not failed
    'all_done',     -- runs regardless of predecessor outcome
    'one_success'   -- runs as soon as any predecessor succeeds
);

CREATE TYPE error_policy AS ENUM (
    'fail',         -- propagate failure upward
    'retry',        -- per retry_policy
    'catch',        -- hand to the nearest enclosing try/catch
    'skip',         -- mark skipped and continue
    'compensate',   -- trigger saga rollback of the enclosing try
    'escalate'      -- reassign to an entity with escalation capability
);

CREATE TYPE port_direction AS ENUM ('in', 'out');

-- Classic precedence link types, as in CPM / MS Project.
CREATE TYPE dependency_type AS ENUM (
    'FS',  -- finish-to-start  (default)
    'SS',  -- start-to-start
    'FF',  -- finish-to-finish
    'SF'   -- start-to-finish
);

-- How an entity receives work. Push = engine calls out and holds a short lease.
-- Pull = work lands in a queue, entity claims it and holds a long lease.
CREATE TYPE dispatch_mode AS ENUM ('push', 'pull');

CREATE TYPE cancellability AS ENUM (
    'immediate',    -- can be stopped synchronously
    'cooperative',  -- honours a cancellation request, eventually
    'never'         -- engine must model orphaned work
);

CREATE TYPE selection_policy AS ENUM (
    'cheapest', 'fastest', 'most_reliable',
    'round_robin', 'least_loaded', 'explicit'
);

CREATE TYPE lease_state AS ENUM ('held', 'released', 'expired', 'revoked');

CREATE TYPE run_state AS ENUM (
    'pending', 'running', 'paused', 'succeeded',
    'failed', 'cancelled', 'compensated'
);

-- What happens to an in-flight run when its plan is edited.
CREATE TYPE version_policy AS ENUM ('pinned', 'migrate', 'restart');

CREATE TYPE allocation_mode AS ENUM ('exclusive', 'shared');


-- =============================================================================
-- CROSS-CUTTING: ENTITY
--
-- An entity is anything that can be assigned work and eventually return a
-- result. Person, model, script, service, pool, org unit, or another plan.
-- The differences are parameter values, not types — there is no discriminated
-- union here on purpose. kind_hint is for dashboards and telemetry ONLY; engine
-- logic must never branch on it.
-- =============================================================================

CREATE TABLE entity (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    kind_hint       text,                      -- display only. NEVER branch on this.

    -- CONTRACT
    capabilities    text[] NOT NULL DEFAULT '{}',
    accepts         jsonb,                     -- JSON Schema for input
    produces        jsonb,                     -- JSON Schema for output

    -- BEHAVIOUR (attributes, not subtypes)
    dispatch        dispatch_mode  NOT NULL DEFAULT 'push',
    latency         jsonb,                     -- {dist: 'pert', optimistic, likely, pessimistic}
    reliability     numeric(5,4)   NOT NULL DEFAULT 1.0
                        CHECK (reliability BETWEEN 0 AND 1),
    cost_model      jsonb,                     -- {unit: time|token|call|currency, rate}
    cancellable     cancellability NOT NULL DEFAULT 'cooperative',
    deterministic   boolean        NOT NULL DEFAULT false,

    -- CAPACITY
    concurrency     integer        NOT NULL DEFAULT 1 CHECK (concurrency > 0),
    calendar_id     uuid,
    rate_limit      jsonb,                     -- {n, per_seconds, burst}
    consumable      boolean        NOT NULL DEFAULT false,
                    -- false: capacity returns on release (people, workers, licences)
                    -- true:  capacity is spent permanently (budget, materials)
    capacity_total  numeric,                   -- required when consumable
    capacity_used   numeric        NOT NULL DEFAULT 0,

    -- COMPOSITION
    plan_id         uuid,                      -- set => assigning work launches a plan

    enabled         boolean        NOT NULL DEFAULT true,
    created_at      timestamptz    NOT NULL DEFAULT now(),
    updated_at      timestamptz    NOT NULL DEFAULT now(),

    CONSTRAINT entity_consumable_needs_capacity
        CHECK (NOT consumable OR capacity_total IS NOT NULL),
    CONSTRAINT entity_capacity_not_overdrawn
        CHECK (capacity_total IS NULL OR capacity_used <= capacity_total)
);

CREATE INDEX entity_capabilities_idx ON entity USING gin (capabilities);
CREATE INDEX entity_plan_idx         ON entity (plan_id) WHERE plan_id IS NOT NULL;

-- Pools and org units: an entity whose capacity is drawn from its members.
CREATE TABLE entity_member (
    parent_id  uuid NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
    member_id  uuid NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
    weight     numeric NOT NULL DEFAULT 1,
    PRIMARY KEY (parent_id, member_id),
    CONSTRAINT entity_member_no_self CHECK (parent_id <> member_id)
);

CREATE TABLE calendar (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    timezone    text NOT NULL DEFAULT 'UTC',
    working_hours jsonb NOT NULL,              -- [{dow:1, from:'09:00', to:'17:00'}, ...]
    holidays    date[] NOT NULL DEFAULT '{}'
);

ALTER TABLE entity
    ADD CONSTRAINT entity_calendar_fk
    FOREIGN KEY (calendar_id) REFERENCES calendar(id);


-- =============================================================================
-- PLANE 0 — DEFINITION
-- =============================================================================

CREATE TABLE plan (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE entity
    ADD CONSTRAINT entity_plan_fk
    FOREIGN KEY (plan_id) REFERENCES plan(id);

CREATE TABLE plan_version (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id      uuid NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
    version      integer NOT NULL,
    published    boolean NOT NULL DEFAULT false,
    root_node_id uuid,                          -- FK added after work_node exists
    diff_from_previous jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plan_id, version)
);

-- A template is a named decomposition point. Multiple methods per template is
-- the whole point: the same abstract task decomposes differently depending on
-- world state. This is the only capability with no process-tree equivalent.
CREATE TABLE template (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    params      jsonb,                          -- JSON Schema for bindings
    description text
);

CREATE TABLE method (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id uuid NOT NULL REFERENCES template(id) ON DELETE CASCADE,
    name        text NOT NULL,
    guard       text,                           -- expression; NULL = always applies
    priority    integer NOT NULL DEFAULT 0,     -- higher wins; first match, no backtracking
    body        jsonb NOT NULL,                 -- subtree spec: nodes, semantics, edges
    UNIQUE (template_id, name)
);

CREATE INDEX method_template_priority_idx ON method (template_id, priority DESC);


-- =============================================================================
-- PLANE 1 — PLAN: work_node
--
-- The single canonical structural entity. Containers and actions share one
-- table (Composite pattern) so rollup, dependencies, scheduling, and templates
-- all operate uniformly.
-- =============================================================================

CREATE TABLE work_node (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_version_id  uuid NOT NULL REFERENCES plan_version(id) ON DELETE CASCADE,
    parent_id        uuid REFERENCES work_node(id) ON DELETE CASCADE,
    sibling_rank     text NOT NULL,             -- lexorank / fractional; ordering among siblings
    name             text NOT NULL,

    -- STRUCTURE ------------------------------------------------------------
    kind             node_kind NOT NULL,
    child_semantics  child_semantics,           -- required iff kind = 'container'

    -- ENTITY BINDING (actions) ---------------------------------------------
    -- Nodes describe what they NEED, not who does it. Resolution happens at
    -- dispatch time. Swapping a person for a model is a capability
    -- registration, not a plan edit.
    req_capabilities text[] NOT NULL DEFAULT '{}',
    req_constraints  text,                      -- e.g. 'entity.reliability > 0.95'
    req_selection    selection_policy NOT NULL DEFAULT 'least_loaded',
    req_candidates   uuid[],                    -- optional narrowing of the pool
    req_quantity     numeric NOT NULL DEFAULT 1,
    req_mode         allocation_mode NOT NULL DEFAULT 'exclusive',

    -- OPERATOR-SPECIFIC ----------------------------------------------------
    guard            text,                      -- child of 'choice'
    loop_spec        jsonb,                     -- {while|until|count|forEach, max_iterations}
    map_spec         jsonb,                     -- {over, concurrency, reducer}
    try_role         try_role,                  -- child of 'try'
    signal_spec      jsonb,                     -- kind='signal': {name, payload_expr}

    -- POLICY (inheritable: resolve by walking up to nearest non-null ancestor)
    retry_policy     jsonb,                     -- {max, backoff, jitter, retry_on[]}
    timeout          interval,
    on_error         error_policy,
    trigger_rule     trigger_rule NOT NULL DEFAULT 'all_success',
    idempotency      jsonb,                     -- {key_expr, effect_scope}
    priority         integer,
    calendar_id      uuid REFERENCES calendar(id),
    scope_vars       jsonb,                     -- variables visible to this subtree

    -- LIFECYCLE ------------------------------------------------------------
    expansion        expansion_state NOT NULL DEFAULT 'primitive',

    -- SCHEDULING -----------------------------------------------------------
    estimate         interval,                  -- point estimate
    estimate_dist    jsonb,                     -- {dist:'pert', optimistic, likely, pessimistic}
    deadline         timestamptz,
    earliest_start   timestamptz,               -- computed by forward pass
    earliest_finish  timestamptz,
    latest_start     timestamptz,               -- computed by backward pass
    latest_finish    timestamptz,
    slack            interval,

    -- PROVENANCE -----------------------------------------------------------
    template_id      uuid REFERENCES template(id),
    method_id        uuid REFERENCES method(id),
    bindings         jsonb,
    stable_key       text,                      -- identity across plan versions

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- I2: leaves have no children and no child semantics
    CONSTRAINT wn_i2_leaf_has_no_semantics
        CHECK (kind = 'container' OR child_semantics IS NULL),
    -- I3: containers must declare their semantics
    CONSTRAINT wn_i3_container_has_semantics
        CHECK (kind <> 'container' OR child_semantics IS NOT NULL),
    -- loop_spec / map_spec belong only to their operator
    CONSTRAINT wn_loop_spec_scope
        CHECK (loop_spec IS NULL OR child_semantics = 'loop'),
    CONSTRAINT wn_map_spec_scope
        CHECK (map_spec IS NULL OR child_semantics = 'map'),
    CONSTRAINT wn_loop_needs_spec
        CHECK (child_semantics <> 'loop' OR loop_spec IS NOT NULL),
    CONSTRAINT wn_map_needs_spec
        CHECK (child_semantics <> 'map'  OR map_spec  IS NOT NULL),
    -- I8: unbounded loops are forbidden at the schema level
    CONSTRAINT wn_i8_loop_bounded
        CHECK (child_semantics <> 'loop'
               OR (loop_spec ? 'max_iterations')),
    CONSTRAINT wn_map_bounded
        CHECK (child_semantics <> 'map'
               OR (map_spec ? 'concurrency')),
    CONSTRAINT wn_signal_spec_scope
        CHECK (signal_spec IS NULL OR kind = 'signal'),
    -- only one of the two estimate forms
    CONSTRAINT wn_estimate_exclusive
        CHECK (estimate IS NULL OR estimate_dist IS NULL),
    -- I4 (partial): rank uniqueness among siblings
    CONSTRAINT wn_i4_rank_unique UNIQUE (parent_id, sibling_rank)
);

CREATE INDEX wn_parent_idx       ON work_node (parent_id, sibling_rank);
CREATE INDEX wn_version_idx      ON work_node (plan_version_id);
CREATE INDEX wn_template_idx     ON work_node (template_id) WHERE template_id IS NOT NULL;
CREATE INDEX wn_capabilities_idx ON work_node USING gin (req_capabilities);
CREATE INDEX wn_stable_key_idx   ON work_node (plan_version_id, stable_key);

-- Root nodes: exactly one per plan_version.
CREATE UNIQUE INDEX wn_one_root_per_version
    ON work_node (plan_version_id)
    WHERE parent_id IS NULL;

ALTER TABLE plan_version
    ADD CONSTRAINT plan_version_root_fk
    FOREIGN KEY (root_node_id) REFERENCES work_node(id) DEFERRABLE INITIALLY DEFERRED;


-- -----------------------------------------------------------------------------
-- Explicit precedence. Control-only ordering: "do this after that, for reasons
-- the data does not capture." Most real dependencies are data edges instead,
-- which generate their own ordering (see I14).
-- -----------------------------------------------------------------------------

CREATE TABLE dependency (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id    uuid NOT NULL REFERENCES work_node(id) ON DELETE CASCADE,
    to_id      uuid NOT NULL REFERENCES work_node(id) ON DELETE CASCADE,
    type       dependency_type NOT NULL DEFAULT 'FS',
    lag        interval NOT NULL DEFAULT '0',   -- negative = lead
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT dep_i6_no_self CHECK (from_id <> to_id),
    UNIQUE (from_id, to_id, type)
);

CREATE INDEX dep_from_idx ON dependency (from_id);
CREATE INDEX dep_to_idx   ON dependency (to_id);


-- =============================================================================
-- PLANE 2 — DATA
--
-- Data flow is first-class, and it subsumes most precedence:
--   a data edge ALWAYS implies a precedence edge (invariant I14).
-- This kills the most common bug class in workflow tools: wiring the data but
-- forgetting the ordering, or reordering tasks and silently breaking a flow.
-- =============================================================================

CREATE TABLE port (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_node_id uuid NOT NULL REFERENCES work_node(id) ON DELETE CASCADE,
    direction    port_direction NOT NULL,
    name         text NOT NULL,
    type         jsonb NOT NULL,                -- JSON Schema
    required     boolean NOT NULL DEFAULT true,
    default_value jsonb,
    reducer      text,                          -- append|merge|sum|max|first|last|ref
    UNIQUE (work_node_id, direction, name)
);

CREATE INDEX port_node_idx ON port (work_node_id, direction);

CREATE TABLE data_edge (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_port_id uuid NOT NULL REFERENCES port(id) ON DELETE CASCADE,
    to_port_id   uuid NOT NULL REFERENCES port(id) ON DELETE CASCADE,
    transform    text,                          -- optional projection expression
    UNIQUE (from_port_id, to_port_id),
    CONSTRAINT data_edge_no_self CHECK (from_port_id <> to_port_id)
);

CREATE INDEX data_edge_from_idx ON data_edge (from_port_id);
CREATE INDEX data_edge_to_idx   ON data_edge (to_port_id);


-- =============================================================================
-- PLANE 3 — RUN
--
-- Plan and run are separate. The plan is a template for execution; the run is
-- what actually happened. Conflating them means you can never re-run, never
-- A/B a plan, and never audit.
-- =============================================================================

CREATE TABLE run (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_version_id uuid NOT NULL REFERENCES plan_version(id),
    state           run_state NOT NULL DEFAULT 'pending',
    version_policy  version_policy NOT NULL DEFAULT 'pinned',
    globals         jsonb NOT NULL DEFAULT '{}',
    correlation_id  text,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX run_state_idx       ON run (state);
CREATE INDEX run_correlation_idx ON run (correlation_id) WHERE correlation_id IS NOT NULL;

-- One row per work_node PER ATTEMPT. Retries, map instances, and loop
-- iterations all produce separate rows. Reusing one row per node destroys
-- history the moment anything retries.
CREATE TABLE execution (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id         uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    work_node_id   uuid NOT NULL REFERENCES work_node(id),
    parent_execution_id uuid REFERENCES execution(id),

    attempt        integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
    map_index      integer,                     -- which map instance
    loop_iteration integer,                     -- which loop pass

    state          lifecycle_state NOT NULL DEFAULT 'pending',
    entity_id      uuid REFERENCES entity(id),  -- resolved at dispatch

    inputs         jsonb,                       -- resolved and snapshotted
    outputs        jsonb,
    error          jsonb,

    effect_key     text,                        -- idempotency: hash(inputs, identity)

    started_at     timestamptz,
    finished_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX exec_attempt_idx
    ON execution (run_id, work_node_id, attempt,
                  COALESCE(map_index, -1), COALESCE(loop_iteration, -1));

CREATE INDEX exec_run_state_idx ON execution (run_id, state);
CREATE INDEX exec_node_idx      ON execution (work_node_id);
CREATE INDEX exec_entity_idx    ON execution (entity_id) WHERE entity_id IS NOT NULL;
-- I15 enforcement aid: an effect_key must be unique per run among successes.
CREATE UNIQUE INDEX exec_effect_key_idx
    ON execution (run_id, effect_key)
    WHERE effect_key IS NOT NULL AND state = 'done';

-- The lease is what makes the entity collapse real. A crashed worker and a
-- person who went on holiday are the same event: the lease lapsed, requeue it.
-- One timeout mechanism, one recovery path, no separate 'wait' node kind.
CREATE TABLE lease (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id uuid NOT NULL REFERENCES execution(id) ON DELETE CASCADE,
    entity_id    uuid NOT NULL REFERENCES entity(id),
    state        lease_state NOT NULL DEFAULT 'held',
    claimed_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    released_at  timestamptz,
    CONSTRAINT lease_expiry_after_claim CHECK (expires_at > claimed_at)
);

-- E4: exactly one active lease per execution.
CREATE UNIQUE INDEX lease_one_active_per_execution
    ON lease (execution_id)
    WHERE state = 'held';

CREATE INDEX lease_expiry_sweep_idx ON lease (expires_at) WHERE state = 'held';

-- Capacity accounting. Renewable entities are leased and released; consumable
-- entities are debited permanently (compensation must explicitly re-credit).
CREATE TABLE allocation (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id uuid NOT NULL REFERENCES execution(id) ON DELETE CASCADE,
    entity_id    uuid NOT NULL REFERENCES entity(id),
    quantity     numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
    mode         allocation_mode NOT NULL DEFAULT 'exclusive',
    from_ts      timestamptz NOT NULL,
    to_ts        timestamptz,
    released     boolean NOT NULL DEFAULT false
);

CREATE INDEX alloc_entity_window_idx ON allocation (entity_id, from_ts, to_ts);

CREATE TABLE checkpoint (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id     uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    seq        bigint NOT NULL,
    snapshot   jsonb NOT NULL,                  -- fully resolvable state
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, seq)
);

-- Append-only. Never UPDATE, never DELETE. Enforced by trigger below.
CREATE TABLE event (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id       uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    seq          bigint NOT NULL,
    type         text NOT NULL,
    work_node_id uuid REFERENCES work_node(id),
    execution_id uuid REFERENCES execution(id),
    payload      jsonb,
    at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, seq)
);

CREATE INDEX event_run_seq_idx ON event (run_id, seq);
CREATE INDEX event_type_idx    ON event (type);


-- =============================================================================
-- TREE FUNCTIONS
-- =============================================================================

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

-- An "atom" is a vertex of the union graph: any leaf, plus loop and map
-- containers (whose bodies are contracted to a single vertex so that repetition
-- does not make the graph cyclic — the same trick structured programming used
-- against goto).
CREATE OR REPLACE FUNCTION wn_is_atom(p_node uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT kind <> 'container' OR child_semantics IN ('loop', 'map')
    FROM work_node WHERE id = p_node;
$$;

-- Entry leaves of a subtree. Under 'sequence' only the first child can start;
-- under every other operator any child may.
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


-- =============================================================================
-- THE UNION GRAPH
--
-- Scheduling and cycle detection NEVER look at the dependency table alone.
-- Edges come from three sources:
--   1. sibling order under 'sequence'
--   2. explicit dependency rows
--   3. every data edge (I14)
--
-- Leaf expansion is NOT optional. Contracting each subtree to one vertex
-- reports false cycles. Counterexample: A = sequence[A1,A2], B = sequence[B1,B2],
-- edges A1->B1 and B2->A2. Contracted you see A->B and B->A, a cycle.
-- Expanded you see the path A1->B1->B2->A2, perfectly acyclic.
-- =============================================================================

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
    ) e

    UNION ALL

    -- (3) I14: every data edge implies precedence
    SELECT wf.plan_version_id, lf.id, ff.id, 'data', '0'::interval
    FROM data_edge de
    JOIN port pf ON pf.id = de.from_port_id
    JOIN port pt ON pt.id = de.to_port_id
    JOIN work_node wf ON wf.id = pf.work_node_id
    JOIN work_node wt ON wt.id = pt.work_node_id
    CROSS JOIN LATERAL wn_last_leaves(wf.id)  lf
    CROSS JOIN LATERAL wn_first_leaves(wt.id) ff
    WHERE wf.id <> wt.id;


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


-- =============================================================================
-- INVARIANT TRIGGERS
-- Constraints that need traversal cannot be CHECK constraints.
-- =============================================================================

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

CREATE TRIGGER dependency_legality
    BEFORE INSERT OR UPDATE ON dependency
    FOR EACH ROW EXECUTE FUNCTION check_dependency_legality();


-- I7: every child of a 'choice' needs a guard.
-- I9: a 'try' needs at least one body, at most one catch, at most one finally.
-- I8: 'loop' and 'map' take exactly one child.
CREATE OR REPLACE FUNCTION check_container_shape()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent uuid; v_sem child_semantics; v_n integer;
BEGIN
    v_parent := COALESCE(NEW.parent_id, OLD.parent_id);
    IF v_parent IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

    SELECT child_semantics INTO v_sem FROM work_node WHERE id = v_parent;

    IF v_sem = 'choice' THEN
        SELECT count(*) INTO v_n FROM work_node
        WHERE parent_id = v_parent AND guard IS NULL;
        IF v_n > 1 THEN
            RAISE EXCEPTION 'I7 violated: choice % has % unguarded children (at most one default allowed)',
                v_parent, v_n;
        END IF;
    ELSIF v_sem IN ('loop', 'map') THEN
        SELECT count(*) INTO v_n FROM work_node WHERE parent_id = v_parent;
        IF v_n > 1 THEN
            RAISE EXCEPTION 'I8 violated: % container % has % children, expected 1',
                v_sem, v_parent, v_n;
        END IF;
    ELSIF v_sem = 'try' THEN
        SELECT count(*) INTO v_n FROM work_node
        WHERE parent_id = v_parent AND try_role IS NULL;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'I9 violated: try % has % children without a try_role', v_parent, v_n;
        END IF;
        SELECT count(*) INTO v_n FROM work_node
        WHERE parent_id = v_parent AND try_role = 'catch';
        IF v_n > 1 THEN
            RAISE EXCEPTION 'I9 violated: try % has % catch children, at most 1 allowed', v_parent, v_n;
        END IF;
        SELECT count(*) INTO v_n FROM work_node
        WHERE parent_id = v_parent AND try_role = 'finally';
        IF v_n > 1 THEN
            RAISE EXCEPTION 'I9 violated: try % has % finally children, at most 1 allowed', v_parent, v_n;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE CONSTRAINT TRIGGER container_shape
    AFTER INSERT OR UPDATE OR DELETE ON work_node
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_container_shape();


-- I12: a port with more than one incoming data edge MUST declare a reducer.
-- Without it, concurrent writes from parallel or map branches clobber each
-- other nondeterministically. This is a plan-time error, not a runtime surprise.
CREATE OR REPLACE FUNCTION check_port_reducer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_n integer; v_reducer text;
BEGIN
    SELECT count(*) INTO v_n FROM data_edge WHERE to_port_id = NEW.to_port_id;
    IF v_n > 1 THEN
        SELECT reducer INTO v_reducer FROM port WHERE id = NEW.to_port_id;
        IF v_reducer IS NULL THEN
            RAISE EXCEPTION
                'I12 violated: port % has % incoming data edges but no reducer',
                NEW.to_port_id, v_n;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER port_reducer_required
    AFTER INSERT OR UPDATE ON data_edge
    FOR EACH ROW EXECUTE FUNCTION check_port_reducer();


-- I12 mirror: removing the reducer from a port that already has >=2 incoming
-- data edges must be caught too. The original trigger fires on data_edge
-- insert/update only, so clearing a port's reducer behind its fan-in would
-- otherwise slip through.
CREATE OR REPLACE FUNCTION check_port_reducer_on_port_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
    IF NEW.reducer IS NULL AND NEW.reducer IS DISTINCT FROM OLD.reducer THEN
        SELECT count(*) INTO v_n FROM data_edge WHERE to_port_id = NEW.id;
        IF v_n > 1 THEN
            RAISE EXCEPTION
                'I12 violated: port % has % incoming data edges but no reducer',
                NEW.id, v_n;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER port_reducer_required_on_port_update
    BEFORE UPDATE OF reducer ON port
    FOR EACH ROW EXECUTE FUNCTION check_port_reducer_on_port_update();


-- I16: the event log is append-only.
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER event_append_only
    BEFORE UPDATE OR DELETE ON event
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- E7: the entity call graph must be acyclic. With plans-as-entities you now have
-- a SECOND graph needing cycle detection, separate from the union graph inside
-- each plan. Easy to miss.
CREATE OR REPLACE FUNCTION detect_plan_call_cycles()
RETURNS TABLE (plan_id uuid, path uuid[])
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE calls AS (
        SELECT DISTINCT pv.plan_id AS caller, e.plan_id AS callee
        FROM work_node w
        JOIN plan_version pv ON pv.id = w.plan_version_id
        JOIN entity e ON e.id = ANY(w.req_candidates)
        WHERE e.plan_id IS NOT NULL
    ),
    walk AS (
        SELECT c.caller AS root, c.callee AS node,
               ARRAY[c.caller, c.callee] AS path, false AS cyc
        FROM calls c
        UNION ALL
        SELECT w.root, c.callee, w.path || c.callee, c.callee = ANY(w.path)
        FROM walk w JOIN calls c ON c.caller = w.node
        WHERE NOT w.cyc AND array_length(w.path, 1) < 100
    )
    SELECT root, path FROM walk WHERE cyc;
$$;


-- =============================================================================
-- ROLLUP
--
-- Duration per operator:
--   sequence  Σ children        parallel  max children
--   choice    selected child    race      min children
--   map       max instances     loop      body × expected iterations
--   try       body (+ catch on the failure path)
--   freeform  longest path through children in the union graph
-- =============================================================================

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


-- =============================================================================
-- OPERATIONAL VIEWS
-- =============================================================================

-- Policy inheritance: resolve by walking up to the nearest ancestor that sets
-- the field. Configure once at the root, override at three nodes, not at four
-- hundred leaves.
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

-- Leases about to lapse. The sweeper reads this: expiry is the universal
-- timeout, covering crashed workers and absent humans identically.
CREATE OR REPLACE VIEW lease_expiring AS
    SELECT l.*, e.run_id, e.work_node_id, en.name AS entity_name, en.cancellable
    FROM lease l
    JOIN execution e ON e.id = l.execution_id
    JOIN entity en   ON en.id = l.entity_id
    WHERE l.state = 'held' AND l.expires_at <= now();

-- Entities currently over capacity.
CREATE OR REPLACE VIEW entity_load AS
    SELECT en.id, en.name, en.concurrency,
           count(*) FILTER (WHERE l.state = 'held') AS active,
           en.concurrency - count(*) FILTER (WHERE l.state = 'held') AS headroom
    FROM entity en
    LEFT JOIN lease l ON l.entity_id = en.id
    GROUP BY en.id, en.name, en.concurrency;

-- Orphaned work: race losers and cancellations against entities that cannot be
-- stopped. E6 — do not paper over this; it still consumes capacity and may still
-- produce side effects.
CREATE OR REPLACE VIEW orphaned_work AS
    SELECT e.id AS execution_id, e.run_id, e.work_node_id, en.name AS entity_name
    FROM execution e
    JOIN entity en ON en.id = e.entity_id
    WHERE e.state = 'cancelled' AND en.cancellable = 'never';

COMMIT;

-- =============================================================================
-- INVARIANT SUMMARY — where each is enforced
--
--  I1  parent chain acyclic ................... application (FK + traversal)
--  I2  leaf has no child_semantics ............ CHECK wn_i2_leaf_has_no_semantics
--  I3  container has child_semantics .......... CHECK wn_i3_container_has_semantics
--  I4  (parent_id, sibling_rank) unique ....... UNIQUE wn_i4_rank_unique
--  I5  dependency legal iff LCA = freeform .... TRIGGER dependency_legality
--  I6  no self / ancestor dependency .......... CHECK + TRIGGER dependency_legality
--  I7  choice children guarded ................ TRIGGER container_shape
--  I8  loop/map exactly one child, bounded .... TRIGGER container_shape + CHECK
--  I9  try shape .............................. TRIGGER container_shape
--  I10 union graph acyclic .................... FUNCTION detect_cycles (call on edit)
--  I11 data edge type compatible .............. application (JSON Schema check)
--  I12 multi-source port has reducer .......... TRIGGER port_reducer_required
--  I13 required input ports bound ............. application (pre-run validation)
--  I14 data edge implies precedence ........... VIEW union_edge, branch 3
--  I15 effectful node has idempotency key ..... UNIQUE exec_effect_key_idx
--  I16 execution/event append-only ............ TRIGGER event_append_only
--  I17 run references one plan_version ........ FK run.plan_version_id
--  E1  requirements resolve to >=1 entity ..... application (dispatch time)
--  E2  node input satisfies entity.accepts .... application (dispatch time)
--  E3  entity.produces satisfies port types ... application (dispatch time)
--  E4  one active lease per execution ......... UNIQUE lease_one_active_per_execution
--  E5  lease expiry -> failed(timeout) ........ VIEW lease_expiring + sweeper
--  E6  cancellable=never tracked .............. VIEW orphaned_work
--  E7  entity call graph acyclic .............. FUNCTION detect_plan_call_cycles
--  E8  consumable allocation irreversible ..... CHECK entity_capacity_not_overdrawn
-- =============================================================================
