-- THE MANAGER MANUAL: `zee swap` — change WHO is in a crew xell without changing the xell.
--
-- A manager could only ever spawn a worker into a NEW xell, so "hand this same piece of work to a
-- different persona" meant a new branch, a new database, a new set of containers and a new card —
-- i.e. throwing the work away and briefing somebody to find it again. That is why no manager ever
-- ran a Scout, then a Builder, then a Reviewer over one job: the fleet had no verb for it. `zee swap`
-- is that verb, and like every other manager verb it is only reach INSIDE its own crew.
--
-- What the entry has to convey, and why each part is here rather than left to be inferred:
--   * what it KEEPS (branch, commits, containers, db, work-item card, manager) — because the whole
--     value of the verb is what does NOT move, and a manager that does not know that will keep
--     dispatching a fresh xell out of caution;
--   * that the incoming zee is briefed as an INHERITOR, so the manager does not re-write the whole
--     history into --task by hand;
--   * the COLLECT: a cxell zee's commits live inside its cage until something collects them, the
--     swap recreates that cage, and so the swap is REFUSED rather than risk them. A manager that
--     does not know this reads the refusal as a bug and looks for a way around it;
--   * the refusals, in one line each — not my crew, a manager target, a manager harness, and any
--     xell with a human gate open on it.
--
-- SHORT on purpose: this text is paid for on every manager dispatch, and `dev-lead` inherits it. The
-- flag detail stays in the CLI's usage line (restating it here is how the two drift), and
-- test/cxell-cli-drift.test.mjs FAILS if a manager-only CLI verb is missing from this manual.
--
-- Anchored + idempotent in the 065/071/079/085 sense: it returns early when the section is already
-- there, refuses to guess when an anchor has moved, and goes through harness_memory_put (house rule
-- 9 / 076) so every sibling memory entry survives. No folder half — 080 detached every harness row,
-- so the row is the only source and there is no bundle_hash to clear.
DO $$
DECLARE
  txt      text;
  verbline text;
  section  text;
  anchor   text := 'zee say --to <slug> --message "…"            # type a message straight into a worker''s live session';
  crew     text := '### `zee zees` — monitor your crew';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%change WHO is in a xell%' THEN
    RAISE NOTICE 'manager manual: the zee swap section is already there';
    RETURN;
  END IF;
  IF position(anchor IN txt) = 0 OR position(crew IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: an anchor has moved — left untouched (add the zee swap section by hand)';
    RETURN;
  END IF;

  verbline := $hz$zee swap --to <slug> --harness <key> [--task "…"]
                                             # REPLACE the zee in one of YOUR xells, keeping the xell$hz$;

  section := $hz$### `zee swap` — change WHO is in a xell, not which xell

`POST /api/xell/self/swap` `{ to, harness, task?, model?, mode? }`. Replaces the zee working one of
YOUR xells with a fresh one wearing a different worker harness, and **keeps the xell**: the same
branch, the same commits, the same containers, the same database, the same work-item card, still
reporting to you. `zee dispatch` can only ever open a NEW xell, so this is the only way one piece of
work gets a Scout, then a Builder, then a Reviewer instead of three strangers starting over.

The incoming zee is briefed as an **inheritor**: it is told the branch already carries work, what the
previous zee was asked to do, what it last reported, and a short git summary of what is on the
branch. You do not have to re-type that history into `--task` — put the NEXT phase there.

**The outgoing zee's commits are collected first, and the swap is REFUSED if they cannot be.** A
caged zee's commits live inside its container until something collects them (a land, a build, a
sync), and a swap recreates that container from the host worktree — so uncollected work would be
destroyed. The queenzee pulls them onto the worktree BEFORE anything is recreated, and stops the
whole swap if it cannot. That refusal is the guarantee working: tell the worker to `zee land` (or
`zee build`, which collects too), then swap.

Refused, each with a sentence: a xell that is not YOUR crew, a MANAGER xell, a MANAGER harness, a
persona belonging to another project, and any xell with a human gate open on it — a held landing, a
pending ship, or a done suggestion you already raised. That last one is not bureaucracy: swapping
under an open card points a human's decision at a zee that no longer exists.

$hz$;

  txt := replace(txt, anchor, anchor || E'\n' || verbline);
  txt := replace(txt, crew, section || crew);

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: added zee swap (re-crew a xell without losing the xell)';
END $$;
