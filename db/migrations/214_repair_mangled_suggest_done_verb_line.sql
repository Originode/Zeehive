-- REPAIR THE MANGLED `zee suggest-done` VERB LINE IN THE MANAGER MANUAL.
--
-- WHY: 111_xource_clean_request.sql inserted its `zee xource-clean` verb line by anchoring on
-- `zee suggest-done --to <slug> --reason "…"` — the COMMAND PREFIX of 059's verb-table line,
-- not the whole line. PostgreSQL's replace() swaps every occurrence of that prefix, so the
-- command was split from its `# ask a human to mark that xell done (they confirm)` comment and
-- the comment was stranded at the end of the xource-clean line:
--
--     zee suggest-done --to <slug> --reason "…"
--     zee xource-clean --reason "…"            # ask a HUMAN … ship    # ask a human to mark that xell done (they confirm)
--
-- Two rehab workers each hit the resulting 3 red work-assign tests in a fresh meta-DB and
-- reached different diagnoses. The reproduction is unambiguous: applying 001–110 leaves the
-- line intact; applying 111 mangles it (verified by building the manual incrementally).
--
-- ALSO: 196_manager_manual_documents_zee_dep_chain_verb.sql correctly inserted `zee dep` after
-- `zee item` — but that lands between 059's verb block lines (`work`, `assign`, `item`,
-- `suggest-done`), so the block 059 wrote is no longer CONTIGUOUS and
-- test/work-assign.test.mjs's "what 059 writes is VERBATIM" assertion can never pass. The dep
-- line is legitimate; it moves to directly after `zee suggest-done` so the work-tracker verbs
-- stay grouped AND 059's block is contiguous again.
--
-- FORM: 076's harness_memory_get/_put — by PATH, guarded, idempotent, every sibling memory
-- entry preserved (house rule 9; test/harness-memory-migrations.test.mjs fails anything that
-- hand-rolls it). Each edit is guarded on its own text and is a no-op when already applied.
DO $mig$
DECLARE
  txt        text;
  changed    boolean := false;
  -- 111's mangle: the suggest-done command line lost its comment, which was stranded at the
  -- end of the xource-clean line.
  old_mangle text := E'zee suggest-done --to <slug> --reason "…"\n'
                  || E'zee xource-clean --reason "…"            # ask a HUMAN to clean up the project''s xource (the main checkout) — a mangled xource blocks EVERY landing and ship    # ask a human to mark that xell done (they confirm)';
  new_fixed  text := E'zee suggest-done --to <slug> --reason "…"    # ask a human to mark that xell done (they confirm)\n'
                  || E'zee xource-clean --reason "…"            # ask a HUMAN to clean up the project''s xource (the main checkout) — a mangled xource blocks EVERY landing and ship';
  -- 196's dep line between 059's block lines: move it after `zee suggest-done`.
  old_order  text := E'zee item <id> --status <s> [--progress N] [--note "…"]   # move a card in your project''s plan\n'
                  || E'zee dep --item <dependent-id> --on <prerequisite-id> [--remove]   # CHAIN two cards: --item waits for --on (a dependency edge — nesting says part-of, a chain says after)\n'
                  || E'zee suggest-done --to <slug> --reason "…"    # ask a human to mark that xell done (they confirm)';
  new_order  text := E'zee item <id> --status <s> [--progress N] [--note "…"]   # move a card in your project''s plan\n'
                  || E'zee suggest-done --to <slug> --reason "…"    # ask a human to mark that xell done (they confirm)\n'
                  || E'zee dep --item <dependent-id> --on <prerequisite-id> [--remove]   # CHAIN two cards: --item waits for --on (a dependency edge — nesting says part-of, a chain says after)';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF position(old_mangle IN txt) > 0 THEN
    txt := replace(txt, old_mangle, new_fixed); changed := true;
  ELSIF position(new_fixed IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: the suggest-done/xource-clean verb lines are neither mangled nor repaired — check them by hand';
  END IF;

  IF position(old_order IN txt) > 0 THEN
    txt := replace(txt, old_order, new_order); changed := true;
  ELSIF position(new_order IN txt) = 0 AND position(E'zee dep --item <dependent-id> --on <prerequisite-id> [--remove]' IN txt) > 0 THEN
    RAISE NOTICE 'manager manual: the zee dep verb line is present but not where this migration looks — check the verb table by hand';
  END IF;

  IF NOT changed THEN
    RAISE NOTICE 'manager manual: suggest-done line already repaired and zee dep already after it — nothing to do';
    RETURN;
  END IF;

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: repaired the mangled zee suggest-done verb line and restored 059''s verb block';
END $mig$;
