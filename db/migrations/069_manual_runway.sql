-- TEACH THE WORKER MANUAL THE RUNWAY — that a push can be QUEUED, and that queued is safe.
--
-- 067/068 gave the landing gate a holding pattern: while another xell's landing is open on the ref,
-- your push is not raised as a second card, it waits with a position and you are RESUMED when the
-- runway clears. That is a state a zee can land in, and the golden rule of this manual is that a
-- state a zee can land in must be a state the zee is TOLD about — otherwise it meets `holding` for
-- the first time in an answer it did not expect, and the reasonable-looking reactions are all wrong:
-- push again (it just bumps attempts), withdraw and re-land (same queue, back of the line), raise a
-- tend (nobody is blocked), or conclude the gate is broken and go looking for a way round it.
--
-- It goes in right after the STALE paragraph (065) on purpose: the two are the same lesson from
-- opposite ends — stale is the failure the runway exists to PREVENT, and both recover with the same
-- two steps. A zee that has read one should read the other in the same breath.
--
-- Surgical and idempotent by guard (the 063/065 pattern): one anchored replacement inside the stored
-- text, applied only if the manual does not already explain the holding pattern, and the guard
-- matches text this migration ITSELF writes — so a re-run past the ledger is a no-op, not a second
-- copy. The anchor is an exact line 065 wrote; if a human has edited it in the harness manager the
-- replacement simply DOES NOT FIRE and their text is left alone.
DO $$
DECLARE
  idx int;
  txt text;
BEGIN
  SELECT (a.i - 1), a.e->>'text' INTO idx, txt
    FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') WITH ORDINALITY AS a(e, i)
   WHERE h.key = 'zee-base' AND a.e->>'path' = 'cxell-zee-manual.md'
   LIMIT 1;
  IF txt IS NULL OR txt LIKE '%HOLDING PATTERN%' THEN RETURN; END IF;

  txt := replace(txt,
    E'the queenzee cannot reach you it raises a `tend` so a human picks it up instead.)',
    E'the queenzee cannot reach you it raises a `tend` so a human picks it up instead.)\n'
    || E'\n'
    || E'**If your push goes into the HOLDING PATTERN, nothing is wrong.** There is ONE RUNWAY per ref:\n'
    || E'while another xell''s landing is open on main, your push is not raised as a second card — it is\n'
    || E'recorded and QUEUED, and `zee land` tells you your position and who is ahead of you. That is\n'
    || E'deliberate, and it is there to protect YOU: two landings on one ref means a human approves the\n'
    || E'first, the ref moves, and the second can never fast-forward again — the STALE death above. The\n'
    || E'queue is how you stop meeting it.\n'
    || E'\n'
    || E'What `holding` means, exactly: nothing was rejected, nothing was dropped, no sha was burned, your\n'
    || E'commits are untouched on your branch, and **no human has been asked anything yet** — there is no\n'
    || E'card on anyone''s screen for you. So there is nothing to chase and nothing to poll: `zee land\n'
    || E'--wait` prints your position and EXITS rather than waiting for a decision nobody is making.\n'
    || E'\n'
    || E'When the runway clears — the landing ahead of you lands, is rejected, is withdrawn or goes stale —\n'
    || E'the queenzee RESUMES YOUR SESSION with your CLEARANCE, and the recovery is the same two steps as a\n'
    || E'stale landing, in the same order: **`zee sync`** (the xell ahead of you probably just landed, so\n'
    || E'main has moved — merge it in, resolve any conflict, `git add`, `git commit`, and re-verify with\n'
    || E'`zee build … --wait` if the merge touched your change), then **`zee land`**, which raises the FRESH\n'
    || E'request a human actually decides on. **Being cleared is not being approved**: nobody has read your\n'
    || E'commits yet, and the fresh push is gated exactly like any other.\n'
    || E'\n'
    || E'So while you are holding: keep working, or stop — both are fine. Do NOT push again (it only bumps\n'
    || E'the attempt count on the place you already have), do NOT raise a `tend` (nobody is blocked and no\n'
    || E'human is needed), and do NOT try to get in front of the xell ahead of you. If you no longer want\n'
    || E'the landing at all, **`zee land --withdraw --reason "…"`** takes you out of the pattern — the same\n'
    || E'verb, and the same meaning, as un-asking a held card. On your hexagon a human sees you as\n'
    || E'`holding`, with your position and how many commits are waiting, so you are not invisible while you\n'
    || E'wait: they can see the queue their decision is holding up.');

  UPDATE harness SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(txt))
   WHERE key = 'zee-base';
  RAISE NOTICE 'cxell-zee manual: taught the runway/HOLDING PATTERN and the clearance go-around';
END $$;
