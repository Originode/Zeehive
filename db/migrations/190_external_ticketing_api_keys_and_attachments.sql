-- EXTERNAL TICKETING API — a deployed project files, monitors and updates its OWN tickets.
--
-- Until now a ticket could only be born inside ZEEHIVE: the console's tickets window, a manager's
-- `zee ticket`, or a reflection filed as one. Everything a DEPLOYED project knows — the exception
-- its users hit, the log its helpdesk collected, the screenshot somebody pasted — had to be
-- retyped by a human before a zee could work on it. This migration is the door: an onboarded
-- project (omnibiz, say) holds a KEY, calls /api/ext/v1/tickets, and its ticket lands on exactly
-- the board its zees already read. Nothing new is invented — the ticket is the SAME `ticket` row
-- the console shows, so breakdown, assignment and the whole work tracker apply unchanged.
--
-- Three pieces:
--
--   project_api_key   — the credential. Per PROJECT (never per xell, never global): a key names
--                       the project whose tickets it may touch, and that scoping is what makes
--                       "omnibiz cannot file into another project" true by construction rather
--                       than by a check somebody has to remember. Hash only, exactly like
--                       xell.self_token_hash (lib/xell-token.js): the plaintext leaves the server
--                       ONCE, at mint, and no read model can ever return it again. `key_hash` is
--                       a sha256 of 32 random bytes — it is not a credential and has no `_hint`
--                       sibling, so it stays readable to the SELECT-only prod roles (143); the
--                       masked `key_hint` is what a console renders.
--
--   ticket provenance — WHERE a ticket came from, and the caller's OWN id for it. `external_ref`
--                       is what makes a retry idempotent: a helpdesk that POSTs the same ref twice
--                       (network timeout, at-least-once queue) gets the SAME ticket back instead
--                       of a duplicate. Unique per PROJECT, partial (NULL refs are unconstrained),
--                       so a console-filed ticket is unaffected.
--
--   ticket_attachment — the evidence. Images and text logs (json/txt/xml/csv/yaml/har), stored as
--                       bytea in the meta-DB rather than on a filesystem: this fleet's meta-DB is
--                       the thing that is backed up, replicated and reachable from every container,
--                       and a path on one host's disk is exactly the sort of fact house rule 7
--                       forbids. Attachments are small by contract (the API caps one at 10 MB and
--                       a ticket at 50 MB); anything bigger belongs behind a URL in the body.
--
-- FORWARD-ONLY and re-runnable: CREATE TABLE / ADD COLUMN IF NOT EXISTS throughout, so a second
-- migrate pass is a clean no-op. The DOWN thinking (never run in prod): DROP TABLE
-- ticket_attachment, DROP TABLE project_api_key, then drop the three ticket columns. Nothing
-- existing reads any of it, so the migration is inert on a database where no key has been minted.

-- ── the credential ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_api_key (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  label        text NOT NULL,                       -- what a human calls it: 'omnibiz helpdesk'
  key_hash     text NOT NULL UNIQUE,                -- sha256(plaintext). The plaintext is never stored.
  key_hint     text NOT NULL,                       -- masked form for read models: zhk_ab12…7f9c
  -- What this key may do. 'tickets:read' = list/get; 'tickets:write' = create/update/comment/attach.
  -- An array rather than a boolean because the next scope (say 'work:read') must not need a column.
  scopes       text[] NOT NULL DEFAULT '{tickets:read,tickets:write}',
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,                         -- stamped on every accepted call — a dead
  last_seen_ip text,                                -- integration is then visible in the console
  revoked_at   timestamptz,                         -- revoked, never deleted: the tickets it filed
  revoked_by   text                                 -- keep pointing at a row that says who filed them
);

CREATE INDEX IF NOT EXISTS project_api_key_project_idx ON project_api_key (project_id, created_at DESC);

COMMENT ON TABLE project_api_key IS
  'External ticketing API credential, per project. sha256 hash only; the plaintext leaves the server once, at mint.';
COMMENT ON COLUMN project_api_key.scopes IS
  'What the key may do: tickets:read (list/get) and/or tickets:write (create/update/comment/attach).';

-- ── where a ticket came from ─────────────────────────────────────────────────
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS source       text;
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS external_url text;
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS api_key_id   uuid REFERENCES project_api_key(id) ON DELETE SET NULL;

-- IDEMPOTENCY: one external_ref names one ticket in one project. A caller that retries a POST it
-- never saw the answer to gets its ticket back, not a second one.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_external_ref_uniq
  ON ticket (project_id, external_ref) WHERE external_ref IS NOT NULL;

COMMENT ON COLUMN ticket.source IS
  'Where the ticket came from: null/console for a human, api:<key label> for the external ticketing API.';
COMMENT ON COLUMN ticket.external_ref IS
  'The CALLER''s own id for this ticket (its helpdesk row id). Unique per project; a repeat POST is idempotent.';
COMMENT ON COLUMN ticket.external_url IS
  'A link back into the system that filed it, so a human reading the board can open the original.';

-- ── the evidence ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_attachment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES ticket ON DELETE CASCADE,
  -- an attachment may hang off a COMMENT (the log somebody added on the third reply) rather than
  -- off the ticket itself. ON DELETE SET NULL: deleting a comment must not destroy its evidence.
  comment_id   uuid REFERENCES ticket_comment ON DELETE SET NULL,
  filename     text NOT NULL,
  content_type text NOT NULL,
  -- 'image' | 'log' | 'data' | 'file' — the coarse class a UI renders by, derived from the content
  -- type at upload (lib/ticket-attachments.js owns the mapping) and stored so a reader never has to.
  kind         text NOT NULL,
  size_bytes   int  NOT NULL CHECK (size_bytes > 0),
  sha256       text NOT NULL,                       -- integrity, and a caller can dedupe on it
  content      bytea NOT NULL,
  uploaded_by  text,
  source       text,                                -- 'api:<label>' | 'console'
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_attachment_ticket_idx ON ticket_attachment (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_attachment_comment_idx ON ticket_attachment (comment_id)
  WHERE comment_id IS NOT NULL;

COMMENT ON TABLE ticket_attachment IS
  'Supporting evidence on a ticket: images and text logs (json/txt/xml/csv/yaml/har), stored in the meta-DB as bytea.';
COMMENT ON COLUMN ticket_attachment.kind IS
  'Coarse class for rendering: image | log | data | file. Derived from content_type at upload.';
