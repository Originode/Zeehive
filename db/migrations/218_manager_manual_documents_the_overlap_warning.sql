-- THE MANAGER MANUAL: `zee assign` (and the board's deploy dialog) tell a manager when the work is
-- not as empty as the board makes it look — another live xell may already be in it, or work on this
-- card/ticket has already LANDED on main (tickets #33/#64).
--
-- WHY: the overlap warning reached a manager's dispatch answer and nothing else. The board's deploy
-- path (POST /work-items/:id/deploy) never checked, and the manual never mentioned the block — so a
-- manager learnt it existed only by reading the dispatch answer carefully. House rule 8: what a zee
-- is told moves with the code, and a check that fires on one path and not the others is a check
-- people learn to trust wrongly.
--
-- SURGICAL AND GUARDED per house rule 9 — harness_memory_get/_put BY PATH, never a hand-rolled jsonb
-- against the memory array (test/harness-memory-migrations.test.mjs fails anything that does). One
-- STANDALONE section placed BEFORE the WORK TRACKER heading — the same seam migration 146 uses, which
-- keeps migration 059's WORK TRACKER replacement VERBATIM in the stored manual (test/work-assign.test.mjs
-- asserts those bytes as contiguous substrings; inserting inside them would break that contract). An
-- anchor a human has moved makes the replacement not fire and says so with a NOTICE, never a
-- half-rewritten manual.
--
-- IDEMPOTENT: the edit guards on the new text already being present. Running this file twice (past
-- the ledger, or on a database that already has the paragraph) is a no-op.
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  addition  text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF txt LIKE '%Read the overlap warning before you deploy%' THEN
    RAISE NOTICE 'manager manual: the deploy overlap warning is already documented — nothing to do';
    RETURN;
  END IF;

  addition := $hz$
### Read the overlap warning before you deploy

`zee assign` (and the board's deploy dialog, when a human deploys from the console) tells you when the
work is not as empty as the board makes it look — another live xell may already be in it, or work on
this card/ticket may already have LANDED on main. It is INFORMATION, not a refusal: you can still
deploy, and the check never blocks one. But read it before you do — two zees on one file is ordinary,
two zees on one PROBLEM is a duplicate nobody sees until it lands. If it names a live xell, talk to it
(`zee say`) or re-brief this one to a different part; if it names a landed sha, `git show <sha>` says
what is already on main before you spend a worker re-proving it.

$hz$;
  -- Insert before "## The WORK TRACKER" heading (the same seam as migration 146 — never inside 059's
  -- WORK TRACKER replacement, whose bytes test/work-assign.test.mjs asserts verbatim).
  IF position(E'\n## The WORK TRACKER — the plan your crew executes' IN txt) > 0 THEN
    txt := replace(txt, E'\n## The WORK TRACKER — the plan your crew executes',
                        E'\n' || addition || E'\n## The WORK TRACKER — the plan your crew executes');
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: the WORK TRACKER heading has moved — the overlap warning was not added';
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
    RAISE NOTICE 'manager manual: the deploy overlap warning is now documented';
  ELSE
    RAISE NOTICE 'manager manual: nothing to patch (the overlap warning was already there)';
  END IF;
END $$;
