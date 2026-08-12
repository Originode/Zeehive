# Decision record: adopting the A2A protocol for agent-to-agent conversations

**Date:** 2026-08-11
**Author:** Architect (xell `implement-a2a-protocol-whenever-two-agents-a-52f81f`)
**Status:** DESIGN — proposed, nothing built. Supersedes nothing.
**Spec:** [a2a-protocol-plan.md](a2a-protocol-plan.md)

Seven decisions. The context they were all made in: the directive is *"implement a2a protocol
whenever two agents are talking to each other"*; ZEEHIVE's agent-to-agent traffic is the
`zee_message` plane (store-then-deliver through the queenzee, `server/src/lib/managers.js`), zees
are caged with **no network path to each other** (the cxell wall is the product), and the A2A
protocol reached **v1.0** under the Linux Foundation (verified against `a2aproject/A2A` tag
`v1.0.1` on 2026-08-11 — pre-1.0 recollections of the wire format, `message/send` method names
and `agent.json` card path, are now WRONG; v1.0 uses PascalCase methods and
`/.well-known/agent-card.json`).

---

## DR-1 — Scope: what counts as "two agents talking", and what deliberately does not

**Decision.** A2A applies to the `zee_message` plane (manager⇄worker directives, reports,
reflections; router intake) and to the new external-agent door. It does NOT apply to
queenzee⇄zee continuations, zee⇄model gateway traffic, or zee⇄tool (MCP / `zee` CLI) calls.

**Options considered.**

- **A · The `zee_message` plane + the external door** *(chosen)*. For: it is exactly where two
  *agents* exchange language today; the store-then-deliver machinery maps cleanly onto A2A's
  task model; the external door is the actual payoff of adopting a standard rather than staying
  bespoke.
- **B · Literal maximalism — every channel any agent uses, including queenzee prompts and model
  calls.** For: the directive says "whenever", and one protocol everywhere is one thing to learn.
  Rejected because the queenzee is, by this repo's own definition (package.json), a *pure-script
  deterministic orchestrator* — its continuations are control plane, and wrapping them in an
  agent-conversation protocol would misdescribe them to every conforming client (a `GetTask` on
  "your landing went stale" is a category error). Model calls already have a wire standard (the
  provider dialects) and a recorder (`llm_gateway_request`); tool calls already have MCP, which
  is agent→tool by design. A2A's own positioning is agent↔agent *opaque peers* — using it where
  one side is a deterministic script or a tool erases the distinction the two existing protocols
  exist to draw.
- **C · External door only, internal stays bespoke.** For: smallest build; interop is where the
  standard pays. Rejected because the directive names internal conversations too — and because an
  external Task that cannot cite the same ids as the internal conversation it lands in would make
  the fleet's audit trail two disjoint vocabularies. The envelope (DR-3) makes internal adoption
  nearly free, so the saving is small and the cost is permanent bilingualism.

**Consequences.** Easy: one id vocabulary across internal and external traffic. Hard: the
boundary needs stating (this record) or someone will "finish the job" onto C4–C6. Impossible:
nothing — out-of-scope channels can be brought in later by a superseding record.

**Reversibility.** Scope can widen any time; narrowing after external callers exist cannot.

**What would change our mind.** The queenzee growing genuine agency (an LLM deciding its
continuations) would move C4 into scope — the test is "is either side making free decisions?".

---

## DR-2 — One A2A server (the queenzee API), never per-zee servers

**Decision.** ZEEHIVE speaks A2A at exactly one place: the queenzee API, as a multi-tenant A2A
service where each live zee is a tenant-scoped agent. Zees never run A2A servers and never dial
each other; their client path is queenzee-mediated.

**Options considered.**

- **A · Mediated multi-tenant service** *(chosen)*. For: preserves the cxell wall untouched;
  every message keeps landing in `zee_message` (the durable inbox + the audit a human reads);
  delivery semantics (`decideMessageDelivery` — queued/resumed/typed) keep working, which
  matters because an A2A peer cannot type into a cage; and the shape is spec-native, not a bend —
  v1.0's `AgentInterface.tenant` field exists verbatim for *"multiple agents served behind a
  single A2A endpoint"* (`a2a.proto`), and the REST bindings are tenant-scoped
  (`/{tenant}/message:send`).
- **B · An A2A server inside each cxell, firewall holes between xells.** For: it is the
  protocol's native deployment story, and peers could stream directly. Rejected because the
  cost is the containment model itself: cxell→cxell reach is the precise thing the cage
  exists to prevent (a compromised or confused zee reaching a sibling's worktree/db is the
  scenario the walls were built for); a server inside a cage dies with every turn/rebuild, so
  tasks would need re-homing anyway; and messages would stop transiting the queenzee, deleting
  the audit trail — the same reason langchain was pointed at the gateway, not the provider
  (nothing may depend on an agent volunteering its own data).
