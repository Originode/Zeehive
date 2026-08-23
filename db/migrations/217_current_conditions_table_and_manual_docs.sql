-- CURRENT CONDITIONS — a short, dated, per-PROJECT list of live impediments, injected into every
-- briefing and readable with `zee conditions`.
--
-- WHY (ticket #67): briefings carry TIMELESS truths (the manual, the project doc, the harness).
-- Nothing carried the DATED ones — the shared dev DSN is stale, these two tests are red on main and
-- are not yours, spinoff app tiers do not boot — so every worker rediscovered the same broken
-- environment by walking into it, and some spent hours on it. A condition is DATA (house rule 7):
-- it lives in the meta-DB and is resolved live at briefing time, never written into a doc in the
-- repo, where it would restate data the day it rots.
--
-- EPHEMERAL BY CONSTRUCTION — the failure mode this card exists to avoid is the list silently
-- becoming a SECOND MANUAL: stale lines nobody dares delete, injected forever. So each row is
-- dated (updated_at is what the briefing renders) and deleting one is a plain DELETE of a row —
-- the console and `zee conditions --remove <id>` both expose it. There is deliberately NO archive:
-- a condition that stops being true is GONE, not hidden.
--
-- Three pieces:
--
--   project_condition   the table. One row = one line. `body` is a single line, ideally carrying
--                       a ticket ref ("the shared dev DSN is stale (TKT-47) — get a database with
--                       `zee db-sandbox`"). `updated_by` names the actor who last touched it (a
--                       human in the console, or the manager xell slug). Per-project; deleting the
--                       project cascades.
--
--   worker manual       document `zee conditions` (READ) in the worker manual (harness `zee-base`,
--                       path cxell-zee-manual.md) — house rule 8: a verb a zee has must be a verb
--                       its manual names, or test/cxell-cli-drift.test.mjs fails the build.
--
--   manager manual      document `zee conditions --add/--remove` (WRITE) in the manager manual
--                       (harness `manager`, path memory/manager-zee-manual.md) — a manager is the
--                       natural author (it watches its crew hit these all evening), so it must know
--                       it can write.
--
-- Both manual edits go through the 076 helper (harness_memory_get/put) — BY PATH, every sibling
-- memory entry preserved (house rule 9; test/harness-memory-migrations.test.mjs fails anything
-- that hand-rolls jsonb against harness.bundle). An anchor that has moved appends with a NOTICE,
-- so the verb is documented on any database.

-- ── the table ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_condition (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (length(btrim(body)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_by  text
);
CREATE INDEX IF NOT EXISTS project_condition_project_idx
  ON project_condition (project_id, created_at, id);

-- ── the WORKER manual: `zee conditions` (READ) ─────────────────────────────
DO $mig$
DECLARE
  txt        text;
  changed    boolean := false;
  verbline   text;
  list_anchor text := E' zee meet create --title "…" | attend <code> | say <code> --message "…"        # GROUP CHAT: start a room (prints the code), join a room by code, post to a room — the "peer to peer a2a chat" verb (docs/zee-meet-plan.md)';
  section    text;
  sec_anchor text := E'### `zee report` · `zee inbox` — talking to your MANAGER';
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. the cheat-sheet line, after its neighbour `zee meet`.
  verbline := E' zee conditions                                # YOUR PROJECT''S CURRENT CONDITIONS: the short, dated list of LIVE IMPEDIMENTS injected into every briefing — read it any time, and trust it over any doc that is older than it is (NOT gated)';
  IF position(verbline IN txt) = 0 THEN
    IF position(list_anchor IN txt) > 0 THEN
      txt := replace(txt, list_anchor, list_anchor || E'\n' || verbline); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee meet cheat-sheet line has moved — the zee conditions list line was not added';
    END IF;
  END IF;

  -- 2. a short section of its own, before the talking-to-your-manager deep-dive.
  section := $hz$### `zee conditions` — your project's CURRENT CONDITIONS

A short, dated, per-PROJECT list of LIVE IMPEDIMENTS, injected into every briefing and readable
any time with this verb. It is the OPPOSITE of the manual: the manual is timeless, these lines are
true NOW and should be false SOON. Each line is dated; if a line stops being true it should be
DELETED (your manager edits the list, or a human in the console) — stale conditions are worse than
none. Never treat a condition as documentation and never copy one into a doc: conditions are DATA,
resolved live from the meta-DB, and a doc restates data the day it rots.

```
zee conditions                  # read this project's current conditions (any zee; NOT gated)
zee conditions --add "…"        # MANAGER: add a line (e.g. "the shared dev DSN is stale (TKT-47) — use `zee db-sandbox`")
zee conditions --remove <id>    # MANAGER: delete a line — trivial on purpose
```

$hz$;

  IF position('### `zee conditions`' IN txt) = 0 THEN
    IF position(sec_anchor IN txt) > 0 THEN
      txt := replace(txt, sec_anchor, section || sec_anchor);
    ELSE
      RAISE NOTICE 'worker manual: the report/inbox section has moved — appending the zee conditions section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee conditions documented';
  ELSE
    RAISE NOTICE 'worker manual: zee conditions was already documented — nothing to do';
  END IF;
END $mig$;

-- ── the MANAGER manual: `zee conditions --add/--remove` (WRITE) ────────────
DO $mig$
DECLARE
  txt        text;
  changed    boolean := false;
  verbline   text;
  list_anchor text := E' zee work [--board] [--item <id>]             # YOUR PROJECT''S PLAN: its work items, in tree order';
  section    text;
  sec_anchor text := E'### `zee suggest-done` — close a worker out';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. the cheat-sheet line, after its neighbour `zee work`.
  verbline := E' zee conditions [--add "…" | --remove <id>]   # YOUR PROJECT''S CURRENT CONDITIONS — the dated list of live impediments injected into every briefing; ADD lines as your crew hits them, DELETE lines the moment they stop being true';
  IF position(verbline IN txt) = 0 THEN
    IF position(list_anchor IN txt) > 0 THEN
      txt := replace(txt, list_anchor, list_anchor || E'\n' || verbline); changed := true;
    ELSE
      RAISE NOTICE 'manager manual: the zee work cheat-sheet line has moved — the zee conditions list line was not added';
    END IF;
  END IF;

  -- 2. a short section of its own, before the suggest-done deep-dive.
  section := $hz$### `zee conditions` — curate your project's CURRENT CONDITIONS

The project's current conditions are the short, dated list of LIVE IMPEDIMENTS injected into every
worker's briefing (ticket #67). You are the natural author: you watch your crew hit these all
evening. When a worker reports a broken environment it cannot fix (a dead DSN, a port it cannot
see, a red test that is not its change), ADD a line here — dated, with a ticket ref — so the next
worker does not rediscover it. The moment a line stops being true, DELETE it: stale conditions are
worse than none, and this list must never become a second manual.

```
zee conditions                          # read the current list (as it is injected)
zee conditions --add "…"                # ADD a line (a human can also edit in the console)
zee conditions --remove <id>            # DELETE a line — trivial on purpose
```

The write is MANAGER-only (`requireManager`), scoped to YOUR project by your token — the same wall
as `zee work --new`. It opens no gate and touches nothing irreversible: it is a line of text in the
meta-DB that the next briefing renders.

$hz$;

  IF position('### `zee conditions`' IN txt) = 0 THEN
    IF position(sec_anchor IN txt) > 0 THEN
      txt := replace(txt, sec_anchor, section || sec_anchor);
    ELSE
      RAISE NOTICE 'manager manual: the suggest-done section has moved — appending the zee conditions section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
    RAISE NOTICE 'manager manual: zee conditions documented';
  ELSE
    RAISE NOTICE 'manager manual: zee conditions was already documented — nothing to do';
  END IF;
END $mig$;
