-- HARNESS RE-SCOPE, THE OTHER HALF OF DIRECTION 2 — the children of the harness being scoped.
--
-- 084 says its compatibility rule holds "from BOTH directions", and for the xells wearing a harness
-- it does. For INHERITANCE it held from one direction only: `harness_scope_guard` refuses a harness
-- whose NEW.parent_id sits in another project, so the CHILD being written is checked — and nothing
-- re-checks the children when the PARENT moves. So this was accepted:
--
--   G is system-wide, C (project B) inherits G;  UPDATE harness SET project_id = <A> WHERE key = 'G';
--
-- and afterwards C — untouched, and still project B's — inherits a harness belonging to project A,
-- which is exactly the merge 084 exists to prevent: effectiveHarness() concatenates the chain, so
-- every xell of project B wearing C is briefed with project A's personality, skills and memory. A
-- global child is the same bug with a wider blast radius (one project's text in every briefing).
--
-- It takes raw SQL or a migration to reach today — no route re-scopes a harness — which is precisely
-- who a defensive trigger is written for: the rule is asserted where it cannot be forgotten, not in
-- whichever caller happens to exist this month.
--
-- Nothing here changes a row: it replaces one function and re-creates its trigger. Every existing
-- pairing already satisfies the rule (each scoped harness inherits a global one or its own project's).
CREATE OR REPLACE FUNCTION harness_scope_guard() RETURNS trigger AS $$
DECLARE bad text; n int; p_proj uuid; p_key text;
BEGIN
  IF NEW.is_law_core AND NEW.project_id IS NOT NULL THEN
    RAISE EXCEPTION 'the core (law) harness is the law layer for every zee in the fleet — it cannot be scoped to one project';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id AND NEW.project_id IS NOT NULL THEN
    -- the xells WEARING it (084, unchanged)
    SELECT string_agg(slug, ', '), count(*) INTO bad, n FROM xell
      WHERE harness_id = NEW.id AND project_id <> NEW.project_id;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'cannot scope harness "%" to one project: it is worn by % xell(s) of another project (%)',
                      NEW.key, n, bad;
    END IF;
    -- and the harnesses INHERITING it: after this write they would be inheriting across scopes, which
    -- the same trigger refuses when the child itself is written. Same rule, other direction.
    SELECT string_agg(key, ', '), count(*) INTO bad, n FROM harness
      WHERE parent_id = NEW.id AND project_id IS DISTINCT FROM NEW.project_id;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'cannot scope harness "%" to one project: % harness(es) inherit it from another scope (%) '
                      '— a harness may only inherit a SYSTEM-WIDE harness or one in its own project, so this '
                      'would merge this project''s persona, skills and memory into their wearers'' briefings. '
                      'Re-scope or re-parent them first.', NEW.key, n, bad;
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
