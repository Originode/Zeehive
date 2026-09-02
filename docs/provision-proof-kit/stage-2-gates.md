# Stage 2 — the gates: claim conjunct, re-preflight, port fix, failure routing

**Implements:** phase 3 of [docs/provision-proof-plan.md](../provision-proof-plan.md) (landed
`302df5b5`). **Prerequisite:** stage 1 is on main (`lib/xell-proof.js`, the `proof_*` columns,
`pool_config.readiness_proof`, `build_readiness_record`). Read plan §§4.3, 4.5, 4.6 and
DR-3/DR-4 first.

**Hard rule:** do NOT flip any project to `'required'`. That is a human's per-project decision
in the console (DR-3). Your job is that the knob WORKS, proven by tests.

## Build

1. **The `required` conjunct in the claim CAS** — `lib/xell-claim.js` (`claimReadyXell` and the
   sweep's take) and intake's `claimReadyXellForSkill`, as ONE statement joining `pool_config`;
   plan §4.3 has the exact SQL shape. No read-then-write window opens — TKT-88-D6B4 (five
   dispatched tasks destroyed in three minutes) is the incident behind the one-statement rule.
   - `'off'`: byte-for-byte today's behaviour.
   - `'advisory'`: refuses nothing (ordering already landed in stage 1).
   - `'required'`: unproven / proof-failed / preflight-failed xells are not stock; a dispatch
     that finds no claimable xell falls through to the EXISTING fresh-spawn path (§4.7) — it
     must never fall through to claiming a known-broken xell.

2. **Re-preflight on every binding change** per §4.5 — after `attachXellDb` (intake.js:586),
   after `cloneInstanceFor` (intake.js:747), after the migration-detected clone-switch path.
   Bounded by the existing `PREFLIGHT_TIMEOUT_MS`. Under `'required'` a failure REFUSES the
   dispatch with the named check (the existing refusal shape: `ok:false`, the check, DSN
   identity WITHOUT the secret) and the dispatch retries the next candidate; under
   `'advisory'` the spawn proceeds and the verdict lands on the row and in the zee's briefing
   (the conditions block).

3. **Port-allocation fix** (SEPARATE commit — it is a fix with its own revert story):
   clone/spin db host-port allocation checks meta-DB recorded ports ∪ daemon-bound ports (one
   bounded `docker ps --format` read through the async adapter pattern — never spawnSync on
   the event loop) and on bind refusal retries the next free slot instead of failing the
   attach. TKT-85 family. The stage-2 re-preflight is the safety net; this is the fix.

4. **Failure routing** per §4.6, at stamp time, once per failure:
   - INFRA class → `build_readiness_record` status `missing` with the check verbatim; the pool
     fill CONSULTS the record and stops filling that (machine, project); say it on state
     CHANGE only (the pool's existing logging discipline, see `lastMachineGuardSaid`); a
     project-level console card names machine + check + the one bootstrap/medic action. The
     card carries the dispatch-medic seam (a button target — stage 3 fills it); nothing
     auto-spawns.
   - CODE class on a pristine pooled xell at the source tip → the project-level "main does not
     build since <sha>" fact (console card + current-conditions candidate). Does NOT mark the
     machine, does NOT stop the fill.
   - Proof-failed xells stop counting toward `pool_size`, are decommissioned via the existing
     `sweepDecommission` AFTER routing has recorded the evidence, capped per (machine,
     project) per hour — a persistent INFRA fault flips the record and stops the fill; it must
     never become a provision→fail→reap churn loop.

## Verify

Standalone tests, watched failing first:
- the claim CAS matrix: {off, advisory, required} × {no proof, proven, proof-failed,
  preflight-failed} — drive the REAL SQL against `zee db-sandbox --migrate`, not a mock;
- concurrency: claim vs sweep still exactly-one-winner with the new conjunct (extend the
  pattern in `test/dispatch-claim-vs-pool-sweep.test.mjs`);
- re-preflight refusal shape, and that `'advisory'` never refuses;
- port allocator: collision → next slot; daemon read bounded and failure-tolerant (an
  unreachable daemon degrades to meta-DB-only allocation, logged, never a hang);
- the churn cap and the fill-stop on a recorded `missing`.

The assigned db is SHARED dev — all DDL and CAS-driving happens on the sandbox. Report what
was and was not exercised live.

## Land

Separate commits: CAS conjunct · re-preflight · port fix · routing. Land when green. The
landing message states explicitly that no project was flipped to `required`.
