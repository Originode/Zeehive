-- DEPLOY SITES — where a tier runs and how it is reached (docs/deploy-topology-spec.md §5).
--
-- Until now "where" lived in a single pair of project columns (docker_ctx_dev/docker_ctx_prod),
-- which cannot express a second production deployment (OmniBiz already has one: the registry-image
-- VPS stack in docker-compose.prod.yml). A deploy_site is one (project, location): its docker
-- context (or 'default' = the local machine's daemon — never NULL, so "local" is first-class and
-- NULL keeps meaning "unmonitored" on container rows), the daemon host, an optional per-site
-- compose/env override, and an ingress descriptor (lan | reverse-proxy | cloudflare-tunnel |
-- wireguard) describing how the stack is reached.

CREATE TABLE deploy_site (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  key          text NOT NULL,                        -- 'dev' | 'mardale-prod' | 'vps' | ...
  tier         container_tier NOT NULL,              -- dev | prod (spinoff instances live on the dev site)
  docker_ctx   text NOT NULL DEFAULT 'default',      -- 'default' = THIS machine's docker daemon
  host         inet,                                 -- LAN or WG address of the daemon host
  compose_file text,                                 -- overrides the manifest tier compose (e.g. vps → docker-compose.prod.yml)
  env_file     text,                                 -- site secrets file (a PATH; content is never stored)
  ingress      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {kind, public_url, proxy_role, provider_container, notes}
  reachable_at timestamptz,                          -- last successful reachability probe
  is_default   boolean NOT NULL DEFAULT false,       -- the site this tier's traffic goes to by default
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deploy_site_tier_placed CHECK (tier IN ('dev','prod')),
  UNIQUE (project_id, key)
);
-- exactly one default site per (project, tier)
CREATE UNIQUE INDEX deploy_site_default_uq ON deploy_site (project_id, tier) WHERE is_default;

ALTER TABLE container    ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES deploy_site ON DELETE SET NULL;
ALTER TABLE ship_request ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES deploy_site;  -- NULL = default prod site
ALTER TABLE deploy_lock  ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES deploy_site;  -- lock is PER SITE

CREATE INDEX container_site_idx ON container (site_id);

-- ── backfill from the deprecated project columns ────────────────────────────────────────────
-- Every project gets a default dev site (ctx falls back to 'default' = local daemon). A prod
-- site is created only where docker_ctx_prod is actually set — inventing a "prod on this
-- machine" site for a project that never configured prod would be a lie with consequences.
INSERT INTO deploy_site (project_id, key, tier, docker_ctx, host, is_default)
SELECT p.id, 'dev', 'dev', COALESCE(p.docker_ctx_dev, 'default'), p.dev_host_ip, true
  FROM project p
ON CONFLICT (project_id, key) DO NOTHING;

INSERT INTO deploy_site (project_id, key, tier, docker_ctx, host, compose_file, is_default)
SELECT p.id, p.docker_ctx_prod, 'prod', p.docker_ctx_prod, p.prod_host_ip, p.compose_prod, true
  FROM project p
 WHERE p.docker_ctx_prod IS NOT NULL
ON CONFLICT (project_id, key) DO NOTHING;

-- point existing containers at their site by (project, docker_ctx) match; spinoff rows live on
-- the dev site, shared dev/prod rows on their tier's site.
UPDATE container c
   SET site_id = s.id
  FROM deploy_site s
 WHERE c.site_id IS NULL
   AND s.project_id = c.project_id
   AND s.docker_ctx = c.docker_ctx
   AND s.tier = CASE WHEN c.tier = 'spinoff' THEN 'dev'::container_tier ELSE c.tier END;

COMMENT ON TABLE deploy_site IS
  'Where a project tier runs (docker context / host) and how it is reached (ingress). The project.docker_ctx_dev/_prod columns are deprecated in its favor.';
COMMENT ON COLUMN deploy_site.docker_ctx IS
  '''default'' means the local machine''s docker daemon — the sanctioned spelling of "just this machine".';
