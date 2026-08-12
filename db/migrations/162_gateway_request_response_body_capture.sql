-- LLM GATEWAY BODY CAPTURE — the request/response BODIES behind each gateway call.
--
-- Migration 154 (llm_gateway_request) records the ledger row: identity, model, path,
-- status, tokens, cost — deliberately narrow and hot. The observability drill-down's
-- input/output panel has NOTHING to render, because the bodies were never stored.
-- This migration adds them on a SEPARATE table keyed by the request row: bodies are big
-- and cold, and the hot ledger stays narrow. A human expanding a gateway call in the
-- console reads the request delta + the reassembled response from here.
--
-- WHAT IS STORED:
--   • request_body   — the DELTA message (the last message in the request's messages/
--                      input array — the new content of THIS call), NOT the whole
--                      resent conversation prefix. Scrubbed of secrets, capped ~32KB
--                      with request_truncated set when the cap cut it.
--   • response_body  — the response text REASSEMBLED from the SSE chunks (never raw
--                      per-chunk fragments, never unbounded — the same 32KB cap).
--                      Scrubbed, capped, response_truncated set when cut.
--
-- RETENTION: 14 days. Bodies are cold by design; the queenzee maintenance loop sweeps
-- rows older than 14 days (llm_gateway_body_created_idx exists for exactly that DELETE).
-- The request ledger row itself is NOT swept — bodies are the cold part, the ledger stays.
--
-- PER-PROJECT SWITCH: pool_config.gateway_body_capture, default ON. OFF stores nothing
-- (the gateway checks it before capturing; the ledger row is written either way).
--
-- Keyed by request_id with ON DELETE CASCADE: deleting a gateway request row removes
-- its bodies with it (a body outliving its request row would be an orphan nobody reads).
-- project_id rides along (denormalised like 154) so the sweep can scope by project and
-- a body survives a xell being reaped.
--
-- Idempotent, additive, forward-only.
CREATE TABLE IF NOT EXISTS llm_gateway_body (
  request_id        uuid PRIMARY KEY REFERENCES llm_gateway_request(id) ON DELETE CASCADE,
  project_id        uuid REFERENCES project(id) ON DELETE CASCADE,
  request_body      text,
  request_truncated boolean NOT NULL DEFAULT false,
  response_body     text,
  response_truncated boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_gateway_body_created_idx ON llm_gateway_body (created_at);
CREATE INDEX IF NOT EXISTS llm_gateway_body_project_idx ON llm_gateway_body (project_id);

ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS gateway_body_capture boolean NOT NULL DEFAULT true;
