-- A REFUSED SHIP RAISES NOTHING — AND A ZEE MUST NOT REPORT IT AS PENDING.
--
-- Reported by an operator: "some ship requests seem to be missing… xells insist they have ship
-- requests… but i see zero." They were not missing. They were never raised.
--
-- `requestShip` refuses outright when the work is not landed (or the tree is dirty, or the ship ref
-- will not resolve). A refusal writes NO ship_request row, so there is nothing on the production
-- panel, nothing on the hexagon, and — until now — nothing anywhere at all: the only record was one
-- line in the queenzee's in-memory log, gone at the next restart. Meanwhile the refusal came back to
-- the zee as HTTP 200 with `{ok:false}`, and `zee` printed that JSON and exited 0. A refusal looked
-- exactly like a success, so zees relayed "the ship request is waiting for your approval" to humans
-- staring at an empty panel.
--
-- Three things changed, and the manual must carry the one that is the ZEE's to know:
--   * the CLI now exits 1 and says "SHIP DID NOT HAPPEN — nothing is awaiting a human";
--   * the refusal is recorded and rendered in the console's production panel, so the human can SEE
--     that a zee asked and was refused;
--   * and a ship you asked for is only real if the answer names a ship_request. That is this patch.
--
-- Surgical + anchored + guarded like 050/051/053/056: skipped if the manual already says it, and
-- each replace fires only if its anchor still matches, so a human-edited manual is left ALONE.
DO $$
DECLARE
  txt text;
  mem jsonb;
BEGIN
  SELECT bundle->'memory'->0->>'text' INTO txt FROM harness WHERE key='zee-base';
  IF txt IS NULL OR txt LIKE '%A REFUSED ship is not a quiet ship%' THEN RETURN; END IF;

  -- (1) the verb list line: name the outcome that is NOT a request.
  txt := replace(txt,
    E'zee ship [--targets server webapp] --reason "…"  # ask to deploy to prod   (ONLY when 100% certain)',
    E'zee ship [--targets server webapp] --reason "…"  # ask to deploy to prod — REFUSED unless landed (ONLY when 100% certain)');

  -- (2) the section: what a refusal is, and what you must not tell your human.
  txt := replace(txt,
    E'build, you do not release anything — deliberately. `--targets` names what to rebuild (`server`,\n'
    || E'`webapp`, or both; default both). Land first (`zee land`), then ship.',
    E'build, you do not release anything — deliberately. `--targets` names what to rebuild (`server`,\n'
    || E'`webapp`, or both; default both). Land first (`zee land`), then ship.\n'
    || E'\n'
    || E'**A REFUSED ship is not a quiet ship — it is NO ship.** When the gate refuses (work not landed,\n'
    || E'uncommitted files in the worktree, a ship ref that will not resolve) NOTHING is created: no\n'
    || E'request, no card, no hexagon state, nobody to approve anything. The answer says so — `ok:false`,\n'
    || E'`refused:true`, and the `zee` CLI exits **1** with "SHIP DID NOT HAPPEN". Read it before you\n'
    || E'speak: telling a human "the ship is waiting for your approval" when it was refused sends them to\n'
    || E'a console that shows zero, and that is exactly how this rule was earned. A ship you asked for is\n'
    || E'real only when the answer names a **ship_request id and commit** (`zee status` → `ship.pending`).\n'
    || E'A refusal is echoed back as `ship_refused` there, and the console now shows your refused ask on\n'
    || E'your xell — so the honest move costs you nothing and the dishonest one is visible anyway.\n'
    || E'\n'
    || E'Fix the reason and ask again — the fix is almost always `zee land` first (and committing, or\n'
    || E'reverting, whatever is dirty in the worktree). One open ship per zee: re-asking while a request\n'
    || E'is open just hands you back the same one.');

  mem := jsonb_build_array(jsonb_build_object('path', 'cxell-zee-manual.md', 'text', txt));
  UPDATE harness SET bundle = jsonb_set(bundle, '{memory}', mem) WHERE key='zee-base';
  RAISE NOTICE 'cxell-zee manual: a refused ship raises nothing — do not report it as pending';
END $$;
