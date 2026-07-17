-- WHERE a ship's code comes from (docs/deploy-topology-spec.md §5 + onboarding UI).
-- NULL (the default, and OmniBiz's setting) = the LOCAL main branch of repo_root — the
-- anti-band-aid rule unchanged. A project whose integration truth lives on a remote may set
-- e.g. 'origin/main'; requestShip fetches that remote first so the approved sha is current.
ALTER TABLE project ADD COLUMN IF NOT EXISTS ship_ref text;

COMMENT ON COLUMN project.ship_ref IS
  'Git ref a prod ship builds from. NULL = local main_branch. A remote ref (origin/main) is fetched at request time.';
