-- The one-line VERB LIST at the top of the worker manual, taught the same thing 069 taught the prose.
--
-- Separate from 069 because it is a separate anchor with a separate failure mode: a zee skimming the
-- verb table for "what does land do" must not read a description that stops at "gated push to main"
-- when the honest answer is "…or a place in the queue". Kept to one line, in the table's voice.
--
-- Guarded on its own text, so it is idempotent independently of 069 — if a human has rewritten the
-- verb table, the anchor does not match, nothing fires, and their table survives.
DO $$
DECLARE
  idx int;
  txt text;
BEGIN
  SELECT (a.i - 1), a.e->>'text' INTO idx, txt
    FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') WITH ORDINALITY AS a(e, i)
   WHERE h.key = 'zee-base' AND a.e->>'path' = 'cxell-zee-manual.md'
   LIMIT 1;
  IF txt IS NULL OR txt LIKE '%or QUEUE behind%' THEN RETURN; END IF;

  txt := replace(txt,
    E'zee land                                         # collect commits + gated push to main (ONLY when 100% certain)',
    E'zee land                                         # collect commits + gated push to main (ONLY when 100% certain)\n'
    || E'                                                 #   …or QUEUE behind the xell already landing: ONE runway per ref.\n'
    || E'                                                 #   Holding is normal — you are told your position and RESUMED when it clears.');

  UPDATE harness SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(txt))
   WHERE key = 'zee-base';
  RAISE NOTICE 'cxell-zee manual: the verb list now says `zee land` can queue';
END $$;
