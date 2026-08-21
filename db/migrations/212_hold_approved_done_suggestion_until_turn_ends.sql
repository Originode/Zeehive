-- HOLD AN APPROVED done suggestion until the turn ends (ticket #75).
--
-- A human (or the auto-done policy) approving a done suggestion whose target is mid-turn used to
-- be REFUSED and the row reverted to 'pending' — the decision was discarded and nothing retried it
-- when the turn ended. A finished xell then held its slot (containers + db) for 42 and 67 minutes
-- in one crew, because the approval that had already been made was silently thrown away.
--
-- This migration adds a new status, 'approved-held': the decision has been made (approved) but is
-- HELD until the target's turn ends (quiescence). The reaper applies it the moment the turn ends;
-- a human can also force-close the xell explicitly. The refusal itself is unchanged — a live turn
-- is never torn down without force.
--
-- The status CHECK (052) is replaced to admit the new value, and the open index — which the console
-- reads to show still-live cards — is widened to include held rows so a held decision stays visible.
ALTER TABLE done_suggestion DROP CONSTRAINT IF EXISTS done_suggestion_status_check;
ALTER TABLE done_suggestion ADD CONSTRAINT done_suggestion_status_check
  CHECK (status IN ('pending','approved','approved-held','rejected','failed'));

DROP INDEX IF EXISTS done_suggestion_open_idx;
CREATE INDEX done_suggestion_open_idx ON done_suggestion (project_id, status)
  WHERE status IN ('pending','approved-held') AND dismissed_at IS NULL;

COMMENT ON TABLE done_suggestion IS
  'A manager zee''s suggestion that another xell is finished. A human confirms it in the console (typed confirmation); THAT marks the task done and reaps the cxell. A manager can never mark anything done itself. status ''approved-held'' is a decision already made that the reaper will apply once the target''s turn ends (ticket #75).';
