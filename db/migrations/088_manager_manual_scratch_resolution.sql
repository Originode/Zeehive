-- THE MANAGER'S HALF of the scratch-script note (#31 follow-up to 087).
--
-- 087 put the whole note in `zee-base`, which every WORKER harness chains to (dev-base → zee-base, and
-- the dev crew under dev-base). The MANAGER chain (manager → dev-lead) does not inherit it, and a
-- manager runs one-off scripts against its workspace constantly — read the meta-DB, check a payload,
-- probe an endpoint — so it hits the same module-resolution wall from a manual that never mentions it.
-- One did today and guessed its way around it.
--
-- WHAT IS DELIBERATELY LEFT OUT: the commit half. 087's rule opens with "keep scratch out of the repo,
-- because a checkpoint you have BUILT from must never be rewritten", and a manager can be in neither
-- situation — it has zero push access to the xource and it builds nothing. Briefing a reader about doors
-- it does not have is the failure ticket #1 was about, so this is the resolution facts only, and it is
-- shorter than its zee-base sibling on purpose. Not padded for symmetry.
--
-- The `node:` builtins line is the REASON both notes exist and is kept verbatim in both: a script that
-- imports only builtins needs no resolution at all, so it runs identically whatever you set — which is
-- how a wrong rule survives a day of apparent confirmation, every observation true and the conclusion
-- wrong. Anyone shortening this note keeps that sentence.
--
-- FORM: 077/079/087's shape — anchored on an exact stored line, guarded, idempotent, through 076's
-- `harness_memory_get` / `harness_memory_put` (house rule 9) so no sibling memory entry can be rebuilt
-- away. A re-run past the ledger is a byte-identical no-op; if a human has rewritten the workspace
-- section in the harness manager, the insert declines and SAYS SO rather than silently doing nothing.
--
-- AND NOTE FOR THE NEXT AUTHOR: this is a migration, not a repo file edit, because no harness is
-- file-backed any more (080 — `harnesses/` is gone, `harness.dir` is NULL, `lib/harness.js` reads no
-- filesystem; CLAUDE.md house rule 10). 079's comment still says otherwise and is annotated in place.
DO $$
DECLARE
  txt    text;
  anchor text;
  done   text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%Running a one-off script against your workspace%' THEN
    RAISE NOTICE 'manager manual: the scratch-script resolution note is already there';
    RETURN;
  END IF;

  -- the last line of "What read-only production means inside YOUR OWN workspace" (079) — the section
  -- about what running things in your own workspace is actually like, which is where this belongs
  anchor := E'a server started from that file inherits whatever database the file names.';
  IF position(anchor IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: workspace-section anchor not found — left untouched';
    RETURN;
  END IF;

  txt := replace(txt, anchor, anchor || E'\n'
    || E'\n'
    || E'**Running a one-off script against your workspace.** You will do this constantly — read the\n'
    || E'meta-DB, check a payload, probe an endpoint — and the place it bites is imports: a script written\n'
    || E'outside the repo cannot see the repo''s `node_modules`, so `import pg` fails. Write the script in\n'
    || E'`/tmp` anyway (a stray file in the tree turns up in the `git status` you are trying to read) and\n'
    || E'reach the dependency one of these ways — all four facts verified, not reasoned about:\n'
    || E'\n'
    || E'- **`.cjs` + `require()`** is the simple case: `NODE_PATH=/work/repo/node_modules node /tmp/x.cjs`.\n'
    || E'- **`NODE_PATH` does NOT work for `.mjs`** — it is CommonJS-only and Node''s ESM loader ignores it.\n'
    || E'- **Staying in ESM?** Symlink `/work/repo/node_modules` beside the file, or import by absolute\n'
    || E'  path (`/work/repo/node_modules/<pkg>/…`).\n'
    || E'- **Running it "from the repo" does not help a FILE in `/tmp`.** ESM resolves from the importing\n'
    || E'  FILE''s URL, never from the process cwd — `node -e` escapes this only because it has no file URL.\n'
    || E'\n'
    || E'**The trap:** a script that imports only `node:` builtins needs no resolution at all, so it runs\n'
    || E'identically whatever you set — which is how a false rule survives a day of apparent confirmation,\n'
    || E'every observation true and the conclusion wrong.');

  done := harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual (%): how a one-off script reaches the repo''s own packages', done;
END $$;
