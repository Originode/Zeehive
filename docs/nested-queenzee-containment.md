# What is ACTUALLY inert in a nested queenzee — the audit

`CLAUDE.md` used to say a Zeehive xell's own queenzee "can never touch the real fleet" (corrected in the
same change as this document, which it now points at). Ticket #27 was
raised because that is **not true for proddiff**, which probes real production databases with no
simulate gate at all. This document is the audit that question deserves: not "is proddiff exempt?"
but **which loops consult a safety flag, which reach nothing only because of what they happen to do
today, and which reach the real fleet.**

It is an audit, not a remedy. Nothing here changes gating — the fix for proddiff (gate it / scope it
to owned databases / leave it exempt and correct the docs) is a human's decision on ticket #27.

## How to read it

**Read-only reach and write reach are different facts** and are never merged below. A nested
queenzee reading production is a documentation problem; a nested queenzee able to *write* to it is a
containment problem.

Two environments must also be told apart, because the same code has different reach in each:

| | **cxell-run** (a caged zee's `npm run server`) | **host-run** (the legacy host-process mode) |
|---|---|---|
| `docker` binary | **absent** — every docker path fails `ENOENT` | **present** — docker paths work |
| host worktrees (`project.repo_root`, `xell.worktree_path`) | **absent** — the cage sees only `/work/repo` | **present** — real paths, real repos |
| network | default-DROP: `api.anthropic.com`, own containers, queenzee API | whatever the machine has |
| meta-DB | **a CLONE of the real one** — real slugs, container names, docker contexts, repo paths | same |

That last row is the load-bearing one. **A nested queenzee's database is the real fleet's data.**
Every loop below reads real rows and, if it acts on what they name, acts on real things. What stops
it in a cxell is usually the *absence of a tool or a path*, not a flag — which is exactly the
distinction "inert by accident" names.

The flags: `PROVISION_MODE`, `BUILD_MODE`, `SHIP_MODE`, `MAINTENANCE_MODE` (`real` | `simulate`) and
a family of `*_ENABLED` on/off switches. A Zeehive xell gets the three modes as `simulate` plus
`POOL_TARGET_READY=0` and `PROVISION_APP_TIER=false` from `zeehive.yml` → `.zeehive.env` — verified
against this xell's own generated file, which carries the three modes and `POOL_TARGET_READY` and
**no `*_ENABLED` switch at all**. Every `*_ENABLED` check is of the form
`if (process.env.X === 'false')`, so all of them are ON in a nested instance and every loop below
RUNS. Turning one off is a deliberate act nobody has taken for a xell.

## The table

| loop / path | flag it consults | classification | what it reaches | can it WRITE? |
|---|---|---|---|---|
| `pool.js` | `POOL_ENABLED`, `PROVISION_MODE` | **GATED** | provisioning is mode-checked; `POOL_TARGET_READY=0` also means it wants nothing | no (simulate records rows only) |
| `provision.js` (via pool/intake) | `PROVISION_MODE` | **GATED** | worktrees, db containers | no in simulate |
| `reaper.js` | `PROVISION_MODE` | **GATED** — explicitly: in simulate it "retires the ROW ONLY" | worktrees, containers | no in simulate |
| `dbclone.js` | `DBCLONE_ENABLED`, `PROVISION_MODE` | **GATED** — passes `dryRun` into `emitXellEnv` | xell worktrees, clone dbs | no in simulate |
| `intake.js` | `PROVISION_MODE`, `PRODRO_MODE` | **GATED** for spawn/prod-role minting | cxells, prod read-only roles | no in simulate |
| `shipgate.js` — builds + env materialize | `SHIP_MODE`, `SHIP_REAPER_ENABLED` | **GATED** | prod build scripts (MODE is passed to them), `<repo>/.env` | no in simulate |
| **`shipgate.js` → `applyMigrations`** | **none on this step** | **REACHES THE REAL FLEET** | the project's **production database**, via `docker exec … psql` | **YES — it applies SQL** |
| `proddiff.js` | `PRODDIFF_ENABLED` only (an on/off switch, not a mode) | **REACHES THE REAL FLEET** | prod + dev + per-xell databases, catalog `SELECT`s via `docker exec psql` | no — read-only by construction |
| `shipmigrate.js` (`prodDb`, `pendingMigrations`, `catchupDelta`) | none | **REACHES THE REAL FLEET** (read) | prod databases + their migration ledger | no on these paths; `applyMigrations` is the write one, above |
| `maintenance.js` | `MAINTENANCE_MODE`, `MAINTENANCE_ENABLED` | **GATED** — real `pg_dump`/`pg_restore` are inside `MODE === 'real'` | prod db, backup volume | no in simulate |
| `containers.js` (health) | `CONTAINER_MONITOR_ENABLED` | **REACHES THE REAL FLEET** (read) | every docker context in the rows — `docker ps`/inspect | no |
| `containers.js` → `decommissionContainer` | none | **INERT BY ACCIDENT** — only ever called from a human API route, never from a loop | would stop+remove a real container and its volume | **YES if called** |
| `monitor.js` (sessions) | `MONITOR_ENABLED` | **INERT BY ACCIDENT** in a cxell | host session/process state | no |
| `nudge.js` | **none** | **INERT BY ACCIDENT** — needs `docker exec`/SSH to a cxell, absent in a cage | a REAL zee's live session: writes files into its cage and types into its session | **YES if reachable** (writes into another xell's workspace) |
| `landgate.js` / `landing.js` / `landingpad.js` | `LAND_REAPER_ENABLED`, `LANDING_PAD_ENABLED` | **INERT BY ACCIDENT** — the git paths it needs are host paths | the real xource repo (`update-ref`, ref moves) | **YES if the paths exist** |
| `xellgit.js` | **none** | **INERT BY ACCIDENT** — same reason | real worktrees: `stash`, `merge`, `push` | **YES if the paths exist** |
| `poller.js` | `POLLER_ENABLED` | GATED-ish (a switch) | drives the loops above | inherits theirs |
| `worksync.js` | `WORKSYNC_ENABLED` | **INERT** (meta-DB only) | its own database | writes rows in its own (cloned) db |
| `seedgate.js` | `SHIP_MODE` | **GATED** | prod db (approved seed files) | no in simulate |
| `deploylock.js`, `tasks.js`, `landing.js`, `catchup-delta.js`, `ooney.js`, `self.js` | — | **INERT** (meta-DB / own xell only) | its own database, its own worktree | own db only |

