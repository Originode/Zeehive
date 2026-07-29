-- FIRST USER OF `harness_memory_put` — and a real manual edit: a test that fails right after a sync
-- is a DATABASE question before it is a bug.
--
-- The content: a cxell's database is a CLONE cut at some earlier commit's schema, and `zee sync`
-- moves the CODE only — nothing drags the database along with it. So the suite goes red on
-- migrations the zee's own db has never applied, and the failure reads like a broken test. It has
-- cost real zees real hours (twice in one day at the time of writing), and the manual's db-catchup
-- section explained the verb without ever naming the symptom that should send you to it.
--
-- The FORM is the point of this file. This is exactly the surgical, guard-anchored edit that 063 and
-- 065 do by hand — read the entry, replace at an anchor, write it back — except that it never walks
-- `bundle->'memory'` itself: 076's `harness_memory_get`/`harness_memory_put` locate the entry BY
-- PATH, so the array cannot be rebuilt (which is how 050/051/053/056/057/066 deleted the sibling
-- `tend-or-land.md` note out of the live meta-DB) and no future author has to remember not to.
-- Every manual migration from here on is written this way; the lint in
-- test/harness-memory-migrations.test.mjs fails any that is not.
--
-- Idempotent by guard in the 065 sense: the guard matches text this migration ITSELF writes, so a
-- re-run past the ledger is a no-op rather than a second copy, and `put` is a SET at a path, never
-- an append to the array. The anchor is an exact line of the stored manual; if a human has edited it
-- in the harness manager the replacement simply DOES NOT FIRE and their text is left alone.
DO $$
DECLARE
  txt  text;
  done text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL OR txt LIKE '%is a db question first%' THEN RETURN; END IF;

  txt := replace(txt,
    E'long-running xell — the same "catch up" instinct as `zee sync`, one layer down.',
    E'long-running xell — the same "catch up" instinct as `zee sync`, one layer down.\n'
    || E'\n'
    || E'**A test that fails right after a sync is a db question first.** `zee sync` moves your CODE;\n'
    || E'nothing moves your DATABASE with it. Your db is a clone cut at some earlier commit''s schema, so\n'
    || E'a suite that was green can go red on migrations your own db has never applied — and it reads\n'
    || E'exactly like a broken test. Check the ledger before you report a bug: run the repo''s migrate\n'
    || E'command (this repo: `npm run db:migrate`), or `zee db-catchup` for prod''s schema, and only then\n'
    || E'trust the failure.');

  done := harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'cxell-zee manual (%): a red suite right after a sync is a db question first', done;
END $$;
