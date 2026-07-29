# The work tracker — the verbs: assignment, deploy, and the board that moves itself

**Status:** parts 2–3 of the work tracker, landed and in production. This document was
**reconstructed from the landed code** after its original author's xell was reaped with the text
still in it — every claim below is either read directly from the source named beside it or
exercised against a running server (see *How this was verified*).

The nouns are part 1's and live in [work-tracker.md](work-tracker.md): tickets, the work-item
hierarchy, the board and gantt read models, and the five policies. **This file is the verbs** — what
puts a zee on an item, what briefs it, and what moves the card afterwards.

| what | where |
|---|---|
| the domain (assign · unassign · deploy · candidates · report) | `server/src/lib/work-assign.js` |
| the board moving itself | `server/src/queenzee/worksync.js` |
| the cxell verbs (`zee work` · `zee assign` · `zee item`) | `server/src/queenzee/self.js` + `scripts/zee` |
| the manuals that make the verbs reachable | `db/migrations/059_work_tracker_verbs.sql` |
| the HTTP surface | `server/src/api/routes.js` |

## The shape

```
ticket ──breakdown──▶ work_item ──assign / deploy──▶ a zee in a xell
                          ▲                               │
                          └────── worksync tick ──────────┘
                             (the card follows the zee)
```

Part 1 ends at the work item. These verbs carry it the last step — onto an agent — and then keep
the board honest without anybody dragging a card.

## What it borrows rather than restates

`work-assign.js` deliberately reuses part 1 instead of growing a parallel dialect, and this is worth
knowing before changing either file:

- **the status vocabulary** — `isTerminal` / `canTransition` / `nextStatuses` / `statusFromHive`
  from `work-status.js`. `TERMINAL` is *derived*, never a second hardcoded list;
- **the transaction** — `inTransaction` + `dbRunner`, so an assignment writes the item, the zee's
  task stamp and the audit event as one unit, and broadcasts only after the `COMMIT`;
- **the audit vocabulary** — `logWorkEvent` with part 1's kinds (`assigned` · `status` · `comment`).
  No new event kind exists: *un*-assigning is an `assigned` event whose `detail` says
  `unassigned: true`;
- **the zee chip** — `liveZees()` verbatim, so the hive status on a card is the one the hexagon
  shows;
- **the id contract** — `assertId`: malformed → 400 naming the field, well-formed but unknown → 404.

## The HTTP surface

| method | path | what |
|---|---|---|
| `POST` | `/api/work-items/:id/assign` | link an **existing** xell (`{xell_id, actor?}`) |
| `DELETE` | `/api/work-items/:id/assign` | take the zee off; **the status is left alone** |
| `POST` | `/api/work-items/:id/deploy` | **dispatch a fresh worker** for this item and assign it |
| `GET` | `/api/work-items/:id/candidates` | who could take it — so a picker offers xells, not a uuid box |
| `GET` | `/api/xell/self/work` | `zee work` — token-scoped |
| `POST` | `/api/xell/self/work/assign` | `zee assign` — **manager only** |
| `POST` | `/api/xell/self/work/item` | `zee item` — token-scoped |

**Error contract.** `work-assign.js` tags its own refusals with an explicit `err.status`
(`400` you asked wrong · `404` it does not exist · `409` it exists and the answer is still no), and
`routes.js` honours it via `assignErr()`. Anything thrown out of `work-items.js` still falls through
to part 1's sentence-matching `workErr()`. *(This is the explicit-status mechanism part 1's own
routes do not yet use — see the follow-up note at the end.)*

## assign — link an existing xell

`POST /api/work-items/:id/assign  {xell_id}`

It is **idempotent, and self-healing with it**: assigning the xell already on the item returns
`already: true` and still completes the `queued → assigned` move if a previous attempt died between
the two writes.

Only `queued → assigned` is performed. An item already `working`/`blocked`/`review` is further along
than this verb knows, and a terminal item has been decided by somebody.