- **C · Sidecar A2A proxy per xell.** For: keeps per-agent URLs "real". Rejected: N containers
  doing what one route with a `:slug` parameter does; every sidecar is another thing the reaper,
  the builder and the compose generator must know; and it still needs the mediator for delivery,
  so it adds a hop without removing one.

**Consequences.** Easy: discovery, auth, and recording live where every other gate already
lives. Hard: the queenzee API is a single point through which all agent traffic flows — but it
already is (every `zee say` transits it today), and the gateway split addresses its load story.
Impossible: true peer-to-peer streaming between two caged zees without the mediator in the path.
That is the point.

**Reversibility.** Fully — the mediated service does not preclude later per-agent endpoints;
the cards' `supportedInterfaces` would just grow a URL.

**What would change our mind.** Nothing foreseeable inside ZEEHIVE; the walls are the product.
Federation with an external fleet is handled at the fleet card (plan §7), not by opening cages.

---

## DR-3 — A2A objects are a projection over `zee_message`; the row stays authoritative

**Decision.** No new store. `postMessage` stamps an `meta.a2a` envelope (ids only, plus the one
stored flag `canceled`); Message/Task/TaskState are derived on read from columns the fleet
already writes (`delivered`, `delivery`, `read_at`, `kind`, plus tend/turn facts).

**Options considered.**

- **A · Envelope + projection** *(chosen)*. For: zero DDL until phase 3 (two expression
  indexes); a projection cannot drift from a store it does not copy; every existing reader
  (console, `zee inbox`, `messagesForXell`) is untouched; rollback is "stop stamping".
- **B · A first-class `a2a_task` table, dual-written with `zee_message`.** For: indexed task
  lookups from day one; a place for A2A-only fields. Rejected because dual-writes create the
  two-sources-of-truth problem this repo already documents on its message path (the
  delivery-correction race in `postMessage` exists precisely because two writers on one fact
  race) — and every consequential field the table would hold is derivable. The cost is a
  permanent reconciliation obligation for a lookup speed nobody has measured a need for:
  message volume scales with turns, and the whole fleet's measured turn count is 520 rows
  (docs/langchain-stateful-zees.md §1).
- **C · Replace `zee_message` with an A2A-native task store.** For: no translation layer at
  all. Rejected as a one-way door with live callers on the old shape: every console view, the
  manager verbs, the router intake, the reflection stage and the drift-tested manual all read
  `zee_message` — data outlives code, and this data is younger than none of its readers.

