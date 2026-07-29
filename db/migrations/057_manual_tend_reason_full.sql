-- THE MANUAL PROMISED A CLAMP THAT WAS A TRUNCATION.
--
-- 056 taught zees that a tend's reason is required and "clamped to ~200 characters". It was — on the
-- way IN as well as out, so the tail was not clipped for display, it was DESTROYED. The first real
-- tend to hit it was one reporting a production credential problem: it reached the console as
-- "…re-tasking a manager wi…", and the rest existed nowhere a human could read.
--
-- Fixed in the same shipment's successor: a tend now STORES what the zee said (bounded at 2000) and
-- the console shows the one-line head on the chip/card with the WHOLE text on the opened ask. The
-- manual has to match, or zees will keep pre-truncating their own asks to fit a limit that is only
-- about layout — and the useful half of every serious tend goes missing before it is ever written.
DO $$
DECLARE
  txt text;
  mem jsonb;
BEGIN
  SELECT bundle->'memory'->0->>'text' INTO txt FROM harness WHERE key='zee-base';
  IF txt IS NULL OR txt LIKE '%the console keeps the whole text%' THEN RETURN; END IF;

  txt := replace(txt,
    E'your session to find out what for. Write it as the whole ask, in ONE line — it is clamped to\n'
    || E'~200 characters, so put the detail in your session and the decision in the reason:',
    E'your session to find out what for. Write it as the whole ask, in ONE line — the first ~200\n'
    || E'characters are what a human sees at a glance on the chip and the card, and the console keeps\n'
    || E'the whole text for when they open the ask (so LEAD with the decision; do not pre-truncate it):');

  mem := jsonb_build_array(jsonb_build_object('path', 'cxell-zee-manual.md', 'text', txt));
  UPDATE harness SET bundle = jsonb_set(bundle, '{memory}', mem) WHERE key='zee-base';
  RAISE NOTICE 'cxell-zee manual: the tend reason is clipped for DISPLAY, not truncated on the way in';
END $$;
