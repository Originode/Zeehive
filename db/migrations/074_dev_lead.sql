-- DEV-LEAD ("Crew Lead") — the manager harness that runs the dev crew.
--
-- The crew (073) is eight WORKER roles under `dev-base`. This is the one MANAGER-type harness that
-- goes with them, and it adds exactly one thing to `manager`: the roster of those roles and the
-- judgement of which role a piece of work needs. Everything else — the manager manual, the
-- dispatch-brief skill, the refusals — is INHERITED, not copied: `parent: manager` in the folder's
-- HARNESS.yml, resolved to parent_id by refreshHarnesses() at boot, merged root→leaf by
-- effectiveHarness(). A copy would be a second manager manual rotting on its own schedule.
--
-- zee_type stays 'manager' for two reasons, one of which is structural: a lead dispatches and lands
-- nothing (it is a manager by behaviour), and 054's harness_type_guard refuses cross-type
-- inheritance anyway — a worker-typed harness could not name `manager` as its parent.
--
-- This is a ROW, nothing more. The bundle (personality, the pick-the-role skill, the roster memory)
-- is read from harnesses/dev-lead/ by refreshHarnesses(); the repo is truth and this row is only the
-- anchor, exactly as 044/046/052 seed theirs. No schema change, no harness memory array touched, no
-- existing harness row edited.
INSERT INTO harness (key, label, dir, zee_type, is_law_core, enabled)
VALUES ('dev-lead', 'Crew Lead', 'harnesses/dev-lead', 'manager', false, true)
ON CONFLICT (key) DO NOTHING;
