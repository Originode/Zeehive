# Decision record: splitting the gateway from the loops, and operation priorities

**Date:** 2026-08-05
**Author:** Architect (xell `design-split-api-gateway-from-queenzee-confi-73130e`)
**Status:** DESIGN — proposed, nothing built. Supersedes nothing.
**Specs:** [queenzee-gateway-split.md](queenzee-gateway-split.md) ·
[queenzee-operation-priorities.md](queenzee-operation-priorities.md)

Six decisions. Each was hard to *make* (not hard to implement), and each has an alternative that will
be proposed again by someone who does not know it was considered.

The world all six were made in: **one node process** serves 295 routes, drives 15 `setInterval` loops,
owns every live agent turn and runs `spawnSync` inside request handlers. Measured in a cxell against
the real server: one `POST /api/xells/:id/reap` froze `GET /health` for **1179ms** and `GET /api/fleet`
for **1220ms** — with every background loop switched off, on a two-commit scratch repo, with no docker
involved. That was the cheapest reap possible; the timeout ceilings on the same class of call are 120s
(`reaper.js:305`), 600s (`provision.js:765`) and **1800s** (`xell-db.js:406`) — a design-maximum
single-call freeze of **thirty minutes**. And it is not only slow: `hooks/land-gate-update.sh` gives
the API ten seconds and **fails closed**, so a busy queenzee declines pushes a human approved.

The repo has paid for all of this before, twice, and fixed it locally both times (`lib/git.js:19`:
*"/api/fleet at 30-90s while the DB sat idle"*; `landgate.js:895`: the approve-and-nothing-happens
self-deadlock). These six decisions are about the structure that keeps producing it.

---

## DR-1 — The API and the loops become two processes from one image

**Decision.** `server/src/index.js` keeps express, SSE, the terminal websocket and the routes.
A new `server/src/queenzee/index.js` runs the loops, the op scheduler and the live-turn handles, and
holds the single-queenzee advisory lock. Same image, two commands, two containers.

### Options considered

**A · Two processes, one image *(chosen)*.** For: the meta-DB is already the shared truth, so most
routes need no new plumbing at all; a frozen worker can no longer freeze the console; each process
gets its own pg pool; the deploy stays one image and one build; and the split is undoable with a flag
(`QUEENZEE_INPROC=true`) rather than a revert.

**B · Keep one process; convert every `spawnSync` to async.** For: no IPC to design, no deploy change,
and the repo has already done this once and documented it (`lib/git.js: gitAsync`). *Rejected because
it was measured and it is not enough:* under identical load (240 real git calls per 6s tick through
this repo's own `lib/git.js`), making those calls **async but in-process** still left a **568.7ms**
`/health` tail, while moving the API to a separate process on the same box under the same load
brought the max from **1437.7ms to 58.9ms** — a 24× tail improvement from the boundary alone.
*(Measured by a sibling architect xell and reported through my manager; I did not re-run it. My own
in-cage measurement of the reap path is in §1 of the spec.)* De-syncing is **necessary but not
sufficient**: the callbacks, the stdout and the pg work all come back to the one loop. On top of
that it is 57 conversions concentrated in the most destructive paths in the system (teardown,
provision, cxell delivery) with no harness that proves a converted teardown still tears down; it
leaves the API and the loops sharing one CPU and **one 9-connection pg pool** with no timeout; and it
produces no queue, so the operator's priority ask (DR-5) has nothing to schedule.

**C · `node cluster` — N workers behind one port.** For: no route changes at all, and OS-level
parallelism for free. *Rejected because:* the loops are not safe to run N times — the advisory lock in
`index.js:78` exists precisely because two drivers reconcile against each other (three were once alive
for a day). So one worker holds the lock and still serves its share of requests: **1/N of console
requests still freeze**, unpredictably, which is worse to diagnose than all of them freezing. And SSE
fan-out across cluster workers needs the same cross-process channel this design has to build anyway.

**D · `worker_threads` for the loops.** For: one process, one deploy, and a shared-memory event bus.
*Rejected because:* the blocking work is `child_process` + git + docker — spawning is not made
cheaper by a thread, so the only gain would be isolation, and a thread gives *worse* isolation than a
process here: the SDK's live turn handles and the pg clients are not thread-shareable, and the
process-level `unhandledRejection` backstop (`index.js:41`, written after a 25-minute outage) does not
extend across threads.

**E · A read-only API replica in front, writes through to the queenzee.** For: cheapest possible
console fix. *Rejected because:* the console's hot paths write constantly (claim, dispatch, decide,
pause, nudge), so the replica would proxy most traffic straight back into the frozen process.

