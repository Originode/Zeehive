-- SCRATCH SCRIPTS IN A CAGE — one incident, one correction, and one trap that made a false rule look
-- true for a whole day (ticket #31).
--
-- THE INCIDENT: a zee committed a checkpoint carrying three scratch files, ran `zee build` (which
-- fast-forwards the HOST worktree to that commit), then `git reset --soft` to recommit without them.
-- That rewrote a commit the host had already collected, so every later build refused to fast-forward
-- — and the error blames the fast-forward, not the rewrite, which is where the time goes. Recovery was
-- a `merge -s ours` after checking the stranded side held nothing that mattered.
--
-- THE CORRECTION: "keep scratch in /tmp" alone walks into module resolution — a file in /tmp cannot
-- see the repo's node_modules — and the obvious fix, `NODE_PATH=/work/repo/node_modules`, does NOT
-- work for `.mjs`: NODE_PATH is CommonJS-only and Node's ESM loader ignores it. Three forms DO work
-- and are named below; all were run, not reasoned about.
--
-- THE TRAP, and the reason this note exists at all: scratch that imports only `node:` builtins needs no
-- resolution whatsoever, so it runs identically with NODE_PATH, without it, or with it set to nonsense.
-- A zee can therefore "confirm" a wrong rule all day — every observation true, the conclusion wrong.
-- That is the same shape as the go-around flake (#19): what makes a wrong belief durable is the case
-- where it happens to work. Anyone shortening this note for brevity must keep that last sentence; the
-- other four facts are useful, and this is the one that stops them being re-learned from scratch.
--
-- WHERE IT GOES, and why only here. `zee-base` owns `cxell-zee-manual.md` and EVERY worker harness
-- chains to it (dev-base → zee-base, and the whole dev crew under dev-base), so one edit reaches all of
-- them. The MANAGER chain (manager → dev-lead) does not inherit zee-base and keeps its own
-- `memory/manager-zee-manual.md`; it is deliberately NOT patched, because a manager lands nothing and
-- builds nothing, so the half of this note that matters most — never rewrite a commit a build has
-- collected — cannot apply to it.
--
-- NB for whoever writes the next manual migration: the manager harness is NOT file-backed any more.
-- 079's comment (and the folder split it describes) predates 080, which moved every harness INTO the
-- meta-DB; there is no `harnesses/` directory, `harness.dir` is NULL and `lib/harness.js` reads no
-- filesystem (CLAUDE.md house rule 10). So a manager-manual edit is a migration too, not a repo file
-- edit — the split that used to make it both is gone.
--
-- FORM: 077/079's shape — anchored, guarded, idempotent, through 076's `harness_memory_get` /
-- `harness_memory_put` (house rule 9), which locate the entry BY PATH so no sibling memory file can be
-- rebuilt away. The guard matches text this file itself writes, so a re-run past the ledger is a
-- byte-identical no-op. The anchor is an exact stored line: if a human has rewritten the golden rules
-- in the harness manager, the insert simply does not fire and their words are left alone — and it says
-- so out loud rather than silently doing nothing.
DO $$
DECLARE
  txt    text;
  anchor text;
  done   text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'cxell-zee manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%Keep scratch OUT of the repo%' THEN
    RAISE NOTICE 'cxell-zee manual: the scratch-script rule is already there';
    RETURN;
  END IF;

  -- the tail of golden rule 6 ("Verify in your cxell"), which ends the list — so this lands as rule 7
  -- and no existing number moves
  anchor := E'docker) and exercise the real thing before you call the work done. "I wrote it" is not verification.';
  IF position(anchor IN txt) = 0 THEN
    RAISE NOTICE 'cxell-zee manual: golden-rule-6 anchor not found — left untouched';
    RETURN;
  END IF;

  txt := replace(txt, anchor, anchor || E'\n'
    || E'7. **Keep scratch OUT of the repo.** A helper script left in the tree is one `git add -A` from\n'
    || E'   riding into a checkpoint, and a checkpoint you have already BUILT from must never be rewritten:\n'
    || E'   `zee build` fast-forwards the host worktree to that commit, so amending it makes every later\n'
    || E'   build refuse to fast-forward — and the error blames the fast-forward, not the rewrite. Write\n'
    || E'   scratch under `/tmp`. If it needs one of the repo''s own packages (`pg`, `esbuild`), use ONE of\n'
    || E'   these three (all verified): make it **`.cjs` and `require()`** it\n'
    || E'   (`NODE_PATH=/work/repo/node_modules node /tmp/x.cjs`), or stay in ESM and **symlink**\n'
    || E'   `/work/repo/node_modules` beside the file, or **import by absolute path**\n'
    || E'   (`/work/repo/node_modules/<pkg>/…`). `NODE_PATH` does NOT work for `.mjs` — it is\n'
    || E'   CommonJS-only — and running from the repo does not save a FILE in `/tmp`: ESM resolves from\n'
    || E'   the importing FILE''s URL, never the process cwd (`node -e` escapes it only because it has no\n'
    || E'   file URL). **The trap:** scratch that imports only `node:` builtins needs no resolution at\n'
    || E'   all, so it runs identically whatever you set — which is how a false rule survives a day of\n'
    || E'   apparent confirmation, every observation true and the conclusion wrong.');

  done := harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'cxell-zee manual (%): keep scratch out of the repo, and how a scratch script resolves modules', done;
END $$;