**Consequences.** Easy: honest states (derived from what actually happened, never a copy that
can lie). Hard: `ListTasks` filters jsonb until P3's indexes; state derivation must be a pure,
unit-tested function (the repo's own precedent: `decideMessageDelivery`). Impossible: A2A
fields with no ZEEHIVE fact behind them — which is a feature; inventing facts for wire
compliance is how a protocol adapter starts lying.

**Reversibility.** Complete until P3 (inert jsonb keys); after P3, dropping two indexes.

**What would change our mind.** Measured `GetTask` latency an expression index cannot fix, or
A2A v2 requiring server-stored state that is genuinely underivable.

---

## DR-4 — Identity: the xell slug is the agent; contextId is the thread; state is derived

**Decision.** Tenant key = xell slug (the seat, not the individual zee process); `version` on
the card = head commit sha; `contextId` minted per ordered conversation (from-xell, to-xell,
work item) and reused; `taskId` minted per task-opening message (directive / routing request);
TaskState mapping exactly as plan §3.3, including the honest `working`-forever for `typed`
deliveries into cages with no turn hooks (the reaper's KNOWN GAP is surfaced in task metadata,
never papered into `completed`).

**Options considered (per axis, the losing one honestly).**

- *Agent = zee id* (the individual agent process): survives nothing — a swap (`selfSwap`)
  replaces the zee but keeps the xell, the branch, the inbox and the manager relationship; an
  external peer holding a task against a zee id would lose its counterparty at every swap.
  The slug is what the fleet already treats as the durable identity (messages address slugs).
- *`auth-required` for human-gated waits*: tempting (a landing gate IS a wait on an authority),
  rejected for v1 because the state's defined meaning is an authentication exchange with the
  *client*; a conforming client would respond by trying to authenticate, which is not what a
  landing approval is. `input-required` (on tend) with the reason as status message says the
  true thing.
- *Backfilling envelopes onto historical rows*: rejected — invented ids on delivered-and-read
  history answer no caller's question and would make `ListTasks` imply tasks nobody ever opened.

**Consequences.** Easy: swaps, resumes and rebuilds are invisible to A2A peers. Hard: a task
can outlive the zee that accepted it (the swap inherits it — which is exactly what the swap
briefing already promises: "same database, same work-item card, and it still reports to you").
Impossible: addressing one specific zee incarnation. Deliberate.

**Reversibility.** Id semantics are the least reversible choice here (minted ids persist in
rows) — which is why they carry the most scrutiny in this record. The mapping *rules* can
change forward at any time; minted ids never get re-meant.

**What would change our mind.** A2A defining a standard agent-instance identity distinct from
agent identity.

---

## DR-5 — JSON-RPC binding implemented directly; no A2A SDK; no gRPC

**Decision.** Implement the v1.0 JSON-RPC binding (PascalCase methods, SSE streaming) as plain
express routes + one pure mapping module. Do not adopt `@a2a-js/sdk` (or any A2A server SDK);
do not offer gRPC.

**Options considered.**

- **A · Direct implementation** *(chosen)*. For: the surface is small (six methods that act,
  five that refuse with spec error codes — the plan's §3.2 table); the repo's server has zero framework dependencies
  today and its precedent is explicit — langgraph was refused because *"its pitch is owning
  the control flow, and ZEEHIVE already owns control flow"* (docs/langchain-stateful-zees.md).
  An A2A server SDK is built around an `AgentExecutor` interface that wants to own exactly the
  loop the queenzee owns (turn lifecycle, task state transitions). Bending its executor to be
  a thin shim is more code than the routes.
- **B · Adopt the JS server SDK.** For: conformance tracking upstream, streaming plumbing for
  free, types maintained by the project. Rejected for the executor-shaped reason above, plus:
  the SDK's in-memory/own task store collides head-on with DR-3 (the projection), so we would
  use the SDK minus its store minus its executor — i.e., its types. Types we can take from the
  spec's schema without the runtime. *(Worth re-checking at P3: if by then the SDK cleanly
  separates wire layer from store/executor, the FOR case strengthens.)*
- **C · gRPC binding (also or instead).** For: it is the proto's native shape. Rejected: no
  gRPC anywhere in this stack, no named caller wanting it, and v1.0 makes bindings optional —
  a second binding is cost with no payer (the Architect rule: extensibility you cannot name a
  user for).

**Consequences.** Easy: conformance is auditable by reading one module against one spec
section. Hard: spec upgrades are ours to track by hand (mitigated: `A2A-Version` header is
checked, `VersionNotSupportedError` -32009 is implemented from day one). Impossible: nothing —
an SDK can be swapped in later behind the same routes.

**Reversibility.** High.

**What would change our mind.** The SDK separating its wire layer from its executor/store; or
a conformance test-suite requirement from an integrator that the SDK passes and hand-rolled
code keeps failing.

---

## DR-6 — Auth is the two existing credentials, and A2A grants no new reach

**Decision.** Internal callers authenticate with the xell token (resolved like
`/api/xell/self/*`); external callers with `zhk_` project keys grown an `a2a` scope (migration
190's scheme). Crew scoping is enforced *behind* the protocol exactly as it is behind the
verbs today: A2A is a wire format, not a permission. External task views are id-scrubbed like
the ticketing API's answers.

**Rejected.** A third, A2A-specific credential (every credential is a lifecycle to manage and
a briefing to teach; two doors already exist with exactly the right two shapes);
OAuth2/OIDC now (no named integrator; the card's `securitySchemes` can grow schemes
additively). Card-level `securityRequirements` faithfully declare bearer — an external
conforming client needs no ZEEHIVE lore to connect.

**Consequences.** Easy: revocation, attribution and scoping are the existing machinery. Hard:
nothing new. Impossible: anonymous discovery — even the directory requires a credential,
because agent cards enumerate live agents and their tasks' existence is fleet-internal fact.

**What would change our mind.** A federation partner requiring mutual TLS or signed cards
(`AgentCardSignature` is in v1.0; the field is left empty, not misused, until then).

---

## DR-7 — External exposure is last, and is named as the one-way door

**Decision.** The phase order is envelope → read → write → external (plan §6), and phase 4 is
explicitly recorded as the irreversible step: the day a `zhk_` key with `a2a` scope is handed
to an integrator, the card shape, id semantics and state mapping become a contract ZEEHIVE no
longer owns unilaterally.

**Rejected.** Shipping the external door first ("interop is the payoff, start there") — it
front-loads the only irreversible commitment to the moment of least evidence, with the
projection untested by any internal caller. The internal phases are each fully reversible and
each produce evidence the next phase stands on.

**Consequences.** Easy: three phases of consequence-free learning. Hard: the payoff is last;
someone will be tempted to skip to it. This record is the answer to that someone.

**Reversibility.** P0–P3 fully (documented per phase in the plan); P4 never.

**What would change our mind about the ordering.** A concrete external integration deadline —
in which case the compression happens by overlapping P2/P3, never by skipping P1's envelope
(ids minted wrong are the mistake that cannot be unminted; see DR-4).
