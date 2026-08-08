-- LLM GATEWAY REQUEST LEDGER — every AI call that crosses the queenzee gateway.
--
-- The queenzee becomes a transparent LLM gateway (LiteLLM-style): every cxell CLI points its
-- base URL at the queenzee, so EVERY AI call — spawn, resume, or interactive — crosses one
-- door the queenzee owns. This table records each request at the transport layer:
-- which xell/zee made it, which provider/model, the exact token usage + cost the UPSTREAM
-- reported, and the per-turn grouping (the span that started the session).
--
-- WHY a new table instead of reusing zee_turn (153): zee_turn is one row per TURN with the
-- turn's AGGREGATE burn. The gateway records one row per REQUEST — a turn makes many requests
-- (each tool call, each retry, each streaming chunk is a messages/completions POST). The two
-- grains are different and both are needed: zee_turn says "this turn cost $X total", the
-- gateway ledger says "here are the individual calls that added up to $X". turn_id links the
-- per-request rows to their turn (SET NULL on delete — a request outlives a reaped turn row
-- the way xell_conversation outlives a xell).
--
-- Attribution is IDENTITY, not parsing: the gateway authenticates the caller by the per-xell
-- identity token (ZEEHIVE_XELL_TOKEN, lib/xell-token.js) the cxell already carries. It knows
-- WHICH xell made every call without parsing a session id out of CLI output. zee_id is the
-- live zee of that xell at request time (denormalised for the read model; it is the xell that
-- is authoritative).
--
-- Idempotent, additive, forward-only.
CREATE TABLE IF NOT EXISTS llm_gateway_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  xell_id        uuid REFERENCES xell(id) ON DELETE SET NULL,
  zee_id         uuid REFERENCES zee(id) ON DELETE SET NULL,
  turn_id        uuid REFERENCES zee_turn(id) ON DELETE SET NULL,
  project_id     uuid REFERENCES project(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'messages'
                   CHECK (kind IN ('messages','chat-completions')),
  provider       text,             -- claude | openai | kimi | deepseek | grok (resolved)
  model          text,
  session_id     text,             -- the CLI's session id, if the request carried one
  method         text NOT NULL,
  path           text NOT NULL,
  status         int,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  cache_read_tokens  bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  total_tokens   bigint NOT NULL DEFAULT 0,
  cost_usd       numeric NOT NULL DEFAULT 0,
  duration_ms    int,
  error          text,             -- the upstream error, if the call failed
  requested_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_gateway_xell_idx   ON llm_gateway_request (xell_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS llm_gateway_turn_idx   ON llm_gateway_request (turn_id, requested_at ASC);
CREATE INDEX IF NOT EXISTS llm_gateway_project_idx ON llm_gateway_request (project_id, requested_at DESC);
