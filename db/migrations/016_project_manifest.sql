-- PROJECT MANIFEST + APP-DB IDENTITY (docs/deploy-topology-spec.md §3.1, Appendix A).
--
-- db_name/db_user: the application database's identity is a PROJECT fact. Until now it lived in
-- the global PROD_DB_NAME/PROD_DB_USER env — wrong the moment a second project exists (two
-- projects cannot share one env var). The env vars remain as last-resort fallback only.
--
-- manifest: a cached copy of the repo's zeehive.yml, parsed and validated at onboarding/refresh,
-- so the queenzee can answer naming/compose/port questions WITHOUT reading the repo on every
-- decision. The repo file is the truth; this is a projection stamped with its hash, and drift
-- between the two is a surfaced condition, not a silent one.

ALTER TABLE project
  ADD COLUMN IF NOT EXISTS db_name       text,
  ADD COLUMN IF NOT EXISTS db_user       text,
  ADD COLUMN IF NOT EXISTS manifest      jsonb,
  ADD COLUMN IF NOT EXISTS manifest_hash text,
  ADD COLUMN IF NOT EXISTS manifest_at   timestamptz;

-- Existing projects: the app db has always been named after the project (omnibiz), and the
-- backup/diff paths already default the user to postgres. Make that explicit per project.
UPDATE project SET db_name = lower(name) WHERE db_name IS NULL;
UPDATE project SET db_user = 'postgres'  WHERE db_user IS NULL;

COMMENT ON COLUMN project.db_name IS
  'Name of the application database inside this project''s db containers (NOT the zeehive meta-DB).';
COMMENT ON COLUMN project.manifest IS
  'Cached parse of the repo''s zeehive.yml (truth lives in the repo; manifest_hash detects drift).';
