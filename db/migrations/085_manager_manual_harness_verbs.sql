-- THE MANAGER MANUAL: the verbs that let a manager mint its OWN project's worker personas (084).
--
-- 084 gave a manager `/api/xell/self/harness*` and scripts/zee gave it `zee harness`, and no manual
-- said a word about either — so the fleet's managers had a verb they could not know they had, and
-- the only place it was written down was the CLI's own `--help`. A capability an agent is never told
-- about is the same as one that does not exist.
--
-- What the entry has to convey, and why each part is in it rather than left to be inferred:
--   * the verbs, briefly (the flag detail is the CLI's usage text — restating it here would drift);
--   * a persona a manager creates belongs to ITS OWN project, and the scope comes from the TOKEN, so
--     "which project?" is not a question it can ask;
--   * the way to specialise is to INHERIT a system-wide worker harness (`--parent`), never to edit
--     one — editing the fleet's shared vocabulary is refused, and forking it strands the craft;
--   * creating or editing a MANAGER persona is refused, WITH the reason: a manager that can mint
--     managers grows the fleet sideways with nobody's consent.
--
-- SHORT on purpose: this text is paid for on every manager dispatch, and `dev-lead` inherits it.
-- test/cxell-cli-drift.test.mjs now FAILS when a manager-only CLI verb is missing from this manual,
-- which is the guard that would have caught 084 landing silent.
--
-- Anchored + idempotent in the 065/071/079 sense: it returns early when the section is already
-- there, refuses to guess when an anchor has moved, and goes through harness_memory_put (house rule
-- 9 / 076) so every sibling memory entry survives. No folder half any more — 080 detached every
-- harness row (`dir = NULL`), so the row is the only source and there is no bundle_hash to clear.
DO $$
DECLARE
  txt      text;
  verbline text;
  section  text;
  anchor   text := 'zee say --to <slug> --message "…"            # type a message straight into a worker''s live session';
  tracker  text := '## The WORK TRACKER — the plan your crew executes';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%cast a ROLE of your own%' THEN
    RAISE NOTICE 'manager manual: the zee harness section is already there';
    RETURN;
  END IF;
  IF position(anchor IN txt) = 0 OR position(tracker IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: an anchor has moved — left untouched (add the zee harness section by hand)';
    RETURN;
  END IF;

  verbline := $hz$zee harness [<key>] [--new] [--delete] [--parent <key>] [--personality-file <f>]
                                             # YOUR PROJECT'S worker personas: list, read, mint, edit$hz$;

  section := $hz$### `zee harness` — cast a ROLE of your own
`GET/POST/PUT/DELETE /api/xell/self/harness*`. The persona is what makes two workers on the same task
do different things, and you may author your own: bare `zee harness` lists the ones your project can
use, `zee harness <key>` reads one, `--new --label "…" --parent <key>` mints one, `--delete` removes
one of yours. Then dispatch into it with `--harness <key>`.

A persona you create belongs to **your project** — the scope comes from your token, never from a flag
— so no other project sees it, wears it or inherits it. It is not gated: a worker in a persona you
wrote still meets every gate every other worker meets.

**Specialise by INHERITING, not by editing.** The system-wide personas (`zee-base` carries the cxell
manual, `dev-base` the dev craft) are the fleet's shared vocabulary and are refused you — `--parent`
one instead and add only what this project needs, so their craft keeps reaching your crew from one
place.

**A MANAGER persona is refused**, created or edited: managers are added by humans, and a manager that
can mint managers grows the fleet sideways with nobody's consent.

$hz$;

  txt := replace(txt, anchor, anchor || E'\n' || verbline);
  txt := replace(txt, tracker, section || tracker);

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: added the zee harness verbs (a manager mints its own project''s personas)';
END $$;
