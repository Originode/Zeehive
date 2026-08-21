-- PROVENANCE FOR THE 2026-08-21 BACKFILL — who decided a row's revive_class, and how.
--
-- The card (ticket #78) is judged by the share of revive_class='unknown' AFTERWARDS, and migration
-- 213 reclassified 53 of the 65 unknown rows in a single statement. Without a marker, nobody can
-- tell a row classified LIVE at the moment of death from a row rewritten by the backfill — and the
-- metric could move without a single future death being classified better. This column records HOW
-- a row's class (or its NULL) was decided:
--
--     'live'                  — classifyTurnDeath at the moment the turn died (noteTurnDeath,
--                               revive.js); stamped on EVERY new classification going forward, so the
--                               distinction keeps working instead of being a one-off label.
--     'backfill-2026-08-21'   — migration 213's one-time reclassification of the measured cohort.
--     NULL                    — never classified: a healthy finish, or a death path that does not
--                               reach the classifier (a separate defect reported to the manager).
--
-- The 213-touched rows are identified by the SAME last_stop_reason patterns 213 used, plus the class
-- columns in both states (before and after 213's UPDATE ran), so this is correct whether 215 is
-- applied before or after 213 has been applied anywhere.
--   • the three reclassified groups: after 213 they carry revive_signal 'auth'/'model'/'killed'
--     together with their matching pattern; before 213 they were still 'unknown'. Either state
--     marks them, and nothing else can be in those states with those reasons at migration time.
--   • the non-death rows: 213 set them to NULL, which would otherwise be indistinguishable from the
--     ~356 rows that never went through the classifier at all (a healthy 'end_turn'). The
--     discriminator is the turn-death session_event: every row 213 touched was 'unknown' BEFORE the
--     backfill, and 'unknown' is only ever written by noteTurnDeath, which also records a
--     'turn-death' event. A row with the pattern but no such event was never examined — it stays
--     NULL source, honestly unprocessed, rather than being claimed by the backfill.
--   • every OTHER row with a real class (revive_class NOT NULL) and a turn-death event was decided
--     LIVE at the moment of death, before this column existed — mark it 'live' too, so NULL source
--     means exactly one thing: the classifier never examined this row.
ALTER TABLE zee ADD COLUMN IF NOT EXISTS revive_class_source text;

-- ── the three reclassified groups (37 measured rows: 15 auth + 17 model + 5 killed) ──────────────
UPDATE zee SET revive_class_source = 'backfill-2026-08-21'
 WHERE revive_class_source IS NULL
   AND (   (revive_signal = 'auth'   AND last_stop_reason ILIKE '%not signed in%')
        OR (revive_signal = 'model'  AND last_stop_reason ILIKE '%issue with the selected model%')
        OR (revive_signal = 'killed' AND last_stop_reason ILIKE '%exited 137%')
        OR (revive_class = 'unknown' AND (   last_stop_reason ILIKE '%not signed in%'
                                          OR last_stop_reason ILIKE '%issue with the selected model%'
                                          OR last_stop_reason ILIKE '%exited 137%')));

-- ── the non-death rows (16 measured) — examined and NOT a death, distinguishable from unprocessed ──
UPDATE zee z SET revive_class_source = 'backfill-2026-08-21'
 WHERE z.revive_class_source IS NULL
   AND (z.revive_class IS NULL OR z.revive_class = 'unknown')
   AND (   z.last_stop_reason LIKE 'end_turn%'
        OR z.last_stop_reason LIKE 'post-ship reflection%'
        OR z.last_stop_reason ILIKE 'message from manager-%'
        OR z.last_stop_reason ILIKE 'swapped out by manager-%')
   AND EXISTS (SELECT 1 FROM session_event se
                WHERE se.zee_id = z.id AND se.hook_event_name = 'turn-death');

-- ── every other row with a real class and a turn-death event was decided LIVE, pre-column ─────────
-- (a row the classifier named at the moment of death, before 215 existed; the credential-injected
-- re-arm sets no turn-death event, so the event guard keeps it out). NULL source now means exactly
-- one thing: the classifier never examined this row.
UPDATE zee z SET revive_class_source = 'live'
 WHERE z.revive_class_source IS NULL
   AND z.revive_class IS NOT NULL
   AND EXISTS (SELECT 1 FROM session_event se
                WHERE se.zee_id = z.id AND se.hook_event_name = 'turn-death');
