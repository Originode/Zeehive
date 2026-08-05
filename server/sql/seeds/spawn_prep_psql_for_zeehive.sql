-- Give the ZEEHIVE project's spawn template a `psql` step (migration 121, pool_config.spawn_prep).
--
-- WHY THIS FILE EXISTS. A zee's own binding hands it, verbatim:
--     "psql": "psql \"postgresql://…\""
-- and the cxell image has no psql in it. Every zee that wants to look at the database it was given
-- therefore discovers the gap mid-turn and either works around it or spends part of its turn (and
-- the allowance) installing one. Migration 121 made "what a fresh xell is prepped with" editable per
-- project; this is that edit, applied to the project the fleet actually runs on.
--
-- It is a SEED and not a migration on purpose: it changes one project's configuration, which is data
-- a human should be able to see, approve and reverse — not schema. Approve it with `zee seed` (a
-- human reads this SQL in the console and the queenzee runs it), or make the same edit by hand in
-- Project setup → Pool → Dependencies & cache, where it is two clicks.
--
-- IDEMPOTENT, as a seed must be (seeds are not ledgered and may legitimately be re-run):
--   * it starts from the EFFECTIVE template — the stored one if there is one, the built-in default
--     if there is not — so it never overwrites another edit;
--   * it is a no-op when a psql step is already there, whatever that step was named;
--   * it only ever APPENDS. Nothing here disables or removes a step somebody added.
--
-- COST: one apt install per cxell spawn, ~5-15s with the shared apt archive cache warm. The
-- PREP_STEP timing line in the spawn log says exactly what it costs on this fleet — if that number
-- is ever the reason a spawn is slow, the answer is a cxell image that bakes psql in, not this.
WITH effective AS (
  SELECT
    p.id AS project_id,
    COALESCE(pc.spawn_prep, jsonb_build_object(
      'steps', jsonb_build_array(
        jsonb_build_object('key','npm-deps','kind','npm','enabled',true,'label','Node dependencies (npm ci)'),
        jsonb_build_object('key','web-build','kind','npm-run','enabled',true,'script','build --workspace web',
                           'allow_failure',true,'label','Prebuild the web bundle')),
      'cache', jsonb_build_object('npm','shared','npm_prefer_offline',false,'npm_omit_dev',false,'apt','shared')
    )) AS prep
  FROM project p
  JOIN pool_config pc ON pc.project_id = p.id
  WHERE p.name = 'Zeehive'
)
UPDATE pool_config pc
   SET spawn_prep = jsonb_set(
         e.prep, '{steps}',
         (e.prep -> 'steps') || jsonb_build_array(jsonb_build_object(
           'key','psql', 'kind','apt', 'enabled',true, 'root',true,
           'label','psql (postgresql-client)',
           'packages', jsonb_build_array('postgresql-client'))))
  FROM effective e
 WHERE pc.project_id = e.project_id
   -- already has a step that installs postgresql-client (under any key) → nothing to do
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(e.prep -> 'steps') s
      WHERE s ->> 'kind' = 'apt'
        AND (s -> 'packages') ? 'postgresql-client');
