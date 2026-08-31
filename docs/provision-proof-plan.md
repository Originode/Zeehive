# PROVISION PROOF — a xell is ready only when its chips are proven

**Status:** DESIGN — proposed, nothing built. Companion decision record:
[provision-proof-decision-record.md](provision-proof-decision-record.md).
**Author:** Architect (xell `figure-out-how-to-make-sure-the-xells-provis-aa002c`)
**Date:** 2026-08-31
**Directive (verbatim):** *figure out how to make sure the xells provisioned are buildable (all
chips web and server), and db chips are reachable. so even before a zee is deployed, that part is
already solved… NONE of the zees can still reach their chips and dbs… it should be for any
existing project, and any future new project or future onboarded project… regardless of existing
build scripts and manifests… plan it properly, not some band aid approach. also there should be a
zee harness with the role of troubleshooting this for any project so it should have access to
zeehive settings and meta-db for that project. that way the same zee can properly on-board and
initiate a project.*
**Builds on:** the readiness preflight (#53, `lib/preflight.js`), machine×project build-readiness
(#173, `lib/build-readiness.js`), the one-click bootstrap (`lib/build-bootstrap.js`), the build
path and its failure classifier (`lib/build.js`, migration 233), the spawn template
(`docs/spawn-prep.md`), and the claim CAS (`lib/xell-claim.js`, TKT-88-D6B4).

---

## 1. The problem, with the incident record behind it

A pooled xell is stamped `status='ready'` the moment its row is inserted
(`provision.js provisionXell`, ~line 1032). Everything that would tell anyone whether the xell
actually WORKS happens later, weaker, or never:

- **The DB preflight exists but gates nothing.** `runPreflight` opens the projected
  `DATABASE_URL` and stamps `preflight_error` on the row — but `readyXells` (intake.js:97) and
  `claimReadyXell` (xell-claim.js:52) select on `status='ready' AND quarantined_at IS NULL` only.
  A xell whose DSN is *known refused* is handed to the next zee anyway. Ticket #47: seven workers
  in one crew, one night, each independently rediscovering "password authentication failed for
  user zeehive". TKT-181 (2026-08-26): confirmed *again* — the stamped verdict changed nothing.
- **Nothing ever builds the app tier before a zee does.** `provision-xell.sh` runs `spin-env.sh`
  only when the project has one (line 72); compose-authored projects bring their stack up on the
  first `zee build` — on the **zee's clock**, after dispatch. The two live incident classes prove
  the gap:
  - TKT-178: "all predefined address pools have been fully subnetted" — the image builds, the
    container never starts. 20 omnibiz containers on `default` failed forever, discovered
    one zee at a time.
  - TKT-85 family: the clone-db bind collides on an already-allocated host port (5500 on
    ugreen-nas). Allocated from the meta-DB slot formula, never checked against the daemon.
  Both pass **every** static check we have: `compose config -q` resolves, networks exist, the
  shared dev db is up. Only a real `build` + `up` + probe surfaces them.
- **The binding can change after the only preflight ran.** Dispatch attaches a clone db or
  switches coupling (`attachXellDb`, intake.js:586; `cloneInstanceFor`, :747) — the new DSN is
  never opened before the zee spawns. The provision-time preflight proved a binding the zee no
  longer has.
- **Build-readiness is machine-scoped, on-demand, console-only.** `buildReadinessForProject`
  answers a human at the pool knobs. Dispatch never consults it; the pool fills machines it
  would call `missing`.

The current conditions block (2026-08-26) states the outcome plainly: *"LIVE CONTAINER
VERIFICATION IS BROKEN FOR THIS PROJECT'S SPINOFFS, two ways, and neither is your code."* Every
one of those zees was told to verify in-cage instead — which is the workaround this design
retires as the normal case.

**The principle:** *"provisioned" must mean "proven".* The proof is the same act the zee would
perform — the real build, the real `up`, the real port probe, the real `SELECT 1` — performed on
the **pool's clock**, before the xell can be claimed. The same move `spawn-prep` already made for
`npm ci` ("who pays: `when`"), applied to the whole app tier.

## 2. What already exists — the readiness ladder today

| layer | module | scope | when | writes? | gates? |
|---|---|---|---|---|---|
| build-readiness probe | `lib/build-readiness.js` | machine × project | console demand | never | never |
| bootstrap | `lib/build-bootstrap.js` | machine × project | human click | creates declared dev infra | n/a |
| DB preflight | `lib/preflight.js` | xell | end of real provision | stamps verdict | **never** |
| build status | `lib/build.js getBuildStatus` | container | after `zee build` | records commit/health | n/a |
| failure classifier | `lib/build.js classifyBuildFailure` | build failure | at failure | `last_build_error_class` | n/a |

Every piece of evidence-machinery this design needs already exists. What is missing is a rung —
**the xell-level burn-in** — and a **wire from verdict to gate**. This plan adds exactly those
two things and the harness that troubleshoots them. It replaces nothing.

## 3. Boundary — three layers, three owners

1. **Machine × project** — *"can a build work HERE at all?"* Owner: `build-readiness.js`
   (exists). Commit-independent, xell-independent. Extended only by recording its verdicts
   (§4.4) so gates and the medic can consult them without a live docker round-trip.
2. **Xell** — *"does THIS xell's app tier build, start, serve, and does its db answer?"* Owner:
   NEW `lib/xell-proof.js`. This is the burn-in: it BUILDS (so it is deliberately **not** part
   of `preflight.js`, whose contract is "never writes to what it checks" — a burn-in creates
   images and containers, which would poison that contract; the DSN probe stays pure and is
   *delegated to*, not duplicated).
3. **Dispatch** — *"may this xell be handed to a zee?"* Owner: the claim predicate
   (`xell-claim.js` / intake's `readyXells`) plus a re-preflight on any binding change. The gate
   consumes verdicts; it never computes them.

If two of these ever have to change together for one fault class, the boundary is wrong; today's
incidents each land in exactly one: TKT-178 is layer 2 (surfaced) + layer 1 (recorded as the
machine fact it is), #47/TKT-181 is layer 3, TKT-85 is layer 2 plus the allocation fix (§4.5).

## 4. Interfaces

### 4.1 `proveXell(xellId, opts)` — the burn-in (new `server/src/lib/xell-proof.js`)

```js
// { ok, error, checks: [{check, ok, skipped, detail, class}], commit, at }
proveXell(xellId, { roles = null, timeoutMs = PROOF_TIMEOUT_MS } = {})
```

Ordered checks, each bounded, the whole verdict never thrown:

1. `db-open` — delegate to `preflightXell` (the existing pure probe, existing skip semantics:
   prod bindings are never opened, db-less couplings are skipped-with-reason).
2. `app-build:<role>` — for each buildable role of the project (from the manifest's
   `roles.*.buildable`, defaulting to server+webapp exactly as `build.js BUILDABLE` does):
   invoke the **same** build path a `zee build` takes (`build.js` → `build-container.sh`, with
   the meta-DB's recorded compose/env/port facts). This is the "regardless of existing build
   scripts and manifests" property, for free: whatever a project's build is — generated compose,
   own compose, `runner: process` — the proof exercises the one path the zee will use, so proof
   and reality cannot drift. A `runner: process` role has no container build; its check is
   SKIPPED with the reason (its worktree warm + db-open carry the value there).
3. `app-serve:<role>` — the container is up AND the published port answers
   (`probePublishedRole`, the same fact `serving_head` already requires, build.js:586).
4. Failure classification rides along per check via `classifyBuildFailure` (migration 233):
   `INFRA` | `CODE`. The class decides routing (§4.6), never the verdict.

The proof is **evidence-derived, verdict-stamped** — same pattern as preflight: the authoritative
facts stay where they already live (`container.last_build_commit`, `health`,
`last_build_error`, `last_build_error_class`); the xell row carries the stamped summary.

### 4.2 Data shape (migration; all additive)

```sql
ALTER TABLE xell ADD COLUMN IF NOT EXISTS proof_at     timestamptz;  -- when the burn-in last ran
ALTER TABLE xell ADD COLUMN IF NOT EXISTS proof_error  text;         -- NULL = proven / not yet run
ALTER TABLE xell ADD COLUMN IF NOT EXISTS proof_checks jsonb;        -- the named checks, verbatim
ALTER TABLE xell ADD COLUMN IF NOT EXISTS proof_commit text;         -- source tip the build proved

ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS readiness_proof text NOT NULL DEFAULT 'advisory';
-- 'off' | 'advisory' | 'required'  (CHECK constraint; see §6 for the rollout of the default)

CREATE TABLE build_readiness_record (      -- §4.4: the machine×project verdict, remembered
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id  uuid NOT NULL REFERENCES machine ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  status      text NOT NULL,               -- 'ok' | 'unknown' | 'missing' (probe vocabulary, unchanged)
  error       text,
  checks      jsonb NOT NULL DEFAULT '[]'::jsonb,
  probed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (machine_id, project_id)          -- latest verdict per pair; history is the event log
);
```

`proof_error` semantics mirror `preflight_error`: NULL means "no known fault" — a xell proven
green and a xell never proven are told apart by `proof_at`. What may be null, and what that null
MEANS, is part of the contract: `proof_at IS NULL` = never burned in (legacy/backfill state);
`proof_at NOT NULL AND proof_error IS NULL` = proven.

**Deliberately NOT a new `xell.status` value.** `status='ready'` is the load-bearing token of
the claim/sweep CAS (TKT-88-D6B4): every conditional UPDATE, the pool's fill counting, the
sweep's take/untake and the console all pivot on it. A new enum state would touch every one of
those sites to fix one predicate. Columns + predicate are additive and reversible.

### 4.3 The gate — claim-time, one statement, policy-scoped

`claimReadyXell` / the sweep CAS stay CAS-shaped; the gate is an additional conjunct computed in
the same statement (a join on `pool_config`), so no read-then-write window opens:

```sql
UPDATE xell x SET status='claimed', is_pooled=false
  FROM pool_config pc
 WHERE x.id=$1 AND x.status='ready' AND NOT x.is_production AND x.quarantined_at IS NULL
   AND pc.project_id = x.project_id
   AND (pc.readiness_proof <> 'required'
        OR (x.proof_at IS NOT NULL AND x.proof_error IS NULL AND x.preflight_error IS NULL))
 RETURNING x.*;
```

- `off` — today's behaviour, byte for byte.
- `advisory` — claims proceed; the verdict is SURFACED (hexagon `vac-dirty` already exists for
  `preflight_error`; extend the same predicate to `proof_error`; the dispatch log and the zee's
  briefing name the failed check). `readyXells` **orders** proven xells first, so an advisory
  fleet already prefers proven stock without ever refusing a dispatch.
- `required` — an unproven or proof-failed xell is not stock. A dispatch that finds no claimable
  xell falls through to today's fresh-spawn path (§4.7) — it must never fall through to
  *claiming a known-broken xell*, which is the current behaviour.

The pool's own accounting changes symmetrically under `required`: a proof-failed xell does not
count toward `pool_size` (it is not stock), so the fill provisions a replacement, and the failed
one is decommissioned through the existing `sweepDecommission` path with the proof error as the
reason — after the failure has been ROUTED (§4.6), so the evidence is recorded before the
container disappears. Cap: never more than N proof-failed teardowns per (machine, project) per
hour — a persistent INFRA fault must flip the machine's recorded readiness and STOP the fill
(§4.6), not churn provision→fail→reap forever.

### 4.4 Where the proof runs — the pool's clock

In `provisionXell` (real mode, app tier on), after the existing `runPreflight` call: enqueue the
burn-in. Fire-and-forget like `warmWorktree`/`prewarmCage` — a provision that failed because a
burn-in was slow would be a worse bug than the one this fixes — but with a **concurrency cap**
(one proof per machine at a time; builds are minutes and daemon-heavy) and a queue owned by the
pool maintainer's tick, which already owns "work on the pool's clock" (image bake precedent,
pool.js ~100).

The pool tick also:
- **backfills**: proves existing `ready` xells with `proof_at IS NULL`, oldest first, same cap —
  this is how a running fleet converges without a flag day;
- **re-records machine×project readiness** (`build_readiness_record`) after each proof, and on a
  slow cycle (e.g. hourly) via the existing `probeBuildReadiness` — so the recorded verdict is
  never staler than the last time anyone actually tried;
- **skips proving where the recorded machine verdict is `missing`** — a machine that cannot
  build does not need N xells to each discover it; one recorded fact serves all.

**Proof staleness under fast-forward.** The pool reconciles ready xells to the source tip every
tick. A proof is NOT invalidated by a fast-forward: the expensive facts it established —
networks allocatable, ports bindable, images buildable, db answering — are commit-independent
(that is `build_readiness_record`'s half) or still standing (the containers keep running). The
commit-specific byproduct ("main at C builds") is recorded in `proof_commit` and is advisory: a
later `zee build` on the zee's branch re-proves the code half anyway. So `required` mode does
not force a rebuild per land on main — the one-way cost that would make this design too
expensive to keep on.

### 4.5 Binding changes re-prove — dispatch-time preflight

Any path that changes a xell's db binding after provision re-runs the pure preflight on the NEW
DSN before the zee spawns, bounded by the existing `PREFLIGHT_TIMEOUT_MS`:

- `attachXellDb` (dispatch `--db` / console attach) — after the attach and env re-emit;
- `cloneInstanceFor` (db-clone cut at dispatch) — after the clone db is up and the DSN emitted;
- the migration-detected clone-db switch (the auto-attach this xell's own briefing describes).

On failure under `required`: the dispatch is REFUSED with the named check (the same shape as
every other refusal — `ok:false`, the check, the DSN identity without the secret), the xell goes
to routing (§4.6), and the dispatch retries the next candidate. Under `advisory`: spawn
proceeds, the verdict lands in the zee's briefing/conditions and on the row. This closes the
#47/TKT-181 class at the moment it actually occurs, not at provision time when the binding was
different.

**The allocation fix that goes with it (required closure, small, separate commit):** clone/spin
db host-port allocation currently trusts the meta-DB slot formula. It must allocate against the
union of (meta-DB recorded ports) ∪ (ports actually bound on the daemon, one bounded `docker ps
--format` read), and on a bind refusal retry the next free slot rather than fail the attach.
The re-preflight above is the safety net; this is the fix. (TKT-85 family.)

### 4.6 Failure routing — a verdict must land where its owner looks

A failed proof is routed by CLASS, once, at stamp time:

- **INFRA** (address pools, daemon down/unreachable, context missing, port bind refused) — the
  fault is the (machine, project) pair's, not the xell's: write `build_readiness_record` status
  `missing` with the check verbatim; the pool STOPS filling that pair (the record is consulted
  at fill, §4.4) and says so once (state-change logging, the pool's existing discipline); the
  console machine matrix badge flips (the record makes today's on-demand probe result
  persistent, so the badge no longer requires a human to have recently clicked); a
  `tend`-equivalent card is raised at PROJECT level naming the machine, the check, and the one
  bootstrap/medic action that fixes it. This is the auto-dispatch seam for the medic harness
  (§7): the card carries a "dispatch infra-medic" button; nothing auto-spawns (a fault loop that
  auto-spawns agents is a new failure class — a human clicks, phase 4 may revisit).
- **CODE** on a pristine pooled xell at the source tip — *main itself does not build on this
  machine*: a project-level fact ("main broken since <sha>"), raised as a current-conditions
  line candidate and a console card. It does NOT mark the machine and does NOT stop the fill
  (the next land on main may fix it; xells remain claimable under `advisory`, and under
  `required` the gate holds until a green proof — which is correct: dispatching zees onto a
  main that cannot build is the thing managers currently discover by burning a crew).

### 4.7 What a fresh (non-pooled) dispatch gets

A dispatch that provisions fresh (pool empty, or explicit) cannot wait minutes for a burn-in —
that cost lands on a human. Contract: the pure preflight runs synchronously (bounded 5s, as at
provision) and is honoured per policy; the burn-in starts concurrently with cage prep and its
verdict lands in the zee's briefing the way conditions do, and on `zee status`. The zee's first
`zee build --wait` then IS the completion of the proof — same path, so the work is shared, not
doubled. The pool is the mechanism that makes the proven path the common path; the fresh spawn
is the documented, surfaced exception.

### 4.8 Surfacing — every reader that exists today, no new ones

- `zee status` / `self.js`: `proofFailed`, the named checks — beside the existing
  `preflightFailed`.
- Briefing/conditions: a proof-failed binding is stated to the zee up front (the current
  conditions block that today carries hand-written impediment lines gets the machine-generated
  one).
- Hive/hexagon: `vac-dirty` predicate extends to `proof_error` (hive-status.js:148 — one line).
- Console: xell card names the failing check verbatim (same rule as preflight: the check, NAMED,
  or a human goes looking); machine matrix reads `build_readiness_record`.
- `zee build --wait`: already tells INFRA from CODE (233); unchanged.

## 5. Why this holds for any project, present or future

The proof's only project-specific inputs are the ones the meta-DB already owns for every
project: the manifest (or its defaults — `manifest.js` supplies the whole shape when a repo
declares nothing), the recorded compose/env/port facts on the container rows, and the build
script contract (`build-container.sh`) that every role already goes through. A project onboarded
tomorrow with no `zeehive.yml`, its own compose, or `runner: process` is proven by the same
calls its zees will make. There is no per-project proof code to write — which is the test of
"not a band-aid": when a new project fails its proof, the fix is in that project's manifest or
that machine's infra, never in this design.

Onboarding gains a definition of done (§7.3): a project is INITIATED when (a) its manifest
parses, (b) at least one machine's `build_readiness_record` is `ok`, (c) one pooled xell's proof
is green. The console can render that as a three-light project readiness strip — derived from
the records above, stored nowhere (derivable state is not duplicated).

## 6. Migration — running fleet, old data, half-deployed states

Each phase is safe to stop at; none is a one-way door.

- **Phase 1 — evidence (additive, silent).** Migration for the columns/table + `xell-proof.js` +
  the pool-clock queue + backfill of existing ready xells. Default `readiness_proof='advisory'`.
  Old rows: `proof_at IS NULL` means "legacy, not yet proven" and gates nothing. Half-deployed
  (new schema, old server): unused columns; old schema, new server: the migration ships with the
  server (boot_migrations), so that state does not occur here.
- **Phase 2 — surfacing + advisory ordering.** `readyXells` proven-first ordering; hexagon,
  status, briefing, matrix. Still refuses nothing.
- **Phase 3 — the gates.** The `required` conjunct in the claim CAS; dispatch-time re-preflight
  on binding change; the port-allocation fix; failure routing incl. the fill stop. Flip
  `readiness_proof='required'` per project, zeehive first, after its pool has run green for some
  days under advisory. The default for NEW projects becomes `required` once two projects have
  lived on it. Way back: set the knob to `advisory` — the columns keep recording, nothing else
  moves.
- **Phase 4 — the medic harness (§7).** Independent of 1–3 in code, dependent in value: the
  verbs read the records the earlier phases write.

Rollback boundary worth stating: once managers/humans start trusting "ready means proven"
(phase 3, socially), turning it off is cheap in code and expensive in expectation — that is the
only near-one-way door here, and it is a door we want to walk through.

## 7. The INFRA-MEDIC harness — troubleshoot any project, onboard the next one

A system-wide **worker** harness, key `infra-medic`, meta-DB-owned like every harness (row is
the harness; authored by migration via `createHarness` + `harness_memory_put`, house rule 9).
Its memory is the runbook of THIS design: the readiness ladder, how to read a proof verdict,
the bootstrap contract, the onboarding checklist (§5), and the refusals below.

### 7.1 Access — read wide, write through gates

*"Access to zeehive settings and meta-db for that project"* decomposes into two different
grants, and only one of them is a DSN:

- **READ: a minted meta-DB read-only role.** The exact machinery managers already have
  (`lib/prod-readonly.js`: per-xell `zee_ro_<slug>`, LOGIN+CONNECT+SELECT,
  `default_transaction_read_only=on`, secret columns revoked), pointed at the orchestrator's own
  meta-DB, injected as `ZEEHIVE_META_RO_DSN`, firewall-opened at seal time, dropped by the
  reaper with the xell. The medic can read the whole estate — machines, pool knobs, container
  rows, proof/readiness records, event log — which is what troubleshooting IS. Postgres enforces
  read-only; a prompt does not.
- **WRITE: none, ever, by DSN.** `docs/self-project-prod-data.md` already records why: any role
  that can `UPDATE xell` or `DELETE FROM container` is a nested reaper. Every mutation is a
  queenzee-mediated verb, and every mutation that touches real infra or settings is
  **human-gated** — the same land/ship card pattern:

```
zee infra readiness [--machine <key>]   # run/read machine×project readiness  (NOT gated, read-only)
zee infra proof [--xell <slug>]         # burn-in a pooled xell of this project (NOT gated — throwaway
                                        #   containers, same class as `zee build`)
zee infra bootstrap --plan              # the dry-run plan performBuildBootstrap already computes (NOT gated)
zee infra bootstrap --perform           # HUMAN-GATED card → queenzee performs (the console 🔧, as a verb;
                                        #   same contract: creates only manifest-declared DEV infra,
                                        #   never invents, never removes, dev-only guard intact)
zee infra settings                      # non-secret projection of this project's settings (NOT gated)
zee infra propose --change '<patch>' --reason "…"
                                        # HUMAN-GATED settings card (pool knobs, registry, machine
                                        #   priority, manifest-cache refresh) → queenzee applies on approval
```

Routes: `/api/xell/self/infra/*`, token-scoped like every self verb, project-resolved from the
calling xell — the medic acts on ITS project and nothing else (the same wall as `zee item`).

### 7.2 Authorization — a capability column, not a bundle field

The harness bundle structurally cannot carry rules (authoring accepts personality/skills/memory
and nothing else — that non-override is load-bearing). So the grant is a first-class column:

```sql
ALTER TABLE harness ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;
-- allowlist-validated by trigger; one value defined today: 'infra-troubleshoot'
```

The `/infra/*` routes check the effective harness chain for the capability; the meta-RO bind at
dispatch is triggered by the same flag (mirroring `bindManagerToProdReadonly`). Assigning a
capability-bearing harness is already a human/console act, so wearing the medic IS the grant —
no second approval step is invented. A harness edit cannot self-grant (the column is not in the
bundle, set only by migration/console).

### 7.3 What the medic does with it

- **Troubleshoot:** read the failed check verbatim from the records → reproduce with
  `zee infra proof` → fix by the narrowest lever: a manifest/compose change (landed through the
  ordinary land gate — the medic is a worker in a worktree, so project-file fixes are just
  commits), a `bootstrap --perform` ask, or a `propose` for a settings change. Its manual's
  standing refusals: never asks for a write DSN, never routes around a gate, reports what it
  could not fix with the named check.
- **Onboard / initiate:** drive the §5 definition of done for a new or newly-onboarded project:
  validate the manifest parse, probe every machine, raise the bootstrap asks, prove the first
  pooled xell, and hand back the three-light certificate. Project CREATION stays a human console
  act (it names repos and hosts the fleet does not know yet); the medic makes everything after
  that click converge without a human debugging docker by hand.

## 8. Checked against reality

- **Existing caller I did not design for:** `zee assign` / skill-claim (`claimReadyXellForSkill`)
  — same CAS, same conjunct; a human standing in a worktree claiming it under `required` with a
  failed proof gets the named refusal, which is correct and new information for them.
- **Largest plausible volume:** a machine with pool_size 5 across 4 projects = 20 burn-ins; the
  per-machine cap of 1 concurrent proof means convergence takes hours on the pool's clock —
  acceptable, that is the clock's purpose; the recorded machine verdict short-circuits the
  hopeless ones.
- **Two at once:** two proofs on one xell — the pool queue is the single writer per xell (same
  single-flight discipline as the revive loop); proof vs claim — the claim CAS is untouched by a
  running proof (the xell stays `ready`; a claim mid-proof under `advisory` simply inherits the
  running containers, which is today's behaviour).
- **Half-deployed:** `advisory` default + NULL-means-legacy makes every mixed state read
  correctly (§6).
- **Simulate mode:** `PROVISION_MODE/BUILD_MODE=simulate` proves nothing and stamps nothing —
  a nested queenzee must never build real containers or record fake green (the same guard every
  real-side-effect module already reads).

## 9. Least sure / would change this design

- Whether `advisory` ordering alone (phase 2) already removes most of the pain — if it does,
  `required` can stay per-project opt-in longer. Measure: dispatches that landed on a
  proof-failed xell per week.
- The per-machine proof concurrency cap of 1 is a guess; a beefy build host can take more. Knob
  it on `machine` if it binds.
- If proof failures turn out to be dominated by one project's flaky build rather than infra,
  add a flake-damping rule (two consecutive fails to route) — not designed now, named so it is
  not re-argued from scratch.
