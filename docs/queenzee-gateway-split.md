# Splitting the API gateway from the queenzee's loops

*Design · 2026-08-05 · Architect (xell `design-split-api-gateway-from-queenzee-confi-73130e`) ·
routing request: "decouple the HTTP API from the background loops, and make operation priorities
configurable in project settings"*

**Status: DESIGN. Nothing here is built.** This document says what to build, in what order, what each
step promises a caller, and how to get back out. The companion documents are
[queenzee-operation-priorities.md](queenzee-operation-priorities.md) (the operator-facing half) and
[queenzee-gateway-split-decision-record.md](queenzee-gateway-split-decision-record.md) (what was
rejected, and why).

---

## 1. The claim, measured

> "the console blocks when the queenzee is busy"

That is true, it is not a queueing artefact, and it is not the database. **One HTTP request can freeze
every other HTTP request**, because the route handler runs a synchronous child process on the only
event loop the queenzee has.

Measured in this xell, against **the real `server/src/index.js`**, in the cage, on a `zee db-sandbox`
postgres, with **every background loop disabled** — so the number below is the floor, not the fleet:

| probe (one request per 20ms, 20s) | p50 | p90 | p99 | max |
|---|---|---|---|---|
| `GET /health`, idle | 1.8ms | 3.4ms | 13.3ms | **57.8ms** |
| `GET /health`, one `POST /api/xells/:id/reap` at t=3s | 1.9ms | 3.9ms | 14.1ms | **1179ms** |
| `GET /api/fleet` (console's own read model), same reap | 52.1ms | 78.4ms | 162.2ms | **1220ms** |

`/health` touches nothing — no database, no disk. It still stalled for **1.18 seconds**, in one
unbroken block at t≈4.2s, i.e. exactly while the reap ran. The reap itself was the cheapest one
possible: a two-commit scratch repo, no containers, no docker, no images.

**Why**, exactly:

```
POST /api/xells/:id/reap            api/routes.js:1323
  └─ reapXell()                     queenzee/reaper.js
       └─ spawnSync(bash, scripts/despawn-xell.sh, { timeout: 120000 })   reaper.js:305
```

`spawnSync` blocks the process. Everything else — every console poll, every SSE heartbeat, every
`zee status`, every hook — waits. The measured 1.18s is `despawn-xell.sh`'s own `sleep 1` plus a
`git worktree remove`. On a real host that script also runs `spin-env.sh purge` (docker compose down,
image removal) against a possibly remote docker context, under a **120-second** timeout. The freeze is
whatever that takes.

It is not one route. The same shape is on the human gate paths:

| path | the synchronous thing it does inside the request |
|---|---|
| `POST /api/tasks/:id/done` → `markTaskDone` (`tasks.js:129`) | calls `reapXell` **inline** — the measurement above IS the mark-done path |
| `POST /api/land-requests/:id/decide` → `landApproved` (`landgate.js:709`) | `ffState()` = 3× `spawnSync('git' …)` then the push, inline |
| `POST /api/xells/:id/reap` | as measured |
| `GET /api/fleet` | `projectHeads()` = 2× `spawnSync('git' …)` per poll (`lib/fleet.js:44`) |
| ship / seed / build / provision | `spawnSync` in `lib/provision.js` (16 sites), `lib/cxell.js` (22), `shipgate`, `seedgate` |

And this repo has already paid for it once. `lib/git.js:19` carries the receipt:

> *"spawnSync in a loop is an event-loop freeze: the monitor's stale-claim sweep ran FOUR sync git
> calls per claimed xell per tick, and on big Windows worktrees that starved every API request for
> tens of seconds (2026-07-19: /api/fleet at 30-90s while the DB sat idle)."*

That fix was local (`gitAsync` for one caller). The structure that produced it is untouched.

### The process boundary, isolated — measured by a sibling xell, not by me

A second architect xell was dispatched on this same task and stood down; its measurements came to me
through my manager. **I did not re-run these** and I am not presenting them as mine. Identical load
(240 real git calls per 6s tick, through this repo's own `lib/git.js`, 30s samples):

| arrangement | `/health` p50 | `/health` max |
|---|---|---|
| API **co-resident** with the loops | 1.1ms | **1437.7ms** (matches the tick's 1412ms freeze 1:1) |
| API in a **separate process**, same box, same load | 1.7ms | **58.9ms** |
| same 240 calls made **async, in-process** | — (p95 3.5ms) | **568.7ms** |

Two things fall out, and they are the reason this design has both halves:

1. **The process boundary alone is worth ~24× on the tail.** That is the split (DR-1).
2. **De-syncing is necessary but not sufficient** — 240 *async* spawns still left a 568ms tail,
   because the callbacks, the stdout and the pg work all land back on the one loop. So "just convert
   `spawnSync` to `spawn`" does not finish the job, and now there is a number saying so.

### It is a correctness problem, not only a UX one

This is the finding that upgrades the split from "the console feels slow" to "a gate can deadlock",
and it is the one I would keep if I had to drop everything else. I verified it in the code:

- `hooks/land-gate-update.sh:105` curls the queenzee with `--max-time 10 --connect-timeout 3` and
  **fails closed** — line 110: *"Gate unreachable: queenzee at $API did not answer (curl rc=$RC).
  Failing closed."* A busy queenzee therefore **declines a human-approved push**.
- `landgate.js:895–900` already documents the self-deadlock this produced, with its own receipt:
  *"the server is single-threaded and, having initiated the push, is blocked inside spawnSync waiting
  for it. The hook times out (curl rc=28), fails closed, and the push is declined. That self-deadlock
  is the actual cause of 'I approved and nothing happened' — verified: /api/land/check answers in 57ms
  when the loop is free and times out during a server-initiated push."*

That was fixed locally (`update-ref` instead of `git push`, so the hook is not re-entered). The
*structure* that produced it — a gate whose verdict is served by the same loop the gate's own work
blocks — is untouched. Hence the hard requirement in §4: **the gate path must be non-starvable.**

### How long a single call can freeze the fleet

Verified in this branch, by timeout ceiling:

| call site | timeout |
|---|---|
| `reaper.js:305` `spawnSync(despawn-xell.sh)` — the mark-done path | 120s |
| `provision.js:765` `spawnSync(provision-xell.sh)` | **600s** |
| `xell-db.js:406` `spawnSync(…pg_restore…)` — isolated-db provisioning | **1800s** |

**Design-maximum single-call freeze: thirty minutes.** And the irony for part (B) is worth stating
plainly: the operator's own top-priority example — mark-done / reaping — is today one of the longest
blocking calls in the API.

### A second, quieter channel

`server/src/db/pool.js` creates the pg pool with no options: **`max` = 10, `connectionTimeoutMillis` =
undefined** (verified against the installed `pg` in this cage). `index.js:80` takes one connection out
of that pool *permanently* for the single-queenzee advisory lock, leaving **9**. A loop that holds
several clients through a slow meta-DB (it is over the network) makes route handlers **queue for a
client with no timeout at all** — they wait forever rather than failing. No measurement here: I did not
reproduce it, and I am not going to report it as if I had. It is a code fact, and the split fixes it
for free (two processes, two pools).

### What I did NOT measure

- The cost of the loops themselves under a real fleet — my sandbox has one project and no xells.
  The loop tick costs are documented in the code (`pool.js:195`: sweeps compounding "from 47s to 90s+"
  on 2026-07-19) and I am citing that as **history, not as my measurement**.
- The cost of a live headless turn on the API's event loop. `intake.js:1318` consumes an
  `sdk.query()` async iterator **inside the queenzee process** for every `headless-sdk` zee, so every
  agent event is parsed and handled on the loop that serves the console. Real, unquantified, named in
  §7 as its own phase.

### Reproducing it

```sh
zee db-sandbox --migrate                                  # DSN on 127.0.0.1, dies with the cage
DATABASE_URL=<dsn> PORT=4818 PROVISION_MODE=real \
  POOL_ENABLED=false POLLER_ENABLED=false MONITOR_ENABLED=false \
  CONTAINER_MONITOR_ENABLED=false CONTEXT_RECONCILE_ENABLED=false DBCLONE_ENABLED=false \
  PRODDIFF_ENABLED=false REVIVE_ENABLED=false IMAGE_JANITOR_ENABLED=false WORKSYNC_ENABLED=false \
  LANDING_PAD_ENABLED=false LAND_REAPER_ENABLED=false SHIP_REAPER_ENABLED=false \
  node server/src/index.js
# insert a project whose repo_root is a scratch git repo + a xell row whose worktree_path is a
# real worktree of it, then: hammer GET /health every 20ms and POST /api/xells/<id>/reap once.
```

The probe scripts stayed in `/tmp` deliberately (house rule: scratch does not ride into the repo).
Phase 0 of §7 turns the *durable* half of this into a test that cannot rot — see
`test/gateway-no-sync-exec.test.mjs`.

### How big the job is, counted

I prototyped that lint (a static walk of the `import` graph from `api/routes.js`, in `/tmp`) and ran
it against this branch:

```
modules reachable from api/routes.js: 105
of those, 26 contain a synchronous child-process call — 57 call sites total
  8 lib/devices.js · 7 lib/provision.js · 5 queenzee/shipmigrate.js · 5 queenzee/landgate.js ·
  3 lib/xell-db.js · 3 lib/projects.js · 3 queenzee/shipgate.js · 3 lib/reveal.js · … · 1 queenzee/reaper.js
```

That is the size of Phase 3, measured rather than guessed: **57 blocking call sites are statically
reachable from the route table**. Import-reachability over-approximates runtime reachability (a module
imported for one function may hold its `spawnSync` in another) — which is the right direction for a
guard, and is exactly what the shrinking allowlist keeps honest.

The sibling xell ran the same idea **per entry point** (depth-limited to 3 local imports), which is
the more useful ordering for Phase 3 — again, its numbers, not mine:

| entry point | sync-exec sites reachable (depth 3) |
|---|---|
| `api/routes.js` | 53 |
| `queenzee/self.js` (every `zee` verb) | 49 |
| `queenzee/reaper.js` | 44 |
| `queenzee/pool.js` | 42 |
| `queenzee/worksync.js` | 38 |
| `queenzee/intake.js` | 35 |
| `queenzee/poller.js`, `lib/harness-bridge.js` | **0** |

Two loops already reach zero — they are DB-only today, and they are the shape every loop is meant to
end up in ("a loop DECIDES"). `self.js` at 49 is the one worth flagging: **every cxell verb a zee
calls runs through it**, so a frozen queenzee is also a frozen `zee status`.

---

## 2. The coupling, mapped

One process (`server/src/index.js`) does all of this:

```
express app  ──  api/routes.js (295 routes)  ──┐
                                               ├── the SAME event loop, the SAME pg pool (max 9),
15 setInterval loops started in index.js ──────┘    the SAME module graph, the SAME child processes
  poller · pool · monitor · containers · context-reconcile · maintenance · shipReaper ·
  landReaper · landingPad · revive · imageJanitor · proddiff · dbclone · worksync · harnessBridge
+ a websocket terminal bridge on the same server (attachTerminalBridge)
+ every live headless turn (LIVE_QUERIES)
```

`routes.js` imports **directly** from `queenzee/*` — `intake`, `reaper`, `maintenance`, `monitor`,
`landgate`, `shipgate`, `seedgate`, `proddiff`, `containers`, `tasks`, `self`, `pause`, `nudge`,
`xellgit`, `landingpad`, `deploylock`. A route does not *ask* the queenzee to do something; the route
**is** the queenzee, on the request's stack.

### What is shared, and how hard it is to move

**Almost everything is already in the meta-DB, and that is what makes this tractable.** Every gate is
rows: `land_request`, `ship_request`, `prod_bind_request`, `seed_request`, `deploy_lock`,
`session_event`, `task`. Every fleet fact is rows. A second process reading the same database sees the
same truth with no new plumbing.

### The singleton lock is the boundary, stated in one line

`index.js:78–92` takes advisory lock `715533001` — *"the queenzee of this meta-DB"* — for the process
lifetime, and a second instance waits 90s and exits. That lock is entirely about **driving the fleet**:
two loop-runners reconciling against one meta-DB ping-pong provisions and reap each other's xells
(three were once alive for a day). **It has nothing to do with serving HTTP.** The current process
takes it anyway, because the two jobs are one process — so ZEEHIVE cannot express *"I am **a** queenzee
API instance"* as distinct from *"I am **the** queenzee"*.

That is not a theoretical cost. **This very xell is bound `db-shared-dev`, where the live queenzee
already holds that lock — so a spinoff `server` container here can never win it, waits 90s and
restart-loops, while `zee build server --wait` may still report "UP and serving your HEAD" and the
port refuses every connection.** (Corroborated across several xells; my manager is raising it
separately as TKT-136-FE32 / TKT-137-F266. It is why the §1 measurement was taken against a
`zee db-sandbox` postgres rather than a built container.)

After the split the gateway takes **no** lock, so an API instance is startable anywhere, any number of
times, against any meta-DB — including a spinoff's. An environment fault becomes design evidence: the
lock is exactly the line this design draws, and the fleet is already paying for it not being drawn.

**Phase-0 reality (built):** `QUEENZEE_INPROC=false` already starts exactly this API-only instance —
no lock, no loops, every route served — from the current one-process `index.js` (see
`server/src/config.js`). It is the pre-split slice: the lock and loop skips plus an honest refusal on
the routes that drive the fleet, with default behavior (the lock + all loops) unchanged. The name is
item 23's escape hatch, answering "are the queenzee loops in THIS process?" — default true today, and
the split flips the default, not the flag.

Five things are **not** in the database — process-local state a route reads today:

| state | owner | who reads it | can it cross a process boundary? |
|---|---|---|---|
| `bus` (EventEmitter) → SSE `/api/stream` | `lib/events.js` | every loop broadcasts; the console subscribes | **No** — must be forwarded (§5.3) |
| `ring` (2000 log lines) → `GET /api/logs` | `lib/logbus.js` | the console terminal | **No** — same channel as the bus |
| `LIVE_QUERIES` (live SDK turn handles) | `intake.js:879` | `setZeeMode`, message-into-a-live-turn | **No** — a handle to a running child |
| `backupJobs` (AbortControllers) | `maintenance.js:72` | `cancelBackup` | **No** — same |
| `registry` (harness bridges), `inFlight` | `lib/harness-bridge.js` | `getBridge`/`probeBridge` | **No** — same |
| `nameCache`, `cxellDiffCache`, `crewDiffCache`, `staleDiffAt`, `lastSaid`, `reportedDryLandings`, `liveShips` | various | caches and log de-dupers | **Yes** — duplicate per process; a cache miss is not a bug |

The first five are the whole difficulty of the split, and there are only five. Note that
`setZeeMode` **already** handles "there is no live control channel to this session" as a first-class
answer (`intake.js:904`) — the degraded path the split needs is code that already exists and already
ships.

---

## 3. The boundary

Three tiers. The rule that decides which tier a piece of work belongs to is one sentence:

> **A loop DECIDES. An op DOES. The gateway only ever reads rows and writes rows.**

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ GATEWAY            server/src/index.js          (container zeehive_server, :4700) │
│   express + SSE + the terminal websocket + 295 routes                            │
│   MAY: read/write the meta-DB, enqueue ops, forward 5 live-state calls           │
│   MAY NOT: spawn anything, touch a worktree, hold the single-queenzee lock       │
│   INVARIANT: no code path from a route may reach *Sync() or docker (lint-tested) │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ meta-DB (shared truth)        ▲ /internal/* on 127.0.0.1 (5 calls + events)
        ▼                               │
┌──────────────────────────────────────────────────────────────────────────────────┐
│ WORKER             server/src/queenzee/index.js (container zeehive_queenzee)      │
│   the 15 loops + the op scheduler + the live-turn handles                        │
│   holds the single-queenzee advisory lock                                        │
│   MAY: read/write the meta-DB, spawn op-runners, own long-lived children         │
│   MAY NOT: block its own event loop (no *Sync in a tick — lint-tested)           │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ spawn()
        ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ OP-RUNNER          node server/src/queenzee/op-runner.js <op_id>                  │
│   ONE operation, one process, exits when done. May block itself all it likes:    │
│   spawnSync, a 120s despawn script, docker, git — nobody is waiting on this loop │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Why three and not two.** A two-process split (gateway + worker) fixes the console and leaves the
worker starving itself: mark-done would still be a 120-second freeze *of the queenzee*, and the
priority model in §6 would have nothing to schedule. The op-runner is the tier that turns "heavy work"
into something with a row, a lane, a cancel button and a concurrency budget. It is also what lets the
refactor **stop converting `spawnSync` calls** — inside a runner they are legal and correct, so the
job is "move the call site", not "rewrite 60 call sites".

**What stays in the gateway on purpose:**

- the **terminal websocket** (`lib/terminal-bridge.js`): pure I/O to a cage over SSH, no host state
  beyond the ssh key file, and it is what a human reaches for when things are bad. It must not share a
  process with the thing that freezes.
- **every gate decision**: `decideLandRequest`, `decideShip`, `decideProdBind`, `markTaskDone`,
  `decideDoneSuggestion`. The *decision* is a row write and stays synchronous in the request. Only the
  *execution* that follows it becomes an op. §4 is emphatic about this.

---

## 4. What this must not change: the gates

Every gate keeps its human, its wording and its answer. The rule:

> **The caller's answer is still the GATE's verdict, computed synchronously from rows. Only the work
> that happens AFTER a human has decided becomes an operation.**

| verb | today | after | changed for the caller? |
|---|---|---|---|
| `zee land` | held / queued(holding) / stale / refused, computed from rows | identical | **no** |
| approve a landing | `landApproved()` pushes inline; the HTTP call returns the push result | writes `land_request.status='approved'`, enqueues `land` op, returns the row + `op_id` | the console already re-renders from SSE; the push result arrives on the op |
| `zee ship` | refused unless landed (synchronous, from rows) | identical refusal, then a `ship` op | **no** — a refusal is still `ok:false, refused:true`, exit 1 |
| `zee prod` / `zee seed` | records a request; a human decides | identical | **no** |
| `zee done` | flags `awaiting-done` | identical | **no** |
| "Mark done" | reaps inline (1.2s–120s freeze) | writes `task.status`, enqueues a **top-lane** `reap` op, returns immediately | the button stops hanging the console; the card follows the op |
| `zee build --wait` | polls build status | identical (the build already reports through rows) | **no** |

**And one hard requirement, from §1: the gate path must be non-starvable.** `hooks/land-gate-update.sh`
gives the queenzee **10 seconds** to answer `/api/land/check` and **declines the push** if it does not.
So `GET /api/land/check` is not a read model — it is a correctness-critical endpoint on a 10-second
budget, and it must be served by a process that cannot be blocked by fleet work. After the split it is
a pure row read in the gateway, which is exactly the property the hook has always assumed and never
had. A reviewer should treat any change that puts host work back on that path as a defect, not a
regression in latency.

Three invariants a reviewer should check every PR against:

1. **No gate becomes automatic.** An op is only ever enqueued by (a) a human's decision, (b) a loop
   that already had the authority to act, or (c) a zee verb that was already permitted. `enqueueOp`
   grants nothing.
2. **No gate becomes asynchronous in its *refusal*.** Refusals are cheap row reads; they stay in the
   request. A gate that answered "no" instantly must not start answering "we'll let you know".
3. **The prod deploy lock and the landing pad are unchanged.** The lock is a row (`deploy_lock`); the
   pad (`queenzee/landingpad.js`) is the one-at-a-time chronological runway for landings and ships. A
   `top` lane does **not** jump either (§6.5 of the companion doc). The pad's own words: it *"only
   decides the ORDER and the ONE-AT-A-TIME in which the queenzee acts on the things a human already
   approved"* — that stays true, and lanes order the **rest** of the queue around it.

---

## 5. Interfaces

### 5.1 The operation queue (the one new table)

**This is a generalization of something the repo already has, not a new idea.**
`queenzee/landingpad.js` is *already* a DB-backed chronological FIFO across two lanes (landings and
ships), with strict one-at-a-time processing, an `LANDING_PAD_ENABLED=false` escape hatch and a read
model the console renders. `queenzee_op` is that pattern applied to **every** heavy operation, with
lanes instead of pure arrival order — and the pad keeps its own authority over its runway (§4).

The counter-example is just as instructive: `lib/build.js` does validate-synchronously → flip a DB
status → return → **float the work as a promise**, which is why `recoverOrphanBuilds()` has to run at
boot to clean up after a queenzee that died mid-build (`index.js:128`). Three such recoveries exist
(`builds`, `ships`, `teardowns`). A durable job row with a heartbeat is what those three are
compensating for the absence of.

```sql
-- db/migrations/NNN_queenzee_operations.sql   (ask `zee migration-number` for NNN)
CREATE TABLE queenzee_op (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  kind          text NOT NULL,                  -- vocabulary: server/src/lib/op-kinds.js
  xell_id       uuid REFERENCES xell ON DELETE CASCADE,   -- NULL = fleet/project-wide op
  args          jsonb NOT NULL DEFAULT '{}'::jsonb,
  lane          text NOT NULL CHECK (lane IN ('top','normal','background')),
  dedupe_key    text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','failed','cancelled')),
  requested_by  text NOT NULL,                  -- 'human:<name>' | 'zee:<slug>' | 'loop:<name>'
  request_ref   jsonb,                          -- the gate row this executes: {"land_request":"<uuid>"}
  runnable_at   timestamptz NOT NULL DEFAULT now(),   -- retry backoff / deferral
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz, finished_at timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  runner_pid    int, runner_host text, heartbeat_at timestamptz,
  result        jsonb, error text
);
-- ONE pending/running op per logical target. Two clicks of "Mark done" are one reap.
CREATE UNIQUE INDEX queenzee_op_dedupe ON queenzee_op (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');
CREATE INDEX queenzee_op_queue ON queenzee_op (status, lane, enqueued_at)
  WHERE status IN ('pending','running');
```

**Data-shape decisions, and what is authoritative:**

- `lane` is **stored, not derived**. It is resolved from project settings at *enqueue* time and never
  re-read. An op runs at the priority it was accepted at; changing a setting must not reorder a queue
  under a human who is watching it, and the row is then the receipt for why it ran when it ran. The
  settings screen says so: *"applies to newly enqueued operations"*.
- `args` is the **whole** input. A runner must never re-derive its target from live state — that is
  the class of bug `pool.js:29` documents at length (a stale scan reaping a freshly dispatched xell).
  Runners re-assert their preconditions atomically (below).
- `result`/`error` are **facts about the op**, never the gate's verdict. The gate's verdict is in
  `land_request` / `ship_request` / `task`, and those tables stay authoritative when the two disagree.
- Retention: `done`/`failed`/`cancelled` older than 14 days are deleted by the maintenance loop. Ops
  are a work queue with a short audit tail, not a history (`session_event` is the history).

**Claiming is a conditional UPDATE, matching `takeReadyXellForSweep`'s existing shape** — the repo
already settled "two deciders, one row" this way:

```sql
UPDATE queenzee_op SET status='running', started_at=now(), attempts=attempts+1,
       runner_pid=$1, runner_host=$2, heartbeat_at=now()
 WHERE id = (SELECT id FROM queenzee_op
              WHERE status='pending' AND runnable_at <= now()
              ORDER BY CASE lane WHEN 'top' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, enqueued_at
              FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

### 5.2 The module both processes import

```js
// server/src/queenzee/ops.js
export async function enqueueOp({ project_id, kind, xell_id = null, args = {}, requested_by,
                                  request_ref = null, dedupe_key = null, runnable_at = null })
  // → { op, deduped: boolean }
  // NEVER throws on a duplicate: returns the EXISTING pending/running op with deduped:true.
  // Resolves `lane` from pool_config (lib/op-priority.laneFor) and stores it.
  // Throws only on: unknown kind, unknown project. Both are programming errors, not runtime ones.

export async function claimNextOp({ budget })     // the worker's scheduler; the SQL above
export async function heartbeatOp(id)             // runner → every 10s
export async function finishOp(id, { result, error })
export async function cancelOp(id, by)            // pending → cancelled; running → best-effort signal
export async function listOps({ project_id, status, kind, xell_id, limit = 50 })
export async function opStatus(id)
export async function recoverOrphanOps()          // boot: running + heartbeat older than 90s → pending
                                                  // (attempts >= 3 → failed, loudly). Same shape as
                                                  // recoverOrphanBuilds/Ships/Teardowns in index.js.
```

**The scheduler polls at 1000ms.** A `top` op therefore starts within a second of being enqueued,
which is two orders of magnitude better than the freeze it replaces. A `pg_notify` wake-up (payload:
the op id) is the named future optimization and is deliberately **not** built — see DR-2 and DR-4.

> **⚠ Every number in this section is a JUDGEMENT DEFAULT, not a measurement.** The per-kind
> `timeout_ms` values, the 1000ms scheduler tick and `max_concurrent_ops: 2` were chosen to be
> obviously-safe starting points, not derived from data — nothing in this fleet has been timed at
> that granularity. The `timeout_ms` values are deliberately set **above** the existing `spawnSync`
> timeouts they wrap (`reaper.js:305` 120s → 180s, `provision.js:765` 600s → 900s, `xell-db.js:406`
> 1800s → 1800s+) so the inner timeout still fires first and keeps its own error message; that
> relationship is the part worth preserving, and the absolute numbers are the part worth replacing
> the moment anyone has real op durations. The **module and function names above ARE verified** — all
> sixteen were checked against this branch's exports.

**The kind registry** — the whole contract between an enqueue site and a runner, in one file, exactly
as `spawn-prep.js` holds `STEP_KINDS`:

```js
// server/src/lib/op-kinds.js
export const OP_KINDS = {
  reap:           { module: '../queenzee/reaper.js',      fn: 'reapXell',        timeout_ms: 180000 },
  provision:      { module: '../lib/provision.js',        fn: 'provisionXell',   timeout_ms: 900000 },
  build:          { module: '../lib/build.js',            fn: 'buildXell',       timeout_ms: 1800000 },
  land:           { module: '../queenzee/landgate.js',    fn: 'landApproved',    timeout_ms: 300000 },
  ship:           { module: '../queenzee/shipgate.js',    fn: 'runShip',         timeout_ms: 3600000 },
  seed:           { module: '../queenzee/seedgate.js',    fn: 'runSeed',         timeout_ms: 600000 },
  backup:         { module: '../queenzee/maintenance.js', fn: 'backupProd',      timeout_ms: 7200000 },
  restore:        { module: '../queenzee/maintenance.js', fn: 'restoreBackup',   timeout_ms: 7200000 },
  'db-clone':     { module: '../lib/xell-db.js',          fn: 'attachXellDb',    timeout_ms: 1800000 },
  'schema-catchup':{module: '../queenzee/shipmigrate.js', fn: 'catchUpXellToProd', timeout_ms: 900000 },
  'pool-reconcile':{module: '../queenzee/landing.js',     fn: 'reconcileXell',   timeout_ms: 300000 },
  'prod-diff':    { module: '../queenzee/proddiff.js',    fn: 'diffOneContainerAgainstProd', timeout_ms: 600000 },
  'env-reconcile':{ module: '../lib/provision.js',        fn: 'emitXellEnv',     timeout_ms: 60000 },
  'image-janitor':{ module: '../lib/images.js',           fn: 'sweepOrphanSpinImages', timeout_ms: 1800000 },
  'worktree-diff':{ module: '../lib/git.js',              fn: 'worktreeDiff',    timeout_ms: 120000 },
  dispatch:       { module: '../queenzee/intake.js',      fn: 'spawnHeadless',   timeout_ms: null },   // long-lived, see §7 phase 6
};
```

A `timeout_ms` of `null` means "this runner owns a live turn and lives as long as it does". Every
other runner is killed at its timeout and the op is `failed` with a named reason — today several of
these paths have a `spawnSync` timeout and no *op-level* one, so a wedged docker context is a
permanent stall nobody can see.

### 5.3 HTTP

**Public (gateway, unchanged paths).** Existing action routes keep their path, method and status
codes, and gain an envelope:

```jsonc
// POST /api/xells/:id/reap  →  202
{ "ok": true, "op": { "id": "…", "kind": "reap", "lane": "top", "status": "pending" },
  "xell": { "id": "…", "slug": "…", "status": "tearing-down" } }
```

New, small, read-only surface for the console's operations rail:

```
GET  /api/ops?project=<uuid>&status=pending,running&limit=50   → [op…]
GET  /api/ops/:id                                              → op
POST /api/ops/:id/cancel   { reason }                          → { cancelled, reason }
```

**Internal (worker, 127.0.0.1 only, `Authorization: Bearer $QUEENZEE_INTERNAL_TOKEN`).** Exactly six
endpoints, because exactly five pieces of state cannot cross a process boundary:

```
GET  /internal/events                    SSE — the worker's bus; the gateway re-fans it to /api/stream
GET  /internal/logs?n=200                the logbus ring (backfills the console terminal after a
                                         gateway restart)
GET  /internal/health                    { ok, uptime_s, loops:[{name,last_tick_at,skipped}],
                                           ops:{pending,running}, lock_held }
POST /internal/live/:zee_id/mode         { permission_mode }   → setZeeMode against LIVE_QUERIES
POST /internal/live/:zee_id/message      { text, images }      → into a running turn
POST /internal/backup/:snapshot_id/cancel                      → the AbortController in backupJobs
```

**Contract when the worker is unreachable:** these six return `503 {"queenzee_offline": true,
"since": …}` and the gateway surfaces a `queenzee offline` chip in the console. Every DB-backed read
and every gate decision keeps working. That is strictly better than today, where the same condition is
a dead console *and* a dead fleet with no way to tell them apart.

**The three-servers trap.** `CLAUDE.md §1` warns that two servers answer the same paths (your own
build vs the fleet queenzee). This adds a third listener, so: `/internal/*` is bound to `127.0.0.1`
only, and the **gateway refuses `/internal/*` with a named 404** — *"/internal is the queenzee
worker's loopback API; you are talking to the gateway"*. A zee that probes the wrong port gets a
sentence, not a mystery.

### 5.4 Event fan-out

The worker keeps `lib/events.js` and `lib/logbus.js` exactly as they are. The gateway starts an
`EventSource`-style client against `/internal/events`, and every frame it receives it re-`broadcast()`s
onto its own bus, which `/api/stream` already serves. **No route changes and no console changes.**

- Reconnect with backoff; on reconnect, backfill the log ring from `/internal/logs`.
- A dropped frame is a missed repaint, not lost truth: every console view re-reads from the DB on the
  event. That is already how it behaves (`broadcast('xell', { id })` sends an *id*, not a payload).
- The gateway pulls (rather than the worker pushing) so that a gateway restart is invisible to the
  worker and needs no registration.

---

## 6. Priorities, in one paragraph

Full spec: **[queenzee-operation-priorities.md](queenzee-operation-priorities.md)**. In brief:
`pool_config.op_priority jsonb` (project settings — the same NULL-means-default, one-normalizer,
served-effective shape as `spawn_prep`, migration 121) maps each **op kind** to one of three
**lanes** — `top` / `normal` / `background` — plus one `max_concurrent_ops` number. Defaults put
`reap` on `top` (the operator's stated policy: reaping frees compute), leave everything a human waits
on at `normal`, and drop the five pure-housekeeping kinds (`pool-reconcile`, `prod-diff`,
`image-janitor`, `env-reconcile`, `worktree-diff`) to `background`. A lane means three concrete things: dequeue order, a reserved
concurrency slot for `top`, and `background` loop ticks that **skip** while a `top` op is pending or
running. Lanes order a queue; they never preempt a running op and never jump the prod deploy lock.

**Priorities do not need the process split.** Phase 2 delivers them on today's single process, which
is why they are sequenced before it.

---

## 7. Migration — seven phases, each safe to stop at

Each phase lands on its own, is useful on its own, and has a named way back. The system is running
throughout, with old data, live callers, and (in the fleet) a half-deployed pair of processes.

### Phase 0 — make the invariant testable (no behaviour change)
- `test/gateway-no-sync-exec.test.mjs`: walk the static import graph from `api/routes.js` and fail on
  any reachable `spawnSync`/`execSync`/`execFileSync` **outside a declared allowlist**. The allowlist
  starts as "everything that is reachable today" and shrinks by one entry per phase. A deterministic,
  machine-independent gate — *not* a latency threshold test, which would measure how busy the box is.
- `lib/loops.js`: a registry every `start*()` registers with (`{ name, interval_ms, tick }`), so a
  loop can be listed, timed, and later gated. No behaviour change; `index.js` calls it instead of
  fifteen bare `setInterval`s.
- **Back out:** delete two files.

### Phase 1 — the op queue, with `reap` as its only kind
- The migration in §5.1, `queenzee/ops.js`, `lib/op-kinds.js`, `queenzee/op-runner.js`, and the
  scheduler tick in the worker-to-be (still inside `index.js`).
- `POST /api/xells/:id/reap` and `markTaskDone` enqueue instead of calling `reapXell`.
- Feature flag `OPS_ENABLED` (default `true` after the first fleet day; ships as `false`): when
  `false`, both call sites do exactly what they do today, inline.
- **Proof:** rerun §1's measurement. `/health` max during a mark-done must fall to the idle baseline.
- **Back out:** `OPS_ENABLED=false`. The table stays and is ignored (additive; never destructive).

### Phase 2 — priorities (see the companion doc)
- `pool_config.op_priority` migration, `lib/op-priority.js`, the lane column populated at enqueue,
  the `mayTick()` yield check wired into the loop registry, the Project setup → Pool section.
- **Back out:** set every kind back to `normal` from the console (`Reset to defaults` is one click),
  or `OP_PRIORITY_ENABLED=false` to force `normal` everywhere.

### Phase 3 — move the remaining kinds onto ops, one PR per kind
Order by measured pain, and each PR keeps its inline fallback behind the same flag:
`land` → `build` → `provision`/`pool-reconcile` → `backup`/`restore` → `ship`/`seed` →
`db-clone`/`schema-catchup` → `prod-diff`/`image-janitor`/`env-reconcile`/`worktree-diff`.
Each PR shrinks the Phase-0 allowlist by its entry. **Back out:** per-kind flag.

### Phase 4 — split the process
- `server/src/queenzee/index.js` — the worker entrypoint. **The npm script `queenzee` already exists
  and points at that exact path** (`package.json`), and the file does not; the seam was intended once
  already.
- `index.js` keeps express, SSE, the terminal bridge and the routes; it **stops** starting loops and
  **stops** taking the advisory lock.
- The worker takes the lock (unchanged code, moved), starts the loops, starts the scheduler, and
  serves `/internal/*` on `127.0.0.1:4701`.
- `docker-compose.prod.yml` gains a `queenzee` service from the **same image** with
  `command: node server/src/queenzee/index.js`, the same volumes (repos, ssh keys, docker socket),
  the same env. `npm run dev` gains the worker via `concurrently`.
- **The way back is a flag, not a revert:** `QUEENZEE_INPROC=true` makes the gateway start the loops
  in-process exactly as today (one import, one call). The split is therefore **not a one-way door**
  until Phase 7 deletes that branch.
- **Deploy order (half-deployed fleet):** the advisory lock already refuses a second driver, so the
  order is: recreate `server` (gateway; takes no lock, so it can start while the old process still
  holds one) → then start `queenzee` (waits up to 90s for the old lock to free — the existing
  behaviour in `index.js:78`). At no point are two loop-drivers live.

### Phase 5 — the five live-state calls
`setZeeMode`, message-into-a-live-turn, `cancelBackup`, `getBridge`/`probeBridge`, and the log ring
move behind `/internal/*`; the gateway forwards. **Back out:** `QUEENZEE_INPROC=true`.

### Phase 6 — live turns leave the queenzee (separate, optional, biggest win for CPU)
`intake.js` runs `sdk.query()` **in-process**. Move each headless turn into its own long-lived
op-runner (`kind: 'dispatch'`, `timeout_ms: null`), with `LIVE_QUERIES` becoming a map of child IPC
channels behind the same `/internal/live/*` interface — so the gateway does not change at all. This is
why §5.3 puts an indirection in front of a Map today. Also fixes a real fault: a queenzee restart
currently kills every live host-side turn.

### Phase 7 — close the doors
Delete the inline fallbacks and `QUEENZEE_INPROC`. Empty the Phase-0 allowlist. Add the doc-map rows
to `CLAUDE.md` **and** sync `project_doc.body` in the same landing
(`zee migration-number`, then `node scripts/sync-project-doc.mjs <NNN>` — `test/project-doc-drift.test.mjs`
fails otherwise). *This deliberately did not happen in this design landing: a doc-map row for something
nobody can use yet would cost a migration and buy nothing.*

---

## 8. Risks

| # | risk | mitigation | residual |
|---|---|---|---|
| 1 | **A gate weakens by accident** during Phase 3 (an execution path that also carried an authorization check) | §4's three invariants are the PR checklist; `landApproved` etc. keep their own precondition checks *inside* the runner and re-assert atomically | a reviewer must actually read the moved function |
| 2 | **Three servers answer the same paths** | `/internal/*` is loopback-only; the gateway refuses it with a named 404 | a zee can still probe the wrong port — but now it is told which |
| 3 | **Op storms** — a loop enqueues every tick | `dedupe_key` is mandatory at every enqueue site (lint: `enqueueOp` without `dedupe_key` fails the test unless the kind opts out) | a kind that opts out wrongly |
| 4 | **Priority inversion** — a `top` reap waits on the prod lock a `normal` ship holds | stated, not solved: lanes order the queue, they do not preempt or jump locks (§6.5 of the companion doc) | a top op can still wait; it is visible in the ops rail |
| 5 | **Background starvation** under a permanently busy `top` lane | aging: a `background` op waiting > 15 min is promoted to `normal` | tuning |
| 6 | **Two loop-drivers** in a half-deployed fleet | the existing advisory lock (`index.js:78`) already makes this impossible; the gateway must not take it (lint: the lock code lives in `queenzee/index.js` only) | none, if the lock stays |
| 7 | **Worker down = console half-dead** | DB reads and gate decisions keep working; an honest `queenzee offline` chip; `/internal/health` is what it reports from | live-turn controls unavailable while it is down (they are unavailable today too — the whole process is down) |
| 8 | **The op table grows** | 14-day retention in the maintenance loop; partial indexes only cover pending/running | none |
| 9 | **The host-process era** (`docker/zeehive/Dockerfile.server` says the live queenzee may still be a host process) | two processes need a supervisor there; `npm run dev` covers a checkout, and `QUEENZEE_INPROC=true` covers a host deploy that cannot supervise two | a host deploy runs un-split, and gets Phases 1–3 only |
| 10 | **pg pool** — `max: 10`, no connection timeout | set both explicitly per process when the split lands (gateway 10 / worker 10, `connectionTimeoutMillis: 5000`); a route should fail fast, not wait forever | worth doing in Phase 4, not before |
| 11 | **A later change puts host work back on `/api/land/check`** — the endpoint the push hook decides on in 10 seconds, failing closed | item 1's lint asserts that endpoint's handler specifically, by name, on top of the whole-graph rule; `landgate.js:895` is cited in the test so the reason travels with it | a reviewer can still allowlist it |

---

## 9. Work items (builder-executable)

Each item names its files, its proof, and what it must not change. `S`≈half a day, `M`≈1–2 days,
`L`≈3+. **Dependencies are strict** — the number in `after` is the item that must be landed first.

| # | title | size | after | files | done when |
|---|---|---|---|---|---|
| 1 | **Lint: no synchronous exec reachable from a route** | S | — | `test/gateway-no-sync-exec.test.mjs` (new) | the test walks `api/routes.js`'s import graph, prints the current allowlist, and FAILS when a new sync call becomes reachable. The allowlist starts at the **measured** 26 modules / 57 call sites (§1) — a prototype of this walk was run on this branch, so the shape is known to work. Watched to fail: add a `spawnSync` to a route, see red. **Plus a named assertion for `GET /api/land/check`**: its handler must reach zero sync-exec sites and zero host work, because `hooks/land-gate-update.sh` decides a human's push on it in 10s and fails closed (cite `landgate.js:895` in the test so the reason travels with the check) |
| 2 | **Loop registry** | S | — | `server/src/lib/loops.js` (new), `server/src/index.js` | all 15 loops register `{name, interval_ms, tick}`; `GET /api/logs` unchanged; `node server/src/index.js` boots with identical log lines |
| 3 | **Migration: `queenzee_op`** | S | — | `db/migrations/NNN_queenzee_operations.sql` (get NNN from `zee migration-number`) | `npm run db:migrate` applies clean on a fresh db AND on a prod-schema clone; `test/migration-numbers.test.mjs` green |
| 4 | **`ops.js` + `op-kinds.js`** | M | 3 | `server/src/queenzee/ops.js`, `server/src/lib/op-kinds.js` (both new) | `test/queenzee-ops.test.mjs`: enqueue→claim→finish; two concurrent claims get different ops (SKIP LOCKED); a duplicate `dedupe_key` returns the same op with `deduped:true`; an op whose heartbeat is 90s stale is recovered to `pending` |
| 5 | **`op-runner.js`** | M | 4 | `server/src/queenzee/op-runner.js` (new) | `node server/src/queenzee/op-runner.js <id>` runs one op, heartbeats, writes `result`, exits 0; a handler that throws → `failed` + `error`; a runner killed mid-op is recovered by item 4's sweep |
| 6 | **Scheduler tick** | M | 5 | `server/src/queenzee/scheduler.js` (new), registered via item 2 | claims up to `max_concurrent` ops, spawns runners, reaps exits; a runner crash never takes the tick down |
| 7 | **`reap` becomes an op** | M | 6 | `server/src/api/routes.js`, `server/src/queenzee/tasks.js`, `reaper.js` | **the §1 measurement re-run: `/health` max during a mark-done is back at the idle baseline**; `OPS_ENABLED=false` restores the inline path byte-for-byte; xell still ends `retired` |
| 8 | **Migration: `pool_config.op_priority`** | S | 3 | `db/migrations/NNN_op_priority.sql` | applies clean; column NULL on every existing row; `COMMENT ON COLUMN` names the normalizer (house style, cf. migration 121) |
| 9 | **`lib/op-priority.js`** | M | 8 | new | `test/op-priority.test.mjs`: NULL → defaults; unknown kind dropped, not thrown; `laneFor` caches 1s and **fails open to the defaults** on a db error (copy `lib/fleet-pause.js`'s shape and say so) |
| 10 | **Lanes honored: dequeue + budget + `mayTick`** | M | 9, 6 | `ops.js`, `scheduler.js`, `lib/loops.js` | `test/op-priority-scheduling.test.mjs`: a `top` op enqueued after 20 `normal` ones is claimed first; a `background` loop's tick is skipped while a `top` op is running; a `background` op waiting >15min is promoted |
| 11 | **Console: Project setup → Pool → Operation priorities** | M | 9 | `web/src/ProjectSetup.jsx`, `server/src/lib/projects.js` (`getPoolConfig`/`updatePoolConfig`) | the section renders every kind with its lane, "Reset to defaults" restores NULL, `max_concurrent_ops` saves; verified in this xell's own webapp build |
| 12 | **Console: the operations rail** | M | 6 | `web/src/` (new small panel), `routes.js` (`GET /api/ops`) | pending/running ops with lane, age, target and a cancel button; updates over SSE |
| 13–19 | **One kind per PR** (`land`, `build`, `provision`+`pool-reconcile`, `backup`+`restore`, `ship`+`seed`, `db-clone`+`schema-catchup`, the four background kinds) | M each | 7 | per §5.2 | for each: the gate's answer is unchanged (§4 table), the inline fallback flag works, item 1's allowlist shrinks by that entry |
| 20 | **Worker entrypoint + gateway strip** | L | 13–19 | `server/src/queenzee/index.js` (new), `server/src/index.js`, `package.json` | `npm run queenzee` boots the loops and takes the lock; `npm run server` boots routes only and takes **no** lock; two workers → the second exits loudly (existing behaviour, re-verified) |
| 21 | **`/internal/*` + event fan-out** | L | 20 | `server/src/queenzee/internal-api.js` (new), `server/src/lib/events-client.js` (new) | with both up, the console's SSE stream and terminal log are indistinguishable from today; kill the worker → console still serves reads and shows `queenzee offline`; the gateway 404s `/internal/*` with the named sentence |
| 22 | **Compose + deploy** | M | 21 | `docker/zeehive/docker-compose.prod.yml`, `docker-compose.bootstrap.yml`, `docker/zeehive/README.md` | a `queenzee` service from the same image; a **server ship recreates one container** (the rule `docker-compose.prod.yml:63` already states); cold bootstrap verified |
| 23 | **`QUEENZEE_INPROC` escape hatch** | S | 20 | `server/src/index.js` | with it set, one process behaves exactly as pre-split (the documented way back, and the host-process deploy path) |
| 24 | **Phase 6: live turns into runners** | L | 21 | `queenzee/intake.js`, `op-runner.js` | a queenzee restart no longer kills a live host-side turn; `setZeeMode` still applies mid-turn through `/internal/live/*` |

**Suggested first cut for a builder crew:** items 1–7 as one activity ("the queue, proved on reap"),
8–11 as a second ("priorities an operator can set"), 12–19 as a third, 20–23 as a fourth. Item 24 is
its own ticket.

---

## 10. What I am least sure about

1. **`background` loop yielding may be the wrong lever.** Skipping ticks while a `top` op runs is
   cheap and legible, but the loops are not where the compute goes once the ops move out — the runners
   are. If measurement after Phase 3 shows loop ticks are noise, drop the `mayTick` half and keep
   lanes as pure queue ordering. *That would simplify the model and I would take it.*
2. **One process per op** costs ~150ms of node boot plus a pg connect. Fine for seconds-to-minutes
   work; wrong if a kind ever becomes high-frequency. The registry's `timeout_ms` per kind is the
   place a future "run this one in-worker" flag would go — I have not built that seam, on purpose.
3. **Cross-project fairness.** Lanes are global; a `top` op in project A beats a `normal` op in
   project B. With one real project this is right. What would change my mind: a second busy project
   whose `normal` work visibly starves — the fix would be per-project concurrency reservations, and
   the `project_id` column is already there for it.
4. **Whether `dispatch` should default to `top`.** A human waits on a dispatch exactly as they wait on
   a mark-done. I left it `normal` because it competes with `reap` for the same slot and because the
   operator's stated policy was reaping. One flip in project settings changes it, which is the point
   of putting it in settings at all.
