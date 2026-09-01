-- INFRA REQUESTS — the HUMAN-GATED cards the infra-medic raises (provision-proof plan §7.1, stage 3).
--
-- Two of the medic's verbs must perform NOTHING until a human approves: `bootstrap --perform`
-- (create this project's manifest-declared DEV infrastructure — networks, shared dev db) and
-- `propose` (apply a settings change — pool knobs, registry, machine priority, manifest-cache
-- refresh). This table is the card. The shape is the fleet's standard ask-table (029 / 049 / 111):
--
--   * xell_id is the MEDIC that asked (SET NULL if it is reaped — the ask is still a fact);
--   * kind is which verb filed it: 'bootstrap' or 'propose';
--   * payload carries what the card asks for (bootstrap: {machine_id}; propose: the settings patch
--     and the reason it exists);
--   * status pending → approved (the QUEENZEE performs) → completed, or rejected; `result` is the
--     receipt of what actually happened, so the card reads as a verdict;
--   * decided_at/by name the human; dismissed_at/by is the console's "seen it" marker, never a
--     decision (exactly xource_clean_request's semantics).
--
-- Only the MEDIC (a harness wearing the 'infra-troubleshoot' capability) can file a row, and only a
-- HUMAN approves one — a zee never decides. The queenzee performs on approval with the same guards
-- as the console 🔧 (performBuildBootstrap verbatim for 'bootstrap'; the settings whitelist for
-- 'propose'), and every outcome is recorded here and in build_bootstrap_action.
CREATE TABLE IF NOT EXISTS infra_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  xell_id      uuid REFERENCES xell(id) ON DELETE SET NULL,
  zee_id       uuid REFERENCES zee(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('bootstrap','propose')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason       text,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','completed','failed')),
  result       jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,
  finished_at  timestamptz,
  dismissed_at timestamptz,
  dismissed_by text
);

-- At most one OPEN card per (project, kind) — a medic cannot stack two bootstraps or two proposes;
-- re-asking while one is open hands the same card back. Mirrors land_request_open_uq's
-- (pending, approved) window: approval performs synchronously, but the row is not 'completed' until
-- the queenzee finishes, so the window must be covered too.
CREATE UNIQUE INDEX IF NOT EXISTS infra_request_open_uq
  ON infra_request (project_id, kind) WHERE status IN ('pending','approved');

CREATE INDEX IF NOT EXISTS infra_request_project_idx
  ON infra_request (project_id, status, requested_at DESC);
