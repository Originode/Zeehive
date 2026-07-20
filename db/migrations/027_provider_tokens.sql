-- Provider tokens: per-project AI-provider credentials for CXELLD (in-container) zees, stored in
-- the meta-DB instead of a dotfile on somebody's disk. One row per (project, provider) — today
-- the only provider is 'claude' (a long-lived OAuth token from `claude setup-token`, injected
-- into the zee-agent container's environment at spawn; the host's ~/.claude is never mounted).
--
-- The token column is the secret. The API NEVER returns it — read models get token_hint
-- (first/last few chars) and the spawn path alone reads the full value, stamping last_used_at
-- so a dead token is visible in the console. Delete the row to disconnect.
CREATE TABLE IF NOT EXISTS provider_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  token        text NOT NULL,
  token_hint   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (project_id, provider)
);
