-- PROVIDER ACCOUNT PAUSE — a human can disable one connected AI-provider account without
-- deleting it, so no dispatch on it can start a zee while it stays connected and resumable.
-- Covers every assignment surface at once because the enforcement lives in the one token read
-- every spawn funnels through (provider-tokens.tokenForSpawn): console prompt buttons, the
-- dispatch/manager/swap modals, an MCP or /xell dispatch, a manager deploying a worker, and a
-- queued task all reach it. Deleting the token stays the way to remove an account for good;
-- pausing is the reversible "stop using THIS one right now" switch.
--
-- Why a row-level column instead of a separate table: the paused state is a property of ONE
-- account (a project can hold several of one provider type since 036), it is read on the hot
-- spawn path, and the read model already returns one object per account. A column keeps the
-- state where the credential is, so the spawn gate and the console read model see the same
-- fact without a join.
--
-- The shape follows the fleet/project/xell pause tables (100/101/102): paused_at + who + why,
-- cleared on resume. NULL paused_at = active.
ALTER TABLE provider_token
  ADD COLUMN IF NOT EXISTS paused_at   timestamptz,
  ADD COLUMN IF NOT EXISTS paused_by   text,
  ADD COLUMN IF NOT EXISTS reason      text,
  ADD COLUMN IF NOT EXISTS resumed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS resumed_by  text;

-- The generic spawn pick ("freshest account of this type") skips paused rows; a partial index
-- keeps that read on the same shape as the existing provider_token_project_type_idx.
CREATE INDEX IF NOT EXISTS provider_token_active_idx
  ON provider_token (project_id, provider)
  WHERE paused_at IS NULL;