### The refusals — all verified live

| you tried | answer |
|---|---|
| no `xell_id` | **400** `assign needs a xell_id — the xell to put on this work item.` |
| malformed `xell_id` | **400** `"nope" is not a valid xell id` |
| well-formed, unknown | **404** `no xell … — it may already have been reaped.` |
| a `retired` / `tearing-down` xell | **409** — it is gone or being torn down, so its worktree is going away and anything unlanded with it |
| a xell in **another project** | **409** `… belongs to a different project than this work item.` |
| **production** | **409** `… IS production. Production is not a worker: it is the thing the work ships to.` |
| a **manager** zee | **409** `… is a MANAGER zee … it cannot execute a work item — it DISPATCHES a worker for one.` |
| a xell **already on an open item** | **409** `One zee, one item — unassign that one first … or pick another xell.` |

The checks run in that order, which matters for one case: a **production xell that also sits in
another project reports the project refusal**, because the project check comes first. (Verified both
ways — the production sentence appears when the production xell is in the *same* project.)

## unassign — back to being plan

`DELETE /api/work-items/:id/assign`

Clears `work_item.xell_id`, clears the `task.work_item_id` stamp, and writes an `assigned` event
with `unassigned: true` and `status_kept`.

**It deliberately does not change the status.** An item that reached `working` did so because work
happened; taking the zee off does not un-happen it, and guessing a status backwards would overwrite
the one thing the history is for. Verified: an item at `working` is still `working` afterwards, with
`zee: null` and `xell_id: null`. Unassigning nothing returns `already: true`.

## deploy — dispatch a worker briefed from the item

`POST /api/work-items/:id/deploy  {task?, model?, mode?, harness?, title?, manager_xell_id?}`

This is the verb that makes a well-cut plan pay: rather than "dispatch, then assign by hand",
everything the item already knows reaches the worker automatically. `briefForWorkItem()` (pure and
exported, so it can be read and tested without dispatching anything) builds the brief from the
item's **title, body, ancestor chain, linked ticket — including the ticket's own body, fetched
specially because the card's ticket shape carries none — dates and priority**, plus whatever extra
`task` text the caller adds.

Who dispatches decides which guards apply, and **both are existing paths, never a second one**:

- `manager_xell_id` → `selfDispatch` (the manager's own dispatch: the worker is stamped as its crew,
  seated beside it, and a manager still cannot hand it prod, the manager type or the manager harness);
- otherwise → `dispatchXell` (the console's ordinary dispatch).

Then it calls `assign` for the new xell and writes an `assigned` event with `deployed: true`.

Two refusals happen **before** anything is dispatched (verified live):

- the item is **terminal** — **409** `… is done — deploying a zee onto a finished item would spend a
  whole worker on work somebody has already decided is over. Reopen it first if that is wrong.`
- the item **already has a live zee** — **409** `… is already deployed on "…". Talk to it, or
  unassign it first — deploying again would spawn a second zee onto the same job.`

If the dispatch returns no xell, it raises **500** with the raw answer quoted, rather than leaving
the item silently unlinked.

## candidates — so a picker offers a choice that works

`GET /api/work-items/:id/candidates`

Two populations, both **in this item's project**: the **ready pool** (`from_pool: true`, offered
first) and **live workers with no open item**. Excluded: production, managers, anything
`retired`/`tearing-down`/`error`/`husk`, and any xell already carrying an open work item —
*including the one already on this item*, which cannot "take" what it is already doing. Each row
carries a `why`. With nobody available, `note` points at `deploy`.

> **A real-hive caveat, found while verifying this.** A `ready` xell only appears if the queenzee's
> pool has not already trimmed it: `pool.ensureReady()` treats a project with no `pool_config` row
> as `target_ready = 0` and reaps surplus ready xells within a tick (~15 s). My first candidates call
> returned only the live workers because the pool had retired the ready fixture in between. This is
> the same race that makes `test/work-assign.test.mjs` flaky roughly 1 run in 10.

