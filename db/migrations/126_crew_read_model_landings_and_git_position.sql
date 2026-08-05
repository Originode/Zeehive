-- WHAT A WORKER HAS PRODUCED — the crew read model tells the truth about the work now, so the
-- manager manual has to say what it actually returns (house rule 8).
--
-- The manual promised `zee zees` would show "its diff (ahead/dirty)". lib/managers.js crewFor()
-- computed no diff at all and said nothing about landings, so the one instrument a manager has
-- carried only fields written at TURN BOUNDARIES — status, model, cost — which describe a worker's
-- previous turn, not its work. A manager read `idle` on a reviewer that had restarted and landed a
-- commit eight minutes earlier, concluded it was inert, and spent a whole redundant xell redoing
-- landed work. Worse, the manual's own warning ("never suggest done over unlanded work") sent a
-- manager to check a field that did not exist.
--
-- The code now returns `landings` (the landing ledger) and `diff` (ahead/dirty/shortstat, read from
-- the worker's cxell when one is live, else its host worktree, null when neither can be read). This
-- migration makes the manual say exactly that, and points the suggest-done rule at the field a
-- manager must actually look at.
--
-- Anchored + idempotent, like 090/111: it RAISE NOTICEs rather than throwing when an anchor has
-- moved, so a database whose manual has drifted is reported rather than half-patched.
DO $$
DECLARE
  txt     text;
  old_par text;
  new_par text;
  old_sd  text;
  new_sd  text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%WHAT IT HAS PRODUCED%' THEN
    RAISE NOTICE 'manager manual: the crew row already documents what a worker has produced';
    RETURN;
  END IF;

  old_par := 'One row per worker: slug, branch, hive status (`occ-working`,' || E'\n'
    || '`occ-landRequest`, `occ-tendRequest`, `occ-doneRequest`, …), what it is waiting on, its diff' || E'\n'
    || '(ahead/dirty), its last message to you. This is your dashboard; read it before you interrupt anyone.';

  new_par := $hz$One row per worker: slug, branch, hive status (`occ-working`,
`occ-landRequest`, `occ-tendRequest`, `occ-doneRequest`, …), what it is waiting on, its last message
to you — and WHAT IT HAS PRODUCED:

- **`landings`** — `{count, last_sha, landed_at}`: what actually reached main, read from the landing
  ledger. A worker with landings has produced something whatever its status says.
- **`diff`** — `{ahead, dirty, files, insertions, deletions, head, source}`: what has NOT landed yet.
  `ahead` is unlanded commits, `dirty` is uncommitted files. It is read from INSIDE the worker's
  cxell when one is live (that is where a caged zee's work lives — the host worktree stays frozen
  until the work lands or builds), otherwise from its host worktree; `source` says which. It is
  **null** when neither could be read: null means "not measurable", never "produced nothing", and it
  is never rounded down to 0.

**The two halves of a row age differently.** Status, model and cost come from the worker's `zee`
row, which is written at TURN BOUNDARIES — a worker mid-turn still shows the status its LAST turn
ended in, so `idle` never means "it has stopped". `landings` and `diff` are measured when you read
them (and cached for ~15s, because this is polled), so they are the fields to trust about the work
itself. This is your dashboard; read it before you interrupt anyone.$hz$;

  IF position(old_par IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: the `zee zees` paragraph has moved — describe landings/diff by hand';
  ELSE
    txt := replace(txt, old_par, new_par);
  END IF;

  -- …and the rule that depends on it: name the field, so "read its git state" is checkable.
  old_sd := 'Read the worker''s git state first (`zee zees` shows' || E'\n'
    || 'it): unlanded commits die with the worktree, and a done suggestion on top of them is how work is' || E'\n'
    || 'lost.';
  new_sd := 'Read what it has PRODUCED first (`zee zees`:' || E'\n'
    || '`diff.ahead` is its unlanded commits, `landings` is what already reached main): unlanded commits' || E'\n'
    || 'die with the worktree, and a done suggestion on top of them is how work is lost.';
  IF position(old_sd IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: the suggest-done git-state sentence has moved — left as it was';
  ELSE
    txt := replace(txt, old_sd, new_sd);
  END IF;

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: `zee zees` now documents landings + diff (what a worker has PRODUCED)';
END $$;
