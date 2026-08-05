-- THE MANAGER MANUAL, again: 123's plan-cutting section, behind a guard that cannot false-positive.
--
-- 123 appended the `zee work --new` / `zee breakdown` / `zee unassign` section and guarded the append
-- with `txt LIKE '%zee breakdown%'` — the VERB NAME. The manual is human-editable in the console's
-- harness manager, so any manager who had written the verb name into it (asking for the verb, noting
-- it was missing, quoting the refusal that names it) makes 123 RETURN and the section never lands.
-- Silently: nothing fails, no migration errors, and test/cxell-cli-drift.test.mjs §e is satisfied by
-- that same human sentence — it lints that the verb is MENTIONED, not that the section is there. The
-- fleet's managers would simply not have the verbs, on the one database where it mattered.
--
-- So: the same text, guarded on the section's own HEADING, which nothing but this migration writes.
-- Idempotent (a database that ran 123 already has the heading and is left alone), forward-only (123
-- is landed and applied; it is not edited), and by PATH through harness_memory_put — house rule 9 /
-- 076 — so every sibling memory entry survives.
--
-- Kept verbatim from 123 apart from the item-shape line: `zee breakdown` now whitelists what an item
-- may carry, so the manual lists exactly the accepted keys.
DO $$
DECLARE
  txt text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%### Cutting the plan yourself%' THEN
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
`{title, kind?, body?, parent_id?, ref?, priority?, starts_on?, due_on?}` — those keys and no others,
because the file is input and a card is PLAN: it is refused by name if an entry tries to carry a zee,
a status or a progress. A later entry may name an earlier entry's `ref` as its `parent_id`, which is
how one call expresses activities with tasks under them. It is ONE transaction: either the whole plan
exists or the ticket is untouched. It is also ADDITIVE — running it twice cuts a SECOND set of items
rather than reconciling the first, so re-plan by editing what is there, not by breaking the ticket
down again.

**`zee unassign`** takes the zee off a card. It is what `zee assign`'s "unassign it first" refusal
has always been asking for, and the case it exists for is a worker that died at spawn: its item is
still linked to a xell that will never work again, and nothing else can free it. The item's STATUS
is left alone (work that happened, happened) and the xell itself is untouched — unassigning reaps
nobody, and closing a worker out is still `zee suggest-done` and a human. If the zee is still LIVE
the answer says so, and means it: that worker's `zee work` goes blank and its `zee item` is refused
from then on, and it is not told unless you tell it (`zee say --to <slug>`).

All three are PLAN ROWS ONLY: they create and move cards. None of them dispatches, lands, ships,
marks a xell done or opens a gate — which is exactly why they are yours unaided. The project comes
from your token, never from a flag, so a parent, ticket or item in another project is refused by
name rather than quietly created in yours — including when it is named by its UUID. A worker running
any of them is told it is a manager verb.$hz$;

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: added the plan-cutting section (work --new / breakdown / unassign)';
END $$;
