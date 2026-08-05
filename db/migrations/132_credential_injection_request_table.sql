-- CREDENTIAL INJECTION — a rotated or repaired provider key reaches LIVE cages without a re-spawn.
--
-- A cage is born with the key its provider account held at dispatch time, and nothing in the fleet
-- can change it afterwards: /etc/environment and the vendor's auth file (~/.codex/auth.json) are
-- written once, at spawn. When a human rotates an account (Project setup) or a zee dies on a 401,
-- every live cage that was born with the OLD key is stuck with it until it is re-dispatched.
--
-- This migration adds the REQUEST half of the fix, shaped exactly on xource_clean_request (111):
--   * a row a HUMAN's action or the QUEENZEE raises (never a zee — there is no zee verb that touches
--     this table);
--   * status pending → approved (the queenzee injects) → completed, or rejected;
--   * result carries a PER-XELL receipt (masked hint only — a token never reaches a log, a result
--     row or a card), and a partial failure is recorded per xell, never thrown away;
--   * dismissed_at is the console's "seen it" marker, never a decision.
--
-- Two kinds, from the two triggers (decision 1 in the work item):
--   * kind='rotation'  — a human connected/replaced an account in Project setup. One request per
--     (project, provider), and it names how many live cages predate the new account's key.
--   * kind='auth-death' — a zee's turn died TERMINAL with signal 'auth' (a 401 / invalid key), quoted
--     and scoped to that xell. 'credit' is NOT a trigger: a new key does not fix an empty balance.
--
-- One OPEN request per xell+provider, and one for a project-wide rotation — the same "one open ask"
-- discipline as prod_bind / xource_clean, so a human is never shown two cards saying the same thing.
CREATE TABLE IF NOT EXISTS credential_inject_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  account_id   uuid REFERENCES provider_token(id) ON DELETE SET NULL,
  kind         text NOT NULL DEFAULT 'rotation'
                 CHECK (kind IN ('rotation','auth-death')),
  xell_id      uuid REFERENCES xell(id) ON DELETE SET NULL,
  reason       text,
  error_quote  text,
  cage_count   int,
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

-- One OPEN rotation per (project, provider) — a human must decide the current one before another
-- rotation of the same provider is raised.
CREATE UNIQUE INDEX IF NOT EXISTS credential_inject_open_rotation_uq
  ON credential_inject_request (project_id, provider) WHERE status = 'pending' AND kind = 'rotation';

-- One OPEN auth-death per (xell, provider) — the same zee dying twice on the same provider shows one
-- card, not two.
CREATE UNIQUE INDEX IF NOT EXISTS credential_inject_open_xell_uq
  ON credential_inject_request (xell_id, provider) WHERE status = 'pending' AND kind = 'auth-death';

CREATE INDEX IF NOT EXISTS credential_inject_project_idx
  ON credential_inject_request (project_id, status, requested_at DESC);
