-- The hygiene note gets the HOLDING half — on the databases that already had the note.
--
-- 071 seeds the note in full for a database that never had it (every cxell database: fresh and
-- migration-only). That leaves the opposite case, which is the one running in production: a database
-- where a human typed the note by hand years of migrations ago. 071 will not touch it — deliberately,
-- because overwriting a human's own words is worse than an out-of-date note — so without this the
-- holding paragraph would reach only new databases, and the note a real zee reads would still tell it
-- to keep its asks true without saying that a queued push is not an ask at all.
--
-- APPENDS, in 064's style and for 064's reason: the note is a human's writing, and an anchored
-- replace would either clobber it or stop firing the moment they edit it. Guarded on the paragraph
-- this migration itself writes, so it runs at most once — and it is the SAME text 071 seeds, so a
-- database that took the 071 path and one that took this path end up identical.
DO $$
DECLARE
  idx int;
  txt text;
BEGIN
  SELECT (a.i - 1), a.e->>'text' INTO idx, txt
    FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') WITH ORDINALITY AS a(e, i)
   WHERE h.key = 'zee-base' AND a.e->>'path' = 'tend-or-land.md'
   LIMIT 1;
  IF txt IS NULL OR txt LIKE '%your push is HOLDING%' THEN RETURN; END IF;

  txt := txt || E'\n\n' || $note$and if your push is HOLDING — queued behind another xell's landing on the same ref — that is not an ask at all, so there is nothing to keep true and nobody to chase: no card was raised, no human was asked, and your commits are exactly where you left them. Do NOT raise a tend for it (nobody is blocked), do NOT push again to try to get seen (it only bumps the attempt count on the place you already have), and do NOT withdraw-and-re-land hoping for a better spot (you go to the back of the same queue). You are told your position, a human can see you holding, and the queenzee RESUMES you when the runway clears — then it is `zee sync`, then `zee land`. The only reason to withdraw while holding is that you no longer want to land at all.$note$;

  UPDATE harness SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(txt))
   WHERE key = 'zee-base';
  RAISE NOTICE 'zee-base: the hygiene note now says a HOLDING push is not an ask';
END $$;
