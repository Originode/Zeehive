-- DERIVE THE SCHEDULE FROM THE RECORD — actual start/end for every work item, from facts the
-- meta-DB already records. Never typed by a human or a zee: a byproduct of the ledger.
--
-- WHY THIS EXISTS. Live prod (2026-08-08): 470 work items, 0 with starts_on, 0 with due_on, and 3
-- dependency edges in total. The gantt is a 734-line chart rendering over an EMPTY schedule,
-- because dates only exist when somebody TYPES them. But nothing is missing from the record: an
-- item's real start is its first work_item_event into assigned/working (or the first zee_turn of
-- the xell linked to it), its real end is the terminal event or the land_request that landed it,
-- and its in-flight state is the live zee plus its turns. This migration adds the two DERIVED
-- columns and keeps them current as a byproduct of the queenzee's own event writes.
--
-- THE INVARIANT: starts_on/due_on are the PLAN (a human's forecast). actual_start/actual_end are
-- the ACTUAL (what the record proves happened). They are different data and must never be merged —
-- the gantt draws planned and actual side by side.
--
-- DERIVATION RULES (the single source of truth; server/src/lib/work-actuals.js states the same
-- rules in JS, tested standalone, and the workflow-rehab programme reuses them):
--
--   actual_start = the EARLIEST of
--     • the first work_item_event with kind='status' AND to_status IN ('assigned','working')
--     • the first work_item_event with kind='assigned' that is a REAL assignment (an unassign or a
--       zee-gone note is not a start)
--     • the first zee_turn of any xell that has been linked to the item (work_item.xell_id, the
--       task stamp, or an assigned event's detail->>'xell_id')
--   actual_end = the EARLIEST of
--     • the first work_item_event with kind='status' AND to_status IN ('done','cancelled')
--     • the first land_request with status='landed' for any linked xell (its landed_at)
--   A null actual_end is exactly "the work is still in flight" — the read models already resolve
--   the live zee that proves it.
--
-- KEPT CURRENT BY TRIGGERS, not by any agent: every work_item_event insert/update, every
-- zee_turn insert, and every land_request that lands recompute the item's two columns. The backfill
-- below derives the columns for every existing item first, so a 470-item database with a year of
-- events gets its schedule the moment this migration applies.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS), forward-only.

ALTER TABLE work_item ADD COLUMN IF NOT EXISTS actual_start timestamptz;
ALTER TABLE work_item ADD COLUMN IF NOT EXISTS actual_end   timestamptz;

COMMENT ON COLUMN work_item.actual_start IS 'DERIVED actual start: the first work_item_event into assigned/working, or the first zee_turn of a linked xell — whichever is earliest. A byproduct of the ledger, never agent-submitted. Distinct from starts_on (the PLAN).';
COMMENT ON COLUMN work_item.actual_end IS 'DERIVED actual end: the terminal work_item_event (done/cancelled), or the first land_request that landed for a linked xell — whichever is earliest. Null while the work is still in flight. Distinct from due_on (the PLAN).';

-- ── the recompute ────────────────────────────────────────────────────────────
-- One function for every source and every trigger. It resolves the xells that have been LINKED to
-- the item (current link, the task stamp, or an assigned event's recorded xell_id — an item is
-- still linked to a zee that was later unassigned) and derives both columns from the ledger.
CREATE OR REPLACE FUNCTION work_item_actual_refresh(target_id uuid) RETURNS void AS $$
DECLARE
  owner_xells uuid[];
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

  UPDATE work_item wi SET
    actual_start = (
      SELECT min(x.ts) FROM (
        -- a status transition into assigned/working, or a real assignment event (an unassign or a
        -- zee-gone note is an 'assigned' event too, and says the opposite of a start)
        SELECT e.ts FROM work_item_event e
          WHERE e.work_item_id = target_id
            AND ( (e.kind = 'status' AND e.to_status IN ('assigned','working'))
                  -- a real assignment names a non-null xell_id or assignee: an unassign, a zee-gone
                  -- note, and a PATCH that clears the link (detail.xell_id = json null) all write
                  -- kind='assigned' and all say a zee is NOT on it.
                  OR (e.kind = 'assigned'
                      AND coalesce((e.detail->>'unassigned')::boolean, false) = false
                      AND coalesce((e.detail->>'zee_gone')::boolean, false) = false
                      AND (coalesce(e.detail->>'xell_id', '') NOT IN ('', 'null')
                           OR coalesce(e.detail->>'assignee', '') NOT IN ('', 'null'))) )
        UNION ALL
        -- the first turn of any xell that worked this item
        SELECT zt.started_at FROM zee_turn zt
          WHERE zt.xell_id = ANY(owner_xells)
      ) x
    ),
    actual_end = (
      SELECT min(x.ts) FROM (
        -- the terminal event
        SELECT e.ts FROM work_item_event e
          WHERE e.work_item_id = target_id AND e.kind = 'status' AND e.to_status IN ('done','cancelled')
        UNION ALL
        -- the landing that delivered the work
        SELECT lr.landed_at FROM land_request lr
          WHERE lr.status = 'landed' AND lr.landed_at IS NOT NULL
            AND lr.xell_id = ANY(owner_xells)
      ) x
    )
  WHERE wi.id = target_id;
END;
$$ LANGUAGE plpgsql;

-- ── backfill: derive actuals for every existing item ─────────────────────────
SELECT work_item_actual_refresh(id) FROM work_item;

-- ── keep it current: a byproduct of the queenzee's own event writes ──────────
CREATE OR REPLACE FUNCTION work_item_actual_event_trg() RETURNS trigger AS $$
BEGIN
  IF NEW.work_item_id IS NOT NULL THEN
    PERFORM work_item_actual_refresh(NEW.work_item_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_item_actual_event_trg ON work_item_event;
CREATE TRIGGER work_item_actual_event_trg AFTER INSERT OR UPDATE ON work_item_event
  FOR EACH ROW EXECUTE FUNCTION work_item_actual_event_trg();

-- A zee_turn proves the linked xell is working — the earliest one is a start, and one is inserted
-- the moment a turn begins (while the xell is CURRENTLY on the item, so the current link is the
-- right place to look).
CREATE OR REPLACE FUNCTION work_item_actual_turn_trg() RETURNS trigger AS $$
DECLARE target_id uuid;
BEGIN
  SELECT id INTO target_id FROM work_item WHERE xell_id = NEW.xell_id LIMIT 1;
  IF target_id IS NOT NULL THEN
    PERFORM work_item_actual_refresh(target_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_item_actual_turn_trg ON zee_turn;
CREATE TRIGGER work_item_actual_turn_trg AFTER INSERT ON zee_turn
  FOR EACH ROW EXECUTE FUNCTION work_item_actual_turn_trg();

-- A landing that reaches status='landed' is the work being DELIVERED — the item's actual end.
CREATE OR REPLACE FUNCTION work_item_actual_land_trg() RETURNS trigger AS $$
DECLARE target_id uuid;
BEGIN
  IF NEW.status = 'landed' THEN
    SELECT id INTO target_id FROM work_item WHERE xell_id = NEW.xell_id LIMIT 1;
    IF target_id IS NOT NULL THEN
      PERFORM work_item_actual_refresh(target_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_item_actual_land_trg ON land_request;
CREATE TRIGGER work_item_actual_land_trg AFTER INSERT OR UPDATE ON land_request
  FOR EACH ROW EXECUTE FUNCTION work_item_actual_land_trg();
