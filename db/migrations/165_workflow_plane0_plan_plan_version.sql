-- HIERARCHICAL WORKFLOW MODEL — PLANE 0 (plan · plan_version) + shared types + calendar
--
-- Stage 1 of the serial rollout (docs/hierarchical-workflow-adoption.md §5). This file is
-- the FIRST half of the workflow model's first real migration: the shared enum types every
-- plane uses, the cross-cutting `calendar` lookup work_node.calendar_id points at, and the
-- PLANE 0 definition tables. The PLANE 1 tables (work_node, dependency) and the union graph
-- land in 166.
--
-- DESIGN OF RECORD: docs/hierarchical-workflow-schema.sql (stage A loaded and exercised it).
-- Where this file departs from it, the departure is a ZEEHIVE weld or a stage boundary, and
-- it is named below:
--
--   • plan.project_id — ZEEHIVE TENANCY WELD (adoption §2): a plan binds to a zeehive
--     project at the ROOT. The general schema is silent on tenancy; ZEEHIVE resolves it by
--     this single column. work_node deliberately has NO project_id — descendants inherit the
--     binding lexically, the same way wn_effective_policy() resolves inherited policy.
--
--   • child_semantics is created with the FULL design enum (sequence/parallel/choice/race/
--     map/loop/try/freeform) but work_node constrains the COLUMN to sequence/parallel/freeform
--     for this stage (constraint wn_stage1_child_semantics in 166). choice/race/map/loop/try
--     are stage 4+/9; the enum values already exist so a later stage only DROPs the stage-1
--     column constraint instead of ALTER TYPE.
--
--   • The DDL's cross-cutting `entity`/`entity_member` are stage 5 and deliberately NOT here.
--     `calendar` IS here only because work_node.calendar_id references it.
--
--   • template/method (plane 0, "templates, versioning") are stage 9–14 and NOT here;
--     166's work_node therefore omits template_id/method_id until they land.
--
-- FORWARD-ONLY: each object is created idempotently where postgres allows (IF NOT EXISTS /
-- CREATE OR REPLACE / the DO-block duplicate_object pattern the repo already uses). The
-- migration runner skips applied files by filename, so a re-run is a no-op; the DOWN thinking
-- is: DROP the PLANE 1 file (166) first, then DROP plan_version, plan, calendar and the enum
-- types in reverse order of creation. Never run that in prod — forward-only.

-- ── shared enum types ──────────────────────────────────────────────────────────
-- node_kind: a work_node is a container (has children), an action (assigned to an entity),
-- or a signal (emits an event other runs can wait on). No 'wait' and no 'subprocess' kind:
-- waiting is a long lease held by a pull entity; a subprocess is an action bound to a
-- plan-backed entity.
DO $$ BEGIN
  CREATE TYPE node_kind AS ENUM ('container', 'action', 'signal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- How a container's children relate to each other. This single field carries the ordering
-- semantics, the completion rule, the duration rollup formula, and whether explicit
-- dependencies are legal inside. FULL design enum; 166's stage-1 column CHECK restricts use.
DO $$ BEGIN
  CREATE TYPE child_semantics AS ENUM (
    'sequence',   -- total order by sibling_rank; completes when all done
    'parallel',   -- unordered, concurrent, static width; all done
    'choice',     -- exactly one child by guard; others skipped      (stage 4+)
    'race',       -- all start, first to finish wins; others cancelled (stage 9+)
    'map',        -- dynamic fan-out, one instance per item in map_spec.over (stage 9+)
    'loop',       -- one child, repeated per loop_spec                (stage 4+)
    'try',        -- error boundary; children tagged by try_role       (stage 4+)
    'freeform'    -- partial order defined by explicit dependency rows
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- When this file runs on a database where the sibling stage-1 set (167) created
-- child_semantics first, the enum exists with only sequence/parallel/freeform and the
-- CREATE TYPE above is a no-op. Bring it to the full design set here — this migration is
-- the enum's home, and the values must be COMMITTED before 176 adds the loop/map CHECK
-- constraints that reference them (PostgreSQL forbids using a new enum value in the same
-- transaction that added it). On a fresh database the values already exist, so each of
-- these is a no-op. Placing each BEFORE 'freeform' keeps the final order identical to the
-- CREATE TYPE above on both paths.
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'choice' BEFORE 'freeform';
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'race'   BEFORE 'freeform';
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'map'    BEFORE 'freeform';
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'loop'   BEFORE 'freeform';
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'try'    BEFORE 'freeform';

DO $$ BEGIN
  CREATE TYPE try_role AS ENUM ('body', 'catch', 'finally', 'compensate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE expansion_state AS ENUM (
    'primitive',    -- no further decomposition
    'unexpanded',   -- template bound, not yet expanded
    'expanded',     -- children materialised
    'stale'         -- guard that selected the method is no longer true
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- What a node does when predecessors did not all succeed.
DO $$ BEGIN
  CREATE TYPE trigger_rule AS ENUM (
    'all_success',  -- default; blocks on skipped or failed predecessors
    'none_failed',  -- runs if predecessors are done or skipped, not failed
    'all_done',     -- runs regardless of predecessor outcome
    'one_success'   -- runs as soon as any predecessor succeeds
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE error_policy AS ENUM (
    'fail',         -- propagate failure upward
    'retry',        -- per retry_policy
    'catch',        -- hand to the nearest enclosing try/catch
    'skip',         -- mark skipped and continue
    'compensate',   -- trigger saga rollback of the enclosing try
    'escalate'      -- reassign to an entity with escalation capability
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Classic precedence link types, as in CPM / MS Project.
DO $$ BEGIN
  CREATE TYPE dependency_type AS ENUM (
    'FS',  -- finish-to-start  (default)
    'SS',  -- start-to-start
    'FF',  -- finish-to-finish
    'SF'   -- start-to-finish
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE selection_policy AS ENUM (
    'cheapest', 'fastest', 'most_reliable',
    'round_robin', 'least_loaded', 'explicit'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE allocation_mode AS ENUM ('exclusive', 'shared');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── cross-cutting: calendar ────────────────────────────────────────────────────
-- Small lookup table work_node.calendar_id references. The entity plane's `entity` and
-- `entity_member` tables (which also live in the DDL's cross-cutting section) are stage 5.
CREATE TABLE IF NOT EXISTS calendar (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',
  working_hours jsonb NOT NULL,               -- [{dow:1, from:'09:00', to:'17:00'}, ...]
  holidays      date[] NOT NULL DEFAULT '{}'
);

-- ── PLANE 0 — DEFINITION ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- tenancy lookups always start at the project; this is the only project_id on the plane
CREATE INDEX IF NOT EXISTS plan_project_idx ON plan (project_id);

CREATE TABLE IF NOT EXISTS plan_version (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  version            integer NOT NULL,
  published          boolean NOT NULL DEFAULT false,
  root_node_id       uuid,                          -- FK added after work_node exists (166)
  diff_from_previous jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_version_plan_version_unique UNIQUE (plan_id, version)
);

COMMENT ON TABLE plan IS
  'PLANE 0 definition: a version-controlled workflow. ZEEHIVE weld: binds to a project (tenancy at the root; work_node inherits by tree, never by a project_id column).';
COMMENT ON TABLE plan_version IS
  'One immutable snapshot of a plan. root_node_id is the single root work_node of the version (added in 166, FK deferred).';
COMMENT ON TABLE calendar IS
  'Working-hours/calendar lookup for work_node.calendar_id (policy inheritance via wn_effective_policy).';
