# PROMPT — the work_node architecture of ZEEHIVE (self-contained)

> **How to use this document.** It is a self-contained prompt: hand it, whole, to a human or an
> agent who has never seen the ZEEHIVE repository, and they will hold an accurate model of what a
> `work_node` is, why it is shaped the way it is, what was rejected on the way, and what exists
> versus what is only designed. Every fact in it was read from the repository at the date below;
> §12 maps each claim to the file that proves it, for a reader who does have the repo.
> Written 2026-08-24 from the ZEEHIVE main branch (design: `docs/hierarchical-workflow-model.md`;
> adoption: `docs/hierarchical-workflow-adoption.md`; implementation: migrations 165–199 and
> `server/src/lib/work-node-sync.js` and neighbours).

---

## 1. The system, in two paragraphs

ZEEHIVE is a deterministic agent-environment orchestrator. It cuts isolated git worktrees
(**xells**), runs autonomous agents (**zees**) inside caged containers (**cxells**), and puts a
human gate in front of everything irreversible (landing to main, shipping to prod, touching prod
data). A meta-database records the fleet: projects, xells, zees, gates, turns, LLM-gateway calls.

For a long time that meta-DB recorded only **which agents were running** — never **what the work
was**. A manager zee had a hive and no plan. The first answer was a conventional tracker
(`work_item`: a project → activity → task tree with statuses). The second, current answer is the
**hierarchical workflow model**, whose central table is **`work_node`** — one table that carries
the plan of all work in the system, from a whole project down to a single prompt typed into the
console. The console's honeycomb is now work-node-centric: the URL *is* the work-node path
(`/project/child/child`), and a child node with no live agent renders as a vacant seat.

## 2. The problem work_node solves

Work decomposes two ways at once, and conflating them is the classic modelling error:

- **Containment** — "prep ingredients" *is made of* wash + slice. Part-of. Forms a tree.
- **Precedence** — wash *comes before* slice. An ordering relation. Forms a DAG.

Both get drawn as arrows on a whiteboard; they are different edge types with different algebra and
are stored separately (`work_node.parent_id` for containment; the `dependency` table for
precedence).

The theoretical boundary that shapes the design is exact: block-structured trees built from
*sequence* and *parallel* correspond precisely to **series-parallel partial orders** (Valdes–
Tarjan–Lawler). A partial order is series-parallel iff it contains no induced **N pattern**:

```
wash → chop,  marinate → chop,  marinate → preheat   (wash and preheat unrelated)
```

No bracketing of those four tasks preserves exactly those constraints — so process trees are a
strict subset of DAGs, and the boundary is sharp and detectable. **The design consequence:
DAG-over-tree is the substrate** (most general); process-tree operators are layered on top as an
annotation that buys back guarantees where they apply; HTN-style templates sit above as a generator.

## 3. The four planes

```
PLANE 0  DEFINITION   plan · plan_version · template · method   (immutable once published)
PLANE 1  PLAN         work_node · dependency                    (mutable, schedulable)
PLANE 2  DATA         port · data_edge · reducer                (typed, checked at plan time)
PLANE 3  RUN          run · execution · lease · allocation ·    (append-only, durable)
                      checkpoint · event
CROSS-CUTTING         entity · entity_member                    (anything assignable work)
```

**Referencing rule: a plane may reference the plane below it, never above.** A `work_node` points
at its plan_version and (eventually) template; a template never points at a work_node. An
`execution` points at a `work_node`; a `work_node` never points at an execution. This is what lets
you re-plan without corrupting run history, and replay a run against the exact plan version it
used. The old `work_item` violated exactly this: it conflated Plane 1 (the plan) and Plane 3 (the
one attempt at it) in one row — the reason it is being replaced underneath rather than extended.

## 4. work_node itself

**One table for containers and leaves** (Composite pattern), so rollup, dependencies, scheduling
and templates operate uniformly instead of forking into two code paths.

- `kind` is deliberately minimal: `container | action | signal`. There is **no `wait` kind and no
  `subprocess` kind** — waiting is a long lease held by a pull entity (§7), and a subprocess is an
  action bound to a plan-backed entity. Both were special cases that dissolved once entities were
  unified.
- `parent_id` (self-FK) + `sibling_rank` (lexorank-style text; unique per parent) carry the tree.
- `plan_version_id` ties the node to its plan; exactly one parentless root per plan_version
  (partial unique index `wn_one_root_per_version`).

Column groups (all on the one table):

