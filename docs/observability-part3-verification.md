# Verification: Observability Layer, Part 3 (LLM Gateway attribution + usage)

**Date:** 2026-08-08
**Author:** Scout (check-observability-layer-part-3-0fc61b)
**Status:** Verified; two gateway bugs found and fixed on this branch.

## What was checked

The observability layer has two grains that must both be true for a human to answer
"what did THIS xell spend?":

1. **The per-turn ledger** (`zee_turn`, migration 153, `server/src/lib/turn-ledger.js`) —
   one row per spawn/resume/interactive turn with that turn's own burn. Written at every
   turn boundary the queenzee observes (intake spawn, nudge resume, self interactive);
   read by `GET /xells/:id/observability` and `GET /turns/:id/events`.
2. **The LLM gateway** (`llm_gateway_request`, migration 154, `server/src/lib/gateway.js`) —
   one row per AI HTTP request that crossed the queenzee's transparent proxy (the grain that
   captures ALL turn kinds, including interactive TUI sessions whose stdout never reaches the
   queenzee). Read by `GET /xells/:id/gateway-requests`.
3. **The web panel** (`web/src/XellObservability.jsx`) — two tabs (Turns + Gateway calls).

## How it was verified

- **Unit tests pass** — `test/gateway.test.mjs` (sections A–G), `test/turn-ledger.test.mjs`,
  `test/interactive-turn-boundary.test.mjs`, `test/resumed-turn-accounting.test.mjs`,
  `test/turn-usage-unmetered.test.mjs` all green.
- **HTTP proxy exercised end-to-end** against a mock upstream with a real DB xell + token:
  the proxy authenticates by path token, forwards, records, completes, and reads upstream
  usage from a real SSE stream (10 in / 5 out).
- **Live server + gateway booted and probed** (built this branch): `/api/hello` on the
  gateway answers `{"ok":true}`, `/x/<token>/<provider>/api/hello` answers for both the
  `/claude` and `/deepseek` paths, an unknown xell token is a 401, a non-gateway path is
  a 404, and both observability read routes answer `{ok:true}`.

## Bugs found and fixed (commits on this branch)

### 1. The gateway env attributed deepseek to claude and kimi to openai
`gatewayEnv()` hardcoded the path provider segment to `/claude` (Anthropic dialect) and
`/openai` (OpenAI dialect). The proxy resolves the provider **account** from that path
(`resolveUpstream` → `tokenForSpawn`), so:
- a **deepseek** cxell's calls were forwarded with the project's **claude** key (to the
  claude upstream) — refused when the project had no claude account, otherwise the wrong
  vendor + key;
- a **kimi** cxell's calls were forwarded with the **openai** key — same class of bug.

`gatewayEnv()` now takes the dispatched `provider` and names it in the path
(`/x/<tok>/deepseek`, `/x/<tok>/kimi`); `intake.js` passes it through. Verified with a mock
upstream: a deepseek call now carries `Bearer sk-…deepseek` to `/anthropic/v1/messages`.

### 2. The proxy doubled `/v1` for OpenAI-dialect providers
The CLI's forward path already carries the API version (`/v1/chat/completions` from the
OpenAI SDK, whose base ends in `/v1`), and the upstream base also ended in `/v1` — so a
codex call was forwarded to `/v1/v1/chat/completions` (404 upstream). `providerUpstreamUrl()`
now strips the trailing `/v1` from the upstream base. Verified: the mock upstream saw
`/v1/chat/completions`.

### 3. The gateway ledger never set `zee_id`
Migration 154 says "the live zee of that xell at request time", but the proxy passed
`zeeId: null`, so `requestsForXell`'s `LEFT JOIN zee` always rendered `zee_name` null. The
proxy now denormalises the live zee's id at request time.

### 4. The claude upstream read the server's own `ANTHROPIC_BASE_URL`
`providerUpstreamUrl('claude')` returned `process.env.ANTHROPIC_BASE_URL`, which is the
queenzee's default-provider knob and legitimately points at deepseek in some deployments —
that would send every claude cxell call to the wrong vendor. The claude provider now
always resolves to `https://api.anthropic.com`.

## Regression tests added

`test/gateway.test.mjs` section G asserts the upstream path composition (no double `/v1`,
per-provider base path) and section D asserts provider-aware `gatewayEnv` paths.

## Known gaps (NOT fixed — out of scope for this check)

- **Grok is not routed through the gateway.** `gatewayEnv()` sets no grok base-url var and
  the grok adapter declares none, so grok cxells bypass the gateway entirely and their calls
  are invisible to the ledger. `providerUpstreamUrl` now has a `grok` case for when a door
  exists, but pointing grok at the gateway is a separate change (needs a grok base-url env
  the CLI honours).
- **Non-streaming split responses could lose usage.** If a single JSON body arrives split so
  that neither the tail nor the next chunk holds the complete JSON, `usageFromStream`'s
  non-SSE fallback returns null. Rare in practice (all first-party CLIs stream).
- **`GET /xells/:id/gateway-requests` ignores `?limit=`** — the route always uses the 50-row
  default the web sends; the query param is a no-op (harmless, the defaults agree).
- **The web panel's gateway tab does not render `zee_name`** — the data is now populated but
  the UI shows provider/model only.

## Files touched

```
M  server/src/lib/gateway.js       (gatewayEnv provider-aware path; upstream /v1 strip; claude
                                    upstream fixed; kind from provider; zee_id denormalised)
M  server/src/queenzee/intake.js   (pass the dispatched provider into gatewayEnv)
M  test/gateway.test.mjs           (section G regression; section D provider-aware env)
A  docs/observability-part3-verification.md (this file)
```
