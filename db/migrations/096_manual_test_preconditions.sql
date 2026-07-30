-- IF AN ASSERTION DEPENDS ON A PRECONDITION, THE PRECONDITION BELONGS IN THE TEST.
--
-- Three zees hit this from three directions in one day, and every time the failure named the wrong
-- cause:
--   • eighteen reds right after a sync that were unapplied migrations, not code (already covered by
--     the note this one is anchored to);
--   • a "flaky" calibration that was stale planner statistics — it had been measured on a
--     freshly-analyzed database and never said so, and chasing it turned up a FALSE "data is missing"
--     that would have fired in production;
--   • a 50ms wall-clock assertion that failed once at 90ms on a loaded box and passed at 11ms and 5ms
--     minutes later, so a real regression there would have read as intermittency.
--
-- The cost is not the red. It is that a precondition living in the author's head reads as
-- INTERMITTENCY to everyone else — and intermittency is what gets a genuine red waved through.
--
-- FORM: 077/079's shape — anchored, guarded, idempotent, through 076's harness_memory_put so the
-- memory array is never rebuilt. The anchor is the tail of the db-catchup note, whose sibling this is;
-- if a human has edited that paragraph the replacement does not fire and their words are left alone.
DO $$
DECLARE
  txt  text;
  done text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL OR txt LIKE '%the precondition belongs IN the test%' THEN RETURN; END IF;

  txt := replace(txt,
    E'command (this repo: `npm run db:migrate`), or `zee db-catchup` for prod''s schema, and only then\ntrust the failure.',
    E'command (this repo: `npm run db:migrate`), or `zee db-catchup` for prod''s schema, and only then\n'
    || E'trust the failure.\n'
    || E'\n'
    || E'**And if an assertion depends on a precondition, the precondition belongs IN the test.** Fresh\n'
    || E'planner statistics, an idle box, a migrated database: state it, assert it, or measure something\n'
    || E'that does not need it. A wall-clock threshold measures how busy the machine is — if what you mean\n'
    || E'is "this did not block", assert THAT (it returned a value, not a promise; the probe had not run\n'
    || E'yet). An estimate-vs-exact comparison needs an `ANALYZE` first, and should say so where it\n'
    || E'compares. A precondition kept in your head reads as INTERMITTENCY to the next zee, and\n'
    || E'intermittency is how a genuine red gets waved through. Never widen a threshold to get green:\n'
    || E'if it is wrong, say what it should measure instead.');

  done := harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'cxell-zee manual (%): a precondition belongs in the test, not in the author''s head', done;
END $$;
