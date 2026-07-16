-- WHICH containers a ship deploys. Until now a ship always rebuilt BOTH server and webapp; the
-- zee had no way to say "only the webapp changed". The zee names its targets when the /ooney
-- pipeline raises the request; runShip filters on them. Empty is not a state — a ship of nothing
-- is not a ship, so the default stays "both" and the column is NOT NULL.
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS targets text[] NOT NULL DEFAULT '{server,webapp}';

COMMENT ON COLUMN ship_request.targets IS
  'Which prod roles this ship rebuilds (subset of {server,webapp}), chosen by the zee at request time.';
