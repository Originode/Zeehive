-- Backups get a NETWORK destination, and a record of WHERE each dump actually landed.
--
-- Regression 1 (2026-07-19): pool_config.backup_dir was NULL for every project, so every dump
-- fell back to /backups — the zeehive_backups volume INSIDE the server container. Before
-- containerization the queenzee was a host process and could reach the NAS path directly; the
-- container silently redirected four days of "successful" backups onto a local volume nobody
-- could restore from. A directory string alone can't fix that: the NAS is on ANOTHER machine.
--
-- backup_ctx : the DOCKER CONTEXT whose host owns backup_dir. This reuses the mechanism the whole
--              system already trusts — a docker context — so NO SMB credentials live in Zeehive
--              and nothing mounts CIFS in the server container. The dump is streamed straight from
--              the source db's context to a throwaway container on backup_ctx that writes it to a
--              bind-mounted backup_dir on that context's host (e.g. ugreen-nas → /volume3/maki/...).
--              NULL ⇒ today's behavior exactly: write to backup_dir on the local host (the volume).
ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS backup_ctx text;

-- dest_ctx : which context a given dump was WRITTEN to. dump_path alone is now ambiguous — the
--            same "/volume3/maki/Backups/Omnibiz/db/x.dump" means one thing on ugreen-nas and
--            nothing on the local host. Restore and retention read this to reach the right host;
--            NULL ⇒ the dump is a local file on the queenzee host (pre-040 rows, and local mode).
ALTER TABLE db_snapshot ADD COLUMN IF NOT EXISTS dest_ctx text;

-- toc_summary : the schemas + table count pg_restore --list saw in the VALIDATED dump. Lets the
--               next backup's guard assert continuity ("the last good backup had schema core; this
--               one lost it — you are dumping the wrong database") without re-reading a 1.2 GB
--               remote file, and lets the UI show what a restore point actually contains.
--               NULL ⇒ legacy/simulated row whose contents were never fingerprinted.
ALTER TABLE db_snapshot ADD COLUMN IF NOT EXISTS toc_summary jsonb;
