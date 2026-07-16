-- SCHEMA DRIFT FROM PRODUCTION — make it visible instead of discoverable.
--
-- WHY: a whole afternoon went into finding, by hand, that the prod DB was missing objects the
-- DEPLOYED prod code already referenced (erp_restaurant.kitchen_claim + friends). Nothing in the
-- system knew. OmniBiz has no migration runner and no ledger, so a database cannot be asked what
-- it is missing — the only way to know is to diff it against another one. That diff was a human
-- with psql. This makes it a routine the queenzee runs, and a colour on the chip.
--
-- The reference is always the project's PRODUCTION db (role='db', tier='prod'). Prod is compared
-- against nothing — it IS the ruler, so its own prod_diff stays NULL.
--
-- prod_diff shape (NULL = never checked; the UI shows no drift badge):
--   {
--     "ok": true,                       -- false => could not compare; see "error"
--     "error": null,
--     "total": 12,                      -- missing+extra across all kinds; 0 => in sync
--     "kinds": {
--        "table":   {"missing":["erp_x.y"], "extra":[]},
--        "column":  {"missing":["erp_x.y.z:text"], "extra":[]},
--        "trigger": {"missing":["erp_x.y.trg"], "extra":[]}
--     }
--   }
-- "missing" = prod has it, this db does not (the dangerous direction: code expects it).
-- "extra"   = this db has it, prod does not (usually unshipped work, or legacy).
--
-- Lists are TRUNCATED to a sample by the writer (see queenzee/proddiff.js) — this column feeds a
-- tooltip, not an audit. The counts are exact; the samples are illustrative.
ALTER TABLE container ADD COLUMN IF NOT EXISTS prod_diff    jsonb;
ALTER TABLE container ADD COLUMN IF NOT EXISTS prod_diff_at timestamptz;

COMMENT ON COLUMN container.prod_diff IS
  'Schema+trigger drift vs the project''s prod db. NULL=never checked. total=0 means in sync.';
COMMENT ON COLUMN container.prod_diff_at IS
  'When prod_diff was last computed (regardless of outcome).';

-- Only db containers are ever compared, and the UI filters on drift, so index the common lookup:
-- "which db containers have drifted?" Partial — most rows are not dbs and never get a prod_diff.
CREATE INDEX IF NOT EXISTS idx_container_prod_drift
    ON container (((prod_diff->>'total')::int))
 WHERE prod_diff IS NOT NULL;
