-- PERSIST A CLASSIFIED BUILD FAILURE — ticket "make zee build return actionable failures".
--
-- THE DEFECT: a failed build persisted last_build_error (ticket #173) but with NO classification,
-- so `zee build --wait` told a zee "the build FAILED" and printed the raw docker tail — it could
-- not say whether retrying would EVER help. The mardale-prod incident (ticket #178) was a docker
-- address-pool exhaustion: the zee's image built fine, the HOST could not create a network, and
-- the zee retried 40 times because nothing told it the failure was not its code.
--
-- THE FIX: classify each persisted failure as
--     INFRA  → host/daemon/network/context (NOT the zee's code — retrying will not help)
--     CODE   → traces to the worktree (compile/test/compose — the error is the actionable part)
-- and store the class beside the error. PROD-SHIP is a REFUSAL, not a persisted class: a
-- production-tier container refuses `zee build` at the gate (the build never runs), so there is no
-- failure to classify on the row. The classifier lives in lib/build.js (classifyBuildFailure);
-- this column is where its answer lands.
ALTER TABLE container
  ADD COLUMN IF NOT EXISTS last_build_error_class text;

COMMENT ON COLUMN container.last_build_error_class IS
  'Classified cause of the most recent failed build (INFRA | CODE), computed by lib/build.js classifyBuildFailure. INFRA = host/daemon/network/context — NOT the zee''s code, retrying will not help; CODE = a build error that traces to the worktree (compile/test/compose). NULL = never failed, last build succeeded, or the failure was not classified. PROD-SHIP is a refusal at the build gate, never a persisted class.';
