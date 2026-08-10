# Decision Record: Per-machine pooling for `runner: process` projects

**Date:** 2026-08-10
**Author:** Architect (machine-aware-pooling-is-disabled-local-mard-eccb04)
**Status:** Decided (design) — not yet implemented; supersedes nothing. The pool guard and
banner described in §3.1 of `deploy-topology-spec.md` remain the CURRENT behaviour until a
builder lands the changes in "Interfaces" below.

## Decision

For a `runner: process` project, per-machine pool configuration is HONORED on the one machine
its xells factually live on — the queenzee-host machine row — with the ready count taken
project-wide (no `docker_ctx` join, so the zero-by-construction runaway cannot recur).
Per-machine config on any OTHER machine stays a dead letter, and the "Machine-aware pooling
is DISABLED" warning narrows to name only those remote rows. `container.docker_ctx IS NULL`
is given its honest reading everywhere it is counted: **"not a container — runs where the
queenzee runs"**, not "nowhere".

## Context — why the warning exists, and why it feels like "so many steps"

The operator report: *"⚠ Machine-aware pooling is DISABLED: local, mardale-prod, ugreen-nas …
I just want to be able to configure the pool per machine in peace. Why can't this work
harmoniously with zeehive.yml? Why so many steps?"* (second ticket against this banner — the
first is recorded in `test/machine-pooling-warning.test.mjs`'s header).

What per-machine pooling MEANS is "keep N ready xells warm ON machine M". A process-runner
xell (Zeehive itself) cannot run on a remote machine at all — not a disabled flag, a missing
mechanism, three times over:

1. its worktree is a directory on the queenzee host (`repo_root/.claude/worktrees/<slug>`);
2. its server/webapp are bare processes the queenzee spawns locally (`docker_ctx=NULL`,
   health probed by URL — provision.js);
3. its cxell cage is created with `ctx='default'`, hardcoded (intake.js) — the cage never
   leaves the queenzee's own daemon.

The pool guard (pool.js `reconcileProject`) exists because machine mode counts ready xells
*through the owned server container's* `docker_ctx`; for process xells that is NULL, the
count is zero forever, and fill would provision `pool_size` more every 15s tick — the
167-ready-xell pile of 2026-07-19. So process projects were routed to the legacy
project-wide target and every per-machine knob went dead, loudly.

The "so many steps" is the two exits each crossing a real boundary: compose-converting the
spinoff changes the project's SHAPE (a repo fact → manifest → refresh, so the cache and the
fleet agree), and the clear button deletes the config. Neither yields "pool per machine in
peace", because the system has no notion today that a process xell HAS a machine. It does:
**the queenzee host, always, by construction.** This record adds that notion exactly where it
is factually true and nowhere else.

Two latent defects surfaced while reading for this record (both fixed by the design):

- **Mis-placement:** `provisionXell` → `pickDevMachine` is NOT guarded for process projects.
  A remote machine at top `dev_priority` steers the per-xell db container — the ONE docker
  piece a process xell has, run with `--network zee-hive-net` and addressed by container name
  over that same-daemon network — onto a remote daemon the local processes cannot reach.
  Remote `dev_priority>0` for a process project is not merely ineffective; it can break
  provisioning.
- **Blind cap:** `liveXellCount(ctx)` joins on `c.docker_ctx = ctx`, so process xells are
  invisible to every machine's `max_xells` — the runaway's other half.

## Data shape

No schema change. `machine_pool` (migrations 023/025/038) stays the single authority for
per-(machine, project) pool policy. The one new statement is a READING of existing data:
a server-role container row with `docker_ctx IS NULL` runs on the queenzee host, so for
counting and placement it belongs to the machine row whose context is the queenzee's own.
That identity lives in ONE new helper (`queenzeeHostCtx()`, machines.js — today it returns
`'default'`, the context intake.js already hardcodes for every cage), and is surfaced to the
console as a computed `is_queenzee_host` field on `listMachines` rows so the web never
hardcodes the context string.

## Interfaces (the contract for the builder — smallest set, in dependency order)

1. **machines.js** — `queenzeeHostCtx()` (returns `'default'`); `listMachines` adds
   `is_queenzee_host`; `liveXellCount(ctx)` counts NULL-ctx server rows into the
   queenzee-host machine: `WHERE (c.docker_ctx = $1 OR ($1 = queenzeeHostCtx() AND
   c.docker_ctx IS NULL))`.
2. **provision.js** — when `serverRoleIsProcess(project.manifest)`: pin the machine choice to
   the queenzee-host machine row (or none), never a remote one; `devCtx` for the per-xell db
   container is the queenzee-host context. Fixes the mis-placement defect.
3. **pool.js `reconcileProject`** — when `serverRoleIsProcess`: split `devMachines()` into
   the queenzee-host row and the rest. Host row present → target = its `machinePoolSize`,
   filled/trimmed against the PROJECT-WIDE ready query (all such xells are local by
   construction), capped by its `max_xells` via the widened `liveXellCount`. Remote rows
   present → the existing loud `!!!` guard line, narrowed to name only them. No host row →
   legacy `pool_config.target_ready`, unchanged. Mode flips keep the "say it when it
   CHANGES" map.
