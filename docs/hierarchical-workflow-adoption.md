# Hierarchical workflow adoption — replace-underneath, rollout to full rehab

**Status:** approved by the operator (2026-08-08): "rollout until full rehab."
**Source design:** the operator's "Hierarchical Workflow Model — Architecture" message
(four planes: DEFINITION / PLAN / DATA / RUN, plus the entity collapse) with companion
PostgreSQL DDL. That document is the design of record; this file records how ZEEHIVE
adopts it, what is corrected, and the rollout order.

## 1. The decision

Replace-underneath, not graft. `work_item` conflates the plan and the one attempt at it
(Plane 1 and Plane 3 in one row) — the exact modelling error the design exists to avoid,
and it cannot be fixed by adding columns. New tables are built as designed, the work
tracker API and the console (Board, Gantt, drawers) are re-pointed at them, the existing
items are migrated, and the old shape is retired. Rollout continues until the old
conflation is gone ("full rehab") — no permanent dual-run.

Migration is cheap by measurement, not hope: at decision time prod held 470 work items
with **zero** `starts_on`, **zero** `due_on`, and 3 `work_item_dep` edges. Each item
becomes a `work_node`; each item that ever ran becomes an `execution` reconstructed from
`work_item_event` / `zee_turn` / `land_request` timestamps.

## 2. The extended collapse: a project is a work_node

The operator's extension, adopted: `work_item.kind` (`project | activity | task`) was
always the containment tree flattened into an enum. It dies. A "project" in the
work-tracking sense is simply a root container node; "activity" and "task" are just
depths. Consequences:

- **Tenancy is a root binding, not a column.** The ZEEHIVE `project` table survives —
  it is the repo/deploy/context binding, which is a different noun — and a root
  `work_node`'s plan references it. Descendants inherit the binding lexically, the same
  way `wn_effective_policy()` resolves retry/timeout. No `project_id` stamped on every
  row.
- **A ticket is intake, not structure.** A ticket becomes a plan (via breakdown /
  template expansion); the plan's root is the end goal the gantt runs to.
- **The end-goal gantt is the root subtree's schedule**: executions supply the actual
  layer, CPM over the union graph supplies the planned layer, leases supply the
  waiting-on-a-human layer.

## 3. ZEEHIVE welds (what the general schema is silent on)

1. **Zees, humans and gates are entities.** A zee is a pull entity holding a long lease;
   `zee await` releases the turn into `waiting` under a held lease (the anti-spin
   primitive — the turn ENDS, tokens stop); `zee handover` writes output ports, and I14
   derives the ordering from the data. A human gate (`land_request`, ship, seed, done) is
   an action bound to a `human@console` pull entity — multi-day gate waits become
   `lease` rows and render as bars instead of being invisible.
2. **The observability join.** `zee_turn` gains `execution_id`; `llm_gateway_request`
   already carries `turn_id`. The chain `execution → zee_turn → llm_gateway_request` is
   the drill-down waterfall, and every row in it is a byproduct of a door (the gateway
   proxy, the queenzee's own state transitions) — never an agent submission. Langfuse is
   removed, not demoted (operator decision).
3. **Simulate-mode.** Push-dispatch entity adapters (provision/build/ship/deploy) are
   mode-gated exactly like every existing action path (`BUILD_MODE` / `PROVISION_MODE` /
   `SHIP_MODE`), per docs/nested-queenzee-containment.md.
4. **`kind_hint` lint** — a standalone test (same pattern as
   `test/cxell-cli-drift.test.mjs`) fails the build if engine logic ever branches on
   `entity.kind_hint`.

## 4. Corrections to the DDL as received

1. **`execution`'s UNIQUE constraint does not parse.** Postgres forbids expressions in
   UNIQUE *constraints*. Replace with a unique *index*:
   `CREATE UNIQUE INDEX exec_attempt_idx ON execution (run_id, work_node_id, attempt,
   COALESCE(map_index,-1), COALESCE(loop_iteration,-1));`
   As shipped, `CREATE TABLE execution` aborts the whole transaction.
2. **I12 is half-enforced.** `check_port_reducer` fires on `data_edge` insert/update
   only; removing the reducer from a `port` that already has ≥2 incoming edges is not
   caught. Add a mirror trigger on `port` UPDATE.
3. (Noted, not a defect) `detect_cycles` is exponential on dense freeform regions —
   acceptable as call-on-edit with `freeform` kept rare; report the freeform ratio as a
   plan-health metric per the design's own risk table.

## 5. Rollout order

Phase 0 is independent of the model and runs first — the new model makes these tables
MORE load-bearing:

- gateway meter reads zero (cost always $0; claude/grok token capture broken)
- `session_event.turn_id` NULL fleet-wide (play-by-play dead)
- gateway body capture (~32 KB caps, scrubbed, retention, per-project switch)
- spin alarm from the gateway ledger (interim until leases land)
- derive actual start/end for existing items (feeds the gantt during transition, and is
  the reconstruction logic the Plane-3 migration reuses)

Then the design's own build order, welded:

| stage | delivers | notes |
|---|---|---|
| A | this doc + corrected schema landed in `docs/` | dev-architect |
| 1 | core: plan/plan_version/work_node/dependency, union_edge, leaf-expanded detect_cycles | first real migration |
| 3 | durability: run/execution/event (append-only), idempotency keys | before any branching |
| 5 | entities + leases: zees/humans/gates as entities, capability matching, lease sweeper | replaces nudge/revive special cases with ONE wake path |
| weld | `zee_turn.execution_id`, gateway join, project-as-root binding, simulate gating | the observability spine |
| 6 | CPM forward/backward pass, slack, critical path → Gantt re-pointed | planned layer; label levelled output "feasible", never "optimal" |
| rehab | dual-write from existing verbs → migrate reads → migrate 470 items → retire old shape | full rehab: the conflation is deleted |
| 2/4/8 | data plane, choice/loop/trigger rules, signals | as demanded by real plans |
| 9–14 | map/race, replay, capacity, saga, templates, versioning | when the need shows up |

Stages 2 and 4 may pull earlier if the first drafted chains need typed handover
(ports) before the rehab completes; the weld stage's `zee handover --result` can
interim-store on `execution.outputs` until ports exist.

## 6. Verification

Per stage, a standalone `test/*.test.mjs` against real containers, and the design's §11
failure-semantics matrix filled before any operator beyond sequence/parallel/freeform is
implemented — unfillable cells are forbidden at the schema level, not left as runtime
incidents. The A1→B1, B2→A2 false-cycle case gets an explicit test on day one.
