-- `zee turn` IN THE WORKER MANUAL — the turn nothing in the fleet could see.
--
-- THE GAP (reaper.js has stated it in these words for months, as a KNOWN GAP): an INTERACTIVE turn
-- — one a human or a manager starts by TYPING into the resting session in a cage's pane — starts a
-- turn nothing in the fleet observes. Channel A (hooks) is not installed for a cxell, the passive
-- poller skips entrypoint='cxell-cli', and the monitor's `pgrep` cannot tell a generating TUI from
-- one sitting at its prompt. So the zee reads 'idle' for the whole of it — the same blindness that
-- cost a manager a duplicate xell (TKT-57/60), on the one door the queenzee does not own.
--
-- The cage can answer for itself: it holds the `zee` CLI and its own identity token. So the vendor
-- CLI's own turn hooks call `zee turn --start` / `zee turn --end` (installed at spawn — declared per
-- vendor and MEASURED, never assumed), and the queenzee records the boundary on the ZEE ROW ONLY.
--
-- WHAT THE TEXT MUST KEEP SAYING, because the honest limits are the point of the verb:
--   • NO COST. A hook knows a turn happened, not what it cost. Only a turn the queenzee itself ran
--     reports usage — so an interactive turn moves the STATUS and never the burn columns.
--   • It is called FOR you by the hooks; a zee does not sprinkle it through its own turn.
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry preserved
-- (house rule 9; test/harness-memory-migrations.test.mjs fails anything that hand-rolls it). Two
-- guarded edits: the CLI cheat-sheet line and a section of its own. A moved anchor appends rather
-- than skips (test/cxell-cli-drift.test.mjs §e requires the verb to be documented on EVERY
-- database), and says so with a NOTICE.
DO $mig$
DECLARE
  txt      text;
  changed  boolean := false;
  anchor_list text := E'zee working [--note "…"]                         # ping "I am actively working" (NOT gated)\n';
  new_list    text := E'zee turn --start | --end                          # an INTERACTIVE turn boundary — the cage''s own hooks call this (NOT gated)\n';
  anchor_sec  text := E'### `zee sync` — catch up / rebase your branch onto current main';
  section     text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  section := $sec$### `zee turn` — the turn NOBODY could see, reported by the cage itself
`POST /api/xell/self/turn` `{ state: 'start' | 'end' }`. Three kinds of turn run in your cage, and
until this verb the fleet could only see two of them: the one it SPAWNED you with, and the one it
RESUMES you with (a landing approval, a message to a finished zee, a runway clearance, the post-ship
reflection, a fleet resume). The third is a turn a human or your manager starts by **typing into the
live session in your pane** — the queenzee does not start it, no hook or poller is installed in a
cage, and a `pgrep` cannot tell a generating session from one sitting at its prompt. So that turn ran
with your row saying `idle`, which is exactly the reading that cost a manager a whole duplicate xell.

**You do not normally call this.** Your runtime's own turn hooks call it for you — they are installed
into the cage at spawn — so an interactive turn moves your status the same way a queenzee-started one
does. It is here because an attending human (or you) may need it when a session's status is plainly
lying: `zee turn --end` after a turn that was interrupted, for instance.

- **NOT gated**, and it opens nothing: it writes your zee row and a session event, nothing else.
- **It records NO COST.** A hook knows a turn happened, not what the vendor charged for it — only a
  turn the queenzee itself ran reports usage. Your burn columns are silent for an interactive turn
  rather than carrying an invented figure.
- **It never overwrites a decision a human is holding**: like every turn boundary, it is the zee row
  only, so a xell sitting at `awaiting-done` keeps saying done? on the hexagon while you work.
- **Claude cages today.** The hook is declared per vendor and measured, never assumed; codex and kimi
  declare none, so those cages are exactly as they were — and a cxell that was already running when
  this shipped keeps the old gap until it is respawned.

$sec$;

  IF position(new_list IN txt) = 0 THEN
    IF position(anchor_list IN txt) > 0 THEN
      txt := replace(txt, anchor_list, anchor_list || new_list); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the CLI list line for zee working has moved — the cheat-sheet line was not added';
    END IF;
  END IF;

  IF position('### `zee turn`' IN txt) = 0 THEN
    IF position(anchor_sec IN txt) > 0 THEN
      txt := replace(txt, anchor_sec, section || anchor_sec);
    ELSE
      RAISE NOTICE 'worker manual: the zee sync section has moved — appending the zee turn section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee turn documented';
  ELSE
    RAISE NOTICE 'worker manual: zee turn was already documented — nothing to do';
  END IF;
END
$mig$;
