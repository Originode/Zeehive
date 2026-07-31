-- HARNESSES — shared, SYSTEM-WIDE config layers assigned to xells (docs/harness-proposal.md).
--
-- A harness carries a config BUNDLE (personality, skills, memory, tools, bridge) that layers into a
-- zee's briefing. Unlike xource/xell/container it has NO project_id: it is visible to EVERY project.
-- The files live in the Zeehive project under harnesses/<key>/; this row is a parsed, hashed
-- projection of them (same pattern as project.manifest — the repo is truth, drift is surfaced).
--
-- LAW: the `core` harness (is_law_core) is the built-in, undeletable law layer — the cxell-zee
-- manual + the binding rules. Every xell always gets core; an assigned harness (e.g. hermes) layers
-- BELOW it and may ADD, never OVERRIDE, the queenzee-interaction rules. That non-override is enforced
-- structurally in lib/harness.js by a reserved-key validator (a bundle has no field that can express
-- a land/ship/prod/gate rule), the same way the schema — not a rule — is what stops a xell tracking
-- its own xource. A harness never ships or lands; it is only a guide (the zee ships/lands).

CREATE TABLE harness (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text UNIQUE NOT NULL,                 -- 'core', 'hermes', ...
  label         text NOT NULL,
  dir           text,                                 -- 'harnesses/hermes' (relative to the Zeehive repo root)
  head_commit   text,                                 -- commit the graph anchors the harness node to
  bundle        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- parsed/validated config (personality, skills, memory, tools, bridge…)
  bundle_hash   text,                                 -- projection stamp; drift vs the files is surfaced, not silent
  avatar_path   text,                                 -- 'harnesses/hermes/avatar.svg' (the badge art)
  is_law_core   boolean NOT NULL DEFAULT false,       -- the built-in manual harness; exactly one, undeletable
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- exactly one law-core harness (partial unique on the boolean → at most one row where it is true)
CREATE UNIQUE INDEX harness_single_core ON harness ((is_law_core)) WHERE is_law_core;

-- ── the impossibilities ──────────────────────────────────────────────────────
-- The core harness is the law layer, so it is undeletable, cannot be demoted out of law-core, cannot
-- be renamed off 'core', and cannot be disabled — otherwise a xell could end up with no law layer at
-- all, which is the one thing the manual-is-law guarantee forbids.
CREATE FUNCTION harness_guard() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    IF OLD.is_law_core THEN RAISE EXCEPTION 'the core (law) harness is undeletable'; END IF;
    RETURN OLD;
  END IF;
  IF (TG_OP = 'UPDATE') AND OLD.is_law_core THEN
    IF NOT NEW.is_law_core THEN RAISE EXCEPTION 'the core harness must stay is_law_core'; END IF;
    IF NEW.key IS DISTINCT FROM OLD.key THEN RAISE EXCEPTION 'the core harness key is immutable (must be "core")'; END IF;
    IF NOT NEW.enabled THEN RAISE EXCEPTION 'the core harness cannot be disabled'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER harness_guard_trg
  BEFORE UPDATE OR DELETE ON harness
  FOR EACH ROW EXECUTE FUNCTION harness_guard();

-- ── a xell is ASSIGNED one harness (config-uses, NOT code-tracks) ────────────
-- Unlike xource_id (immutable — it decides where work LANDS), harness_id is mutable: a harness
-- decides only CONFIG, touches no landing target, so a human may switch it and it just re-briefs the
-- next turn. NULL = core only. ON DELETE SET NULL so deleting a harness drops its xells back to core.
ALTER TABLE xell ADD COLUMN IF NOT EXISTS harness_id uuid REFERENCES harness ON DELETE SET NULL;

-- per-project default harness a bare dispatch attaches (like default_runtime_id / default_db_coupling)
ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS default_harness_id uuid REFERENCES harness ON DELETE SET NULL;

-- carried through intake exactly like req_runtime_id / req_db_coupling
ALTER TABLE task ADD COLUMN IF NOT EXISTS req_harness_id uuid REFERENCES harness;

COMMENT ON TABLE harness IS
  'System-wide config layer (personality/skills/memory/tools/bridge) assigned to xells; files live in the Zeehive project under harnesses/<key>/. No project_id = visible to every project.';
COMMENT ON COLUMN harness.is_law_core IS
  'The built-in, undeletable law harness (cxell manual + binding rules). Exactly one; an assigned harness layers below it and may never override it.';
COMMENT ON COLUMN xell.harness_id IS
  'The harness assigned to this xell (NULL = core only). Mutable — a human may switch it; it decides config, never a landing target.';

-- ── seed the law-core harness (structural — always needed) ───────────────────
-- Its TEXT (the manual + binding rules) is assembled in code (bindingFor/spawnCxell), so the row is
-- the marker of the law layer, not its storage. Reproduces today's briefing with zero behaviour
-- change: every xell already gets the manual + rules; core just names that layer in the data model.
INSERT INTO harness (key, label, dir, is_law_core, enabled, bundle)
VALUES ('core', 'Core (law)', 'harnesses/core', true, true,
        '{"summary":"The cxell-zee manual + binding rules. Always present, non-overridable — the law layer for how a zee interacts with zeehive/queenzee."}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Hermes: a real harness, files under harnesses/hermes/. bundle/head_commit/avatar_path are filled
-- from the folder by lib/harness.js refreshHarnesses() at boot (the row here is just the anchor).
INSERT INTO harness (key, label, dir, is_law_core, enabled, avatar_path)
VALUES ('hermes', 'Hermes', 'harnesses/hermes', false, true, 'harnesses/hermes/avatar.svg')
ON CONFLICT (key) DO NOTHING;
