-- Dev spawn PRIORITY becomes a (machine, project) fact — the twin of what 025 did for pool_size.
-- One dev_priority on the machine row meant a host's spawn preference was shared across every
-- project: raise "local first" for one project and you raised it for all of them, and a machine
-- was a dev target either for everyone or for no one. But WHERE a project's work should land is a
-- PROJECT choice — one project may want everything on the beefy build box, another may keep to the
-- laptop. So priority moves next to pool_size in machine_pool; max_xells (the hard cap on live dev
-- xells) STAYS machine-wide — that is the host's muscle, shared by whoever's xells they are.
ALTER TABLE machine_pool
  ADD COLUMN IF NOT EXISTS dev_priority integer NOT NULL DEFAULT 0 CHECK (dev_priority >= 0);

-- Carry today's machine-wide priority into every project so behavior is unchanged on upgrade:
-- update the pool rows that already exist, then create rows for (machine, project) pairs that had
-- a priority but no pool row (a machine a project could spawn on but kept no warm pool for).
UPDATE machine_pool mp SET dev_priority = m.dev_priority
  FROM machine m WHERE mp.machine_id = m.id AND m.dev_priority > 0;

INSERT INTO machine_pool (machine_id, project_id, pool_size, dev_priority)
SELECT m.id, p.id, 0, m.dev_priority FROM machine m CROSS JOIN project p WHERE m.dev_priority > 0
ON CONFLICT (machine_id, project_id) DO UPDATE SET dev_priority = EXCLUDED.dev_priority;

-- The old column stays (deprecated, unread by post-038 code) ONLY so a pre-038 queenzee keeps
-- ticking against this schema until its next safe restart; dropped with machine.pool_size later.
COMMENT ON COLUMN machine.dev_priority IS
  'DEPRECATED since 038 — per-project dev priorities live in machine_pool.dev_priority. Unread by current code.';
