-- WHAT ELSE A SHIP APPLIES: the schema the new process runs at BOOT (ticket #12).
--
-- `ship_request.migrations` (014) records the DEPLOY-TIME set: server/sql/migrations|ops files the
-- queenzee applies to the production database before the containers build. That is the whole story
-- for a normal project — and it was `[]` for every Zeehive ship, because Zeehive migrates ITSELF:
-- runMigrations() applies db/migrations/*.sql to the live meta-DB as the new server comes up.
--
-- So the ship card told the approving human "no migrations" while a deploy applied five, including
-- one that repaired live data loss and two that rewrote the manual every zee reads. The gate was
-- less informative than the human believed it was — the same class of failure as a harness that
-- rendered healthy while carrying nothing.
--
-- Kept as its OWN column rather than merged into `migrations`, because the two carry different
-- risk: deploy-time runs under the queenzee's control before anything swaps and a failure stops the
-- ship; boot-time runs inside the new process after the swap, where a failure leaves a started
-- server on a partly-migrated schema. A card that merged them would misstate both.
--
-- Shape: NULL = not computed (a row from before this existed, or a project with no boot schema).
--   { "applicable": bool, "dir": "db/migrations", "ok": bool, "pending": ["075_x.sql"],
--     "applied": 74, "via": "own-pool"|"psql", "error": null }
-- ok:false is LOUD by design: the card must say "unknown", never "none" — an unreadable ledger
-- rendering as zero is exactly the bug this fixes.
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS boot_migrations jsonb;

COMMENT ON COLUMN ship_request.boot_migrations IS
  'Schema the SHIPPED PROCESS applies at boot (Zeehive: db/migrations/*.sql via runMigrations() against the meta-DB), resolved at request time. NULL = not computed; {ok:false} = the ledger could not be read, which the card must show as UNKNOWN rather than none.';
