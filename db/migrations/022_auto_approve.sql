-- Operator policy: auto-approve landings and/or ships for a project, skipping the human gate.
-- Both OFF by default — the human decision stays the default everywhere. A human sets these in the
-- console; they are project-scoped and independent (landing→main is far lower stakes than
-- shipping→prod, so you can enable one without the other). See landgate.js / shipgate.js.
ALTER TABLE project
  ADD COLUMN IF NOT EXISTS auto_approve_land boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_approve_ship boolean NOT NULL DEFAULT false;
