-- TEACH THE WORKER MANUAL: `zee sync` and `zee land` may carry a note naming sibling landings that
-- touched the files this zee changed (ticket #77).
--
-- WHY: the landing-overlap read model (lib/work-overlap.js) already warns a DISPATCH path when a
-- brief names files a recent landing touched (tickets #33/#64), and 218 taught the manager manual
-- that warning. This is the other end: when a zee runs `zee sync` or `zee land`, the answer now
-- carries a best-effort note listing recent sibling landings on main that touched files the zee
-- itself has changed on its branch. A verb answer that can carry that and the manual says nothing
-- about it is a note nobody has been told to read — house rule 8: what a zee is told moves with
-- the code, and a warning that fires on one path and not the others is a warning people learn to
-- trust wrongly.
--
-- SURGICAL AND GUARDED per house rule 9 — harness_memory_get/_put BY PATH (076), never a
-- hand-rolled jsonb against the memory array (test/harness-memory-migrations.test.mjs fails
-- anything that does). One STANDALONE section placed BEFORE the `zee db-catchup` heading — the end
-- of the `zee sync` section, the closest seam to where a zee reads about the two verbs that carry
-- the note. An anchor a human has moved makes the insertion not fire and says so with a NOTICE,
-- never a half-rewritten manual.
--
-- IDEMPOTENT: the edit guards on the new text already being present. Running this file twice (past
-- the ledger, or on a database that already has the section) is a no-op.
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  addition  text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'zee manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF txt LIKE '%The sibling-landing note — read it, never trust it to be the whole story%' THEN
    RAISE NOTICE 'zee manual: the sibling-landing note is already documented — nothing to do';
    RETURN;
  END IF;

  addition := $hz$
### The sibling-landing note — a warning on `zee sync` and `zee land` that is never a block

Both verbs may answer with a short note naming RECENT LANDINGS on main that touched files YOU have
changed on your branch. It is **INFORMATION, never a block**: nothing about it can refuse a sync or
a land, and a clean merge is the absence of OVERLAPPING LINES, not agreement. When it names a
sibling landing, `git show <sha>` says exactly what that landing changed — so you extend it rather
than fight it. The note is computed best-effort and may say so when the answer is only PARTIAL; a
failure on its side means fewer warnings, never a sync that did not happen or a land that was
refused. If it names a sha you have not read, read it before you land — two zees on one file is
ordinary, two zees on one PROBLEM is a duplicate nobody sees until it lands.

$hz$;
  -- Insert before the `zee db-catchup` heading — the end of the `zee sync` section (the closest
  -- seam to the two verbs that carry the note; never inside 059's WORK TRACKER replacement or any
  -- section whose bytes other tests assert verbatim).
  IF position(E'### `zee db-catchup` — catch your database up to prod''s schema' IN txt) > 0 THEN
    txt := replace(txt, E'### `zee db-catchup` — catch your database up to prod''s schema',
                        E'\n' || addition || E'### `zee db-catchup` — catch your database up to prod''s schema');
    changed := true;
  ELSE
    RAISE NOTICE 'zee manual: the zee db-catchup heading has moved — the sibling-landing note was not added';
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'zee manual: the sibling-landing note is now documented';
  ELSE
    RAISE NOTICE 'zee manual: nothing to patch (the sibling-landing note was already there)';
  END IF;
END $$;
