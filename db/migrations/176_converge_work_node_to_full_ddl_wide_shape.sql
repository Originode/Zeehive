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
-- inline, and the two GIN/btree indexes 166 adds. Nothing is dropped anywhere.
--
-- (The child_semantics enum values the full design carries — choice/race/map/loop/try —
-- are added by 165, not here: PostgreSQL forbids using a new enum value in the same
-- transaction that added it, and the loop/map CHECK constraints below reference those
-- values, so the ADD VALUEs must commit in 165's transaction before this file runs.)
--
-- This file is a NO-OP on a database that already ran 165/166 first (every object it
-- adds already exists; ADD COLUMN IF NOT EXISTS / ADD CONSTRAINT in a duplicate_object
-- DO-block / CREATE INDEX IF NOT EXISTS all no-op), and it is the CONVERGENCE that turns
-- a narrow-first database into exactly the same shape — a pg_dump of the two paths after
-- this migration must be identical.
--
-- Alignment decisions (see the reconcile card, step 1):
--   • calendar_id — 166 declares `REFERENCES calendar(id)` inline; 172 declares a plain
--     uuid with the FK deferred to a later stage. Aligned by ADD CONSTRAINT with the
--     SAME name postgres would generate for the inline FK (work_node_calendar_id_fkey),
--     so the schema dump matches the fresh path.
--   • child_semantics — 165 creates the full 8-value enum on every path (its CREATE TYPE
--     on a narrow-first database is a no-op, so 165 also carries the ADD VALUE IF NOT
--     EXISTS statements that complete the enum); 167 created only sequence/parallel/
--     freeform. This file's loop/map CHECK constraints therefore reference values that
--     were committed by 165.
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

-- ── canonical function bodies (CREATE OR REPLACE — the last writer wins) ─────────────
-- The two stage-1 sets define wn_is_atom, wn_first_leaves and wn_duration differently:
-- 166 carries the full-design bodies (loop/map/try-aware); 173/175 carry the stage-1-only
-- bodies. Which one survives depends on apply order — on a fresh database 173/175 run
-- AFTER 166 and overwrite it, on a narrow-first database 166 runs AFTER 173/175 and
-- overwrites them. This file is the LAST migration on BOTH paths, so it re-asserts the
-- canonical (full-design) bodies and the two paths dump identically. These are the
-- reviewed docs/hierarchical-workflow-schema.sql definitions; 166's versions verbatim
-- (wn_is_atom uses child_semantics::text so it parses even before 165's ADD VALUEs commit).
CREATE OR REPLACE FUNCTION wn_is_atom(p_node uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT kind <> 'container' OR child_semantics::text IN ('loop', 'map')
    FROM work_node WHERE id = p_node;
$$;

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
