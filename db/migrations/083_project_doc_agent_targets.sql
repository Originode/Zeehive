-- ONE SOURCE OF TRUTH, ONE FILE PER AI PROVIDER — project_doc stops being "a file" and becomes
-- "the contents", with the FILENAMES resolved from a registry in code (lib/agent-docs.js).
--
-- 081 gave a project rows shaped like files: one row per PATH, each with its own body. That is the
-- wrong grain. A project's agent-facing instructions are ONE piece of writing; what differs per tool
-- is only the filename it opens — CLAUDE.md (Claude Code), AGENTS.md (Codex, Cursor, Gemini CLI,
-- Copilot's coding agent, Zed, Aider, goose, opencode, Junie, Roo, Warp, …), GEMINI.md (Gemini CLI),
-- .github/copilot-instructions.md (Copilot), .cursor/rules/*.mdc (Cursor), and so on. Row-per-path
-- meant an operator pasted the same text into each one and they drifted apart at the first edit.
--
-- So: `targets` names WHICH provider files to generate from this row's body, and the queenzee writes
-- one file per target — each stamped as generated, each carrying that xell's own stack inventory
-- (lib/xell-stack.js), none of them ever written over a path the project itself has committed.
--
-- rel_path survives as the ESCAPE HATCH, and becomes NULLable: a row with targets generates the
-- registry's paths, a row with a rel_path and no targets generates exactly that one custom file
-- (docs/agents/ONBOARDING.md and the like). The two modes are mutually exclusive, enforced in
-- lib/project-docs.js where the reason can be said in words.
ALTER TABLE project_doc ADD COLUMN IF NOT EXISTS targets text[] NOT NULL DEFAULT '{}';
ALTER TABLE project_doc ALTER COLUMN rel_path DROP NOT NULL;

COMMENT ON COLUMN project_doc.body IS
  'THE SOURCE OF TRUTH: the project''s agent-facing instructions, written once. Every file in '
  '`targets` is generated from this text.';
COMMENT ON COLUMN project_doc.targets IS
  'Agent doc target keys (lib/agent-docs.js AGENT_DOC_TARGETS) — which provider entry-point files to '
  'generate from `body`. Empty means this row is a single custom file at `rel_path`.';
COMMENT ON COLUMN project_doc.rel_path IS
  'Custom path for a one-off doc, used ONLY when `targets` is empty. NULL for a normal source row: '
  'its paths come from the target registry, not from the operator.';

-- Existing rows land on the target whose convention they were already imitating, so an operator who
-- wrote AGENTS.md before this migration keeps exactly the file they had — now as a source that can
-- also emit CLAUDE.md with one checkbox. A path nobody recognises stays a custom-path row, untouched:
-- guessing a target for docs/agents/ONBOARDING.md would silently MOVE somebody's file.
--
-- lower(rel_path) is how 081's unique index compares paths, so it is how they are matched here.
-- Setting rel_path to NULL cannot collide: NULLs are distinct in a unique index, so a project that
-- had both AGENTS.md and CLAUDE.md ends up with two independent source rows (their bodies may differ
-- — merging them is an editorial decision, not a migration's).
UPDATE project_doc SET targets = ARRAY['agents'],  rel_path = NULL
  WHERE targets = '{}' AND lower(rel_path) = 'agents.md';
UPDATE project_doc SET targets = ARRAY['claude'],  rel_path = NULL
  WHERE targets = '{}' AND lower(rel_path) = 'claude.md';
UPDATE project_doc SET targets = ARRAY['gemini'],  rel_path = NULL
  WHERE targets = '{}' AND lower(rel_path) = 'gemini.md';
UPDATE project_doc SET targets = ARRAY['copilot'], rel_path = NULL
  WHERE targets = '{}' AND lower(rel_path) = '.github/copilot-instructions.md';

-- A row must be one thing or the other: some targets, or a path. Neither is a row that generates
-- nothing at all — which is how an instruction an operator wrote reaches nobody, in silence.
ALTER TABLE project_doc DROP CONSTRAINT IF EXISTS project_doc_targets_or_path;
ALTER TABLE project_doc ADD CONSTRAINT project_doc_targets_or_path
  CHECK (array_length(targets, 1) > 0 OR rel_path IS NOT NULL);
