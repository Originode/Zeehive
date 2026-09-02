-- ZEE DECOUPLED FROM XELL — the medic plane's one FK relaxation (docs/medic-meta-plane-plan.md
-- §3.1, DR-7; provision-proof kit stage 4; requires 244's medic table).
--
-- A xell is an ENVIRONMENT; a zee is an AGENT. Until now an agent could not exist without an
-- environment (zee.xell_id NOT NULL) — which is exactly the coupling the medic breaks: a medic is
-- a zee whose "environment" is the meta-DB itself. Relaxing the one column (instead of minting a
-- "virtual xell") keeps every consumer honest: the pool, the reaper, the preflight, the proof
-- ladder and the honeycomb all read xell rows and simply never see a medic — the separation the
-- directive asks for, for free. zee_turn.xell_id and session_event.xell_id have been nullable
-- since 001, so the observability spine already tolerates a xell-less zee.
--
-- The CHECK is exactly-one-of: a zee is on a xell OR on a medic, never both, never neither. Same
-- trio on zee_conversation (192) — for a medic the durable work unit IS the medic row, so a
-- resumed medic starts warm on its own history exactly as a swapped zee does on its xell's.
--
-- one_active_zee_per_xell (001) is a unique index on (xell_id): NULLs never collide in a btree
-- unique index, so medic zees do not trip it — but the SAME invariant must hold per medic, so the
-- mirror index is added here.
--
-- Idempotent, additive, forward-only.
ALTER TABLE zee ALTER COLUMN xell_id DROP NOT NULL;
ALTER TABLE zee ADD COLUMN IF NOT EXISTS medic_id uuid REFERENCES medic(id) ON DELETE CASCADE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zee_exactly_one_plane') THEN
    ALTER TABLE zee ADD CONSTRAINT zee_exactly_one_plane
      CHECK ((xell_id IS NOT NULL)::int + (medic_id IS NOT NULL)::int = 1);
  END IF;
END $$;

-- a medic has at most one LIVE zee at a time — the mirror of one_active_zee_per_xell
CREATE UNIQUE INDEX IF NOT EXISTS one_active_zee_per_medic ON zee (medic_id)
  WHERE status IN ('spawning','online','working','idle') AND medic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS zee_medic_idx ON zee (medic_id);

-- The conversation store: same relaxation, same exactly-one-of.
ALTER TABLE zee_conversation ALTER COLUMN xell_id DROP NOT NULL;
ALTER TABLE zee_conversation ADD COLUMN IF NOT EXISTS medic_id uuid REFERENCES medic(id) ON DELETE CASCADE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zee_conversation_exactly_one_plane') THEN
    ALTER TABLE zee_conversation ADD CONSTRAINT zee_conversation_exactly_one_plane
      CHECK ((xell_id IS NOT NULL)::int + (medic_id IS NOT NULL)::int = 1);
  END IF;
END $$;

-- Replay order per medic — the mirror of zee_conversation's UNIQUE (xell_id, seq).
CREATE UNIQUE INDEX IF NOT EXISTS zee_conversation_medic_seq_uq
  ON zee_conversation (medic_id, seq) WHERE medic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS zee_conversation_medic_idx ON zee_conversation (medic_id, seq);
