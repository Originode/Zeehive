-- THE HYGIENE NOTE GETS THE OTHER HALF: withdraw a land request the way you revoke a tend.
--
-- `zee-base` carries a second memory file beside the manual — `tend-or-land.md`, a human-written
-- note about not leaving stale asks standing ("check if your tend request is still relevant… if
-- you've been tended, then revoke your tend request… if you need to land, then do so instead of
-- asking for a tend request"). It is the one page a zee re-reads when it is deciding whether to
-- bother a human, and until now it could only teach half the lesson: a tend can be revoked, a
-- LANDING could not, so "keep your asks true" stopped at the gate.
--
-- 061-063 gave the landing its retraction (`zee land --withdraw`). This teaches it where the rule
-- already lives. The long-form explanation is in the manual (063, `### zee land`); this is the short
-- reminder in the note that a zee actually consults, and the two must not disagree.
--
-- APPENDS, deliberately — it does not rewrite a line. That note is a human's own words (their
-- phrasing, their typos); an anchored replace would either clobber them or, once they edit it, fail
-- to fire and leave the two halves out of step. Appending works against whatever the row says today.
-- Guarded on the verb, so it runs at most once and a row that already teaches it is left alone.
-- Located BY PATH within the memory array (never by index), so other memory files are untouched.
DO $$
DECLARE
  idx int;
  txt text;
BEGIN
  SELECT (a.i - 1), a.e->>'text' INTO idx, txt
    FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') WITH ORDINALITY AS a(e, i)
   WHERE h.key = 'zee-base' AND a.e->>'path' = 'tend-or-land.md'
   LIMIT 1;
  IF txt IS NULL OR txt LIKE '%--withdraw%' THEN RETURN; END IF;

  txt := txt || E'\n\n'
    || E'and the same goes for a LAND request, now that one can be taken back: if you have asked to '
    || E'land and it is no longer what you mean — you found a bug in what you pushed, the work grew, '
    || E'you are about to push a newer commit — then WITHDRAW the open one '
    || E'(`zee land --withdraw --reason "…"`) instead of leaving it standing or stacking a second card '
    || E'on top of it. ONE open landing per zee: a human should only ever have one card from you to '
    || E'decide, and when there are three they cannot tell which one you still mean. Withdrawing '
    || E'decides nothing — nothing lands, nothing is rejected, no sha is burned and your commits stay '
    || E'exactly where they are — so it costs you nothing to keep your asks true. The order is '
    || E'WITHDRAW, then `zee land` again. Two things it is not: an APPROVED landing is a human''s '
    || E'decision and not yours to retract (that one is `zee tend`), and if you are not sure the work '
    || E'is landable at all, do not raise a request you will only have to withdraw — `zee hint-land` '
    || E'lights the button and leaves the call to them.';

  UPDATE harness SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(txt))
   WHERE key = 'zee-base';
  RAISE NOTICE 'harness hygiene note: a land request can be WITHDRAWN, like a tend is revoked';
END $$;
