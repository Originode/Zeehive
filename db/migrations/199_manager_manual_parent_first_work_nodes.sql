-- THE MANAGER MANUAL: the parent-first work_node workflow — ONE parent work_node, a CHAIN of
-- children toward its completion, break down ONLY when necessary, out-of-scope work is a TICKET.
--
-- WHY: the manager plan verbs landed parent-first guardrails (918cd3b) — a parentless leaf TASK
-- is now REFUSED with a sentence ("a task needs a home — establish the parent work_node first
-- (`zee work --new --kind activity --title "…"`), nest this one under it with --parent, or file a
-- ticket (`zee ticket`) if it is outside the current plan"), and `zee work --new --after
-- <sibling-id>` creates a card under the sibling's SAME parent AND adds the FS dependency in one
-- call. The console board is a swimlane matrix — one collapsible row per parent work_node
-- (8e40f67). House rule 8: the manual must move with the CLI and the board, or a manager is
-- briefed for a workflow the verbs no longer allow (free-form top-level card creation) and never
-- learns the one they do (parent-first).
--
-- SURGICAL AND GUARDED per house rule 9 — harness_memory_get/_put BY PATH, never a hand-rolled
-- jsonb against the memory array (test/harness-memory-migrations.test.mjs fails anything that
-- does). Four independent edits, each anchored on its own exact stored text; an anchor a human has
-- moved makes THAT replacement not fire and says so with a NOTICE, never a half-rewritten manual:
--
--   1. the `zee work --new` verb line in the plan-cutting section gains `[--after <sibling-id>]`
--      (anchored on the verb line itself, which 124 wrote and nothing else has moved);
--   2. the dispatch section's "cut a card (`zee work --new --title "…"` …)" — a parentless task is
--      refused now, so the cut must name the activity parent;
--   3. the board section's "1. cut a card (`zee work --new --title "…"` …)" — same contradiction;
--   4. a standalone `### Parent-first` section, placed BEFORE the cutting-the-plan deep-dive
--      (never inside 059's replacement text), teaching the whole workflow and quoting the exact
--      refusal sentence the guardrail lands. Guarded on its own HEADING — the same lesson 124
--      taught: guard on what only this migration writes, not on a verb name a human may mention.
--
-- IDEMPOTENT: the verb-line edit guards on the new text already being present; the section guards
-- on its heading; the two trims fire only while the OLD free-form wording is still there. Running
-- this file twice (past the ledger, or on a database that already has the section) is a no-op.
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  verb_anchor text := E'zee work --new --title "…" [--body "…"] [--kind task|activity] [--parent <id>] [--ticket <code|id>] [--priority 1..5]';
  verb_new text;
  dispatch_anchor text := E'(`zee work --new --title "…"`, or `zee breakdown`) and `zee assign --item <id> --task "…"` — an item';
  dispatch_new text;
  board_anchor text := E'1. cut a card (`zee work --new --title "…"`, or break a ticket down with `zee breakdown`), then';
  board_new text;
  sec_anchor text := E'### Cutting the plan yourself — `zee work --new` · `zee breakdown` · `zee unassign`';
  section text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. The `zee work --new` verb line gains `--after <sibling-id>` (the create-and-chain shorthand).
  verb_new := E'zee work --new --title "…" [--body "…"] [--kind task|activity] [--parent <id>] [--after <sibling-id>] [--ticket <code|id>] [--priority 1..5]';
  IF position(verb_new IN txt) > 0 THEN
    NULL; -- already applied (idempotent re-run)
  ELSIF position(verb_anchor IN txt) > 0 THEN
    txt := replace(txt, verb_anchor, verb_new);
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: the work --new verb line has moved — --after not added';
  END IF;

  -- 2. Dispatch section: a parentless task is refused, so the cut must be `--kind activity`.
  dispatch_new := E'(`zee work --new --kind activity --title "…"`, or `zee breakdown`) and `zee assign --item <id> --task "…"` — an item';
  IF position(dispatch_new IN txt) > 0 THEN
    NULL; -- already applied (idempotent re-run)
  ELSIF position(dispatch_anchor IN txt) > 0 THEN
    txt := replace(txt, dispatch_anchor, dispatch_new);
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: the dispatch-section "cut a card" line has moved — not rewritten';
  END IF;

  -- 3. Board section: same contradiction, same fix.
  board_new := E'1. cut a parent work_node first (`zee work --new --kind activity --title "…"`, or break a ticket down with `zee breakdown`), then';
  IF position(board_new IN txt) > 0 THEN
    NULL; -- already applied (idempotent re-run)
  ELSIF position(board_anchor IN txt) > 0 THEN
    txt := replace(txt, board_anchor, board_new);
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: the board-section step-1 line has moved — not rewritten';
  END IF;

  -- 4. The standalone parent-first section, before the cutting-the-plan deep-dive.
  section := $hz$### Parent-first — establish ONE home for the work

The plan is a TREE: a **parent work_node** (kind `activity`) that encompasses the full extent of the
work, with children cut under it. Establish that ONE parent FIRST, before any task exists — the
parent is what the work is FOR; the children are the steps toward it.

```
zee work --new --kind activity --title "…"     # establish the parent work_node (the whole job)
zee work --new --title "…" --parent <id>       # a child task under that parent
zee work --new --title "…" --after <sibling>   # create-and-chain: under the sibling's SAME parent, and WAITS for it
zee dep --item <dependent-id> --on <prerequisite-id>   # chain two existing cards (they stay siblings)
```

**A task needs a home.** A parentless leaf TASK is refused, exactly:

> `a task needs a home — establish the parent work_node first (`zee work --new --kind activity --title "…"`), nest this one under it with --parent, or file a ticket (`zee ticket`) if it is outside the current plan.`

A parentless ACTIVITY stays allowed — that IS how a parent is established.

**Chain children toward the parent's completion.** `--after <sibling-id>` is the common
create-and-chain gesture: it nests the new card under that sibling's SAME parent AND adds the
dependency (the new card waits for the sibling) in one call. `zee dep` adds or removes a chain
between EXISTING cards. Siblings in the same parent are the shape for genuinely PARALLEL strands —
do not chain things that do not really wait on each other.

**Break down ONLY when necessary.** If one assigned zee can do the whole job, do not split it.
Splitting for optics is theatre — every card costs a briefing and a watch.

**Out-of-scope work is a TICKET.** Something outside the current plan's parent is `zee ticket`,
never a stray work_node. No random unrelated cards: the board is ONE plan, not a free-form pile.

$hz$;

  IF position('### Parent-first' IN txt) = 0 THEN
    IF position(sec_anchor IN txt) > 0 THEN
      txt := replace(txt, sec_anchor, section || E'\n' || sec_anchor);
    ELSE
      RAISE NOTICE 'manager manual: the cutting-the-plan section has moved — appending the parent-first section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
    RAISE NOTICE 'manager manual: parent-first work_node workflow documented';
  ELSE
    RAISE NOTICE 'manager manual: parent-first work_node workflow was already documented — nothing to do';
  END IF;
END $$;
