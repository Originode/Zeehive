-- SCOPE THE ACTUALS REDUCERS TO THE ITEM'S OWN WINDOW (TKT-153).
--
-- THE DEFECT migration 159 shipped. A xell works MANY items over its life, and 159's derivation
-- was min() over the xell's WHOLE history:
--
--   actual_start = min(start events, first zee_turn of ANY linked xell)
--   actual_end   = min(terminal event, first land_request that landed for ANY linked xell)
--
-- min() is right for a terminal event (first done wins) and exactly backwards for a landing or a
-- turn: a landing only ends an item if it happened DURING that item's work, so min() over the
-- xell's whole history guarantees the OLDEST, least relevant landing beats the item's own truthful
-- done event. Measured on prod: 80 of 84 ends came from a xell's first landing, 30 were
-- contaminated by a multi-item xell, 26 were inverted (end < start), and 14 items shared one
-- landing timestamp (one item "ended" 2.5h before it started).
--
-- THE FIX — the item's own window:
--   actual_start — the item's OWN start events WIN. A zee_turn is a fallback only when the ledger
--                  has no start event, and only when it falls INSIDE the item's own window (a turn
--                  before the item's earliest ledger row belongs to an earlier item).
--   actual_end   — the item's OWN terminal event (done/cancelled) WINS. A landing is a fallback
--                  only when the item has no terminal event, and only when landed_at >= the item's
--                  actual_start (the item's own window).
--   never persist an impossible range — actual_end < actual_start is rejected (null) and logged,
--                  so a contradiction is visible instead of a silent negative bar.
--
-- server/src/lib/work-actuals.js states the same rules in JS (tested standalone, and the DB test
-- pins the two to the same answer). KEEP THEM IN STEP.
--
-- NO BACKFILL in this migration, deliberately: rewriting existing prod rows is a separate,
-- human-gated matter (a follow-up run of `SELECT work_item_actual_refresh(id) FROM work_item`
-- is idempotent and safe). This migration only changes the RULE that future events and refreshes
-- run under.
CREATE OR REPLACE FUNCTION work_item_actual_refresh(target_id uuid) RETURNS void AS $$
DECLARE
  owner_xells uuid[];
  v_start timestamptz;
  v_end timestamptz;
  v_earliest timestamptz;
BEGIN
  SELECT array_agg(x) INTO owner_xells FROM (
    SELECT wi.xell_id AS x FROM work_item wi WHERE wi.id = target_id AND wi.xell_id IS NOT NULL
    UNION
    SELECT t.xell_id FROM task t WHERE t.work_item_id = target_id AND t.xell_id IS NOT NULL
    UNION
    SELECT (e.detail->>'xell_id')::uuid FROM work_item_event e
      WHERE e.work_item_id = target_id AND e.kind = 'assigned'
        AND e.detail->>'xell_id' ~ '^[0-9a-fA-F-]{36}$'
  ) o WHERE x IS NOT NULL;

  -- The item's own earliest ledger row: the lower bound of its window. (Every real item has a
  -- 'created' event, so this is normally the item's creation.)
  SELECT min(ts) INTO v_earliest FROM work_item_event WHERE work_item_id = target_id;

  -- actual_start — the item's OWN start events win; a zee_turn is a fallback only when there is
  -- no start event AND the turn falls inside the item's own window. The NOT EXISTS is the
  -- "events win" half (a multi-item xell's first turn, earned on an earlier item, must not pull
  -- this item's start back); the v_earliest bound is the "inside its own window" half.
  SELECT min(x.ts) INTO v_start FROM (
    SELECT e.ts FROM work_item_event e
      WHERE e.work_item_id = target_id
        AND ( (e.kind = 'status' AND e.to_status IN ('assigned','working'))
              OR (e.kind = 'assigned'
                  AND coalesce((e.detail->>'unassigned')::boolean, false) = false
                  AND coalesce((e.detail->>'zee_gone')::boolean, false) = false
                  AND (coalesce(e.detail->>'xell_id', '') NOT IN ('', 'null')
                       OR coalesce(e.detail->>'assignee', '') NOT IN ('', 'null'))) )
    UNION ALL
    SELECT zt.started_at FROM zee_turn zt
      WHERE zt.xell_id = ANY(owner_xells)
        AND NOT EXISTS (
          SELECT 1 FROM work_item_event e2
            WHERE e2.work_item_id = target_id
              AND ( (e2.kind = 'status' AND e2.to_status IN ('assigned','working'))
                    OR (e2.kind = 'assigned'
                        AND coalesce((e2.detail->>'unassigned')::boolean, false) = false
                        AND coalesce((e2.detail->>'zee_gone')::boolean, false) = false
                        AND (coalesce(e2.detail->>'xell_id', '') NOT IN ('', 'null')
                             OR coalesce(e2.detail->>'assignee', '') NOT IN ('', 'null'))) )
        )
        AND (v_earliest IS NULL OR zt.started_at >= v_earliest)
  ) x;

  -- actual_end — the item's OWN terminal event wins; a landing is a fallback only when there is
  -- no terminal event AND it falls inside the item's own window (landed_at >= actual_start).
  SELECT min(x.ts) INTO v_end FROM (
    SELECT e.ts FROM work_item_event e
      WHERE e.work_item_id = target_id AND e.kind = 'status' AND e.to_status IN ('done','cancelled')
    UNION ALL
    SELECT lr.landed_at FROM land_request lr
      WHERE lr.status = 'landed' AND lr.landed_at IS NOT NULL
        AND lr.xell_id = ANY(owner_xells)
        AND NOT EXISTS (
          SELECT 1 FROM work_item_event e2
            WHERE e2.work_item_id = target_id AND e2.kind = 'status' AND e2.to_status IN ('done','cancelled')
        )
        AND (v_start IS NULL OR lr.landed_at >= v_start)
  ) x;

  -- NEVER PERSIST AN IMPOSSIBLE RANGE: actual_end < actual_start is a contradiction the renderer
  -- would draw as a silent negative bar. Reject the end (null = "the record cannot place it")
  -- and say so, so the row is the one worth looking at.
  IF v_end IS NOT NULL AND v_start IS NOT NULL AND v_end < v_start THEN
    RAISE NOTICE 'work_item_actual_refresh(%): end % is before start % — rejecting the end (impossible range)',
      target_id, v_end, v_start;
    v_end := NULL;
  END IF;

  UPDATE work_item wi SET actual_start = v_start, actual_end = v_end WHERE wi.id = target_id;
END;
$$ LANGUAGE plpgsql;
