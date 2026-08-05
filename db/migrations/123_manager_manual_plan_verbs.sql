-- THE MANAGER MANUAL: `zee work --new`, `zee breakdown` and `zee unassign` — the verbs that CUT the
-- plan a manager is ordered to cut.
--
-- The manual already tells a manager to "break a ticket down into work items BEFORE you dispatch
-- anybody", and until this landed there was no verb that could: `zee work` read the plan and
-- `zee assign` deployed onto an item somebody else had created, so a manager wanting four cards had
-- to get a human to type them into the console. The same hole on the way back out — a worker that
-- died at spawn left its card locked to a dead xell, `zee assign` refused the replacement with
-- "unassign it first", and no manager verb could do that either.
--
-- House rule 8: what a zee is told is versioned like code, so this moves in the same commit as the
-- CLI usage and the routes. test/cxell-cli-drift.test.mjs FAILS the build when a MANAGER-only CLI
-- verb is missing from a system-wide manager harness's effective briefing — `dev-lead` and
-- `queenzee-minister` both inherit this text, so patching `manager` is the whole of it.
--
-- APPENDED, not anchored, for the reason 119 gives: 085/088/090/119 patched this manual with
-- anchored replaces and it is human-editable in the harness manager, so any line to anchor on may
-- have moved. The guard returns early when the section is already there, and harness_memory_put
-- (house rule 9 / 076) replaces the ONE entry and keeps every sibling. Flag-level detail stays in
-- the CLI's usage text — restating it here is how the two drift.
DO $$
DECLARE
  txt text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%zee breakdown%' THEN
    RAISE NOTICE 'manager manual: the plan-cutting section is already there';
    RETURN;
  END IF;

  txt := txt || $hz$

### Cutting the plan yourself — `zee work --new` · `zee breakdown` · `zee unassign`

You are told to break a ticket down BEFORE you dispatch anybody. These are the verbs that let you,
without a human in the console:

```
zee work --new --title "…" [--body "…"] [--kind task|activity] [--parent <id>] [--ticket <code|id>] [--priority 1..5]
zee breakdown --ticket <code|id> --items <file.json>
zee unassign --item <id> [--reason "…"]
```

**`zee work --new`** cuts ONE card in your own project and PRINTS ITS ID on the first line, so the
next command is a copy-paste: `zee assign --item <id> --task "…"`. `--parent` hangs it under an
existing item (an activity you already cut), `--ticket` links it to the ticket it came from — and a
worker deployed onto it is then briefed with the body, the ancestors and that ticket for free.

**`zee breakdown`** turns a ticket into a whole TREE in one call. The file is a JSON array of
`{title, kind?, body?, parent_id?, ref?, priority?, starts_on?, due_on?}`, and a later entry may
name an earlier entry's `ref` as its `parent_id` — that is how one call expresses activities with
tasks under them. It is ONE transaction: either the whole plan exists or the ticket is untouched.
It is also ADDITIVE — running it twice cuts a SECOND set of items rather than reconciling the first,
so re-plan by editing what is there, not by breaking the ticket down again.

**`zee unassign`** takes the zee off a card. It is what `zee assign`'s "unassign it first" refusal
has always been asking for, and the case it exists for is a worker that died at spawn: its item is
still linked to a xell that will never work again, and nothing else can free it. The item's STATUS
is left alone (work that happened, happened) and the xell itself is untouched — unassigning reaps
nobody, and closing a worker out is still `zee suggest-done` and a human.

All three are PLAN ROWS ONLY: they create and move cards. None of them dispatches, lands, ships,
marks a xell done or opens a gate — which is exactly why they are yours unaided. The project comes
from your token, never from a flag, so a parent, ticket or item in another project is refused by
name rather than quietly created in yours. A worker running any of them is told it is a manager
verb.$hz$;

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: added the plan-cutting section (work --new / breakdown / unassign)';
END $$;
