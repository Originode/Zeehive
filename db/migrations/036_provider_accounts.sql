-- Provider ACCOUNTS (Mark, 2026-07-21): a project can hold several credentials of the same
-- provider type — e.g. two Claude subscriptions — each its own row with its own label, its own
-- prompt button in the console, and its own last_used_at. `provider` becomes the TYPE column
-- (claude|openai|kimi|github — the registry in lib/provider-tokens.js); the one-row-per-type
-- uniqueness from 027 is dropped. Rows already carry a uuid id (027), which becomes the handle
-- the console deletes by and a dispatch pins with provider_token_id.
ALTER TABLE provider_token ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE provider_token DROP CONSTRAINT IF EXISTS provider_token_project_id_provider_key;
CREATE INDEX IF NOT EXISTS provider_token_project_type_idx ON provider_token (project_id, provider);
