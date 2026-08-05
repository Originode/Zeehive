-- LANGFUSE PLUGIN — ONE system-wide observability instance (user ruling 2026-08-03: "there
-- should only be one langfuse instance for the whole system").
--
-- ZEEHIVE orchestrates AI agents (zees) inside cxells. Langfuse is the self-hosted LLM
-- observability stack (web UI + worker + postgres + clickhouse + redis + minio) that records
-- model calls, token burn, and traces. This migration adds the meta-DB half of the plugin:
--
--   (A) langfuse_config — a SINGLE-ROW table holding the whole plugin's state: is it enabled,
--       what status is the stack in, where it runs (docker_ctx, published ports), the three
--       base URLs (queenzee-facing, cxell-facing, human-visible), the trace credentials
--       (public/secret key — stored FULL, masked on the API, revealed only to a human, exactly
--       like lib/provider-tokens.js), the initial admin login, and an optional LLM-gateway URL.
--
--       It is deliberately NOT a `container` row: container.project_id is NOT NULL REFERENCES
--       project, and this is GLOBAL infrastructure — it belongs to no project, no xell, and the
--       reaper must never touch it. A dedicated single-row table is the honest home, and it can
--       never collide with per-project container logic.
--
--   (B) A manager-manual note (house rule 9): managers get LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL
--       injected into their cxell env at spawn, so they can analyze what their crew did by
--       querying the Langfuse public API. The note tells them the keys exist and gives the one
--       curl they need. No new `zee` verb (house rule 8: a verb must be advertised, implemented
--       AND manual-documented — env + curl is the honest surface today).
--
-- The row is created DISABLED by default: the plugin is opt-in, provisioned by a human clicking
-- Setup in the console (lib/langfuse.js, mode-gated like every other real side effect).

-- ── (A) the single-row config ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS langfuse_config (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),   -- the one-row trick
  enabled       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'off'
                  CHECK (status IN ('off','provisioning','up','down','error')),
  error         text,                                          -- last provisioning/probe failure
  docker_ctx    text,                                          -- the daemon the stack runs on
  host_port     int,                                           -- langfuse-web published host port
  minio_port    int,                                           -- minio console published host port
  compose_project text,                                        -- `docker compose -p` project name
  base_url      text,        -- queenzee-facing base (http://localhost:<host_port>) — where the
                             -- queenzee itself POSTs ingestion
  client_base_url text,      -- cxell-facing base (http://host.docker.internal:<host_port>) — what
                             -- zees get in LANGFUSE_BASE_URL
  ui_url        text,        -- human-facing link (http://localhost:<host_port> unless overridden)
  public_key    text,        -- pk-lf-… (trace project public key) — stored FULL
  secret_key    text,        -- sk-lf-… (trace project secret key) — stored FULL
  public_key_hint text,      -- masked hint, the only thing the API ever shows
  secret_key_hint text,
  admin_email   text,        -- the initial Langfuse admin login (LANGFUSE_INIT_USER_EMAIL)
  admin_name    text,
  admin_password text,       -- stored FULL like any provider_token; revealed only to a human
  admin_password_hint text,
  gateway_url   text,        -- optional LLM gateway (LiteLLM-style passthrough) — null unless set;
                             -- when set, cxells ALSO get provider base-url overrides pointing at it
  provisioned_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row exists from the moment the migration applies; enabled=false is the plugin off state.
INSERT INTO langfuse_config (id)
SELECT true WHERE NOT EXISTS (SELECT 1 FROM langfuse_config WHERE id = true);

-- ── (B) MANAGER MANUAL (manager → manager-zee-manual.md): the Langfuse analysis door ─────────
-- A manager holds the whole picture of its crew, and Langfuse is where the record of what they
-- did lives. The queenzee injects the three LANGFUSE_* vars into EVERY cxell at spawn when the
-- plugin is enabled; this note tells a manager they exist and how to use them. Anchored +
-- idempotent (house rule 9), never throws on a moved anchor — the drift test owns that case.
DO $$
DECLARE
  txt  text;
  para text;
  sec  text := '### `zee conversations` — review your crew''s conversation archives';
BEGIN
  txt := harness_memory_get('manager', 'memory/manager-zee-manual.md');
  IF txt IS NULL THEN
    RAISE NOTICE 'manager manual: no memory entry on this database — nothing to patch';
    RETURN;
  END IF;
  IF txt LIKE '%Langfuse%' THEN
    RAISE NOTICE 'manager manual: the Langfuse note is already present';
    RETURN;
  END IF;
  IF position(sec IN txt) = 0 THEN
    RAISE NOTICE 'manager manual: anchor section not found — add the Langfuse note by hand';
    RETURN;
  END IF;

  para := E'### `Langfuse` — the observability record of what your crew did\n'
       || E'When the Langfuse plugin is enabled, the queenzee posts a TRACE of every finished zee turn\n'
       || E'(tokens, cost, model, session) and of every archived conversation to your instance, and your\n'
       || E'cxell is injected with `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`.\n'
       || E'That is your window into how your workers actually spent tokens and what they produced:\n'
       || E'\n'
       || E'```sh\n'
       || E'# list recent traces (public API, Basic auth = public:secret key)\n'
       || E'curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \\\n'
       || E'  "$LANGFUSE_BASE_URL/api/public/traces?limit=20"\n'
       || E'# fetch one trace''s observations (its token usage + model)\n'
       || E'curl -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \\\n'
       || E'  "$LANGFUSE_BASE_URL/api/public/traces/<traceId>"\n'
       || E'```\n'
       || E'\n'
       || E'Every trace carries `metadata.xell_slug` and `metadata.zee_id`, so you can filter the record\n'
       || E'to a single worker (`?metadata={"xell_slug":"<slug>"}` is not a URL-safe filter — pull and\n'
       || E'filter client-side, or use the web UI at the `ui_url` a human sees in the console). The\n'
       || E'public API is read-only for traces/sessions/scores; writing needs the UI or the ingestion\n'
       || E'endpoint, which the queenzee owns. Use it to audit burn, spot a runaway worker, or review\n'
       || E'what a zee did before you suggest it done.\n'
       || E'\n';
  txt := replace(txt, sec, para || sec);

  PERFORM harness_memory_put('manager', 'memory/manager-zee-manual.md', txt);
  RAISE NOTICE 'manager manual: documented the Langfuse analysis surface';
END $$;