### The lock is the boundary — "a queenzee" vs "THE queenzee"

The clearest statement of this decision is one line of code that does not move: the gateway takes
**no** advisory lock, and the worker takes the one that exists today (`index.js:78`, key
`715533001`). That lock is about driving a fleet — two loop-runners on one meta-DB reap each other's
xells — and has never had anything to do with serving HTTP. Because the two jobs are one process,
ZEEHIVE currently cannot express *"I am **a** queenzee API instance"*, and the fleet pays for it: a
xell bound to the shared dev database can never start its own server (the live queenzee holds the
lock), it restart-loops for 90s at a time, and `zee build server --wait` can still report "UP and
serving your HEAD" while the port refuses connections. After the split an API instance is startable
anywhere, any number of times. This decision does not *fix* that ticket — it is the structural reason
the ticket exists.

### Consequences

*Easy:* the console stays responsive while the fleet churns; the gate path stops being starvable —
`hooks/land-gate-update.sh` gives the queenzee 10 seconds to answer `/api/land/check` and **declines a
human-approved push** otherwise (`landgate.js:895` documents the self-deadlock that produced), so this
is a correctness fix and not only a latency one; the worker can be restarted without dropping a
human's session or the SSE stream; two pg pools; a self-ship can restart the worker while the console
stays up (today it goes dark).
*Hard:* five pieces of in-process state now need a channel (DR-4); the deploy grows a service and the
prod compose file must keep its "a role ship touches ONE container" rule; a host-process deploy needs
a supervisor or `QUEENZEE_INPROC=true`.
*Impossible:* a route can no longer call a queenzee function and use its return value in the same
request. That is the point, and it is the thing that will feel expensive during Phase 3.

### Reversibility

`QUEENZEE_INPROC=true` makes the gateway start the loops in-process, exactly as today — one import,
one call. That flag stays until Phase 7 deletes it, so the split is a **two-way door for as long as it
matters**. What is one-way: once compose has two services and prod runs them, going back means a
deploy change under a live fleet, not just a flag.

### What would change our mind

If Phases 1–3 (queue + runners) alone bring the measured `/health` max during a mark-done back to the
idle baseline **and** loop ticks measure as noise, the process split is optional and can be deferred
indefinitely. The queue is the load-bearing decision; the split is the second one.

---

## DR-2 — Heavy work is a row in the meta-DB, not a message

**Decision.** A new `queenzee_op` table holds one row per heavy operation (kind, args, lane, status,
attempts, heartbeat, result). Enqueue is an INSERT; claiming is `UPDATE … FOR UPDATE SKIP LOCKED`.

### Options considered

**A · A table in the meta-DB *(chosen)*.** For: it is the one durable store every part of this system
already trusts, and every gate is already a row there; it survives a restart, which is the difference
between "the reap is queued" and "the reap vanished"; it is visible to the console and to `zee status`
with no extra channel; and a stored `lane` gives the priority model somewhere to live and something to
be audited against.

**B · An in-memory queue in the worker.** For: no migration, no SQL, microseconds. *Rejected because:*
it is invisible to the gateway, which must accept the work and report its status; and it is lost on
restart — a mark-done that evaporates leaves exactly the stranded `tearing-down` xells that
`recoverOrphanTeardowns` (`index.js:132`) exists to clean up after. We would be re-creating a failure
the code already has a janitor for.

**C · Redis / BullMQ / a real broker.** For: priorities, retries, delayed jobs and a dashboard, all
mature and none of it written by us. *Rejected because:* it adds a runtime dependency to the deploy
(a container, a persistence story, a backup story, a failure mode) for a queue whose realistic depth
is tens of rows; and it creates a **second source of truth** about the same facts — "is this xell being
torn down" would live in Redis while `xell.status` lives in postgres, and the fleet's whole design is
that the meta-DB answers that question.

