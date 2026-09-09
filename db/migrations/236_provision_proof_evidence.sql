-- PROVISION PROOF — EVIDENCE + SURFACING (stage 1, no gating) — docs/provision-proof-plan.md §4.2.
--
-- THE DEFECT THIS BEGINS TO CLOSE: a pooled xell is stamped 'ready' the moment its row is inserted,
-- and nothing ever proves the chips it claims. The db preflight (#53) opens the projected DSN but
-- gates nothing; no app tier is ever built before a zee's first `zee build` (the two live incident
-- classes — TKT-178 docker address-pool exhaustion, TKT-85 clone-db port collisions — pass every
-- static check and surface only on a real build/up, on the ZEE's clock, after dispatch); and the
-- binding can change after the only preflight ran (dispatch-time attach/clone re-point the DSN and
-- the new one is never opened before the zee spawns — #47/TKT-181).
--
-- STAGE 1 IS EVIDENCE + SURFACING ONLY: nothing here may refuse a claim, a dispatch or a spawn.
-- The gate (`required` refusing unproven stock) is stage 2, a different landing. This migration is
-- the additive schema half of the proof machinery (lib/xell-proof.js is the code half):
--
--   xell.proof_at      — when the burn-in last ran (NULL = never proven / legacy — gates nothing);
--   xell.proof_error   — the failing check, NAMED, NULL when the last run proved green. Mirrors
--                        preflight_error's contract: NULL means "no known fault", and a proven-green
--                        xell is told apart from a never-proven one by proof_at;
--   xell.proof_checks  — every proof check verbatim: [{check, ok, skipped, detail, class}];
--   xell.proof_commit  — the source tip the build proved (advisory — commit-independent facts like
--                        "networks allocatable / ports bindable / db answers" do not move with main);
--   pool_config.readiness_proof — the per-project knob ('off' | 'advisory' | 'required'),
--                        defaulting 'advisory'. Stage 1 only surfaces it; stage 2 reads it in the
--                        claim CAS. Deliberately NOT a new xell.status value (DR-2): status='ready'
--                        is the load-bearing token of the claim/sweep CAS (TKT-88-D6B4), and a new
--                        enum value would touch every conditional UPDATE, fill count, sweep and
--                        console pivot to fix one predicate.
--
--   build_readiness_record — the machine×project verdict, REMEMBERED (DR-2): one recorded fact
--                        serves all N pooled xells on a machine (they do not each re-discover an
--                        address-pool exhaustion), the pool fill consults it, and the console
--                        machine matrix reads it without a fresh probe click. Latest verdict per
--                        (machine, project); history stays in the event log.
--
-- This is the "evidence, then wire the verdict to a gate, then the medic harness" kit's phase 1+2.
-- NULL semantics are part of the contract, exactly as preflight's are: proof_at IS NULL = legacy /
-- not yet burned in (gates nothing, orders last); proof_at NOT NULL AND proof_error IS NULL =
-- proven.

-- ── 1. THE XELL'S STAMPED SUMMARY ─────────────────────────────────────────────
ALTER TABLE xell ADD COLUMN IF NOT EXISTS proof_at     timestamptz;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS proof_error  text;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS proof_checks jsonb;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS proof_commit text;

COMMENT ON COLUMN xell.proof_at IS
  'When the provision burn-in last ran against this xell (lib/xell-proof.proveXell). NULL = never proven (legacy/backfill state) — gates nothing.';
COMMENT ON COLUMN xell.proof_error IS
  'The failing proof check, named ("app-build:server: <docker line>"), NULL when the last burn-in proved green. A proven-green xell and a never-proven one are told apart by proof_at, not by this NULL.';
COMMENT ON COLUMN xell.proof_checks IS
  'Every proof check from the last run, verbatim: [{check, ok, skipped, detail, class}]. Skipped checks are kept — "runner: process has no container build" is an answer, not an absence. class is INFRA | CODE (migration 233) on a failed build check.';
COMMENT ON COLUMN xell.proof_commit IS
  'The source tip the build proved (advisory — the commit-dependent code half). The expensive facts the proof established — networks allocatable, ports bindable, images buildable, db answering — are commit-independent and do NOT move when main fast-forwards.';

-- ── 2. THE PER-PROJECT KNOB ───────────────────────────────────────────────────
-- Three values, defaulting advisory (the running-fleet-safe rollout of DR-3): 'off' is today's
-- behaviour byte for byte; 'advisory' claims proceed while proven stock sorts first and failures are
-- SURFACED; 'required' is stage 2's gate (a claim refuses unproven/proof-failed stock). The CHECK
-- keeps a typo from inventing a fourth value.
ALTER TABLE pool_config
  ADD COLUMN IF NOT EXISTS readiness_proof text NOT NULL DEFAULT 'advisory',
  ADD CONSTRAINT pool_config_readiness_proof_check
    CHECK (readiness_proof IN ('off', 'advisory', 'required'));

COMMENT ON COLUMN pool_config.readiness_proof IS
  'How this project treats the provision proof (docs/provision-proof-plan.md): off = today''s behaviour (verdicts recorded, nothing reads them); advisory = claims proceed, proven xells sort first and failures are surfaced; required = stage 2 — an unproven or proof-failed xell is not claimable stock. Default advisory: a running fleet converges without a flag day.';

-- ── 3. THE REMEMBERED MACHINE×PROJECT VERDICT ─────────────────────────────────
CREATE TABLE IF NOT EXISTS build_readiness_record (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id  uuid NOT NULL REFERENCES machine ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  status      text NOT NULL,               -- 'ok' | 'unknown' | 'missing' (probe vocabulary, unchanged)
  error       text,
  checks      jsonb NOT NULL DEFAULT '[]'::jsonb,
  probed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (machine_id, project_id)          -- latest verdict per pair; history is the event log
);

COMMENT ON TABLE build_readiness_record IS
  'The machine×project build-readiness verdict, remembered so the pool fill, the proof backfill and the console machine matrix can consult it without a live docker round-trip (DR-2). One recorded fact serves all N pooled xells on a machine. Latest per (machine, project); history stays in the event log.';
COMMENT ON COLUMN build_readiness_record.status IS
  'The probe vocabulary, unchanged: ok | unknown | missing. A machine whose verdict is missing does not need N xells to each re-discover it.';
COMMENT ON COLUMN build_readiness_record.checks IS
  'The probe checks verbatim from the last run.';
