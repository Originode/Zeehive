-- TEACH THE MANUALS THE WORK-TRACKER VERBS — `zee work`, `zee assign`, `zee item`.
--
-- A verb that is not in the manual does not exist to a zee. The work tracker (058) gave the hive a
-- plan and a board; part 3 gave agents the verbs to act on it. Those verbs reach a zee ONLY through
-- its harness memory, which lives in `harness.bundle` — so a new endpoint with no manual line is a
-- door nobody will ever open.
--
-- TWO manuals, because there are two kinds of zee and each gets only its own doors:
--
--   • the MANAGER manual (`manager`): the plan is its instrument — `zee work` (see the plan),
--     `zee assign` (deploy a worker FOR an item, briefed from the item), `zee item` (move a card),
--     plus a paragraph on WHY it should break a ticket down before dispatching anybody.
--     ⚠ The manager harness is FILE-BACKED (harnesses/manager/), and refreshHarnesses() reloads its
--     bundle from those files at every boot — so the file `harnesses/manager/memory/
--     manager-zee-manual.md` is edited in the SAME commit as this migration. Edit both or they
--     drift: the file is what wins on a machine that has the repo, this block is what teaches a
--     database whose row a human has edited by hand (harness manager) or that has no folder yet.
--   • the WORKER manual (`zee-base`): `zee work` (see the item you are executing) and `zee item`
--     (report where it has got to) — and the fact that a worker may touch its OWN item and nothing
--     else. Zee Base is DB-OWNED (dir IS NULL, see lib/harness.js), so this migration is the ONLY
--     way to change it.
--
-- Surgical and idempotent by guard, exactly as 053: anchored replacements inside the stored text,
-- applied only when the manual does not already carry them, and each anchor is an exact line from
-- the manual as it stands. If a human has edited that line, the anchor does not match and the
-- replacement simply DOES NOT FIRE — a hand-edited manual is never half-rewritten by a migration.
-- Writes back into the memory ENTRY it read (by path, by index), so other memory files on the same
-- harness are untouched.

-- ── (1) the WORKER manual (zee-base, DB-owned) ───────────────────────────────
DO $$
DECLARE
  idx int;
  txt text;
BEGIN
  SELECT (a.i - 1), a.e->>'text' INTO idx, txt
    FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') WITH ORDINALITY AS a(e, i)
   WHERE h.key = 'zee-base' AND a.e->>'path' = 'cxell-zee-manual.md'
   LIMIT 1;
  IF txt IS NULL OR txt LIKE '%zee work [--board]%' THEN RETURN; END IF;

  -- (a) the verb table
  txt := replace(txt,
    E'zee inbox [--all]                                 # read what other zees sent you',
    E'zee inbox [--all]                                 # read what other zees sent you\n'
    || E'zee work [--board] [--item <id>]                  # the WORK ITEM you are executing (its plan, ticket, history)\n'
    || E'zee item [<id>] --status <s> [--progress N] [--note "…"]   # report where YOUR work item has got to');

  -- (b) a section of its own, just before `zee done`
  txt := replace(txt,
    E'### `zee done` — propose you are finished',
    E'### `zee work` · `zee item` — the WORK ITEM you are executing\n'
    || E'`GET /api/xell/self/work` · `POST /api/xell/self/work/item`. ZEEHIVE keeps a PLAN — tickets broken\n'
    || E'down into a tree of work items (project → activity → task) on a board. Your xell may be assigned to\n'
    || E'one of those items, and if it is, the card on that board is how humans watch this job.\n'
    || E'\n'
    || E'- `zee work` shows you the item: its title and body, its ANCESTORS (which project/activity it sits\n'
    || E'  under), the ticket it came from and its children and its history — and, when it was cut from a ticket, that ticket''s own words.\n'
    || E'  Read it. It is the same material your briefing was built from, and it is the answer to "is this\n'
    || E'  in scope?".\n'
    || E'- `zee item --status working --progress 40 --note "…"` reports where you have got to. The board\n'
    || E'  already follows your hive status by itself (working, blocked, awaiting a human), so you do not\n'
    || E'  have to narrate — report when the FACT changes in a way your hexagon cannot show, and when the\n'
    || E'  work itself is finished.\n'
    || E'\n'
    || E'**You may only ever touch YOUR OWN item.** The server resolves which one that is from your token —\n'
    || E'naming somebody else''s id is refused, and so is the plan around yours. That is the same rule as\n'
    || E'everything else in the cage: your own xell, and nothing beside it.\n'
    || E'\n'
    || E'**And it is a report of FACT, not a gate.** Setting your item `done` says the WORK is finished; it\n'
    || E'does NOT mark your xell done, land anything or ship anything. Those are still `zee land` / `zee\n'
    || E'ship` / `zee done` and the humans who approve them. An item reported done with commits still only\n'
    || E'on your branch is a card that lies — land first.\n'
    || E'\n'
    || E'### `zee done` — propose you are finished');

  UPDATE harness SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(txt))
   WHERE key = 'zee-base';
  RAISE NOTICE 'cxell-zee manual: taught `zee work` and `zee item` (the work item a worker executes)';
