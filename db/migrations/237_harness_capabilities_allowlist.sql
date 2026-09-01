-- HARNESS CAPABILITIES — a COLUMN, never a bundle field (provision-proof plan §7.2, stage 3).
--
-- The infra-medic harness (§7) needs a READ-ONLY binding to the orchestrator's own meta-DB, and the
-- fact that a harness is ALLOWED that binding is a capability grant. It lives in a COLUMN for the
-- same reason a harness cannot carry rules in its bundle (044: the authoring surface accepts
-- personality/skills/memory and nothing else — that non-override is load-bearing): a persona cannot
-- express a grant, and must stay unable to. A capability is set by migration/console only.
--
-- The trigger is the allowlist. ONE legal value is defined today: 'infra-troubleshoot' (the medic).
-- A new capability is a reviewed decision, not a string somebody typed into a bundle — the trigger
-- refuses anything not on the list, so a typo can never mint a grant nobody reviewed, and the list
-- is the single place a reviewer sees every capability that exists.
--
-- The check reads the COLUMN only. Nothing in the bundle path reads capabilities; effectiveHarness()
-- and the route gate walk this column (the harness's own row and every ancestor in its chain).

ALTER TABLE harness ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN harness.capabilities IS
  'Capability grants (jsonb array of allowlisted names). NOT a bundle field: a persona cannot express a grant, only this column can. Allowlist enforced by trigger — today only ''infra-troubleshoot'' (the infra-medic read-only meta-DB bind).';

CREATE OR REPLACE FUNCTION harness_capabilities_allowlist() RETURNS trigger AS $$
DECLARE
  cap text;
BEGIN
  IF NEW.capabilities IS NULL THEN NEW.capabilities := '[]'::jsonb; END IF;
  IF jsonb_typeof(NEW.capabilities) <> 'array' THEN
    RAISE EXCEPTION 'harness.capabilities must be a jsonb array of capability names, got %', jsonb_typeof(NEW.capabilities);
  END IF;
  FOR cap IN SELECT jsonb_array_elements_text(NEW.capabilities) LOOP
    IF cap IS DISTINCT FROM 'infra-troubleshoot' THEN
      RAISE EXCEPTION 'harness.capabilities: unknown capability "%" — the allowlist is {infra-troubleshoot}. A capability grant is a column set by migration/console only; a harness edit cannot self-grant.',
        cap;
    END IF;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS harness_capabilities_allowlist_trg ON harness;
CREATE TRIGGER harness_capabilities_allowlist_trg
  BEFORE INSERT OR UPDATE OF capabilities ON harness
  FOR EACH ROW EXECUTE FUNCTION harness_capabilities_allowlist();
