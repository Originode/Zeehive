-- DOCUMENT THE STABLE API ADDRESS A CAGE CAN TRUST (ticket #94).
--
-- ZEEHIVE_API=http://zeehive_server:4700 was injected into every cage and FLAPPED: the compose
-- service name does not resolve while the queenzee container is being recreated (getaddrinfo
-- ENOTFOUND), and from a sealed container that DNS error reads as "the fleet is down" when it is
-- really one name not resolving. The CODE half of the fix (this migration is the TOLD half):
--   * the queenzee now injects the STABLE address http://host.docker.internal:4700 (the queenzee's
--     published port on the host) as ZEEHIVE_API, and cxellRunArgs adds the host-gateway alias so
--     the name resolves on native Linux too (Docker Desktop adds it automatically);
--   * the compose-network name (http://zeehive_server:4700) is injected as ZEEHIVE_API_FALLBACK —
--     the second name a script or the CLI can try when the primary does not resolve;
--   * the `zee` CLI retries ZEEHIVE_API_FALLBACK on a network error and says so (scripts/zee).
-- House rule 8: what a zee is told is versioned like code, so the manual must say the same thing —
-- that is what this migration writes.
--
-- Surgical and idempotent by guard (the 220 pattern): harness_memory_get/_put BY PATH (076, house
-- rule 9), anchored replacements inside the stored text, applied only if the manual does not
-- already carry them. The seam is the intro of the `## The zee CLI` section — never inside 059's
-- protected verb-table block. A human who moved the anchor gets a NOTICE, never a half-rewritten
-- manual.
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  intro     text;
  addition  text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'zee manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  IF txt LIKE '%ZEEHIVE_API_FALLBACK%' THEN
    RAISE NOTICE 'zee manual: the stable API address is already documented — nothing to do';
    RETURN;
  END IF;

  -- The intro of the `## The zee CLI` section — the sentence that already says where the CLI
  -- reaches the queenzee. The addition goes immediately after it, before the verb table.
  intro := $hz$`zee` is on your `PATH`. Use it — do not hand-roll curl. It reads `ZEEHIVE_XELL_TOKEN` and calls the
queenzee at `host.docker.internal:4700` (firewall-allowed).$hz$;

  IF position(intro IN txt) > 0 THEN
    addition := $hz$

The queenzee API address a SCRIPT should trust is injected as `ZEEHIVE_API` — the STABLE
`http://host.docker.internal:4700` (the queenzee's published port on the host: it always resolves,
and only ever fails with a legible connection-refused while the queenzee is actually down). A
compose service name like `http://zeehive_server:4700` FLAPS — it does not resolve while the
queenzee container is being recreated, and a `getaddrinfo ENOTFOUND zeehive_server` from a sealed
cage reads as "the fleet is down" when it is really one name not resolving. If a script's
`$ZEEHIVE_API` fails to resolve, point it at `$ZEEHIVE_API_FALLBACK` (the second name injected for
exactly this) or at the stable address above — never conclude the queenzee is gone. The `zee` CLI
does this for you: on a network error it retries the fallback and tells you what happened.
$hz$;
    txt := replace(txt, intro, intro || addition);
    changed := true;
  ELSE
    RAISE NOTICE 'zee manual: the zee-CLI intro has moved — the API-address paragraph was not added';
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'zee manual: the stable API address is now documented';
  ELSE
    RAISE NOTICE 'zee manual: nothing to patch (the anchors did not match)';
  END IF;
END $$;
