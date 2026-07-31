-- WORK ITEM SCHEDULE SANITY — due_on may not precede starts_on.
--
-- 058 gave a work item a start and an end and trusted callers to order them. They do not: the API
-- accepted PATCH {starts_on:'2026-08-10', due_on:'2026-08-01'} with a 200, and /api/gantt then
-- reported computed_start 2026-08-10 → computed_end 2026-08-01. A chart cannot draw a negative bar,
-- so it renders a stub — visually IDENTICAL to a legitimate one-day task. The schedule was wrong and
-- the picture looked fine, which is the worst pair of properties a read model can have.
--
-- This is the same house rule 001_init states: "constraints/triggers encode the impossibilities".
-- An item finishing before it starts is not a bad UI state to be tidied up client-side, it is a row
-- that should never have been storable — so the invariant goes where nothing can route around it,
-- and lib/work-items.js refuses it FIRST so a caller gets a readable sentence instead of a postgres
-- constraint name.
--
-- NOT in scope here (deliberately): any opinion about how far apart the two dates may be.
-- '0001-01-01' → '9999-12-31' is a legal, ordered, absurd schedule; bounding it is a product
-- decision belonging to whoever renders the window, and the gantt read model now states each row's
-- span_days so a client can clamp honestly rather than the server inventing limits.

-- ── repair before enforce ────────────────────────────────────────────────────
-- Any row already inverted is repaired by CLEARING due_on, not by swapping the pair or by pinning
-- due_on to starts_on. An inverted pair means one of the two dates is wrong and we cannot know
-- which; "no end date" is the only thing that is actually TRUE about such a row, and the gantt
-- already handles a missing due_on (it rolls one up from children, or flags the row unscheduled).
-- Swapping would fabricate an ordering nobody stated, and due_on := starts_on would fabricate a
-- one-day task — the very lie this migration exists to stop.
DO $$
DECLARE fixed int;
BEGIN
  UPDATE work_item SET due_on = NULL WHERE starts_on IS NOT NULL AND due_on IS NOT NULL AND due_on < starts_on;
  GET DIAGNOSTICS fixed = ROW_COUNT;
  IF fixed > 0 THEN
    RAISE NOTICE '060: cleared due_on on % work item(s) that finished before they started', fixed;
  END IF;
END $$;

-- ── the invariant ────────────────────────────────────────────────────────────
-- Either date may be NULL (an item with no schedule, or a start with no end — both ordinary). Only
-- the ORDER of two present dates is constrained.
DO $$ BEGIN
  ALTER TABLE work_item ADD CONSTRAINT work_item_dates_ordered
    CHECK (starts_on IS NULL OR due_on IS NULL OR due_on >= starts_on);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON CONSTRAINT work_item_dates_ordered ON work_item IS
  'due_on may not precede starts_on. Either may be NULL; only the order of two present dates is fixed. A negative span renders as a one-day stub, indistinguishable from a real one — so it is unstorable rather than merely discouraged.';
