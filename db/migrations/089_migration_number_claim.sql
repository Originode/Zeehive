-- MIGRATION NUMBERS ARE HANDED OUT, NOT GUESSED (ticket #9).
--
-- The folder IS the ledger and the FILENAME is its only ordering, so the number in front of a
-- migration is its apply order. A cxell zee chooses that number by reading db/migrations/ in its own
-- worktree — which knows what is landed and what IT wrote, and nothing whatever about the siblings
-- writing migrations on branches it cannot see. Six numbers came out of that: 038, 066, 079, 082, 085
-- (that pair applying in a single boot on the shipped tip, in whatever order a string sort gave two
-- names that were meant to be identical) and then 086, claimed by THREE xells in one evening. git
-- never showed a conflict, because two files that never touch each other do not have one.
--
-- The queenzee is the only party that can see the whole picture (main, plus EVERY live xell's
-- worktree), so `zee migration-number` asks it — and this table is the third input: a number handed
-- out seconds ago, to a zee that has not written its file yet, is taken.
--
-- ADVISORY, deliberately. It hands out a number; it does not gate a landing. A zee that never asks is
-- not blocked, and the lint (test/migration-numbers.test.mjs) is what fails the build if a duplicate
-- lands anyway. Two halves: this one stops the collision, that one refuses to let it hide.
--
-- WHY A CLAIM EXPIRES: it is a courtesy hold, not a reservation. A xell that dies mid-task must not
-- push every future number up forever, and an unused number is only a hole in the sequence, which the
-- ledger does not care about (it needs uniqueness and rough order, not density). So a claim lapses
-- after 7 days — far longer than a xell's life, so it can never expire under a zee still writing the
-- file — and a RETIRED xell's claim stops counting at once, which is the case that actually happens.
CREATE TABLE IF NOT EXISTS migration_number_claim (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  -- CASCADE (unlike prod_seed_request's receipts): a claim is about a number that is not spoken for
  -- yet, so once the xell is gone the hold is meaningless — and the claim's whole purpose is to stop
  -- counting when the xell does.
  xell_id    uuid REFERENCES xell(id) ON DELETE CASCADE,
  xell_slug  text,                                    -- readable in the log after the xell is gone
  number     int  NOT NULL,
  filename   text,                                    -- the suggested path, when the zee named one
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

-- The read is always "live claims for this project" (not expired, xell not retired), so index the
-- pair the verb actually queries on. NOT unique on (project_id, number): a lapsed claim keeps its row
-- as a record, and the number it no longer holds must be free to hand out again — uniqueness here is
-- kept by the per-project advisory lock the verb takes, which is the only place that can also see
-- main and every worktree.
CREATE INDEX IF NOT EXISTS migration_number_claim_project_idx
  ON migration_number_claim (project_id, number);

-- ── what a zee is TOLD (house rule 8) — through the helper (house rule 9 / 076) ────────────────
-- Anchored + idempotent in the 077/085 sense: it returns early when the section is already there,
-- refuses to guess when an anchor has moved, and never walks bundle->'memory' itself.
DO $$
DECLARE
  txt      text;
  verbline text;
  section  text;
  anchor   text := 'zee db-catchup [--restore]                        # roll your OWN db (clone/isolated) forward to prod''s schema (NOT gated)';
  landsec  text := E'### `zee land` — land your work on main';
  done     text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'cxell-zee manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee migration-number%' THEN
    RAISE NOTICE 'cxell-zee manual: the migration-number verb is already documented';
    RETURN;
  END IF;
  IF position(anchor IN txt) = 0 OR position(landsec IN txt) = 0 THEN
    RAISE NOTICE 'cxell-zee manual: an anchor has moved — left untouched (document zee migration-number by hand)';
    RETURN;
  END IF;

  verbline := 'zee migration-number [--name "…"] [--again]      # ASK for the next free db/migrations number (NOT gated)';
  txt := replace(txt, anchor, anchor || E'\n' || verbline);

  section := E'### `zee migration-number` — a migration number two zees cannot both take\n'
    || E'`POST /api/xell/self/migration-number`. `db/migrations/` IS the ledger and the FILENAME is its\n'
    || E'only ordering, so the number in front of a migration is its apply order. Your worktree can only\n'
    || E'show you what is LANDED plus what you wrote — never the four siblings writing migrations on\n'
    || E'branches you cannot see. That is not a theory: six numbers have been claimed twice or more (038,\n'
    || E'066, 079, 082, 085 — and 086 by THREE xells in one evening), and git showed no conflict any time\n'
    || E'because two files that never touch each other do not have one.\n'
    || E'\n'
    || E'So ASK, before you name the file. The queenzee unions three things it can see and you cannot:\n'
    || E'what is landed on main, what every LIVE xell''s worktree already holds, and what other zees have\n'
    || E'claimed in the last few seconds — then records your claim, so the next zee to ask gets a\n'
    || E'different number.\n'
    || E'\n'
    || E'- `zee migration-number --name "add claims table"` answers with the number, the padded prefix and\n'
    || E'  a legal filename to create (`NNN_add_claims_table.sql`).\n'
    || E'- Asking TWICE hands you back the SAME claim — the usual repeat is a re-run, and being told 087\n'
    || E'  after you have already written 086 is the bug this verb exists to prevent. `--again` is how you\n'
    || E'  get a second number for a second migration in one landing.\n'
    || E'- A claim LAPSES after 7 days, and stops counting the moment your xell is retired. It is a\n'
    || E'  courtesy hold, not a reservation: an unused number is just a hole, and the ledger only needs\n'
    || E'  uniqueness and rough order.\n'
    || E'\n'
    || E'**It is advisory: it hands out a number, it does not gate your landing.** Nothing refuses a\n'
    || E'migration you numbered yourself — but `test/migration-numbers.test.mjs` FAILS the build on a new\n'
    || E'duplicate, and the landed pairs are grandfathered there because a forward-only ledger does not\n'
    || E'rewrite history. If you land a collision, that lint is what tells you, and renumbering is then\n'
    || E'your job. Ask first; it is one call.\n'
    || E'\n';
  txt := replace(txt, landsec, section || landsec);

  done := harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'cxell-zee manual (%): zee migration-number documented', done;
END $$;
