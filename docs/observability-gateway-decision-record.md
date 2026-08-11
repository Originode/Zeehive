# Decision Record: The Queenzee as a Transparent LLM Gateway (LiteLLM-style)

**Date:** 2026-08-08
**Author:** Architect (implement-observability-ui-similar-to-how-re-43ca00)
**Status:** Supersedes the post-hoc-turn-parsing approach (migration 153 + turn-ledger.js). In progress.

## The report that reopened this

"it doesn't work... at most it only records spawn turn."

The previous design (migration 153, `turn-ledger.js`, `session_event.turn_id`) recorded turns by
**parsing the CLI's final `result` event** off the queenzee's own spawn/resume exec. A human
reported that only **spawn** turns appear. The diagnosis is structural, not a bug:

| turn kind | how the queenzee sees it | does post-hoc parsing see it? |
|---|---|---|
| **spawn** | `intake.js` streams `claude --bare -p --output-format stream-json` via docker exec; the feed() callback parses events | ✅ yes — this is the one that works |
| **resume** | `nudge.js` → `nudgeCxellZee` gets the whole `{code,out}` back at once (not streamed); `startTurn`/`endTurn` I added live in that path | ⚠️ only if the queenzee's new code runs that exec AND the resume completes through it |
| **interactive** | a human/manager types into the pane → a TUI whose stdout **never reaches the queenzee**. There is NO post-hoc path that can ever see it. | ❌ **impossible by construction** |

The interactive case is the kill shot: the queenzee does not start that session, does not own its
stdout, and cannot parse what it never receives. No amount of post-hoc parsing of CLI output can
fix it.

## Decision

Make the **queenzee a transparent LLM gateway** — a LiteLLM-style reverse proxy that sits in
front of every provider and that **every cxell CLI points at** via its base URL. Every AI call —
spawn, resume, or interactive — crosses the gateway, and the gateway records it at the transport
layer **before** it reaches the provider.

```
cxell CLI (claude/codex/kimi/grok — any turn kind)
        │  ANTHROPIC_BASE_URL / OPENAI_BASE_URL / KIMI_MODEL_BASE_URL → the queenzee gateway
        ▼
  ┌───────────────────────────┐
  │  QUEENZEE GATEWAY          │  records: model, prompt+response, tokens, cost, xell, turn
  │  /v1/messages (Anthropic)  │           exact usage from the upstream's own response
  │  /v1/chat/completions (OpenAI)  │   per-turn grouping (the span that started the session)
  └───────────────────────────┘
        │  the real provider credential (per-project, per-account)
        ▼
   provider API
```

Why this fixes the report **by construction**:

- **Every turn kind crosses the gateway.** The CLIs are pointed at it by their base URL env
  (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `KIMI_MODEL_BASE_URL`). A spawn, a resume, AND an
  interactive TUI session all make the same HTTP calls through the same door. There is no
  "which turn kind did the queenzee own" — the gateway sees all of them.
- **Exact usage, not parsed estimates.** The provider's own response carries the authoritative
  `usage` (input/output/cache tokens, sometimes `cost`). The gateway reads it from the upstream
  response object, not from a CLI line format that varies per vendor.
- **Attribution is identity, not parsing.** The gateway authenticates the caller by the
  per-xell identity token (`ZEEHIVE_XELL_TOKEN`, lib/xell-token.js) the cxell already carries.
  It knows WHICH xell (and by extension which zee) made every call, without needing to parse a
  session id out of CLI output.

## Context

- The fleet already had a **credential** seam: every cxell is injected with the dispatched
  provider's token (`adapter.env()` → `ANTHROPIC_AUTH_TOKEN` etc.) and, since migration 131,
  EVERY dispatchable provider's freshest ACTIVE account under namespaced vars
  (`ZEE_PROVIDER_<KEY>_TOKEN`). The gateway needs to **read** those on the queenzee side and
  **forward** them upstream — the token lives in the meta-DB already (provider_token rows).
- The fleet already had a **reverse-proxy** precedent: `lib/webapp-proxy.js` proxies
  `/xell-web/<slug>/*` with Node built-ins, streaming bodies, named 502s, and websocket
  upgrade. The gateway follows that exact shape.
- The CLIs already respect base-url env vars: the claude adapter sets `ANTHROPIC_BASE_URL`
  (and the deepseek adapter sets it to `api.deepseek.com/anthropic`); codex reads
  `OPENAI_BASE_URL`; kimi reads `KIMI_MODEL_BASE_URL`. Pointing those at the gateway is a
  change of VALUE, not a new mechanism.
- There is no LiteLLM instance anywhere in the fleet today. This is greenfield.

## Options Considered

