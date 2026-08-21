-- BUILD BOOTSTRAP ACTION — one row per "make this machine buildable" bootstrap a human clicks in
-- the console (ticket #173 follow-on). The build-readiness probe NAMES what is missing on a
-- (machine, project) pair; this is the QUEENZEE-PERFORMED, idempotent creation of those DEV
-- prerequisites. PLAN FIRST: the console shows the plan (dry_run) before a human commits; the
-- performed steps (with per-step result) are recorded here so "who asked, what ran, what came
-- back" is an audit fact, not a terminal line.
CREATE TABLE IF NOT EXISTS build_bootstrap_action (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  machine_id  uuid NOT NULL REFERENCES machine(id) ON DELETE CASCADE,
  actor       text NOT NULL,                    -- who clicked ('human@console' fallback, like every console write)
  dry_run     boolean NOT NULL DEFAULT false,   -- true = plan only, nothing performed
  status      text NOT NULL DEFAULT 'planned',  -- planned | performed | already-present | refused | failed
  reason      text,                             -- refusal / overall failure reason
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{kind,target,why,action,status,detail,stderr}]
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS build_bootstrap_action_pair_idx
  ON build_bootstrap_action (project_id, machine_id, created_at DESC);

COMMENT ON TABLE build_bootstrap_action IS
  'A console-started, queenzee-performed bootstrap that creates the DEV prerequisites the build-readiness probe names as missing on a (machine, project) pair. Dry-run rows record the plan before a human commits; performed rows record each step result. Never touches prod (lib/build-bootstrap.js guards).';
COMMENT ON COLUMN build_bootstrap_action.steps IS
  'Per-step plan/performed result: [{kind,target,why,action,status,detail,stderr}] with status created | already-present | cannot | failed | started.';