| group | columns | note |
|---|---|---|
| structure | `kind`, `child_semantics` | semantics required iff container (I2/I3 CHECKs) |
| entity binding | `req_capabilities[]`, `req_constraints`, `req_selection`, `req_candidates[]`, `req_quantity`, `req_mode` | nodes describe what they NEED, never who does it; resolution at dispatch |
| operator-specific | `guard`, `loop_spec`, `map_spec`, `try_role`, `signal_spec` | CHECK-scoped to their operator; loops/maps must be bounded at the schema level |
| policy (inheritable) | `retry_policy`, `timeout`, `on_error`, `trigger_rule`, `idempotency`, `priority`, `calendar_id`, `scope_vars` | resolved by `wn_effective_policy()` walking up to the nearest ancestor that sets each field |
| scheduling | `estimate` XOR `estimate_dist`, `deadline`, `earliest/latest_start/finish`, `slack` | the earliest/latest/slack columns are **inert** — the CPM pass never writes them back (§8) |
| provenance | `template_id`, `method_id`, `bindings`, `stable_key` | `stable_key` is identity across plan versions AND the rehab's idempotency handle (§9) |

### 4.1 The operator set (`child_semantics`)

One field does the BPM work: ordering, completion rule, duration formula, and edge legality are
all functions of it.

| operator | children run | completes when | duration | explicit deps inside? |
|---|---|---|---|---|
| `sequence` | in `sibling_rank` order | all done | Σ children | no — implied |
| `parallel` | all, concurrent | all done | max children | no — contradictory |
| `choice` | one, by `guard` | selected done | max (worst case) | no |
| `race` | all; first finish wins | first done | min children | no |
| `map` | one instance per item (dynamic width) | all instances | max instances | no |
| `loop` | body repeated | exit condition | body × iterations | no |
| `try` | body; catch on error | per `try_role` | body (+ catch) | no |
| `freeform` | per explicit dependency edges | all done | CPM longest path | **yes** |

`loop` and `map` bodies are **contracted to a single vertex** in their parent's graph, so
repetition never makes the union graph cyclic — the same trick structured programming used against
`goto`.

**Implementation status:** the enum carries all eight values, but a stage-1 column constraint
(`wn_stage1_child_semantics`) restricts live use to `sequence | parallel | freeform`. Unlocking
choice/race/map/loop/try is a single `DROP CONSTRAINT` (the enum values were pre-created exactly so
no `ALTER TYPE` is needed later). The container-shape trigger for those operators (I7/I8/I9) lands
with them.

### 4.2 The edge legality invariant (the design's keystone)

> **An explicit `dependency` row is legal iff `LCA(from, to).child_semantics = 'freeform'`.** (I5,
> trigger-enforced; I6 additionally forbids ancestor↔descendant edges.)

Under `sequence` an edge is implied or contradicts rank; under `parallel` it contradicts
parallelism; under `choice`/`race` only one branch survives, so a cross-branch edge is incoherent.
What this buys: **non-freeform subtrees are sound by construction** (no analysis, no deadlock —
well-formedness *is* validity), cycle detection runs only inside freeform regions, and the N
pattern stays expressible (put the four tasks under a freeform parent). Keep `freeform` rare — it
is the only construct without structural guarantees.

## 5. dependency and the union graph

`dependency (from_id, to_id, type FS|SS|FF|SF, lag interval)` — `from_id` is the **predecessor**.
Classic CPM link types; negative lag = lead.

Scheduling and cycle detection **never read the dependency table alone**. The `union_edge` view
assembles edges from three sources: (1) sibling order under `sequence`, (2) explicit dependency
rows expanded per link type, (3) every data edge (I14 — pending until the data plane lands; the
view is written to take it as one appended UNION branch). Each edge carries its link `type` so CPM
interprets `lag` correctly.

**Leaf expansion is not optional.** Contracting each subtree to one vertex reports false cycles:
with `A = sequence[A1,A2]`, `B = sequence[B1,B2]`, edges `A1→B1` and `B2→A2`, the contracted graph
shows `A→B→A` (a cycle) while the expanded graph is the acyclic path `A1→B1→B2→A2`. So dependency
endpoints expand via `wn_first_leaves()` / `wn_last_leaves()` (FS: last leaves of *from* → first
leaves of *to*; SS: first→first; FF: last→last; SF: first→last), and `detect_cycles()` walks the
expanded view. This exact counterexample has a dedicated test.

## 6. Tenancy and policy: everything inherits lexically

