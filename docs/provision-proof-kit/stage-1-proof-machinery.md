# Stage 1 — the proof machinery: evidence + surfacing, no gating

**Implements:** phases 1+2 of [docs/provision-proof-plan.md](../provision-proof-plan.md)
(landed `302df5b5`). Read the plan and
[the decision record](../provision-proof-decision-record.md) FIRST — they are the spec; do not
re-design. If something in them cannot work as written, that is a finding to report, not a
license to improvise.

**Hard scope boundary:** EVIDENCE + SURFACING only. Nothing in this stage may refuse a claim,
a dispatch or a spawn — that is stage 2 (plan phase 3), a different landing.

## Build

1. **Migration** — ask `zee migration-number --name "provision proof evidence"` first (never
   pick a number by hand; six numbers have been claimed twice). Additive only, per plan §4.2:
   - `xell.proof_at timestamptz`, `xell.proof_error text`, `xell.proof_checks jsonb`,
     `xell.proof_commit text`;
   - `pool_config.readiness_proof text NOT NULL DEFAULT 'advisory'` with a CHECK constraint
     (`'off' | 'advisory' | 'required'`);
   - `build_readiness_record` table exactly as §4.2 (UNIQUE on `(machine_id, project_id)` —
     latest verdict per pair; history is the event log).
   - **No new `xell.status` enum values** (DR-2 — the claim/sweep CAS pivots on `'ready'`).
   - NULL semantics are part of the contract: `proof_at IS NULL` = never proven (legacy),
     gates nothing; `proof_at NOT NULL AND proof_error IS NULL` = proven.

2. **`server/src/lib/xell-proof.js`** — `proveXell(xellId, opts)` per plan §4.1:
   - `db-open`: DELEGATE to the existing `preflightXell` — do not copy its probe.
     `lib/preflight.js` has a never-writes contract and this module builds; that is WHY they
     are separate modules. Its skip semantics (prod never opened, db-less couplings
     skipped-with-reason) ride through unchanged.
   - `app-build:<role>` for each buildable role (manifest `roles.*.buildable`, defaulting as
     `build.js BUILDABLE` does): invoke the SAME build path `zee build` uses (`lib/build.js`
     with the meta-DB's recorded compose/env/port facts) — never a parallel docker invocation.
     A `runner: process` role has no container build: SKIP with the reason.
   - `app-serve:<role>`: container up AND published port answers (`probePublishedRole` — the
     same fact `serving_head` requires, build.js:586).
   - Classify each failure with the existing `classifyBuildFailure` (migration 233):
     `INFRA | CODE` rides on the check; it decides routing later, never the verdict.
   - Never throws. Evidence stays authoritative on container rows (`last_build_commit`,
     `health`, `last_build_error`, `last_build_error_class`); the xell row gets the stamped
     summary — the same evidence-derived/verdict-stamped pattern `notePreflight` uses,
     including "broadcast only when the error state changes".
   - `BUILD_MODE`/`PROVISION_MODE` = `simulate`: prove nothing, stamp nothing. A nested
     queenzee must never build real containers or record fake green.

3. **Pool-clock queue** in `server/src/queenzee/pool.js` per plan §4.4:
   - Enqueue a proof after each real provision (fire-and-forget like `warmWorktree` — a
     provision that fails because a proof was slow is a worse bug than the one this fixes).
   - Concurrency cap: ONE proof in flight per machine (single-flight discipline like the
     revive loop — never two proofs on one xell).
   - Backfill: prove existing `ready` xells with `proof_at IS NULL`, oldest first, same cap.
   - Persist the machine×project verdict into `build_readiness_record` after each proof, and
     on a slow (~hourly) cycle via the existing `probeBuildReadiness`.
   - Skip proving on a machine whose recorded verdict is `missing` — one recorded fact serves
     all; N xells do not each need to discover it.
   - Staleness: a pool fast-forward does NOT invalidate a proof (§4.4 — the expensive facts
     are commit-independent; `proof_commit` records the advisory code half). Do not build a
     re-prove-per-land loop.

4. **Surfacing** per plan §4.8 — ordering and words only, no refusals:
   - `readyXells` (intake.js) orders proven xells first. ORDER BY only; the WHERE is
     untouched.
   - `hive-status.js` vac-dirty predicate extends to `proof_error` (line ~148, one line).
   - `self.js` / `zee status`: `proofFailed` + the named checks, beside `preflightFailed`
     (fleet.js gets the same flag for the card).
   - Console: the xell card names the failing check VERBATIM (the preflight rule: the check,
     named, or a human goes looking); the machine matrix reads `build_readiness_record`
     instead of requiring a fresh probe click.

## Verify

Standalone `test/*.test.mjs` scripts (header comment says what each covers) — watch each fail
first:
- proof verdict shapes with an injected build/docker stub (copy the stub pattern from
  `test/build-readiness.test.mjs`);
- simulate-mode is a full no-op (no stamp, no container);
- NULL semantics: legacy rows gate nothing, order last among proven;
- proven-first ordering of `readyXells`;
- the backfill pass and the per-machine cap;
- `build_readiness_record` upsert keeps latest-per-pair.

Run the migration against `zee db-sandbox --migrate` (the assigned db is SHARED dev — no DDL
there). Exercise `proveXell` end-to-end against your own xell's containers via `zee build` if
infra permits; if the standing infra conditions block live verification, verify with sandbox +
stubs and REPORT exactly what you could not exercise live — never claim a live verification you
did not do.

## Land

Commit as you go. Land when green. Your landing message names: the migration number, the new
module, the knob default (`advisory`), and the explicit statement that nothing gates yet.
