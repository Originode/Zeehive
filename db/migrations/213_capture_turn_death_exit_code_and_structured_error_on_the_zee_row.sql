-- CAPTURE WHAT A DEAD TURN ACTUALLY SAID — exit code, stderr tail, structured error — and
-- re-classify the unknown rows whose signal was already in last_stop_reason.
--
-- TICKET #78 / live meta-DB 2026-08-21: 68% of classified deaths are revive_class='unknown', and for
-- 60 of the 65 unknown rows the signal is NOT missing — it is sitting in last_stop_reason and the
-- classifier's rules did not read it ("Not signed in. … grok login --device-code", "There's an issue
-- with the selected model (deepseek-chat)…", "cxell claude exited 137 with no result event: "). Only
-- 5 carry the bare string 'error'. A further 16 are not deaths at all ('end_turn', 'post-ship
-- reflection', 'message from manager-…', 'swapped out by manager-…').
--
-- THIS MIGRATION IS THE SECOND HALF OF THE FIX. The first half is the widened classifier in
-- server/src/lib/turn-death.js, which reads the same signals for every FUTURE death. Here:
--
--   1. three new columns capture the evidence the card asks for — the process exit code, a bounded
--      tail of stderr and the vendor's structured error object — written by noteTurnDeath (revive.js);
--   2. a one-time backfill re-classifies existing 'unknown' rows from the signal already in
--      last_stop_reason, so the share of unknown SHRINKS with evidence rather than waiting for new
--      deaths. The patterns mirror the JS rules for the measured cohort, and the backfill touches
--      ONLY rows still 'unknown' — an already-classified row is left exactly as it is.
--   3. rows that were never deaths drop OUT of the cohort entirely (revive_class = NULL), so a
--      healthy finish or a manager's act is not counted as an unclassifiable death.
--
-- Additive + idempotent: the columns are IF NOT EXISTS, and the backfill's WHERE revive_class='unknown'
-- guard makes re-running (against a snapshot that already has some rows classified) a no-op.
ALTER TABLE zee ADD COLUMN IF NOT EXISTS last_death_code    int;     -- the process exit code (137 = SIGKILL)
ALTER TABLE zee ADD COLUMN IF NOT EXISTS last_death_stderr  text;    -- bounded tail of stderr, scrubbed
ALTER TABLE zee ADD COLUMN IF NOT EXISTS last_death_error   jsonb;   -- the vendor's structured error object

-- ── BACKFILL: the measured unknown cohort, classified from the signal that was already there ──────
-- A credential refusal ("Not signed in", "grok login") is TERMINAL — a retry burns a cage to
-- reproduce the same failure. MEASURED: 15 rows.
UPDATE zee SET revive_class = 'terminal', revive_signal = 'auth'
 WHERE revive_class = 'unknown' AND last_stop_reason ILIKE '%not signed in%';

-- An unusable model ("There's an issue with the selected model (deepseek-chat|reasoner)…") is
-- TERMINAL — the dispatch is wrong, no retry fixes it. MEASURED: 17 rows.
UPDATE zee SET revive_class = 'terminal', revive_signal = 'model'
 WHERE revive_class = 'unknown' AND last_stop_reason ILIKE '%issue with the selected model%';

-- A SIGKILL ("cxell claude exited 137 with no result event") is a kill — the process died (OOM) but
-- the cage, session and files survived; it rides the transient ladder like a host restart. MEASURED: 5.
UPDATE zee SET revive_class = 'transient', revive_signal = 'killed'
 WHERE revive_class = 'unknown' AND last_stop_reason ILIKE '%exited 137%';

-- NOT DEATHS — a healthy end, a prompt the queenzee sent, a manager's nudge, a manager's swap. They
-- belong OUTSIDE the death cohort (NULL), not inside it as 'unknown'. MEASURED: 16 rows.
UPDATE zee SET revive_class = NULL, revive_signal = NULL
 WHERE revive_class = 'unknown' AND (
          last_stop_reason LIKE 'end_turn%'
       OR last_stop_reason LIKE 'post-ship reflection%'
       OR last_stop_reason ILIKE 'message from manager-%'
       OR last_stop_reason ILIKE 'swapped out by manager-%');

-- The 5 bare 'error' rows and anything else the classifier still cannot name stay 'unknown' — the
-- honest default. This card shrinks the cohort with evidence; it does not guess louder.
