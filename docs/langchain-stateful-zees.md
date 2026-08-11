# Deploying Zees via LangChain, Stateful, with Proper Turnover

**Status:** Design + first build (see §8 for what is implemented and what is next)
**Author:** deploy-zees-via-langchain-stateful-with-prop-3fe266
**Directive (verbatim):** deploy zees via **langchain, not langgraph**; stateful, with proper
turnover between zees; the queenzee stays first-class but deterministic.

---

## 1. Context: what "deploy zees via langchain" is and is not

Today a zee is a **vendor CLI spawned as a process inside a caged container** (the cxell): the
queenzee runs `claude -p` / `codex exec` / `kimi --print` / `grok -p` headless inside the cage,
translates its output stream into the normalized `init` / `assistant` / `result` event feed, and
records the turn + every model call in the observability spine (`zee_turn`, `llm_gateway_request`).
There is no agent framework in the loop at all. `grep -ril "langchain\|langgraph"` across the repo
returns nothing.

The measured starting point:

| table | rows | note |
|---|---|---|
| `llm_gateway_request` | 14,159 | every AI call that crosses the queenzee gateway, per request |
| `zee_turn` | 520 | one row per turn (spawn / resume / interactive) with the turn's aggregate burn |

**The problem this card exists to solve is turnover, not the model call.** The model call is already
well-observed (the gateway sees every HTTP request). What is broken: a zee's **context dies with its
cxell**. The next zee — a swap wearing a different harness, a resume after a crash, a re-dispatch —
starts cold and re-derives what the previous zee already knew. There is no durable record of the
working conversation, so every handover throws away the thing a handover is supposed to carry.

**Langchain's role is a library, not a scheduler.** The human was explicit: langgraph is refused
because its pitch is owning the control flow, and ZEEHIVE already owns control flow — the queenzee's
loops, the pool, the gates. A graph runtime would be a second, competing scheduler. Langchain used
as a library — **model calls, tool binding, memory** — underneath the queenzee's existing
determinism is the shape asked for. If the design ever ends up with a framework deciding what runs
next, it has built the thing the human said not to build.

---

## 2. What langchain owns

Three things, all of them single-call library operations the queenzee invokes:

### 2.1 Model calls (`@langchain/anthropic` / `@langchain/openai` chat models)

A langchain chat model wrapper replaces the **vendor CLI as the thing that makes a model call**.
The wrapper handles the wire dialect (Anthropic `/v1/messages` for claude/deepseek, OpenAI
`/v1/chat/completions` for openai/kimi), the message types (`HumanMessage`, `AIMessage`,
`SystemMessage`, `ToolMessage`), and streaming — everything a raw provider SDK gives you, with a
uniform surface across vendors.

**Crucially, the wrapper is pointed at the existing gateway, not at the provider directly.** The
base URL is `gatewayEnv({ xellToken, provider })` — the same `/x/<xell-token>/<provider>` path the
vendor CLIs already use. Every langchain model call therefore **crosses the same gateway door** and
is recorded in `llm_gateway_request` exactly like a CLI call. The transparency directive replaced
Langfuse precisely so nothing depends on an agent volunteering its own data; langchain changes
nothing about that — the gateway records at the transport layer, and langchain is just another
transport.

### 2.2 Memory (the conversation state, DB-backed)

Langchain's memory abstraction (`BaseChatMessageHistory`, message lists) is the shape of the state
model. The actual store is a new table, `zee_conversation` — see §4. Langchain does **not** own the
durability; the queenzee reads the table before a turn and writes it after. Langchain's contribution
is the message type system that makes "here is the history, continue it" a first-class operation.

### 2.3 Tool binding

