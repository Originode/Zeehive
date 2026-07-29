-- THE DEV CREW — one shared craft layer plus eight role harnesses, for ANY project.
--
-- Until now the only worker persona a project could dispatch was Zee Base (the cxell manual and
-- nothing else) or a Zeehive-specific one. That makes every worker a generalist: it knows how to
-- talk to the queenzee and nothing about how to do the KIND of work it was handed. The dev crew is
-- the missing layer — eight role-specialised personas that map onto the AI-native SDLC (spec →
-- plan → tasks → implement, test-as-spec, a critic pass, repro-first debugging, docs-as-context,
-- gated release) and carry NO project lore, so they are dispatchable on any repo.
--
-- THE CHAIN (and why it has exactly three links):
--
--   zee-base  →  dev-base  →  dev-<role>
--   (DB-owned;    (the shared    (only the judgement
--    the manual)   craft layer)   that is that role's own)
--
-- `dev-base` exists so the shared half is paid for ONCE. effectiveHarness() merges the chain root →
-- leaf and harnessLayerText() INLINES personality + every skill body + every memory file into the
-- briefing, so a line written into all eight roles is a line every wearer pays for and the crew
-- pays for eight times. Hence the budgets, enforced by test/dev-crew.test.mjs: the roles carry NO
-- memory files at all, a short personality and at most two small skills; anything shared belongs in
-- dev-base. And the cxell manual is INHERITED from zee-base — never copied, never restated. See
-- docs/dev-crew.md.
--
-- These rows are the file-backed pattern of 046: key + label + dir, empty bundle. Boot's
-- refreshHarnesses() reads harnesses/<key>/ and fills bundle/hash/head_commit/avatar — and resolves
-- parent_id from each HARNESS.yml's `parent:` key, which is why NO parent link is set here. Nothing
-- in this migration touches harness.bundle, so it cannot rebuild (and thereby delete) a memory
-- array — see test/harness-memory-migrations.test.mjs.
--
-- zee_type is 'worker' for all nine: these personas land code, which a manager never does.
INSERT INTO harness (key, label, dir, zee_type, enabled) VALUES
  ('dev-base',       'Dev Base',   'harnesses/dev-base',       'worker', true),
  ('dev-scout',      'Scout',      'harnesses/dev-scout',      'worker', true),
  ('dev-architect',  'Architect',  'harnesses/dev-architect',  'worker', true),
  ('dev-builder',    'Builder',    'harnesses/dev-builder',    'worker', true),
  ('dev-tester',     'Test Wright','harnesses/dev-tester',     'worker', true),
  ('dev-reviewer',   'Reviewer',   'harnesses/dev-reviewer',   'worker', true),
  ('dev-fixer',      'Fixer',      'harnesses/dev-fixer',      'worker', true),
  ('dev-scribe',     'Scribe',     'harnesses/dev-scribe',     'worker', true),
  ('dev-shipwright', 'Shipwright', 'harnesses/dev-shipwright', 'worker', true)
ON CONFLICT (key) DO NOTHING;
