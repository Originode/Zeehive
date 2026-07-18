-- Pool size becomes a (machine, project) fact. One number on the machine row applied to every
-- project meant Zeehive kept as many warm xells as OmniBiz on the same host — but load is a
-- PROJECT property: a high-load project deserves a bigger pool on the same machine, a quiet one
-- shouldn't pin worktrees it won't claim. max_xells and dev_priority stay machine-wide: the
-- host's muscle and its preference order don't change per project.
CREATE TABLE IF NOT EXISTS machine_pool (
  machine_id  uuid NOT NULL REFERENCES machine ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  pool_size   integer NOT NULL DEFAULT 0 CHECK (pool_size >= 0),
  PRIMARY KEY (machine_id, project_id)
);

-- Seed from the flat per-machine sizes so today's behavior carries over unchanged — every project
-- starts with what it effectively had, and the console edits them apart from here.
INSERT INTO machine_pool (machine_id, project_id, pool_size)
SELECT m.id, p.id, m.pool_size FROM machine m CROSS JOIN project p WHERE m.pool_size > 0
ON CONFLICT DO NOTHING;

-- The old column stays (deprecated, unread by post-025 code) ONLY so the pre-025 queenzee keeps
-- ticking against this schema until its next safe restart; dropped by a later migration.
COMMENT ON COLUMN machine.pool_size IS
  'DEPRECATED since 025 — per-project pool sizes live in machine_pool. Unread by current code.';
