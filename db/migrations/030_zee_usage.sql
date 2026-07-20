-- Fleet burn tracker: full per-run usage on the zee row (spec: fleet burn tracker).
--
-- Today only cost_usd is persisted from a zee's final `result` event. That event also carries a
-- `usage` object (input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens);
-- capturing all of it lets the dashboard show, per xell and fleet-cumulatively, how many TOKENS a
-- (cxell) zee burned — not just the dollar figure.
--
-- bigint, not int: a cache-heavy run reads back hundreds of thousands of tokens per turn and a
-- long-lived xell accumulates many zees; int (2.1B) is a real ceiling once summed across the fleet.
-- NOT the account-wide %/limits Anthropic's /usage shows — this only tracks what THIS fleet's runs
-- consumed. Additive + idempotent (IF NOT EXISTS): safe on a re-run, never rewrites cost_usd.
ALTER TABLE zee ADD COLUMN IF NOT EXISTS input_tokens       bigint NOT NULL DEFAULT 0;
ALTER TABLE zee ADD COLUMN IF NOT EXISTS output_tokens      bigint NOT NULL DEFAULT 0;
ALTER TABLE zee ADD COLUMN IF NOT EXISTS cache_read_tokens  bigint NOT NULL DEFAULT 0;
ALTER TABLE zee ADD COLUMN IF NOT EXISTS cache_write_tokens bigint NOT NULL DEFAULT 0;
