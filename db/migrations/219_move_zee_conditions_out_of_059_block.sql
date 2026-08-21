-- MOVE `zee conditions` OUT OF 059's WORK-TRACKER BLOCK (defect 1), AND LAND THE CHEAT-SHEET
-- LINES 217 MEANT TO ADD (defect 2).
--
-- DEFECT 1 — the RED test/work-assign.test.mjs catches:
--   059's manager block replaces the anchor '### `zee suggest-done` — close a worker out' with a
--   block that STARTS at '## The WORK TRACKER — the plan your crew executes' and ENDS with that same
--   suggest-done heading — so the heading is the LAST LINE INSIDE 059's verbatim replacement.
--   217 does `replace(txt, sec_anchor, section || sec_anchor)` with sec_anchor = that heading, so it
--   inserts the whole `zee conditions` section INSIDE 059's block and splits the verbatim text that
--   test/work-assign.test.mjs asserts is contiguous. THIS IS THE THIRD TIME THIS SHAPE HAS BITTEN
--   (111, 196, then 214 repaired it this morning); 218 shows the correct seam — anchor on
--   E'\n## The WORK TRACKER — the plan your crew executes' and insert BEFORE it.
--
--   FIX: a forward-only migration that MOVES the `zee conditions` section out of 059's block to
--   before the WORK TRACKER heading — the same seam 218 uses. Guarded and idempotent: a database
--   where 217 already ran (every database — 217 < 219) is repaired; a database where a human has
--   already moved it is a no-op; an unexpected layout raises a NOTICE instead of half-rewriting.
--
-- DEFECT 2 — an insert that silently did nothing:
--   217's cheat-sheet inserts anchored on a LEADING SPACE (E' zee work [--board]…' / E' zee meet…')
--   and the stored cheat-sheet lines have none, so position() = 0 and both took the RAISE NOTICE
--   branch. The `zee conditions` line is ABSENT from BOTH the manager and the worker verb tables.
--   A NOTICE in a migration log is not a failure anybody sees — the real lesson.
--
--   FIX: LAND both lines (a manager is the natural author of conditions, and a worker should be able
--   to read them from its cheat-sheet), anchored on the stored no-leading-space lines. The MANAGER
--   line goes AFTER the whole 059 verb-table block (after `zee suggest-done`, which ENDS that block)
--   — deliberately NOT after `zee work` where 217 aimed, because that would split 059's verbatim
--   four-line block all over again. The WORKER line goes after `zee meet`, exactly where 217 aimed.
--
-- House rule 9: every write goes through harness_memory_get/_put BY PATH — never a hand-rolled jsonb
-- against harness.bundle (test/harness-memory-migrations.test.mjs fails anything that does).
DO $mig$
DECLARE
  txt       text;
  changed   boolean := false;
  section   text;   -- the manager conditions section 217 wrote (moved, never edited)
  sd_heading text := E'### `zee suggest-done` — close a worker out';
  wt_anchor text  := E'\n## The WORK TRACKER — the plan your crew executes';
  wt_heading text := E'## The WORK TRACKER — the plan your crew executes';
  sd_cheat  text;   -- the stored manager cheat-sheet line that ENDS 059's verb-table block
  cond_cheat text;  -- the manager cheat-sheet line to land (no leading space — the stored style)
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- The section EXACTLY as 217 wrote it (217 is immutable; this is its $hz$ value verbatim).
  section := $hz$### `zee conditions` — curate your project's CURRENT CONDITIONS

The project's current conditions are the short, dated list of LIVE IMPEDIMENTS injected into every
worker's briefing (ticket #67). You are the natural author: you watch your crew hit these all
evening. When a worker reports a broken environment it cannot fix (a dead DSN, a port it cannot
see, a red test that is not its change), ADD a line here — dated, with a ticket ref — so the next
worker does not rediscover it. The moment a line stops being true, DELETE it: stale conditions are
worse than none, and this list must never become a second manual.

```
zee conditions                          # read the current list (as it is injected)
zee conditions --add "…"                # ADD a line (a human can also edit in the console)
zee conditions --remove <id>            # DELETE a line — trivial on purpose
```

The write is MANAGER-only (`requireManager`), scoped to YOUR project by your token — the same wall
as `zee work --new`. It opens no gate and touches nothing irreversible: it is a line of text in the
meta-DB that the next briefing renders.

$hz$;

  -- DEFECT 1 — move the section out of 059's WORK TRACKER block.
  IF position(section IN txt) > 0 AND position(section IN txt) < position(wt_heading IN txt) THEN
    RAISE NOTICE 'manager manual: the zee conditions section already precedes the WORK TRACKER — nothing to move';
  ELSE
    IF position(section || sd_heading IN txt) > 0 THEN
      txt := replace(txt, section || sd_heading, sd_heading);   -- out of 059's block
      changed := true;
    ELSE
      RAISE NOTICE 'manager manual: the zee conditions section is neither before the WORK TRACKER nor inside 059''s block — check by hand';
    END IF;
    IF changed THEN
      IF position(wt_anchor IN txt) > 0 THEN
        txt := replace(txt, wt_anchor, E'\n' || section || wt_anchor);   -- before the WORK TRACKER heading
      ELSE
        RAISE NOTICE 'manager manual: the WORK TRACKER heading has moved — the conditions section was removed but not re-inserted; check by hand';
      END IF;
    END IF;
  END IF;

  -- DEFECT 2 — land the MANAGER cheat-sheet line AFTER the 059 verb-table block (after the
  -- suggest-done line that ends it), never between 059's work/assign/item/suggest-done lines.
  cond_cheat := E'zee conditions [--add "…" | --remove <id>]   # YOUR PROJECT''S CURRENT CONDITIONS — the dated list of live impediments injected into every briefing; ADD lines as your crew hits them, DELETE lines the moment they stop being true';
  IF position(cond_cheat IN txt) = 0 THEN
    sd_cheat := E'zee suggest-done --to <slug> --reason "…"    # ask a human to mark that xell done (they confirm)';
    IF position(sd_cheat IN txt) > 0 THEN
      txt := replace(txt, sd_cheat, sd_cheat || E'\n' || cond_cheat);
      changed := true;
    ELSE
      RAISE NOTICE 'manager manual: the suggest-done cheat-sheet line has moved — the conditions verb line was not added';
    END IF;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
    RAISE NOTICE 'manager manual: moved zee conditions out of the WORK TRACKER block and landed its verb line';
  ELSE
    RAISE NOTICE 'manager manual: zee conditions already in place — nothing to do';
  END IF;
END $mig$;

-- ── the WORKER manual: land the `zee conditions` READ line 217 meant to add ──
DO $mig$
DECLARE
  txt       text;
  changed   boolean := false;
  meet_line text := E'zee meet create --title "…" | attend <code> | say <code> --message "…"        # GROUP CHAT: start a room (prints the code), join a room by code, post to a room — the "peer to peer a2a chat" verb (docs/zee-meet-plan.md)';
  verbline  text := E'zee conditions                                # YOUR PROJECT''S CURRENT CONDITIONS: the short, dated list of LIVE IMPEDIMENTS injected into every briefing — read it any time, and trust it over any doc that is older than it is (NOT gated)';
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF position(verbline IN txt) = 0 THEN
    IF position(meet_line IN txt) > 0 THEN
      txt := replace(txt, meet_line, meet_line || E'\n' || verbline);
      changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee meet cheat-sheet line has moved — the conditions verb line was not added';
    END IF;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: landed the zee conditions verb line';
  ELSE
    RAISE NOTICE 'worker manual: zee conditions verb line already present — nothing to do';
  END IF;
END $mig$;
