-- THE MANAGER MANUAL: `zee ops` (review the queenzee's own operations) and `zee ticket` (file the
-- finding in the work tracker).
--
-- The minister harness (120) exists to CRITICISE the queenzee — but the verbs it runs on are plain
-- MANAGER verbs, so they belong in the shared manager manual, not in one persona's memory: every
-- manager harness inherits this text (dev-lead, queenzee-minister), and
-- test/cxell-cli-drift.test.mjs FAILS if a MANAGER-only CLI verb is missing from any system-wide
-- manager harness's effective briefing. A crew lead reading its inbox full of reflections is one
-- `zee ticket` away from turning them into cards; it should know that.
--
-- What the entry has to convey, and why each part is here rather than left to be inferred:
--   * `zee ops` is READ-ONLY and fleet-wide — a digest, never an action. A manager that thinks the
--     review verb can fix what it finds will try to drive the queenzee with it;
--   * `zee ticket` is the ONLY write the critique gets, it lands in the caller's OWN project, and a
--     ticket opens no gate — the split between finding and deciding is the design, said out loud;
--   * check what is already filed (`--list`) BEFORE filing — a duplicated criticism is noise that
--     buries the real one (the same lesson as stacked land requests).
--
-- APPENDED, not anchored. 085/088/090 patched this manual with anchored replaces, so any line this
-- migration could anchor on may have moved on a database that took those patches in a different
-- state (and the live manual is human-editable in the harness manager). An append cannot miss: the
-- guard returns early when the section is already there, and harness_memory_put (house rule 9 /
-- 076) replaces the ONE entry while keeping every sibling. Verb-line details stay in the CLI's
-- usage text — restating flags here is how the two drift.
DO $$
DECLARE
  txt text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee ops%' THEN
    RAISE NOTICE 'manager manual: the zee ops / zee ticket section is already there';
    RETURN;
  END IF;

  txt := txt || $hz$

## Reviewing the queenzee itself — `zee ops` · `zee ticket`

Two verbs every manager has; together they are the whole job of the **queenzee-minister** persona.

```
zee ops [--hours N] [--logs N] [--alerts]    # the queenzee's operations as ONE read-only digest
zee ticket --title "…" [--body "…"] [--kind bug|feature|chore|question|incident] [--priority 1..5] [--notify]
zee ticket --list [--status s] [--q text]    # what is ALREADY filed in your project's tracker
```

### `zee ops` — read the queenzee's own operations
`GET /api/xell/self/ops`. One digest, fleet-wide, every part of it a read: the queenzee's recent
log with the warning/error lines pre-filtered (`--alerts` prints only those), every landing, ship,
seed and prod-bind request with HOW LONG each sat waiting on a human, the fleet's token burn (window
totals and the top spenders), open tends, and the backup ledger with its failures. `--hours` widens
the window (default 24).

It is a REVIEW verb, not a control verb. Nothing in it opens a gate, moves a container or edits
config — a critique that could act would be a second queenzee. What you do with a finding is decide
(a card in your own plan, a worker dispatched at it) or FILE it:

### `zee ticket` — file what you found
`POST /api/xell/self/ticket`. Files a ticket in YOUR OWN project's tracker (the project is resolved
from your token; the reporter is your slug), exactly the raw ask a human types into the tickets
window — and that is all it does: a ticket opens no gate and changes nothing until a human or a
manager breaks it down into work items and takes it up. `--notify` also drops it into every OTHER
live manager's inbox, so a finding reaches whoever runs the crew.

**List before you file** (`zee ticket --list`, `--q` searches title/body/reporter): a criticism
filed twice is noise that buries the one card a human would have acted on. Reference the evidence
in `--body` — the request ids, the ages, the exact log lines out of `zee ops` — so the ticket can
be judged without re-running the review.$hz$;

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: added the zee ops / zee ticket section';
END $$;
