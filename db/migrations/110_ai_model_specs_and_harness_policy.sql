-- AI MODEL SPECS + PER-HARNESS MODEL POLICY — model specs live in the meta-DB, harnesses
-- get policy knobs, and dispatch resolves the model the harness allows.
--
-- Two halves, one migration:
--
-- (A) ai_model_spec — a registry of the models the fleet can dispatch on, stored in the meta-DB
--     like harnesses/project docs (house rule: "what a zee is told/run on is DATA"). Each row names
--     a provider that owns it, the model id/alias, and the parameters that matter for choosing one:
--     context window, output/parameter ceilings, etc. The registry is the single place an operator
--     records "what is this model and what is it good for" — instead of the current hard-coded
--     lists in intake.js/cxell-runtimes.js, which live in code and need a land/ship to change.
--
-- (B) harness.model_policy — a jsonb of RESTRICTION KNOBS per harness. A harness is the config
--     layer a zee wears, so it is the natural place to say "manager zees run flagship claude
--     models; worker zees run deepseek". The policy can:
--       • limit which providers/models a wearer may run on   (allow_providers / allow_models)
--       • bound the context window and parameter count       (min_context / max_context,
--                                                             min_params / max_params)
--       • express DEPLOYMENT PRIORITY for models             (priorities: { model: n })
--       • name the DEFAULT model when none is explicit       (default_model)
--     Dispatch resolves the harness's policy BEFORE a zee spawns: an explicit model a policy
--     forbids is refused (the harness is the manual — running a zee on a model its persona does
--     not allow is the same class of bug as briefing it with the wrong manual), and a bare
--     dispatch (no explicit model) gets the highest-priority allowed model.
--
-- Priorities default to 1 for every allowed model: "higher priority gets deployed first" — and
-- the example from the ticket works out of the box (prioritize claude flagship for managers,
-- deepseek for workers) by writing priorities in the harness policy.

-- ── (A) the model-spec registry ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_model_spec (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,                -- claude | openai | kimi | deepseek …
  key            text NOT NULL,                -- opus | gpt-5.6-sol | deepseek-reasoner …
  label          text NOT NULL,                -- 'Opus' (the picker's label)
  note           text,                         -- one line: what it is good for
  context_window bigint,                       -- tokens of context the model supports (NULL = unknown)
  max_output     bigint,                       -- tokens of max output (NULL = unknown)
  parameters     bigint,                       -- parameter count in BILLIONS (NULL = unknown)
  is_default     boolean NOT NULL DEFAULT false, -- the bare-dispatch default for this provider
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, key)
);

COMMENT ON TABLE ai_model_spec IS
  'AI model specifications the fleet can dispatch on (meta-DB owned). One row per (provider, model id/alias): label, note, context window, output/parameter ceilings. Harness model policies reference these to restrict what a zee may run on.';
COMMENT ON COLUMN ai_model_spec.parameters IS
  'Model parameter count in BILLIONS (e.g. 405 = 405B). Used by harness model_policy min_params/max_params. NULL = unknown/not applicable.';
COMMENT ON COLUMN ai_model_spec.is_default IS
  'The bare-dispatch default model for its provider (one per provider; mirrors the code default).';

CREATE INDEX IF NOT EXISTS ai_model_spec_provider_idx ON ai_model_spec (provider, enabled);

-- ── (B) per-harness model policy knobs ────────────────────────────────────────
ALTER TABLE harness ADD COLUMN IF NOT EXISTS model_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN harness.model_policy IS
  'Per-harness AI model policy: { allow_providers?, allow_models?, min_context?, max_context?, min_params?, max_params?, priorities?: {model: n}, default_model? }. Restricts what a zee wearing this harness may run on, and sets deployment priority per model (default 1; higher deploys first). Dispatch resolves this BEFORE spawn.';

-- ── seed the registry from today's known model lists (the code defaults, made data) ──
-- claude aliases (intake.js ZEE_MODELS — generation aliases the CLI resolves upstream).
INSERT INTO ai_model_spec (provider, key, label, note, is_default) VALUES
  ('claude', 'opus',   'Opus',   'most capable — best for unattended, load-bearing work', true),
  ('claude', 'sonnet', 'Sonnet', 'fast and cheaper — good for well-scoped or simple jobs', false),
  ('claude', 'haiku',  'Haiku',  'fastest and cheapest — light edits and quick tasks',    false),
  ('claude', 'fable',  'Fable',  'newest generation — huge (1M) context; unproven on unattended zee work', false)
ON CONFLICT (provider, key) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, is_default = EXCLUDED.is_default;

-- openai (cxell-runtimes.js VENDOR_MODELS.openai)
INSERT INTO ai_model_spec (provider, key, label, note, is_default) VALUES
  ('openai', '',          'Codex default', 'the codex CLI''s own recommended model', true),
  ('openai', 'gpt-5.6-sol',   'GPT-5.6 Sol',   'flagship — complex, long-horizon work', false),
  ('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'balanced everyday workhorse', false),
  ('openai', 'gpt-5.6-luna',  'GPT-5.6 Luna',  'fast and affordable', false),
  ('openai', 'gpt-5.4-mini',  'GPT-5.4 mini',  'cheapest — light edits and quick tasks', false)
ON CONFLICT (provider, key) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, is_default = EXCLUDED.is_default;

-- kimi (cxell-runtimes.js VENDOR_MODELS.kimi)
INSERT INTO ai_model_spec (provider, key, label, note, is_default) VALUES
  ('kimi', '',                   'Kimi default', 'the Kimi CLI''s own default model', true),
  ('kimi', 'k3',                        'K3',              'flagship', false),
  ('kimi', 'kimi-for-coding',           'K2.7 Code',       'standard coding model', false),
  ('kimi', 'kimi-for-coding-highspeed', 'K2.7 high-speed', 'same model, faster serving', false)
ON CONFLICT (provider, key) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, is_default = EXCLUDED.is_default;

-- deepseek (cxell-runtimes.js VENDOR_MODELS.deepseek)
INSERT INTO ai_model_spec (provider, key, label, note, is_default) VALUES
  ('deepseek', '',                'DeepSeek default', 'the DeepSeek CLI''s own default model', true),
  ('deepseek', 'deepseek-chat',     'DeepSeek Chat',     'the current V-series — fast, everyday coding', false),
  ('deepseek', 'deepseek-reasoner', 'DeepSeek Reasoner', 'the thinking R-series — hard, long-horizon work', false)
ON CONFLICT (provider, key) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, is_default = EXCLUDED.is_default;
