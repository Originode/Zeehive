-- Monitoring columns: whether a zee's session is REALLY active per the `claude` CLI
-- (agents --json for local/headless, `claude remote list` for remote), independent of
-- the model self-reporting.
ALTER TABLE zee
  ADD COLUMN cli_active      boolean,
  ADD COLUMN monitor_source  text,       -- 'agents-json' | 'remote-list' | 'remote-status'
  ADD COLUMN last_monitor_at timestamptz,
  ADD COLUMN remote_ref      text;       -- remote session handle/name if runtime is remote