A langchain tool is a named function with a JSON schema; the chat model can request its use and the
driver can execute it. The loop (`runLangchainAgentTurn`) is bounded, in-process, and the tool LIST
is the confinement: only the verbs in the registry (`langchain-tools.js`) are bindable, each calling
the SAME handler `/api/xell/self/*` calls, and the loop resolves through the ALLOWLIST (`LANGCHAIN_TOOLS`),
never through a caller-supplied array — an over-wide array cannot widen the loop.

The bound verbs are the read-only/report verbs (`status`, `work`, `working`, `item`) and the
wave-2 ASK verb `tend` (it asks for a human and executes nothing). `hint-land` / `hint-ship` are NOT
bound yet — their write shape (a `session_event` annotating a request, plus the hint state) has been
reported to the manager and is pending their call before they are added.

**The confinement is the ALLOWLIST, not the gate.** The wave-2 argument that `land`/`ship`/`seed`
are safe to bind "because they terminate on a human" is FALSE on this fleet. Measured on the fleet
meta-DB (2026-08-11): `project.auto_approve_land` / `auto_approve_ship` / `auto_approve_seed` are
`true` for Zeehive and omnibiz, and the gates decide without a human in the path — `landgate.js:188`
→ `:250` (`status='landed', decided_by='auto-approve@policy'`), `shipgate.js:223`, `seedgate.js:199`;
593 auto-approved lands, 287 auto-approved ships, 10 auto-approved seeds. A bound `land` puts a
model-chosen commit on main, `ship` deploys production, `seed` writes prod rows. So `land`/`ship`/
`seed` are NOT in the registry and never will be added by a test. Do NOT flip `auto_approve_*` to
make a hold appear — that is fleet-wide policy.

## 3. What the queenzee keeps (everything that is not a single model call)

| concern | owner | why |
|---|---|---|
| **spawn / claim / pool** | queenzee | a xell is claimed, a zee row is created, the pool sweep still owns ready rows |
| **landing / ship / seed / prod gates** | queenzee + human | untouched — langchain never sees a gate |
| **scheduling (when a turn runs, resumes, reaps)** | queenzee loops | `intake.js`, `nudge.js`, `reaper.js` unchanged; `monitor.js` only EXCLUDES `driver='langchain'` zees from its CLI-liveness probe (they have no cage/CLI session to probe) |
| **the gateway + ledgers** | queenzee | every langchain call flows through `gatewayProxy` → `llm_gateway_request` |
| **turn lifecycle** | queenzee | `startTurn` / `endTurn` in `turn-ledger.js` |
| **the harness brief** | queenzee | the task text the zee is given is built by the existing briefing machinery |
| **confinement** | queenzee + cxell | the cxell container remains the permission boundary for tool execution |

The pattern is uniform: **langchain is invoked, the queenzee decides.** A langchain zee turn is
"the queenzee decided to run a turn, so it asks langchain to make a model call with the current
conversation, then records the result." Nothing in langchain triggers a spawn, a resume, a gate or
a reap.

## 4. What "state" means concretely

State is **the conversation that must survive a handover**, stored as durable rows the next zee
can be seeded from.

### 4.1 The table: `zee_conversation` (migration 192)

```
zee_conversation (
  id            uuid PK,
  xell_id       uuid NOT NULL REFERENCES xell(id) ON DELETE CASCADE,
  zee_id        uuid REFERENCES zee(id) ON DELETE SET NULL,
  turn_id       uuid REFERENCES zee_turn(id) ON DELETE SET NULL,
  seq           int NOT NULL,               -- per-xell order (app-maintained, MAX(seq)+1)
  role          text CHECK (role IN ('system','user','assistant','tool')),
  content       text NOT NULL,
  name          text,                       -- tool name for tool-role messages
  meta          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (xell_id, seq)
)
```

- **Keyed by `xell_id`**, not `zee_id` — the xell is the durable work unit (it survives zee swaps,
  re-dispatches and re-crews; `xell.execution_id` already says the same thing for the workflow
  plane). A swap retires the old zee row but the xell's conversation keeps accumulating.
