-- ENVIRONMENTS — the meta-DB becomes the source of truth for the env vars git ignores.
--
-- Until now a project's real secrets/app config (the actual `.env`) lived as a PATH on disk
-- (deploy_site.env_file / project.env_file — 015 says outright "content is never stored"). That
-- is the one class of env NOT in the meta-DB, and it is exactly the untracked class: no backup,
-- no history, no source of truth. This mirrors the provider_token pattern (027/036) — secrets in
-- the meta-DB, a masked read model, a single full-read door — and generalises it to arbitrary
-- named env-var sets a project can hold and hand to its xells.
--
-- Shape mirrors deploy_site (015): per-project, keyed, tier-defaulted, one default per tier.
-- Resolution for a xell (lib/environments.js): explicit xell.environment_id wins; else a live-prod
-- or is_production xell gets the default PROD environment; else the default DEV one. The resolved
-- set is merged into .zeehive.env by emitXellEnv — AFTER per-xell truth (ports/DATABASE_URL/site),
-- which stays authoritative, and never overriding the manifest safety defaults appended last.

CREATE TABLE environment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  key         text NOT NULL,                    -- 'dev' | 'prod' | 'staging' | ...
  label       text,
  tier        container_tier NOT NULL,          -- dev | prod (which tier this env serves by default)
  description text,
  is_default  boolean NOT NULL DEFAULT false,   -- the env a xell of this tier gets when unpinned
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key),
  -- spinoff instances resolve to the DEV environment; an environment is only ever dev or prod
  CONSTRAINT environment_tier_ok CHECK (tier IN ('dev','prod'))
);
-- exactly one default environment per (project, tier) — same partial-unique trick as deploy_site
CREATE UNIQUE INDEX environment_default_uq ON environment (project_id, tier) WHERE is_default;

CREATE TABLE environment_var (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environment ON DELETE CASCADE,
  name           text NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  value          text NOT NULL DEFAULT '',      -- the SECRET; the API NEVER returns it for is_secret rows
  is_secret      boolean NOT NULL DEFAULT true, -- false → shown in the read model (flags, hosts, ports)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, name)
);
CREATE INDEX environment_var_env_idx ON environment_var (environment_id);

-- explicit per-xell override; NULL = resolve by tier (the normal case). ON DELETE SET NULL so
-- dropping an environment a xell was pinned to falls it back to the tier default, never orphans it.
ALTER TABLE xell ADD COLUMN environment_id uuid REFERENCES environment ON DELETE SET NULL;

-- Backfill: every project gets an empty dev + prod environment, each the default of its tier.
-- Empty on purpose — emitXellEnv adds nothing until a human fills one, so existing xells emit
-- exactly what they do today. Importing on-disk env_file content is a human's one-click act
-- (console → import), never a silent slurp of somebody's secrets into the DB.
INSERT INTO environment (project_id, key, tier, label, is_default, description)
SELECT p.id, 'dev', 'dev', 'Development', true,
       'Default environment for dev/spinoff xells. Fill from Project setup → Environments.'
  FROM project p
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO environment (project_id, key, tier, label, is_default, description)
SELECT p.id, 'prod', 'prod', 'Production', true,
       'Loaded into production xells and any xell bound to the live prod database.'
  FROM project p
ON CONFLICT (project_id, key) DO NOTHING;

COMMENT ON TABLE environment IS
  'A named set of env vars per project — the meta-DB source of truth for the untracked .env. Resolved to a xell by tier (lib/environments.js) and merged into .zeehive.env by emitXellEnv.';
COMMENT ON COLUMN environment_var.value IS
  'The secret value. Never returned by the API for is_secret rows — only emitXellEnv and the human export/reveal read it (mirrors provider_token).';
