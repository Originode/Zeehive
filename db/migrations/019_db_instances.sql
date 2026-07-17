-- DB INSTANCES: a db container CONTAINS databases — model them first-class.
--
-- 018 bolted db-clone on as two scalar columns (xell.clone_db_name, container.clone_tpl_at),
-- which could describe exactly one clone per xell and one template per container, invisibly to
-- the inventory. But the truth is structural: one postgres container holds MANY databases — the
-- primary (shared dev / prod), the clone template, and a clone per schema-work xell. This table
-- says so, carries per-INSTANCE prod drift (a clone's drift is its xell's business, not the
-- shared chip's), and gives discovery somewhere to record what pg_database actually reports —
-- including orphaned clones whose xell is long gone.
--
-- The 018 columns are DROPPED (one truth): they were applied but never read by live code.
CREATE TABLE db_instance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id  uuid NOT NULL REFERENCES container ON DELETE CASCADE,
  name          text NOT NULL,                       -- datname inside this container's postgres
  kind          text NOT NULL CHECK (kind IN ('primary','template','clone','other')),
  -- set for a LIVE clone; ON DELETE SET NULL so a drop-failed clone survives its xell as a
  -- visible ORPHAN (kind='clone', owner NULL) instead of vanishing from the books
  owner_xell_id uuid REFERENCES xell ON DELETE SET NULL,
  prod_diff     jsonb,                               -- same payload shape as container.prod_diff
  prod_diff_at  timestamptz,
  refreshed_at  timestamptz,                         -- template: last rebuild; clone: cut time
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,                         -- last time discovery saw it in pg_database
  UNIQUE (container_id, name),
  CONSTRAINT db_instance_owner_is_clones CHECK (kind = 'clone' OR owner_xell_id IS NULL)
);
CREATE INDEX db_instance_owner_idx     ON db_instance (owner_xell_id);
CREATE INDEX db_instance_container_idx ON db_instance (container_id, kind);

-- Every db container has its primary database (the project's application db).
INSERT INTO db_instance (container_id, name, kind)
SELECT c.id, COALESCE(p.db_name, lower(p.name)), 'primary'
  FROM container c JOIN project p ON p.id = c.project_id
 WHERE c.role = 'db'
ON CONFLICT DO NOTHING;

-- Templates already tracked by 018's column.
INSERT INTO db_instance (container_id, name, kind, refreshed_at)
SELECT c.id, COALESCE(p.db_name, lower(p.name)) || '_zeehive_tpl', 'template', c.clone_tpl_at
  FROM container c JOIN project p ON p.id = c.project_id
 WHERE c.role = 'db' AND c.clone_tpl_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- Clones already recorded by 018's column (belt and braces — the feature never went live).
INSERT INTO db_instance (container_id, name, kind, owner_xell_id)
SELECT uc.container_id, x.clone_db_name, 'clone', x.id
  FROM xell x
  JOIN xell_uses_container uc ON uc.xell_id = x.id
  JOIN container c ON c.id = uc.container_id AND c.role = 'db'
 WHERE x.clone_db_name IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE xell      DROP COLUMN IF EXISTS clone_db_name;
ALTER TABLE container DROP COLUMN IF EXISTS clone_tpl_at;
