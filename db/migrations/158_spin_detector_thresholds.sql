-- SPIN DETECTOR THRESHOLDS — per-turn budgets the queenzee enforces against the gateway ledger.
--
-- A zee waiting on another zee or on a human gate has no suspend primitive, so it spins: the live
-- meta-DB measured one spawn turn at 69 gateway calls / 5,003,163 tokens and another at 29 calls,
-- none of it progress. The detector (queenzee/spin.js + lib/spin-detector.js) reads the SAME ledger
-- the gateway already writes (llm_gateway_request, 154), and this table carries the knobs.
--
-- The SIGNAL is repetition without progress, not duration: a long honest build/verify turn must not
-- trip it. So the thresholds are about the SUSPECT WINDOW — the gateway calls made since the turn's
-- last progress event (a commit is approximated by land/report/working/tend; see lib/spin-detector.js
-- PROGRESS_EVENT_NAMES) — and the calls in that window must all be similar-sized (max_size_spread)
-- AND the window must clear BOTH a call floor and a token floor. A turn that is making progress
-- resets the window; a turn whose calls are genuinely diverse is not a poll loop.
--
-- CONFIG, NOT CONSTANTS: three scopes, most specific wins — 'harness' > 'project' > 'default'.
--   scope='default'  → the fleet-wide fallback (exactly one row, enforced by the partial unique index)
--   scope='project'  → one row per project (project_id)
--   scope='harness'  → one row per harness (harness_id)
-- The knob columns are NULLABLE on purpose: NULL means "inherit from the less specific scope",
-- exactly the model_policy precedent (an omitted field inherits from the parent chain). A harness
-- that tunes ONLY min_calls keeps the project's min_tokens. The 'default' row seeds every knob so a
-- scope with no explicit value always resolves. The code ships the same defaults as the 'default'
-- row, so a database without this table (or a row deliberately deleted to restore defaults)
-- behaves identically. Idempotent, additive, forward-only.
CREATE TABLE IF NOT EXISTS spin_detector_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL CHECK (scope IN ('default','project','harness')),
  project_id      uuid REFERENCES project(id) ON DELETE CASCADE,
  harness_id      uuid REFERENCES harness(id) ON DELETE CASCADE,
  enabled         boolean,             -- NULL = inherit from the less specific scope
  min_calls       int,                 -- NULL = inherit
  min_tokens      bigint,              -- NULL = inherit
  max_size_spread numeric,             -- NULL = inherit
  same_path       boolean,             -- NULL = inherit
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spin_scope_exclusive CHECK (
    (scope = 'default' AND project_id IS NULL AND harness_id IS NULL)
    OR (scope = 'project' AND project_id IS NOT NULL AND harness_id IS NULL)
    OR (scope = 'harness' AND harness_id IS NOT NULL AND project_id IS NULL)
  )
);

-- exactly one default row; at most one project/harness row per project/harness
CREATE UNIQUE INDEX IF NOT EXISTS spin_config_one_default  ON spin_detector_config ((true)) WHERE scope = 'default';
CREATE UNIQUE INDEX IF NOT EXISTS spin_config_project_uq   ON spin_detector_config (project_id) WHERE scope = 'project';
CREATE UNIQUE INDEX IF NOT EXISTS spin_config_harness_uq   ON spin_detector_config (harness_id) WHERE scope = 'harness';

-- The fleet default, so the knob is visible/editable in the console rather than hidden in code.
-- Every knob is set here so a scope with no explicit value always resolves to the sane default.
INSERT INTO spin_detector_config (scope, enabled, min_calls, min_tokens, max_size_spread, same_path)
SELECT 'default', true, 20, 1000000, 1.6, true
WHERE NOT EXISTS (SELECT 1 FROM spin_detector_config WHERE scope = 'default');