**D · Reuse the existing `task` table.** For: it exists, it has a status vocabulary and the console
already renders it. *Rejected because:* `task` is the **human work intake** (a prompt, a zee, a
human's done gate) and the board renders it as such. A reap appearing on the board as an assignment
would be a lie in the one place humans look to see what is being worked on.

### Consequences

*Easy:* cancel, retry, dedupe, audit, "why did this run when it did", and a console rail — all of them
are ordinary SQL. Orphan recovery copies three existing recoveries in `index.js`.
*Hard:* one more table to migrate, and a polling scheduler (1s tick) rather than an instant wake — a
`top` op waits up to a second before it starts. A `pg_notify` wake is the named optimization we
deliberately did **not** build; one second is not the problem we are solving.
*Impossible:* sub-100ms dispatch of background work. Nothing in this system needs it.

### Reversibility

The table is additive. Backing out is "stop writing to it" (`OPS_ENABLED=false`), and the inline call
paths remain until Phase 7. Dropping the table later is a one-line migration with no data anyone reads.

### What would change our mind

Queue depth persistently in the thousands, or a kind that needs sub-second start latency. Neither is
plausible at this fleet's size; both would be visible in the ops rail before they hurt.

---

## DR-3 — One short-lived child process per operation

**Decision.** The worker never executes an operation itself. It spawns
`node server/src/queenzee/op-runner.js <op_id>`, which runs one op and exits. Inside a runner,
`spawnSync` stays legal.

### Options considered

**A · A child process per op *(chosen)*.** For: it bounds the damage a blocking call can do to exactly
one process that nobody is waiting on; it means the refactor **moves call sites instead of rewriting
them**, so a teardown's 200 lines of hard-won `spawnSync` behaviour is not rewritten under a fleet
that depends on it; it gives an op a pid, a kill, a timeout and a crash boundary; and OS scheduling of
N runners is what makes `max_concurrent_ops` a real lever rather than a label.

**B · Run ops asynchronously inside the worker.** For: no spawn cost, no IPC, one process to reason
about. *Rejected because:* it re-creates the freeze one layer down — a frozen worker cannot answer its
own `/internal/*`, so the five live-state calls the gateway forwards would stall exactly as console
requests do today; and it still requires converting every `spawnSync` (DR-1's B cost), which is the
expense the child process is bought to avoid.

**C · `worker_threads` per op.** For: cheaper than a process, shared memory for progress. *Rejected
because:* almost every op's real work is spawning *another* process (git, bash, docker), so a thread
buys nothing over a child; and a thread that crashes takes the worker with it.

**D · A pre-forked pool of persistent runners.** For: avoids ~150ms of node boot per op. *Rejected
because:* it is a saving of 150ms on jobs that take seconds to hours, paid for with the exact bug
class we are escaping — leaked state in a reused process (a stale docker context, an open pg client,
a memoized cache from the previous op's project).

### Consequences

*Easy:* per-kind timeouts (several of these paths today have a `spawnSync` timeout but no op-level
one, so a wedged docker context is a permanent invisible stall); cancel = kill; a crashed op is
`failed` with a reason instead of a dead orchestrator.
*Hard:* logs must be piped from runner → worker → logbus → SSE, which is one more hop for the build
feed; and a runner needs the same mounts as the worker (repos, ssh keys, docker socket) — it is a
child of the worker, so it inherits them, which is why the runner is **not** its own container.
*Impossible:* an op sharing an in-memory handle with the worker. `dispatch` (a live turn) is the one
kind that needs to, and it gets an explicit IPC channel in Phase 6.

### Reversibility

Per-kind: the inline path stays behind a flag until Phase 7. A kind can be moved back to inline
execution one flag at a time.

### What would change our mind

If runner boot ever measures as a meaningful fraction of op duration for a kind we care about, that
kind gets an "in-worker" bit in `lib/op-kinds.js`. The registry is the seam; we are not building the
framework behind it now.

---

## DR-4 — State crosses on the meta-DB; five live things cross on a loopback HTTP the gateway PULLS

**Decision.** Everything the gateway needs, it reads from the meta-DB. The five things that cannot be
rows — the event bus, the log ring, live-turn handles, the backup AbortControllers, harness bridges —
are reached through six `/internal/*` endpoints on `127.0.0.1:4701`, and the gateway **subscribes** to
the worker's event stream rather than the worker pushing to it.

### Options considered

**A · meta-DB + loopback HTTP, pull direction *(chosen)*.** For: one mechanism for the five live calls
*and* the event stream; the gateway can restart without the worker knowing or buffering; auth is a
shared token on a loopback socket; and when the worker is down the gateway degrades to "DB reads work,
live controls say `queenzee_offline`" — which is honest and strictly better than today's dead console.

**B · Postgres `LISTEN`/`NOTIFY` for the event fan-out.** For: no HTTP, no token, no new listener; the
DB is already shared; it is the obvious postgres answer. *Rejected because:* it carries **events only**,
so the five live-handle calls would still need HTTP — two mechanisms instead of one, and the second one
is the harder one. It also has a hard 8000-byte payload limit while a ship streams whole docker build
lines through `logbus`, and a dedicated `LISTEN` connection is one more client on a pool of ten. Kept
in the back pocket as the wake-up nudge for DR-2's 1s poll, where the payload is a single id.

**C · The worker pushes events to the gateway.** For: no long-lived outbound connection; the worker
already knows when something happens. *Rejected because:* the worker would have to know how many
gateways exist and buffer for one that is restarting — a registration protocol we do not otherwise
need. Pull makes a gateway restart a non-event.

**D · A shared file or unix socket for the log ring.** For: no HTTP for the biggest payload.
*Rejected because:* two containers have no guaranteed shared filesystem, and it duplicates a channel
we already have to build for the other four things.

### Consequences

*Easy:* `/api/stream` and the console terminal are unchanged; `setZeeMode` already treats "no live
control channel" as a first-class answer (`intake.js:904`), so the degraded path is code that already
ships.
*Hard:* a third listener now answers HTTP in this system, and `CLAUDE.md §1` already warns that two
servers answering the same paths is a trap zees fall into. Mitigation is explicit: `/internal/*` binds
to loopback only, and the **gateway 404s `/internal/*` with a sentence that names which server you are
talking to**.
*Impossible:* a gateway that serves live-turn control while the worker is down. That is honest — the
handle only exists there.

### Reversibility

`QUEENZEE_INPROC=true` (DR-1) removes the channel entirely by removing the boundary.

### What would change our mind

If the SSE relay measurably drops frames under load, the events move to `LISTEN`/`NOTIFY` with the
payload reduced to `{type,id}` — which is what `broadcast()` mostly already sends.

---

## DR-5 — Priorities are three lanes plus one number, stored in `pool_config`

**Decision.** `pool_config.op_priority jsonb` = `{ lanes: {<kind>: 'top'|'normal'|'background'},
max_concurrent_ops: int }`. NULL means the built-in defaults. One normalizer
(`server/src/lib/op-priority.js`), served effective, edited in Project setup → Pool. `reap` defaults to
`top`.

### Options considered

**A · Three lanes + `max_concurrent_ops`, in `pool_config` *(chosen)*.** For: `pool_config` is where
every other project knob already lives, and `spawn_prep` (migration 121) has already settled the exact
pattern — NULL means default, one normalizer, effective view with server-defined presets, a Pool-tab
editor. A lane is legible in a sentence and has three real mechanical meanings (dequeue order, a
reserved slot, background loops yielding). A pattern used here already is a decision that has been made.

**B · A numeric priority (0–100) per kind.** For: expressive, orders naturally, and every queue library
already speaks it. *Rejected because:* it is unfalsifiable for the operator who has to set it — nobody
can defend 80 over 90 for a reap — and a number cannot express the two things the operator actually
asked for ("give it a slot of its own", "make the janitor get out of the way"). It converts a policy
into a tuning parameter, and tuning parameters get set once and never revisited.

**C · Per-xell or per-operation priority.** For: the finest possible control, and an operator could
rush one specific job. *Rejected because:* there is no moment in the console where a human would set
it — an op is created by a click, not by a form — so the control would have to be exercised *after*
enqueue, on a screen that does not exist. And the ask was project settings.

**D · A normalized `op_priority` table (project × kind rows).** For: queryable, easy to extend with
per-kind columns later, no jsonb. *Rejected because:* it puts a join on the enqueue hot path; it has
no natural representation of "this project has never been configured" (you would insert 16 rows per
project, or teach every reader that a missing row means default anyway — i.e. reinvent NULL); and it
diverges from the settled `pool_config` pattern for no benefit at this size.

**E · Fleet-wide env vars.** For: simplest possible; matches how loop intervals are configured today.
*Rejected because:* changing a scheduling policy would require a redeploy of the queenzee, and the ask
was explicitly project settings — a fleet with one busy project and one quiet one needs two answers.

### Consequences

*Easy:* an operator can say "reaping first" and see it happen; the defaults encode the stated policy;
a new kind needs no data migration (absent = its built-in default).
*Hard:* the lane is stored on the op row, so a settings change does not reorder work already queued —
which is correct, and which the settings screen must say out loud or it will read as a bug.
*Impossible:* expressing "this kind is more important than that one *within* a lane". If that is ever
needed, the answer is `enqueued_at` or a fourth lane, and both are worse than they sound.

### Reversibility

"Reset to defaults" writes NULL, from the console, in one click. `OP_PRIORITY_ENABLED=false` forces
plain FIFO. The column is additive and can be dropped later with nothing to migrate.

### What would change our mind

Operators asking for a fourth lane, or a project whose `background` work never runs despite the 15-min
aging rule. Either says the model is too coarse — and the fix would be per-lane concurrency, not a
priority number.

---

## DR-6 — A gate's DECISION stays synchronous; only the work after it becomes an op

**Decision.** `decideLandRequest`, `decideShip`, `decideProdBind`, `markTaskDone`, and every refusal a
zee verb can receive, stay synchronous row reads/writes in the gateway. The execution that follows an
approval (the push, the deploy, the reap, the seed) becomes an op.

### Options considered

**A · Decisions synchronous, execution queued *(chosen)*.** For: every documented promise to a caller
survives untouched — `zee land` still answers held/queued/stale, `zee ship` still answers
`refused:true` and exits 1, a rejection still frees the runway instantly. The gates are already rows
and human decisions; nothing about the human-in-the-loop changes. And the decision path does no
blocking work, so it belongs in the gateway on the merits.

**B · Everything is an op, decisions included.** For: one uniform path, one place to reason about
ordering, and a human's approval would be visible in the ops rail like everything else. *Rejected
because:* it changes what a click means. "Approve" would answer "queued for approval processing", and
a zee's `zee land` would answer "pending" where the manual promises `held` / `holding` / `stale` /
`refused` — the cxell manual is explicit that a refused ship must say so *in the answer*, because a
zee that reports "waiting for your approval" when nothing was created sends a human to an empty
console. That sentence was earned; a queue in front of the verdict un-earns it.

**C · Leave execution synchronous too.** For: no change at all. *Rejected because:* it is the measured
bug — a human's "Mark done" click freezes the entire console for as long as a despawn script takes,
which is up to 120 seconds.

### Consequences

*Easy:* the gate code and its tests barely move; the reviewer's checklist for Phases 3 is three lines
(§4 of the spec).
*Hard:* two places now know about one action — the decision (row) and the op. They must agree, and the
rule is written down: **the gate table is authoritative; the op's `result` is a fact about the op, not
a verdict.**
*Impossible:* an approval that is also its own receipt of completion. The console must follow the op
to know the push landed — which is what it already does through SSE.

### Reversibility

Per-kind flags (DR-3) restore inline execution behind an approval without touching the decision path.

### What would change our mind

Nothing short of a gate whose *verdict* genuinely requires host work. `ffState()` (3× sync git) is the
closest — it is a landability check inside the approval. It moves **into the `land` op**, and the
approval's answer stops claiming to know the push outcome. If that turns out to be information a human
needs at click time, the check gets a fast read-only path, not the gate a queue.
