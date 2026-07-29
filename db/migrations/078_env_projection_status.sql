-- .zeehive.env IS A PROJECTION, AND NOTHING RECORDED WHETHER IT ACTUALLY LANDED (ticket #15 follow-up).
--
-- The file is written once, at provision time (lib/provision.emitXellEnv), from the meta-DB. Every
-- caller after that re-emits BEST-EFFORT — bindManagerToProdReadonly, the db-clone watch, a rename,
-- an environment pin — and each of them caught the failure and moved on. So a xell could be bound to
-- production read-only, be TOLD it holds production, and keep a file pointing at its own throwaway
-- spinoff database, with the only trace a log line that had long scrolled away.
--
-- Two columns, so the outcome of the last projection outlives the log:
--   env_projected_at      — when the file was last verified/written to match the meta-DB;
--   env_projection_error  — why the last one FAILED, cleared by the next success.
-- lib/fleet.js selects x.*, so the console's env chip carries both with no extra query.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS env_projected_at     timestamptz;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS env_projection_error text;

COMMENT ON COLUMN xell.env_projected_at IS
  'When .zeehive.env was last verified/written to match the meta-DB (lib/provision.emitXellEnv). NULL = never projected.';
COMMENT ON COLUMN xell.env_projection_error IS
  'Why the last .zeehive.env projection failed, NULL when the last one succeeded. A stale file with a '
  'reason a human can read, instead of a swallowed .catch().';
