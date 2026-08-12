-- LANGCHAIN STATEFUL ZEE CONVERSATION — the working memory that survives a handover.
--
-- A zee's context dies with its cxell; the next zee (a swap, a resume, a re-dispatch) starts cold
-- and re-derives what the previous one knew. This migration adds the durable conversation store the
-- langchain zee driver (server/src/lib/langchain-zee.js, docs/langchain-stateful-zees.md) reads
-- before a turn and appends after it, so a handover starts the next zee WARM.
--
-- DESIGN (see the doc §4):
--   • Keyed by xell_id — the xell is the durable work unit (it survives zee swaps and re-crews;
--     xell.execution_id already says the same for the workflow plane). A swap retires the old zee
--     row but the xell's conversation keeps accumulating.
--   • One row per message, with a per-xell seq the app maintains (MAX(seq)+1) so replay order is
--     exact and independent of clock skew.
--   • Lifetime = the xell's lifetime: ON DELETE CASCADE. A reaped xell's conversation goes with it;
--     a live xell's conversation is exactly the state its next turn needs. No separate retention
--     sweep is required.
--   • Best-effort append by contract (the driver never lets a write fail a turn).
--
-- It is deliberately NOT xell_conversation (112): that table is an ARCHIVE — a receipt about a
-- finished xell (the raw JSONL transcript, ON DELETE SET NULL so it outlives the xell). This table
-- is the WORKING MEMORY a live xell carries into its next turn. The two do not merge.
--
-- The runtime row: a zee can be driven by langchain instead of a vendor CLI. The dispatch path
-- checks rt.driver (the same seam 'cxell-cli' uses) and routes to spawnLangchainZee.
--
-- Idempotent, additive, forward-only.
CREATE TABLE IF NOT EXISTS zee_conversation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  xell_id    uuid NOT NULL REFERENCES xell(id) ON DELETE CASCADE,
  zee_id     uuid REFERENCES zee(id) ON DELETE SET NULL,
  turn_id    uuid REFERENCES zee_turn(id) ON DELETE SET NULL,
  seq        int  NOT NULL,
  role       text NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content    text NOT NULL,
  name       text,                              -- tool name for tool-role messages
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (xell_id, seq)
);

CREATE INDEX IF NOT EXISTS zee_conversation_xell_idx  ON zee_conversation (xell_id, seq);
CREATE INDEX IF NOT EXISTS zee_conversation_turn_idx ON zee_conversation (turn_id);
CREATE INDEX IF NOT EXISTS zee_conversation_zee_idx  ON zee_conversation (zee_id);

INSERT INTO agent_runtime (key,label,vendor,driver,viewer_kind,viewer_url_template,enabled,sort_order)
VALUES ('langchain-stateful','LangChain (stateful)','langchain','langchain','none',NULL,false,200)
ON CONFLICT (key) DO NOTHING;
