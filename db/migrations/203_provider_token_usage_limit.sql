-- PROVIDER ACCOUNT USAGE LIMIT SNAPSHOT — how much of THIS account's limit is still available.
--
-- The job is "how much of the usage limit is available per provider", not per-xell burn. Fleet
-- burn (zee rows / llm_gateway_request totals) answers "what did we spend". The question here
-- is "how full is the provider ACCOUNT's quota window right now" — Claude Code's 5h/7d seat
-- windows, or the API's RPM/TPM remaining headers.
--
-- Source of truth is the upstream's own response headers, captured by the LLM gateway on every
-- call (lib/gateway.js extractRateLimit). The gateway writes the freshest snapshot onto the
-- provider_token row that authenticated the call. The console reads it back next to each
-- account in Project setup and as a statusline chip — never as a per-xell figure.
--
-- shape of usage_limit (jsonb), written by the gateway, never hand-authored:
--   {
--     "source": "headers",
--     "status": "allowed" | "exceeded" | "rate_limited" | null,
--     "representative": "five_hour" | "seven_day" | …,
--     "available_pct": 93.0,          -- THE number a human wants (remaining of the binding window)
--     "windows": {                    -- Claude Code / OAuth seat (anthropic-ratelimit-unified-*)
--       "5h": { "status", "utilization", "available_pct", "reset_at" },
--       "7d": { … }
--     },
--     "tokens":   { "remaining", "limit", "available_pct", "reset" },  -- API TPM headers
--     "requests": { "remaining", "limit", "available_pct", "reset" }   -- API RPM headers
--   }
--
-- Additive, idempotent, forward-only. No existing column is rewritten.
ALTER TABLE provider_token
  ADD COLUMN IF NOT EXISTS usage_limit    jsonb,
  ADD COLUMN IF NOT EXISTS usage_limit_at timestamptz;

COMMENT ON COLUMN provider_token.usage_limit IS
  'Freshest rate/usage-limit snapshot for THIS account (gateway headers). See migration 203.';
COMMENT ON COLUMN provider_token.usage_limit_at IS
  'When usage_limit was last written by the LLM gateway.';