### Option A: Stand up LiteLLM itself as the gateway
- **For:** Battle-tested; per-model pricing, load balancing, virtual keys, a web UI.
- **Rejected because:** Adds a heavy dependency (its own db/redis, its own config) that fights
  the fleet's single-process ethos and the per-project account model (LiteLLM virtual keys
  would need to mirror provider_token rows). The fleet's providers are already one credential
  each; the gateway's whole job here is a thin recording door. A 200-line Node reverse proxy
  reusing `lib/webapp-proxy.js`'s pattern is the fleet-shaped thing.

### Option B: Keep post-hoc parsing, fix the interactive gap another way (ssh into the pane and parse its tmux buffer)
- **For:** No new transport layer.
- **Rejected because:** Parsing a TUI's screen buffer is strictly worse than parsing stdout —
  it is rendering-dependent, lossy, and breaks on every vendor's UI change. It also still
  misses the resume case (a resumed headless exec does stream through nudgeCxellZee, but only
  when the queenzee owns it). A gateway removes the entire class.

### Option C: Inject a logging hook/middleware INTO each CLI (per-vendor plugin)
- **For:** Could capture per-call data close to the source.
- **Rejected because:** Per-vendor plugins are exactly the fragmentation the adapters already
  absorb, and none of the CLIs has a stable middleware hook for raw traffic. The gateway is
  vendor-neutral by construction.

### Option D: The gateway only records, and does NOT sit in the request path (a "tee")
- **For:** Zero latency added to the live call.
- **Rejected because:** A tee duplicates traffic (2× token cost for streaming calls) and cannot
  report the provider's authoritative usage before the call completes. Sitting in the path is
  the point — LiteLLM does exactly this, and the latency of one local reverse proxy is
  negligible.

## Why the Rejected Ones Were Rejected (specific costs)

| Option | Specific cost |
|---|---|
| A (LiteLLM) | New heavyweight infra + config that must mirror provider_token; fights the fleet's single-process + per-project account model. |
| B (tmux parse) | Rendering-dependent, lossy, breaks per vendor UI; still can't see the resume case reliably. |
| C (CLI plugins) | Per-vendor fragmentation; no stable raw-traffic hook in any CLI. |
| D (tee) | 2× streaming cost; cannot surface the upstream's authoritative usage. |

## Consequences

### What this makes easy
- **Every turn kind records** — the exact report that reopened this.
- **Exact tokens/cost** — read from the upstream response's own `usage`, uniform across vendors.
- **Play-by-play at the transport layer** — the gateway can persist request/response bodies
  per call (the true play-by-play), attributed to xell + turn via the identity token.
- **A future routing/guardrail/abuse seam** — once the gateway is the door, rate limits, model
  allow-lists, and cost caps become middleware on it.

### What this makes hard
- **The gateway must be reachable from the cxell** — the cxell firewall currently allows
  provider endpoints; the gateway host:port must be allow-listed. This is the main integration
  cost.
- **SSE/streaming passthrough** — the gateway must stream `text/event-stream` responses
  without buffering (the webapp proxy already does this; same pattern).
- **Per-project credential resolution** — the gateway must resolve which provider account a
  request belongs to. It authenticates the CALLER by xell token, then uses that xell's project's
  account for the requested provider (the same `tokenForSpawn`/`spawnCreds` resolution the
  spawn path uses).

### What this makes impossible
- Nothing. The post-hoc turn ledger can stay as a fallback/normalizer; the gateway supersedes
  it as the source of truth.

## Reversibility

| Step | Reversible? | How |
|------|-------------|-----|
| Gateway route on the queenzee | Yes — remove the mount; CLIs fall back to their default base URLs | |
| Point cxell base URLs at the gateway | Yes — revert `adapter.env()` to the provider's real URL | |
| Gateway request log table | Yes — stop writing it | |
| The post-hoc ledger (migration 153) | Yes — already landed and inert; keep or drop independently | |

**One-way doors:** none. The gateway is additive; every piece can be removed and the fleet
reverts to direct provider calls.

## What Would Change Our Mind

- If the gateway's in-path latency proves material (a local reverse proxy on a busy hive), a
  sidecar per cxell would move it closer but complicate the firewall story — revisit only on
  measured evidence.
- If the fleet later needs multi-project cost limits or virtual keys, LiteLLM's richer model
  becomes justified; the thin gateway is the foundation that makes that migration clean.

## Files Changed (this round)

```
A  server/src/lib/gateway.js                  (NEW — the transparent reverse proxy + recorder)
M  server/src/index.js                        (mount the gateway on the http server, before the API)
M  server/src/api/routes.js                   (gateway read model routes, if separate)
M  server/src/lib/cxell-runtimes.js           (point base URLs at the gateway)
M  server/src/lib/cxell.js                    (nudgeCxellZee env, prepareCxellAuth)
M  server/src/lib/provider-tokens.js          (gateway credential resolution, if separate)
M  docker/zeehive/cxell-firewall.sh           (allow the gateway host:port)
M  web/src/XellObservability.jsx              (render gateway records, if it replaces the turn view)
```