## The board moves itself — `queenzee/worksync.js`

A kanban board a human has to drag is a board that is wrong by lunchtime. Every item with a zee on
it already has a truth: what that zee's hexagon says right now.

```
work_item.xell_id → liveZees() → hive status → statusFromHive() → the card's status
```

A 30 s tick (`WORKSYNC_INTERVAL_MS`, first run 15 s after boot, disabled with
`WORKSYNC_ENABLED=false`). Every move is written with actor **`queenzee`**, so an item's history
reads honestly as "the board moved itself" and is never mistaken for a human's judgement. Failures
are isolated per item so one bad row cannot stop the sweep, and a meta-DB with no work tracker at all
is skipped quietly rather than logged every 30 s.

### The fence — the load-bearing decision of that file

The tick may only move an item **between the in-flight statuses**. `IN_FLIGHT` is *derived* from the
vocabulary (verified: `assigned, working, blocked, review, shipping`), so a new status is picked up
or excluded without a second edit — and the fence cannot be widened by accident.

| the tick will never | why |
|---|---|
| move an item to `done` or `cancelled` | **finishing is a decision**, and this repo gives decisions to humans. Worse, the signal is not evidence: `statusFromHive` maps `occ-done`/`occ-doneRequest` to `done`, and both mean a xell being torn down *or asking to be* — which says nothing about whether the work is complete |
| move an item **out of** a terminal status | once a human has decided, no tick un-decides it |
| move a `queued` item | it has not started; that is what assignment is for |
| touch an item with no xell | no zee, no fact — it stays plan |
| make an illegal transition | `canTransition` is checked as well |

Verified by driving the tick directly, with a live working zee on the item throughout:

```
item done      → {scanned:1, moved:0}  still done
item queued    → {scanned:1, moved:0}  still queued
item assigned  → {scanned:1, moved:1}  now working
```

### When the zee is gone

If the assigned xell is `retired` (or its row has vanished) the tick **notes it in the ledger and
changes nothing else** — not the status, and **not the link**:

> `xell_id` is HISTORY. Liveness is resolved at READ time, never by nulling the column.

That is [policy 4](work-tracker.md) and this is where the guard belongs. `liveZees()` already filters
retired/husk/error and `hiveStatus()` answers `null` for a retired row, so a stale id cannot lie to
anybody — the read models hand a dead xell's card `zee: null, live_status: null`. A second guard at
*write* time would be the cache invalidation that policy warns about (missed by `purgeDevXells`, by
`recoverOrphanTeardowns`, by a hand-edited row) and it would cost the board its provenance: which
agent was actually on this work.

A `husk`/`error` xell is left **completely** untouched — it is awaiting housekeeping and may yet come
back, and `liveZees` already refuses to speak for it. Only `retired`-or-vanished counts as gone.

The note is written **once per dead xell**, not once per tick — idempotency is keyed on the xell id
inside the event's `detail`, so a later re-assignment to a different xell that also dies gets its
own entry. Verified:

```
tick 1 → {scanned:1, moved:0, noted:1}   status kept 'working', xell_id kept, 1 ledger event
tick 2 → {scanned:1, moved:0, noted:0}   (not a stutter every 30s)
tick 3 → {scanned:1, moved:0, noted:0}
```

The event is `kind: 'assigned'` with `detail: {zee_gone: true, xell_id, xell_slug, reason, status_kept}`.

## The three cxell verbs

A verb that is not in the manual does not exist to a zee — which is why **migration 059** patches the
two manuals (surgical, idempotent, anchored replacements, exactly as 053): the **manager** manual
(`manager` harness, also file-backed at `harnesses/manager/memory/manager-zee-manual.md` — edit both
or they drift) and the **worker** manual (`zee-base`, DB-owned, so the migration is the only way to
change it).

