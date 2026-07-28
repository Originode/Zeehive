-- ZEE TYPE vs HARNESS — two axes that were quietly one.
--
-- 052 gave a xell a `role` (worker|manager) and left harness assignment free, so the two could
-- contradict each other: a WORKER could be handed the manager harness (whose manual teaches
-- `zee dispatch`, `zee suggest-done` and "you hold production read-only" — none of which it has), and
-- a MANAGER could be switched onto a worker harness and lose its own manual entirely. Both produce
-- the same failure: an agent briefed for doors it does not have, which is exactly how a zee spends a
-- turn hammering on a refusal.
--
-- So the model is two axes with a declared relationship:
--
--   TYPE     is the xell's — what the queenzee will and will not let this zee do (052's refusals).
--   HARNESS  is the persona/skills/manual — and each harness DECLARES which type it is for.
--
-- A harness may only be worn by a xell of its type. That is enforced here, in triggers, rather than
-- in the assign path alone: the console, dispatch, the CLI and any future caller all reach the same
-- wall, and an existing pairing cannot be broken by editing the harness afterwards either.
--
-- Renaming `role` → `zee_type` at the same time, while the column is one day old and only this
-- feature reads it: "role" already means something else in this schema (container.role is db/server/
-- webapp), and the operator vocabulary for this axis is TYPE.
ALTER TABLE xell RENAME COLUMN role TO zee_type;
ALTER TABLE xell RENAME CONSTRAINT xell_role_chk TO xell_zee_type_chk;
COMMENT ON COLUMN xell.zee_type IS
  'worker (default) or manager. A manager zee dispatches/monitors workers and holds the prod db READ-ONLY; it has zero push/PR access to the xource. It may only wear a harness declared for its type.';

-- ── a harness declares the TYPE it is for ────────────────────────────────────
-- 'any' exists for the law layer (core), which applies to every zee whatever its type. Everything
-- else is worker (the default — every harness that existed before this migration is a worker one)
-- or manager.
ALTER TABLE harness ADD COLUMN IF NOT EXISTS zee_type text NOT NULL DEFAULT 'worker';
DO $$ BEGIN
  ALTER TABLE harness ADD CONSTRAINT harness_zee_type_chk CHECK (zee_type IN ('worker','manager','any'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN harness.zee_type IS
  'Which zee TYPE may wear this harness: worker (default), manager, or any (the law layer). A xell may only be assigned a harness whose type matches its own — enforced by xell_harness_type_guard.';

UPDATE harness SET zee_type = 'any'     WHERE is_law_core;
UPDATE harness SET zee_type = 'manager' WHERE key = 'manager';

-- ── the compatibility rule, from both directions ─────────────────────────────
-- Direction 1: a xell may not be assigned an incompatible harness (nor have its type changed out
-- from under a harness it already wears).
CREATE OR REPLACE FUNCTION xell_harness_type_guard() RETURNS trigger AS $$
DECLARE h_type text; h_key text;
BEGIN
  IF NEW.harness_id IS NULL THEN RETURN NEW; END IF;
  SELECT zee_type, key INTO h_type, h_key FROM harness WHERE id = NEW.harness_id;
  IF h_type IS NULL THEN RETURN NEW; END IF;                       -- harness vanished; ON DELETE SET NULL handles it
  IF h_type <> 'any' AND h_type <> COALESCE(NEW.zee_type, 'worker') THEN
    RAISE EXCEPTION 'harness "%" is for % zees; this xell is a % zee. A harness carries the manual for '
                    'a type''s verbs and refusals — wearing the wrong one briefs an agent for doors it '
                    'does not have.', h_key, h_type, COALESCE(NEW.zee_type, 'worker');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS xell_harness_type_guard_trg ON xell;
CREATE TRIGGER xell_harness_type_guard_trg
  BEFORE INSERT OR UPDATE OF harness_id, zee_type ON xell
  FOR EACH ROW EXECUTE FUNCTION xell_harness_type_guard();

-- Direction 2: a harness's type may not be changed while a xell of the other type wears it, and a
-- harness may only INHERIT from one of its own type (or from 'any'). Cross-type inheritance is the
-- subtle version of the same bug: a manager harness parented on Zee Base would silently merge the
-- WORKER manual into a manager's briefing, teaching it `zee land` — the one verb it is refused.
CREATE OR REPLACE FUNCTION harness_type_guard() RETURNS trigger AS $$
DECLARE bad text; p_type text; p_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.zee_type IS DISTINCT FROM OLD.zee_type THEN
    SELECT string_agg(slug, ', ') INTO bad FROM xell
      WHERE harness_id = NEW.id AND NEW.zee_type <> 'any' AND COALESCE(zee_type,'worker') <> NEW.zee_type;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'cannot retype harness "%" to %: it is worn by % zee(s) of another type (%)',
                      NEW.key, NEW.zee_type, NEW.zee_type, bad;
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT zee_type, key INTO p_type, p_key FROM harness WHERE id = NEW.parent_id;
    IF p_type IS NOT NULL AND p_type <> 'any' AND p_type <> NEW.zee_type THEN
      RAISE EXCEPTION 'harness "%" (%) cannot inherit "%" (%): a harness may only inherit within its own '
                      'type, or from the law layer. Cross-type inheritance would merge the other type''s '
                      'manual into this one''s briefing.', NEW.key, NEW.zee_type, p_key, p_type;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS harness_type_guard_trg ON harness;
CREATE TRIGGER harness_type_guard_trg
  BEFORE INSERT OR UPDATE ON harness
  FOR EACH ROW EXECUTE FUNCTION harness_type_guard();

-- The 052 guard reads the renamed column; recreate it against zee_type.
CREATE OR REPLACE FUNCTION xell_manager_guard() RETURNS trigger AS $$
DECLARE mgr_type text; mgr_prod boolean;
BEGIN
  IF NEW.is_production AND NEW.zee_type <> 'worker' THEN
    RAISE EXCEPTION 'production is not a manager xell';
  END IF;
  IF NEW.manager_xell_id IS NOT NULL THEN
    IF NEW.manager_xell_id = NEW.id THEN RAISE EXCEPTION 'a xell cannot manage itself'; END IF;
    IF NEW.zee_type = 'manager' THEN
      RAISE EXCEPTION 'a manager xell cannot report to another manager (the hierarchy is one level deep)';
    END IF;
    IF NEW.is_production THEN RAISE EXCEPTION 'production cannot be managed by a zee'; END IF;
    SELECT zee_type, is_production INTO mgr_type, mgr_prod FROM xell WHERE id = NEW.manager_xell_id;
    IF mgr_type IS NULL THEN RAISE EXCEPTION 'manager_xell_id names no xell'; END IF;
    IF mgr_type <> 'manager' OR mgr_prod THEN
      RAISE EXCEPTION 'manager_xell_id must name a xell whose type is manager';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The per-project default harness a bare dispatch attaches is a WORKER default by construction (a
-- manager is added explicitly, and gets a manager harness). Nothing to migrate — noted so the next
-- reader does not go looking for a per-type default that does not exist.
