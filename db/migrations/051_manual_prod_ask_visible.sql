-- THE MANUAL STILL DESCRIBES `zee prod` AS IF NOBODY COULD SEE IT.
--
-- Until 2026-07-28 that was accurate: the verb wrote a prod_bind_request row and the queenzee logged
-- a line, and NOTHING in the console rendered it — no hexagon status, no card, no ping. A zee could
-- ask for production and never be answered. That is fixed (occ-prodRequest → `prod?`, with
-- Reject / Bind to PROD on the asking xell's card), and the manual must say so, because the fix
-- changes what a zee should DO: the ask is answerable now, so ask and keep working — do not treat
-- prod access as an unreachable thing you have to plan around, and do not go silent waiting.
--
-- Same surgical, anchored, guarded shape as 050: applied only if the manual does not already carry
-- the new text, and each replacement fires only if its anchor still matches — a manual a human has
-- edited in the harness manager is left ALONE rather than clobbered.
DO $$
DECLARE
  txt text;
  mem jsonb;
BEGIN
  SELECT bundle->'memory'->0->>'text' INTO txt FROM harness WHERE key='zee-base';
  IF txt IS NULL OR txt LIKE '%your ask is VISIBLE%' THEN RETURN; END IF;

  -- (1) `zee prod`: what a human actually sees when you ask, and what to do while you wait.
  txt := replace(txt,
    E'data — an investigation, a one-off repair whose shape you cannot know in advance.',
    E'data — an investigation, a one-off repair whose shape you cannot know in advance.\n'
    || E'\n'
    || E'**And your ask is VISIBLE now.** It used to land in the queenzee log and nowhere else, so a zee\n'
    || E'could ask for production and simply never be answered. Today the request lights `prod?`\n'
    || E'(`occ-prodRequest`) on your hexagon and renders on your card in the console''s "waiting on you"\n'
    || E'line, with **Reject** and **Bind to PROD** on it — the same treatment a held landing gets. So:\n'
    || E'ask once, say what you need it for, and KEEP WORKING on everything that does not depend on it.\n'
    || E'`zee status` carries the answer as `prod_bind` (`pending` → `confirmed`/`rejected`); on confirm\n'
    || E'your db_coupling becomes `db-shared-prod` and the cxell is re-sealed so prod is reachable at all.\n'
    || E'A rejection is a normal answer, not a failure — usually it means the job was really `zee seed`.');

  -- (2) the hint section's "never left hanging" promise now covers the prod-DATA asks too.
  txt := replace(txt,
    E'"a zee should never be left hanging": if you finish unsure, your hexagon still asks a human to act,',
    E'"a zee should never be left hanging" — which now holds for the prod-DATA asks as well: `prod?` and\n'
    || E'`seed?` are hexagon states with buttons, not log lines.\n'
    || E'If you finish unsure, your hexagon still asks a human to act,');

  SELECT jsonb_set(bundle, '{memory,0,text}', to_jsonb(txt)) INTO mem FROM harness WHERE key='zee-base';
  UPDATE harness SET bundle = mem WHERE key='zee-base';
END $$;
