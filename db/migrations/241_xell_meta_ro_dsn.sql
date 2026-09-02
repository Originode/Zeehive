-- XELL META-RO DSN — the infra-medic's read-only bind to the orchestrator's OWN meta-DB
-- (provision-proof plan §7, stage 3, build item 4).
--
-- A medic wears the infra-medic harness and holds the 'infra-troubleshoot' capability. At dispatch
-- the queenzee mints it a per-xell `zee_ro_<slug>` role on the META-DB this server itself connects
-- to (LOGIN+CONNECT+SELECT, `default_transaction_read_only=on`, secret columns revoked — the same
-- machinery lib/prod-readonly.js uses for a manager, aimed at a different database). That minted
-- DSN lives HERE, exactly the way a manager's prod reader lives in prod_ro_dsn (052): it is what
-- .zeehive.env's ZEEHIVE_META_RO_DSN is emitted from, what the boot reconcile re-projects, and what
-- the reaper clears when it drops the role with the xell.
--
-- `meta_ro_dsn` is a SECRET (it embeds the role's password). prod-readonly.js's SECRET_COLUMNS
-- must list it so a manager's SELECT-only role never reads another xell's meta DSN back out; the
-- column lives beside prod_ro_dsn for the same reason that one is a column and not a bundle field.

ALTER TABLE xell ADD COLUMN IF NOT EXISTS meta_ro_dsn text;

COMMENT ON COLUMN xell.meta_ro_dsn IS
  'The infra-medic meta-DB read-only DSN (a per-xell zee_ro_<slug> role on the orchestrator''s own meta-DB, minted by lib/prod-readonly.js when the worn effective harness carries the infra-troubleshoot capability). SECRET — embeds a password; prod-readonly.js revokes it from every read-only role. Dropped by the reaper with the xell. A live value here is the only reason .zeehive.env carries ZEEHIVE_META_RO_DSN.';