**Scope is resolved from the TOKEN, never from a parameter.** A manager may touch any item in *its
own project*; a worker may touch *only the item it is assigned to*. The caller does not get to say
which xell it is. Nothing here is a new gate or a way round one.

### `zee work` — the plan you are part of *(any zee)*

- **manager** → its project's plan in **tree order** (depth-first — `listWorkItems` returns
  breadth-first by depth, so `workItemTree` re-orders it), each item with its status, assignee, live
  `zee` and advisory `live_status`. `--board` drops the project root (a root is not a card).
- **worker** → the one item it is assigned to, with the ancestors, ticket and history it was briefed
  from. Resolved by `itemForXell`: its own `work_item.xell_id` first, falling back to the stamp on
  its newest task, **an open item always beating a finished one**.
- `--item <id>` reads one item, scoped the same way.

Verified: a manager token gets `{view:'tree', count:3, items:[…]}`; a worker token with no arguments
gets its own item; a worker asking for an item that is not its own is **refused with a sentence**
(`that is not the work item you are assigned to…`); a worker with no item at all gets
`item: null` and an explanation, not an error.

### `zee assign --item <id> --task "…"` — deploy a worker *(MANAGER only)*

`selfWorkAssign` → `deployWorkItem` with `managerXellId`, so it is the manager's own dispatch path
with the item's brief attached. Refused for a worker (`\`zee assign\` is a MANAGER verb and this
xell's type is 'worker'…`), refused without `--item`, and refused for an item in another project
(*"you may only deploy workers onto YOUR project's plan"*). All verified.

### `zee item [--status --progress --note]` — report where the work got to *(any zee, scoped)*

A report of **fact**, not a gate: it moves the card and nothing else. A worker may omit the id — the
server resolves it from the token. Legal transitions are `work-status.js`'s answer, not this file's;
an illegal one is refused with the legal list.

**Setting `done` is allowed** — the zee is the one who knows the work is finished — and it
deliberately does **not** touch the xell's own done/land/ship state. Verified end to end: a worker
reported its item `done`, the item became `done`, and its xell stayed `working` (not
`awaiting-done`). A verb that quietly proposed done for the xell would be exactly the bypass this
repo refuses.

Writes are one transaction: a status change logs a `status` event; a note without a status change
logs a `comment` event; `progress` rides along.

## How this was verified

Against a real server built from this branch (`zee build server --wait`), over HTTP, using tokens
minted for throwaway xells in a throwaway project of my own database — a worker, a spare worker, a
manager and a pool xell. Exercised: candidates (both populations), assign (happy path, idempotent
re-assign, and **all eight refusals**), unassign (status preserved, and the no-op), deploy's two
pre-dispatch refusals, all three cxell verbs including every scoping refusal, and the worksync tick
driven directly through its fence and its dead-zee branch.

**Not exercised, and therefore stated only as read from the source:** a *successful* `deploy`
(it spawns a real agent; the attempt was made and correctly got as far as
`no ready xell available for headless spawn`, so the pre-dispatch path is confirmed and the spawn
itself is not), and the exact brief text `briefForWorkItem` produces.

All fixtures were removed afterwards.

## Follow-ups this reconstruction surfaced

1. **`work-assign.js` tags refusals with an explicit `err.status`; `work-items.js` still does not** —
   part 1's `workErr()` classifies by *matching the message text*, so the wording of its refusals is
   load-bearing prose. Part 3 got this right. Part 1 should adopt the same mechanism.
2. **`test/work-assign.test.mjs` is flaky ~1 in 10** — its `ready` fixture races the queenzee's pool
   trim. Its throwaway project should claim a `pool_config` row with `target_ready >= 1`.
3. **The original of this document was lost with its author's xell.** Docs that exist only inside a
   cxell die with it; land the doc in the same commit as the code it describes.
