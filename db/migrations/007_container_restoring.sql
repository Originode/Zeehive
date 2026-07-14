-- A db container being restored from a backup snapshot is BUSY. Mark it (set at restore start,
-- cleared at finish) so the UI can show a spinner and lock out builds/actions until it's done —
-- restoring and (re)building a container at the same time would mangle it. Building already has
-- its own signal (container.health='building'); this covers the restore case.
ALTER TABLE container ADD COLUMN IF NOT EXISTS restoring_since timestamptz;
