-- LANGFUSE PLUGIN FOLLOW-UPS — custom port + org name + 1:1 project mapping.
--
-- Three follow-ups to the shipped Langfuse plugin (114), all on the single-row
-- langfuse_config plus one new per-project table:
--
--   (A) custom PORT — the langfuse-web host port is currently fixed at LANGFUSE_PORT
--       (default 3000). It is already stored in host_port; nothing new is needed on the
--       schema, but provisioning must accept it (lib/langfuse.js) instead of only the env.
--
--   (B) custom ORG NAME — Langfuse's org is currently the compose default 'ZeeHive'.
--       This migration adds `org_name` so provisioning can record + re-seed it
--       (LANGFUSE_INIT_ORG_NAME / LANGFUSE_INIT_ORG_ID).
--
--   (C) 1:1 PROJECT MAPPING — every ZEEHIVE project gets its OWN Langfuse project + its own
--       public/secret key pair, so a project's traces land only in that project's Langfuse
--       scope. Creating Langfuse projects requires an ORG-SCOPED API key (POST
--       /api/public/projects), which a human pastes once at Setup (org_public_key /
--       org_secret_key, stored FULL + masked, provider-token discipline like 027). The map
--       table mirrors provider_token exactly: project_id FK ON DELETE CASCADE, full keys +
--       hints. The queenzee creates a Langfuse project + per-project API key for each
--       ZEEHIVE project on provision / "Sync projects", and scopes traces to it.
--
-- These columns are OPT-IN: provisioning works exactly as before without org keys (single
-- system trace project); the mapping + custom org/port are layered on when the human supplies
-- them. Migration is idempotent (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).

ALTER TABLE langfuse_config ADD COLUMN IF NOT EXISTS org_name text;

-- The ORG-SCOPED API key (the one that can create projects) — full values stored, hints on
-- the read model, revealed only to a human (exactly like public_key/secret_key).
ALTER TABLE langfuse_config ADD COLUMN IF NOT EXISTS org_public_key text;
ALTER TABLE langfuse_config ADD COLUMN IF NOT EXISTS org_secret_key text;
ALTER TABLE langfuse_config ADD COLUMN IF NOT EXISTS org_public_key_hint text;
ALTER TABLE langfuse_config ADD COLUMN IF NOT EXISTS org_secret_key_hint text;

-- ── the 1:1 ZEEHIVE-project → Langfuse-project map ────────────────────────────
-- One row per ZEEHIVE project that has a matching Langfuse project. Full per-project
-- public/secret key (what a zee of THAT project uses to POST traces), masked on the read
-- model. Mirrors provider_token (027): project_id REFERENCES project ON DELETE CASCADE, so
-- removing a ZEEHIVE project removes its Langfuse mapping. UNIQUE(project_id) = at most one
-- mapping per project; UNIQUE(langfuse_project_id) = one Langfuse project never doubles up.
CREATE TABLE IF NOT EXISTS langfuse_project_map (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  langfuse_project_id   text NOT NULL,
  langfuse_project_name text NOT NULL,
  public_key            text NOT NULL,
  secret_key            text NOT NULL,
  public_key_hint       text NOT NULL,
  secret_key_hint       text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id),
  UNIQUE (langfuse_project_id)
);

CREATE INDEX IF NOT EXISTS langfuse_project_map_project_idx ON langfuse_project_map (project_id);
