-- Spawn-template default for WHERE a new xell's images compile. Inherited by both buildable
-- containers at provision (server/src/lib/provision.js), exactly like default_db_coupling.
-- NULL ⇒ compile on the run host (today's behavior). A non-null value is validated against the
-- project's registry when set, so a default that can't hand its image over is refused up front.
ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS default_build_ctx text;
