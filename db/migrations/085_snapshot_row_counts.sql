-- WHAT A BACKUP CONTAINS, IN ROWS — TKT-22-4F0E ("im afraid the data might not be fully backed up").
--
-- Every existing check on a backup is about the ARCHIVE: the PGDMP magic, its size against the last
-- good dump, and its TOC (which TABLES it holds, and that it lost no schema). Not one of them counts a
-- row. So the question the ticket actually asked had no answer anywhere in the system, and the number
-- a worried human found instead — schema drift — is not an answer to it in either direction.
--
-- This records, per backup, WHAT WAS IN THE SOURCE when the dump was taken, so that:
--   • a table that SHRINKS between two backups becomes visible. That is the real shape of "my data is
--     not fully backed up", and nothing today would ever notice it.
--   • a RESTORE can be graded against its OWN source instead of against live production. Grading it
--     against live prod would repeat the exact mistake this ticket unpicked: prod keeps moving, so an
--     append-heavy table is always "short" and the check would cry wolf forever.
--
-- row_counts: { "schema.table": <estimated rows>, … } — pg_class.reltuples, the planner's estimate,
-- refreshed by ANALYZE/autovacuum. Deliberately NOT count(*): an exact count over a 600-table, 1.3 GB
-- production database is minutes of I/O for instrumentation, and the dump is the product here — the
-- counts must never cost the backup anything. Estimates are apples-to-apples for the trend (both sides
-- equally stale) and honest for the comparison as long as every surface says "estimate", which they do.
-- A table whose estimate is unknown (never analyzed) is recorded as -1 by postgres and reported as
-- "no reference" rather than guessed at.
--
-- row_total: the sum, for the one-line reading. NULL for both columns means the counts were not
-- captured (an older backup, a simulated one, or a probe that failed) — never zero, which would read
-- as "the database was empty".
ALTER TABLE db_snapshot ADD COLUMN IF NOT EXISTS row_counts jsonb;
ALTER TABLE db_snapshot ADD COLUMN IF NOT EXISTS row_total  bigint;

-- WHICH BACKUP A DATABASE WAS LOADED FROM. The data check compares a restored db against the counts
-- recorded for its source, so it has to know what that source WAS — and the answer must be recorded,
-- not inferred from timestamps. db_refresh already does this for pooled xell databases; a container
-- restore (the backups panel, and "Duplicate prod") recorded nothing at all, so "which dump is this
-- database?" was unanswerable for exactly the databases a human restores by hand.
--
-- restored_from: the db_snapshot it was restored from, NULL for a live "Duplicate prod" pipe (there is
-- no snapshot in the middle) — restored_note says which of those it was.
ALTER TABLE container ADD COLUMN IF NOT EXISTS restored_from uuid REFERENCES db_snapshot(id) ON DELETE SET NULL;
ALTER TABLE container ADD COLUMN IF NOT EXISTS restored_at   timestamptz;
ALTER TABLE container ADD COLUMN IF NOT EXISTS restored_note text;

-- The data-completeness verdict itself, kept SEPARATE from prod_diff on purpose. Merging them is the
-- defect this ticket found: one number that a human read as answering both "is my schema the same?"
-- and "is my data there?". Two columns, two questions, two colours.
ALTER TABLE container ADD COLUMN IF NOT EXISTS data_check    jsonb;
ALTER TABLE container ADD COLUMN IF NOT EXISTS data_check_at timestamptz;
