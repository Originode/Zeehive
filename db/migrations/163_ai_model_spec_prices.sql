-- AI MODEL SPEC PRICES — $/1M token prices for the models the fleet dispatches on.
--
-- Migration 110 created ai_model_spec as the model registry (label, note, context window,
-- output/parameter ceilings) but deliberately no prices. The LLM gateway (154) records every
-- AI call at the transport layer and needs to DERIVE cost: the upstream's usage object is
-- authoritative for tokens, and Anthropic-dialect responses carry no cost field, so the cost
-- column was structurally $0 on every row. This migration adds the four per-mtok prices the
-- gateway's costOf() reads (server/src/lib/gateway.js): input, output, cache read, cache write.
--
-- Prices are per MILLION tokens (mtok) in USD, matching the providers' published pricing.
-- NULL = unknown/not applicable — a model with no price records cost 0, never a wrong
-- estimate. The provider DEFAULT models (key = '') have no fixed price: the CLI resolves
-- the actual model upstream, so there is nothing to price here.
--
-- The values are the providers' public list prices as of 2026-08:
--   claude   opus  $15/$75  · sonnet $3/$15  · haiku $0.80/$4  · fable $5/$25
--            (cache read/write $1.50/$18.75 · $0.30/$3.75 · $0.08/$1.00 · $0.50/$6.25)
--   deepseek chat $0.28/$0.42 · reasoner $0.55/$2.19
--   grok     grok-4.5 $3/$15
--   kimi     k3 + kimi-for-coding(+highspeed) $0.60/$2.50
--   openai   gpt-5.6-sol $1.25/$10 · terra $0.75/$6 · luna $0.40/$1.60 · mini $0.25/$2
--
-- Idempotent, additive, forward-only. ADD COLUMN IF NOT EXISTS + ON CONFLICT DO UPDATE make it
-- a no-op on a DB that already carries the columns (the shared dev DB predates this landing via
-- a lost sibling migration) and a clean apply on a fresh one.
ALTER TABLE ai_model_spec ADD COLUMN IF NOT EXISTS input_price_per_mtok numeric;
ALTER TABLE ai_model_spec ADD COLUMN IF NOT EXISTS output_price_per_mtok numeric;
ALTER TABLE ai_model_spec ADD COLUMN IF NOT EXISTS cache_read_price_per_mtok numeric;
ALTER TABLE ai_model_spec ADD COLUMN IF NOT EXISTS cache_write_price_per_mtok numeric;

COMMENT ON COLUMN ai_model_spec.input_price_per_mtok IS
  'USD per MILLION input tokens (the gateway costOf() reads this). NULL = unknown/not applicable.';
COMMENT ON COLUMN ai_model_spec.output_price_per_mtok IS
  'USD per MILLION output tokens (the gateway costOf() reads this). NULL = unknown/not applicable.';
COMMENT ON COLUMN ai_model_spec.cache_read_price_per_mtok IS
  'USD per MILLION cache-read tokens (prompt caching, Anthropic). NULL = no cache read price.';
COMMENT ON COLUMN ai_model_spec.cache_write_price_per_mtok IS
  'USD per MILLION cache-write tokens (prompt caching, Anthropic). NULL = no cache write price.';

INSERT INTO ai_model_spec (provider, key, label, note, is_default,
                           input_price_per_mtok, output_price_per_mtok,
                           cache_read_price_per_mtok, cache_write_price_per_mtok) VALUES
  ('claude', 'opus',   'Opus',   'most capable — best for unattended, load-bearing work', true,
    15, 75, 1.50, 18.75),
  ('claude', 'sonnet', 'Sonnet', 'fast and cheaper — good for well-scoped or simple jobs', false,
    3, 15, 0.30, 3.75),
  ('claude', 'haiku',  'Haiku',  'fastest and cheapest — light edits and quick tasks',    false,
    0.80, 4, 0.08, 1.00),
  ('claude', 'fable',  'Fable',  'newest generation — huge (1M) context; unproven on unattended zee work', false,
    5, 25, 0.50, 6.25),
  ('deepseek', 'deepseek-chat',     'DeepSeek Chat',     'the current V-series — fast, everyday coding', false,
    0.28, 0.42, NULL, NULL),
  ('deepseek', 'deepseek-reasoner', 'DeepSeek Reasoner', 'the thinking R-series — hard, long-horizon work', false,
    0.55, 2.19, NULL, NULL),
  ('grok', 'grok-4.5', 'Grok 4.5', 'the flagship coding model — configurable reasoning', false,
    3, 15, NULL, NULL),
  ('kimi', 'k3',                        'K3',              'flagship', false,
    0.60, 2.50, NULL, NULL),
  ('kimi', 'kimi-for-coding',           'K2.7 Code',       'standard coding model', false,
    0.60, 2.50, NULL, NULL),
  ('kimi', 'kimi-for-coding-highspeed', 'K2.7 high-speed', 'same model, faster serving', false,
    0.60, 2.50, NULL, NULL),
  ('openai', 'gpt-5.6-sol',   'GPT-5.6 Sol',   'flagship — complex, long-horizon work', false,
    1.25, 10, NULL, NULL),
  ('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'balanced everyday workhorse', false,
    0.75, 6, NULL, NULL),
  ('openai', 'gpt-5.6-luna',  'GPT-5.6 Luna',  'fast and affordable', false,
    0.40, 1.60, NULL, NULL),
  ('openai', 'gpt-5.4-mini',  'GPT-5.4 mini',  'cheapest — light edits and quick tasks', false,
    0.25, 2, NULL, NULL)
ON CONFLICT (provider, key) DO UPDATE SET
  input_price_per_mtok = EXCLUDED.input_price_per_mtok,
  output_price_per_mtok = EXCLUDED.output_price_per_mtok,
  cache_read_price_per_mtok = EXCLUDED.cache_read_price_per_mtok,
  cache_write_price_per_mtok = EXCLUDED.cache_write_price_per_mtok;
