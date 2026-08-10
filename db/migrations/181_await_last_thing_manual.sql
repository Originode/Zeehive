-- WELD FIX — the manual updates that shipped with the review fixes.
--
-- The review of the landed weld stage changed the BEHAVIOUR of the two verbs beyond what
-- migration 180 documented:
--   • `zee handover` now REFUSES to overwrite a result already on execution.outputs unless
--     the caller passes --override (the append-only event log keeps the history of every
--     handover — migration 180's text described a bare overwrite);
--   • `zee await` ENDS the turn but cannot make the process stop — the zee MUST treat it as
--     the last thing it does in the turn, or tokens keep burning while the ledger says the
--     turn is over (the exact lie the anti-spin primitive exists to remove).
--
-- House rule 8 — what a zee is told is versioned like code. The CLI usage (scripts/zee) and
-- this manual text move together; the drift lint's §e checks the VERBS are documented (180
-- already documents them), and this migration keeps the SECTION faithful to the behaviour.
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry
-- preserved (house rule 9; test/harness-memory-migrations.test.mjs fails anything that
-- hand-rolls it). Same shape as 180, which documented the verbs in the first place. Each
-- edit is guarded on its own anchor; a moved anchor does not half-edit (the section bullet
-- falls back to an append so the verb is documented on any database, and says so with a
-- NOTICE). Re-applying on a database whose manual already carries the text is a no-op.
DO $mig$
DECLARE
  txt           text;
  changed       boolean := false;

  -- the CLI cheat-sheet lines (next to their neighbours, exactly as 180 wrote them)
  cs_handover_old text := E'zee handover --result <json>                        # store your typed result on the execution you are on (interim, until the data plane)\n';
  cs_handover_new text := E'zee handover --result <json> [--override]                # store your typed result on the execution you are on (interim, until the data plane) — refused if outputs already has one unless --override\n';
  cs_await_old    text := E'zee await [--for <hours>]                            # END your turn, hold a lease, mark the execution waiting (the anti-spin primitive)\n';
  cs_await_new    text := E'zee await [--for <hours>]                            # END your turn, hold a lease, mark the execution waiting (the anti-spin primitive) — MUST be the LAST thing you do in this turn\n';

  -- the handover bullet in the section body — append the override sentence
  bullet_handover_old text := E'  it quoted). This is the interim hand-over of "what the work produced".\n';
  bullet_handover_new text := E'  it quoted). This is the interim hand-over of "what the work produced".\n  A SECOND handover is REFUSED while `execution.outputs` already has a result unless you pass\n  `--override` — the mutable column stays "the latest", and the append-only event log keeps the\n  history of every handover.\n';

  -- the await bullet anchor + the "MUST be the last thing" paragraph (as applied)
  bullet_await_old text := E'  over the queenzee resumes the work. A turn with no execution is refused — there is nothing to hold.\n';
  section         text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. cheat-sheet: handover gains [--override] + the refusal sentence.
  IF position(cs_handover_new IN txt) = 0 THEN
    IF position(cs_handover_old IN txt) > 0 THEN
      txt := replace(txt, cs_handover_old, cs_handover_new); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee handover cheat-sheet line has moved — the --override flag was not added there';
    END IF;
  END IF;

  -- 2. cheat-sheet: await gains the "MUST be the LAST thing" warning.
  IF position(cs_await_new IN txt) = 0 THEN
    IF position(cs_await_old IN txt) > 0 THEN
      txt := replace(txt, cs_await_old, cs_await_new); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee await cheat-sheet line has moved — the last-thing warning was not added there';
    END IF;
  END IF;

  -- 3. the handover bullet: document the overwrite refusal.
  IF position(bullet_handover_new IN txt) = 0 THEN
    IF position(bullet_handover_old IN txt) > 0 THEN
      txt := replace(txt, bullet_handover_old, bullet_handover_new); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee handover bullet has moved — the --override note was not added';
    END IF;
  END IF;

  -- 4. the await bullet: append the "MUST be the last thing" paragraph (guarded — it is
  --    already present on databases the review patched directly).
  section := $sec$
- **`zee await` MUST be the last thing you do in a turn.** It ENDS the turn — the ledger
  says `ended` the moment it returns, but it cannot make your process stop. If you keep talking (or
  calling tools) after it, the tokens keep burning while the ledger says you are done, and a later
  gateway call would attach to a closed turn. Call it, then STOP. The queenzee resumes you when the
  wait resolves (the lease lapses or is released).
$sec$;
  IF position('`zee await` MUST be the last thing' IN txt) = 0 THEN
    IF position(bullet_await_old IN txt) > 0 THEN
      txt := replace(txt, bullet_await_old, bullet_await_old || section); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee await bullet has moved — appending the last-thing paragraph at the end';
      txt := txt || E'\n' || section; changed := true;
    END IF;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee handover --override and zee await last-thing documented';
  ELSE
    RAISE NOTICE 'worker manual: the weld-fix manual text was already present — nothing to do';
  END IF;
END
$mig$;
