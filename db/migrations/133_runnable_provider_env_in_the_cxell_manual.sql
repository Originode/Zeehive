-- `zee creds --provider <key> --export` IN THE WORKER MANUAL — the RUNNABLE env is server-computed.
--
-- Migration 131 documented `zee creds` for the namespaced token a cage holds. That token is what a
-- cage HOLDS, not what a vendor CLI READS: to RUN the kimi CLI a zee needs KIMI_MODEL_*, codex needs
-- OPENAI_API_KEY *and* an in-cage `codex login --with-api-key` install, deepseek needs
-- ANTHROPIC_AUTH_TOKEN+BASE_URL+MODEL. That mapping lives in the runtime adapters
-- (lib/cxell-runtimes.js) and is computed SERVER-side (`GET /api/xell/self/provider-env`), never in
-- the CLI. This migration documents the `--export` flag so a zee knows the verb exists (house rule 8;
-- test/cxell-cli-drift.test.mjs §e fails the build until the manual names it).
--
-- FORM: 076's harness_memory_get/_put — by PATH, idempotent, every sibling memory entry preserved
-- (house rule 9; test/harness-memory-migrations.test.mjs fails anything that hand-rolls it). Same
-- shape as 131, which documented `zee creds` for exactly this reason. Each edit is guarded on its own
-- anchor text; an anchor that has moved does not half-edit (the section falls back to an append so the
-- verb is documented on any database, and says so with a NOTICE).
DO $mig$
DECLARE
  txt           text;
  changed       boolean := false;
  list_old      text := E'zee creds [--provider <key>] [--json]';
  list_new      text := E'zee creds [--provider <key>] [--export] [--json]';
  block_old     text := E'zee creds --provider claude        # the source-able env for ONE provider (ZEE_PROVIDER_CLAUDE_TOKEN=…)\n';
  block_new     text := E'zee creds --provider claude        # the source-able env for ONE provider (ZEE_PROVIDER_CLAUDE_TOKEN=…)\nzee creds --provider claude --export   # the RUNNABLE vendor env — what the vendor CLI actually reads (server-computed, see below)\n';
  anchor_body   text := E'the same guard the active vendor''s env goes through.';
  new_body      text;
BEGIN
  txt := harness_memory_get('zee-base', 'cxell-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'worker manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;

  -- 1. the CLI cheat-sheet line (next to its neighbour `zee env`), so the flag is discoverable at a glance.
  IF position(list_old IN txt) > 0 THEN
    txt := replace(txt, list_old, list_new); changed := true;
  ELSE
    RAISE NOTICE 'worker manual: the zee creds cheat-sheet line has moved — the --export flag was not added there';
  END IF;

  -- 2. the section's example block: add the --export example line.
  IF position(block_old IN txt) > 0 THEN
    txt := replace(txt, block_old, block_new); changed := true;
  ELSE
    RAISE NOTICE 'worker manual: the zee creds example block has moved — the --export example was not added there';
  END IF;

  -- 3. a "run another vendor's CLI" note in the section body.
  new_body := $body$
The namespaced token is what a cage HOLDS; the RUNNABLE env is what a vendor CLI READS. `zee creds
--provider <key> --export` prints the latter — SERVER-computed through the runtime adapter, so the
mapping is never duplicated in the CLI. It prints source-able `KEY=value` lines ONLY on stdout (so
`eval` is safe); notes — including codex's one-time in-cage install — go to stderr. An unknown/absent
provider fails naming what the cage holds, and a mis-attributed token is refused with the same named
sentence the spawn guard uses.
$body$;

  IF position(new_body IN txt) = 0 THEN
    IF position(anchor_body IN txt) > 0 THEN
      txt := replace(txt, anchor_body, anchor_body || E'\n\n' || new_body); changed := true;
    ELSE
      RAISE NOTICE 'worker manual: the zee creds body anchor has moved — appending the --export note at the end';
      txt := txt || E'\n' || new_body; changed := true;
    END IF;
  END IF;

  IF changed THEN
    PERFORM harness_memory_put('zee-base', 'cxell-zee-manual.md', txt);
    RAISE NOTICE 'worker manual: zee creds --export documented';
  ELSE
    RAISE NOTICE 'worker manual: zee creds --export was already documented — nothing to do';
  END IF;
END
$mig$;
