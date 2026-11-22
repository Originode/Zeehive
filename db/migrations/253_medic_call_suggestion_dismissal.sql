-- A HUMAN CAN SAY NO to a ⛑ medic dispatch ask (the dismiss card). The console asks a human to
-- dispatch the medic in three places and, before this migration, every one of them was
-- dispatch-or-nothing: the red chip nagged until the underlying fault changed. A human who is
-- already fixing the fault by hand, or who judges the ask not a medic job, now has a way to say so
-- that is honest about WHO is being dismissed:
--
--   1. medic_call gains dismissed_at / dismissed_by — the HUMAN's decline of a CALLED emergency.
--      Dismissing a call DECLINES it (status 'declined'); the note is REQUIRED and is POSTED BACK
--      to the calling zee as a message — the SAME contract answerMedicCall already enforces for a
--      medic's own 'declined' decision. A declined call is final history, exactly like a medic
--      decline (there is no UNDO for a decision the calling zee already saw); a still-blocked zee
--      raises a FRESH call.
--
--   2. a NEW table medic_dismissal persists the dismissal of the ROWLESS suggestions — the
--      infra-derived emergency rows (fleet.js: a failing db preflight / failing provision proof /
--      an INFRA-classed build failure on a live zee's xell) and the condition dispatch cards. A
--      rowless suggestion is recomputed from live evidence every fleet snapshot, so its dismissal
--      is fingerprinted on the EXACT text the human was shown: the SAME fault stops nagging, but a
--      DIFFERENT fault on the same xell — or an edited condition body — raises again by itself. No
--      timers; the dismissal expires by fingerprint mismatch alone. `display` stores the shown text
--      so the console's "N dismissed" line can render an UNDO that restores exactly what was hidden.
--
-- This is a HUMAN's verb on the owner pool. The medic role gets NO write grant here: medic_call is
-- already on the medic no-write list (migration 252 removed the table grant — the role's only door
-- to a call row is the row-scoped calls/call_answer tools), and medic_dismissal is a human-dismissal
-- receipt the medic must never trim (medic-role.js MEDIC_NO_WRITE_TABLES gains it in code).
--
-- Idempotent, additive, forward-only.

CREATE TABLE IF NOT EXISTS medic_dismissal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  target_kind   text NOT NULL CHECK (target_kind IN ('xell','condition')),
  target_id     uuid NOT NULL,          -- xell.id (an infra emergency row) or project_condition.id
  fingerprint   text NOT NULL,          -- sha256 hex of the exact shown text (the expiry)
  display       text NOT NULL,          -- the text the human was shown (the UNDO line's label)
  reason        text,                   -- optional human note ("fixing by hand", "not a medic job")
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  dismissed_by  text NOT NULL DEFAULT 'human@console',
  UNIQUE (project_id, target_kind, target_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS medic_dismissal_project_idx
  ON medic_dismissal (project_id, dismissed_at DESC);

-- The human's decline of a CALLED emergency: the call row carries WHO dismissed it and when, so the
-- console (and the Medic Bay) can tell a human decline from a medic's own decline or the zee's
-- withdraw without joining anything.
ALTER TABLE medic_call ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
ALTER TABLE medic_call ADD COLUMN IF NOT EXISTS dismissed_by text;
