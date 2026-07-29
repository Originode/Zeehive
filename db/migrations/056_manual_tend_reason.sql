-- A TEND WITHOUT A REASON IS AN INTERRUPTION, NOT A REQUEST.
--
-- `zee tend` raises "I need a human in the console" on the hexagon. The reason a zee typed was
-- recorded into session_event.raw and then read by NOTHING: the console could only say "this xell
-- wants you", and its own note told the human to "open its session to see why". So the one ask
-- whose ENTIRE content is its reason shipped the reason nowhere, and answering a tend started with
-- reading a transcript.
--
-- The reason now travels: required (and clamped to one brief line) when raising, carried on the
-- fleet row, rendered on the xell card and in the console's "waiting on you" line, handed to a
-- manager reading its crew, and echoed back in `zee status`. The manual must say so, because it
-- changes what a zee must DO: give a WHY that is useful to a human on its own.
--
-- Surgical + anchored + guarded, like 050/051/053: skipped if the manual already carries the new
-- text, and each replace fires only if its anchor still matches — a manual a human edited in the
-- harness manager is left ALONE rather than clobbered.
DO $$
DECLARE
  txt text;
  mem jsonb;
BEGIN
  SELECT bundle->'memory'->0->>'text' INTO txt FROM harness WHERE key='zee-base';
  IF txt IS NULL OR txt LIKE '%The reason is REQUIRED%' THEN RETURN; END IF;

  -- (1) the verb list line: the reason is not optional garnish, it is the message.
  txt := replace(txt,
    E'zee tend --reason "…" | --clear                  # raise/lower "I need a human in the console"',
    E'zee tend --reason "…" | --clear                  # raise/lower "I need a human" — the BRIEF reason is required');

  -- (2) the section itself: what the reason is FOR, and what a good one looks like.
  txt := replace(txt,
    E'`POST /api/xell/self/tend` `{ reason?, clear? }`. Flags **"I need a human in the console"** on your\n'
    || E'hexagon with `--reason "why"`. It opens no gate and blocks nothing — it is a signal, not a request\n'
    || E'for a specific action (use `hint-land`/`hint-ship` when what you want is a land/ship button). `zee\n'
    || E'tend --clear` lowers it, and any `zee working` clears it too. Use it when you are genuinely stuck on\n'
    || E'something only a human can unblock — not as a substitute for deciding and proceeding.',
    E'`POST /api/xell/self/tend` `{ reason, clear? }`. Flags **"I need a human in the console"** on your\n'
    || E'hexagon with `--reason "why"`. It opens no gate and blocks nothing — it is a signal, not a request\n'
    || E'for a specific action (use `hint-land`/`hint-ship` when what you want is a land/ship button). `zee\n'
    || E'tend --clear` lowers it, and any `zee working` clears it too. Use it when you are genuinely stuck on\n'
    || E'something only a human can unblock — not as a substitute for deciding and proceeding.\n'
    || E'\n'
    || E'**The reason is REQUIRED, and it is the whole message.** A tend carries no diff, no commit and no\n'
    || E'button — the only thing a human receives is your one line, and it is shown where they are: on\n'
    || E'your card and in the console''s "waiting on you" chip (`zee status` echoes it back as\n'
    || E'`tend.reason`). Raising without one is refused, because it summons a human who then has to open\n'
    || E'your session to find out what for. Write it as the whole ask, in ONE line — it is clamped to\n'
    || E'~200 characters, so put the detail in your session and the decision in the reason:\n'
    || E'\n'
    || E'- good: `zee tend --reason "prod webapp 502s after my ship — needs a human to look, I have not touched it"`\n'
    || E'- good: `zee tend --reason "task says migrate orders, but the orders table is prod-only — which db?"`\n'
    || E'- useless: `zee tend --reason "need help"` / `"blocked"` / `"question"`\n'
    || E'\n'
    || E'And lower it when it stops being true: `zee tend --clear` (or any `zee working`), so a stale\n'
    || E'"needs you" is not competing with a real one.');

  mem := jsonb_build_array(jsonb_build_object('path', 'cxell-zee-manual.md', 'text', txt));
  UPDATE harness SET bundle = jsonb_set(bundle, '{memory}', mem) WHERE key='zee-base';
  RAISE NOTICE 'cxell-zee manual: a tend must carry a brief reason (and the console now shows it)';
END $$;
