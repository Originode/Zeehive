-- A2A MEET — peer-to-peer GROUP CHAT rooms for zees (docs/zee-meet-plan.md, DR-1..DR-4).
--
-- The human directive: "i want agents to be able to talk to each other via some sort of peer to
-- peer a2a chat session like a group chat via a zee meet verb… zees can join and talk."
--
-- The A2A plane (zee_message + meta.a2a, DR-3) is deliberately NOT the home for a group room:
-- a room has facts that do not fit the (from,to) message shape — a membership SET, a founder, a
-- code, a closed state — and a fan-out of N zee_message rows per post (DR-1 rejected) would make
-- the durable record N private copies of one message. So a meet is a first-class, small, durable
-- store of three tables:
--
--   a2a_meet           the room: identity (id), project scope, title, founder, open/closed.
--   a2a_meet_member    who may read and post; role founder/member; when they joined. This row is
--                      the AUDIT of "attended" — self-serve by code, recorded (DR-2). PK is
--                      (meet_id, xell_id) so one seat attends once. A reaped xell drops out by
--                      ON DELETE CASCADE on xell — "leaving" happens for free (DR-4).
--   a2a_meet_message   the transcript: every post, in order, attributed to a member xell. The
--                      row is authoritative; delivery is a best-effort fan-out of notifications
--                      through the existing sendMessageToXell machinery (DR-3) — never a second
--                      record that can lie.
--
-- The code a zee hands to another is DERIVED, never stored (house rule 7): <slug>/<token> where
-- slug = the founder's xell slug truncated to ~12 chars and token = the last 6 hex chars of the
-- room's uuid id. A room is project-scoped (DR-2): only that project's zees may attend.
--
-- leave/close and "room as A2A Task" are named seams (DR-4), not built: closed_at is the column
-- the close seam would set; the deterministic conversationTaskId('a2a_meet', meet_id) projection
-- reuses the DR-8 machinery when a peer asks for it. A room dies with its project (ON DELETE
-- CASCADE on project).
--
-- Idempotent, additive, forward-only — the same contract as every migration in this folder.
CREATE TABLE IF NOT EXISTS a2a_meet (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  slug            text NOT NULL,                    -- founder xell slug, truncated (~12 chars) — the code's hint
  title           text NOT NULL,
  founder_xell_id uuid REFERENCES xell(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz                       -- null while open (the DR-4 close seam)
);

CREATE TABLE IF NOT EXISTS a2a_meet_member (
  meet_id       uuid NOT NULL REFERENCES a2a_meet(id) ON DELETE CASCADE,
  xell_id       uuid NOT NULL REFERENCES xell(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('founder','member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_read_at  timestamptz,                        -- per-member read watermark for the unread hint
  PRIMARY KEY (meet_id, xell_id)
);

CREATE TABLE IF NOT EXISTS a2a_meet_message (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meet_id      uuid NOT NULL REFERENCES a2a_meet(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  from_xell_id uuid REFERENCES xell(id) ON DELETE SET NULL,
  from_slug    text,                                -- the poster's slug at post time
  body         text NOT NULL,
  kind         text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','meet-note')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS a2a_meet_member_meet_idx  ON a2a_meet_member (meet_id);
CREATE INDEX IF NOT EXISTS a2a_meet_member_xell_idx  ON a2a_meet_member (xell_id);
CREATE INDEX IF NOT EXISTS a2a_meet_message_meet_idx ON a2a_meet_message (meet_id, created_at);
CREATE INDEX IF NOT EXISTS a2a_meet_message_proj_idx ON a2a_meet_message (project_id, created_at);
