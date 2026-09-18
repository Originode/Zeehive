-- ZEE PROD-LOGS — document the read-only production LOG verb in the worker manual.
--
-- The verb itself landed in scripts/zee + GET /api/xell/self/prod-logs + server/src/lib/prod-logs.js:
-- any zee may read the TAIL of its own project's production app-tier container log, and gets no
-- access to the container with it (no exec, no filesystem, no start/stop, no follow; the caller
-- names a ROLE, never a container; every line is credential-masked; the prod DATABASE is excluded
-- because a postgres log is production row data — that stays `zee prod` / `zee seed`).
--
-- House rule 8: what a zee is told is versioned like code — the manual, the briefing and the CLI
-- move together, and test/cxell-cli-drift.test.mjs §(e) fails the build when a verb the CLI
-- advertises is missing from the manual. House rule 9: the edit goes BY PATH through
-- harness_memory_get/_put (076), guarded on its own text, and an anchor that has moved appends at
-- the end with a NOTICE rather than failing the ledger.
--
-- `zee prod-logs` is EVERY zee's verb (read-only, project-scoped, no gate) — worker manual only.
DO $$
DECLARE
  wtxt      text;
  wchanged  boolean := false;
  wverbline text;
  wlist_anchor text := E'zee seed --file <seed.sql> --reason "…"          # ask a human to approve a LANDED seed file; the QUEENZEE runs it on PROD';
  wsection  text;
  wsec_anchor text := E'### `zee upload-conversation` — archive this xell''s conversation';
BEGIN
  wtxt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF wtxt IS NOT NULL AND wtxt NOT LIKE '%zee prod-logs%' THEN
    -- (a) the verb line in the CLI list, in the prod family next to `zee seed`.
    wverbline := E'zee prod-logs [<role>] [--tail N] [--since 30m] [--grep "…"]   # READ-ONLY tail of PRODUCTION''s own app-tier log — no container access (NOT gated)';
    IF position(wlist_anchor IN wtxt) > 0 THEN
      wtxt := replace(wtxt, wlist_anchor, wlist_anchor || E'\n' || wverbline);
      wchanged := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee seed list line has moved — the zee prod-logs list line was not added';
    END IF;

    -- (b) a section of its own, after the prod-DATA verbs and before upload-conversation.
    wsection := $hz$### `zee prod-logs` — read PRODUCTION's own log, and nothing else

`GET /api/xell/self/prod-logs`. You shipped it; this is how you find out what it SAID when it ran.
It returns the TAIL of your project's live production **app tier** container log (the roles you can
ship: `server`, `webapp`). **Every zee has it, it is NOT gated, and it grants no access to the
container** — that combination is the whole design:

```
zee prod-logs                          # what you may read (your project's prod roles)
zee prod-logs server                   # the tail of production's server log
zee prod-logs webapp --tail 500 --since 30m --grep "500"
zee prod-logs server --json            # the full answer (sources, counts, deployed sha)
```

- **You name a ROLE, never a container.** The container is resolved server-side from YOUR project
  (token → xell → project). There is no id, host, port or docker context you can pass, and none is
  ever returned — the answer carries the role, the container name, its state, the deployed sha and
  the lines.
- **It is the LOG and nothing more.** No shell, no exec, no filesystem, no start/stop/restart, no
  follow. Reading a log can never become running something in production.
- **Credentials are MASKED before the lines leave the queenzee** (`***`) — DSN passwords, bearer
  tokens, `key=value` secrets, JWTs, vendor key shapes. The answer says how many lines were masked.
  It is a mask, not a promise of purity: a secret printed in a shape nothing recognises still reads
  as text, so treat a production log as sensitive and quote from it sparingly.
- **The production DATABASE is deliberately not readable here.** A postgres log echoes statement
  text, which is production ROW DATA — that stays behind `zee prod` / `zee seed`, where a human
  decides. Asking for it is refused by name, not silently ignored.
- **Bounded**: `--tail` defaults to 200 and is capped at 1000, the read is byte-capped (you are told
  `truncated`), `--since` takes `30m`/`2h`/`1d`, and `--grep` is a plain case-insensitive substring
  (not a regex). Every read is recorded in the queenzee log with your slug — reading production is a
  fact humans can see, not a trust exercise.

**This is PRODUCTION's log. The QUEENZEE's own log is `zee ops`** (a manager's digest), and your own
xell's containers are yours already — build them and read them with `zee build`.

$hz$;
    IF position('### `zee prod-logs`' IN wtxt) = 0 THEN
      IF position(wsec_anchor IN wtxt) > 0 THEN
        wtxt := replace(wtxt, wsec_anchor, wsection || E'\n' || wsec_anchor);
      ELSE
        RAISE NOTICE 'worker manual: the upload-conversation heading has moved — appending the zee prod-logs section at the end';
        wtxt := wtxt || E'\n' || wsection;
      END IF;
      wchanged := true;
    END IF;

    IF wchanged THEN
      PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', wtxt);
      RAISE NOTICE 'worker manual: zee prod-logs documented';
    ELSE
      RAISE NOTICE 'worker manual: zee prod-logs could not be documented (anchors moved)';
    END IF;
  ELSE
    RAISE NOTICE 'worker manual: zee prod-logs is already documented (or no entry on this database) — nothing to do';
  END IF;
END $$;
