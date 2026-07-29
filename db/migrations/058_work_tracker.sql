-- WORK TRACKER — the layer ZEEHIVE was missing: what the work IS.
--
-- Everything in this meta-schema so far records which AGENTS are running: xells, zees, containers,
-- gates. Nothing records the WORK. A manager zee therefore has a hive and no plan — it can see that
-- four zees are alive, and nothing at all about what any of them is for, what is blocked behind
-- what, or what is left. This migration adds that layer:
--
--   ticket      — what came IN (a bug, a feature, a question). Per-project numbered, commentable.
--   work_item   — what the work IS, as a HIERARCHY: project → activity → task (→ subtask).
--                 A work item is the thing a manager assigns a zee to (xell_id) and the thing a
--                 board column / gantt row is drawn from.
--   work_item_dep    — finish→start edges, for the gantt.
--   work_item_event  — the audit trail (created | status | moved | assigned | edited | comment).
--
-- Two rules make the hierarchy trustworthy, and both live HERE rather than in application code,
-- because this repo's house style is "constraints/triggers encode the impossibilities" (001_init):
--
--   1. EVERY project has exactly ONE root work item of kind 'project', created by trigger for new
--      projects and backfilled for existing ones. Anything else without an explicit parent is
--      attached to it. That is what makes "everything under Zeehive is a descendant of Zeehive"
--      true by construction rather than by convention.
--   2. NESTING RANK: project(0) < activity(1) < task(2), and a child's rank must be >= its
--      parent's. So an activity sits under a project, a task under an activity, a task under a task
--      (subtasks) — and an activity can NEVER appear under a task, which is the shape that makes a
--      gantt roll-up meaningful.
--
-- The STATUS vocabulary is deliberately not new: work_status is the zee lifecycle (task_status:
-- queued/assigned/working/done/cancelled) plus the three states a zee visibly passes through that
-- the hive already names — occ-tendRequest → blocked, occ-land* → review, occ-ship* → shipping.
-- server/src/lib/work-status.js is the single source of truth for the display side of it and maps
-- a live hive status onto this enum, exactly as lib/hive-status.js does for a xell.

-- ── enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE work_status AS ENUM
    ('queued','assigned','working','blocked','review','shipping','done','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE work_item_kind AS ENUM ('project','activity','task');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_kind AS ENUM ('bug','feature','chore','question','incident');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── what came IN ─────────────────────────────────────────────────────────────
-- work_item_id (the item a ticket was broken down into) is added as a plain column and wired to
-- work_item further down: the two tables reference each other, so one FK has to come second.
CREATE TABLE IF NOT EXISTS ticket (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  number       int NOT NULL,                       -- per-project sequence, assigned by trigger
  title        text NOT NULL,
  body         text,
  kind         ticket_kind NOT NULL DEFAULT 'feature',
  status       work_status NOT NULL DEFAULT 'queued',
  priority     int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  reporter     text,
  assignee     text,
  labels       text[] NOT NULL DEFAULT '{}',
  work_item_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS ticket_comment (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES ticket ON DELETE CASCADE,
  author     text,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── what the work IS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  parent_id      uuid REFERENCES work_item ON DELETE CASCADE,
  kind           work_item_kind NOT NULL,
  title          text NOT NULL,
  body           text,
  status         work_status NOT NULL DEFAULT 'queued',
  priority       int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  ticket_id      uuid REFERENCES ticket ON DELETE SET NULL,
  xell_id        uuid REFERENCES xell ON DELETE SET NULL,  -- the worker zee currently on it (part 2)
  assignee       text,                                     -- free text: a human, when not a zee
  starts_on      date,
  due_on         date,
  estimate_hours numeric(8,2),
  progress       int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  sort_order     double precision NOT NULL DEFAULT 1000,   -- rank among siblings / within a column
  path           text NOT NULL DEFAULT '',                 -- '<ancestor>/<ancestor>/' , root = ''
  depth          int NOT NULL DEFAULT 0,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  -- IMPOSSIBILITY: a 'project' item is ALWAYS a root. It represents the project itself, so a
  -- project hanging under an activity would be a second, contradictory tree.
  CONSTRAINT work_item_project_is_root CHECK (kind <> 'project' OR parent_id IS NULL)
);

-- IMPOSSIBILITY: exactly ONE root item per project row. Everything else is a descendant of it.
CREATE UNIQUE INDEX IF NOT EXISTS work_item_one_project_root
  ON work_item (project_id) WHERE kind = 'project';

-- the second half of the ticket ↔ work_item pair (see the note on ticket.work_item_id)
DO $$ BEGIN
  ALTER TABLE ticket ADD CONSTRAINT ticket_work_item_fk
    FOREIGN KEY (work_item_id) REFERENCES work_item ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- finish→start edges for the gantt. Same-project only, never self (trigger below).
CREATE TABLE IF NOT EXISTS work_item_dep (
  work_item_id  uuid NOT NULL REFERENCES work_item ON DELETE CASCADE,
  depends_on_id uuid NOT NULL REFERENCES work_item ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_item_id, depends_on_id)
);

-- the audit trail. kind: created | status | moved | assigned | edited | comment
CREATE TABLE IF NOT EXISTS work_item_event (
  id           bigserial PRIMARY KEY,
  work_item_id uuid REFERENCES work_item ON DELETE CASCADE,
  ts           timestamptz NOT NULL DEFAULT now(),
  kind         text,
  from_status  work_status,
  to_status    work_status,
  actor        text,
  detail       jsonb
);

-- Part 2 stamps a dispatched worker's task with the item it was dispatched FOR. The column is added
-- HERE, now, so two workers never have to fight over one migration number for it.
ALTER TABLE task ADD COLUMN IF NOT EXISTS work_item_id uuid REFERENCES work_item ON DELETE SET NULL;

-- ── indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS work_item_project_status_idx ON work_item (project_id, status);
CREATE INDEX IF NOT EXISTS work_item_parent_idx         ON work_item (parent_id);
-- text_pattern_ops: every subtree read is `path LIKE '<prefix>%'`, which only uses an index under
-- this opclass unless the database happens to be in the C collation.
CREATE INDEX IF NOT EXISTS work_item_path_idx           ON work_item (path text_pattern_ops);
CREATE INDEX IF NOT EXISTS work_item_ticket_idx         ON work_item (ticket_id);
CREATE INDEX IF NOT EXISTS work_item_xell_idx           ON work_item (xell_id);
CREATE INDEX IF NOT EXISTS ticket_project_status_idx    ON ticket (project_id, status);
CREATE INDEX IF NOT EXISTS ticket_comment_ticket_idx    ON ticket_comment (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS work_item_event_item_idx     ON work_item_event (work_item_id, ts DESC);

-- ── shared helpers ───────────────────────────────────────────────────────────
-- terminal statuses. Kept as a function so the DB and work-status.js state the SAME two, and a
-- future third terminal state is one edit in each place rather than a grep.
CREATE OR REPLACE FUNCTION work_status_is_terminal(s work_status) RETURNS boolean AS $$
  SELECT s IN ('done','cancelled');
$$ LANGUAGE sql IMMUTABLE;

-- nesting rank: project(0) < activity(1) < task(2)
CREATE OR REPLACE FUNCTION work_item_rank(k work_item_kind) RETURNS int AS $$
  SELECT CASE k WHEN 'project' THEN 0 WHEN 'activity' THEN 1 ELSE 2 END;
$$ LANGUAGE sql IMMUTABLE;

-- ── triggers ─────────────────────────────────────────────────────────────────

-- updated_at + closed_at, for both ticket and work_item. Entering a terminal status STAMPS
-- closed_at; leaving one CLEARS it, so "closed_at is set" and "the status is terminal" can never
-- disagree — a reopened item that still reads as closed is the classic tracker lie.
CREATE OR REPLACE FUNCTION work_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    IF work_status_is_terminal(NEW.status) AND NEW.closed_at IS NULL THEN NEW.closed_at := now(); END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF work_status_is_terminal(NEW.status) THEN
      IF NEW.closed_at IS NULL THEN NEW.closed_at := now(); END IF;
    ELSE
      NEW.closed_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_item_touch_trg ON work_item;
CREATE TRIGGER work_item_touch_trg BEFORE INSERT OR UPDATE ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_touch();
DROP TRIGGER IF EXISTS ticket_touch_trg ON ticket;
CREATE TRIGGER ticket_touch_trg BEFORE INSERT OR UPDATE ON ticket
  FOR EACH ROW EXECUTE FUNCTION work_touch();

-- The work_item guard: parentage, rank, cycles, and the materialized path/depth.
--
-- path is the '/'-joined list of ANCESTOR ids, each followed by '/': a root has '', its child has
-- '<root>/', a grandchild '<root>/<child>/'. So an item's whole subtree is `path LIKE path||id||'/%'`
-- (one index scan, no recursive CTE) and its ancestors are the path split on '/'. Because the path
-- already carries every ancestor id, the CYCLE check is a substring test rather than a walk.
CREATE OR REPLACE FUNCTION work_item_guard() RETURNS trigger AS $$
DECLARE
  p_project uuid; p_kind work_item_kind; p_path text; p_depth int; root_id uuid;
BEGIN
  -- A non-project item with no parent is attached to its project's ROOT item rather than being
  -- refused: that is what keeps "every work item is a descendant of the project root" true no
  -- matter which caller created it.
  IF NEW.parent_id IS NULL AND NEW.kind <> 'project' THEN
    SELECT id INTO root_id FROM work_item
      WHERE project_id = NEW.project_id AND kind = 'project' AND id IS DISTINCT FROM NEW.id;
    IF root_id IS NULL THEN
      RAISE EXCEPTION 'project % has no root work item to attach "%" to', NEW.project_id, NEW.title;
    END IF;
    NEW.parent_id := root_id;
  END IF;

  IF NEW.parent_id IS NULL THEN
    NEW.path := ''; NEW.depth := 0;
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'a work item cannot be its own parent';
  END IF;

  SELECT project_id, kind, path, depth INTO p_project, p_kind, p_path, p_depth
    FROM work_item WHERE id = NEW.parent_id;
  IF p_project IS NULL THEN
    RAISE EXCEPTION 'parent_id % names no work item', NEW.parent_id;
  END IF;
  -- IMPOSSIBILITY: a child in a different project than its parent. The tree is per-project; a
  -- cross-project edge would make every subtree read (and every roll-up) silently wrong.
  IF p_project <> NEW.project_id THEN
    RAISE EXCEPTION 'a work item must live in the same project as its parent (parent is in project %)', p_project;
  END IF;
  -- IMPOSSIBILITY: nesting upward. project → activity → task → subtask only.
  IF work_item_rank(NEW.kind) < work_item_rank(p_kind) THEN
    RAISE EXCEPTION 'a work item of kind "%" cannot be nested under kind "%" (allowed: project > activity > task > subtask)', NEW.kind, p_kind;
  END IF;
  -- IMPOSSIBILITY: a cycle. The parent's path holds every ancestor of the parent, so if this node
  -- is in there, moving under that parent would make the node its own descendant.
  IF position(NEW.id::text in p_path) > 0 THEN
    RAISE EXCEPTION 'that move would make "%" a descendant of itself (cycle refused)', NEW.title;
  END IF;

  NEW.path  := p_path || NEW.parent_id::text || '/';
  NEW.depth := p_depth + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_item_guard_trg ON work_item;
CREATE TRIGGER work_item_guard_trg BEFORE INSERT OR UPDATE ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_guard();

-- When an item MOVES, every descendant's path/depth must follow it. Touching the direct children
-- (a no-op parent_id write) re-fires the guard on each of them, which recomputes their path from
-- this row's new one — and their own AFTER trigger carries it down the next level. It terminates
-- because it only recurses while a path actually CHANGED.
CREATE OR REPLACE FUNCTION work_item_reparent_descendants() RETURNS trigger AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path OR NEW.depth IS DISTINCT FROM OLD.depth THEN
    UPDATE work_item SET parent_id = NEW.id WHERE parent_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_item_reparent_trg ON work_item;
CREATE TRIGGER work_item_reparent_trg AFTER UPDATE ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_reparent_descendants();

-- work_item_dep: refuse a self-dependency and a dependency across projects. Both would render the
-- gantt unsolvable rather than merely wrong.
CREATE OR REPLACE FUNCTION work_item_dep_guard() RETURNS trigger AS $$
DECLARE a uuid; b uuid;
BEGIN
  IF NEW.work_item_id = NEW.depends_on_id THEN
    RAISE EXCEPTION 'a work item cannot depend on itself';
  END IF;
  SELECT project_id INTO a FROM work_item WHERE id = NEW.work_item_id;
  SELECT project_id INTO b FROM work_item WHERE id = NEW.depends_on_id;
  IF a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'both ends of a dependency must exist'; END IF;
  IF a <> b THEN RAISE EXCEPTION 'a dependency may not cross projects'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_item_dep_guard_trg ON work_item_dep;
CREATE TRIGGER work_item_dep_guard_trg BEFORE INSERT OR UPDATE ON work_item_dep
  FOR EACH ROW EXECUTE FUNCTION work_item_dep_guard();

-- ticket.number: a per-project sequence a human can say out loud ("#14"), not a uuid. Assigned
-- under a transaction advisory lock keyed on the project, so two concurrent inserts cannot both
-- read the same max and collide on the UNIQUE (project_id, number).
CREATE OR REPLACE FUNCTION ticket_number_assign() RETURNS trigger AS $$
BEGIN
  IF NEW.number IS NULL OR NEW.number <= 0 THEN
    PERFORM pg_advisory_xact_lock(hashtext('ticket_number:' || NEW.project_id::text));
    SELECT coalesce(max(number), 0) + 1 INTO NEW.number FROM ticket WHERE project_id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The column stays NOT NULL: postgres evaluates column constraints AFTER the BEFORE-row triggers,
-- so an INSERT that omits `number` is filled here and still lands on a NOT NULL column.
DROP TRIGGER IF EXISTS ticket_number_trg ON ticket;
CREATE TRIGGER ticket_number_trg BEFORE INSERT ON ticket
  FOR EACH ROW EXECUTE FUNCTION ticket_number_assign();

-- ── every project gets a root, forever ───────────────────────────────────────
CREATE OR REPLACE FUNCTION project_root_work_item() RETURNS trigger AS $$
BEGIN
  INSERT INTO work_item (project_id, kind, title, created_by)
    VALUES (NEW.id, 'project', NEW.name, 'queenzee')
    ON CONFLICT (project_id) WHERE kind = 'project' DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_root_work_item_trg ON project;
CREATE TRIGGER project_root_work_item_trg AFTER INSERT ON project
  FOR EACH ROW EXECUTE FUNCTION project_root_work_item();

-- backfill: one root per project that already exists
INSERT INTO work_item (project_id, kind, title, created_by)
  SELECT p.id, 'project', p.name, 'migration:058' FROM project p
  ON CONFLICT (project_id) WHERE kind = 'project' DO NOTHING;

-- ── documentation that travels with the schema ───────────────────────────────
COMMENT ON TABLE  ticket           IS 'What came IN: a bug/feature/chore/question/incident, numbered per project, broken down into work_item rows.';
COMMENT ON TABLE  work_item        IS 'The HIERARCHY of work: project → activity → task (→ subtask). What a manager assigns a zee to (xell_id) and what the board/gantt render.';
COMMENT ON COLUMN work_item.path   IS 'Materialized ancestor ids, each followed by "/": root = "", child of root = "<root>/". Subtree = path LIKE path||id||''/%''.';
COMMENT ON COLUMN work_item.xell_id IS 'The worker zee currently on this item (part 2). NULL when nobody, or when a human holds it (assignee).';
COMMENT ON COLUMN work_item.sort_order IS 'Rank among siblings and within a board column. Doubles so a drag can insert between two neighbours without renumbering.';
COMMENT ON TABLE  work_item_dep    IS 'finish→start dependency edges for the gantt. Same project, never self.';
COMMENT ON TABLE  work_item_event  IS 'Audit trail for a work item: created | status | moved | assigned | edited | comment.';
COMMENT ON COLUMN task.work_item_id IS 'The work item this dispatched task was cut for (part 2 stamps it).';
