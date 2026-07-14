-- Per-container build tracking + session title on the zee.
ALTER TABLE container
  ADD COLUMN IF NOT EXISTS last_build_commit text,
  ADD COLUMN IF NOT EXISTS last_built_at   timestamptz,
  ADD COLUMN IF NOT EXISTS hot_build       boolean NOT NULL DEFAULT false;

-- The human-readable session title as the AI provider shows it (Claude Code / Codex / …).
ALTER TABLE zee
  ADD COLUMN IF NOT EXISTS title text;
