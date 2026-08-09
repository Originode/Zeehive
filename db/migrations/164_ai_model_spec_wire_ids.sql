-- AI MODEL SPEC WIRE IDS — explicit wire-model-id aliases on ai_model_spec.
--
-- Migration 110 keys ai_model_spec on SHORT aliases (claude 'opus','sonnet','haiku','fable');
-- the gateway ledger (154) records the WIRE id the CLI actually sent (claude-opus-5) — the CLI
-- resolves `opus` → `claude-opus-5` server-side, and the codebase never hardcodes that mapping.
-- So modelPrice() matched key EXACTLY, missed every claude row (wire id ≠ key), and cost fell
-- back to 0. deepseek/grok/openai/kimi price only because their keys happen to equal their wire
-- ids ('deepseek-chat', 'grok-4.5', 'gpt-5.6-sol', 'k3' …).
--
-- WHY EXPLICIT wire_ids, NOT a strip/regex in code: ground truth. The alias list is DATA on the
-- spec row, so an id absent from the list is UNPRICED (cost 0 + a meta note — never a wrong
-- estimate), not normalised into a guess. The day Anthropic reprices `claude-opus-6`, it is not
-- in the list, so it is loudly unpriced until a migration adds it — instead of silently priced
-- at the opus-5 row.
--
-- The seeded wire ids are the CURRENT-GENERATION ids, per intake.js ZEE_MODELS: every claude
-- alias resolves to the current generation (`claude-<alias>-5` — claude-opus-5 + claude-fable-5
-- CONFIRMED from prod rows; sonnet/haiku follow the same documented current-gen pattern). A
-- future generation gets its own row/alias migration.
--
-- Idempotent, additive, forward-only. The seed half is repeated as an idempotent SEED file
-- (server/sql/seeds/ai_model_spec_wire_ids.sql) so a wire id can be added to prod independently
-- of a ship, via `zee seed` — the migration rides the ship AND a fresh db; the seed is the
-- re-runnable prod-data path.
ALTER TABLE ai_model_spec ADD COLUMN IF NOT EXISTS wire_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN ai_model_spec.wire_ids IS
  'Explicit wire-model ids that resolve to this spec row, in ADDITION to key (e.g. key opus → wire id claude-opus-5). Ground truth: an id NOT listed here is unpriced, never guessed. Empty = the key IS the wire id.';

UPDATE ai_model_spec SET wire_ids = '{}'::text[] WHERE wire_ids IS NULL;

UPDATE ai_model_spec SET wire_ids = ARRAY['claude-opus-5']    WHERE provider='claude' AND key='opus'   AND NOT (wire_ids @> ARRAY['claude-opus-5']);
UPDATE ai_model_spec SET wire_ids = ARRAY['claude-sonnet-5']  WHERE provider='claude' AND key='sonnet' AND NOT (wire_ids @> ARRAY['claude-sonnet-5']);
UPDATE ai_model_spec SET wire_ids = ARRAY['claude-haiku-5']   WHERE provider='claude' AND key='haiku'  AND NOT (wire_ids @> ARRAY['claude-haiku-5']);
UPDATE ai_model_spec SET wire_ids = ARRAY['claude-fable-5']   WHERE provider='claude' AND key='fable'  AND NOT (wire_ids @> ARRAY['claude-fable-5']);
