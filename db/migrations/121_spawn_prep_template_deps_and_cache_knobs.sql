-- 121 — THE SPAWN TEMPLATE GETS DEPENDENCIES AND CACHE KNOBS
--
-- Until now "what is installed in a fresh xell" was one hard-coded line in the queenzee
-- (lib/cxell.js: warmInstallScript) — `npm ci`, then a web build, for every project, forever. Two
-- things fell out of that, and this column is both fixes:
--
--   1. A project that needs anything ELSE had no way to say so. The standing example is psql: a
--      zee's binding literally hands it `psql "postgresql://…"` and the cage has no psql in it, so
--      every zee that wants to look at its own database either works around it or spends its turn
--      installing one. Now the project's spawn template carries STEPS — npm, an npm script, apt
--      packages, or a shell line — that a human adds and removes in Project setup → Pool.
--
--   2. Nothing about HOW that install ran was tunable per project. The shared npm cache (ticket #7)
--      was a fleet-wide env var, so one project could not opt out of it and no project could opt
--      into anything else. The `cache` half of this column is those knobs: npm cache
--      shared/per-container, prefer-offline, omit-dev, and a shared apt archive cache so a second
--      cxell installing postgresql-client does not re-download it. Measured in a cxell against this
--      repo's own lockfile: cold cache 32s, warm shared cache 11s — that 3x is the shared cache, and
--      it is why 'shared' is the default and prefer-offline (16s, i.e. nothing above noise) is not.
--
-- SHAPE (server/src/lib/spawn-prep.js is the ONE normalizer — never read this column raw):
--   { "steps": [ { "key":"npm-deps", "kind":"npm|npm-run|apt|shell", "enabled":true, … } ],
--     "cache": { "npm":"shared|container", "npm_prefer_offline":true,
--                "npm_omit_dev":false, "apt":"shared|off" } }
--
-- NULL means "the built-in default", which is byte-for-byte the behaviour every project has today:
-- npm ci + the web build, shared npm cache. So this migration changes NOTHING until a human edits a
-- template — deliberately, because a default here is every project's dispatch path.
ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS spawn_prep jsonb;

COMMENT ON COLUMN pool_config.spawn_prep IS
  'Spawn template prep: {steps:[…], cache:{…}} — what is installed into a fresh xell and how it is '
  'cached. NULL = the built-in default (npm ci + web build, shared npm cache). Normalized by '
  'server/src/lib/spawn-prep.js; edited in Project setup → Pool.';
