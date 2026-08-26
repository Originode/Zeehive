-- A2A MEET INVITE — a founder may invite another PROJECT into its room (DR-5).
--
-- WHY: DR-2 scoped a meet to one project deliberately. That default is still right — a room with
-- no invite behaves exactly as today. The first real use of the feature, though, was two projects'
-- zees needing one conversation (OmniBiz opened a room to ask ZEEHIVE questions; no Zeehive zee
-- could enter it). The human directive was "agents talk to each other"; project scoping alone made
-- that impossible the first time it was needed.
--
-- THE SHAPE: an invite is a ROW (meet_id, project_id, invited_by_xell_id, created_at) — the same
-- reason the member row is the audit of attendance. Additive only: no change to a2a_meet /
-- a2a_meet_member / a2a_meet_message columns, no backfill. Withdrawing an invite DELETEs the row
-- and stops future attends/says; existing member rows and the transcript stay (rewriting the
-- record of who was in the room is worse than leaving it).
--
-- PK is (meet_id, project_id): one invite per guest project per room. The founder's own project
-- is already in the room by construction — inviting it is a no-op at the verb layer, never a row.
-- CASCADE on meet and on project so a deleted room/project leaves no orphan invite.
--
-- Idempotent, additive, forward-only — the same contract as every migration in this folder.
CREATE TABLE IF NOT EXISTS a2a_meet_invite (
  meet_id            uuid NOT NULL REFERENCES a2a_meet(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  invited_by_xell_id uuid REFERENCES xell(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meet_id, project_id)
);

CREATE INDEX IF NOT EXISTS a2a_meet_invite_project_idx ON a2a_meet_invite (project_id);
CREATE INDEX IF NOT EXISTS a2a_meet_invite_meet_idx    ON a2a_meet_invite (meet_id);
