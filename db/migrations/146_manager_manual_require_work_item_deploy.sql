-- THE MANAGER MANUAL: a manager deploys through the work-items board, and `zee dispatch` is the
-- ROUTER's verb.
--
-- The fleet kept producing DUPLICATE deployments — two workers on one unit of work (TKT-104
-- triple-dispatch, TKT-110 assign-race, TKT-114 two-router-runs, a router free-form dispatch that
-- spawned a second identical architect). The work-items board is the deployment tool that prevents
-- that: deployWorkItem holds a per-item advisory lock (TKT-110) and refuses a second worker on an
-- item that already has one. A free-form `zee dispatch` (itemless) has no such guard. The code
-- refuses `zee dispatch` for a manager now (the ROUTER's verb — a router routes prompts with it,
-- and manager-spawn uses the raw dispatch path, so neither breaks); the manual must move with it
-- (house rule 8 — test/cxell-cli-drift.test.mjs fails the build if they drift).
--
-- SURGICAL BY DESIGN: migration 059 writes the work-tracker verb block and the whole WORK TRACKER
-- section, and test/work-assign.test.mjs asserts those bytes VERBATIM in the stored manual. So this
-- migration edits ONLY text migration 080 wrote (the "what you are for" list, the hard limits, the
-- `zee dispatch` verb line and section, the "Refused for you" list) and ADDS one standalone section
-- before the WORK TRACKER heading — never 059's replacement text.
--
-- FORM: 137's shape — 076's harness_memory_get/_put, by PATH, idempotent, every sibling memory
-- entry preserved (house rule 9). Each edit is anchored on exact stored text; an anchor a human has
-- moved makes that replacement not fire and says so with a NOTICE, never a half-rewritten manual.
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  rule1_anchor text := E'1. **Cut work into tasks and dispatch workers.**';
  rule1_new text;
  limit1_anchor text := E'and you land none. If something must change in the repo, **dispatch a worker**.';
  limit1_new text;
  dispatch_verb_anchor text := E'                                             # spawn a WORKER zee into a fresh xell, stamped as yours';
  dispatch_verb_new text;
  dispatch_sec_anchor text := E'reads as a cluster rather than scattered across the grid.\n\nWhat you may not set, because the queenzee refuses it:';
  dispatch_sec_new text;
  refused_anchor text := E'Refused for you, always: `zee land`, `zee prod` (you already hold prod read-only; a full bind is a';
  refused_new text;
  board_sec text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%the board is the ONLY way a manager deploys%' THEN
    RAISE NOTICE 'manager manual: the board-required deploy rule is already there';
    RETURN;
  END IF;

  -- 1. "What you are for" rule 1: deploy through the board, not just "dispatch workers".
  rule1_new := E'1. **Cut work into tasks and deploy workers through the board.** One job per worker, briefed well enough that it can';
  IF position(rule1_anchor IN txt) > 0 THEN
    txt := replace(txt, rule1_anchor, rule1_new);
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: "what you are for" rule 1 anchor has moved — not rewritten';
  END IF;

  -- 2. Hard limit 1: dispatch a worker → deploy a worker onto a work item.
  limit1_new := E'and you land none. If something must change in the repo, **deploy a worker onto a work item** (`zee assign`).';
  IF position(limit1_anchor IN txt) > 0 THEN
    txt := replace(txt, limit1_anchor, limit1_new);
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: hard-limit 1 anchor has moved — not rewritten';
  END IF;

  -- 3. The verb list's continuation line for `zee dispatch`: say it is the router's verb.
  dispatch_verb_new := E'                                             # REFUSED for a manager — the ROUTER''s verb; you deploy through the board: `zee assign`';
  IF position(dispatch_verb_anchor IN txt) > 0 THEN
    txt := replace(txt, dispatch_verb_anchor, dispatch_verb_new);
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: the zee dispatch verb continuation has moved — not rewritten';
  END IF;

  -- 4. The dispatch section: insert a REFUSED paragraph before "What you may not set".
  dispatch_sec_new := E'reads as a cluster rather than scattered across the grid.\n\n'
    || E'**This verb is REFUSED for you.** A free-form dispatch has no per-item guard, which is exactly how the\n'
    || E'fleet produced duplicate workers — two dispatches for one unit of work each spawn a worker and the board\n'
    || E'never sees either. The ROUTER zee (your project''s front door) is the one manager-type zee whose job is\n'
    || E'free-form dispatch: it routes one worker per request. Your deployment tool is the board: cut a card\n'
    || E'(`zee work --new --title "…"`, or `zee breakdown`) and `zee assign --item <id> --task "…"` — an item\n'
    || E'admits at most one live worker, so a second deploy on the same item is refused with a sentence.\n\n'
    || E'What you may not set, because the queenzee refuses it:';
  IF position(dispatch_sec_anchor IN txt) > 0 THEN
    txt := replace(txt, dispatch_sec_anchor, dispatch_sec_new);
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: the zee dispatch section anchor has moved — not rewritten';
  END IF;

  -- 5. The "Refused for you, always" list: name the board rule.
  refused_new := E'Refused for you, always: `zee land`, `zee prod` (you already hold prod read-only; a full bind is a\n'
    || E'write escalation and is not yours to ask for), `zee dispatch` (deploying through the board — `zee assign`\n'
    || E'— is the only manager deployment path; the ROUTER routes prompts with `zee dispatch`), and any dispatch\n'
    || E'option that would widen a worker beyond its own xell.';
  IF position(refused_anchor IN txt) > 0 THEN
    txt := replace(txt, refused_anchor, refused_new);
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: the "Refused for you, always" anchor has moved — not rewritten';
  END IF;

  -- 6. A STANDALONE section, placed BEFORE the WORK TRACKER heading (never inside 059's replacement).
  board_sec := $hz$

### The board is the ONLY way a manager deploys

A free-form `zee dispatch` is refused for you: it has no per-item guard, and a dispatch without a card is
exactly how the fleet produced duplicate workers — two zees on one unit of work, both invisible on the
board. The work-items board closes that: an item admits at most one live worker, and a second deploy on the
same item is refused with a sentence. So a manager's deployment path is:

1. cut a card (`zee work --new --title "…"`, or break a ticket down with `zee breakdown`), then
2. `zee assign --item <id> --task "…"` — the worker is briefed from the item (title, body, ancestors,
   ticket, dates) plus your task text, and the board follows it from there.

The ROUTER zee is the one manager-type zee whose job is free-form `zee dispatch`: it routes one worker
per request. You are not the router — deploy through the board.

$hz$;
  -- Insert before "## The WORK TRACKER" heading
  IF position(E'\n## The WORK TRACKER — the plan your crew executes' IN txt) > 0 THEN
    txt := replace(txt, E'\n## The WORK TRACKER — the plan your crew executes',
                        E'\n' || board_sec || E'\n## The WORK TRACKER — the plan your crew executes');
    changed := true;
  ELSE
    RAISE NOTICE 'manager manual: the WORK TRACKER heading has moved — the board section was not inserted';
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
    RAISE NOTICE 'manager manual: a manager deploys through the work-items board (zee dispatch refused; zee assign is the deployment path)';
  ELSE
    RAISE NOTICE 'manager manual: nothing to patch (all anchors already in place)';
  END IF;
END $$;
