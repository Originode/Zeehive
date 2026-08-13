# A2A in ZEEHIVE — the protocol plan for every agent-to-agent conversation

**Status:** DESIGN — proposed, nothing built. Companion decision record:
[a2a-protocol-decision-record.md](a2a-protocol-decision-record.md).
**Author:** Architect (xell `implement-a2a-protocol-whenever-two-agents-a-52f81f`)
**Date:** 2026-08-11
**Directive (verbatim):** *implement a2a protocol whenever two agents are talking to each other.*
**Protocol pinned:** A2A **v1.0** (Linux Foundation, `a2aproject/A2A` tag `v1.0.1`), JSON-RPC
binding — PascalCase methods (`SendMessage`, `GetTask`, …), SSE streaming, Agent Card at
`/.well-known/agent-card.json`, `A2A-Version` header. Facts below were read from the v1.0.1
`specification/a2a.proto` and `docs/specification.md`, not recalled.

---

## 1. The inventory: where two agents actually talk in ZEEHIVE today

"Whenever two agents are talking to each other" has a precise answer in this codebase, and it is
smaller than it sounds. Everything below was read from the code, with the authoritative file named.

| # | conversation | mechanism today | agent↔agent? |
|---|---|---|---|
| C1 | **manager → worker** directive (`zee say`) | `postMessage` → `zee_message` (kind `directive`) → `sendMessageToXell` delivery (`server/src/lib/managers.js`, `queenzee/nudge.js:552`) | **yes** |
| C2 | **worker → manager** report / post-ship reflection (`zee report`) | same store-then-deliver, kinds `report` / `reflection` | **yes** |
| C3 | **console → router** routing request | `zee_message` kind `directive` (`🧭 ROUTING REQUEST`, docs/router-zee.md) | human→agent, but the *envelope* is the same row |
| C4 | **queenzee → zee** continuations (landing stale, runway clearance, fleet resume, reflection prompt) | `sendMessageToXell` resume path | **no** — the queenzee is a *pure-script orchestrator* (package.json's own words), not an agent |
| C5 | **zee → model** | LLM gateway `/x/<token>/<provider>` (`index.js:251`) | no — agent→model |
| C6 | **zee → tools / host surface** | MCP (`mcp/server.js`), `zee` CLI | no — agent→tool and agent→orchestrator |
| C7 | **plane-3 execution hand-over** (`zee handover` → `execution.outputs`) | interim store until the stage-2 data plane (docs/hierarchical-workflow-model.md) | agent→agent *data*, mediated by the workflow model |
| C8 | **external agent ⇄ fleet agent** | **does not exist** — the nearest thing is the ticketing API (`/api/ext/v1/*`, keys `zhk_…`, migration 190), which is app→fleet, not agent↔agent | the interop A2A exists for |

**Scope of this design: C1, C2, C3 (the `zee_message` plane) gain A2A envelopes and an A2A read
side; C8 is the new door A2A opens; C7 is a named seam (execution outputs ⇄ A2A Artifacts), not
built. C4–C6 are explicitly out** — see DR-1 for why, and what was rejected. **DR-8 (2026-08-13)
extends the conversation set** to the three non-`zee_message` stores that ARE conversations —
`xell_conversation` archives (112), `zee_conversation` working memory (192), `zee_turn` ledger
(153) — each projecting to deterministic A2A Tasks (uuid v5 at read time, nothing stored).
`session_event` stays out (the control-plane hook log, not a conversation). See
[the decision record](a2a-protocol-decision-record.md) DR-8.

Two structural facts drive everything else:

1. **Zees have no network path to each other.** The cxell wall is the product: a cage reaches its
   own containers, the registries and the queenzee API — never another xell. A2A's native
   deployment (every agent runs its own HTTP server, peers call it) is *structurally impossible
   here without demolishing the containment*, and the containment is not negotiable (DR-2).
2. **Agent messages are already store-then-deliver through one mediator.** `postMessage` writes the
   durable `zee_message` row, then delivery types/queues/resumes into the recipient's session
   (`decideMessageDelivery`, `server/src/lib/zee-turn.js:57`). The row is the audit a human reads.
   Any A2A adoption that bypasses that row deletes the fleet's memory of what its agents said.

So: **ZEEHIVE speaks A2A at one place — the queenzee API — as a multi-agent (tenant-scoped) A2A
server, and the existing `zee_message` machinery becomes the A2A task store by projection.** Zees
keep their verbs; the wire grows a standard.

---

## 2. Boundary

One A2A **service**, many A2A **agents**:

- **The A2A server is the queenzee API process.** After the gateway split
  (docs/queenzee-gateway-split-decision-record.md, DR-1) these routes belong on the **gateway**
  side; the delivery work stays in the loops process and the send path crosses that design's DR-4
  channel exactly like every other route that asks the loops to act.
- **Each live zee is one A2A agent**, addressed by tenant path — v1.0's REST bindings are already
  tenant-scoped (`/{tenant}/message:send` in `a2a.proto`), and the JSON-RPC binding scopes by URL.
  The tenant key is the **xell slug** (stable for the xell's life, already the public name on every
  hexagon, survives zee swaps — the *seat* is the agent, the way the console already treats it).
- **Zees never serve A2A themselves and never dial each other directly.** A zee's A2A "client" is
  a queenzee-mediated call (its existing verbs today; a `zee a2a` verb for external targets in
  phase 4), so every agent-to-agent exchange stays recorded at the transport layer — the same
  transparency stance that pointed langchain at the gateway instead of the provider
  (docs/langchain-stateful-zees.md §2.1: nothing depends on an agent volunteering its own data).

```
external A2A agent ──HTTP(S), zhk_ key──▶ ┌────────────────────────────────┐
                                          │  queenzee API  (A2A server)    │──▶ zee_message (store)
zee (cxell) ──zee CLI / xell token──────▶ │  /a2a/v1/…  one URL per agent  │──▶ sendMessageToXell (deliver)
                                          └────────────────────────────────┘──▶ SSE bus (stream)
```

## 3. Interfaces

### 3.1 Discovery

| URL | serves | notes |
|---|---|---|
| `GET /.well-known/agent-card.json` | the **fleet card** — the queenzee API as an A2A service | RFC 8615 requires origin root; there is one origin, so the root card describes the service and points at the directory |
| `GET /a2a/v1/agents` | **directory** (extension — A2A defines no registry): live agents, each with its card URL | filtered to what the caller's credential may see (§3.4) |
| `GET /a2a/v1/agents/:slug/card` | the **per-agent card** | generated per request from live rows — house rule 7: names/containers/status are DATA, never baked into a static file |

Per-agent card mapping (v1.0 `AgentCard`, required fields all present):

| card field | from |
|---|---|
| `name` / `description` | zee name + xell slug / the task brief's first lines + harness label |
| `supportedInterfaces` | one `AgentInterface`: `{ url: "<base>/a2a/v1/agents/<slug>", protocolBinding: "JSONRPC", tenant: "<slug>", protocolVersion: "1.0" }` — `tenant` is the spec's own field for "multiple agents served behind a single A2A endpoint" (`a2a.proto`, `AgentInterface.tenant`) |
| `provider` | `{ organization: "ZEEHIVE", url: <console url> }` |
| `version` | the xell's `head_commit` short sha — the honest version of an agent that is a worktree |
| `capabilities` | `{ streaming: true, pushNotifications: false, extendedAgentCard: false }` (phase-gated; false until built) |
| `securitySchemes` / `securityRequirements` | HTTP bearer (§3.4) |
| `defaultInputModes` / `defaultOutputModes` | `["text/plain"]` (v1: text parts only — matches `zee_message.body`) |
| `skills` | from the harness row (`lib/harness.js`): one `AgentSkill` per harness skill (`id`=skill key, `description`=its *When:* line), plus one for the zee's task |

### 3.2 JSON-RPC methods (v1.0 names) — and what each maps to

Endpoint: `POST /a2a/v1/agents/:slug` (`Content-Type: application/json`, `A2A-Version: 1.0`).

| method | maps to | notes |
|---|---|---|
| `SendMessage` | `postMessage({from, to, body, kind})` — store-then-deliver, unchanged | sender resolved from the credential, **never** from the payload; text parts concatenated into `body`; `DataPart`/`FilePart` → `ContentTypeNotSupportedError` (-32005) in v1 |
| `SendStreamingMessage` | `SendMessage` + subscribe (SSE) | rides the existing `broadcast('zee-message', …)` bus; first event is the Task, then status-update events |
| `GetTask` | projection read (§4) over `zee_message` + `zee_turn` | `TaskNotFoundError` (-32001) for ids with no enveloped row |
| `ListTasks` | same projection, filtered to the caller's visibility | only enveloped rows appear — pre-A2A history is served by the console views, not backfilled (§5) |
| `CancelTask` | sender-only; marks the row's envelope `canceled` **iff** still undelivered/queued | once delivery says `resumed`/`typed` the turn is running: `TaskNotCancelableError` (-32002). Cancel never interrupts a turn — interruption is a human's fleet-pause, not a peer's RPC |
| `SubscribeToTask` | SSE on the task's events | |
| `*PushNotificationConfig*` | `PushNotificationNotSupportedError` (-32003) | webhook egress from the queenzee is a new outbound door; not opened until an integrator needs it |
| `GetExtendedAgentCard` | `ExtendedAgentCardNotConfiguredError` (-32007) | |

### 3.3 Task-state mapping — the contract's hard part, written down

The A2A `TaskState` is **derived** (never stored) from facts ZEEHIVE already records:

| ZEEHIVE fact (authoritative source) | A2A state |
|---|---|
| row stored, delivery `none`/failed (`delivered=false`) | `submitted` — the durable inbox IS submission; it will be read on the next turn |
| delivery `queued` (recipient mid-turn) | `submitted` |
| delivery `resumed` / `typed` | `working` |
| recipient raised `zee tend` while the task is live | `input-required` (the tend reason is the status message) |
| a reply row (`report`/`message`) whose envelope references the `taskId` | `completed` — the reply body becomes the task's Artifact |
| recipient decommissioned / xell retired at send time (`decideMessageDelivery` → `none` with those reasons) | `rejected` |
| sender-cancel before delivery (§3.2) | `canceled` |
| delivery attempted and errored after retries | `failed` |
| `typed` into a cage with no turn hooks (the KNOWN GAP in `queenzee/reaper.js` — codex/kimi cages) | stays `working`; the card's honest answer is "delivered, completion unobservable" — noted in task `metadata`, never faked to `completed` |

`auth-required` is reserved (a task blocked on a human gate — prod bind, landing — could map here
later; not asserted in v1 because a gate is not an *authentication* exchange and lying about which
kind of blocked it is would mislead a conforming client).

### 3.4 Auth — exactly the two credentials that already exist

- **Internal callers** (a zee through its verbs): `Authorization: Bearer $ZEEHIVE_XELL_TOKEN` —
  resolved to the sending xell exactly as `resolveSelf` does for `/api/xell/self/*`. Crew scoping
  is unchanged: a worker may address its manager; a manager its crew (`workerOf`,
  `managers.js`); a router is refused crew verbs by name (151) — **A2A adds no reach that
  `zee say`/`zee report` do not already have.** The protocol is a wire format, not a permission.
- **External callers**: project API key `Bearer zhk_…` (migration 190's scheme, `X-Zeehive-Api-Key`
  accepted for parity with the ticketing API). Keys gain an `a2a` scope; an A2A-scoped key sees
  and may address only agents its project owns, and — like the ticketing API's answers — task
  projections for external callers carry **no xell ids, no tokens, no internal counts**.
- No third credential, no OAuth, until a named integrator requires it (card `securitySchemes`
  declares HTTP bearer only).

## 4. Data shape — projection, not migration

**`zee_message` stays authoritative.** A2A objects are a *view* of rows the fleet already writes:

- `postMessage` stamps an envelope into the existing `meta` jsonb (no DDL):

  ```jsonc
  meta.a2a = {
    "messageId": "<uuid>",          // minted per message (the row id reused)
    "taskId":    "<uuid>",          // minted when the message opens a task (a directive / routing request)
    "contextId": "<uuid>",          // the conversation thread: minted on first exchange between an
                                    // ordered (from_xell,to_xell) pair per work item, then reused
    "referencedTaskId": "<uuid>?",  // set on replies (report answering a directive)
    "state": null | "canceled"      // ONLY cancel is stored; every other state is derived (§3.3)
  }
  ```

- **Message** ⇄ row: `role` = `user` when the sender opened the context, `agent` on replies;
  `parts` = `[{text: body}]`; `metadata` carries the ZEEHIVE `kind` (`directive`/`report`/
  `reflection`) so nothing about the existing taxonomy is lost in translation.
- **Task** ⇄ the task-opening row + everything referencing its `taskId`: `history` = those
  messages in order; `artifacts` = reply bodies; `status` per §3.3.
- **What is authoritative when they disagree:** the ZEEHIVE columns (`delivered`, `delivery`,
  `read_at`, `kind`) win, always. The envelope stores *identity* (ids) and one flag (`canceled`);
  it never duplicates a fact a column already owns — a projection cannot drift from a store it
  does not copy.
- **DDL comes late and small:** phase 3 needs `GetTask` by id → one migration adding two
  expression indexes on `(meta->'a2a'->>'taskId')` / `contextId`. Written as a file under
  `db/migrations/` with a number claimed via `zee migration-number` (binding rule: never DDL on
  the shared dev db; the migration file triggers the clone-db switch).
- **C7 seam (not built):** when the stage-2 data plane lands, `execution.outputs` from
  `zee handover` maps 1:1 onto A2A `Artifact` (`artifactId` = execution id, `parts` =
  `[{data: outputs}]`). The mapping module (§6 P1) keeps a named function stub for it so the seam
  is visible; nothing behind it ships now.

## 5. Compatibility

- **Old rows** (every `zee_message` before P1) have no envelope → invisible to `ListTasks`/
  `GetTask`, fully visible where they always were (`zee inbox`, `messagesForXell`, the console).
  No backfill: inventing task ids for delivered-and-read history answers no caller's question.
- **Old callers**: `zee say` / `zee report` / `zee inbox` keep their exact CLI text UX; their JSON
  answers *gain* `a2a: {taskId, contextId}` additively. The manager manual needs no re-teach
  (house rule 8: manual/briefing/CLI move together — the additive field needs no manual change;
  the phase-4 `zee a2a` verb does, and carries its drift-test update with it).
- **Half-deployed:** every phase is additive. P1 stamps envelopes nobody reads yet; P2–P3 read
  what P1 wrote; an un-enveloped row and an enveloped one coexist in every view. Rolling back any
  phase strands only inert jsonb keys.
- **The gateway split in flight:** these routes are express routes like the other 295; whichever
  process owns routes when each phase lands, the same code mounts. The only coupling is
  `sendMessageToXell` living loops-side post-split — the same boundary crossing every
  message-sending route already has to make (their DR-4).

## 6. Migration — phases, each safe to stop at

| phase | ships | DDL | reversible? |
|---|---|---|---|
| **P0 (this)** | the design + decision record | none | trivially |
| **P1 — envelope** | `server/src/lib/a2a.js` (pure mapping: rows ⇄ Message/Task, state derivation §3.3, unit-tested like `zee-turn.js`'s pure `decideMessageDelivery`); `postMessage` stamps `meta.a2a`; verb answers gain ids | none | stop stamping; envelopes go inert |
| **P2 — read side** | fleet card, directory, per-agent cards; `GetTask`/`ListTasks`/`SubscribeToTask` (internal token auth only) | none (seq scan acceptable at current volumes — the whole fleet's measured turn count is 520 rows, docs/langchain-stateful-zees.md §1, and messages scale with turns; not re-measured from this xell: dev-db auth refused the generated env credentials) | delete routes |
| **P3 — write side** | `SendMessage`/`SendStreamingMessage`/`CancelTask` (internal); the two expression indexes | 1 small migration | delete routes; indexes are droppable |
| **P4 — external interop** | `a2a` scope on `zhk_` keys; external card/task views (id-scrubbed); `zee a2a <card-url> --message` outbound verb (queenzee-mediated, recorded like `llm_gateway_request`) | none | **the one-way door** — see DR-7 |

Ordering rationale: identity first (ids exist before anything reads them), read before write
(a projection bug found while the only writer is still the old path costs nothing), external last
(the only irreversible step goes where the most evidence has accumulated).

## 7. What would change this design

- A2A publishing a lightweight "message-only" profile → P1's envelope may map onto it directly.
- The gateway split landing with a different route home → §2 follows it, nothing here resists it.
- A named integrator needing push notifications or OAuth → opens the doors §3.2/§3.4 keep shut.
- Fleet-to-fleet (nested queenzee) federation being asked for → the fleet card in §3.1 is the
  seam; a nested hive's card lists its agents and the parent dials it as one more external agent.
