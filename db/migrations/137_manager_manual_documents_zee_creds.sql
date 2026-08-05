-- THE MANAGER MANUAL: `zee creds` — a manager's cage carries EVERY connected provider's credential,
-- and the manual never said the verb exists.
--
-- spawnCxell (131) has carried every DISPATCHABLE provider's freshest ACTIVE account into every
-- cage since 2026-08-04, `zee creds` reads them, and 133 documented `--export`. But that shipped
-- documented in the WORKER manual ONLY (migrations 131 and 133 edit `cxell-zee-manual.md`). The
-- manager harness does not inherit zee-base (`harness.parent_id` is NULL for 'manager'), so a
-- manager xell receives `memory/manager-zee-manual.md` and never the cxell manual — and a manager
-- runs in the SAME kind of cage, now holding every provider key, with no way to know the verb is
-- there. The CLI-drift test cannot see the gap: its per-type rule only requires MANAGER-only verbs
-- in the manager manual, and `zee creds` is an every-zee verb.
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry preserved
-- (house rule 9; test/harness-memory-migrations.test.mjs fails anything that hand-rolls it). Two
-- independent edits, each guarded on its own text: the verb line in the "Your verbs" list (anchored
-- on `zee working`, its stable neighbour) and a short section of its own before the first crew-verb
-- deep-dive. An anchor that has moved does not half-edit — the section falls back to an append so
-- the verb is documented on any database, and says so with a NOTICE. What a MANAGER needs is kept
-- short and pointed at docs/cxell-provider-env.md for the rest (house rule 7: nothing the API
-- resolves is restated here).
DO $$
DECLARE
  txt       text;
  changed   boolean := false;
  verbline  text;
  list_anchor text := E'zee working [--note "…"]                     # ping "I am actively working" (NOT gated)';
  section   text;
  sec_anchor text := E'### `zee dispatch` — spawn a worker';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. the verb line in the "Your verbs" list, next to its neighbour `zee working`.
  verbline := E'zee creds [--provider <key>] [--export] [--json]   # what PROVIDER CREDENTIALS this cage holds — every connected provider''s key, each under its own ZEE_PROVIDER_<KEY>_TOKEN (NOT gated)';
  IF position(verbline IN txt) = 0 THEN
    IF position(list_anchor IN txt) > 0 THEN
      txt := replace(txt, list_anchor, list_anchor || E'\n' || verbline); changed := true;
    ELSE
      RAISE NOTICE 'manager manual: the zee working list line has moved — the zee creds list line was not added';
    END IF;
  END IF;

  -- 2. a short section of its own, placed before the first crew-verb deep-dive.
  section := $hz$### `zee creds` — what this cage holds

Your cage carries every connected DISPATCHABLE provider's freshest ACTIVE account, each under its
own `ZEE_PROVIDER_<KEY>_TOKEN` — never github, never a paused account, never a token that is
unmistakably another vendor's. `zee creds` reads them: `--provider <key>` prints the source-able
namespaced env for one, `--export` the RUNNABLE vendor env (server-computed), `--json` the list. A
worker's cage carries the same set, so a brief that needs a different vendor's CLI needs no
re-dispatch and no key handed over.

A cage is only ever handed the account it was GRANTED; a rotated key reaches a live cage only
through a human-approved credential-injection request the QUEENZEE performs. You neither inject nor
approve — never ask a worker to copy a key by hand. The full contract is `docs/cxell-provider-env.md`.

$hz$;

  IF position('### `zee creds`' IN txt) = 0 THEN
    IF position(sec_anchor IN txt) > 0 THEN
      txt := replace(txt, sec_anchor, section || sec_anchor);
    ELSE
      -- The verb must be documented SOMEWHERE on every database, so a moved anchor appends rather
      -- than skips. Loudly, so a human can re-place it.
      RAISE NOTICE 'manager manual: the zee dispatch section has moved — appending the zee creds section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
    RAISE NOTICE 'manager manual: zee creds documented';
  ELSE
    RAISE NOTICE 'manager manual: zee creds was already documented — nothing to do';
  END IF;
END $$;
