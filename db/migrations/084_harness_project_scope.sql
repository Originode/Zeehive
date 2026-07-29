-- HARNESS SCOPE — a harness is SYSTEM-WIDE by default, and may be scoped to ONE project.
--
-- 044 gave `harness` no project_id at all, and said so out loud: "it is visible to EVERY project".
-- That is still the DEFAULT and it is still what every existing row is — core, zee-base, manager, the
-- dev-* crew are the fleet's shared vocabulary and nobody's property. What it could not express is a
-- persona that belongs to ONE project: a manager zee that wants a specialised worker for its own
-- backlog had to ask a human to add a harness every project's picker would then offer.
--
-- So: `project_id` nullable. NULL = system-wide (the default, and what every row already is);
-- non-null = visible to that project only, and cascaded with it — a project's personas die with the
-- project, exactly like its xells and its pool config.
--
-- The compatibility rule that follows is enforced HERE, in triggers, in the shape 054 uses for
-- zee_type: a xell may only wear a harness that is global or its OWN project's, and it must hold
-- from BOTH directions (assigning the harness, and re-scoping a harness a xell already wears).
-- One rule in one place, so the assign path, dispatch, the manager API, the console and any future
-- caller reach the same wall — and so an existing pairing cannot be broken by editing the harness
-- afterwards, which is the half a route check always misses.
ALTER TABLE harness ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES project ON DELETE CASCADE;

COMMENT ON COLUMN harness.project_id IS
  'NULL (default) = a SYSTEM-WIDE harness, visible to every project. Non-null = visible to that project only, and deleted with it. A xell may only wear a harness that is global or its own project''s — enforced by xell_harness_scope_guard/harness_scope_guard.';

COMMENT ON TABLE harness IS
  'A persona a zee wears (personality/skills/memory, owned by the meta-DB). Global by default; project_id scopes one to a single project.';

-- ── the compatibility rule, from both directions (054's shape) ───────────────
-- Direction 1: a xell may not be assigned a harness from ANOTHER project (nor be moved to another
-- project out from under a harness it already wears — project_id is immutable in practice, but the
-- trigger does not have to trust that).
CREATE OR REPLACE FUNCTION xell_harness_scope_guard() RETURNS trigger AS $$
DECLARE h_proj uuid; h_key text; h_proj_name text;
BEGIN
  IF NEW.harness_id IS NULL THEN RETURN NEW; END IF;
  SELECT project_id, key INTO h_proj, h_key FROM harness WHERE id = NEW.harness_id;
  IF h_proj IS NULL THEN RETURN NEW; END IF;                       -- global (or the harness vanished)
  IF h_proj <> NEW.project_id THEN
    SELECT name INTO h_proj_name FROM project WHERE id = h_proj;
    RAISE EXCEPTION 'harness "%" belongs to project "%" and this xell does not — a project-scoped '
                    'persona is visible to its own project only. Use a system-wide harness, or one of '
                    'this project''s.', h_key, COALESCE(h_proj_name, h_proj::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS xell_harness_scope_guard_trg ON xell;
CREATE TRIGGER xell_harness_scope_guard_trg
  BEFORE INSERT OR UPDATE OF harness_id, project_id ON xell
  FOR EACH ROW EXECUTE FUNCTION xell_harness_scope_guard();

-- Direction 2: a harness's SCOPE may not be narrowed out from under the xells wearing it, the law
-- layer stays global, and a harness may only INHERIT one that is global or in its own project.
--
-- That last one is the quiet version of the same bug, and the reason it is here rather than in the
-- manager API: inheritance MERGES the parent's personality, skills and memory into the child's
-- briefing, so a global harness parented on one project's persona would hand that project's text to
-- every other project's zees — the very thing project_id exists to prevent — and a route check would
-- only cover the one caller that went through it.
CREATE OR REPLACE FUNCTION harness_scope_guard() RETURNS trigger AS $$
DECLARE bad text; p_proj uuid; p_key text;
BEGIN
  IF NEW.is_law_core AND NEW.project_id IS NOT NULL THEN
    RAISE EXCEPTION 'the core (law) harness is the law layer for every zee in the fleet — it cannot be scoped to one project';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id AND NEW.project_id IS NOT NULL THEN
    SELECT string_agg(slug, ', ') INTO bad FROM xell
      WHERE harness_id = NEW.id AND project_id <> NEW.project_id;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'cannot scope harness "%" to one project: it is worn by % xell(s) of another project (%)',
                      NEW.key, (SELECT count(*) FROM xell WHERE harness_id = NEW.id AND project_id <> NEW.project_id), bad;
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT project_id, key INTO p_proj, p_key FROM harness WHERE id = NEW.parent_id;
    IF p_proj IS NOT NULL AND p_proj IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'harness "%" cannot inherit "%": a harness may only inherit a SYSTEM-WIDE harness '
                      'or one in its own project. Inheriting across projects would merge that project''s '
                      'persona, skills and memory into this briefing.', NEW.key, p_key;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS harness_scope_guard_trg ON harness;
CREATE TRIGGER harness_scope_guard_trg
  BEFORE INSERT OR UPDATE ON harness
  FOR EACH ROW EXECUTE FUNCTION harness_scope_guard();

-- ── and the per-project DEFAULT harness a bare dispatch attaches ─────────────
-- pool_config.default_harness_id (044) is the persona intake attaches when --harness is omitted, so
-- pointing it at another project's harness would hand that project's persona to every xell this one
-- dispatches — through the one path that never names a harness at all.
CREATE OR REPLACE FUNCTION pool_default_harness_scope_guard() RETURNS trigger AS $$
DECLARE h_proj uuid; h_key text;
BEGIN
  IF NEW.default_harness_id IS NULL THEN RETURN NEW; END IF;
  SELECT project_id, key INTO h_proj, h_key FROM harness WHERE id = NEW.default_harness_id;
  IF h_proj IS NOT NULL AND h_proj <> NEW.project_id THEN
    RAISE EXCEPTION 'harness "%" belongs to another project — it cannot be this project''s default '
                    'harness. A default must be system-wide, or this project''s own.', h_key;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pool_default_harness_scope_guard_trg ON pool_config;
CREATE TRIGGER pool_default_harness_scope_guard_trg
  BEFORE INSERT OR UPDATE OF default_harness_id, project_id ON pool_config
  FOR EACH ROW EXECUTE FUNCTION pool_default_harness_scope_guard();

-- Every harness that exists today is global, and stays that way: nothing is UPDATEd here. A project
-- gets its first scoped persona when a manager (or a human) creates one.
