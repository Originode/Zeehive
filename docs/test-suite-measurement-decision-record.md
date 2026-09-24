# Decision Record: a test is measured by its EXIT CODE, never by a word in its output

**Date:** 2026-09-24
**Author:** xell `98-printed-lines-across-363-test-files-say-f-adcbdc`
**Status:** Decided and implemented (`scripts/run-tests.mjs`, `npm test`,
`test/run-tests.test.mjs`), pending land.
**Builds on:** the readiness worker's A/B of the provision-proof flake, which is where this was
first seen (a careless `grep -i fail` "reports 10/10 failures on healthy code").

## The rule

Measure a test by its **process exit code** (or, for a human, its **terminal summary line**).
**Never** by grepping its output for a word. The suite's stdout is not a verdict surface: it is
full of *descriptions of healthy scenarios*, so the word `fail` appears on a perfectly green run.

## The instance

`test/provision-proof.test.mjs` ends `process.exit(fail ? 1 : 0)` (line 42 counts, line 332 exits)
and prints this on **every** run, green or not:

```js
console.log('\n── 2. proveXell: address-pool exhaustion → app-build FAILS, classed INFRA ──');
```

Line 159 is a **section header**. `grep -i fail` over a fully green run of that file returns a hit,
and a grep-based measurement of the whole suite reads as a bloodbath.

## The sweep (this branch, 2026-09-24)

Method: every `console.log|error|warn|info` / `process.stdout|stderr.write` line in `test/*.mjs`
that **mentions** `fail` — a variable named `execFail` is not output, and the sweep counts printed
*lines*, so it over-counts slightly rather than under. 363 `.mjs` files, 361 of which print;
**838 printed lines carry `fail`/`failed`/`FAILS`**:

| shape | count | what it is |
|---|---|---|
| assertion marker — the literal `✗ FAIL` | 380 | the third instrument (below) |
| terminal / summary lines (`N FAILED`, `FAILURE(S)`, `all good`, …) | ~330 | the second instrument |
| **descriptions of healthy scenarios** | **90–130** | the trap: printed on a GREEN run |

The third row is the only one whose count moves with the classifier (a line can be both a header
and carry a summary phrase); the card counted 98, a strict reading gives 89, a loose one 126. The
order of magnitude is the point and it is not in dispute. Samples:

```
build-bootstrap.test.mjs:194   ── a failing probe (missing network + missing shared dev db) → an ordered plan ──
backup-network-dest.test.mjs:84 ── REGRESSION 3: a valid archive of the WRONG database must FAIL ──
backup-retry-alert.test.mjs:50  ── a failed attempt brings the next attempt FORWARD ──
```

## The instruments, in order of authority

1. **the process EXIT CODE** — the verdict. A section header cannot produce it.
2. **the terminal SUMMARY line** — `all good` vs `N FAILED`. Context for a human, never the verdict.
3. **the assertion MARKER** — the literal `✗ FAIL`. An alarm, never a verdict (see the converse).

A bare `/fail/i` over the output is never an instrument.

## The converse — a real failure hidden behind a passing word

The same proxy error in the other direction: a test whose output *says* success while it failed.

* **Sweep of exit-code correctness.** Of the 359 `test/*.test.mjs` files that keep their own failure
  counter, every one routes that counter to its exit code — `process.exit(fail ? 1 : 0)`,
  `process.exitCode = failures === 0 ? 0 : 1`, or `if (fail) { …; process.exit(1); }`. The two
  `node:test` files get theirs from the framework. **No file exits 0 on its own failure.**
* **What WAS found, and is fixed in this branch.** Three tests printed `console.log('\nall good')`
  **unconditionally**:
  * `test/infra-medic-dispatch.test.mjs` printed it as its **last line before `process.exit(1)`**,
    with no conditional terminal line anywhere in the file — a failing run ended `… ✗ FAIL …` then
    `all good`. Anyone reading the word saw green on a red run.
  * `test/fleet-conditions.test.mjs` and `test/provision-fault-carding.test.mjs` printed it
    mid-body, one screen before their own conditional summary — redundant and misleading.
    No assertion was changed: the first gains the suite's standard conditional terminal line, the
    other two drop the redundant print and keep theirs.
* **Not a defect:** `if (fail) { console.log(`${fail} FAILURE(S)`); process.exit(1); }
  console.log('\nALL PASS')` (seen in three tests) is *unreachable* on a failing run — the exit
  happens first. It is honest, and left alone.

## Decision

1. **`scripts/run-tests.mjs` + `npm test` is the suite gate.** Nothing swept `test/*.test.mjs`
   before this: `package.json` had no `test` script, `.github/workflows` runs no test path, and
   `hooks/` references none. The suite was run by hand and read by eye, which is *why* a bad grep
   survived. The runner spawns each test, measures the **exit code**, and exits nonzero if any test
   did not exit 0. Sequential on purpose: the integration tests share one `DATABASE_URL`, and
   concurrency is what manufactures the interference below.
