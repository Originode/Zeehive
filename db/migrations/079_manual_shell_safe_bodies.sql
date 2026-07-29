-- COMPOSING A LONG BODY THE SHELL WILL NOT EXECUTE — three incidents, three zees, one afternoon.
--
-- Every one of them wrote a report body inside a DOUBLE-quoted shell string with backticks around a
-- command name, and bash ran the command substitution. Once it invoked the ship verb, once build
-- (which RAN and mangled the sentence it was in), and a third put an apostrophe inside a
-- single-quoted `git commit -m` and closed the quote early.
--
-- The reason this is worth a manual note rather than three shrugs: the two verbs that were invoked
-- refused ONLY because they happen to require an argument. `zee land` does not. The same slip around
-- it raises a real landing request on a human's screen from a zee that never meant to ask.
--
-- Whether a gated verb should refuse a bare invocation is ticket #17 and a human's decision. This
-- migration is documentation, and nothing else.
--
-- FORM: 077's shape — anchored, guarded, idempotent. The guard matches text this file itself writes,
-- so a re-run past the ledger is a no-op; the anchor is an exact line of the stored manual, so if a
-- human has edited that paragraph in the harness manager the replacement simply DOES NOT FIRE and
-- their words are left alone. It goes through 076's `harness_memory_get`/`harness_memory_put`, which
-- locate the entry BY PATH — the array is never rebuilt, so no sibling memory file can be lost.
--
-- SUPERSEDED BY 080 (kept as the record of what this migration did, and of what was true when it ran):
-- the paragraph below describes the manager harness as FILE-BACKED, which stopped being true at 080.
-- Every harness now lives entirely in the meta-DB — `harnesses/` is gone, `harness.dir` is NULL and
-- `lib/harness.js` reads no filesystem (CLAUDE.md house rule 10) — so patching the MANAGER manual is a
-- migration exactly like patching zee-base's, not a repo file edit, and nothing overwrites it at boot.
-- This misled a reader in ticket #31; 088 is the manager-side put it should have been.
--
-- Only the `zee-base` manual is patched here. The MANAGER manual is file-backed
-- (harnesses/manager/, refreshHarnesses reloads it from the folder at every boot), so its copy of
-- this note lives in that FILE — a DB write to it would be overwritten on the next boot.
DO $$
DECLARE
  txt  text;
  done text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL OR txt LIKE '%the shell will not execute%' THEN RETURN; END IF;

  txt := replace(txt,
    E'gated — this is the ONE reach outside your own xell you are meant to have.',
    E'gated — this is the ONE reach outside your own xell you are meant to have.\n'
    || E'\n'
    || E'**Compose a long body so the shell will not execute it.** Backticks inside a DOUBLE-quoted\n'
    || E'shell string are a command substitution: bash RUNS what you meant to name. Put a report, a\n'
    || E'tend reason or any multi-line text in a QUOTED heredoc (`<<''EOF''`) or single quotes, and name\n'
    || E'commands without backticks when you are inside double quotes. Same for git: a commit message\n'
    || E'that is multi-line or contains an apostrophe uses `git commit -F` with a quoted heredoc, never\n'
    || E'`-m`. This has already fired three times: it invoked the ship verb once and the build verb\n'
    || E'once, and both were refused only because those verbs REQUIRE an argument — `zee land` does\n'
    || E'not, so the same slip there raises a real landing request you never meant to ask for.');

  done := harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'cxell-zee manual (%): compose a long body the shell will not execute', done;
END $$;
