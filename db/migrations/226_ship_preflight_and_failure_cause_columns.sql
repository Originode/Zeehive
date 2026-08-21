-- SHIP PRE-FLIGHT + PARSED FAILURE CAUSE (ticket #58) — decide with facts BEFORE the irreversible step.
--
-- 8 of 31 ship failures were facts knowable at request time (a prod db row with no host_port; a
-- target db that cannot be inspected on its docker context), and the rest stored ~400 characters of
-- raw docker log as the "cause". Two additions to the ship_request row:
--
--   1. PRE-FLIGHT. When a ship is raised, the queenzee runs READ-ONLY probes over the deploy's
--      preconditions (the migration target db is addressable and inspectable, the build targets have
--      build scripts, the docker contexts are reachable) and stamps the verdict here. A failed
--      precondition turns the card into "cannot ship, because X" BEFORE a human approves.
--        preflight        → [{ check, ok, skipped, unknown, detail }] — every check, not just failures
--        preflight_at     → when the probes ran
--        preflight_error  → the combined named failure(s), null when every check passed
--
--   2. PARSED FAILURE CAUSE. A failed ship keeps its raw log (error / containers) — the evidence is
--      never replaced — but now ALSO stores a classified cause (image-pull, npm-install,
--      migration-refused, health-check, disk, other) plus the ONE line that identifies it, so the
--      card can say WHY it failed instead of handing out a log to scroll.
--        failure_cause  → the small stable vocabulary above
--        failure_line   → the identifying line from the raw output
--
-- And the deploy-time migration read is no longer silently dropped: pendingMigrations() failing at
-- request time used to become `migrations = []` and the card said "none". The error now rides here
-- so the card can say "UNKNOWN", the same rule the boot-time set already followed (075).
--        migrations_error → why the deploy-time migration set could not be read, null when it could
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS preflight        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS preflight_at     timestamptz,
  ADD COLUMN IF NOT EXISTS preflight_error  text,
  ADD COLUMN IF NOT EXISTS migrations_error text,
  ADD COLUMN IF NOT EXISTS failure_cause    text,
  ADD COLUMN IF NOT EXISTS failure_line     text;

COMMENT ON COLUMN ship_request.preflight IS
  'READ-ONLY pre-flight checks run when the ship is raised (ticket #58): what the deploy is going to need — migration target db, build targets, docker contexts. Array of {check, ok, skipped, unknown, detail}.';
COMMENT ON COLUMN ship_request.preflight_error IS
  'The combined named failure(s) from the pre-flight, null when every check passed. A failed precondition turns the card into "cannot ship, because X".';
COMMENT ON COLUMN ship_request.migrations_error IS
  'Why the deploy-time migration set could not be read at request time (pendingMigrations failed) — null when it was read. The card must render this as UNKNOWN, never as zero.';
COMMENT ON COLUMN ship_request.failure_cause IS
  'Classified cause of a failed ship (image-pull | npm-install | migration-refused | health-check | disk | other). The raw log stays in error/containers; this is the one-line diagnosis beside it.';
COMMENT ON COLUMN ship_request.failure_line IS
  'The ONE line from the raw failure output that identifies the cause.';
