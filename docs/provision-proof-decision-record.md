# Decision Record: provision proof — proven chips before a zee, and the infra-medic harness

**Date:** 2026-08-31
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

## DR-5 — The infra-medic is a worker harness: minted read-only meta-DB DSN, human-gated write verbs, a capability column

**Decision:** system-wide worker harness `infra-medic`; at dispatch it is bound to a per-xell
SELECT-only role on the orchestrator's meta-DB (`prod-readonly.js` machinery, secret columns
revoked, dropped with the xell) as `ZEEHIVE_META_RO_DSN`; all mutation goes through
`/api/xell/self/infra/*` verbs — reads and burn-ins ungated, `bootstrap --perform` and
`propose --change` human-gated cards the QUEENZEE performs; the routes are enabled by
`harness.capabilities` (new jsonb column, allowlist-triggered, value `infra-troubleshoot`),
never by anything in the bundle.

**Options considered:**
- *Chosen.* For: reuses the one precedent that already survived review (manager
  `db-prod-readonly` — postgres enforces read-only, not a prompt); the write path keeps the
  human between an agent and the fleet's estate, which is the product's whole design; the
  capability column respects the structural rule that a bundle can never express a grant.
- *A limited write role on the meta-DB.* **Rejected:** `docs/self-project-prod-data.md` already
  rejected it with the incident behind it — any role that can UPDATE xell/DELETE container is a
  nested reaper. This is the specific cost, not a preference.
- *A new zee TYPE (`infra`) beside worker/manager.* For: types already gate harness fit.
  **Rejected:** type is woven through dispatch, pickers, triggers and pool selection
  (`ZEE_TYPES`); a third value is a fleet-wide change to express one route guard. The medic IS a
  worker — it lands manifest/compose fixes through the ordinary land gate; that is most of its
  fixes.
- *Console-only troubleshooting (no harness — humans click bootstrap).* **Rejected:** that is
  today, and the estate is losing: the human is the bottleneck the directive names, and the
  diagnostic loop (read verdict → reproduce → narrow the lever → propose) is agent-shaped work.
- *Make it a manager (managers already get prod-RO).* **Rejected:** managers cannot land code
  and their manual teaches crew verbs; the medic's levers are commits, proofs and gated asks —
  worker verbs. Granting by capability rather than by type also lets a future harness (e.g. an
  onboarding concierge) carry the same grant without a taxonomy change.

**Consequences:** makes easy: one dispatch that can diagnose any project's provisioning end to
end, and drive onboarding to the three-light definition of done. Makes hard (deliberately):
any agent fixing infra WITHOUT a human reading the plan first. Makes impossible: the medic
mutating the meta-DB directly — postgres refuses. **Reversibility:** disable the harness
(existing switch) or empty its capability; the RO role dies with each xell.
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
