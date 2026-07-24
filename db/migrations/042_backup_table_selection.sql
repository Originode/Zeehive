-- Table-scoped backups & restores. Until now every prod backup dumped the WHOLE database and every
-- restore loaded the WHOLE archive. Operators want to scope both: skip a bulky/volatile table from
-- the nightly dump, or restore just a handful of tables into a dev db without clobbering the rest.
--
-- backup_tables — the DEFAULT selection applied to scheduled + manual prod backups. NULL or [] means
--   "the whole database" (today's behaviour, and the default). A non-empty array of 'schema.table'
--   strings makes pg_dump include ONLY those tables (pg_dump -t), i.e. a SCOPED dump.
ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS backup_tables jsonb;

-- db_snapshot.tables — what a given dump actually captured: NULL = the full database, a JSON array =
--   the exact scoped selection. Two jobs read it: (1) the content/size guards skip a scoped dump
--   (a partial dump is SMALLER and has FEWER schemas than a full one BY DESIGN — comparing them would
--   falsely cry "wrong/empty database"), and a scoped dump is never used as the ruler a later full
--   dump is validated against; (2) the restore picker offers exactly the tables a dump contains.
ALTER TABLE db_snapshot ADD COLUMN IF NOT EXISTS tables jsonb;