4. **intake.js** — no change: the priority join yields 0 for process xells, and ordering is
   moot when every xell is on one machine.
5. **Machines.jsx** — `machinePoolingDisabled` narrows to remote rows
   (`m.enabled && m.dev_priority>0 && !m.is_queenzee_host`) when `spinoffIsProcess`; the
   queenzee-host column's pool/priority knobs render as live; the clear button zeroes only
   the named remote rows; banner text names the third exit ("set the pool on <local> — the
   machine process xells live on").
6. **deploy-topology-spec.md §3.1/§6** — updated WITH the implementation, not before.
7. **Tests** — extend `machine-pooling-warning.test.mjs` (banner names only remote rows;
   local knob live) and `pool-machine-guard-silence.test.mjs`; new
   `pool-process-local-machine.test.mjs`: fill-to-target is idempotent across ticks (the
   runaway assertion), trim on surplus, `max_xells` caps via NULL-aware count, remote-only
   config takes the legacy path with the narrowed guard line, provision pins the db ctx
   local even when a remote machine outranks.

## Migration / compatibility

Pure code; each step is safe to stop at. No data moves, no dual-write, no backfill: the
`machine_pool` rows operators already created become effective the moment step 3 lands.
Half-deployed is benign — until pool.js lands, behaviour is exactly today's. Fleets with no
queenzee-host machine row, or none configured for the project, keep the legacy project-wide
target with zero behaviour change (a fresh install stays as it was).

## Options considered

**A. Status quo — keep the guard, offer only "clear per-machine pooling".**
For: zero risk; the guard stays maximally simple. Rejected: it deletes the operator's intent
instead of honoring the honorable half of it. The local column's knobs render in the matrix
and stay a dead letter, and the nag returns the next time anyone sets a priority — this is
already the second ticket against the same banner.

**B. Compose-convert Zeehive's spinoff server (the banner's named path).**
For: full machine placement; one uniform pooling model. Rejected because it changes what a
Zeehive xell IS (spec §6): the nested queenzee/web become per-xell containers — spinoff
compose, per-xell images, the §6.2 simulate-safety env re-plumbed into container env, health
moving from URL-probe to `docker ps` — a project with its own decision record, not a config
step. And it still would not move the worktree or the cxell off the queenzee host, so for
THIS project it buys none of what the operator asked for. It remains the right path for a
project that genuinely wants xells ON other machines.

**C. Pool numbers in `zeehive.yml`** (the literal "harmoniously with zeehive.yml" ask).
For: one file, one edit, no console round-trip. Rejected because machine identities are HIVE
facts, not project facts — §3.1 deliberately keeps docker contexts and hosts out of the
manifest. A committed pool number makes every branch and fork carry one hive's capacity
policy, and a manifest refresh becomes a fleet-scaling event (a code push silently changing
how many xells warm on a host). It also never touches the actual blocker: the ready COUNT is
zero by construction — the target's address was never the problem.

**D. Honor per-machine pooling on the queenzee-host row; count project-wide; narrow the
warning to remote rows.** CHOSEN — see Decision.

**E. Stamp placement on the xell row (`xell.placed_ctx`) and count by it.**
For: one authoritative placement fact for compose AND process projects; kills the join
entirely. Rejected for now: a schema migration plus a rollout window in which the xell
column and the container row can disagree about placement — two authorities is the exact
disease. The NULL-means-queenzee-host reading gets the same answer for zero schema. Reopen
if placement ever becomes genuinely per-xell (see below).

## Consequences

- Easy now: `pool_size` on the local machine works for Zeehive in peace — one knob, zero
  manifest edits, no banner. The banner only ever covers genuinely dead config. The per-xell
  meta-DB can no longer be steered onto a remote daemon.
- Hard now: machine mode has TWO counting regimes (docker_ctx join for compose projects,
  project-wide for process projects). The code must keep saying which is in force, and the
  docs must stop equating "machine-aware" with "docker-backed".
- Behaviour change to note in the ship: process xells start counting against the local
  machine's `max_xells` for EVERY project sharing that host — correct (the 167-pile was
  invisible to the cap) but a fleet whose local cap is tight will fill less than before.
- Still impossible, deliberately: warming Zeehive xells ON mardale-prod / ugreen-nas. That
  is Option B's territory.

## Reversibility

Pure code — a revert restores today's guard exactly; `machine_pool` rows are untouched in
both directions. The piece to watch on a revert is the `liveXellCount` widening: reverting
it re-blinds `max_xells` to process xells. No one-way doors; the only soft commitment is
operator expectation once the local knob goes live.

## What would change our mind

1. Cxells or worktrees gain remote placement — placement then becomes a real per-xell fact
   and Option E supersedes this record.
2. A queenzee whose primary docker context is not `'default'` — `queenzeeHostCtx()` must
   become config; if the host context cannot be known reliably, the full guard should return.
3. Zeehive's spinoff actually compose-converts (Option B) — this record then collapses into
   the ordinary machine-aware path and should be superseded, not edited.
