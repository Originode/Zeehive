-- REHAB 3/4 — RETIRE work_item_dep. The workflow model's `dependency` table is the ONE source of
-- truth for finish→start edges (rehab 1/4 dual-wrote every edge into it; rehab 2/4 re-pointed
-- every reader at it; rehab 3/4 stopped the legacy write). work_item_dep itself is now dead.
--
-- SAFETY — the one rule of the rehab's "move before you drop": this migration REFUSES to drop
-- unless every work_item_dep edge is already mirrored as an FS dependency row in the model.
-- dependency.from_id is the PREREQUISITE (the retired work_item_dep.depends_on_id), to_id the
-- DEPENDENT (work_item_dep.work_item_id) — the direction repair 186 corrected on live data. A
-- count mismatch means data would be lost, and the migration aborts loudly rather than drop.
--
-- Then: the guard trigger + guard function that existed only to police work_item_dep go too
-- (nothing else references them), and the table itself. Idempotent — a second pass is a no-op.
--
-- FORWARD-ONLY. The DOWN (recreating work_item_dep) is deliberately never written: the rehab is a
-- one-way door and 185/186 have already read whatever they needed from this table.
DO $$
DECLARE
  v_bad int;
  v_edges int;
BEGIN
  IF to_regclass('public.work_item_dep') IS NULL THEN
    RAISE NOTICE 'work_item_dep already retired — no-op';
    RETURN;
  END IF;

  -- Every legacy edge must have a matching model edge. The legacy table's write order is the
  -- opposite of the model's: work_item_id is the DEPENDENT, depends_on_id the PREREQUISITE, so
  -- the model row is from_id=node(depends_on_id) → to_id=node(work_item_id).
  SELECT count(*) INTO v_bad
    FROM work_item_dep d
   WHERE NOT EXISTS (
     SELECT 1
       FROM work_node a
       JOIN work_node b ON true
       JOIN dependency dp ON dp.from_id = a.id AND dp.to_id = b.id AND dp.type = 'FS'
      WHERE a.stable_key = 'work_item:' || d.depends_on_id::text
        AND b.stable_key = 'work_item:' || d.work_item_id::text);

  SELECT count(*) INTO v_edges FROM work_item_dep;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'work_item_dep retirement REFUSED: % of % edge(s) are NOT mirrored in dependency — nothing was dropped. Find the missing model edges first.',
      v_bad, v_edges;
  END IF;
  RAISE NOTICE 'work_item_dep retirement: % edge(s) all mirrored in dependency — dropping', v_edges;

  DROP TRIGGER IF EXISTS work_item_dep_guard_trg ON work_item_dep;
  DROP FUNCTION IF EXISTS work_item_dep_guard();
  DROP TABLE IF EXISTS work_item_dep;
END $$;
