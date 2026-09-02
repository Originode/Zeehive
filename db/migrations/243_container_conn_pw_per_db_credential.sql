-- TKT-181-9EDA: a xell's generated DATABASE_URL is refused by its own database.
--
-- conn_ref is passwordless BY DESIGN ("secret NAME only, never the password", 001_init.sql):
-- a docker-exec psql authenticates through the container's socket (trust/peer), so the inventory
-- never needed the role password. But a CXELL zee has no docker and reaches postgres over TCP,
-- where postgres demands SCRAM. The queenzee's projection (resolveXellDsn, lib/provision.js)
-- had no per-database source of truth for the real password, so a worker xell's .zeehive.env
-- DATABASE_URL was emitted passwordless -- and the manifest db.password (the committed dev
-- credential) is NOT the actual password of every database (measured 2026-09-02: the ugreen-nas
-- shared dev db was created by provision-xell-db.sh's default 'omnibiz', the mardale-prod one by
-- the bootstrap compose 'zeehive'). A guessed password fails exactly as hard as none at all.
--
-- This column is that per-container source of truth: the ACTUAL password of the role conn_ref
-- names, recorded when the queenzee provisions/registers a db container (and backfilled from the
-- live container for rows that predate the column). resolveXellDsn injects it into every worker
-- DATABASE_URL so the DSN carries a credential that authenticates.
--
-- It is a STORED SECRET: lib/prod-readonly.js SECRET_COLUMNS must list container.conn_pw so the
-- SELECT-only meta-DB reader a manager/medic holds can never read it back out.
ALTER TABLE container ADD COLUMN IF NOT EXISTS conn_pw text;

COMMENT ON COLUMN container.conn_pw IS 'Actual password of the role the conn_ref names -- recorded at provision so a worker xell''s generated DATABASE_URL can carry a credential that authenticates over TCP (TKT-181-9EDA). A stored secret: lib/prod-readonly.js SECRET_COLUMNS keeps it from read-only roles.';
