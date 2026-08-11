-- THE MANAGER MANUAL: `zee dep` — a manager chains two cards from the CLI.
--
-- WHY: the gantt's "start to end goal" needs CHAINS (dependency edges: "this work waits for
-- that work"), not just nesting (parent_id: "this work is part of that"). The console drawer
-- has had the dep picker since 058; the manager CLI gained `zee dep` in the same commit as
-- the duration fallback. The manual must name the verb a manager has — the CLI-drift test
-- (section e) fails a MANAGER-only verb that no manual mentions.
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry
-- preserved (house rule 9; test/harness-memory-migrations.test.mjs fails anything that
-- hand-rolls it). Two independent edits, each guarded on its own text: the verb line in the
-- "Your verbs" list (anchored on `zee item`, its stable neighbour) and a short subsection
-- placed before "Cutting the plan yourself". An anchor that has moved appends at the end and
-- says so with a NOTICE, so the verb is documented on any database.
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  verbline  text;
  list_anchor text := E'zee item <id> --status <s> [--progress N] [--note "…"]   # move a card in your project''s plan';
  section   text;
  sec_anchor text := E'### Cutting the plan yourself — `zee work --new` · `zee breakdown` · `zee unassign`';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. the verb line in the "Your verbs" list, next to its neighbour `zee item`.
  verbline := E'zee dep --item <dependent-id> --on <prerequisite-id> [--remove]   # CHAIN two cards: --item waits for --on (a dependency edge — nesting says part-of, a chain says after)';
  IF position(verbline IN txt) = 0 THEN
    IF position(list_anchor IN txt) > 0 THEN
      txt := replace(txt, list_anchor, list_anchor || E'\n' || verbline); changed := true;
    ELSE
      RAISE NOTICE 'manager manual: the zee item list line has moved — the zee dep list line was not added';
    END IF;
  END IF;

  -- 2. a short section of its own, before the cutting-the-plan deep-dive.
  section := $hz$### `zee dep` — chain two cards (the gantt's critical path)

A card may DEPEND ON another card: `--item` (the dependent) waits for `--on` (the
prerequisite). Nesting (`parent_id`) says "part of"; a chain (`dependency`) says "after" —
and a start-to-end-goal gantt draws the chain as the critical path, so the plan's order
comes from here, not from how the tree happens to be indented. The console drawer has the
same picker (`depends on` on a card); this is the CLI half.

```
zee dep --item <dependent-id> --on <prerequisite-id>     # "dependent waits for prerequisite"
zee dep --item <dependent-id> --on <prerequisite-id> --remove
```

Both ends must be in YOUR project, never an ancestor/descendant pair (the model's I6 refuses
an ancestor-edge), and a self-edge is refused. Do NOT invent chains to make a chart pretty —
chain what is really "after": a deploy waits for the code, a ship waits for the deploy, the
end goal waits for the last card.

$hz$;

  IF position('### `zee dep`' IN txt) = 0 THEN
    IF position(sec_anchor IN txt) > 0 THEN
      txt := replace(txt, sec_anchor, section || sec_anchor);
    ELSE
      RAISE NOTICE 'manager manual: the cutting-the-plan section has moved — appending the zee dep section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
    RAISE NOTICE 'manager manual: zee dep documented';
  ELSE
    RAISE NOTICE 'manager manual: zee dep was already documented — nothing to do';
  END IF;
END $$;
