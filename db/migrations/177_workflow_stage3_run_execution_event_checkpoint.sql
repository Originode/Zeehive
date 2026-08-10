-- HIERARCHICAL WORKFLOW MODEL — PLANE 3 (run · execution · checkpoint · event) — DURABILITY
--
-- Stage 3 of the serial rollout (docs/hierarchical-workflow-adoption.md §5). On top of the
-- stage-1 tables (plan/plan_version/work_node/dependency, union graph, cycle detection) this
-- migration delivers the DURABILITY plane: a run (one instantiation of a plan_version), the
-- per-attempt execution rows, the append-only event log, and checkpoints for replay.
--
-- DESIGN OF RECORD: docs/hierarchical-workflow-schema.sql (PLANE 3). Where this file departs
-- from it, the departure is a stage boundary, and it is named below:
--
--   • entity_id on execution is a PLAIN uuid, NOT a FK — the cross-cutting `entity` table
--     (stage 5, "entities + leases") does not exist yet. The 172 precedent: work_node's
--     calendar_id was a plain uuid until the calendar FK landed. Stage 5 adds the FK.
--
--   • lease/allocation are stage 5 and deliberately NOT here — both reference entity().
--
--   • version_policy is created PINNED-ONLY (the enum carries just 'pinned'). 'migrate' and
--     'restart' land with the plan-version-migration stage; a later stage only ALTER TYPE ...
--     ADD VALUE instead of touching the run table. This is the stage-1 precedent for capping
--     an enum to the stage's needs (167 capped child_semantics to sequence/parallel/freeform).
--
--   • trigger_rule is NOT re-created — stage 1 already wired the enum on work_node. Only the
--     all_success behaviour needs to execute at this stage; the run plane is silent on it.
--
--   • execution is NOT literally append-only (its rows are UPDATEd as an attempt moves through
--     the lifecycle: state, outputs, error, started_at/finished_at). What the DDL's I16 summary
--     means by "execution/event append-only" is delivered as: ONE ROW PER ATTEMPT (the unique
--     exec_attempt_idx — a retry inserts a new row, it never updates the old one) and the event
--     log LITERALLY append-only (UPDATE/DELETE forbidden by trigger). Only `event` gets the
--     forbid_mutation trigger, exactly as the DDL writes it.
--
-- FORWARD-ONLY: every object is created idempotently (CREATE TABLE IF NOT EXISTS / CREATE OR
-- REPLACE / the DO-block duplicate_object pattern). The runner skips applied files by filename,
-- so a re-run is a no-op. The DOWN thinking: DROP TRIGGER event_append_only, DROP FUNCTION
-- forbid_mutation, then DROP TABLE event, checkpoint, execution, run (children first), then the
-- enums in reverse order. Never run that in prod — forward-only.

