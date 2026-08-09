-- STAGE 1 RECONCILE — converge work_node (and two constraint names) to the canonical
-- full-DDL WIDE shape.
--
-- CONTEXT: two independent stage-1 implementations of the hierarchical workflow model
-- both landed on main. Both are guarded/idempotent, so apply-order decides the winner:
--   • a FRESH database runs 165/166 first → work_node is WIDE (the reviewed
--     docs/hierarchical-workflow-schema.sql column set, incl. the stage-1 CHECK
--     wn_stage1_child_semantics and the loop/map shape checks);
--   • PROD ran 167/172/173/174/175 first → work_node is NARROW (stage-1 columns only,
--     no later-stage columns, no stage-1 CHECK, and the dependency/plan_version UNIQUE
--     constraints carry the auto-generated narrow names).
--
-- CANONICAL = the WIDE shape, and convergence toward it is purely ADDITIVE: the narrow
-- work_node gains the full column set (all of them nullable or defaulted, so existing
-- rows are untouched), the missing CHECK constraints, the calendar FK that 166 declares
-- inline, the two GIN/btree indexes 166 adds, and the child_semantics enum gains the
-- five stage-4+/9 values the full design carries. Nothing is dropped anywhere.
--
-- This file is a NO-OP on a database that already ran 165/166 first (every object it
-- adds already exists; ADD COLUMN IF NOT EXISTS / ADD CONSTRAINT in a duplicate_object
-- DO-block / CREATE INDEX IF NOT EXISTS / ADD VALUE IF NOT EXISTS all no-op), and it is
-- the CONVERGENCE that turns a narrow-first database into exactly the same shape — a
-- pg_dump of the two paths after this migration must be identical.
--
-- Alignment decisions (see the reconcile card, step 1):
--   • calendar_id — 166 declares `REFERENCES calendar(id)` inline; 172 declares a plain
--     uuid with the FK deferred to a later stage. Aligned by ADD CONSTRAINT with the
--     SAME name postgres would generate for the inline FK (work_node_calendar_id_fkey),
--     so the schema dump matches the fresh path.
--   • child_semantics — 165 creates the full 8-value enum; 167 creates only
--     sequence/parallel/freeform. Aligned with ALTER TYPE ... ADD VALUE, placed BEFORE
--     'freeform' so the enum order matches the fresh path byte-for-byte. (167's narrow
--     enum exists only on the narrow-first path; ADD VALUE IF NOT EXISTS is a no-op on
--     the fresh path.)
--   • dependency UNIQUE name — dependency_from_to_type_unique (166) vs the auto-generated
--     dependency_from_id_to_id_type_key (172). Aligned with RENAME CONSTRAINT (no drop).
--   • plan_version UNIQUE name — plan_version_plan_version_unique (165) vs
--     plan_version_plan_id_version_key (167). Aligned with RENAME CONSTRAINT (no drop).
--
-- FORWARD-ONLY: every statement is idempotent, and a re-run of this file (or a second
-- migrate pass over a database that already has it) is a clean no-op.
--
-- Types referenced below (selection_policy, allocation_mode, try_role, expansion_state,
-- calendar) are all created by 165, which applies before this file on BOTH paths, so no
-- dependency is introduced on the narrow-first path.

-- ── child_semantics: add the five stage-4+/9 values the full design carries ────────
-- Inserted BEFORE 'freeform' so the final enum order equals 165's: sequence, parallel,
-- choice, race, map, loop, try, freeform. IF NOT EXISTS keeps this a no-op on a database
-- where 165 already created the full enum.
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'choice' BEFORE 'freeform';
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'race'   BEFORE 'freeform';
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'map'    BEFORE 'freeform';
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'loop'   BEFORE 'freeform';
ALTER TYPE child_semantics ADD VALUE IF NOT EXISTS 'try'    BEFORE 'freeform';

