-- THE MANAGER MANUAL: what holding production READ-ONLY does to a manager's OWN workspace.
--
-- Reported by a worker (ticket #15) and true of every manager: the binding is briefed as "read-only
-- production" and nothing more, so the first ordinary developer reflex — migrate, run the suite,
-- start a server — fails at postgres in a way the manual never predicted, and reads as a broken
-- environment instead of the guarantee working.
--
-- WHY THIS IS A MIGRATION AS WELL AS A FILE EDIT. `manager` is file-backed (harness.dir =
-- 'harnesses/manager'), so refreshHarnesses() reloads its bundle from the folder at every boot on a
-- machine that HAS the repo — and `harnesses/manager/memory/manager-zee-manual.md` carries this same
-- section, edited in the same commit. But the row is what `harnessFiles()` injects into a cxell, so
-- a meta-DB whose folder is absent (or whose row a human edited by hand) would never see it. Same
-- reasoning, and the same shape, as 059. Edit BOTH or they drift; the folder wins wherever it exists.
--
-- Anchored + idempotent in the 065/071 sense: it inserts before a heading that appears once, returns
-- early when the section is already there, and goes through harness_memory_put (house rule 9 / 076),
-- so every sibling memory entry survives.
DO $$
DECLARE
  txt text;
  section text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%read-only production means inside YOUR OWN workspace%' THEN
    RAISE NOTICE 'manager manual: the read-only-workspace section is already there';
    RETURN;
  END IF;
  IF position(E'## Your verbs' IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: anchor "## Your verbs" not found — left untouched';
    RETURN;
  END IF;

  section :=
       E'## What read-only production means inside YOUR OWN workspace\n'
    || E'\n'
    || E'Your binding is not only a rule about production: it is the database your workspace points at. The\n'
    || E'`DATABASE_URL` your environment file names is that SELECT-only role, so **anything that writes fails\n'
    || E'at postgres** — a schema migration, most of a repo''s own test suite, a server you start locally that\n'
    || E'expects to write. Those failures are the guarantee working, not a broken environment, and there is\n'
    || E'nothing in them to work around. Read production as much as you like; anything that must WRITE\n'
    || E'belongs in a throwaway database or in a worker''s xell — a worker has one for exactly this.\n'
    || E'\n'
    || E'**And that projection is a FILE**, written from the fleet''s records when the xell is provisioned. A\n'
    || E'manager provisioned before its binding changed keeps the old file until something re-emits it, so\n'
    || E'the binding you are told you hold and the `DATABASE_URL` you actually have can disagree. When they\n'
    || E'do, that is a finding to report, not something to edit around: the file is generated, and an edit to\n'
    || E'it is overwritten the next time it is written.\n'
    || E'\n'
    || E'Where a project''s app tier is a process runner rather than a container carrying its own environment,\n'
    || E'a server started from that file inherits whatever database the file names.\n'
    || E'\n';

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md',
    replace(txt, E'## Your verbs', section || E'## Your verbs'));

  -- AND FORGET THE FOLDER HASH, so the folder can win again. refreshHarnesses() skips a file-backed
  -- harness whose recomputed folder hash still equals bundle_hash — so a migration that writes the
  -- bundle (059 does, and so does the block above) leaves the row diverged from the folder with a
  -- hash that says they agree, and the reconcile never runs. Clearing it forces exactly one re-read
  -- at the next boot: on a machine WITH the repo the folder text (identical to this one, edited in
  -- the same commit) is re-projected and the hash is restored; on a meta-DB with no folder the load
  -- fails and the last good bundle — the one this migration just wrote — is kept. Either way the
  -- row and the folder stop being able to disagree silently.
  UPDATE harness SET bundle_hash = NULL WHERE key = 'manager' AND dir IS NOT NULL;
  RAISE NOTICE 'manager manual: added what read-only production does to the manager''s own workspace';
END $$;
