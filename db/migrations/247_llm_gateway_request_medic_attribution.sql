-- THE GATEWAY LEDGER LEARNS THE MEDIC PLANE (docs/medic-meta-plane-plan.md §3.1, DR-7; kit stage 4;
-- requires 244).
--
-- Every model call in this fleet is recorded in llm_gateway_request — that is the property that
-- makes an in-process agent loop as accountable as a caged one, and a medic must not be the
-- exception that proves the rule. Its calls carry NO xell (there is no xell), so without this
-- column a medic's spend would land as an unattributed row: project-only, impossible to bill to the
-- organ that made it. xell_id is an FK to xell and stays NULL for a medic; medic_id is the plane's
-- own key, and exactly one of the two is set in practice (a CHECK is deliberately NOT added: this
-- is a best-effort LEDGER whose writer is catch-guarded — a constraint here could refuse a receipt,
-- and a lost receipt is worse than a loose one).
--
-- The zee_id/turn_id columns need no change: a medic's zee row (245) and its zee_turn rows are
-- ordinary rows, so the existing joins light up for free.
--
-- Idempotent, additive, forward-only.
ALTER TABLE llm_gateway_request
  ADD COLUMN IF NOT EXISTS medic_id uuid REFERENCES medic(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS llm_gateway_request_medic_idx
  ON llm_gateway_request (medic_id, requested_at DESC) WHERE medic_id IS NOT NULL;

COMMENT ON COLUMN llm_gateway_request.medic_id IS
  'The META-PLANE medic whose loop made this call (docs/medic-meta-plane-plan.md, DR-7). NULL for '
  'every ordinary xell call; set — with xell_id NULL — for a medic''s, so medic spend is attributable '
  'in the same ledger as everyone else''s.';