-- ── work_node: add every WIDE column the NARROW shape lacks ────────────────────────
-- Entity-binding block (actions describe what they NEED, not who does it).
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS req_capabilities text[]    NOT NULL DEFAULT '{}';
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS req_constraints  text;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS req_selection    selection_policy NOT NULL DEFAULT 'least_loaded';
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS req_candidates   uuid[];
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS req_quantity     numeric NOT NULL DEFAULT 1;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS req_mode         allocation_mode NOT NULL DEFAULT 'exclusive';
-- Operator-specific (inert today under wn_stage1_child_semantics — stage 4+/9).
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS guard            text;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS loop_spec        jsonb;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS map_spec         jsonb;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS try_role         try_role;
-- Policy block.
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS idempotency      jsonb;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS scope_vars       jsonb;
-- Lifecycle.
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS expansion        expansion_state NOT NULL DEFAULT 'primitive';
-- Scheduling.
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS deadline         timestamptz;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS earliest_start   timestamptz;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS earliest_finish  timestamptz;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS latest_start     timestamptz;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS latest_finish    timestamptz;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS slack            interval;
-- Provenance.
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS bindings         jsonb;
ALTER TABLE work_node ADD COLUMN IF NOT EXISTS stable_key       text;

-- ── work_node: missing CHECK constraints (guarded — no-op if already present) ───────
-- The loop/map shape checks (wn_loop_spec_scope / wn_map_spec_scope /
-- wn_loop_needs_spec / wn_map_needs_spec / wn_i8_loop_bounded / wn_map_bounded) are
-- vacuous today because wn_stage1_child_semantics forbids loop/map; they exist so the
-- schema dump matches 166 and so stage 4+/9 unlocks by DROPping one constraint.
DO $$ BEGIN
  ALTER TABLE work_node ADD CONSTRAINT wn_loop_spec_scope
    CHECK (loop_spec IS NULL OR child_semantics = 'loop');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE work_node ADD CONSTRAINT wn_map_spec_scope
    CHECK (map_spec IS NULL OR child_semantics = 'map');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE work_node ADD CONSTRAINT wn_loop_needs_spec
    CHECK (child_semantics <> 'loop' OR loop_spec IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE work_node ADD CONSTRAINT wn_map_needs_spec
    CHECK (child_semantics <> 'map' OR map_spec IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE work_node ADD CONSTRAINT wn_i8_loop_bounded
    CHECK (child_semantics <> 'loop' OR (loop_spec ? 'max_iterations'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE work_node ADD CONSTRAINT wn_map_bounded
    CHECK (child_semantics <> 'map' OR (map_spec ? 'concurrency'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- STAGE-1 WELD: child_semantics may only be sequence/parallel/freeform today. On a
-- narrow-first database this also makes the newly-added enum values (choice/race/map/
-- loop/try) schema-refused exactly as they are on the fresh path. A later stage DROPs
-- this one constraint and the operators unlock.
DO $$ BEGIN
  ALTER TABLE work_node ADD CONSTRAINT wn_stage1_child_semantics
    CHECK (child_semantics IS NULL OR child_semantics IN ('sequence', 'parallel', 'freeform'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── work_node: the calendar FK the WIDE shape declares inline ───────────────────────
-- Aligned under the auto-generated name so the schema dump matches 166.
DO $$ BEGIN
  ALTER TABLE work_node
    ADD CONSTRAINT work_node_calendar_id_fkey
    FOREIGN KEY (calendar_id) REFERENCES calendar(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── work_node: the two indexes 166 adds that the narrow shape never created ─────────
CREATE INDEX IF NOT EXISTS wn_capabilities_idx ON work_node USING gin (req_capabilities);
CREATE INDEX IF NOT EXISTS wn_stable_key_idx   ON work_node (plan_version_id, stable_key);

-- ── constraint-name alignment (RENAME is a rename, not a drop) ─────────────────────
-- The narrow set created these UNIQUE constraints unnamed, so postgres auto-generated
-- *_key names; the wide set named them. Both enforce the same uniqueness; rename the
-- narrow name to the canonical one so the two paths dump identically.
DO $$ BEGIN
  ALTER TABLE dependency RENAME CONSTRAINT dependency_from_id_to_id_type_key TO dependency_from_to_type_unique;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE plan_version RENAME CONSTRAINT plan_version_plan_id_version_key TO plan_version_plan_version_unique;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
