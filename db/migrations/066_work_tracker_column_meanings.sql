-- WHAT THE NUMBERS MEAN — column comments for the coded scalars the work tracker shipped.
--
-- 058 and 060 gave these columns a RANGE and no MEANING. `priority int CHECK (priority BETWEEN 1
-- AND 5)` says exactly what is storable and nothing at all about which end is urgent, so the console
-- had to guess (it guessed right, and said so in a comment: "the API says nothing about which end is
-- urgent"). That gap is the worst kind: it fails SILENTLY and totally — had the direction been the
-- other way, every board card in production would have been coloured backwards and nothing would
-- have thrown.
--
-- docs/work-tracker.md states it as policy now. This migration puts the SAME sentence where the next
-- person will actually be standing: in the database. `\d+ work_item` in psql is the first place
-- somebody looks when they are re-deriving a meaning, and until now it answered with a range.
--
-- Comments only. No data, no schema, no behaviour — safe to run against anything.

COMMENT ON COLUMN work_item.priority IS
  '1..5, and 1 is MOST urgent (5 = least). Default 3 is the middle of the scale. The console renders '
  'it that way (pips fill as the number drops, 1 red, 2 amber). NB: machine_pool.dev_priority is the '
  'OPPOSITE convention — it is ordered DESC, so for MACHINES a higher number wins. The names rhyme; '
  'the meanings do not. See docs/work-tracker.md, policy 5.';

COMMENT ON COLUMN ticket.priority IS
  '1..5, and 1 is MOST urgent (5 = least). Default 3. Identical in meaning to work_item.priority — '
  'see docs/work-tracker.md, policy 5.';

-- progress carries a gotcha worth stating where it is stored, not only in the doc: the gantt cannot
-- tell "nobody has said" from "somebody said none", because both are 0.
COMMENT ON COLUMN work_item.progress IS
  'Percent complete of THIS item, 0..100. A LEAF reports its own value. For a PARENT, the gantt '
  'read model treats 0 as "no explicit progress" and substitutes the leaf-count-weighted average of '
  'its children — so a deliberate 0% on a parent is not expressible and will render as the rolled '
  'average instead. Never written back by a roll-up: computed at read time only.';

COMMENT ON COLUMN work_item.estimate_hours IS
  'Estimated effort in HOURS (numeric(8,2)) for this item alone — not a roll-up of its children, and '
  'never used to derive dates. Advisory: nothing in the server reads it.';

COMMENT ON COLUMN work_item.starts_on IS
  'Planned start (date, no time). Either date may be NULL — an item with no schedule, or a start with '
  'no end, are both ordinary. Only the ORDER of two present dates is constrained '
  '(work_item_dates_ordered, migration 060). A parent with no dates has its span rolled up from its '
  'children at READ time.';

COMMENT ON COLUMN work_item.due_on IS
  'Planned finish (date, no time). May not precede starts_on — enforced by work_item_dates_ordered '
  '(migration 060), because a negative span renders as a one-day stub indistinguishable from a real '
  'one-day task. NULL means "no end yet", which is a legitimate state and not a missing value to be '
  'filled in. Nothing bounds how far apart the two dates may be: the gantt states span_days and lets '
  'the renderer clamp.';

COMMENT ON COLUMN work_item.depth IS
  'Number of ancestors (root = 0). Maintained by trigger together with path — never set by hand. '
  'Nesting is child_rank >= parent_rank (project 0 < activity 1 < task 2), so depth is ARBITRARY: '
  'task-under-task and activity-under-activity are both legal. Do not assume three levels.';

COMMENT ON COLUMN work_item.status IS
  'The zee lifecycle, reused rather than reinvented: queued/assigned/working/done/cancelled come from '
  'task_status, and blocked/review/shipping are what the hive already calls occ-tendRequest, '
  'occ-land* and occ-ship*. done and cancelled are TERMINAL (they stamp closed_at). The stored value '
  'is always what a human or a verb last set — a live zee''s hive status is advisory and is never '
  'written back here. See server/src/lib/work-status.js.';

COMMENT ON COLUMN ticket.number IS
  'Per-project sequence a person can say out loud ("#14"), assigned by trigger under an advisory '
  'lock. Unique within the project; NOT global, so two projects both have a #1.';
