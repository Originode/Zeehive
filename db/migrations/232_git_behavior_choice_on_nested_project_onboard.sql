-- GIT BEHAVIOR ON A NESTED PROJECT ONBOARD.
--
-- Onboarding a NEW project INSIDE another project's tree (a monorepo sub-project) is a different
-- act from a top-level onboarding: the new repo_root lives inside a parent's repo, so the human
-- must say HOW the nested repo joins the parent's git — as a git submodule, as a subtree, or not
-- at all ("just use the main repo", no nested git). This migration records that choice on the
-- project row so the nesting is self-describing long after the onboarding dialog is gone.
--
-- Top-level projects have no parent repo, so git_behavior is NULL for them; the console only
-- offers the choice (and the server only accepts it) for a project created inside another one.
ALTER TABLE project ADD COLUMN IF NOT EXISTS git_behavior text;
ALTER TABLE project DROP CONSTRAINT IF EXISTS project_git_behavior_check;
ALTER TABLE project ADD CONSTRAINT project_git_behavior_check
  CHECK (git_behavior IS NULL OR git_behavior IN ('submodule', 'subtree', 'main_repo'));
