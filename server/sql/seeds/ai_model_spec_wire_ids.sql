-- AI MODEL SPEC WIRE IDS — explicit wire-model-id aliases on ai_model_spec (prod data).
--
-- WHY THIS FILE EXISTS. Migration 164 adds the column AND seeds the current-generation claude
-- wire ids; this seed carries the same wire-id ROWS to PRODUCTION independently of a ship — the
-- "rows into prod" verb (`zee seed`), re-runnable any time (a wire id is data, not schema, and
-- the day Anthropic ships a repriced `claude-opus-6` this is the file a human edits and re-seeds
-- without deploying code). Requires migration 164 to be applied first (the wire_ids column).
--
-- IDEMPOTENT, as a seed must be (seeds are not ledgered and may legitimately be re-run):
-- each UPDATE only fires when the wire id is not already present, so re-running is a no-op.
--
-- GROUND TRUTH, not a regex: an id absent from this list is UNPRICED (cost 0 + a meta note),
-- never guessed — so a repriced next generation is loud instead of silently priced at the
-- previous generation's rate.
UPDATE ai_model_spec SET wire_ids = ARRAY['claude-opus-5']    WHERE provider='claude' AND key='opus'   AND NOT (wire_ids @> ARRAY['claude-opus-5']);
UPDATE ai_model_spec SET wire_ids = ARRAY['claude-sonnet-5']  WHERE provider='claude' AND key='sonnet' AND NOT (wire_ids @> ARRAY['claude-sonnet-5']);
UPDATE ai_model_spec SET wire_ids = ARRAY['claude-haiku-5']   WHERE provider='claude' AND key='haiku'  AND NOT (wire_ids @> ARRAY['claude-haiku-5']);
UPDATE ai_model_spec SET wire_ids = ARRAY['claude-fable-5']   WHERE provider='claude' AND key='fable'  AND NOT (wire_ids @> ARRAY['claude-fable-5']);
