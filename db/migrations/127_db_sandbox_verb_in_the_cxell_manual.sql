-- `zee db-sandbox` IN THE WORKER MANUAL — the verb that ends "I could not verify it here".
--
-- What happened (ticket #62). The DATABASE_URL the queenzee writes into .zeehive.env is refused by
-- the shared dev db (ticket #47), so on one night three zees INDEPENDENTLY invented the same
-- workaround: `npm i embedded-postgres` in /tmp, a real PostgreSQL on 127.0.0.1, `npm run
-- db:migrate`, tests pointed at it. It works, and it is entirely inside the cage. Two other zees
-- never found it, ran three hours and verified nothing — which is the whole cost: the cage HAS
-- everything needed to verify database work, and nothing told anybody.
--
-- So the workaround is now a verb (scripts/zee: `zee db-sandbox`), and this is the half of house
-- rule 8 that makes it usable: a verb no manual mentions is a verb no zee knows it has, and
-- test/cxell-cli-drift.test.mjs §e fails the build until the manual names it.
--
-- THE ONE THING THE TEXT MUST KEEP SAYING: the sandbox is never a silent replacement for the
-- assigned DATABASE_URL and never a fallback when the assigned db is unreachable. A broken assigned
-- database has to stay visible — that is ticket #47's actual bug and #53's readiness preflight; a
-- quiet substitution would delete the only signal anyone has that it is broken.
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry preserved
-- (house rule 9; test/harness-memory-migrations.test.mjs fails anything that hand-rolls it). Three
-- independent edits, each guarded on its own text: the CLI list, golden rule 6, and a section of its
-- own in "The verbs". An anchor that has moved does not half-edit — the section falls back to an
-- append, so the verb is documented on any database, and says so with a NOTICE.
DO $mig$
DECLARE
  txt      text;
  changed  boolean := false;
  -- 1. the CLI cheat-sheet, right under its neighbour `zee db-catchup` (both are "your own db")
  anchor_list text := E'zee db-catchup [--restore]                        # roll your OWN db (clone/isolated) forward to prod''s schema (NOT gated)\n';
  new_list    text := E'zee db-sandbox [--migrate] [--status] [--stop]    # a REAL throwaway postgres INSIDE this cage, on 127.0.0.1 (NOT gated)\n';
  -- 2. golden rule 6 — where a zee reads "verify", it should learn that db work is verifiable in here
  anchor_r6 text := E'docker) and exercise the real thing before you call the work done. "I wrote it" is not verification.';
  new_r6    text := E'docker) and exercise the real thing before you call the work done. "I wrote it" is not verification.\n'
                 || E'   When the work is DATABASE work and your assigned db is unusable, `zee db-sandbox` gives you a\n'
                 || E'   real postgres of your own in here — see below. It is an addition, never a substitute: report\n'
                 || E'   the broken assigned db as well.';
  -- 3. the section itself, before `zee migration-number` (the CLI's own order)
  anchor_sec text := E'### `zee migration-number` — a migration number two zees cannot both take';
  section    text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  section := $sec$### `zee db-sandbox` — a REAL database of your own, inside the cage
No API call and no gate: this one starts a **throwaway PostgreSQL on 127.0.0.1 INSIDE your own
container**, prints its DSN, and can migrate it and stop it again. It writes only to a database that
dies with the cage, so there is nothing to ask anybody for.

```
zee db-sandbox --migrate          # start postgres in here + apply db/migrations; prints the DSN
zee db-sandbox                    # start it (a second start returns the SAME DSN — never a second server)
zee db-sandbox --status           # is one running, and on what DSN
zee db-sandbox --stop             # stop it (the data dir is kept, so a later start reuses your schema)

DATABASE_URL="$(zee db-sandbox --migrate | sed -n 's/.*"dsn": "\(.*\)".*/\1/p')" node test/<name>.test.mjs
```

**This is how you verify database work in a cage.** A test that needs a database, a migration you
want to watch apply, a query you want to run for real — all of it is available in here, in seconds.
"I could not verify it in this xell" is not an acceptable end to a database job: three zees invented
this by hand in one night (ticket #62) and two more never thought of it and verified nothing.

**It does NOT replace your assigned `DATABASE_URL`, and it is NOT a fallback.** The verb prints a
DSN; what you do with it is your explicit choice — you pass it to the one command you meant. If your
assigned database is unreachable or refuses your credentials (ticket #47), that is a REAL fault and
it must stay visible: say so in your report, and `zee tend --reason "…"` if it blocks you. A sandbox
quietly standing in for a broken assigned db would delete the only signal anyone has.

- It reaches **nothing on the fleet**. The host is the literal `127.0.0.1`, the port is one bound on
  this container's loopback, and postgres is started with `listen_addresses=127.0.0.1` — no prod, no
  shared dev, no other xell, by construction rather than by promise.
- The first start installs the postgres binaries (`embedded-postgres`, pinned to the major version
  the fleet runs) unless your project's SPAWN PREP already warmed them — with the warm step on, a
  start is seconds.
- It is **your own database, not the meta-DB's clone**: it starts EMPTY. `--migrate` applies
  `db/migrations` to it; anything else you need, you seed yourself.

$sec$;

  IF position(new_list IN txt) = 0 THEN
    IF position(anchor_list IN txt) > 0 THEN
      txt := replace(txt, anchor_list, anchor_list || new_list); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the CLI list line for zee db-catchup has moved — the cheat-sheet line was not added';
    END IF;
  END IF;

  IF position(new_r6 IN txt) = 0 THEN
    IF position(anchor_r6 IN txt) > 0 THEN
      txt := replace(txt, anchor_r6, new_r6); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: golden rule 6 has moved — the db-sandbox pointer was not added there';
    END IF;
  END IF;

  IF position('### `zee db-sandbox`' IN txt) = 0 THEN
    IF position(anchor_sec IN txt) > 0 THEN
      txt := replace(txt, anchor_sec, section || anchor_sec);
    ELSE
      -- The verb must be documented SOMEWHERE on every database (the drift lint checks exactly
      -- that), so a moved anchor appends rather than skips. Loudly, so a human can re-place it.
      RAISE NOTICE 'worker manual: the zee migration-number section has moved — appending the db-sandbox section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee db-sandbox documented';
  ELSE
    RAISE NOTICE 'worker manual: zee db-sandbox was already documented — nothing to do';
  END IF;
END
$mig$;