-- ── stage-3 enum types ────────────────────────────────────────────────────────
-- lifecycle_state: the per-node runtime lifecycle (design §8.4). 'compensated' is a DISTINCT
-- terminal state — a partially rolled-back subtree must not read as either done or failed.
-- 'blocked' is terminal for requirements that can never be satisfied (no matching entity).
DO $$ BEGIN
  CREATE TYPE lifecycle_state AS ENUM (
    'pending',    -- not yet eligible
    'ready',      -- predecessors satisfied, guard true, entity allocatable
    'running',    -- lease held, work in flight
    'waiting',    -- lease held, blocked on external signal/timer/human
    'done',
    'failed',
    'skipped',    -- choice branch not selected, or upstream skip propagated
    'cancelled',  -- race loser, or explicit cancellation
    'blocked',    -- requirements unsatisfiable (no matching entity)
    'compensated' -- completed then rolled back; distinct from done and failed
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- run_state: the run-level lifecycle (the aggregate of its executions).
DO $$ BEGIN
  CREATE TYPE run_state AS ENUM (
    'pending', 'running', 'paused', 'succeeded',
    'failed', 'cancelled', 'compensated'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- What happens to an in-flight run when its plan is edited. PINNED-ONLY at this stage:
-- 'migrate' and 'restart' land with the plan-version-migration stage as ALTER TYPE ADD VALUE.
DO $$ BEGIN
  CREATE TYPE version_policy AS ENUM ('pinned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── PLANE 3 — RUN ─────────────────────────────────────────────────────────────
-- One run is one instantiation of a plan_version. The plan is a template; the run is what
-- actually happened. Conflating them means you can never re-run, never A/B a plan, never audit.
CREATE TABLE IF NOT EXISTS run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id uuid NOT NULL REFERENCES plan_version(id),
  state           run_state NOT NULL DEFAULT 'pending',
  version_policy  version_policy NOT NULL DEFAULT 'pinned',
  globals         jsonb NOT NULL DEFAULT '{}',   -- variables visible to every execution
  correlation_id  text,                          -- external tracing id, e.g. a ticket
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_state_idx       ON run (state);
CREATE INDEX IF NOT EXISTS run_correlation_idx ON run (correlation_id) WHERE correlation_id IS NOT NULL;

-- ── PLANE 3 — EXECUTION ───────────────────────────────────────────────────────
-- One row per work_node PER ATTEMPT (design §8.1). Retries, map instances and loop iterations
-- each get their own row; reusing one row per node destroys history the moment anything retries.
-- The UNIQUE-with-COALESCE is a unique INDEX, not a table constraint — Postgres rejects
-- expressions in constraints (adoption §4.1). A retry therefore INSERTs attempt 2; it can never
-- UPDATE the attempt-1 row into a collision.
CREATE TABLE IF NOT EXISTS execution (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  work_node_id        uuid NOT NULL REFERENCES work_node(id),
  parent_execution_id uuid REFERENCES execution(id),

  attempt            integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  map_index          integer,                    -- which map instance
  loop_iteration     integer,                    -- which loop pass

  state              lifecycle_state NOT NULL DEFAULT 'pending',
  entity_id          uuid,                       -- FK to entity() lands with stage 5 (entities)

  inputs             jsonb,                      -- resolved and snapshotted
  outputs            jsonb,
  error              jsonb,

  effect_key         text,                       -- idempotency: hash(inputs, identity)

  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ONE ROW PER ATTEMPT: unique across (run, node, attempt, map_index, loop_iteration). NULL
-- map/loop coalesce to -1 so a plain retry and a map instance cannot collide.
CREATE UNIQUE INDEX IF NOT EXISTS exec_attempt_idx
  ON execution (run_id, work_node_id, attempt,
                COALESCE(map_index, -1), COALESCE(loop_iteration, -1));

CREATE INDEX IF NOT EXISTS exec_run_state_idx ON execution (run_id, state);
CREATE INDEX IF NOT EXISTS exec_node_idx      ON execution (work_node_id);
CREATE INDEX IF NOT EXISTS exec_entity_idx    ON execution (entity_id) WHERE entity_id IS NOT NULL;

-- I15 enforcement aid (design §8.2): an effect_key must be unique per run among successes, so
-- a retried effectful node either replays the recorded output or fails on the key collision.
CREATE UNIQUE INDEX IF NOT EXISTS exec_effect_key_idx
  ON execution (run_id, effect_key)
  WHERE effect_key IS NOT NULL AND state = 'done';

-- ── PLANE 3 — CHECKPOINT ──────────────────────────────────────────────────────
-- Cadence snapshots for resume-after-crash / time-travel / fork-from-step-N (design §8.3).
-- The event log fills the gaps between snapshots.
CREATE TABLE IF NOT EXISTS checkpoint (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq        bigint NOT NULL,                    -- monotone per run
  snapshot   jsonb NOT NULL,                     -- fully resolvable state
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkpoint_run_seq_unique UNIQUE (run_id, seq)
);

-- ── PLANE 3 — EVENT ───────────────────────────────────────────────────────────
-- The append-only event log. Never UPDATE, never DELETE — enforced by the trigger below (I16).
CREATE TABLE IF NOT EXISTS event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq          bigint NOT NULL,                  -- monotone per run
  type         text NOT NULL,
  work_node_id uuid REFERENCES work_node(id),
  execution_id uuid REFERENCES execution(id),
  payload      jsonb,
  at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_run_seq_unique UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS event_run_seq_idx ON event (run_id, seq);
CREATE INDEX IF NOT EXISTS event_type_idx    ON event (type);

-- ── I16: the event log is append-only ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER event_append_only
    BEFORE UPDATE OR DELETE ON event
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE run IS
  'PLANE 3: one instantiation of a plan_version. The plan is a template; the run is what actually happened.';
COMMENT ON TABLE execution IS
  'PLANE 3: one row per work_node PER ATTEMPT (design §8.1). A retry INSERTs a new attempt row; it never updates the old one. exec_attempt_idx is a unique INDEX (Postgres forbids expressions in constraints).';
COMMENT ON TABLE event IS
  'PLANE 3: append-only event log (I16). UPDATE/DELETE raise via the event_append_only trigger.';
COMMENT ON TABLE checkpoint IS
  'PLANE 3: cadence snapshots for resume-after-crash / time-travel / fork-from-step-N.';
