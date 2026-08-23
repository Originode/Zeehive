-- TEACH THE MANUAL HOW TO UN-ASK A SHIP — `zee ship --withdraw` (221/222, queenzee/shipgate.js).
--
-- A verb that is not in the manual does not exist to a zee: the cxell-zee manual is DB-owned
-- (harness `zee-base`, memory file cxell-zee-manual.md) and reaches a xell only through harness
-- injection, so a new endpoint with no manual line is a door nobody opens. `zee land --withdraw`
-- got its manual line in 063; this is the SHIP half of the same lesson.
--
-- Two things go in:
--   1. the verb — a held ship request can now be lowered by the zee that raised it, exactly like
--      `zee land --withdraw`, as long as the deploy has not started;
--   2. the boundary — a ship a HUMAN already approved is still withdrawable BEFORE the deploy
--      starts (approval only queues it; an auto-approve project flips a fresh ask to approved in
--      milliseconds), but once the deploy has STARTED (`status='shipping'`) withdraw is REFUSED,
--      and the answer to "stop it now" is `zee tend`.
--
-- Surgical and idempotent by guard (the 220 pattern): harness_memory_get/_put BY PATH (076, house
-- rule 9), anchored replacements inside the stored text, applied only if the manual does not
-- already carry them. The body-section seam is the END of the `### zee ship` section, before the
-- `### zee hint-land` heading — never inside 059's protected verb-table block. A human who moved
-- the anchor gets a NOTICE, never a half-rewritten manual.
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  addition  text;
  verb_line text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'zee manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF txt LIKE '%zee ship --withdraw%' THEN
    RAISE NOTICE 'zee manual: `zee ship --withdraw` is already documented — nothing to do';
    RETURN;
  END IF;

  -- (a) the verb table — right after the `zee ship` line, mirroring where 063 put `zee land --withdraw`.
  verb_line := 'zee ship [--targets server webapp] --reason "…"  # ask to deploy to prod — REFUSED unless landed (ONLY when 100% certain)';
  IF position(verb_line IN txt) > 0 THEN
    txt := replace(txt, verb_line,
      verb_line || E'\n'
      || E'zee ship --withdraw [--reason "…"]               # UN-ASK your held ship request (before the deploy starts)');
    changed := true;
  ELSE
    RAISE NOTICE 'zee manual: the `zee ship` verb-table line has moved — the ship --withdraw line was not added';
  END IF;

  -- (b) the body section — appended to the end of `### zee ship`, before `### zee hint-land`.
  addition := $hz$
**A ship you no longer mean can be UN-ASKED — `zee ship --withdraw`.** Raising a ship and then
learning the deploy is bigger than described (it would carry other xells' migrations, prod is
fragile, the ask was wrong anyway) used to be a trap: the exits were a human's Approve/Reject/Defer
and nothing the zee could pull back. `POST /api/xell/self/ship/withdraw` (`zee ship --withdraw`, and
`--clear` is the same verb for symmetry with tend/hint/done) lowers YOUR pending ship request before
the deploy starts: it deploys nothing, reverts nothing, rejects nothing — the card simply leaves the
human's screen and the row records who un-asked it and why. It is REFUSED once the deploy has
STARTED (`status='shipping'` — the queenzee has taken the prod lock and the build is running); if it
must be stopped at that point, `zee tend --reason "…"` so a human can see prod is mid-deploy. A ship
a human already APPROVED is still withdrawable before it starts — approval only queues the deploy —
but an APPROVED ship whose deploy has started is not yours to retract either. `--request <id>`
withdraws one specific request; with no id it lowers all of yours that are still pending/approved.
You may only ever withdraw your OWN.

$hz$;
  -- The seam: the end of the `### zee ship` section, just before the `### zee hint-land` heading.
  IF position(E'### `zee hint-land` · `zee hint-ship` — nudge a human to land/ship, without doing it' IN txt) > 0 THEN
    txt := replace(txt,
      E'### `zee hint-land` · `zee hint-ship` — nudge a human to land/ship, without doing it',
      addition || E'### `zee hint-land` · `zee hint-ship` — nudge a human to land/ship, without doing it');
    changed := true;
  ELSE
    RAISE NOTICE 'zee manual: the zee hint-land heading has moved — the ship-withdraw paragraph was not added';
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'zee manual: `zee ship --withdraw` is now documented';
  ELSE
    RAISE NOTICE 'zee manual: nothing to patch (the anchors did not match)';
  END IF;
END $$;
