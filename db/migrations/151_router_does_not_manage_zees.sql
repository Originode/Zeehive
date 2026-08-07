-- TRAIN THE ROUTER TO NOT MANAGE ZEES — the router's job is the FRONT DOOR, not the crew.
--
-- The router's whole product is intake: recompose a raw prompt, pick the harness, and put a worker
-- on it. Until now it did that with the manager crew verbs — `zee dispatch` stamped the worker into
-- the router's OWN crew (`manager_xell_id = router`), the brief told the worker "a MANAGER ZEE
-- (router) dispatched you and is watching this xell", and the router could `zee zees` / `zee say` /
-- `zee suggest-done` over the zees it routed. That made the router a de-facto MANAGER of the very
-- zees it was only supposed to route — a crew lead with a front door's job.
--
-- This migration is the trainer's edit, in three pieces that land together:
--
--   (1) THE PERSONA (the prose half). The router's "What you do" is rewritten so its deploy step is
--       the BOARD — cut a card if none exists (`zee work --new`), then `zee assign --item <id>` — and
--       "What you are not" now says plainly that it does NOT manage the zees it deploys: no watching,
--       no messaging, no progress updates to itself, and a PROGRAMME is a human-approved manager
--       (`zee mint-manager`), never the router's own crew.
--
--   (2) THE MANAGER MANUAL (the law half, house rule 8: what a zee is told moves with the CLI). The
--       manual has been telling managers "the ROUTER's job is free-form `zee dispatch`" — that is the
--       exact sentence this migration removes. A router routes prompts onto cards, exactly like a
--       manager deploys onto cards; neither free-form dispatches.
--
--   (3) THE CODE IS ALREADY SHIPPED ALONGSIDE THIS FILE (self.js / work-assign.js / router.js):
--       router-dispatched workers are NOT stamped into the router's crew, the brief names no
--       manager, and the crew verbs (`zee zees`, `zee say`, `zee swap`, `zee suggest-done`,
--       `zee conversations`) are refused for a router by name. This migration is the text that
--       teaches the router to live inside those walls.
--
-- Guarded + idempotent, the 149 pattern: each block reads the current text, no-ops when the change
-- is already present, NOTICEs when an anchor has moved (never guesses), and goes through
-- `harness_memory_put` for memory (house rule 9 / 076). A console edit to either text survives:
-- every replace is anchored to the exact sentence it supersedes, and a database that already
-- carries this change is left untouched.

-- ── (A) THE ROUTER PERSONA ─────────────────────────────────────────────────────────────────────
-- Four anchored replaces, each guarded by "is the new text already there?" so re-running is a no-op.
DO $mig$
DECLARE
  txt text;
  new_t text;