2. **A disagreement is an advisory, not a verdict.** Exit 0 that PRINTED an assertion-failure marker
   (or whose terminal line reports failures) is reported as `⚠ advisory` and counted separately —
   it does **not** turn green into red. A proxy signal that overrides the state stops being the
   instrument that cannot be produced by the other case, and the false positive is real: a test that
   echoes a child's failing output (the runner's own test does) prints the marker on a healthy run.
   `--strict` is how an operator makes the advisory fatal.
3. **Never `grep -i fail` a test's output.** Use `npm test` (exit code) or read the terminal line.

## The provision-proof flake, characterized and fixed at its mechanism

The card left this as an open follow-up: section 5's per-machine cap assertion
(`pass 2 drains machine C's remaining xell [${pass2C.length} total]`, line 270) failed ~2 in 15
on the reporter's box. It was two **wall-clock guesses at preconditions**:

* pass 1 held the machine busy with `setTimeout(r, 10)` while its own loop does awaited DB
  roundtrips between ids — a short hold let the machine free up mid-loop and proved **two** xells on
  C in one pass (`… in pass 1 [2]`, observed once in 15 runs here);
* the test then waited `setTimeout(r, 30)` for pass 1's proofs to settle before pass 2 — if they had
  not, pass 2 skipped the still-busy machine and proved nothing (`… [1 total]`).

The hold is now a **gate the test opens**, and pass 2 waits on `Promise.all` of the in-flight proofs
plus a `setImmediate` for the pool's own `.finally(() => proofBusy.delete(key))`. **No assertion was
changed and no threshold widened** — the precondition moved into the test, which is what the dev-loop
memory asks for.

**Evidence** (all against `zee db-sandbox --migrate`, a real postgres in this cage):

| run | version | hold | result |
|---|---|---|---|
| 15 runs | old (HEAD) | 10ms | 0 failures — the flake needs a loaded box |
| 3 runs | old | **forced 400ms** | **3/3 failed** on `pass 2 drains machine C's remaining xell [1 total]` |
| 3 runs | new | **forced 400ms** | 3/3 green — isolates the sleep as the cause |
| 20 runs | new | 10ms | 0 failures |
| 24 × 4-way concurrent | old | 10ms | 20/24 failed |
| 24 × 4-way concurrent | new | 10ms | 12/24 failed |

**What the concurrent numbers are, and are not.** The residue is not this test's timing any more.
The backfill scan in `maybeRunProofs` is **global across the database**, so with several pool
processes on one database another process proves this test's xells: instrumentation showed both C
xells carrying `proof_at` while the test's own stub had been called for only one — the assertion is
about *this* pool's bookkeeping, and a second pool breaks the premise. `npm test` is sequential, so
a gate run does not do this; a hand run against a database a live queenzee is also ticking can.
That is an isolation property of the test, **characterized here and not fixed**.

## What was verified here, and what was not

* **Verified in this cage**, with no docker and no build: the runner and its test (`npm test`, real
  child processes), the three edited tests, and every DB-backed run above — against
  `zee db-sandbox --migrate`, a real postgres on loopback (`…@127.0.0.1:36209/postgres`, 248
  migrations applied).
* **The whole suite was not run end to end.** It wants the assigned shared dev database, which was
  unreachable from here the entire session — the preflight probe reports the host it lives on
  (`ugreen-nas`) as a `db-open … timeout expired (dsn source: shared-dev-container)`. Any count in
  this record that needs no database (the sweep, the exit-code audit) is complete; the flake
  numbers are sandbox numbers, and are labelled as such.
* **The flake's reproducer was characterized, not the reporter's box.** The reporter's 2-in-15 was a
  loaded machine; the forced-400ms hold reproduces the same failure deterministically here. That
  is the stronger instrument, but it is still a stand-in for their wall clock.

## Consequences

* A green suite is now a fact with an exit code behind it: `npm test`.
* The runner's summary distinguishes **failed** from **advisory**; `--json` carries both.
* A test that a human runs by hand can still be misread if they grep it. The rule above is the fix;
  the runner removes the reason to grep.
* This record deliberately does **not** retitle the suite's section headers. The output is a
  description of what the test does; the instrument was wrong, not the prose.

## Files

* `scripts/run-tests.mjs` — the runner (`--list`, `--json`, `--verbose`, `--strict`, `--timeout`,
  `--dir`).
* `test/run-tests.test.mjs` — pins the rule in both directions, against real child processes.
* `test/infra-medic-dispatch.test.mjs`, `test/fleet-conditions.test.mjs`,
  `test/provision-fault-carding.test.mjs` — the unconditional `all good` prints.
* `test/provision-proof.test.mjs` — the section-5 hold is a gate, not a sleep.
