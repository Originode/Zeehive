-- TEACH THE MANUAL HOW TO UN-ASK A LANDING — `zee land --withdraw` (060/061, queenzee/landgate.js).
--
-- A verb that is not in the manual does not exist to a zee: the cxell-zee manual is DB-owned
-- (harness `zee-base`, memory file cxell-zee-manual.md) and reaches a xell only through harness
-- injection, so a new endpoint with no manual line is a door nobody opens.
--
-- Two things go in, and the second one is the point:
--   1. the verb — a held landing can now be lowered by the zee that raised it, exactly like
--      `zee tend --clear` / `zee done --clear`;
--   2. the DISCIPLINE — do not spam the gate. One open land request per zee. If you asked to land
--      and then kept working, WITHDRAW the open one before you land again. A human looking at three
--      held landings from one xell cannot tell which one it still means, and the zee that stacked
--      them is the only thing that knows.
--
-- Surgical and idempotent by guard (the 053/059 pattern): anchored replacements inside the stored
-- text, applied only if the manual does not already carry them, each anchor an exact line from the
-- manual as it stands. If a human has edited that line the anchor does not match and the
-- replacement simply DOES NOT FIRE — a hand-edited manual is never half-rewritten by a migration.
-- Writes back into the memory ENTRY it read (by path, by index), so other memory files are untouched.
DO $$
DECLARE
  idx int;
  txt text;
BEGIN
  SELECT (a.i - 1), a.e->>'text' INTO idx, txt
    FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') WITH ORDINALITY AS a(e, i)
   WHERE h.key = 'zee-base' AND a.e->>'path' = 'cxell-zee-manual.md'
   LIMIT 1;
  IF txt IS NULL OR txt LIKE '%zee land --withdraw%' THEN RETURN; END IF;

  -- (a) the verb table
  txt := replace(txt,
    E'zee land                                         # collect commits + gated push to main (ONLY when 100% certain)\n',
    E'zee land                                         # collect commits + gated push to main (ONLY when 100% certain)\n'
    || E'zee land --withdraw [--reason "…"]               # UN-ASK your held landing (withdraw the old one BEFORE landing again)\n');

  -- (b) the paragraph inside `zee land` — withdraw-then-land, stated where a zee is already reading
  txt := replace(txt,
    E'force a merge; that means something moved underneath you — check with a human.',
    E'force a merge; that means something moved underneath you — check with a human.' || E'\n'
    || E'\n'
    || E'**ONE open landing per zee — do NOT spam the gate.** A held landing is a QUESTION you asked a\n'
    || E'human, and every extra push while it is open asks the same human another one. Three cards from one\n'
    || E'xell, two of them obsolete, and only you know which is current: that is not urgency, it is noise,\n'
    || E'and it is how the real one gets ignored. If you asked to land and then kept working — you found a\n'
    || E'bug in what you pushed, you were handed more scope, the work was not as finished as you thought —\n'
    || E'**withdraw the open request first, then land again**:\n'
    || E'\n'
    || E'```\n'
    || E'zee land --withdraw --reason "found a bug in the migration; re-landing once it is fixed"\n'
    || E'zee land            # one fresh card, for the sha you actually mean\n'
    || E'```\n'
    || E'\n'
    || E'`POST /api/xell/self/land/withdraw` (`zee land --clear` is the same verb, for symmetry with `zee\n'
    || E'tend --clear` / `zee done --clear`). It **un-asks**, and that is all it does: nothing lands, nothing\n'
    || E'is rejected, no sha is burned and your branch is untouched — the card simply leaves the human''s\n'
    || E'screen. `--request <id>` withdraws one specific request; with no id it lowers all of yours that are\n'
    || E'still pending. You may only ever withdraw your OWN.\n'
    || E'\n'
    || E'**An APPROVED landing is not yours to retract.** A human already decided it and the queenzee is\n'
    || E'landing it; withdraw is refused. If it genuinely must not land, `zee tend --reason "…"` and say so.\n'
    || E'And if you are not sure the work is landable at all, do not raise a request you will have to\n'
    || E'withdraw — `zee hint-land` lights the button and leaves the decision with a human.');

  UPDATE harness SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(txt))
   WHERE key = 'zee-base';
  RAISE NOTICE 'cxell-zee manual: taught `zee land --withdraw` (and one open landing per zee)';
END $$;
