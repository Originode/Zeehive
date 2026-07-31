-- PROJECT ENTRY-POINT DOCS — the AGENTS.md/CLAUDE.md a zee reads first, owned by the meta-DB.
--
-- A cxell zee opens the project's entry-point markdown before it designs anything; that file is how
-- a repo tells an agent how it actually works. Until now the only such file was whatever happened to
-- be committed in the repo, which means: nothing for a project that has not written one, no way for
-- an operator to give a fleet-wide instruction without a commit, and a different answer for every
-- provider's filename convention (AGENTS.md, CLAUDE.md, …).
--
-- So the same rule the harnesses just moved to (080): the meta-DB is the source, and the queenzee
-- GENERATES the file into the xell when a zee is assigned. One table, one row per file per project.
--
-- WHAT IT IS NOT: a way to rewrite the repo. The injector REFUSES to overwrite a git-TRACKED path
-- (lib/project-docs.js) — a generated file landing on top of a committed CLAUDE.md would dirty every
-- xell's tree, put a file nobody wrote into a landing diff, and quietly replace the project's own
-- instructions. Untracked is the whole contract: the file is an artefact of the xell, git-excluded
-- like the harness files beside it, and a project that HAS committed its own entry point keeps it.
CREATE TABLE IF NOT EXISTS project_doc (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  -- where it lands in the xell, repo-relative ('AGENTS.md', 'docs/agents/ONBOARDING.md'). Validated
  -- in lib/project-docs.js: relative, no '..', .md only, and never under .zeehive/ or .git/.
  rel_path    text NOT NULL,
  title       text,                                  -- what the console calls it; cosmetic
  body        text NOT NULL DEFAULT '',
  enabled     boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per path per project, case-insensitively: AGENTS.md and agents.md are the same file on the
-- filesystems this lands on, and two rows claiming it would make the winner an accident of ordering.
CREATE UNIQUE INDEX IF NOT EXISTS project_doc_path_uniq ON project_doc (project_id, lower(rel_path));
CREATE INDEX IF NOT EXISTS project_doc_project_idx ON project_doc (project_id, sort, rel_path);

COMMENT ON TABLE project_doc IS
  'Per-project entry-point markdown (AGENTS.md / CLAUDE.md …) owned by the meta-DB and GENERATED into '
  'each xell when a zee is assigned. Never written over a git-tracked path.';
