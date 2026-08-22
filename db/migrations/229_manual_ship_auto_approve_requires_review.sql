-- TEACH THE MANUAL THAT A SHIP MAY AUTO-APPROVE ONLY WHEN THE COMMITS IT CARRIES HAVE BEEN READ (79).
--
-- The night that earned this rule shipped 16 landings and 2 prod deploys in one go with ZERO diffs
-- read by anyone, and one of those carried a cross-project write hole found only because a reviewer
-- was cast by choice. `project.auto_approve_ship` used to fire on policy alone. From this migration
-- the manual says the truth the gate now enforces (queenzee/shipgate.js + ship-payload.js):
--   • a SHIP under auto-approve fires ONLY when every commit its payload carries has a recorded
--     review verdict (`zee review`, ticket #56) — the reading the payload now surfaces;
--   • when some carried commits are UNREAD, auto-approve is WITHHELD — the request stays pending for
--     a human, and the card NAMES the unread commits (their short sha and who landed each) so a
--     human knows exactly whose work needs reading, or can approve it manually;
--   • when the review record cannot be READ at all, auto-approve is WITHHELD TOO — unmeasurable must
--     never mean "all reviewed";
--   • LANDING auto-approve is untouched: main is cheap to revert, and recording a review must never
--     slow a landing.
--
-- Two things go in:
--   1. the ship section — a paragraph at the END of `### zee ship` (before `### zee hint-land`)
--      stating the gate, in the same seam 223 used for ship --withdraw;
--   2. the review section — 225 told zees "It is **NOT a gate** — nothing on the landing or ship
--      path waits on it". That was true when 225 landed and is now WRONG for the ship path: the ship
--      auto-approve DOES wait on the review record. The claim is corrected to name the landing path
--      and the ship exception, so the manual does not lie to a zee that reads the review verb.
--
-- Surgical and idempotent by guard (the 220/223/225 pattern): harness_memory_get/_put BY PATH (076,
-- house rule 9), anchored replacements inside the stored text, applied only if the manual does not
-- already carry them. The body-section seam is the `### zee hint-land` heading — never inside 059's
-- protected verb-table block. A human who moved an anchor gets a NOTICE, never a half-rewritten manual.
DO $$
DECLARE
  txt          text;
  changed      boolean := false;
  ship_addition  text;
  review_old   text;
  review_new   text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'zee manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF txt LIKE '%A SHIP under auto-approve fires ONLY when every commit it carries has been READ%' THEN
    RAISE NOTICE 'zee manual: the ship review-gate paragraph is already present — nothing to do';
    RETURN;
  END IF;

  -- (a) the ship section — appended to the end of `### zee ship`, before `### zee hint-land`.
  ship_addition := $hz$
**A SHIP under auto-approve fires ONLY when every commit it carries has been READ.** `project.auto_approve_ship` is the fast path for a project that trusts its zees — but the night that earned this rule shipped 16 landings and 2 prod deploys in one go with ZERO diffs read by anyone, and one of those carried a cross-project write hole found only because a reviewer was cast by choice. The gate joins the existing payload (the commits since the last shipped sha for the target, each with WHO landed it): if every carried commit has a recorded review verdict (`zee review`, ticket #56), auto-approve fires as before; if ANY carried commit has NO recorded review, auto-approve is **WITHHELD** — the request stays PENDING for a human, and the card NAMES the unread commits (their short sha and who landed each) so a human knows exactly whose work needs reading, or can ship it manually anyway. If the review record cannot be READ at all, auto-approve is **WITHHELD too** — unmeasurable must never mean "all reviewed". LANDING auto-approve is untouched: main is cheap to revert, and recording a review must never slow a landing.

$hz$;
  IF position(E'### `zee hint-land` · `zee hint-ship` — nudge a human to land/ship, without doing it' IN txt) > 0 THEN
    txt := replace(txt,
      E'### `zee hint-land` · `zee hint-ship` — nudge a human to land/ship, without doing it',
      ship_addition || E'### `zee hint-land` · `zee hint-ship` — nudge a human to land/ship, without doing it');
    changed := true;
  ELSE
    RAISE NOTICE 'zee manual: the zee hint-land heading has moved — the ship review-gate paragraph was not added';
  END IF;

  -- (b) the review section — correct the 225 claim now that the ship path DOES wait on the review.
  review_old := 'It is **NOT a gate** — nothing on the landing or ship path'
    || E'\n'
    || 'waits on it, and recording one must never slow a landing.';
  review_new := 'It is **not a gate on the LANDING path** — nothing on landing waits on it, and recording one'
    || E'\n'
    || 'must never slow a landing. A **ship** under auto-approve (ticket #79) is the one path that waits on'
    || E'\n'
    || 'it: every commit the ship carries must have a recorded review verdict, or a human approves it explicitly.';
  IF position(review_old IN txt) > 0 THEN
    txt := replace(txt, review_old, review_new);
    changed := true;
  ELSE
    RAISE NOTICE 'zee manual: the zee-review "NOT a gate" sentence has moved — the ship exception was not added';
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'zee manual: the ship auto-approve review gate is now documented';
  ELSE
    RAISE NOTICE 'zee manual: nothing to patch (the anchors did not match)';
  END IF;
END $$;