The general design is silent on tenancy; ZEEHIVE welds it in **one column**: `plan.project_id`. A
plan binds to a ZEEHIVE project at the root; a `work_node` deliberately has **no** `project_id` —
descendants inherit the binding lexically, exactly the way `wn_effective_policy()` resolves
`retry_policy`/`timeout`/`on_error`/`priority`/`calendar_id` by walking up to the nearest ancestor
that sets them. Configure once at the root, override at three nodes, not at four hundred leaves.

## 7. The run plane and the entity collapse

- **`run`** — one instantiation of a plan_version (`version_policy` currently pinned-only).
- **`execution`** — one row per work_node **per attempt** (retries, map instances and loop
  iterations each get their own row; reusing one row per node destroys history the moment anything
  retries). Snapshots `inputs`, records `outputs`/`error`, carries `effect_key` (idempotency:
  unique per run among successes — at-least-once delivery without it means duplicate charges).
  Lifecycle: `pending → ready → running → done | failed | waiting | cancelled | skipped | blocked`,
  plus `compensated` as a **distinct terminal state** (a partially rolled-back subtree must not
  read as done or failed).
- **`event`** — append-only (trigger-enforced). One deliberate escape hatch: DELETE is permitted
  only when the session opts in via a custom GUC (`zeehive.purge_events`) — retention/GDPR purge
  and test teardown; UPDATE is forbidden always, no hatch. (The naive trigger made the first event
  row render its run permanently undeletable.)
- **`checkpoint`** — run snapshots for replay.

**Entities.** *An entity is anything that can be assigned work and eventually return a result* —
person, model, script, service, pool, org unit, or another plan. The differences are **parameter
values, not subtypes**: dispatch mode (push/pull), latency, reliability, cost model,
cancellability, determinism, concurrency, calendar, rate limit, consumable-or-not. `kind_hint`
exists so dashboards can draw an icon; **the moment engine logic branches on it the abstraction
has failed** (a lint test enforces this). Uniform contract: `assign → lease`, `poll`, `cancel`.
`entity.plan_id` set means assigning work launches another plan — recursion all the way down, which
creates a **second graph** (the plan call graph) with its own cycle detection.

**Leases make the collapse real.** Push entities hold seconds-long leases renewed by heartbeat;
pull entities (people, zees) hold day-long leases renewed by opening the task. **Lease expiry is
the universal timeout**: a crashed worker and a person on holiday are the same event — the lease
lapsed, requeue. This is why there is no `wait` node kind.

**The ZEEHIVE welds** (what the general schema was silent on):

- A **zee is a pull entity**. `xell.execution_id` binds a xell to the execution its zee is
  advancing; `zee_turn.execution_id` stamps each turn, so the chain
  **execution → zee_turn → llm_gateway_request** is the drill-down observability waterfall — every
  row a byproduct of a *door* (queenzee state transitions, the gateway proxy), never
  agent-submitted.
- **`zee handover --result <json>`** stores a typed result on `execution.outputs` (interim until
  the data plane's ports exist; a second handover is refused without `--override`; an immutable
  `execution.handover` event keeps the history).
- **`zee await`** ends the agent's turn (tokens stop — the anti-spin primitive), flips the
  execution to `waiting`, and inserts a held `lease` row; the queenzee resumes the work when the
  lease lapses or is released. Human gates (a landing held for approval) are modelled the same
  way, which is how multi-day gate waits become visible bars instead of invisible time.

## 8. Scheduling: CPM as a read model, durations from evidence

`wn_cpm(plan_version, start)` runs forward/backward passes over `union_edge` and **returns**
earliest/latest start/finish, slack, and the critical path for atoms, with containers reporting
their subtree span. It is a **read model by constraint, not style**: it never writes the
`work_node.earliest_*/latest_*/slack` columns — no agent stores a pass back onto the plan.

**Duration source per atom, in order** (so a made-up number is always traceable):
1. the explicit `estimate` (a 0 estimate counts as no estimate);
2. the **measured actual** — `AVG(finished_at − started_at)` over that node's closed executions
   (what it took last time is the best estimate anyone has, and it is free);
3. an honest default: **one day per unestimated action**. Containers never take the default — they
   roll up from children (sequence Σ, parallel max), so an epic is the sum of its parts.