## The two findings that matter

**1. `proddiff` reads real production databases from a nested queenzee — read-only.** This is the
ticket, confirmed. `PRODDIFF_ENABLED` is an on/off switch, not a mode, and it defaults to on; the
module's own header says it is read-only ("catalog SELECTs over `docker exec psql`; it never writes
to any application db"), and reading the code bears that out. So the claim the docs used to make was
wrong, and the exposure it hid is *read* exposure. In a **cxell** it is additionally stopped by the
missing docker binary; on a **host-run** nested queenzee it genuinely probes prod.

**2. The ship's MIGRATION step is not gated by `SHIP_MODE`, and it WRITES.** `runShip()` applies
pending `server/sql/migrations/*.sql` to the production database at `shipgate.js:650`, in an
`else if (ok)` branch. The steps around it *are* gated — the prod `.env` materialization is inside
`if (ok && MODE === 'real')`, and the container builds are handed `MODE` so a simulate build is a
no-op — but the migration apply has no mode check.

It is reachable without any human in the nested instance: the ship reaper tick (`SHIP_REAPER_ENABLED`,
on by default) selects `ship_request` rows in status `approved` and calls `runShip()` on up to five
of them per tick, and `recoverOrphanShips()` does the same at boot for rows stuck at `shipping`.
Because the nested meta-DB is a **clone of the real one**, a genuinely approved real ship row is
present in it.

What stops it today, in a cxell: `psql` runs through `docker exec`, and a cage has no docker binary,
so the call fails `ENOENT` before touching anything. On a host-run nested queenzee, docker is present.

**This was NOT exercised.** It is reported from the code and the call graph deliberately: a
demonstration would have been an unapproved write to a real production database, which is exactly the
risk being described. The remedy is a human's call.

## What a reader should take from this

- "A nested queenzee can never touch the real fleet" is **false as written**. What is true: every
  *provisioning, teardown, build, deploy-file and backup* path is mode-gated, and in a **cxell** most
  of the rest is stopped by the absence of docker and of host paths rather than by a flag.
- The safety flags gate **actions**, not **reads**. Nothing in the flag family gates a read of
  production, and two paths (`proddiff`, `shipmigrate`'s ledger reads) use that latitude.
- The one path that is both **ungated and a write** is the ship's migration apply. Everything else
  that could write is inert because a tool or a path is missing in a cage — which is a property of
  the cage, not of the code, and it disappears the moment the same code runs on a host.
