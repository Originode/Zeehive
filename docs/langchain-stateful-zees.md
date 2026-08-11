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
driver can execute it. **This is future work in the current build** (§8.3) — the first build drives
a single model turn with no tool loop. When tool execution arrives, the tools must be queenzee-owned
verbs (the `zee` CLI's gates, the repo's own scripts), not free actions, so the gates stay
first-class.

## 3. What the queenzee keeps (everything that is not a single model call)

| concern | owner | why |
|---|---|---|
| **spawn / claim / pool** | queenzee | a xell is claimed, a zee row is created, the pool sweep still owns ready rows |
| **landing / ship / seed / prod gates** | queenzee + human | untouched — langchain never sees a gate |
| **scheduling (when a turn runs, resumes, reaps)** | queenzee loops | `intake.js`, `nudge.js`, `reaper.js`, `monitor.js` unchanged |
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

### 4.3 What is NOT state

- **The gate decisions, the landing requests, the ship cards** — already rows, already durable,
  not conversation.
- **The zee row's burn** — lifetime aggregate, not per-turn context.
- **The `xell_conversation` archive** — a receipt about a finished xell (the JSONL transcript,
  `ON DELETE SET NULL` so it outlives the xell). It is the *record of what happened*; `zee_conversation`
  is the *working memory a live xell carries into its next turn*. The two do not merge.

## 5. How turnover is handed to the next zee

The handover is **the conversation load at turn start**, and it is the queenzee's act, not
langchain's:

1. **Every langchain zee turn starts by loading** `zee_conversation` for the xell (`loadConversation`).
2. **Every turn ends by appending** what it did (`appendConversation`): the user message that was
   the task/brief, and the assistant response.
3. **A swap / resume / re-dispatch on the same xell** therefore starts warm: the new zee's first
   model call is seeded with the previous zee's conversation.

Concretely, for a swap (manager `zee swap --to <slug> --harness <key>`):

- The outgoing zee's last turn already appended its messages (`appendConversation` runs at end of
  every langchain turn, and the collect-before-recreate in `swapZeeInXell` is untouched — commits
  are still rescued first).
- The incoming zee's `dispatchXell` → `spawnLangchainZee` loads the xell's `zee_conversation`
  before its first model call. Its task brief says "you inherited this xell" (the existing
  `swapBrief`), and its **context** now actually reflects that — it reads the prior conversation,
  not just a sentence claiming it.

For a resume (`nudge`), the same: a resumed langchain zee loads the conversation and continues it.
The queenzee's `nudge.js` decision to resume is unchanged; only the payload the resumed turn runs
with is warmer.

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
  `runLangchainTurn` (load → invoke → append → return).
- `spawnLangchainZee` in the dispatch path — a real zee driven by the driver: creates the zee row,
  starts the turn, runs the model call through the gateway, persists the conversation, ends the
  turn with the burn.
- `test/langchain-zee.test.mjs` — a standalone test that proves the turnover: two turns on one xell;
  the second is seeded with the first's conversation, and both calls land in `llm_gateway_request`
  through the real `gatewayProxy`.

### 8.2 Design constraints that hold

- Model calls flow through the gateway (the gateway is the base URL; `llm_gateway_request` is
  written per call).
- The queenzee stays deterministic: langchain is invoked, never invoked-by; no graph, no framework
  loop.
- No gate changes, no `hooks/` changes, no prod writes.

### 8.3 Not built yet (next cards)

1. **Tool loop** — the driver currently makes one model call per turn. The multi-call loop (model →
   tool request → tool result → model → …) is the natural next step, with tools bound through
   langchain's tool interface and executed through queenzee-owned, gate-respecting verbs.
2. **Cxell-sandboxed langchain agent** — the first build runs the model call in the queenzee
   process (safe for a single model call: no tools, no file access). When the agent gains tools, it
   must run inside the cxell so the container remains the permission boundary; that means shipping
   langchain in the zee-agent image.
3. **Conversation pruning / token budgeting** — a long-running xell's `zee_conversation` grows
   without bound; the next card should add a per-xell cap (e.g. keep the last N messages, oldest
   summarized) so warm starts stay within a token budget.
4. **Interactive turns** — the langchain runtime currently supports spawn/resume; an interactive
   pane turn (a human typing into a langchain zee's session) needs a terminal bridge like the
   CLI path's `terminal-bridge.js`.