- **One row per message**, with a `seq` counter so the replay order is exact and independent of
  clock skew.
- **Lifetime = the xell's lifetime.** `ON DELETE CASCADE` — when the xell is reaped, its
  conversation goes with it. No separate retention sweep is needed (a reaped xell's rows are gone,
  and a live xell's conversation is exactly the state it needs).
- **Best-effort append.** Like every ledger write in this system, a conversation write never fails
  a turn — a pg blip loses the history (the zee still completes), never the turn.

### 4.2 The runtime row: `langchain-stateful`

A new `agent_runtime` row with `driver='langchain'` — the seam the dispatch already checks
(`rt.driver === 'cxell-cli'` → cage; `rt.driver === 'langchain'` → langchain driver). It is the
registry way to say "a zee can be driven by langchain", alongside claude-code-cxell, codex, kimi,
deepseek, grok.

**Opt-in by default.** The row is inserted with `enabled=false`, so it can never become a pool
default by accident — a dispatch only lands on it when a human explicitly selects the
`langchain-stateful` runtime. This is deliberate: a langchain zee has no cxell process to probe
(the monitor excludes `driver='langchain'` from its CLI-liveness pass), and the non-caged model-call
loop is the first step of a longer rollout (see §8.3). Making it a fleet default is a later,
explicit decision.

### 4.3 What is NOT state

- **The gate decisions, the landing requests, the ship cards** — already rows, already durable,
  not conversation.
- **The zee row's burn** — lifetime aggregate, not per-turn context.
- **The `xell_conversation` archive** — a receipt about a finished xell (the JSONL transcript,
  `ON DELETE SET NULL` so it outlives the xell). It is the *record of what happened*; `zee_conversation`
  is the *working memory a live xell carries into its next turn*. The two do not merge.

### 4.4 Retention — how large this gets, on purpose

`zee_conversation` is **working memory for live xells, not fleet history**, and the numbers are
deliberately modest:

- **Lifetime = the xell's lifetime.** `ON DELETE CASCADE` on reap. The table holds only the xells
  currently alive; a reaped xell's rows are gone. It does NOT accumulate the way `llm_gateway_request`
  (14,159 rows) or `zee_turn` (520 rows) do — those are the fleet's historical ledgers and have their
  own retention story. `zee_conversation` is bounded by **live xell count × turns per live xell**, not
  by total fleet history.
- **Warm-start context is already capped.** `loadConversation` reads at most **100 messages** per
  turn (the driver's default limit), so a long-lived xell's per-call context is bounded regardless of
  how many rows its table holds. The table may grow; the model call never sees it all.
- **Per-xell growth is unbounded in principle** (2 rows per turn). The concrete next card (§8.3) is a
  per-xell cap with oldest-first summarisation, so a genuinely long-running xell both stops growing
  its storage and keeps its warm-start context inside the model's budget.

This is a made-on-purpose decision, not a default: live-xell working memory with a bounded read, and
a cap card on the roadmap.

## 5. How turnover is handed to the next zee — and the two boundaries it has to cross

"Turnover between zees" crosses **two different boundaries**, and they need different answers. This
change builds the first and explicitly does NOT build the second — saying so is the honest part.

### 5.1 Same-xell turnover (a swap): BUILT and proven

A swap (`zee swap --to <slug> --harness <key>`) is ZEEHIVE's crew handover verb: zee A is retired,
zee B is dispatched **into the SAME xell** — same branch, same commits, same containers, same
database, same card. The incoming zee literally inherits the work. Here the FULL conversation is the
right thing to carry: B is continuing A's work in the same workspace, and A's context is B's context.

The handover is **the conversation load at turn start**, and it is the queenzee's act, not
langchain's:

1. **Every langchain zee turn starts by loading** `zee_conversation` for the xell (`loadConversation`).
2. **Every turn ends by appending** what it did (`appendConversation`): the user message that was
   the task/brief, and the assistant response.
3. **A swap / resume / re-dispatch on the same xell** therefore starts warm: the new zee's first
   model call is seeded with the previous zee's conversation.

The outgoing zee's last turn already appended its messages (appendConversation runs at end of every
langchain turn, and the collect-before-recreate in `swapZeeInXell` is untouched — commits are still
rescued first). The incoming zee's `dispatchXell` → `spawnLangchainZee` loads the xell's
`zee_conversation` before its first model call, so its **context** now actually reflects "you
inherited this xell" — not just a sentence claiming it.

`test/langchain-zee.test.mjs` proves this with **two zee rows on one xell**: the second zee's model
call carries the first zee's full exchange through the real gateway. That is turnover between ZEES
within a xell.

### 5.2 Cross-xell turnover (a brand-new xell): NOT built — scoped here

"Zee A finishes or dies, zee B picks up **in a different xell**" is a different problem. A new xell is
a fresh branch, a fresh clone, a fresh worktree. Replaying A's raw transcript into B is the **naive
answer and probably the wrong one**: A's dead ends, wrong turns, local paths and session ids would
poison B, and most of the transcript is the journey, not the conclusion.

**What this change does NOT do:** `zee_conversation` is keyed by `xell_id` and dies with the xell, so
a brand-new xell starts with an empty conversation — COLD by construction. The same-xell test above
does not stand in for the cross-xell case, and is not offered as such.

**The proposed cross-xell design** (not yet built — the state model is agreed here before code follows).
**DECISION (2026-08-11): the carrier is a XELL-KEYED handover row — Option A.** The execution plane
was considered and rejected as the carrier. The rejection is about **coverage**, not absence of a
path — an execution-linked handover is structurally unavailable to most of the fleet. Measured on
the fleet meta-DB:

    execution total                                161
    execution with work_node_id                    161   (entity_id: 0)
    xells holding a work_item                       81
    XELL -> EXECUTION reachable                     80   of those 81
    EXECUTION -> XELL reachable                    106   of 161
    execution.outputs non-empty                      0   of 161
    xells total                                    584
    live xells                                      23

The execution path exists and runs both ways — xell → `work_item.xell_id` → `work_node.stable_key`
(`'work_item:'||id`) → `execution.work_node_id` reaches an execution for 80 of the 81 xells that
hold a work item, and the reverse reaches 106 of 161 executions. But the path only exists for a xell
that holds a WORK ITEM: 81 of 584 xells (~14%). Six xells in seven have none, so an execution-keyed
handover is unavailable to most of the fleet — including, by construction, any xell cut for something
that never became a card. A `xell_handover` row keyed by `xell_id` is available to all 584. THAT is
why Option A wins: coverage, not absence of a path.

Three reasons, in order of weight:

1. **Coverage** — the execution path reaches only the ~14% of xells that hold a work item; a
   xell-keyed row reaches every xell. (The path itself is real; the earlier draft's "no path in
   either direction" was WRONG and is corrected here.)
2. **Composition** — keyed by the SAME key `zee_conversation` uses (`xell_id`), so the handover row
   composes with what is already built and is found the same way.
3. **No fragile dependency** — `execution.outputs` is non-empty in 0 of 161 rows (it has never been
   written), `execution.entity_id` is never set, `entity` has zero rows, and `work_node.stable_key`
   is a string convention a rename would break. Routing through `execution` would require wiring
   xell↔execution (entity rows for xells, `execution.entity_id` populated, readers re-pointed) as a
   PREREQUISITE CARD with a human's name on it (…-abc363's scope) — this design does not silently
   absorb it.

- **The carrier: a `xell_handover` row, keyed by `xell_id`** — the SAME key `zee_conversation` uses,
  so it composes with what is already built. Written when the predecessor xell is retired/reaped;
  read BY NAME when the successor is dispatched. Boring, reachable, available to every xell.

> **LANDING NOTE (2026-08-11) — what actually happened, for the record.** This §5.2 landed as
> Option A **after** the manager had directed the CARD (work-item) carrier. The coverage measurement
> above is what settled it: a card-keyed handover has no carrier for six xells in seven (81 of 584
> xells, ~14%, hold a work item), while a xell-keyed row is available to every xell. The manager
> re-measured every number independently, agreed Option A is correct, and the CARD proposal was
> withdrawn. An earlier report from this xell that "the CARD landed" was inaccurate — the landing
> that went to main carried Option A — and the record is corrected here rather than left to read as
> if the manager agreed with Option A all along. The working-memory/handover split stands
> unchanged: `zee_conversation` (keyed by xell, dies with the cage) is working memory; the
> xell-keyed `xell_handover` row (curated, not replayed, read only by a named successor, filtered
> of cage-scoped values) is the handover.
- **What crosses the boundary: a CURATED handover**, not the transcript. The durable conclusions:
  what was decided, what was verified, what remains, the constraints that still bind, the next
  concrete step. What stays behind: dead ends, wrong turns, local paths, tool blow-by-blow.
- **How the successor is NAMED** — the handover is read by name, and the name is one of:
  - **(a) SAME work item, NEW xell** — the successor is dispatched on the SAME work_item; the
    predecessor is the previous xell that held that work_item (via the work_item's xell history /
    task row). The successor reads the predecessor's `xell_handover` for that work item.
  - **(b) DIFFERENT work item** — a successor CARD. The link is a `dependency` edge: **`from_id` is
    the PREDECESSOR, `to_id` the DEPENDENT** (get this backwards and the handover runs the wrong
    way). This is "chain" work already being designed by the …-16c430 xell; this design does NOT
    invent a second carrier for it — it uses the same dependency edge to find the predecessor, then
    reads that predecessor's `xell_handover`.
  - **Explicit:** a manager dispatches "continue <xell>" — the dispatch names the predecessor
    directly and reads its `xell_handover`.
  Without one of these, a new xell has no legitimate claim on another xell's conversation and must
  not receive it.
- **Filtering:** any value scoped to the old cage (local paths, container names, session ids,
  claude_session references) is stripped before it crosses.

Whether the cross-xell case is built in this card or as the immediate next card is a scoping call
this design is written to make explicit.

## 6. The wiring (what the code does)

```
dispatchXell (intake.js)
  └─ rt.driver === 'langchain'
       └─ spawnLangchainZee({ pid, xell, task, rt, model, provider })
            ├─ create zee row (status='working', kind='headless', entrypoint='langchain')
            ├─ claim the xell
            ├─ startTurn({ zee, xell, kind:'spawn', model })            → zee_turn
            ├─ conversation = loadConversation(xell.id)                 → zee_conversation
            ├─ chat = buildChatModel({ provider, model, apiKey, baseUrl=gatewayEnv(...).<dialect> })
            ├─ resp = chat.invoke([...conversation, new HumanMessage(task)])
            │       └─ every HTTP request crosses gatewayProxy → llm_gateway_request
            ├─ appendConversation(xell.id, [HumanMessage(task), resp])  → zee_conversation
            ├─ feed events: init / assistant / result                    → SSE + session_event
            └─ endTurn(...) + update zee status/burn
```

The gateway attribution is automatic: `recordRequest` → `zeeTurnForXell(xellId)` finds the live zee
and the open turn, so each langchain call lands under the right zee and turn in the ledger — the
same drill-down waterfall (`execution → zee_turn → llm_gateway_request`) the CLI calls produce.

## 7. Alternatives considered and rejected

| alternative | verdict | why |
|---|---|---|
| **langgraph** | rejected | a second scheduler; its pitch is owning control flow, which the queenzee already owns. Would race the queenzee's loops instead of serving them. |
| **raw provider SDKs** (`@anthropic-ai/sdk` directly) | rejected | no uniform memory/message abstraction across vendors, no tool-binding convention; each vendor would need its own state plumbing, which is the very thing langchain standardizes. |
| **keep the vendor CLI as the only driver + bolt on a transcript DB** | rejected | the CLI's context is in-memory inside the cage; persisting it would require parsing CLI transcripts (the thing the gateway replaced) and re-injecting them through a CLI flag — fragile, vendor-specific, and exactly the "re-derive what the last one knew" cost the card wants gone. |
| **an agent framework that owns the loop** (autogen, crewAI, semantic-kernel-style) | rejected | same reason as langgraph — the framework would decide what runs next, which is the queenzee's job. |
| **langchain but pointed straight at the providers** (bypass the gateway) | rejected | would route model calls around the gateway and lose the observability spine. The gateway is the one door; langchain goes through it. |

## 8. What is built vs. what is next

### 8.1 Built in this change

- `db/migrations/192_...` — `zee_conversation` table + the `langchain-stateful` runtime row.
- `server/src/lib/langchain-zee.js` — the driver: `buildChatModel` (gateway-pointed langchain chat
  model), `loadConversation` / `appendConversation` / `resetConversation` (DB-backed memory),
  `runLangchainTurn` (single model call) and `runLangchainAgentTurn` (the bounded tool loop).
- `server/src/lib/langchain-tools.js` — the tool registry (`status`, `work`, `working`, `item`,
  `tend`), the allowlist that is the confinement. Each tool calls the SAME handler `/api/xell/self/*`
  calls (selfStatus/selfWork/selfWorking/selfWorkItem/selfTend), never a second copy; anything
  outside the registry is refused visibly. `working` carries the TEND GUARD (refuses while a tend is
  open, so a model cannot silently clear a human's question).
- `spawnLangchainZee` in the dispatch path — a real zee driven by the driver: creates the zee row,
  starts the turn, drives `runLangchainAgentTurn` (the loop, bound to the wave-1 registry), feeds
  the play-by-play, persists the conversation, ends the turn with the summed burn.
- `test/langchain-zee.test.mjs` — proves the SAME-XELL turnover (see §5.1): two zee rows on one
  xell; the second zee's model call is seeded with the first zee's conversation, both calls land in
  `llm_gateway_request` through the real `gatewayProxy`, and the real `spawnLangchainZee` path runs
  end to end.
- `test/langchain-tools.test.mjs` — proves the tool loop end to end through the real gateway: the
  model requests `working`, the queenzee runs the SHARED `selfWorking` handler, the result feeds
  back and the model concludes; an unbound tool is refused visibly and the loop continues; the loop
  resolves through the ALLOWLIST even when the caller passes an over-wide `tools` array (the extra
  verb is refused, never run); `tend` is bound and produces a `tend_request` a human answers; an
  open tend SURVIVES a model `working` call (the tend guard refuses); a tool-happy model is stopped
  at the cap with a VISIBLE capped result; every iteration is recorded in `llm_gateway_request`
  attributed to the live zee + open turn.

**STATUS: BUILT, TESTED, and NOT YET ENABLED on any zee.** Measured on the fleet meta-DB:
`zee_conversation` has 0 rows across 0 xells — the migration is landed and applied (the table is
live), but nothing has ever used it. That is consistent with the runtime being opt-in
(`agent_runtime.enabled=false`). To try it, a human flips the switch and dispatches on the runtime:
`UPDATE agent_runtime SET enabled=true WHERE key='langchain-stateful'`, then select the
`langchain-stateful` runtime when dispatching a zee. Until then the driver is exercised only by the
standalone test, not by a live zee.

### 8.2 Design constraints that hold

- Model calls flow through the gateway (the gateway is the base URL; `llm_gateway_request` is
  written per call).
- The queenzee stays deterministic: langchain is invoked, never invoked-by; no graph, no framework
  loop.
- **The confinement is the ALLOWLIST, not the gate.** `land`/`ship`/`seed` are NOT bindable because
  this fleet auto-approves them — `project.auto_approve_land/ship/seed = true` for Zeehive and
  omnibiz, so the gates act with `decided_by='auto-approve@policy'` and no human in the path
  (landgate.js:188→250, shipgate.js:223, seedgate.js:199; measured: 593 auto-approved lands, 287
  auto-approved ships, 10 auto-approved seeds). A bound `land`/`ship`/`seed` would be the ACT, not a
  request. They stay absent from the registry. (This corrects an earlier draft that called the gated
  verbs safe "because they terminate on a human" — on this fleet they do not.)
- **Dependencies are the scoped langchain packages only** — `@langchain/anthropic`, `@langchain/openai`,
  `@langchain/core`. The `langchain` umbrella is deliberately NOT a dependency: it is never imported
  and it pulls the `@langchain/langgraph` runtime into the tree. `npm ls langgraph` is empty.
- No gate changes, no `hooks/` changes, no prod writes.

### 8.3 Not built yet (next cards)

1. **Cross-xell turnover** — the curated-handover design in §5.2: what a successor xell is handed
   when it continues work from a different xell, carried on a XELL-KEYED `xell_handover` row (the
   same key `zee_conversation` uses — Option A, the agreed decision; the execution plane was
   rejected as the carrier on COVERAGE: a card/execution-linked handover is structurally unavailable
   to the ~86% of xells that hold no work item, not because the xell↔execution path is absent — the
   path exists, it just does not reach most of the fleet, and `execution.outputs` has never been
   written).
   Split into same-work-item (case a) and different-work-item (case b, the dependency edge, kept
   aligned with …-16c430's chain work). The old xell's local paths and dead ends are filtered out.
   This is the design gap this card names; it is the natural next card once the state model is
   agreed and read.
2. **Tool loop** — the multi-call loop (model → tool request → tool result → model → …) with tools
   bound through langchain's tool interface and executed through queenzee-owned, gate-respecting
   verbs. WAVE 1 (the mechanism slice) is BUILT: the loop runs in the queenzee process, bound ONLY
   to the read-only, no-side-effect registry verbs (`status`, `work`, `working`, `item`), a hard
   cap of 8 iterations with the cap visible when hit, and ONE handler shared with `/api/xell/self/*`
   (never a second copy of a verb's logic). The wave-2 ASK verb `tend` is bound — it asks for a
   human and executes nothing. `hint-land` / `hint-ship` are NOT bound yet (their write shape is
   reported to the manager and pending their call). `land`/`ship`/`seed` are NOT bound and never will
   be by a test: this fleet auto-approves them (§2.3, §8.2), so there is no human hold for a bound
   ask to reach — the confinement is the allowlist, not the gate.
3. **Cxell-sandboxed langchain agent (workspace action)** — the boundary for tools is drawn by WHAT
   A TOOL CAN DO, not by the existence of tools (this amends an earlier, too-coarse sentence here
   that said any tool ⇒ the cage). Read-only, no-side-effect verbs (`status`, `work`, `working`,
   `item`) may be bound in-process — they acquire no privilege a single in-process model call does
   not already have. Any tool with WORKSPACE ACTION — file write, shell, SQL, docker, git, and
   every gated verb — must run inside the cxell so the container remains the permission boundary,
   and that waits on shipping langchain in the zee-agent image. Until the image lands, workspace
   action is NOT bindable anywhere.
4. **Conversation pruning / token budgeting** — a long-running xell's `zee_conversation` grows
   without bound; the next card should add a per-xell cap (e.g. keep the last N messages, oldest
   summarized) so warm starts stay within a token budget.
5. **Interactive turns** — the langchain runtime currently supports spawn/resume; an interactive
   pane turn (a human typing into a langchain zee's session) needs a terminal bridge like the
   CLI path's `terminal-bridge.js`.
