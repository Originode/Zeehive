-- XOURCE CLEAN-UP — a project's xource (the main checkout at project.repo_root) is the one
-- working tree every landing and every ship builds from. It is not supposed to have uncommitted
-- work of its own, but it sometimes does: a mid-deploy interruption, a conflict a sync left
-- behind, a materialised .env that git now sees as dirty. When that happens the xource is
-- MANGLED — `receive.denyCurrentBranch=updateInstead` refuses the landing push over a dirty
-- tree, the ship's build script runs from a tree that is not clean, and every landing and ship
-- in the project wedges on a checkout nobody asked to be touched.
--
-- The queenzee cannot prevent that from the outside (it never writes into the xource except the
-- things below), and until now there was no verb to fix it either: a human's only move was a
-- shell into the queenzee host and `git reset --hard` by hand. This migration adds the REQUEST
-- half of a proper fix — a row a MANAGER zee files (`zee xource-clean --reason "…"`) that a
-- human decides in the console, exactly like a prod-bind or a done suggestion. The queenzee
-- performs the actual cleanup on approval; the console's Project setup also has a direct
-- human-gated Clean button that writes the same row (see lib/xource-clean.js).
--
-- The table is deliberately shaped like prod_seed_request (049) / prod_bind_request (029):
--   * xell_id is the MANAGER that asked (SET NULL if it is reaped — the ask is still a fact);
--   * status pending → approved (queenzee cleans the xource) → completed, or rejected;
--   * result carries what the cleanup actually did, so the card reads as a receipt;
--   * dismissed_at is the console's "seen it" marker, never a decision.
CREATE TABLE IF NOT EXISTS xource_clean_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  xell_id      uuid REFERENCES xell(id) ON DELETE SET NULL,
  zee_id       uuid REFERENCES zee(id) ON DELETE SET NULL,
  reason       text,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','completed','failed')),
  result       jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,
  finished_at  timestamptz,
  dismissed_at timestamptz,
  dismissed_by text
);

-- At most one OPEN request per asking xell (the verb upserts against this, like prod_bind).
CREATE UNIQUE INDEX IF NOT EXISTS xource_clean_request_open_uq
  ON xource_clean_request (xell_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS xource_clean_request_project_idx
  ON xource_clean_request (project_id, status, requested_at DESC);

-- ── MANAGER MANUAL (manager → manager-zee-manual.md): document `zee xource-clean` ─────────────
-- A manager is the agent that holds the whole picture, so it is the one likely to notice a
-- wedged xource (its crew's landings keep getting refused, its ships keep failing at build). The
-- verb is MANAGER-only — a worker must never be able to reset the main checkout. This edit
-- follows the 090/085 pattern: anchored + idempotent, and it RAISE NOTICEs (never throws) when an
-- anchor has moved so test/cxell-cli-drift.test.mjs is the one that catches a drift it can see.
DO $$
DECLARE
  txt      text;
  verbline text;
  section  text;
  anchor   text := 'zee suggest-done --to <slug> --reason "…"';
  crew     text := '### `zee zees` — monitor your crew';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee xource-clean%' THEN
    RAISE NOTICE 'manager manual: zee xource-clean is already documented';
    RETURN;
  END IF;
  IF position(anchor IN txt) = 0 OR position(crew IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: an anchor has moved — add zee xource-clean by hand';
    RETURN;
  END IF;

  verbline := $hz$zee xource-clean --reason "…"            # ask a HUMAN to clean up the project's xource (the main checkout) — a mangled xource blocks EVERY landing and ship$hz$;

  section := $hz$### `zee xource-clean` — ask a human to clean up the project xource

`POST /api/xell/self/xource-clean` `{ reason }`. The project xource (the main checkout at
`project.repo_root`) is the ONE working tree every landing and ship builds from. Sometimes it gets
mangled — a mid-deploy interruption, a conflict a sync left behind — and a dirty/conflicted tree
blocks EVERY landing (the landing gate refuses to push over it) and every ship (the build runs
from it). This verb RAISES A REQUEST for a human to approve in the console; the QUEENZEE performs
the cleanup on approval: it aborts any in-progress merge/rebase/cherry-pick, resets the index and
working tree to the main tip, and removes untracked junk — preserving every xell's worktree under
`.claude/worktrees/`.

It is a REQUEST, not an act: you never reset the xource yourself, and the human's approve is what
unblocks the crew. Say WHY in the reason — it is what the console shows beside the card.

Refused for a WORKER (you may only ever ask to reset the xource you were given to branch from),
and one open request at a time — re-asking while one is pending just hands you the same card.

$hz$;

  txt := replace(txt, anchor, anchor || E'\n' || verbline);
  txt := replace(txt, crew, section || crew);

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: added zee xource-clean (request a human clean the xource)';
END $$;
