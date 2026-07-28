-- SEEDING PRODUCTION IS A REQUEST — the zee asks, a human approves, the QUEENZEE runs it.
--
-- WHY: a ship carries CODE + SCHEMA (server/sql/migrations) + one-time DATA fixes
-- (server/sql/ops, migration 014's second dir). What it cannot carry is the class of data a
-- shipment NEEDS to be usable but that must run AFTER the new code is live, or that a zee only
-- discovers is missing once prod is serving it: reference rows, a lookup table's contents, the
-- first tenant of a new feature. Until now the only way to put those rows into prod was to bind
-- the whole xell to the production database (lib/xell-prod.js) — i.e. to hand a zee live prod
-- write access for what is really one reviewed file. That is a sledgehammer, and it is the exact
-- asymmetry the ship gate removed for code: the zee should be able to ASK for the narrow thing.
--
-- So: a PROD SEED REQUEST names files that are already ON MAIN (the same anti-band-aid rule the
-- ship gate enforces — the queenzee reads them with `git show <main-tip>:<file>`, never from a
-- zee's worktree), a human approves them in the console with the SQL in view, and the QUEENZEE
-- executes them against the production database. The zee never holds prod, never runs psql, and
-- cannot approve its own request — identical division of labour to shipgate.js.
--
-- NOT ledgered, deliberately: a migration must run exactly once, but a seed is legitimately
-- re-runnable (re-seed after a restore, top up a lookup table). The contract is therefore
-- IDEMPOTENT SQL (ON CONFLICT DO NOTHING / WHERE NOT EXISTS), and the console shows every prior
-- run of the same file so a human approving a repeat knows it is a repeat.
CREATE TABLE IF NOT EXISTS prod_seed_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: a seed that ran on production is a receipt about PRODUCTION, and it
  -- must outlive the throwaway xell that asked for it (the same reasoning as db_instance's
  -- orphaned clones in 019 — the record of a thing that touched prod does not get reaped).
  xell_id      uuid REFERENCES xell(id) ON DELETE SET NULL,
  xell_slug    text,
  zee_id       uuid REFERENCES zee(id) ON DELETE SET NULL,
  -- Which production this seeds (spec §5 sites). NULL = the project's default/legacy prod.
  site_id      uuid REFERENCES deploy_site(id) ON DELETE SET NULL,
  files        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- repo-relative paths under the seed dir
  commit       text,                                  -- the main-tip sha the files are read AT
  reason       text,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','running','seeded','failed','rejected')),
  result       jsonb,                                 -- per-file outcome, or the refusal
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,
  finished_at  timestamptz,
  dismissed_at timestamptz,
  dismissed_by text
);

-- One OPEN seed request per xell (the verb upserts against this) — a zee cannot queue five.
CREATE UNIQUE INDEX IF NOT EXISTS prod_seed_request_open_uq
  ON prod_seed_request (xell_id)
  WHERE status IN ('pending','approved','running') AND xell_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS prod_seed_request_project_idx
  ON prod_seed_request (project_id, requested_at DESC);
