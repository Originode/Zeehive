-- THE MEDIC LEAVES THE XELL — the meta-plane core (docs/medic-meta-plane-plan.md, DR-7/DR-8,
-- stage-4 of the provision-proof kit; the second medic-rework, directed 2026-09-02).
--
-- A medic is NOT deployed in a xell. It is an agent loop the QUEENZEE runs in its own process
-- (the langchain-driver precedent, lib/langchain-zee.js), anchored by the `medic` row this
-- migration creates: no worktree, no branch, no cage, no containers, no land gate. Its writes to
-- the meta-DB go through a dedicated GRANT-scoped postgres role (lib/medic-role.js — NOT granted
-- here: roles are cluster state, minted idempotently at boot, simulated under MEDICRW_MODE), and
-- every write is receipted in `medic_action` — written by the DRIVER on the OWNER pool, so the
-- medic role itself holds no grant on its own audit trail and cannot forge or trim it.
--
-- Idempotent, additive, forward-only. Nothing reads these tables until the driver lands.

-- ── the medic row: placement + status, the anchor everything else hangs off ──────────────────
CREATE TABLE IF NOT EXISTS medic (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  condition_id       uuid REFERENCES project_condition(id) ON DELETE SET NULL,
  brief              text NOT NULL,
  status             text NOT NULL DEFAULT 'diagnosing'
                       CHECK (status IN ('diagnosing','acting','awaiting-human',
                                         'worker-dispatched','converged','retired','errored')),
  needs_human_reason text,
  token_hash         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz
);
COMMENT ON TABLE medic IS
  'A meta-plane medic (DR-7): an in-process agent loop the queenzee runs — never a zee in a xell. '
  'One row per dispatch; the row outlives retirement (the audit must outlive the medic).';
COMMENT ON COLUMN medic.target_project_id IS 'the project whose meta-DB config this medic fixes';
COMMENT ON COLUMN medic.condition_id IS 'the PROVISION-INFRA/blocker condition it was dispatched on (SET NULL if the line is deleted — deleting a fixed condition is the medic''s own job)';
COMMENT ON COLUMN medic.brief IS 'the condition verbatim + the dispatch preamble (what the medic was told)';
COMMENT ON COLUMN medic.needs_human_reason IS 'the one-line ask shown on the needs-you bar while status=''awaiting-human''';
COMMENT ON COLUMN medic.token_hash IS 'sha256 of the medic''s gateway identity token (lib/medic-token.js) — plaintext never stored, same discipline as xell.self_token_hash';

CREATE UNIQUE INDEX IF NOT EXISTS medic_token_hash_uq ON medic (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS medic_live_idx ON medic (status, created_at DESC);
-- one LIVE medic per condition — re-clicking ⛑ on the same card attends the one already there
CREATE UNIQUE INDEX IF NOT EXISTS medic_one_live_per_condition_uq ON medic (condition_id)
  WHERE condition_id IS NOT NULL AND status NOT IN ('retired','converged','errored');

-- ── the audit ledger: every write the medic performs, verbatim ───────────────────────────────
CREATE TABLE IF NOT EXISTS medic_action (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medic_id      uuid NOT NULL REFERENCES medic(id) ON DELETE CASCADE,
  tool          text NOT NULL,
  statement     text NOT NULL,
  tables        text[] NOT NULL DEFAULT '{}',
  rows_affected int,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE medic_action IS
  'The medic''s receipts (DR-8): one row per WRITE-class tool call, written by the driver on the '
  'OWNER pool before the statement commits — the medic role has no grant here.';
COMMENT ON COLUMN medic_action.tool IS 'which registry tool ran (meta_write, dispatch_worker, condition_remove, …)';
COMMENT ON COLUMN medic_action.statement IS 'the exact SQL / verb args, verbatim — the Bay renders this';
CREATE INDEX IF NOT EXISTS medic_action_medic_idx ON medic_action (medic_id, created_at DESC);

-- ── the cutover knob: which plane the ⛑ dispatch seam creates a medic on ─────────────────────
-- 'meta' (default) = a medic row + in-process turn (this model); 'manager-zee' = the superseded
-- stage-3 path (createManagerZee on Zeehive), kept one flip away as the way back (plan §6).
ALTER TABLE pool_config
  ADD COLUMN IF NOT EXISTS medic_plane text NOT NULL DEFAULT 'meta';
DO $$ BEGIN
  ALTER TABLE pool_config
    ADD CONSTRAINT pool_config_medic_plane_check CHECK (medic_plane IN ('meta','manager-zee'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN pool_config.medic_plane IS
  'per-project medic placement: ''meta'' (DR-7, in-process) | ''manager-zee'' (superseded stage-3 path — the rollback)';

-- ── gateway attribution: a medic''s model calls are recorded like everyone else''s ────────────
ALTER TABLE llm_gateway_request
  ADD COLUMN IF NOT EXISTS medic_id uuid REFERENCES medic(id) ON DELETE SET NULL;
COMMENT ON COLUMN llm_gateway_request.medic_id IS
  'set when the gateway token resolved to a MEDIC (meta-plane agent, no xell) — xell_id is NULL on those rows';
CREATE INDEX IF NOT EXISTS llm_gateway_request_medic_idx ON llm_gateway_request (medic_id) WHERE medic_id IS NOT NULL;
