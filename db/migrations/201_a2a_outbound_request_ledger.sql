-- A2A OUTBOUND REQUEST LEDGER — every queenzee-mediated A2A call a zee makes to an EXTERNAL agent.
--
-- The phase-4 `zee a2a <card-url> --message "…"` verb (plan §6 P4) is queenzee-mediated: the zee
-- never dials the external server directly, the queenzee makes the HTTP call on its behalf, and
-- the call is RECORDED at the transport layer exactly like the LLM gateway records its calls
-- (llm_gateway_request, 154): which xell/zee made it, which external agent it went to, the message
-- sent, and the verdict the external server answered. A zee's word about an external conversation
-- is not the fleet's record — this row is (the same transparency stance as the gateway ledger: the
-- transport layer remembers what actually happened, whatever the caller later claims).
--
-- Why a NEW table instead of reusing llm_gateway_request: that table's kind CHECK only admits
-- 'messages' / 'chat-completions' and its cost columns describe an LLM call. An A2A send is a
-- different transport (an external HTTP server, a card URL, a JSON-RPC verdict), and shoehorning
-- it into the LLM ledger would lie about what the row means.
--
-- Idempotent, additive, forward-only. Attribution is IDENTITY like the gateway ledger: the xell
-- token resolves the caller (routes.js resolveSelf), and zee_id/turn_id are the live zee + open
-- turn at request time (best-effort, denormalised — the xell is authoritative).
CREATE TABLE IF NOT EXISTS a2a_outbound_request (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  xell_id        uuid REFERENCES xell(id) ON DELETE SET NULL,
  zee_id         uuid REFERENCES zee(id) ON DELETE SET NULL,
  turn_id        uuid REFERENCES zee_turn(id) ON DELETE SET NULL,
  project_id     uuid REFERENCES project(id) ON DELETE CASCADE,
  card_url       text NOT NULL,          -- the external agent card URL the zee named
  agent_url      text,                   -- the JSON-RPC endpoint resolved from the card
  method         text NOT NULL DEFAULT 'SendMessage',
  body           text,                   -- the message text sent to the external agent
  status         int,                    -- the external server's HTTP status (0 = never answered)
  response       jsonb,                  -- the external JSON-RPC result/error envelope
  error          text,                   -- what went wrong, in words
  requested_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  duration_ms    int,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS a2a_outbound_xell_idx   ON a2a_outbound_request (xell_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS a2a_outbound_project_idx ON a2a_outbound_request (project_id, requested_at DESC);
