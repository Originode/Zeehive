-- XELL SCRATCHPAD — a per-xell working note that OUTLIVES the cage (ticket #66).
--
-- WHAT and WHY: commits are collected; knowledge is not. A swap keeps the branch and loses what the
-- last zee learned; a reaped worker takes 'I am stuck on X' with it; a manager's rolling analysis
-- lives in a container about to be deleted. The fix is ONE text on the xell's OWN row in the
-- meta-DB — `zee scratchpad` writes and reads it, a SWAP embeds it in the inheritance brief the
-- incoming zee is spawned with, and a manager (through `zee scratchpad --xell <slug>`) or a human
-- (the console) can read it. It is NOT a landing, NOT a gate, and never enters the repo: a worktree
-- dies with the branch, which is exactly when the note must survive.
--
-- The shape copies 228 STANDING ORDERS — the structurally identical problem solved a few hours
-- earlier (text on a xell row, appended to a brief): NULL/empty = unset and renders NOTHING (a xell
-- that never writes a scratchpad is byte-identical to today); a hard length ceiling enforced on
-- every write path; refusals decided from the token-resolved xell.
--
-- WHOSE IT IS (the deliberate decision the card asks for): a xell's scratchpad belongs to that xell.
-- A zee writes and reads its OWN and nothing else — the self verb is token-scoped, so a zee can
-- never name another xell. A MANAGER may read a crew xell's (`--xell <slug>`, scoped by workerOf),
-- and a HUMAN may read any xell's in the console. Neither writes a zee's scratchpad: the writer is
-- always the zee that owns the xell.
--
-- TWO halves, like every manual-bearing migration:
--   1. the schema — three nullable columns on xell;
--   2. the manuals — `zee scratchpad` is EVERY zee's verb (worker + manager), and the manager's
--      `--xell <slug>` read is documented in the manager manual. Each edit is guarded on its own
--      text (harness_memory_get/_put BY PATH, house rule 9) and an anchor that has moved appends at
--      the end and says so with a NOTICE, so the verb is documented on any database.

-- ── 1. SCHEMA ─────────────────────────────────────────────────────────────────
ALTER TABLE xell ADD COLUMN IF NOT EXISTS scratchpad text;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS scratchpad_updated_at timestamptz;
ALTER TABLE xell ADD COLUMN IF NOT EXISTS scratchpad_updated_by text;

COMMENT ON COLUMN xell.scratchpad IS
  'Per-xell scratchpad — the zee''s own working notes, written through `zee scratchpad`, read by a swap''s inheritance brief and by its manager/human (ticket #66). NULL/empty = unset; a swap then carries no scratchpad block.';
COMMENT ON COLUMN xell.scratchpad_updated_at IS
  'When this xell''s scratchpad was last set or cleared.';
COMMENT ON COLUMN xell.scratchpad_updated_by IS
  'Who last set/cleared this xell''s scratchpad (the zee slug that owns the xell).';

-- ── 2. THE MANUALS ────────────────────────────────────────────────────────────
DO $$
DECLARE
  -- the WORKER manual (zee-base / cxell-zee-manual.md)
  wtxt      text;
  wchanged  boolean := false;
  wverbline text;
  wlist_anchor text := E'zee conditions                                # YOUR PROJECT''S CURRENT CONDITIONS: the short, dated list of LIVE IMPEDIMENTS injected into every briefing — read it any time, and trust it over any doc that is older than it is (NOT gated)';
  wsection  text;
  wsec_anchor text := E'### Standing orders — your manager''s crew discipline, appended to your brief';
  -- the MANAGER manual (manager / manager-zee-manual.md)
  mtxt      text;
  mchanged  boolean := false;
  mverbline text;
  mlist_anchor text := E'zee standing-orders [--set "…" | --clear]   # YOUR CREW''S STANDING ORDERS — a short block appended VERBATIM to every brief you dispatch; set it once, clear it when it stops being true (SHORT by design — a limit, not a second manual)';
  msection  text;
  msec_anchor text := E'## The WORK TRACKER — the plan your crew executes';
BEGIN
  -- ── the WORKER manual: the verb (every zee has it) and a section of its own ──
  wtxt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF wtxt IS NOT NULL AND wtxt NOT LIKE '%zee scratchpad%' THEN
    -- (a) the verb line in the list, next to its neighbour `zee conditions`.
    wverbline := E'zee scratchpad [--set "…" | --clear]                # YOUR XELL''S SCRATCHPAD — the working note that OUTLIVES this cage (ticket #66): write what you have tried and ruled out, and a SWAP hands it to the next zee in its inheritance brief. Written/read by YOU only; a length cap applies. --clear empties it';
    IF position(wlist_anchor IN wtxt) > 0 THEN
      wtxt := replace(wtxt, wlist_anchor, wlist_anchor || E'\n' || wverbline);
      wchanged := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee conditions list line has moved — the zee scratchpad list line was not added';
    END IF;

    -- (b) a short section of its own, before the standing-orders note.
    wsection := $hz$### `zee scratchpad` — your per-xell working note (it survives this cage)

Everything a zee writes down for itself — what it has tried, what it has ruled out, which assertion
already proved, the half-page of "I am stuck on X" — dies in this container by design, because the
only durable channels are a commit and a message. The scratchpad is the ONE durable channel that is
neither: a single text stored beside the xell in the meta-DB, written and read through your own
verb, and handed to the NEXT zee when this xell is swapped.

```
zee scratchpad                        # read your scratchpad
zee scratchpad --set "…"              # write it (replaces the previous text)
zee scratchpad --clear                # empty it — a swap then carries no scratchpad block
```

It is YOURS and only yours: the verb is token-scoped to the xell that calls it, so you can never read
or write another xell's through any route — and a swap embeds YOUR text in the incoming zee's
inheritance brief as ``### The previous zee's scratchpad``, so the next zee starts where you left
off. It is bounded (a hard ceiling, not a second manual), it is NOT a landing and opens NO gate, and
it never enters the repo — a worktree dies with the branch, which is exactly when the note must
survive. Write it as you work, at whatever cadence you like.

$hz$;
    IF position('### `zee scratchpad`' IN wtxt) = 0 THEN
      IF position(wsec_anchor IN wtxt) > 0 THEN
        wtxt := replace(wtxt, wsec_anchor, wsection || E'\n' || wsec_anchor);
      ELSE
        RAISE NOTICE 'worker manual: the standing-orders note heading has moved — appending the zee scratchpad section at the end';
        wtxt := wtxt || E'\n' || wsection;
      END IF;
      wchanged := true;
    END IF;

    IF wchanged THEN
      PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', wtxt);
      RAISE NOTICE 'worker manual: zee scratchpad documented';
    ELSE
      RAISE NOTICE 'worker manual: zee scratchpad could not be documented (anchors moved)';
    END IF;
  ELSE
    RAISE NOTICE 'worker manual: zee scratchpad is already documented (or no entry on this database) — nothing to do';
  END IF;

  -- ── the MANAGER manual: the verb line and the `--xell <slug>` read section ──
  mtxt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF mtxt IS NOT NULL AND mtxt NOT LIKE '%zee scratchpad%' THEN
    -- (a) the verb line in the list, next to its neighbour `zee standing-orders`.
    mverbline := E'zee scratchpad --xell <slug>                  # READ a worker''s SCRATCHPAD (ticket #66) — the per-xell working note that survives the cage and that a swap hands to the next zee; scoped to YOUR OWN crew';
    IF position(mlist_anchor IN mtxt) > 0 THEN
      mtxt := replace(mtxt, mlist_anchor, mlist_anchor || E'\n' || mverbline);
      mchanged := true;
    ELSE
      RAISE NOTICE 'manager manual: the zee standing-orders list line has moved — the zee scratchpad list line was not added';
    END IF;

    -- (b) a short section of its own, before the work-tracker deep-dive.
    msection := $hz$### `zee scratchpad --xell <slug>` — read a worker's working notes

A worker's scratchpad is its own running analysis — what it has tried, what it has ruled out, where
it is stuck — written through `zee scratchpad` and stored beside the xell in the meta-DB, so it
survives the cage and rides into the next zee's inheritance brief on a swap. A manager can READ a
crew xell's with `--xell <slug>` (scoped to your own crew — you never name a xell that is not
yours), which is how you see what a quiet worker has actually worked out, or what a reaped one took
with it. A worker writes its own and cannot read another's; a manager and a human can only READ —
the scratchpad is the worker's own thinking, never something a manager edits.

$hz$;
    IF position('### `zee scratchpad --xell' IN mtxt) = 0 THEN
      IF position(msec_anchor IN mtxt) > 0 THEN
        mtxt := replace(mtxt, msec_anchor, msection || E'\n' || msec_anchor);
      ELSE
        RAISE NOTICE 'manager manual: the work-tracker section has moved — appending the zee scratchpad section at the end';
        mtxt := mtxt || E'\n' || msection;
      END IF;
      mchanged := true;
    END IF;

    IF mchanged THEN
      PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', mtxt);
      RAISE NOTICE 'manager manual: zee scratchpad documented';
    ELSE
      RAISE NOTICE 'manager manual: zee scratchpad could not be documented (anchors moved)';
    END IF;
  ELSE
    RAISE NOTICE 'manager manual: zee scratchpad is already documented (or no entry on this database) — nothing to do';
  END IF;
END $$;
