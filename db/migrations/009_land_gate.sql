-- LANDING GATE — a push to the xource's main is a REQUEST, not an action.
--
-- Until now "land locally: git push . HEAD:main" was only an INSTRUCTION in the skill/intake
-- prompt. Nothing enforced it and nothing announced it, so a zee could (and did) put commits on
-- main with no human ever seeing them. The queenzee can't police this from the outside — by the
-- time the poller notices, main has already moved.
--
-- So the gate lives in git itself: an `update` hook on the xource (see hooks/land-gate-update.sh)
-- fires on every push to main, asks the API, and DECLINES unless a human already approved this
-- exact new sha. The model cannot skip it — same reasoning as the harness hooks: enforcement
-- belongs where the action happens, not where we hope the agent will ask.
--
-- One row per (ref, new_sha) attempt. Approval is bound to the EXACT sha the human reviewed:
-- a new commit is new content, so it needs a new decision. Re-pushing the same sha after an
-- approval is the intended "zee retries the push" flow.
CREATE TYPE land_status AS ENUM ('pending','approved','rejected','landed');

CREATE TABLE land_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  xell_id      uuid REFERENCES xell ON DELETE SET NULL,   -- resolved by sha; null if unmatched
  ref          text NOT NULL,                             -- refs/heads/<main_branch>
  old_sha      text,                                      -- null-ish/zeroes on ref creation
  new_sha      text NOT NULL,
  status       land_status NOT NULL DEFAULT 'pending',
  commits      jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{short,subject,author}] old..new
  stat         jsonb,                                     -- {ahead,files,insertions,deletions}
  attempts     int NOT NULL DEFAULT 1,                    -- pushes seen for this sha
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   text,                                      -- who approved/rejected (human)
  landed_at    timestamptz,
  note         text,
  -- IMPOSSIBILITY: a decision without a decider, or a landing that was never approved.
  CONSTRAINT land_decided_has_decider CHECK (
    (status IN ('pending')) OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)
  )
);

-- At most ONE open request per (project, ref, sha) — a retrying zee bumps `attempts` on the
-- existing row instead of spamming the console with duplicates. Decided rows stay as history.
CREATE UNIQUE INDEX land_request_open_uq
  ON land_request (project_id, ref, new_sha)
  WHERE status IN ('pending','approved');

CREATE INDEX land_request_pending_idx ON land_request (project_id, requested_at DESC)
  WHERE status = 'pending';
