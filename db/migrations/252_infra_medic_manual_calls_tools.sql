-- THE MEDIC CALLS TOOLS ENTER THE INFRA-MEDIC MANUAL (the BLOCKING-2 correction to 251).
--
-- Migration 251 documented `zee medic` (the patient-voice card) in the worker and manager manuals,
-- and gave the medic role a table-wide UPDATE grant on medic_call so a medic could answer the calls
-- it attends. That grant is WRONG: a TABLE-WIDE update grant with no row guard means the answer
-- scoping answerMedicCall does in code (WHERE medic_id + status='attended') is bypassable by one
-- bare `UPDATE medic_call` statement through meta_write — the "any role that can UPDATE xell is a
-- nested reaper" shape this role surface was drawn to avoid (medic-role.js header). So:
--
--   • the code removes medic_call from MEDIC_WRITE_TABLES and adds it to MEDIC_NO_WRITE_TABLES
--     (this migration cannot touch the running role's grants — the queenzee re-mints the role at
--     boot from medicRoleSql, which the landed code now drives);
--   • the ONLY door to a medic_call row is the calls / call_answer tools (calls/call_answer run on
--     the OWNER pool through answerMedicCall, row-scoped to the medic's own attended call);
--   • the medic's own manual — this harness memory entry — is updated BY PATH (house rule 9) to
--     say so: the two tools are listed, and medic_call joins the REFUSE list in the meta_write
--     prose, so a medic knows the SQL wall is real and the row-scoped tools are the sanctioned door.
--
-- Idempotent, additive, forward-only. Guarded on the anchors' own text: if the manual has moved
-- the notice says so and nothing is lost.
DO $$
DECLARE
  itxt     text;
  ichanged boolean := false;
  ivoice_anchor text := E'- `report` / `need_human` — your voice. `need_human` sets your status and the one-line ask on\n  the needs-you bar; blocks nothing.';
  irefuse_anchor text := 'xell, zee, medic, harness, provider_token, the gate tables and the';
  inew_bullets text;
BEGIN
  itxt := harness_memory_get('infra-medic', 'memory/infra-medic-manual.md');
  IF itxt IS NOT NULL AND itxt NOT LIKE '%call_answer%' THEN
    -- (a) the meta_write refusal prose names medic_call as REFUSED too (no table-wide grant).
    IF position(irefuse_anchor IN itxt) > 0 THEN
      itxt := replace(itxt, irefuse_anchor, 'xell, zee, medic, medic_call, harness, provider_token, the gate tables and the');
      ichanged := true;
    ELSE
      RAISE NOTICE 'infra-medic manual: the meta_write REFUSE list has moved — medic_call was not added to it';
    END IF;

    -- (b) the two calls tools get their own bullets, after the voice bullets.
    inew_bullets := $hz$
- `calls` — list the OPEN medic calls on your TARGET project plus the calls YOU are attending:
  each carries a blocked zee's OWN WORDS, its kind, its xell slug, its CALL ID and the infra
  evidence stamped at call time. A call is a blocked zee asking for YOU — read this before or
  after diagnosing, and ANSWER an attended call with call_answer.
- `call_answer` — answer a call YOU are attending: resolve (fixed) or decline (not yours — a
  fault in the zee's own code/tests is `zee tend`, not a medic). The note is REQUIRED and is
  POSTED BACK to the calling zee as a message. THIS is the only door to a medic_call row:
  medic_call is NOT in your SQL grant (no table-wide UPDATE — the answer scoping cannot be
  bypassed by a bare statement), and the row-scoping — your OWN attended call only — lives in
  this tool, not in the grant.
$hz$;
    IF position(ivoice_anchor IN itxt) > 0 THEN
      itxt := replace(itxt, ivoice_anchor, ivoice_anchor || inew_bullets);
      ichanged := true;
    ELSE
      RAISE NOTICE 'infra-medic manual: the voice-tools bullet has moved — the calls/call_answer bullets were not added';
    END IF;

    IF ichanged THEN
      PERFORM harness_memory_put('infra-medic', 'memory/infra-medic-manual.md', itxt);
      RAISE NOTICE 'infra-medic manual: calls/call_answer documented, medic_call added to the REFUSE list';
    ELSE
      RAISE NOTICE 'infra-medic manual: could not document calls/call_answer (anchors moved) — nothing written';
    END IF;
  ELSE
    RAISE NOTICE 'infra-medic manual: calls/call_answer already documented (or no entry on this database) — nothing to do';
  END IF;
END $$;
