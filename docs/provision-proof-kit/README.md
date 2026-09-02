# Provision-proof implementation kit

Dispatch-ready briefs for implementing
[docs/provision-proof-plan.md](../provision-proof-plan.md) (landed `302df5b5`, with its
[decision record](../provision-proof-decision-record.md)). One brief = one zee-sized job = one
landing. Each is self-contained: point a builder at the file and nothing else needs pasting.

## How to dispatch

Dispatch each stage with a one-line task; the brief carries the rest:

| stage | dispatch prompt (verbatim) | dispatch after |
|---|---|---|
| 1 | `Implement docs/provision-proof-kit/stage-1-proof-machinery.md exactly as written.` | now |
| 2 | `Implement docs/provision-proof-kit/stage-2-gates.md exactly as written.` | stage 1 is on main |
| 3 | `Implement docs/provision-proof-kit/stage-3-infra-medic.md exactly as written.` | stage 2 is on main |
| 4 | `Implement docs/provision-proof-kit/stage-4-medic-meta-plane.md exactly as written.` | stage 3 is on main |

Stage 4 (added 2026-09-02) supersedes stage 3's PLACEMENT of the medic — a medic is not
deployed in a xell; see [docs/medic-meta-plane-plan.md](../medic-meta-plane-plan.md) and
DR-7/DR-8. Stage 3's capability column and handlers are its prerequisites, not its rival.

The stages are strictly ordered — each builds on rows, modules and knobs the previous one
landed. Do not dispatch two stages concurrently: stage 2 edits the claim CAS that stage 1's
tests exercise, and stage 3's routes read stage 1's records.

Kit stages ↔ plan phases: stage 1 = plan phases 1+2 (evidence + surfacing, deliberately one
landing — surfacing is what proves the evidence is readable). Stage 2 = plan phase 3 (gates).
Stage 3 = plan phase 4 (the infra-medic harness).

## After the stages land

Flipping a project to `readiness_proof='required'` is a **human's per-project decision** in the
console (DR-3) — zeehive first, after its pool has run green under `advisory` for some days. No
stage in this kit flips it, deliberately.

## Ground rules common to every stage

Restated in each brief where they bite; listed once here for the human reading along:

- The plan and decision record are the spec. A builder who disagrees with them reports the
  finding (`zee report` / the landing message) — it does not re-design mid-implementation.
- Migration numbers come from `zee migration-number`, never chosen by hand.
- The assigned db is the SHARED dev db — no DDL there, ever. Migrations are verified against
  `zee db-sandbox --migrate`.
- Tests are standalone `test/*.test.mjs` scripts with a header comment saying what they cover,
  and each is watched failing before the fix makes it pass.
- `simulate` modes (`BUILD_MODE`/`PROVISION_MODE`/`SHIP_MODE`/`PRODRO_MODE`) must make every
  new real side effect a no-op — a nested queenzee runs this code against a clone of the real
  fleet's rows.
- Commit early and often; land when green; report exactly what was and was not exercised live.
