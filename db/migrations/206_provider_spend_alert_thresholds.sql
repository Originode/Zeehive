-- PER-PROVIDER SPEND-ALERT THRESHOLDS (project settings) — a human sets an alert AMOUNT (USD)
-- for each provider in Project setup → Agent providers. When ANY xell's cumulative spend on that
-- provider (the LLM gateway ledger, llm_gateway_request.cost_usd) exceeds the amount, that xell's
-- hexagon shows an obvious over-budget indicator.
--
-- WHY a project-level JSONB map instead of a column per provider (or per provider_token):
--   • the provider catalogue is a CODE registry (PROVIDERS in lib/provider-tokens.js), not a fixed
--     column list — a new provider must not need a migration;
--   • the threshold is per PROVIDER TYPE, not per account: a project with two Claude accounts has
--     ONE "how much may one xell burn on Claude" number;
--   • it is a human setting about the project, so it rides the project row like the auto-approve
--     flags (022/122), read by the fleet read model beside them.
--
-- Shape: { "claude": 50.0, "openai": 25.0 } — keys are provider keys, values are USD amounts.
-- Absent key = no alert for that provider. A value of 0/null clears the alert.
ALTER TABLE project
  ADD COLUMN IF NOT EXISTS provider_alert_amounts jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN project.provider_alert_amounts IS
  'Per-provider spend-alert thresholds (USD): { claude: 50 } flags a xell whose gateway-ledger spend on claude exceeds $50.';
