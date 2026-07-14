-- Regular production DB backups: where dumps are written, how often, and how many to keep.
-- The backup rows themselves already live in db_snapshot (dump_path per row, from 001_init).
ALTER TABLE pool_config
  ADD COLUMN IF NOT EXISTS backup_dir          text,               -- null → server default (<repo>/db_backups)
  ADD COLUMN IF NOT EXISTS backup_interval_sec int NOT NULL DEFAULT 86400,   -- daily
  ADD COLUMN IF NOT EXISTS max_backups         int NOT NULL DEFAULT 14;      -- housekeeping keeps the newest N

-- Housekeeping deletes old db_snapshot rows once we exceed max_backups. A db_refresh may
-- reference the snapshot it restored from — don't block the delete; just forget the link.
ALTER TABLE db_refresh DROP CONSTRAINT IF EXISTS db_refresh_snapshot_id_fkey;
ALTER TABLE db_refresh
  ADD CONSTRAINT db_refresh_snapshot_id_fkey
  FOREIGN KEY (snapshot_id) REFERENCES db_snapshot ON DELETE SET NULL;
