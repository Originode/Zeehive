-- XELL OBSERVABILITY LEDGER — per-turn usage + cost + the play-by-play event log.
--
-- A human wants to right-click a xell in the console and see, per TURN, what the zee
-- did (play-by-play), what it cost, and how many tokens it burned. Today the zee row
-- carries LIFETIME burn (cost_usd + token counters, migration 030) and session_event
-- carries a sparse append-only hook log (tend/hints/refusals) — but there is NO
-- per-turn record: a xell that hosted three zees (a swap, a resume) cannot say which
-- turn spent what, and the play-by-play feed (the stream-json events intake.js already
-- receives and broadcasts as 'zee-output') is not persisted anywhere.
--
-- This migration adds the missing two shapes, both following established precedent:
--
--   (A) zee_turn — ONE ROW PER TURN, the unit of observability. A turn is one
--       queenzee-started session invocation (spawn, resume) or one interactive turn
--       (a human/manager typing into the pane). Each row carries the turn's OWN
--       cost + token usage (not the zee's lifetime sum), its model, its session,
--       its timing and how it ended. Mirrors the zee row's burn columns (030) so
--       the same usageFrom() reader feeds both. xell_id + project_id ride along
--       (denormalised like xell_conversation, 112) so a turn survives its zee being
--       decommissioned (ON DELETE CASCADE keeps it with the zee; the xell/project
--       ids keep it findable after).
--
--   (B) session_event.turn_id — a nullable FK so the play-by-play events (assistant
--       text, tool_use, tool_result, result) that intake.js's feed() already sees can
--       be attributed to the turn they belong to. session_event is the existing
--       append-only log (tend/hints/refusals ride it); adding a nullable column is
--       backward compatible — every existing INSERT uses an explicit column list and
--       simply leaves turn_id null.
--
-- Both are idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), safe to
-- re-run, and forward-only: the folder is the ledger.
CREATE TABLE IF NOT EXISTS zee_turn (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zee_id             uuid NOT NULL REFERENCES zee(id) ON DELETE CASCADE,
  xell_id            uuid REFERENCES xell(id) ON DELETE CASCADE,
  project_id         uuid REFERENCES project(id) ON DELETE CASCADE,
  kind               text NOT NULL DEFAULT 'spawn'
                       CHECK (kind IN ('spawn','resume','interactive')),
  status             text NOT NULL DEFAULT 'started'
                       CHECK (status IN ('started','ended','errored','paused')),
  session_id         text,
  model              text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  cost_usd           numeric NOT NULL DEFAULT 0,
  input_tokens       bigint NOT NULL DEFAULT 0,
  output_tokens      bigint NOT NULL DEFAULT 0,
  cache_read_tokens  bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  metered            boolean NOT NULL DEFAULT true,
  stop_reason        text,
  summary            text,          -- last assistant text of the turn (what it said)
  meta               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zee_turn_zee_idx  ON zee_turn (zee_id, started_at DESC);
CREATE INDEX IF NOT EXISTS zee_turn_xell_idx ON zee_turn (xell_id, started_at DESC);

-- The play-by-play attribution: which turn an event belongs to (nullable — existing
-- events have no turn).
ALTER TABLE session_event ADD COLUMN IF NOT EXISTS turn_id uuid REFERENCES zee_turn(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS session_event_turn_idx ON session_event (turn_id, ts);
