-- ZEE DECOUPLED FROM XELL — a zee is an AGENT; a xell is an ENVIRONMENT; a medic is a zee WITH NO
-- ENVIRONMENT (docs/medic-meta-plane-plan.md §3.1, DR-7). Relaxing zee.xell_id (NOT NULL since 001)
-- to an exactly-one-of (xell_id | medic_id) keeps the whole observability spine — zee row, turn
-- ledger, feed events, zee_conversation — carrying medic turns UNCHANGED, and every existing query
-- that JOINs zee→xell simply never sees a medic (which is the separation the Medic Bay wants:
-- the honeycomb renders xell rows and excludes medics structurally, for free).
--
-- zee_turn.xell_id and session_event.xell_id are ALREADY nullable (001) — no change needed there.
--
-- Idempotent, additive, forward-only. Every existing row has xell_id set and medic_id absent, so
-- the CHECKs validate without a rewrite.

-- ── zee: exactly one plane ───────────────────────────────────────────────────────────────────
ALTER TABLE zee ALTER COLUMN xell_id DROP NOT NULL;
ALTER TABLE zee ADD COLUMN IF NOT EXISTS medic_id uuid REFERENCES medic(id) ON DELETE CASCADE;
COMMENT ON COLUMN zee.medic_id IS
  'set iff this zee is a META-PLANE MEDIC turn-runner (DR-7) — then xell_id is NULL: a medic has no environment';
DO $$ BEGIN
  ALTER TABLE zee ADD CONSTRAINT zee_exactly_one_plane
    CHECK (((xell_id IS NOT NULL))::int + ((medic_id IS NOT NULL))::int = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- one LIVE zee per medic — the exact mirror of one_active_zee_per_xell (001). The 001 index is a
-- partial on (xell_id); NULL xell_id rows are simply absent from it, so it needs no change.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_zee_per_medic ON zee (medic_id)
  WHERE medic_id IS NOT NULL AND status IN ('spawning','online','working','idle');

-- ── zee_conversation: the durable unit is the medic row, exactly as it is the xell for a zee ─
ALTER TABLE zee_conversation ALTER COLUMN xell_id DROP NOT NULL;
ALTER TABLE zee_conversation ADD COLUMN IF NOT EXISTS medic_id uuid REFERENCES medic(id) ON DELETE CASCADE;
COMMENT ON COLUMN zee_conversation.medic_id IS
  'set iff this message belongs to a MEDIC''s working memory (DR-7) — then xell_id is NULL; a resumed medic starts warm on its own history';
DO $$ BEGIN
  ALTER TABLE zee_conversation ADD CONSTRAINT zee_conversation_exactly_one_plane
    CHECK (((xell_id IS NOT NULL))::int + ((medic_id IS NOT NULL))::int = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- the medic-side twin of UNIQUE (xell_id, seq) — the append path upserts ON CONFLICT against it
CREATE UNIQUE INDEX IF NOT EXISTS zee_conversation_medic_seq_uq ON zee_conversation (medic_id, seq)
  WHERE medic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS zee_conversation_medic_idx ON zee_conversation (medic_id, seq)
  WHERE medic_id IS NOT NULL;
