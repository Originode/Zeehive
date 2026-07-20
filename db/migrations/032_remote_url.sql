-- GitHub as INBOUND-ONLY transport (Mark, 2026-07-20). remote_url records where a project was
-- cloned from and where the human-triggered "Pull" fetches. It is a fetch source, nothing more:
-- no code anywhere pushes to it — Mark pushes by hand — and the dev cycle (landing, integration,
-- prod builds) never depends on it. NULL for folder-onboarded projects.
ALTER TABLE project ADD COLUMN IF NOT EXISTS remote_url text;
