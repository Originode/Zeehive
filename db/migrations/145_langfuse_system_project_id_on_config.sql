-- LANGFUSE SYSTEM PROJECT ID — the "View Langfuse" session link must resolve from stored
-- state, not a live credentialed API call (TKT-127-E85F).
--
-- GET /api/xells/<id>/langfuse-session builds the link as ui_url + the Langfuse project +
-- the zee's session id → /project/<lfProjectId>/sessions/<id>. For a xell whose project has
-- no 1:1 mapping (langfuse_project_map — empty in production), the session lives in the SYSTEM
-- trace project: the one provisioned via LANGFUSE_INIT_PROJECT_ID ('zeehive'), whose keys are
-- langfuse_config.public_key/secret_key. Its Langfuse id is only defined authoritatively by the
-- public API (GET /api/public/projects with the trace project keys returns the single project
-- those keys scope). Until this migration the resolver called that endpoint LIVE on every
-- request, so any failure — instance down, keys rotated, slow network — closed the door
-- fleet-wide with a reason no human could act on.
--
-- This migration adds the stored home for that id: system_project_id on langfuse_config.
-- lib/langfuse.js writes it when the stack comes up after provision, refreshes it in the
-- existing project sync (syncLangfuseProjects), and — for an instance provisioned before this
-- column existed — writes it back from xellLangfuseSession's own live read. The live read
-- stays only as a last-resort fallback.
--
-- NOT a credential: it has no *_hint sibling and stays readable by the prod RO role (like
-- admin_email / org_name), so prod-readonly.js needs no new secret entry.

ALTER TABLE langfuse_config ADD COLUMN IF NOT EXISTS system_project_id text;

COMMENT ON COLUMN langfuse_config.system_project_id IS
  'The Langfuse id of the system trace project (the one every unmapped trace lands in), learned '
  'from GET /api/public/projects with the trace project keys and stored so the "View Langfuse" '
  'session link needs no live credentialed call. NOT a credential; written when the stack comes '
  'up after provision, refreshed by syncLangfuseProjects, and written back by xellLangfuseSession '
  'when it learns the id live.';
