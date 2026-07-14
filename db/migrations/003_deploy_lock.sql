-- Cross-xell PRODUCTION deploy lock: only one xell may hold prod at a time (the web app
-- shows a padlock on the holder). Mirrors the /spin:deploy-guard protocol, DB-backed.
CREATE TABLE deploy_lock (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  container   text NOT NULL DEFAULT 'prod',
  xell_id     uuid REFERENCES xell ON DELETE CASCADE,
  zee_id      uuid REFERENCES zee ON DELETE SET NULL,
  phase       text,                -- deploying | awaiting-verification
  task        text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, container)    -- one holder per container per project
);