Performance history worth knowing: the first CPM implementation re-evaluated the `union_edge` view
once per node per pass (≈3n full view builds — 20.7 s for a 157-node plan, timeout at 354); the fix
materialises the edge set once into arrays (≈50–60 ms, ~45–180×), and a follow-up removed
per-container re-querying of execution actuals. Two-phase rule: unconstrained CPM first, resource
levelling second (only ever pushing later); once entities are contended this is RCPSP (NP-hard) —
output is labelled **"feasible," never "optimal."**

The **gantt** draws three layers per row: PLANNED (CPM), ACTUAL (execution timestamps), WAITING
(held leases on `waiting` executions — measured reality: landings avg ~10 min, holding patterns avg
~6.5 days, hence the timescale clamp). Edges come from `union_edge`, and a collapsed parent's edges
re-anchor to the nearest visible ancestor client-side. Clicking a bar opens the
execution → turn → gateway waterfall with no second round trip.

## 9. The adoption story: replace-underneath ("full rehab")

The legacy `work_item` (project/activity/task tree) conflated plan and attempt — the exact error
the model exists to avoid — so the decision (operator-approved) was **replace underneath, not
graft**: build the model as designed, re-point the readers, migrate the data, retire the
conflation. No permanent dual-run. Migration was cheap by measurement, not hope (at decision time:
~470–503 items, zero `starts_on`, zero `due_on`, 3 dependency edges).

How it is wired today:

- **The kind enum dies.** `work_item.kind` was the containment tree flattened into an enum: a
  "project" is simply a root container node, activity/task are depths. `node_kind` is derived from
  **shape** (has children ⇒ container, else action).