BEGIN
  SELECT bundle->>'personality' INTO txt FROM harness WHERE key = 'router' AND project_id IS NULL;
  IF txt IS NULL THEN
    RAISE NOTICE '151: no router harness on this database — nothing to brief';
    RETURN;
  END IF;

  -- (A1) Step 3: the concurrency cap is counted on the BOARD, not a crew the router no longer has.
  IF position('Count the live workers on your board' in txt) > 0 THEN
    RAISE NOTICE '151: router persona already counts the board for max_concurrent — no-op';
  ELSIF position('Count your live crew (`zee zees`)' in txt) > 0 THEN
    txt := replace(txt,
      'Count your live crew (`zee zees`); at the cap, hold the',
      'Count the live workers on your board (`zee work --board`); at the cap, hold the');
    RAISE NOTICE '151: router persona — max_concurrent now counts the board, not a crew';
  ELSE
    RAISE NOTICE '151: router persona max_concurrent anchor moved — left untouched (patch by hand)';
  END IF;

  -- (A2) Step 4: the deploy verb is the BOARD, never free-form `zee dispatch`.
  IF position('**Deploy onto a card.**' in txt) > 0 THEN
    RAISE NOTICE '151: router persona already deploys onto cards — no-op';
  ELSIF position('`zee dispatch --task "<recomposed brief>"' in txt) > 0 THEN
    new_t := '4. **Deploy onto a card.** The board is the only deployment path. If the work is already a card'
          || E'\n   on it, assign that one; if not, cut a card first — `zee work --new --title "…" --body "…"` —'
          || E'\n   then `zee assign --item <id> --task "<recomposed brief>" --provider <key> --model <m>'
          || E'\n   --mode <n> --harness <key>`. The card admits at most one live worker, so a second deploy'
          || E'\n   on the same item is refused with a sentence. Then REPORT what you routed and why, in one'
          || E'\n   message: the provider (and its weight-share reasoning), model, mode, harness, and the'
          || E'\n   recomposed brief. The human decides from your report, so it must name every choice you made.';
    txt := replace(txt,
      '4. **Dispatch** — `zee dispatch --task "<recomposed brief>" --provider <key> --model <m>'
   || E'\n   --mode <n> --harness <key>` — then REPORT what you routed and why, in one message: the'
   || E'\n   provider (and its weight-share reasoning), model, mode, harness, and the recomposed brief.'
   || E'\n   The human decides from your report, so it must name every choice you made.',
      new_t);
    RAISE NOTICE '151: router persona — the deploy step is now the board';
  ELSE
    RAISE NOTICE '151: router persona dispatch anchor moved — left untouched (patch by hand)';
  END IF;

  -- (A3) The ONE-SHOT paragraph names the board, not a crew, for where its state lives.
  IF position('`zee work --board` for the plan and the concurrency cap' in txt) > 0 THEN
    RAISE NOTICE '151: router persona already points the one-shot at the board — no-op';
  ELSIF position('`zee zees` for your crew and the concurrency cap' in txt) > 0 THEN
    txt := replace(txt,
      '`zee zees` for your crew and the concurrency cap, `zee work --board` for the plan, `zee inbox`',
      '`zee work --board` for the plan and the concurrency cap, `zee inbox`');
    RAISE NOTICE '151: router persona — one-shot orientation drops the crew, keeps the board';
  ELSE
    RAISE NOTICE '151: router persona one-shot anchor moved — left untouched (patch by hand)';
  END IF;

  -- (A4) "What you are not": the router does NOT manage the zees it deploys. This REPLACES the 149
  -- "You do not CREATE managers" block (whose mint-manager escalation is now folded in below), so
  -- the two paragraphs do not age apart — the trainer's copy-rot rule: one rule, one place.
  IF position('You do not manage the zees you route' in txt) > 0 THEN
    RAISE NOTICE '151: router persona already carries the do-not-manage block — no-op';
  ELSIF position('You do not CREATE managers' in txt) > 0 THEN
    new_t := E'You do not manage the zees you route. Your job is the front door: recompose the prompt, pick\n'
          || E'the harness, put a worker on a card — and then you are DONE with that zee. The card is its\n'
          || E'anchor and progress goes to the board (`zee work` / `zee item`), never to you. You have no crew:\n'
          || E'`zee zees`, `zee say`, `zee swap`, `zee suggest-done` and `zee conversations` are REFUSED for a\n'
          || E'router, and you must not tell a deployed zee to report to you. If a request is genuinely a\n'
          || E'PROGRAMME rather than a task — several strands, a crew, work that outlives one worker — that is\n'
          || E'a MANAGER\'s job, and a manager is added by a human: file the ask with\n'
          || E'`zee mint-manager --reason "why one well-briefed worker will not do" --task "the programme"` and\n'
          || E'LET the manager run it. A rejection means "dispatch a worker", which is the common answer.\n'
          || E'One open ask at a time, and never for a job you could brief a single zee to finish.\n'
          || E'\n';
    txt := replace(txt,
      'You do not CREATE managers — but when a request is genuinely a PROGRAMME rather than a task'
   || E'\n(several strands, a crew, work that outlives one worker''s cage), you may ASK a human for one:'
   || E'\n`zee mint-manager --reason "why one worker will not do" --task "the programme"`. A human decides'
   || E'\nand the queenzee mints it; a rejection means "dispatch a worker", which is the common answer.'
   || E'\nOne open ask at a time, and never for a job you could brief a single zee to finish.'
   || E'\n',
      new_t);
    RAISE NOTICE '151: router persona — 149''s CREATE-managers block replaced by do-not-manage';
  ELSIF position('**You are ONE-SHOT.**' in txt) > 0 THEN
    new_t := E'You do not manage the zees you route. Your job is the front door: recompose the prompt, pick\n'
          || E'the harness, put a worker on a card — and then you are DONE with that zee. The card is its\n'
          || E'anchor and progress goes to the board (`zee work` / `zee item`), never to you. You have no crew:\n'
          || E'`zee zees`, `zee say`, `zee swap`, `zee suggest-done` and `zee conversations` are REFUSED for a\n'
          || E'router, and you must not tell a deployed zee to report to you. If a request is genuinely a\n'
          || E'PROGRAMME rather than a task — several strands, a crew, work that outlives one worker — that is\n'
          || E'a MANAGER\'s job, and a manager is added by a human: file the ask with\n'
          || E'`zee mint-manager --reason "why one well-briefed worker will not do" --task "the programme"` and\n'
          || E'LET the manager run it. A rejection means "dispatch a worker", which is the common answer.\n'
          || E'One open ask at a time, and never for a job you could brief a single zee to finish.\n'
          || E'\n';
    txt := replace(txt, '**You are ONE-SHOT.**', new_t || '**You are ONE-SHOT.**');
    RAISE NOTICE '151: router persona — do-not-manage block inserted before the one-shot close';
  ELSE
    RAISE NOTICE '151: router persona one-shot close moved — left untouched (patch by hand)';
  END IF;

  UPDATE harness SET bundle = jsonb_set(bundle, '{personality}', to_jsonb(txt))
   WHERE key = 'router' AND project_id IS NULL;
