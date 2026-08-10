# Decision Record: Machine-aware pooling is the DEFAULT when machines exist

**Date:** 2026-08-10
**Author:** Architect (machine-aware-pooling-is-disabled-local-mard-eccb04)
**Status:** Implemented (same day — machines.js `poolMachines`/`implicitPoolMachine`,
pool.js, provision.js, App.jsx/Machines.jsx; test `pool-machine-default.test.mjs`).
**Extends:** [`process-machine-pooling-decision-record.md`](process-machine-pooling-decision-record.md)
(which made the queenzee-host row govern process projects when configured; this record removes
the "when configured" requirement for everyone).

## Decision

When machine rows exist, the pool maintainer is machine-aware for EVERY project with zero
configuration, two rules:

1. **Either knob activates a machine** for a project's pool: a `machine_pool` row with
   `pool_size>0` alone now pools there (`poolMachines`). `dev_priority` keeps its own meaning
   (spawn targeting, `devMachines`, unchanged — pinned by `machine-pool-per-project.test.mjs`).
2. **No `machine_pool` rows at all → the implicit default** (`implicitPoolMachine`): the
   project-wide `pool_config.target_ready` pools on the ONE machine that can actually host the
   project — the queenzee host for process projects (counted project-wide), the oldest machine
   holding the project's shared dev db for compose projects (couplings that need no shared db
   default to the queenzee host) — machine-aware count and `max_xells` cap included, and
   dispatch-time fresh spawns place on the same machine. Only a hive with no machines, or none
   eligible, still takes the placeless legacy path.

The operator's model becomes: **the matrix knobs always work; the project-wide knob is the
budget until a per-machine number exists.** No mode to know about, no predicate to satisfy.

## Context

The operator, after the first fix shipped: *"I don't need instructions, I need it so that it
should be simple — machine-aware pooling should be the default if there is more than one
machine."* The residual friction was real: machine mode was opt-in per (machine, project) —
until someone set `dev_priority>0` somewhere, every project pooled by the legacy project-wide
path even on a hive full of machines, and a `pool_size` set without also setting `dev_priority`
was silently dead (two knobs to make one thing happen).

## Options considered

**A. Auto-seed `machine_pool` rows** (on machine or project creation, defaults dev_priority=1).
For: the matrix shows the state as data. Rejected: it writes config the human never chose,
needs seeding for every future project × machine (two creation paths to hook, forever), and
turning a machine OFF for a project then means deleting rows someone "set" — the difference
between a default and a recorded choice disappears.

**B. Every enabled machine is a target by default.** For: the literal "more than one machine"
reading. Rejected: it aims dev xells at machines that cannot host them — a production host, the
NAS, any machine without the project's shared dev db, where `provisionXell` deliberately
REFUSES — turning a quiet default into a stream of provision failures. Placement breadth stays
an explicit choice; the default is the one machine that provably works.

**C. Chosen: either-knob activation + eligibility-gated implicit default.** The `machine_pool`
row stays the only stored config; defaults are computed at read time and disappear the moment a
real choice exists.

## Consequences

- A new project on a machined hive pools machine-aware from its first tick; setting a pool size
  in the matrix works with no second knob; the project-wide knob keeps working as the implicit
  budget (App.jsx shows it exactly when it governs).
- Behaviour change: a compose project with NO per-machine config now places its pool on the
  dev-db machine instead of the legacy dev-site fallback — same machine in every fleet we know
  of (the db and the site agree), but a fleet where they differ will see placement move. The
  implicit choice is logged once per change ("pooling for project … defaults to machine …").
- The implicit default is deliberately single-machine. Spreading a target across machines is
  policy nobody asked for; a human who wants two machines sets two numbers.

## Reversibility

Pure code, no schema, no data written. Revert restores opt-in behaviour; `machine_pool` rows
are untouched either way. What would change our mind: a fleet where the dev-db machine and the
intended dev site genuinely differ (the implicit choice would then need to read the site row
too), or an implicit default observed overfilling a host despite `max_xells` (would point at a
counting gap, not at the default).
