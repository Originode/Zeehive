# IMPLEMENT — the self-orienting driver for the provision-proof kit

You are a builder zee dispatched to advance the implementation of
[docs/provision-proof-plan.md](../provision-proof-plan.md) (landed `302df5b5`). This kit is
staged: **you implement exactly ONE stage per dispatch** — the first stage that is not yet
complete on your branch. This file tells you how to find out which one that is. The same
one-line dispatch is used every time, so assume nothing about what a previous zee did:
**detect, verify, then build.**

## Step 0 — orient

Read, in order: this file · [README.md](README.md) · the plan · the
[decision record](../provision-proof-decision-record.md). Then read `zee scratchpad` — a
predecessor on THIS xell may have left you mid-stage notes. Then run the detection below.

## Step 1 — detect progress (run these, believe the output, not this doc)

Your branch was cut from current main, so main's state is your tree's state. From `/work/repo`:

```sh
# STAGE 1 complete?  (proof machinery: module + schema + knob)
test -f server/src/lib/xell-proof.js && \
  grep -rl "build_readiness_record" db/migrations/ >/dev/null && \
  grep -rl "readiness_proof" db/migrations/ >/dev/null && echo "stage 1: DONE"

# STAGE 2 complete?  (gates: CAS conjunct + binding-change re-preflight)
grep -l "readiness_proof" server/src/lib/xell-claim.js >/dev/null && \
  grep -l "runPreflight\|preflight" server/src/lib/xell-db.js server/src/lib/db-instances.js \
    server/src/queenzee/intake.js 2>/dev/null | grep -q . && echo "stage 2: DONE"

# STAGE 3 complete?  (medic: capability column + verb family)
grep -rl "capabilities" db/migrations/ | xargs grep -l "infra-troubleshoot" >/dev/null 2>&1 && \
  grep -q "infra" scripts/zee && echo "stage 3: DONE"
```

- **All three DONE** → the kit is fully implemented. Do not invent stage 4. Verify the whole
  (`node test/<the kit's tests>.mjs`, `zee build server --wait` in the background), report the
  state, and `zee done --summary` saying the kit is complete.
- **Otherwise** → your job is the FIRST stage that did not print DONE:
  - stage 1 → implement [stage-1-proof-machinery.md](stage-1-proof-machinery.md)
  - stage 2 → implement [stage-2-gates.md](stage-2-gates.md)
  - stage 3 → implement [stage-3-infra-medic.md](stage-3-infra-medic.md)

**Detection is a floor, not a verdict.** A stage can be PARTIALLY landed (a predecessor died
mid-way): if your stage's detection half-fires, read what exists (git log on the touched files,
the stage brief's Build list against the tree), run its tests, and CONTINUE from the first
incomplete item — never re-write what is already landed and green, and never "fix" a landed
predecessor's style. If something landed looks genuinely wrong against the plan, that is a
finding: report it (`zee report` / your landing message), implement your stage around it only
if the plan permits, otherwise `zee tend --reason` with the specific conflict.

## Step 2 — build

Follow your stage's brief **exactly as written**. The brief is the spec; the plan and decision
record are its law. The scope boundary is hard both ways:

- Do not reach FORWARD: stage 1 gates nothing; stage 2 flips no project to `required`; nobody
  builds any part of a later stage "while they're in there".
- Do not reach BACK: earlier stages are landed code — extend them only where your brief says so.

House rules that have bitten builders here, restated once: `zee migration-number` before
naming any migration · the assigned db is SHARED dev, all DDL on `zee db-sandbox --migrate` ·
harness bundles only via `harness_memory_put` · claim/sweep changes stay one-statement CAS ·
every new real side effect is a no-op under simulate modes · commit early and often.

## Step 3 — verify, land, hand over

- Tests are standalone `test/*.test.mjs` with a header comment; watch each fail first.
- `zee build server --wait` (in the background — never a hand-rolled poll) and exercise what
  your stage changed against your OWN containers. If the standing infra conditions block live
  verification, verify via sandbox + stubs and REPORT exactly what you could not exercise
  live — never claim a live verification you did not do.
- `zee land` when green. One stage = one landing (multiple commits are fine; stage 2's brief
  names its commit split).
- Before finishing, write `zee scratchpad --set` with: which stage you completed (or where in
  it you stopped), what is verified vs assumed, and which stage is next — the next dispatch
  reads it at step 0.
- Then `zee done --summary "stage N of the provision-proof kit landed (<sha>); next: stage
  N+1"` — or, if you stopped mid-stage on a real blocker, `zee tend --reason` with the
  specific ask instead.
