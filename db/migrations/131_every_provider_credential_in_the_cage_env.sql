-- `zee creds` IN THE WORKER MANUAL — a cage now carries EVERY connected provider's credential.
--
-- spawnCxell used to inject ONLY the dispatched provider's credential (adapter.env({token}) —
-- ANTHROPIC_AUTH_TOKEN for the claude AND the deepseek adapter alike). A zee whose task needs a
-- DIFFERENT vendor's CLI (a manager swapping a worker onto Codex, a DeepSeek cage asked to compare
-- against a Claude answer) had no way to get that vendor's key. Since 2026-08-04 the cage carries
-- every DISPATCHABLE provider's freshest ACTIVE account, each under its OWN non-colliding namespaced
-- var (ZEE_PROVIDER_<KEY>_TOKEN + a ZEE_PROVIDERS manifest), and `zee creds` reads them.
--
-- This is the half of house rule 8 that makes the verb usable: a verb no manual mentions is a verb
-- no zee knows it has, and test/cxell-cli-drift.test.mjs §e fails the build until the manual names it.
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry preserved
-- (house rule 9; test/harness-memory-migrations.test.mjs fails anything that hand-rolls it). Two
-- independent edits, each guarded on its own text: the CLI cheat-sheet line (next to its neighbour
-- `zee env` — both are "what is in this cage") and a section of its own in "The verbs". An anchor
-- that has moved does not half-edit — the section falls back to an append, so the verb is documented
-- on any database, and says so with a NOTICE.
DO $mig$
DECLARE
  txt          text;
  changed      boolean := false;
  anchor_list  text := E'zee env                                           # which environment this xell resolved to — var NAMES only (read-only)\n';
  new_list     text := E'zee creds [--provider <key>] [--json]             # what PROVIDER CREDENTIALS this cage holds — every connected provider''s key, each under its own ZEE_PROVIDER_<KEY>_TOKEN (NOT gated)\n';
  anchor_sec   text := E'### THE FLEET PAUSE — when your turn ends and you did nothing wrong';
  section      text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  section := $sec$### `zee creds` — what credentials THIS cage holds, and the env for one provider
No API call and no gate: this reads the cage's own environment. Every cxell carries EVERY connected
DISPATCHABLE provider's freshest ACTIVE account, each under its own NON-COLLIDING namespaced var —
not just the one this dispatch runs on — so a zee whose task needs a different vendor's CLI can reach
that key without asking a human to re-dispatch.

```
zee creds                          # which providers are present (account label + masked hint)
zee creds --provider claude        # the source-able env for ONE provider (ZEE_PROVIDER_CLAUDE_TOKEN=…)
zee creds --json                   # the list as JSON
```

The set rides in `ZEE_PROVIDERS` (the manifest) plus `ZEE_PROVIDER_<KEY>_TOKEN` / `_LABEL` / `_HINT`,
and it lands in BOTH `/etc/environment` (an attending human's SSH login) and the headless exec env, so
a zee finds it either way. Only DISPATCHABLE providers, freshest ACTIVE (non-paused) account each:
github (an infra credential) is never in the set, and a token unmistakably another vendor's is skipped
rather than injected under the wrong provider's name — the same guard the active vendor's env goes
through.

$sec$;

  IF position(new_list IN txt) = 0 THEN
    IF position(anchor_list IN txt) > 0 THEN
      txt := replace(txt, anchor_list, anchor_list || new_list); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the CLI list line for zee env has moved — the cheat-sheet line was not added';
    END IF;
  END IF;

  IF position('### `zee creds`' IN txt) = 0 THEN
    IF position(anchor_sec IN txt) > 0 THEN
      txt := replace(txt, anchor_sec, section || anchor_sec);
    ELSE
      -- The verb must be documented SOMEWHERE on every database (the drift lint checks exactly
      -- that), so a moved anchor appends rather than skips. Loudly, so a human can re-place it.
      RAISE NOTICE 'worker manual: the zee env section has moved — appending the zee creds section at the end';
      txt := txt || E'\n' || section;
    END IF;
    changed := true;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee creds documented';
  ELSE
    RAISE NOTICE 'worker manual: zee creds was already documented — nothing to do';
  END IF;
END
$mig$;
