-- A REVIEW RECORD — the first-class fact that a landed diff was READ, by whom, and what was found.
--
-- The gap (ticket #56): a reviewer cast on a landed diff found a cross-project write hole and a
-- mass-assignment path within the hour, and the system recorded NEITHER the review NOR its findings.
-- `land_request` knows who approved the PUSH, never whether anyone READ the diff; the ship card says
-- what commit ships, never who has looked at it. This table is that missing fact, tied to the thing
-- it is about: a commit sha.
--
-- DELIBERATELY NOT A GATE. Recording a review must never slow or block the landing path — this is a
-- plain INSERT a reviewer makes after reading, and nothing on the land/ship gate consults it. The
-- future TKT-79 ("a ship may auto-approve only if the commits it carries have been read") will read
-- THIS table, but that gate is not built here.
--
-- `verdict` is its own enum (clean / changes_required) because it will be filtered and aggregated,
-- not just displayed. `findings_count` is the number of concrete findings the reviewer wrote down;
-- `report` is the text. `reviewer` is denormalized to the reviewing xell's slug so the record
-- survives the reviewer being reaped (the same reason land_request carries xell_slug).
--
-- A review is tied to a COMMIT, not to a request: `commit_sha` is the full 40-char sha a reviewer
-- read. Landing and ship cards join reviews on that sha (land_request.new_sha, ship_request.commit).
-- One review per reviewer per commit is NOT enforced — a reviewer that re-reads after a fix and
-- wants to record the new verdict may, and the read models show the newest first.
CREATE TYPE review_verdict AS ENUM ('clean','changes_required');

CREATE TABLE review (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  xell_id         uuid REFERENCES xell ON DELETE SET NULL,      -- the reviewing xell
  zee_id          uuid REFERENCES zee ON DELETE SET NULL,       -- the reviewing zee row, when live
  reviewer        text NOT NULL,                                -- the reviewer's slug, denormalized
  commit_sha      text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  verdict         review_verdict NOT NULL DEFAULT 'clean',
  findings_count  int NOT NULL DEFAULT 0 CHECK (findings_count >= 0),
  report          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_commit_idx ON review (commit_sha);
CREATE INDEX review_xell_idx   ON review (xell_id);
