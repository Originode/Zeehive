-- Backups/restores now run ASYNCHRONOUSLY (non-blocking child processes). A backup row is
-- created 'running' up-front and finalized 'finished' (with size) or 'failed' (with error) when
-- the dump completes — so the UI can show a per-backup spinner and the job never blocks a request.
ALTER TABLE db_snapshot
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'finished',   -- running | finished | failed
  ADD COLUMN IF NOT EXISTS error  text;

-- Generalize the per-container busy marker to cover BOTH the source db (during a backup) and the
-- target db (during a restore), so every container doing work shows a spinner. Additive: the old
-- restoring_since column stays (deprecated) so a still-running old server keeps working; new code
-- reads busy_since/busy_op. Backfill any in-flight restore.
ALTER TABLE container
  ADD COLUMN IF NOT EXISTS busy_since timestamptz,
  ADD COLUMN IF NOT EXISTS busy_op    text;            -- 'backup' | 'restore'
UPDATE container SET busy_since = restoring_since, busy_op = 'restore'
  WHERE restoring_since IS NOT NULL AND busy_since IS NULL;
