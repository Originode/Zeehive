# The work tracker, part 3 — putting a ZEE on a work item

> **Where this belongs.** This is the part-3 half of the work-tracker write-up. It was written while
> part 1 (`db/migrations/058_work_tracker.sql`, `server/src/lib/work-items.js`,
> `docs/work-tracker.md`) was still held at the landing gate, so it lives in its own file rather than
> as an add/add conflict on `docs/work-tracker.md`. **Fold it into `docs/work-tracker.md` and delete
> this file** the moment part 1 is on main — it is one section, not a separate document.

Parts 1 and 2 gave the hive a PLAN: tickets broken down into a tree of work items (project →
activity → task, nested as deep as the job needs) with a status on each and a kanban board over
them. Part 3 is what makes the plan reach the agents, and the fleet reach the plan:

| direction | what it means |
|---|---|
| **plan → fact** | a human (or a manager zee) puts a zee ON an item — `assign`, `deploy` |
| **fact → plan** | the item then follows that zee by itself — `queenzee/worksync.js` |

Nothing here is a new gate, and nothing here is a way round one. A dispatched worker still lands its
own work through the landing gate, still ships through the ship gate, and is still marked done by a
human. What changed is only that the board knows about it.

---

## 1. Assignment — `server/src/lib/work-assign.js`

A separate module from `work-items.js` on purpose: `work-items.js` owns the PLAN's domain
(create/move/status/history) and knows nothing about the fleet; everything in `work-assign.js`
reaches into xells, dispatch and the queenzee. One module per direction keeps the plan usable with
no fleet at all, and puts every refusal in one readable place.

- **`assignWorkItem(id, { xell_id, actor })`** — links an existing xell: sets `work_item.xell_id`,
  moves `queued` → `assigned` (and *only* that transition — an item already `working` is further
  along than this verb knows), stamps the xell's newest `task.work_item_id`, writes a
  `work_item_event` `kind:'assigned'` and broadcasts `work`. Assigning the same xell twice is an
  idempotent no-op that writes no second event, so a retry after a half-failed call is safe.
- **`unassignWorkItem(id, { actor })`** — clears the link, the task stamp, and writes the event. It
  deliberately does **not** change the status: an item reached `working` because work happened, and
  taking the zee off does not un-happen it. Guessing a status backwards would overwrite the one
  thing the history exists to record.
- **`deployWorkItem(id, { task, model, mode, harness, actor, managerXellId })`** — the real verb.
  It DISPATCHES a fresh worker for the item and assigns it, through the **existing** dispatch paths
  (`selfDispatch` when a manager deploys, `dispatchXell` when the console does). There is
  deliberately no second spawn path: one here would be a hole punched straight through the manager
  layer's refusals (no prod, no manager type, no manager harness for a dispatched worker).
- **`candidatesFor(id)`** — the xells that could take this item: the ready pool plus live workers
  with no open item, in this project only. Never a manager, never production, never a xell that
  `assign` would refuse — a picker that offers a choice the server then rejects is worse than one
  that offers fewer.

### The refusals are the point

Every one is a full sentence with an HTTP code (`400` you asked wrong · `404` it does not exist ·
`409` it exists and the answer is still no), because the sentence is what a human reads:

| refused | why |
|---|---|
| a xell from another project | a xell only ever works in its own project |
| production | production is not a worker; it is what the work ships to |
| a MANAGER zee | a manager writes no code and lands none — it *dispatches* one that can |
| a xell already on another open item | one zee, one item |
| deploying onto an item that already has a live zee | two agents on one job |
| deploying onto a `done`/`cancelled` item | a whole worker spent on work somebody ended |

### The brief a deployed worker receives

