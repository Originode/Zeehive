-- FLEET PAUSE — the one operator switch that stops EVERY zee, in every xell, managers included.
--
-- Why it needs a row at all: the pause has to OUTLIVE the click. Interrupting the live turns is only
-- half of "stop" — the queenzee is a set of loops that start turns on their own (a landing lands and
-- nudge.js resumes the zee, a runway clears and it re-calls the holder, a ship succeeds and it asks
-- for a reflection, a human dispatches). Without a durable flag the fleet would be paused for exactly
-- as long as it took the next tick to wake something up, and the operator would be watching zees
-- restart one by one with no idea why. So the flag is checked by every path that starts or resumes a
-- turn, and it survives a queenzee restart — a pause you have to remember to re-apply is not a pause.
--
-- SINGLETON by construction: `id boolean PRIMARY KEY DEFAULT true CHECK (id)` admits exactly one row,
-- so "is the fleet paused" can never have two answers. Fleet-wide, NOT per project: the button says
-- every zee everywhere, and a per-project flag would quietly leave another project's managers running.
--
-- The counts are a RECEIPT, not state: how many live zees the last pause actually interrupted and how
-- many the last play nudged back. They exist because "paused" on its own cannot be checked — a pause
-- that reached nothing and a pause that stopped eleven zees look identical without them.
CREATE TABLE IF NOT EXISTS fleet_pause (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused        boolean     NOT NULL DEFAULT false,
  paused_at     timestamptz,
  paused_by     text,
  reason        text,
  resumed_at    timestamptz,
  resumed_by    text,
  -- receipts of the last fan-out in each direction
  interrupted   int         NOT NULL DEFAULT 0,
  unreachable   int         NOT NULL DEFAULT 0,
  nudged        int         NOT NULL DEFAULT 0
);
INSERT INTO fleet_pause (id, paused) VALUES (true, false) ON CONFLICT (id) DO NOTHING;

-- ── what a zee is TOLD about it (house rule 8) ────────────────────────────────────────────────────
-- A zee whose turn is cut off mid-tool-call and then resumed minutes later with no explanation has
-- every reason to believe it crashed, or that its `zee build` died, or that a human rejected
-- something. That misreading is expensive: the honest recovery (re-orient with `zee status`, then
-- carry on) looks nothing like the recovery from a crash. So the manual says what a pause is, in the
-- verbs section beside the other things that happen TO a zee rather than by it.
--
-- FORM: 076's harness_memory_put — anchored, guarded, idempotent, never rebuilding the memory array.
DO $$
DECLARE
  txt  text;
  done text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL OR txt LIKE '%THE FLEET PAUSE%' THEN RETURN; END IF;

  txt := replace(txt,
    E'Both are read-only/ping and open no gate.',
    E'Both are read-only/ping and open no gate.\n'
    || E'\n'
    || E'### THE FLEET PAUSE — when your turn ends and you did nothing wrong\n'
    || E'A human can PAUSE the whole fleet from the console: one button that interrupts every zee in\n'
    || E'every xell, managers included. It is a plain SIGINT to your headless run, so from inside your\n'
    || E'turn it is indistinguishable from a crash — your tool call stops mid-flight, and that is the\n'
    || E'point of writing it down here. **Nothing was rejected and nothing of yours failed.** Your\n'
    || E'commits are exactly where you left them (which is why you commit early), your landing/ship\n'
    || E'requests stand untouched, and no gate moved.\n'
    || E'\n'
    || E'While the fleet is paused the queenzee starts nothing: no dispatch, no landing nudge, no\n'
    || E'clearance call, no operator message reaches a session. When a human presses PLAY you are\n'
    || E'RESUMED with a prompt that says so. Do not guess at what happened while you were stopped —\n'
    || E'**`zee status` is the answer** (your landing may have been approved, gone stale, or been\n'
    || E'cleared for the runway in the meantime), and `zee work` if you are on a work item. Re-verify\n'
    || E'with `zee build … --wait` only if the interrupted step was a build. Then carry on where you\n'
    || E'were: do NOT re-run a `zee land`/`zee ship` you had already asked for, and do not raise a\n'
    || E'`tend` about having been paused — a human did it deliberately and is watching.');

  done := harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
  RAISE NOTICE 'cxell-zee manual (%): the fleet pause — an interrupted turn is not a crash', done;
END $$;
