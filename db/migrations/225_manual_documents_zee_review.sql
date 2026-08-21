-- TEACH THE MANUAL ABOUT `zee review` — the first-class record that a landed diff was READ (224).
--
-- A verb that is not in the manual does not exist to a zee: the cxell-zee manual is DB-owned
-- (harness `zee-base`, memory file cxell-zee-manual.md) and reaches a xell only through harness
-- injection, so a new endpoint with no manual line is a door nobody opens. This is the manual half
-- of the review-record work (ticket #56): the schema is 224, the server verb is selfReview in
-- queenzee/self.js, the CLI case is in scripts/zee, and THIS migration is what makes a zee know any
-- of it exists.
--
-- Two things go in:
--   1. the verb — `zee review --of <sha>` records that a landed diff was read and what the reader
--      concluded, and it is NOT a gate: nothing on the land/ship path waits on it;
--   2. the boundary — a review names a full 40-char commit sha, a verdict (clean | changes-required),
--      a findings count and the report text. It is a record, not a request: no human approves it,
--      nothing ships or lands because of it, and the landing/ship cards surface it so a ship of an
--      UNREVIEWED change is a decision a human makes knowingly, not by accident.
--
-- Surgical and idempotent by guard (the 220/223 pattern): harness_memory_get/_put BY PATH (076,
-- house rule 9), anchored replacements inside the stored text, applied only if the manual does not
-- already carry them. The body-section seam is the START of the `### The REFLECTION stage` heading,
-- just after the `### zee report` section — never inside 059's protected verb-table block. A human
-- who moved the anchor gets a NOTICE, never a half-rewritten manual.
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  verb_line text;
  body      text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'zee manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF txt LIKE '%zee review --of%' THEN
    RAISE NOTICE 'zee manual: `zee review` is already documented — nothing to do';
    RETURN;
  END IF;

  -- (a) the verb table — right after the `zee inbox` line, in the "crew" block.
  verb_line := 'zee inbox [--all]                                 # read what other zees sent you';
  IF position(verb_line IN txt) > 0 THEN
    txt := replace(txt, verb_line,
      verb_line || E'\n'
      || E'zee review --of <sha> [--verdict clean|changes-required] [--findings N] [--report "…"]  # RECORD a review of a landed diff — the fact that someone READ it, not a gate');
    changed := true;
  ELSE
    RAISE NOTICE 'zee manual: the `zee inbox` verb-table line has moved — the zee review line was not added';
  END IF;

  -- (b) the body section — inserted before `### The REFLECTION stage`, right after the report section.
  body := $hz$
### `zee review` — record that a landed diff was read, and what the reader found
`POST /api/xell/self/review` `{ commit, verdict, findings_count, report }`. A review is a first-class
record: WHO reviewed a landed commit, what they concluded (`clean` / `changes-required`), how many
concrete findings they wrote down, and the report text. `zee review --of <sha> --verdict clean
--findings 0 --report "…"` records it. It is **NOT a gate** — nothing on the landing or ship path
waits on it, and recording one must never slow a landing. Its job is the opposite of a gate: a
landing or ship card now shows whether the code has been READ and by whom, so shipping an
unreviewed change is a decision a human makes knowingly, not by accident.

The `--of <sha>` is a full 40-char commit sha — the tip of the landed diff you read (a landing's
`new_sha`, a ship's `commit`). `--verdict` is `clean` or `changes-required`, `--findings N` is the
number of findings you recorded, `--report "…"` is the text (a heredoc for anything long — the shell
safety rule above). Re-reviewing the same sha after a fix records a NEW review; the cards show the
newest first, so an updated verdict supersedes an earlier one visually while both stay in the ledger.

$hz$;
  -- The seam: the `### The REFLECTION stage` heading, which follows `### zee report` in the manual.
  IF position(E'### The REFLECTION stage — after your work ships' IN txt) > 0 THEN
    txt := replace(txt,
      E'### The REFLECTION stage — after your work ships',
      body || E'### The REFLECTION stage — after your work ships');
    changed := true;
  ELSE
    RAISE NOTICE 'zee manual: the REFLECTION-stage heading has moved — the zee-review paragraph was not added';
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'zee manual: `zee review` is now documented';
  ELSE
    RAISE NOTICE 'zee manual: nothing to patch (the anchors did not match)';
  END IF;
END $$;
