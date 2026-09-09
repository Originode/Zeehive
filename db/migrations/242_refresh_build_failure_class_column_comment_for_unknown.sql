-- REFRESH container.last_build_error_class's COMMENT for the UNKNOWN class — comment-only.
--
-- Migration 233 documented the column as "(INFRA | CODE)". The build-failure classifier (build.js)
-- now also stores UNKNOWN (the fail-safe: an error nobody matched is never guessed CODE, because a
-- false "your worktree" sent the mardale-prod worker hunting a bug it did not write — the exact
-- harm this ticket exists to stop). A column whose domain grew must not keep a COMMENT that denies
-- the new value — schema self-documentation that lies is worse than none. The column is TEXT, so
-- no type/constraint change is needed; this is the comment catching up to the code (landed fb12715).
COMMENT ON COLUMN container.last_build_error_class IS
  'Classified cause of the most recent failed build (INFRA | CODE | UNKNOWN), computed by lib/build.js classifyBuildFailure. INFRA = host/daemon/network/context — NOT the zee''s code, retrying will not help; CODE = an error that CONFIDENTLY traces to the worktree (compile/test/compose); UNKNOWN = the classifier could not tell — never guessed CODE, the raw stderr is the evidence. NULL = never failed, last build succeeded, or the failure was not classified. PROD-SHIP is a refusal at the build gate, never a persisted class.';
