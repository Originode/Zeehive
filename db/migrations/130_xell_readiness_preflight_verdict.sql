-- THE QUEENZEE WRITES A XELL'S ENVIRONMENT AND THEN CALLS IT READY, WITHOUT EVER OPENING IT (ticket #53).
--
-- .zeehive.env is a projection (lib/provision.emitXellEnv), and 078/082 record whether the FILE was
-- written. Nothing records whether what is IN it actually answers. Measured across one manager's
-- crew of thirteen in a single night: SEVEN workers independently discovered that the DATABASE_URL
-- they had been handed is rejected by the shared dev db ('password authentication failed for user
-- zeehive' — ticket #47); two of them never worked around it, ran three hours, verified nothing and
-- landed nothing. The projection columns were all green the whole time, because writing a string is
-- not the same fact as the string being usable.
--
-- lib/preflight.js OPENS what was written — the same DSN, resolved by the same resolveXellDsn the
-- emitter uses — and stamps the verdict here, so the fault is a property of the xell a human and a
-- zee can both see rather than something the first agent to try discovers hours in.
--
--   preflight_at     — when the preflight last RAN (whatever it concluded);
--   preflight_error  — the failing check, NAMED ('db-open: …'), NULL when the last run passed.
--                      Named rather than a boolean: "not ready" without which check failed sends a
--                      human looking, which is the cost this is trying to remove.
--   preflight_checks — every check with its own outcome, including the ones deliberately SKIPPED
--                      (a production binding is never opened by a preflight) — jsonb so later
--                      checks join it without another column each.
--
-- lib/fleet.js selects x.*, so the console's chip carries all three with no extra query, and
-- hive-status derives a failing vacant xell as `dirty` instead of `ready`.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS preflight_at     timestamptz;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS preflight_error  text;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS preflight_checks jsonb;

COMMENT ON COLUMN xell.preflight_at IS
  'When the readiness preflight last ran against this xell (lib/preflight.preflightXell). NULL = never run.';
COMMENT ON COLUMN xell.preflight_error IS
  'The failing readiness check, named ("db-open: password authentication failed for user zeehive"), '
  'NULL when the last preflight passed. What the queenzee wrote is not the same fact as what answers.';
COMMENT ON COLUMN xell.preflight_checks IS
  'Every readiness check from the last run: [{check, ok, skipped, detail}]. Skipped checks are kept — '
  '"production is never opened by a preflight" is an answer, not an absence.';