- **Backfill**: every work_item became a `work_node` with `stable_key = 'work_item:<uuid>'` (the
  idempotency handle); containers got `sequence` semantics (sort_order is a total sibling order),
  or `freeform` exactly when the container is the LCA of an explicit dependency edge (the only
  semantics I5 permits). Two backfill defects were found and repaired on live data by a follow-up
  migration: dependency **direction was reversed** (the legacy table's write order means the
  opposite of the model's from=predecessor), and sibling_rank's zero-padded encoding broke on
  fractional/negative kanban sort orders (fixed with a sign-safe fixed-point encoding shared with
  the dual-write).
- **Dual-write**: every legacy writer keeps both shapes true in the **same transaction**
  (`work-node-sync.js`): a work_item upserts its work_node, a status change writes an execution, a
  dependency edit writes the model edge. A failure rolls the whole pair back — a half-written pair
  is worse than no rehab.
- **work_item survives as the ATTRIBUTE ANNEX** (deliberate, revisited decision): the model is
  authoritative for the plan shape (which rows exist, parentage, sibling order, node kind), the
  dependency edges, and the actuals (executions). work_item still owns the attributes the model
  demonstrably does not: title, body, status vocabulary (the run plane collapses review/shipping
  to `waiting`), priority, ticket_id, assignee (`xell_id` — the lease plane was empty when the
  reader moved; re-pointing assignment at leases would have rendered every card unassigned),
  progress, sort_order, created_by, and the human comment trail. Stopping that dual-write would
  draw blank cards.
- **`work_item_dep` is retired** (dropped, with a refuse-unless-fully-mirrored guard); the model's
  `dependency` table is the one source of truth for edges.
- **A project IS a work_node**: one root node per project (`stable_key = 'project:<project_id>'`,
  container, sequence, parent NULL) so a project-level gantt exists — the whole project's span
  from start to end goal.
- **Any new prompt is a work_node**: a console "+ prompt" (any dispatch not already for a card)
  cuts a task item — and therefore, via the dual-write, a work_node — under the honeycomb context
  it was dispatched from (falling back to the project root). No more itemless workers the board
  never saw. The parent is advisory: a stale context must never fail a dispatch.
- **Parent-first discipline** (manager verbs + manual): a parentless leaf task is refused with a
  sentence; `zee work --new --after <sibling>` creates a card under the same parent AND the FS
  dependency in one call; the console board is a swimlane matrix, one collapsible row per parent
  work_node; the honeycomb URL is the work-node path.

## 10. Decision record — what was rejected, and why

| rejected | why |
|---|---|
| Graft columns onto `work_item` | it conflates Plane 1 and Plane 3 in one row; columns cannot fix a conflation. Replace-underneath was approved instead. |
| Separate container/leaf tables | forks rollup, dependencies, scheduling and templates into two code paths; the Composite single table keeps them uniform. |
| A `wait` node kind / a `subprocess` node kind | both dissolve under the entity collapse: waiting = long lease on a pull entity; subprocess = action bound to a plan-backed entity. |
| One edge table for containment + precedence | different algebra (tree vs DAG); conflating them is the root modelling error. |
| Contracted (per-subtree) cycle detection | reports false cycles (the A1→B1, B2→A2 counterexample); usable only as an early-out that must never reject. |
| Dependencies legal anywhere | under sequence/parallel/choice/race an explicit edge is implied, contradictory or incoherent; I5 confines them to freeform LCAs and buys soundness-by-construction everywhere else. |
| `project_id` stamped on every node | tenancy is a root binding inherited lexically, like every other policy; a stamped column is a denormalisation that can drift. |
| One execution row per node, updated in place | destroys history on the first retry; per-attempt rows are the run plane's whole point. |
| Branching engine logic on `entity.kind_hint` | unravels the entity collapse; display-only by contract, lint-enforced. |
| Storing CPM results on work_node | a stored schedule is a cache with no invalidation; the pass is a read model, enforced as a constraint. |
| Stored roll-ups (parent dates/progress) | stale the first time anyone edits a leaf; roll-ups are read-model concerns. |
| Retiring `work_item` entirely, now | the model lacks body/comments/assignee homes; retiring the annex would blank the console. The annex shrinks as the model grows the fields. |
| A strictly append-only event log with no purge | made runs undeletable and retention impossible; the session-GUC hatch keeps I16's intent (no silent rewriting) while making the cascade honest. |

**Reversibility:** the rehab's drop of `work_item_dep` and the retirement of the kind enum are
one-way doors (taken knowingly, with a refuse-unless-mirrored guard). The stage-1 operator
restriction, the annex, and every "not yet built" item below are two-way: each unlock is an
additive migration.

## 11. Built vs designed-only (as of 2026-08-24)

**Built and live:** Planes 0/1 (plan, plan_version, work_node, dependency), tree algebra
(ancestors/LCA/atoms/first-last leaves), union_edge + leaf-expanded detect_cycles + I5/I6 trigger,
policy inheritance + duration rollup, Plane 3 (run/execution/event/checkpoint + append-only +
purge hatch), entities + leases + capability schema + operational views
(lease_expiring/entity_load/orphaned_work), the observability weld (xell/zee_turn.execution_id),
CPM (optimised, evidence-based durations), the rehab (backfill, dual-write, readers re-pointed,
work_item_dep retired, project root nodes), prompt-as-work_node dispatch, parent-first manager
verbs, the work-node-centric console (board, gantt, honeycomb URL).

**Designed, not yet built:** Plane 2 (port/data_edge/reducers; I12 reducer-required, I14
data-implies-precedence — `zee handover` interim-stores on `execution.outputs` until then); the
choice/race/map/loop/try operators (enum values exist; column constraint locks them);
template/method (HTN generation — lazy expansion, no backtracking, bounded recursion); version
policies beyond `pinned`; resource levelling; saga/compensation; signals in anger. The failure-
semantics matrix (operator × failure mode) must be filled before any new operator is implemented —
unfillable cells get forbidden at the schema level, not left as runtime incidents.

## 12. Where each claim lives (for a reader with the repo)

- Design of record: `docs/hierarchical-workflow-model.md` (+ `docs/hierarchical-workflow-schema.sql`)
- Adoption + corrections + rollout order: `docs/hierarchical-workflow-adoption.md`
- Migrations (`db/migrations/`): 165/166 planes 0–1 + union graph; 167/172–175 the parallel narrow
  stage-1 set; 176 convergence to the wide shape; 177/178 run plane + purge hatch; 179 entities +
  leases; 180 observability weld; 184/189/194/197 CPM + optimisation + durations;
  185/186 backfill + repair; 188 retire work_item_dep; 191 project root nodes; 199 parent-first.
- Server: `server/src/lib/work-node-sync.js` (dual-write), `work-item-model.js` (model read layer +
  the annex design), `work-items.js` / `work-assign.js` (tracker + assignment),
  `workflow-gantt.js` (three-layer timeline), `prompt-work-node.js` (dispatch weld),
  `server/src/queenzee/self.js` (`zee handover` / `zee await`).
- Console: `web/src/hive/HiveCanvas.jsx` (work-node honeycomb, vacant seats), `web/src/work/`
  (Board, Gantt), `web/src/App.jsx` (URL = work-node path).
- Legacy tracker nouns/verbs: `docs/work-tracker.md`, `docs/work-tracker-verbs.md`.
