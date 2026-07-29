-- SEED THE HYGIENE NOTE — the memory file that existed only because a human typed it.
--
-- `zee-base` carries two memory files: the manual (047, patched by migration ever since) and
-- `tend-or-land.md`, the short note a zee re-reads when it is deciding whether to bother a human.
-- The manual has always been seeded. The note never was — it was typed into the harness manager by
-- hand, so it exists in that one database and in NO migration.
--
-- The cost was not cosmetic. 064 APPENDS the landing half to this note and no-ops when the note is
-- absent, and test/land-withdraw.test.mjs asserts on the result — so on a database that has only
-- ever seen migrations, three assertions fail and "is the suite green?" has no answer. Every cxell
-- database is exactly that: fresh, migrated, never hand-edited. Two zees in a row hit it, diagnosed
-- it, and worked around it locally; that is the signal to fix it rather than document it.
--
-- So the note is seeded here IN FULL — the human's original words, kept verbatim (their phrasing,
-- their typos: it is their note), plus the landing half 064 appends and the holding half the runway
-- (067/068) adds. On a database that already has it, this is a NO-OP: guarded on the entry existing
-- at all, so a hand-edited note is never overwritten by this migration.
--
-- Ordering note: 064 runs BEFORE this on a fresh database, finds no note, and returns — which is why
-- the text below must already contain what 064 would have appended. On an existing database 064
-- already ran against the human's row and this does nothing. Both paths end at the same text.
DO $$
DECLARE
  has_note boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') AS a(e)
     WHERE h.key = 'zee-base' AND a.e->>'path' = 'tend-or-land.md') INTO has_note;
  IF has_note THEN RETURN; END IF;

  UPDATE harness
     SET bundle = jsonb_set(bundle, '{memory}',
           COALESCE(bundle->'memory', '[]'::jsonb)
           || jsonb_build_array(jsonb_build_object('path', 'tend-or-land.md', 'text', $note$please always check if your tend request is still relevant or not. if you've been tended, then revoke your tend request... if you need to land, then do so instead of asking for a tend request... if you are done then just set your status stop using unecessary tend requests.

and the same goes for a LAND request, now that one can be taken back: if you have asked to land and it is no longer what you mean — you found a bug in what you pushed, the work grew, you are about to push a newer commit — then WITHDRAW the open one (`zee land --withdraw --reason "…"`) instead of leaving it standing or stacking a second card on top of it. ONE open landing per zee: a human should only ever have one card from you to decide, and when there are three they cannot tell which one you still mean. Withdrawing decides nothing — nothing lands, nothing is rejected, no sha is burned and your commits stay exactly where they are — so it costs you nothing to keep your asks true. The order is WITHDRAW, then `zee land` again. Two things it is not: an APPROVED landing is a human's decision and not yours to retract (that one is `zee tend`), and if you are not sure the work is landable at all, do not raise a request you will only have to withdraw — `zee hint-land` lights the button and leaves the call to them.

and if your push is HOLDING — queued behind another xell's landing on the same ref — that is not an ask at all, so there is nothing to keep true and nobody to chase: no card was raised, no human was asked, and your commits are exactly where you left them. Do NOT raise a tend for it (nobody is blocked), do NOT push again to try to get seen (it only bumps the attempt count on the place you already have), and do NOT withdraw-and-re-land hoping for a better spot (you go to the back of the same queue). You are told your position, a human can see you holding, and the queenzee RESUMES you when the runway clears — then it is `zee sync`, then `zee land`. The only reason to withdraw while holding is that you no longer want to land at all.$note$)))
   WHERE key = 'zee-base';
  RAISE NOTICE 'zee-base: seeded the tend-or-land hygiene note (it had only ever been typed by hand)';
END $$;
