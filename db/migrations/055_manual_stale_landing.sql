-- TEACH THE WORKER MANUAL WHAT A **STALE** LANDING IS — and that the recovery is `zee sync`.
--
-- The cxell-zee manual lives in the meta DB (047) and reaches a xell only through harness injection,
-- so a STATE that is not written HERE is a state the worker meets for the first time in a nudge it
-- did not expect. The queenzee now resumes a zee whose landing went stale ("main moved past your
-- sha — `zee sync`, then `zee land` again"); the manual's landing section stopped at "re-run after
-- approval", which is the one instruction that CANNOT work for a stale sha. A zee reading only that
-- either re-pushes the dead sha or amends to dodge a gate it thinks is stuck.
--
-- So: name the state, say the commits are safe, and give the two-step recovery in the same words the
-- nudge uses (server/src/queenzee/nudge.js → STALE_PROMPT).
--
-- Surgical and idempotent by guard, exactly as 053: an anchored replacement inside the manual text,
-- applied only if the manual does not already explain a stale landing. The anchor is an exact line
-- from 047/050 — if a human has since edited it in the harness manager, this simply does not fire
-- and leaves their text alone.
DO $$
DECLARE
  txt text;
  mem jsonb;
BEGIN
  SELECT bundle->'memory'->0->>'text' INTO txt FROM harness WHERE key='zee-base';
  -- The guard matches text this migration ITSELF writes (as 053's did), so a re-run is a no-op even
  -- outside the ledger — not a second copy of the paragraph.
  IF txt IS NULL OR txt LIKE '%goes STALE%' THEN RETURN; END IF;

  txt := replace(txt,
    E'force a merge; that means something moved underneath you — check with a human.',
    E'force a merge; that means something moved underneath you — check with a human.\n'
    || E'\n'
    || E'**If your landing goes STALE**, it did not land and it never will: main moved on while your push\n'
    || E'waited (another zee landed first), so the sha a human approved can no longer fast-forward — and an\n'
    || E'approval is bound to ONE exact sha. Nothing is lost; every commit is still on your branch. The\n'
    || E'queenzee closes the request, RESUMES YOUR SESSION to tell you, and the recovery is two steps:\n'
    || E'**`zee sync`** (merge current main into your branch — resolve any conflict it leaves you, `git add`,\n'
    || E'`git commit`, and re-verify with `zee build … --wait` if the merge touched your change), then\n'
    || E'**`zee land`** again, which raises a FRESH request on the new sha. A new decision on new content is\n'
    || E'expected, not a setback. Do NOT re-push the dead sha and do NOT amend/force to get around the gate.\n'
    || E'(`zee land --wait` and `zee status --wait` both exit on `stale` with the same instruction, and if\n'
    || E'the queenzee cannot reach you it raises a `tend` so a human picks it up instead.)');

  mem := jsonb_build_array(jsonb_build_object('path', 'cxell-zee-manual.md', 'text', txt));
  UPDATE harness SET bundle = jsonb_set(bundle, '{memory}', mem) WHERE key='zee-base';
  RAISE NOTICE 'cxell-zee manual: taught what a STALE landing is and that `zee sync` is the recovery';
END $$;
