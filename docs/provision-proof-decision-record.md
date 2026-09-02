# Decision Record: provision proof — proven chips before a zee, and the infra-medic harness

**Date:** 2026-08-31 (DR-5 corrected 2026-09-02 — the infra-medic was re-decided from a worker
harness to a MANAGER zee on the orchestrator's own project; see the amendment in DR-5).
**Author:** Architect (xell `figure-out-how-to-make-sure-the-xells-provis-aa002c`)
**Status:** Decided — design only; implementation is cut as follow-up phases (the companion
[provision-proof-plan.md](provision-proof-plan.md) is the plan).
**Supersedes:** nothing. **Extends:** #53 (preflight), #173 (build-readiness), migration 233
(build-failure classes), `docs/self-project-prod-data.md` (the no-write-role rule).

The context, once, for all decisions below: pooled xells are stamped `ready` unproven; the DB
preflight stamps a verdict nothing consumes (`readyXells`/`claimReadyXell` never read it); no
app tier is ever built before a zee's first `zee build`; the two live incident classes
(TKT-178 docker address-pool exhaustion, TKT-85 clone-db host-port collision) pass every static
check that exists and surface only on a real build/up — on the zee's clock, after dispatch; and
the #47/TKT-181 credential fault recurs because dispatch-time binding changes are never
re-preflighted. Constraint set: a running fleet (no flag day), the claim CAS discipline
(TKT-88-D6B4), the preflight "never writes" contract, `simulate` modes for nested queenzees, and
the meta-DB write prohibition for agents.

---

## DR-1 — The proof is the REAL build path, run on the pool's clock

**Decision:** a xell is proven by executing the same `zee build` path its zee will use
(`build.js` → `build-container.sh` with the meta-DB's recorded facts) plus the existing pure DSN
preflight, before the xell counts as claimable stock; the work runs on the pool maintainer's
clock, capped per machine.

**Options considered:**
- *Chosen — real path, pool clock.* For: proof and reality cannot drift (any project, any
  manifest, any build script — the abstraction already exists and every role already goes
  through it); the cost lands where `spawn-prep` already established it belongs ("who pays:
  `when`"); the evidence rows (`last_build_commit`, `health`, error class) already exist.
- *Static probes only (extend `compose config -q`, network/volume inspects).* For: cheap,
  instant, no containers held. **Rejected:** empirically insufficient — both live incident
  classes pass every static check; address-pool exhaustion and port-bind collisions are only
  observable by attempting the real thing. This is the band-aid the directive forbids.
- *A synthetic canary build (hello-world image + scratch container per machine).* For: cheap,
  catches daemon/network faults. **Rejected:** it proves the machine, not the project — a
  project whose own Dockerfile, compose interpolation or port slot is broken stays green. Kept
  as nothing: the machine half is already covered by recording the real probe (§4.4).
- *Burn-in at dispatch time (prove, then spawn).* For: freshest possible verdict. **Rejected:**
  minutes of build land on the human waiting for the zee — the exact cost `spawn_prep.when`
  exists to move off the dispatch path. The dispatch-time piece is only the 5s pure preflight.
- *One shared proof per (machine × project), no per-xell burn-in.* For: N× cheaper.
  **Rejected as the whole answer:** the observed faults are per-xell — port slots collide per
  slot, the emitted `.zeehive.env` DSN is per xell (#47/TKT-181). Kept as the half it is worth:
  machine×project verdicts are recorded and short-circuit hopeless proving (DR-2).

**Consequences:** pooled xells hold running containers earlier (they already do for spin-env
projects; compose projects now match) — memory/CPU on pool hosts rises; the cap and
`pool_size` are the levers. Makes easy: "ready means proven", broken-main detection as a free
byproduct. Makes hard: nothing that was previously possible; the knob (`off`) restores today.
**Reversibility:** full — fire-and-forget queue, additive columns, knob to `off`.
**Would change our mind:** if proof cost dominates pool hosts in practice (measure: proof
minutes per machine per day), move to proving a SAMPLE per (machine, project, commit) and
per-xell-proving only the db/env half — the interfaces already split along that line.

## DR-2 — Verdicts are additive columns + a recorded machine×project row, never a new xell status

**Decision:** `xell.proof_at/proof_error/proof_checks/proof_commit` (stamped summary; evidence
stays on container rows) and `build_readiness_record(machine_id, project_id, status, checks,
probed_at)` with latest-per-pair uniqueness.

**Options considered:**
- *Chosen.* For: mirrors `preflight_*` exactly (one pattern, already understood); the claim CAS
  stays one statement; NULL semantics ("never proven") give the backfill a first-class state.
- *New `xell.status` values (`proving`, `proven`).* For: visible in every existing status
  reader for free. **Rejected:** `status='ready'` is the load-bearing token of the
  claim-vs-sweep CAS (TKT-88-D6B4); every conditional UPDATE, fill count, sweep take/untake and
  console pivot would need to learn the new values in the same release — a fleet-wide
  coordinated change to fix one predicate, and the incident record shows exactly this seam is
  where races live.
- *A separate `xell_proof` table.* For: history per xell. **Rejected:** the row-per-xell verdict
  is what every consumer wants (claim join, hexagon, `zee status`); history already lands in the
  event log and loglines. A table would be the second place to look for one fact.
- *No machine record — keep the probe on-demand.* **Rejected:** the pool cannot consult a
  verdict that only exists while a human's console tab is open; 20 containers failed forever on
  a machine whose probe would have said `missing` — had anything persisted it where the fill
  looks.

**Consequences:** two more stamped-verdict columns to keep honest (the same "stamp, never
gate-by-accident" discipline as preflight). **Reversibility:** columns are additive; dropping
them is one migration. **Would change our mind:** a real need to render proof history per xell
in the console → add the table THEN, fed by the same stamp call.

## DR-3 — Gating is a per-project knob: `off` → `advisory` → `required`, defaulting advisory

**Decision:** `pool_config.readiness_proof` with three values; the `required` conjunct lives
inside the claim CAS (a `pool_config` join, still one statement); rollout flips projects to
`required` individually, zeehive first.

**Options considered:**
- *Chosen.* For: a running fleet converges without a flag day; `advisory` + proven-first
  ordering delivers most of the value (dispatches stop LANDING on known-broken xells because
  proven ones sort first) while the backfill catches up; `required` is the end state the
  directive asks for ("even before a zee is deployed, that part is already solved").
- *Hard gate from day one.* For: honest immediately. **Rejected:** the moment it deploys, every
  existing pooled xell has `proof_at IS NULL` — the entire fleet's stock becomes unclaimable
  until the backfill finishes; on a machine that genuinely cannot build (the omnibiz 20), the
  project would have NO dispatch path at all, including for the zee sent to fix it.
- *Advisory forever (surface, never refuse).* **Rejected:** that is the preflight lesson
  verbatim — #47 was stamped on every affected row all night and seven zees were dispatched onto
  it anyway. A verdict nothing consumes is decoration; TKT-181 proves it recurs.
- *Global knob instead of per-project.* **Rejected:** projects differ in exactly the dimension
  that matters (process-runner vs compose, machine estates); one project's flaky build must not
  hold another project's gate hostage.

**Consequences:** under `required`, an all-red machine estate means NO pooled dispatch for that
project until fixed — deliberate, and the failure routing + medic exist to make "fixed" fast;
the fresh-spawn path (plan §4.7) remains the escape hatch and is surfaced, not silent.
**Reversibility:** knob per project, downward any time. **Would change our mind:** if `advisory`
ordering alone drives dispatches-onto-broken-xells to ~zero for months, `required` may stay
opt-in — the measure is named in the plan (§9).

## DR-4 — Every binding change re-runs the pure preflight before the zee spawns

**Decision:** `attachXellDb`, `cloneInstanceFor` and the clone-switch path re-run
`runPreflight` on the NEW DSN (bounded, 5s) and honour the policy knob; the clone/spin db port
allocator additionally checks daemon-bound ports and retries the next slot on bind refusal.

**Options considered:**
- *Chosen.* For: closes #47/TKT-181 at the moment the fault actually exists (the provision-time
  preflight proved a binding dispatch then replaced); the probe is pure, cheap, already written.
- *Preflight only at provision (status quo).* **Rejected:** it verifies a DSN the zee will never
  hold whenever dispatch attaches/clones — which is the default flow for db-clone projects.
- *Retry/port-hunt only, no re-preflight.* **Rejected:** fixes TKT-85 but not TKT-181; the
  SCRAM fault is not a port fault. The two are complements: allocator fixes what it can,
  preflight catches whatever class comes next.
- *Have the zee verify first thing in-cage.* **Rejected:** that is today's workaround (the
  conditions block instructs exactly this), and it spends an agent turn to discover what the
  queenzee could know for free before spawning it.

**Consequences:** dispatch gains up to 5s on binding-changing paths; a refusal under `required`
means a dispatch can fail where it used to "succeed" into a broken cage — the refusal names the
check, which is strictly better information. **Reversibility:** full (advisory mode keeps the
old behaviour with a stamped verdict). **Would change our mind:** nothing foreseeable; this one
is the cheapest correctness in the design.

## DR-5 — The infra-medic is a MANAGER zee on the orchestrator's own project: whole-meta-DB read, human-gated config writes, a capability column

**Correction 2026-09-02 (the medic-rework card).** This decision was first made on 2026-08-31 as
*a worker harness* — the medic wore the harness in a worktree of the blocked project and landed
manifest/compose fixes through the ordinary land gate. The first PROVISION-INFRA dispatches
against that model corrected it: a PROVISION-INFRA card names a machine×project pair that cannot
build because the project's **config** is wrong (manifest cache, pool knobs, machines, shared-dev
db) — and the fix is a meta-DB config change, not a code change. Whoever fixes it must be able to
read the **whole** meta-DB, because every project's config lives in the one orchestrator
database — and no worker of any single project is. So the medic is re-typed below from worker to
MANAGER-on-Zeehive. What survives the correction unchanged: no write DSN on any path, mutation
stays human-gated, the capability column (not the bundle) is the grant, and project creation
stays human (DR-6). The original "worker" text is superseded; the decision is restated in place.

**Decision:** the `infra-medic` harness is MANAGER-type (migration 242 re-types the harness row
and its bundle mirror; no new zee TYPE is invented). It is worn only by manager zees created on
the **orchestrator's own project** (`createManagerZee` on Zeehive — whose production database IS
the meta-DB), never as a worker of the blocked project. Because it is a manager on Zeehive, its
manager prod-read already sees the whole fleet's config read-only; its one capability
(`infra-troubleshoot`, a jsonb column allowlist-triggered at 237 — never a bundle field)
additionally mints the per-xell SELECT-only meta-reader (`ZEEHIVE_META_RO_DSN`,
`prod-readonly.js` machinery, secret columns revoked, dropped with the xell), mirroring
`bindManagerToProdReadonly`'s lifecycle exactly. Every verb takes an **explicit TARGET project**
(`--project <name|id>`, name or id): the reads and burn-ins (`readiness`, `proof`,
`bootstrap-plan`, `settings`) are open across projects; the two mutations (`bootstrap --perform`,
`propose --change`) are HUMAN-GATED `infra_request` cards filed on the target that the QUEENZEE
performs on approval — never the medic, which holds no write DSN. The routes are the
`/api/xell/self/infra/*` family, capability-gated through the effective harness chain.

**Scope wall (the design's load-bearing line):** the medic fixes **meta-DB config rows only**.
It never touches another project's code, repo, branches, ships or production data — its cage
holds only the Zeehive repo (structural, not willpower). A fault needing a CODE change to
another project is reported with the named `check` + `detail`, never fixed. A fault needing
ZEEHIVE code is how the manager type is used: it dispatches a Zeehive worker (`zee dispatch`).

**Options considered:**
- *Chosen (2026-09-02) — a manager zee on the orchestrator's own project.* For: ZEEHIVE's
  production database IS the meta-DB, so a manager there already holds prod-RO over the whole
  fleet — the read half of "read wide" needs no new machinery, and re-typing the one harness row
  (migration 242) needs no `ZEE_TYPES` taxonomy change; managers cannot land code, which is now
  exactly right — the medic's whole surface is meta-DB config rows, not project files; a ZEEHIVE
  code fault stays reachable through the manager's `zee dispatch`. The 2026-08-31 rejection of
  this option ("managers cannot land code … the medic's levers are commits, proofs and gated
  asks") is answered by the correction: the medic's levers turned out to be **config reads and
  gated asks**, not commits — the first live dispatches proved a PROVISION-INFRA fix is a
  manifest-cache refresh or a settings/pool change, all queenzee-mediated verbs, none of them a
  land gate.
- *The original 2026-08-31 decision — a worker harness (superseded).* For (then): a worker in a
  worktree can land manifest/compose fixes through the ordinary land gate. **Rejected
  (2026-09-02):** a PROVISION-INFRA card is a CONFIG fault, not a code fault — landing a
  project-file fix is the wrong surface, and the worker of the blocked project structurally
  cannot read the WHOLE meta-DB (only its own project's rows), so it cannot even see most of the
  config a diagnosis needs. The first dispatches against the worker model were how this surfaced.
- *A limited write role on the meta-DB.* **Rejected:** `docs/self-project-prod-data.md` already
  rejected it with the incident behind it — any role that can UPDATE xell/DELETE container is a
  nested reaper. This is the specific cost, not a preference.
- *A new zee TYPE (`infra`) beside worker/manager.* For: types already gate harness fit.
  **Rejected:** type is woven through dispatch, pickers, triggers and pool selection
  (`ZEE_TYPES`); a third value is a fleet-wide change to express one route guard. Re-typing the
  one harness worker→manager (242) gets the whole model without the taxonomy change.
- *Console-only troubleshooting (no harness — humans click bootstrap).* **Rejected:** that is
  today, and the estate is losing: the human is the bottleneck the directive names, and the
  diagnostic loop (read verdict → reproduce → narrow the lever → propose) is agent-shaped work.
- *A manager MEDIC as a separate harness beside infra-medic.* **Rejected as redundant:** the
  correction re-types the existing harness rather than minting a sibling — one row, one runbook,
  one capability grant; the capability column still lets a future harness (e.g. an onboarding
  concierge) carry the same grant without a taxonomy change.

**Consequences:** makes easy: one dispatch that can diagnose ANY project's provisioning end to
end (reads open across projects because it lives where the whole meta-DB is readable) and drive
onboarding to the three-light definition of done. Makes hard (deliberately): any agent fixing
infra WITHOUT a human reading the plan first, and any agent editing a blocked project's code —
the scope wall plus the manager refusal surface (`zee land`/`zee ship` are not the manager's
verbs) make it impossible. Makes impossible: the medic mutating the meta-DB directly — postgres
refuses. **Reversibility:** re-type the harness back to worker or empty its capability; the RO
role dies with each xell.
**Would change our mind:** if gated `propose --change` cards turn out to be so frequent and so
rubber-stamped that the gate is pure latency, promote SPECIFIC named settings (e.g. machine
dev_priority) to ungated — one at a time, by name, with this record superseded per setting.

## DR-6 — Project creation stays human; the medic drives everything after it

**Decision:** onboarding/initiating a project keeps its console entry point (a human names the
repo, the machines, the credentials); the medic owns convergence from that click to the
three-light readiness certificate (manifest parses / a machine records `ok` / first xell proof
green) and is the standing owner of keeping it green.

**Options considered:**
- *Chosen.* For: the create step names things the fleet cannot yet see (host paths, contexts,
  credentials) — exactly the facts a caged agent structurally lacks; everything after is
  meta-DB + probe + gated-ask work the medic holds all the levers for.
- *Fully agent-performed onboarding.* **Rejected:** a cxell cannot see the host filesystem or
  docker to even validate the repo path it was given; the "runbook that ages badly" failure
  (`onboard-mardale-prod-alt.md` warns for itself) shows host-side steps cannot be delegated to
  a cage. It would require widening the cage — the one cost this product never pays.

**Consequences:** onboarding acquires a machine-checkable definition of done where today it has
folklore. **Reversibility:** trivial (it adds a checklist, changes no flow).
**Would change our mind:** a queenzee-host agent runtime with human-gated host actions — a
different product decision; supersede then.

---

**Hard-to-make note (per the record rule):** DR-1's rejection of dispatch-time burn-in and DR-3's
refusal of a day-one hard gate were the two genuinely contested calls — both trade immediate
purity for a fleet that keeps moving. The tiebreaker in both was the same house precedent
(`spawn_prep.when`, the advisory-first preflight): this codebase has twice before chosen "move
the cost to the pool's clock, surface first, gate second", and both times the pattern held.
