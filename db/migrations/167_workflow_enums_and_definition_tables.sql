-- HIERARCHICAL WORKFLOW MODEL — PLANE 0 (DEFINITION): enums, plan, plan_version.
--
-- First real migrations of the hierarchical workflow model
-- (docs/hierarchical-workflow-model.md + the corrected DDL in
-- docs/hierarchical-workflow-schema.sql). Stage 1 delivers the DEFINITION and
-- PLAN planes only: plan/plan_version/work_node/dependency, the tree functions,
-- the union graph, leaf-expanded cycle detection, the I5/I6 dependency-legality
-- trigger, wn_effective_policy and wn_duration. Ports/data (PLANE 2),
-- entities/leases and run/execution/event (PLANE 3) arrive in later stages.
--
-- TENANCY WELD (docs/hierarchical-workflow-adoption.md §2): a plan binds to a
-- ZEEHIVE project at the root — `plan.project_id`. Descendants (work_node rows)
-- inherit the binding lexically, exactly the way wn_effective_policy() resolves
-- retry/timeout, so there is deliberately NO project_id column on work_node.
--
-- SCOPE OF child_semantics: ONLY 'sequence', 'parallel' and 'freeform' exist at
-- this stage. 'choice'/'race'/'map'/'loop'/'try' are stage 4+; they arrive as
-- ALTER TYPE ... ADD VALUE together with the columns and triggers that enforce
-- their shape. Capping the enum now makes "sequence/parallel/freeform only" a
-- schema-level fact rather than a convention.
--
-- Idempotent, additive, forward-only.
DO $$ BEGIN
  CREATE TYPE node_kind AS ENUM ('container', 'action', 'signal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE child_semantics AS ENUM ('sequence', 'parallel', 'freeform');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE dependency_type AS ENUM ('FS', 'SS', 'FF', 'SF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trigger_rule AS ENUM ('all_success', 'none_failed', 'all_done', 'one_success');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE error_policy AS ENUM ('fail', 'retry', 'catch', 'skip', 'compensate', 'escalate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── PLAN ─────────────────────────────────────────────────────────────────────
-- The immutable definition: a named workflow bound to exactly one ZEEHIVE
-- project (the tenancy weld). plan_version rows below it are the mutable,
-- versioned snapshots; work_node rows hang off those.
CREATE TABLE IF NOT EXISTS plan (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_project_idx ON plan (project_id);

-- ── PLAN_VERSION ─────────────────────────────────────────────────────────────
-- One versioned snapshot of a plan. `published` flips to true when the version
-- is frozen; `root_node_id` is the single root work_node of that version (FK
-- added once work_node exists, DEFERRABLE so the two tables can reference each
-- other). diff_from_previous records what changed versus the prior version.
CREATE TABLE IF NOT EXISTS plan_version (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           uuid NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  version           integer NOT NULL,
  published         boolean NOT NULL DEFAULT false,
  root_node_id      uuid,
  diff_from_previous jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

CREATE INDEX IF NOT EXISTS plan_version_plan_idx ON plan_version (plan_id, version);