END $$;

-- ── (2) the MANAGER manual (file-backed; this keeps a DB-only row in step) ───
DO $$
DECLARE
  idx int;
  txt text;
BEGIN
  SELECT (a.i - 1), a.e->>'text' INTO idx, txt
    FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') WITH ORDINALITY AS a(e, i)
   WHERE h.key = 'manager' AND a.e->>'path' LIKE '%manager-zee-manual.md'
   LIMIT 1;
  IF txt IS NULL OR txt LIKE '%zee assign --item%' THEN RETURN; END IF;

  -- (a) the verb table
  txt := replace(txt,
    E'zee suggest-done --to <slug> --reason "…"    # ask a human to mark that xell done (they confirm)',
    E'zee work [--board] [--item <id>]             # YOUR PROJECT''S PLAN: its work items, in tree order\n'
    || E'zee assign --item <id> --task "…"            # DEPLOY a worker for a work item (briefed FROM the item)\n'
    || E'zee item <id> --status <s> [--progress N] [--note "…"]   # move a card in your project''s plan\n'
    || E'zee suggest-done --to <slug> --reason "…"    # ask a human to mark that xell done (they confirm)');

  -- (b) the work-tracker section, just before `zee suggest-done`
  txt := replace(txt,
    E'### `zee suggest-done` — close a worker out',
    E'## The WORK TRACKER — the plan your crew executes\n'
    || E'\n'
    || E'ZEEHIVE holds tickets and a hierarchy of **work items** — project → activity → task, nested as deep\n'
    || E'as the job needs — with a status on each one and a kanban board over them. That plan is not\n'
    || E'decoration: it is the unit you dispatch against. **Break a ticket down into work items BEFORE you\n'
    || E'dispatch anybody.** A vague ticket handed straight to a worker becomes a vague brief, and a bad brief\n'
    || E'costs a whole xell; an item that has been cut properly already carries its title, its body, its\n'
    || E'ancestors, the ticket it came from and its dates — and `zee assign` folds every one of\n'
    || E'those into the worker''s briefing for free. Breaking down first also makes the work VISIBLE: each item\n'
    || E'is a card a human can see, and a card with a zee on it moves by itself.\n'
    || E'\n'
    || E'### `zee work` — your project''s plan\n'
    || E'`GET /api/xell/self/work`. Every work item in YOUR project, in tree order, with its status, who is\n'
    || E'assigned and what that zee is doing right now. `--board` drops the project root (a root is a summary\n'
    || E'row, not a card); `--item <id>` reads one item in full — body, ancestors, ticket, children and\n'
    || E'its recent history. Read this before you dispatch: an item that already has a zee on it does not need\n'
    || E'a second one.\n'
    || E'\n'
    || E'### `zee assign` — deploy a worker for an item\n'
    || E'`POST /api/xell/self/work/assign` `{ item, task?, model?, mode?, harness? }`. This is `zee dispatch`\n'
    || E'aimed at a card. The worker is spawned through the SAME path — stamped as your crew, seated next to\n'
    || E'you, on its own throwaway db, and you still cannot hand it production, the manager type or the manager\n'
    || E'harness — but its brief is built from the ITEM (title, body, ancestor chain, linked ticket, dates and\n'
    || E'priority) plus whatever `--task` text you add. It answers with the new worker''s slug. The item is then\n'
    || E'linked to that xell, and the board FOLLOWS it: as the worker works, blocks, asks for a landing or a\n'
    || E'ship, the card moves itself. You never drag it.\n'
    || E'\n'
    || E'It is refused when the item is already carrying a live zee, when the item is finished, and when the\n'
    || E'item belongs to another project. Those are sentences, not codes — read them.\n'
    || E'\n'
    || E'### `zee item` — move a card\n'
    || E'`POST /api/xell/self/work/item` `{ id, status?, progress?, note? }`. You may report any item in your\n'
    || E'OWN project (a worker may report only the one it is assigned to). Use it for the parts of the plan no\n'
    || E'zee is executing — an activity you have decided is `done`, a task you are putting `blocked` because\n'
    || E'you are waiting on a human.\n'
    || E'\n'
    || E'**What it is not:** moving a card is a report of FACT about the work. It never marks a xell done,\n'
    || E'never lands and never ships — those stay `zee suggest-done` and the humans'' gates. And the queenzee''s\n'
    || E'own sync only ever moves cards BETWEEN the in-flight statuses; `done` and `cancelled` are only ever\n'
    || E'set by a zee or a human, because finishing is a decision.\n'
    || E'\n'
    || E'### `zee suggest-done` — close a worker out');

  UPDATE harness SET bundle = jsonb_set(bundle, ARRAY['memory', idx::text, 'text'], to_jsonb(txt))
   WHERE key = 'manager';
  RAISE NOTICE 'manager-zee manual: taught `zee work`, `zee assign` and `zee item` (the work tracker)';
END $$;