`briefForWorkItem()` is pure and exported, so it can be read and tested without dispatching
anything. It folds the item's **title and body**, its **ancestor chain** (so the worker knows which
project/activity it sits under), its **linked ticket**, its **acceptance notes** ("this is what done
means here") and the deployer's extra `--task` text into one briefing — and closes with how to
report progress. This is why breaking a ticket down properly pays: a well-cut item briefs its
worker for free.

## 2. The board moves itself — `server/src/queenzee/worksync.js`

A 30 s queenzee tick (`WORKSYNC_ENABLED=false` to stop it, `WORKSYNC_INTERVAL_MS` to retune), same
shape as `queenzee/dbclone.js`. For every item with a live `xell_id`:

```
work_item.xell_id → the xell's HIVE STATUS (lib/hive-status.js, from exactly the signals
lib/fleet.js feeds it) → statusFromHive() (lib/work-status.js) → the item's status
```

**The policy, which is the load-bearing decision of the whole part:** the tick may only move an item
*between the in-flight statuses* (`assigned, working, blocked, review, shipping`). It will never

- move an item to `done` or `cancelled` — **finishing is a decision**, and this repo is built on the
  rule that a decision belongs to a human: a push is held at the landing gate, a prod deploy is a
  request the queenzee performs only once someone approves it, a zee cannot mark even itself done. A
  tick that could close a card would be the one machine in the system allowed to declare work
  finished, from a signal ("the zee looks idle") that is not evidence of anything;
- move an item OUT of a terminal status — once a human has decided, no tick un-decides it;
- touch an item nobody is on — no zee, no fact, it stays plan.

When the assigned xell is **gone** (retired, or the row deleted) the status is left exactly where it
was and only the LINK is cleared, with an event saying why: the card goes back to being plan.

Every move it makes is a `work_item_event` with `actor:'queenzee'`, so the history reads honestly as
"the board moved itself" and is never mistaken for a human's judgement.

## 3. Routes

| route | what |
|---|---|
| `POST /api/work-items/:id/assign` `{ xell_id }` | link an existing xell |
| `DELETE /api/work-items/:id/assign` | unlink (status untouched) |
| `POST /api/work-items/:id/deploy` `{ task?, model?, mode?, harness? }` | dispatch a worker for it |
| `GET /api/work-items/:id/candidates` | who could take it |

## 4. The cxell verbs (`scripts/zee` → `/api/xell/self/*`)

**Scope is resolved from the caller's TOKEN, never from a parameter.** A manager may touch any item
in its own project; a worker may touch only the item it is assigned to.

- **`zee work [--board] [--item <id>]`** — a MANAGER sees its project's plan in tree order with each
  item's status, assignee and live zee (`--board` drops the project root: a root is not a card); a
  WORKER sees the one item it is executing, with the ancestors, ticket and acceptance notes it was
  briefed from. A worker that knows which item it is executing can say so in its report.
- **`zee assign --item <id> --task "…"`** (MANAGER only) — deploys a worker for that item through
  the same path `zee dispatch` uses, so the worker is still stamped `manager_xell_id`, still seated
  next to its manager, still on its own throwaway db, and a manager still cannot hand it prod, the
  manager type or the manager harness. Returns the new worker's slug.
- **`zee item [<id>] --status <s> [--progress N] [--note "…"]`** — reports where the WORK has got
  to. Setting `done` is allowed (it is a report of fact, not a gate) and it explicitly does **not**
  touch the xell's own done/land/ship state. Reopening a terminal item is refused: that is a
  human's decision.

## 5. The manuals — `db/migrations/059_work_tracker_verbs.sql`

A verb that is not in the manual does not exist to a zee. 059 teaches both, following 053 exactly in
spirit — anchored replacements inside the manual text stored in `harness.bundle`, guarded so they are
idempotent and simply **do not fire** when an anchor has moved (a human may have edited the manual in
the harness manager, and a half-rewritten manual is worse than an out-of-date one):

- the **manager** manual — `zee work`, `zee assign`, `zee item`, plus a paragraph on what the work
  tracker is and why a manager should break a ticket down before dispatching anybody. The manager
  harness is FILE-BACKED (`harnesses/manager/`, reloaded by `refreshHarnesses()` at every boot), so
  `harnesses/manager/memory/manager-zee-manual.md` is edited in the same commit — **edit both or
  they drift**. (The test asserts the migration's output is byte-for-byte the file's text.)
- the **worker** manual (`zee-base`, DB-owned — a migration is the only way to change it) — `zee
  work`, `zee item`, and the fact that a worker may only touch its OWN item.

## 6. Tests

`test/work-assign.test.mjs` — a throwaway project in the real meta DB, everything cleaned in a
`finally`, ✓/✗ lines, non-zero exit on failure. It covers assignment and its idempotence, every
refusal and its HTTP code, unassignment keeping the status, the candidate picker, the deploy brief
and its refusals **with the dispatch path stubbed** (a test never spawns an agent), the worksync
fence in both directions, the token-scoping of the three cxell verbs, and that the routes, the CLI
and both manuals actually carry the verbs. If 058 is not applied to the target database the suite
**skips loudly** rather than pretending to pass.

---

## Reconcile-at-merge checklist (written before part 1 landed — delete once done)

Part 3 was built while `db/migrations/058_work_tracker.sql` and `server/src/lib/work-items.js` were
still held at the landing gate, and verified against a throwaway stand-in for them. Five things to
check the moment part 1 is on main — each is deliberately a single point in the code:

1. **`work-items.js`'s signatures** — `setStatus` / `emit` / `inTransaction` are called through the
   three adapters at the top of `work-assign.js` (`event`, `moveStatus`, `tx`). If one differs,
   change the adapter, not the call sites. Check in particular whether `setStatus` already writes its
   own `work_item_event` — if it does, `worksync` should not add a second one (its own `emit` there
   is what carries `actor:'queenzee'`, so keep whichever makes the history read once).
2. **The status vocabulary** — `worksync.IN_FLIGHT` and `work-assign.TERMINAL` are policy fences kept
   as explicit lists (the test pins them against the real vocabulary). If `work_status` carries
   `terminal` / `in_flight` flags, derive them from it instead and keep the test.
3. **`statusFromHive()`'s real mapping** — the fence means no mapping can produce `done`/`cancelled`
   from a tick, but the test asserts the actual statuses, so a different mapping changes the expected
   values, not the code.
4. **The `broadcast('work', …)` payload** — part 3 sends `{ item_id, project_id, kind, … }`. If parts
   1/2 already broadcast a different shape, make them one shape; the console (part 4) reads it.
5. **The routes and the docs** — move part 3's route block to the end of part 1's work-tracker section
   in `routes.js`, and fold this file into `docs/work-tracker.md`.
