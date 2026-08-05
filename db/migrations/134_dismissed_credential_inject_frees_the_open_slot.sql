-- CREDENTIAL-INJECT: a DISMISSED request must not hold the one-open slot.
--
-- The two one-open-uniqueness indexes from 132 are partial on `status='pending'` only. A request
-- that is dismissed while still 'pending' keeps matching that partial predicate, so it keeps
-- occupying the slot: the next real rotation of the same (project, provider) — or the next auth
-- death of the same (xell, provider) — finds "an open request already exists" and is handed back
-- the INVISIBLE dismissed card, never raising a fresh one a human can see.
--
-- Dismiss is deliberately NEVER a decision (the xource-clean distinction): the row stays
-- 'pending' and a dismissed_at is stamped, so history still reads "seen it, not decided". What
-- must change is that a dismissed row stops being "the open request". Adding `dismissed_at IS
-- NULL` to the partial predicate does exactly that, with no status rewrite.
DROP INDEX IF EXISTS credential_inject_open_rotation_uq;
CREATE UNIQUE INDEX credential_inject_open_rotation_uq
  ON credential_inject_request (project_id, provider)
  WHERE status = 'pending' AND kind = 'rotation' AND dismissed_at IS NULL;

DROP INDEX IF EXISTS credential_inject_open_xell_uq;
CREATE UNIQUE INDEX credential_inject_open_xell_uq
  ON credential_inject_request (xell_id, provider)
  WHERE status = 'pending' AND kind = 'auth-death' AND dismissed_at IS NULL;
