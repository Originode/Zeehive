-- SPIN DETECTOR CONVERGENCE — drop the NOT NULL knob columns an early 158 draft baked in.
--
-- WHY THIS FILE EXISTS, not a rewrite of 158: migrations are ledgered by NUMBER, and a database
-- that saw the early draft of 158 (NOT NULL knob columns with baked-in column defaults — the shape
-- that reached the shared dev db during development, before 158 landed in its corrected nullable
-- form) has 158 recorded as APPLIED. Its corrected 158 — including the self-heal ALTER block that
-- lives INSIDE 158 — will therefore NEVER re-run there, so that db keeps the stale shape forever
-- and every partial spin_detector_config insert hits a NOT NULL violation. NULL = inherit is the
-- CORE semantic of the field-level inheritance (lib/spin-detector.js spinConfigFor), so the stale
-- shape silently breaks the whole knob. This file converges it forward: a fresh database (where
-- 158 already created the nullable, no-default shape) runs it as a clean no-op, because the two
-- loops below only touch columns that still carry the stale constraint.
--
-- GUARDED two ways:
--   • the table is only touched if it exists (a db whose ledger is somehow missing 158 is skipped);
--   • each ALTER fires only for a column that still has the stale shape (is_nullable='NO', or a
--     column default) — postgres DROP NOT NULL / DROP DEFAULT on an already-correct column is
--     itself a no-op, so the loop just finds nothing to do.
-- Idempotent, additive, forward-only — safe to re-run, and a no-op on a corrected database.
DO $mig$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.spin_detector_config') IS NULL THEN
    RAISE NOTICE 'spin_detector_config not present — nothing to converge';
    RETURN;
  END IF;

  -- DROP NOT NULL on the knob columns that still carry it (stale shape only).
  FOR r IN
    SELECT c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'spin_detector_config'
        AND c.is_nullable = 'NO'
        AND c.column_name IN ('enabled','min_calls','min_tokens','max_size_spread','same_path')
  LOOP
    EXECUTE format('ALTER TABLE spin_detector_config ALTER COLUMN %I DROP NOT NULL', r.column_name);
    RAISE NOTICE 'spin_detector_config.%: DROP NOT NULL', r.column_name;
  END LOOP;

  -- DROP the baked-in column defaults on the knob columns that still carry them (stale shape only).
  FOR r IN
    SELECT c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'spin_detector_config'
        AND c.column_default IS NOT NULL
        AND c.column_name IN ('enabled','min_calls','min_tokens','max_size_spread','same_path')
  LOOP
    EXECUTE format('ALTER TABLE spin_detector_config ALTER COLUMN %I DROP DEFAULT', r.column_name);
    RAISE NOTICE 'spin_detector_config.%: DROP DEFAULT', r.column_name;
  END LOOP;
END $mig$;