END $mig$;

-- ── (B) THE MANAGER MANUAL ─────────────────────────────────────────────────────────────────────
-- Four anchored replaces, all removing the now-false "the ROUTER's job is free-form `zee dispatch`".
DO $mig$
DECLARE
  txt text;
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE '151: no manager manual on this database — nothing to document';
    RETURN;
  END IF;

  -- (B1) the CLI block: `zee dispatch` is refused for EVERY manager, router included.
  IF position('REFUSED for every manager, router included' in txt) > 0 THEN
    RAISE NOTICE '151: manager manual already refuses dispatch for every manager — no-op';
  ELSIF position('REFUSED for a manager — the ROUTER''s verb; you deploy through the board' in txt) > 0 THEN
    txt := replace(txt,
      'REFUSED for a manager — the ROUTER''s verb; you deploy through the board: `zee assign`',
      'REFUSED for every manager, router included — the board is the only deployment path: `zee assign`');
    RAISE NOTICE '151: manager manual — `zee dispatch` refused for every manager';
  ELSE
    RAISE NOTICE '151: manager manual CLI block anchor moved — left untouched (patch by hand)';
  END IF;

  -- (B2) the "Refused for you, always" block.
  IF position('a ROUTER routes prompts onto cards, it does not free-form dispatch' in txt) > 0 THEN
    RAISE NOTICE '151: manager manual refused-block already says a router routes onto cards — no-op';
  ELSIF position('the ROUTER routes prompts with `zee dispatch`)' in txt) > 0 THEN
    txt := replace(txt,
      '— is the only manager deployment path; the ROUTER routes prompts with `zee dispatch`)',
      '— is the only manager deployment path; a ROUTER routes prompts onto cards, it does not free-form dispatch)');
    RAISE NOTICE '151: manager manual — refused block says a router routes onto cards';
  ELSE
    RAISE NOTICE '151: manager manual refused-block anchor moved — left untouched (patch by hand)';
  END IF;

  -- (B3) the `zee dispatch` section's router sentence.
  IF position('routes prompts onto CARDS, never free-form' in txt) > 0 THEN
    RAISE NOTICE '151: manager manual dispatch section already says the router routes onto cards — no-op';
  ELSIF position('The ROUTER zee (your project''s front door) is the one manager-type zee whose job is' in txt) > 0 THEN
    txt := replace(txt,
      'The ROUTER zee (your project''s front door) is the one manager-type zee whose job is'
   || E'\nfree-form dispatch: it routes one worker per request. Your deployment tool is the board: cut a card',
      'The ROUTER zee (your project''s front door) routes prompts onto CARDS, never free-form: it is not'
   || E'\nexempt from the board. Your deployment tool is the board: cut a card');
    RAISE NOTICE '151: manager manual — dispatch section says the router routes onto cards';
  ELSE
    RAISE NOTICE '151: manager manual dispatch-section anchor moved — left untouched (patch by hand)';
  END IF;

  -- (B4) "The board is the ONLY way a manager deploys" close.
  IF position('A ROUTER is not exempt either' in txt) > 0 THEN
    RAISE NOTICE '151: manager manual board section already says a router is not exempt — no-op';
  ELSIF position('The ROUTER zee is the one manager-type zee whose job is free-form `zee dispatch`' in txt) > 0 THEN
    txt := replace(txt,
      'The ROUTER zee is the one manager-type zee whose job is free-form `zee dispatch`: it routes one worker'
   || E'\nper request. You are not the router — deploy through the board.',
      'A ROUTER is not exempt either — it routes prompts onto cards and does not manage the workers it deploys.'
   || E'\nIf a request is a programme, a router asks a human for a manager (`zee mint-manager`) and lets the'
   || E'\nmanager run it. You are not the router — deploy through the board.');
    RAISE NOTICE '151: manager manual — board section says a router is not exempt';
  ELSE
    RAISE NOTICE '151: manager manual board-section anchor moved — left untouched (patch by hand)';
  END IF;

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
END $mig$;
