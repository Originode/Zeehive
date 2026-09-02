-- THE MEDIC-PLANE KNOB — the dispatch seam's way back (docs/medic-meta-plane-plan.md §6, DR-7).
--
-- POST /project-conditions/:id/dispatch-medic reads this per-project knob to decide WHAT the ⛑
-- button creates:
--
--   'meta'         (default) — a medic row + an in-process meta-plane turn (queenzee/medic-spawn.js):
--                   no xell claim, no cage, no containers. The corrected model.
--   'manager-zee'  — the superseded stage-3 path (createManagerZee on the orchestrator's own
--                   project), kept callable so the cutover is one flip away from restored. It is
--                   the ROLLBACK, not an alternative to keep alive: the follow-up that removes the
--                   cage-side medic surface retires this value with it.
--
-- On the PROJECT (not pool_config): this is dispatch policy, not pool behaviour — the same shelf
-- as auto_approve_land/ship. The CHECK keeps a typo from inventing a third plane.
ALTER TABLE project
  ADD COLUMN IF NOT EXISTS medic_plane text NOT NULL DEFAULT 'meta';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_medic_plane_check') THEN
    ALTER TABLE project ADD CONSTRAINT project_medic_plane_check
      CHECK (medic_plane IN ('meta', 'manager-zee'));
  END IF;
END $$;

COMMENT ON COLUMN project.medic_plane IS
  'What the ⛑ dispatch-medic button creates for conditions of THIS project: ''meta'' (default) = an '
  'in-process meta-plane medic (no xell); ''manager-zee'' = the superseded stage-3 manager-zee path, '
  'kept as the one-flip rollback (docs/medic-meta-plane-plan.md §6).';
