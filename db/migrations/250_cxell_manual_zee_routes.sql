-- ZEE ROUTES — document the router's directory half in the worker manual
-- (docs/netbird-mesh-plan.md §3.4; the verb landed in scripts/zee + /api/xell/self/routes).
--
-- House rule 8: what a zee is told is versioned like code — the manual, the briefing and the CLI
-- move together, and test/cxell-cli-drift.test.mjs §(e) fails the build when a verb the CLI
-- advertises is missing from the manual. House rule 9: the edit goes BY PATH through
-- harness_memory_get/_put (076), guarded on its own text, and an anchor that has moved appends at
-- the end with a NOTICE rather than failing the ledger.
--
-- `zee routes` is EVERY zee's verb (read-only, self-scoped, no gate) — worker manual only.
DO $$
DECLARE
  wtxt      text;
  wchanged  boolean := false;
  wverbline text;
  wlist_anchor text := E'zee env                                           # which environment this xell resolved to — var NAMES only (read-only)';
  wsection  text;
  wsec_anchor text := E'### `zee creds` — what credentials THIS cage holds, and the env for one provider';
BEGIN
  wtxt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF wtxt IS NOT NULL AND wtxt NOT LIKE '%zee routes%' THEN
    -- (a) the verb line in the CLI list, next to its neighbour `zee env`.
    wverbline := E'zee routes                                        # HOW TO REACH YOUR STUFF, resolved LIVE from the meta-DB (never baked): your db/server/webapp, each with a source — mesh hostname+canonical port, or the recorded legacy host:port — plus the fallback pair and a bounded db liveness probe (NOT gated)';
    IF position(wlist_anchor IN wtxt) > 0 THEN
      wtxt := replace(wtxt, wlist_anchor, wlist_anchor || E'\n' || wverbline);
      wchanged := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee env list line has moved — the zee routes list line was not added';
    END IF;

    -- (b) a short section of its own, before the creds section.
    wsection := $hz$### `zee routes` — how to reach your stuff, resolved live

`GET /api/xell/self/routes`. Your `.zeehive.env` is a SNAPSHOT: it is stamped when the cage is
created and never re-minted, so the addresses in it rot — a shared dev db restarts on another
port, a stack moves machines, and the file cannot tell you. `zee routes` is the LIVE answer:
the queenzee derives, at call time, how THIS xell reaches its own db, server and webapp (and the
shared containers it uses), and says for each answer which world produced it:

- `source: "mesh"` — your xell has a joined mesh peer: the answer is its mesh hostname (and IP)
  on the CANONICAL role port, the same port every xell uses. The legacy host:port pair rides
  along as `fallback` while both are true.
- `source: "legacy-port"` — no mesh peer yet: the recorded host:port, exactly what your
  `.zeehive.env` was generated from.

The db answer carries a ready-to-use `dsn` (mesh answers re-address the projected DSN — same
credentials, same database, a different door) and a bounded liveness `probed` verdict
(`ok`/`refused`/`unknown`) — advice, never a gate. Read-only, self-scoped (you only ever hear
about your OWN stack), opens no gate. **When `.zeehive.env` and `zee routes` disagree, `zee
routes` is the current answer** — reach for it the moment a recorded address refuses, before
concluding a database is down.

$hz$;
    IF position('### `zee routes`' IN wtxt) = 0 THEN
      IF position(wsec_anchor IN wtxt) > 0 THEN
        wtxt := replace(wtxt, wsec_anchor, wsection || E'\n' || wsec_anchor);
      ELSE
        RAISE NOTICE 'worker manual: the creds section heading has moved — appending the zee routes section at the end';
        wtxt := wtxt || E'\n' || wsection;
      END IF;
      wchanged := true;
    END IF;

    IF wchanged THEN
      PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', wtxt);
      RAISE NOTICE 'worker manual: zee routes documented';
    ELSE
      RAISE NOTICE 'worker manual: zee routes could not be documented (anchors moved)';
    END IF;
  ELSE
    RAISE NOTICE 'worker manual: zee routes is already documented (or no entry on this database) — nothing to do';
  END IF;
END $$;
