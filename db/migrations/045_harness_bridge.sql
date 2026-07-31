-- HARNESS BRIDGE CONFIG — the live, UI-editable connection to a harness's external web UI (Hermes).
--
-- The HARNESS.yml `bridge:` block is the DEFAULT (truth-in-repo, versioned). This DB override is what
-- a human sets from the dashboard so pointing Zeehive at a RUNNING Hermes instance — its base_url,
-- enabling the mirror, opting into inbound replies — needs no land/ship. refreshHarnesses() never
-- touches these columns, so a file refresh can't clobber an operator's live wiring.
--
-- bridge_probe records the last "Test connection" result (the discovery-endpoint probe) so the setup
-- UI can show, truthfully, whether the configured Hermes instance actually answered — real end-to-end
-- verification of the Hermes side, not an assertion.
ALTER TABLE harness
  ADD COLUMN IF NOT EXISTS bridge_override jsonb,   -- { base_url, enabled, inbound, session_key, append_path, viewer_url_template, mode }
  ADD COLUMN IF NOT EXISTS bridge_probe    jsonb;   -- last probe: { ok, at, status, url, detail }

COMMENT ON COLUMN harness.bridge_override IS
  'Operator-set live bridge connection (overrides the HARNESS.yml bridge block). Set from the dashboard; never overwritten by the file refresh.';
COMMENT ON COLUMN harness.bridge_probe IS
  'Last discovery-endpoint probe result from the setup UI''s Test connection — the honest "did Hermes answer?" record.';
