-- Operator policy: auto-approve SEEDS and auto-DONE xells for a project, alongside the existing
-- land/ship auto-approve switches (022). Both OFF by default — the human decision stays the default.
-- A human sets these in the console; they are project-scoped and independent:
--   auto_approve_seed  — a prod-seed request is approved and RUN automatically (no human review of
--                        the SQL). The queenzee still only runs files that are already ON MAIN, from
--                        the seedgate's whitelist (server/sql/seeds/), so the anti-band-aid rule for
--                        data is untouched — only the human decision is skipped.
--   auto_done          — a DONE SUGGESTION is confirmed automatically, but ONLY when a manager zee
--                        raised it (done_suggestion rows are manager-only by construction; a worker's
--                        own `zee done` still needs a human). The reap still runs through the same
--                        guards — an actively-working xell is refused and the card stays open.
ALTER TABLE project
  ADD COLUMN IF NOT EXISTS auto_approve_seed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_done boolean NOT NULL DEFAULT false;
