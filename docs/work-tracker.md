# The work tracker — tickets + a work-item hierarchy

**Status:** part 1 of 4 (schema + REST API, server only). Migration `058_work_tracker.sql`,
`server/src/lib/work-status.js`, `server/src/lib/work-items.js`, `server/src/lib/tickets.js`,
routes in `server/src/api/routes.js`, test `test/work-tracker.test.mjs`.
Parts 2–4 hang zee-assignment and the console (kanban + gantt) off exactly this contract.

## Why this exists

Everything in the ZEEHIVE meta-schema records **which agents are running**: xells, zees,
containers, gates, land/ship requests. Nothing recorded **what the work IS**.

So a manager zee has a hive and no plan. It can see that four zees are alive and nothing at all
about what any of them is *for*, what is blocked behind what, or what is left. Humans held that in
their heads (or in a chat log), which is exactly the thing that does not survive a zee being reaped.

This adds the missing layer:

```
ticket  ──breakdown──▶  work_item tree  ──assigned──▶  a zee in a xell
what came in            what we will do                who is doing it
```

Keeping those three separate is the whole point. A ticket can be one line typed in a hurry and
still be tracked; the *same* ticket can become eleven tasks under three activities without anyone
re-filing it; and the work item survives the zee that was on it.

## The status vocabulary — reused, not invented

`work_status` is **the zee lifecycle**, not a new set of words:

| work_status | where it comes from |
|---|---|
| `queued` `assigned` `working` `done` `cancelled` | the existing `task_status` enum (001_init) |
| `blocked` | the hive's `occ-tendRequest` — the zee is stopped, waiting on a human |
| `review` | `occ-landRequest` / `occ-landHint` |
| `shipping` | `occ-shipRequest` / `occ-shipHint` |

A tracker bolted on with its own vocabulary (`todo/doing/done`, `open/closed`) would be lying about
the thing it tracks the moment a zee raised a tend. Because the words line up, a board card can show
what the zee on it is **actually** doing right now, beside the status a human last set.

`server/src/lib/work-status.js` is the single source of truth for the display side, written in the
exact shape and spirit of `lib/hive-status.js` — pure, dependency-free, so the server read models
and the web palette cannot drift:

- `WORK_STATUS` — `{ key: { label, order, terminal } }`. `done` and `cancelled` are terminal
  (the same two `work_status_is_terminal()` names in the migration; edit them together).
- `WORK_STATUS_KEYS`, `workLabel(key)`, `isTerminal`, `workOrder`, `isWorkStatus`.
- `statusFromHive(hiveStatusKey)` → the work status a live hive status implies, or **null**.
  `occ-working`→`working`, `occ-claimed`/`occ-idle`→`assigned`, `occ-tendRequest`→`blocked`,
  `occ-land*`→`review`, `occ-ship*`→`shipping`, `occ-done`/`occ-doneRequest`→`done`. Everything
  else → `null`, and null is a real answer: a status is never invented from a hive state that
  implies none.
- `nextStatuses(key)` / `canTransition(from,to)` — anything may be **cancelled**; a **terminal**
  item may only go back to `queued` (reopening restarts the flow, so "how did this reach review?"
  always has an answer in the event log); otherwise any non-terminal status may move to any other,
  because work really does go working → blocked → working → review → blocked, and a state machine
  that pretends otherwise only teaches people to lie to it.
- `workStatusVocabulary()` — the payload behind `GET /api/work-statuses`, so the console never
  hardcodes a column list, a label or an order.

**`live_status` is advisory and is never written back.** The card's column is always its *stored*
status. A zee going idle for a minute must not silently drag somebody's card into another column.

## The schema (migration 058)

```
ticket(id, project_id, number, title, body, kind, status, priority, reporter, assignee,
       labels text[], work_item_id, created_at, updated_at, closed_at)   UNIQUE(project_id, number)
ticket_comment(id, ticket_id, author, body, created_at)
work_item(id, project_id, parent_id, kind, title, body, status, priority, ticket_id, xell_id,
          assignee, starts_on, due_on, estimate_hours, progress, sort_order, path, depth,
          created_by, created_at, updated_at, closed_at)
work_item_dep(work_item_id, depends_on_id, created_at)         -- finish→start, for the gantt
work_item_event(id, work_item_id, ts, kind, from_status, to_status, actor, detail jsonb)
task.work_item_id                                              -- added for part 2
```

Enums: `work_status` (above), `work_item_kind` (`project|activity|task`),
`ticket_kind` (`bug|feature|chore|question|incident`).

### The impossibilities live in the DATABASE

House style (001_init): *"enums encode the capability matrix; triggers/constraints encode the
impossibilities."* Every rule below is enforced by postgres, with a message written for a human,
and the libraries do **not** re-check them — they let it raise and pass the sentence on.

| rule | what it prevents | how |
|---|---|---|
| a `project`-kind item is always a root | a second, contradictory tree | `CHECK (kind <> 'project' OR parent_id IS NULL)` |
| exactly ONE root per project | "which of these is the project?" | `UNIQUE INDEX … (project_id) WHERE kind='project'` |
| a new project gets its root automatically | a project you cannot file work under | `AFTER INSERT` trigger on `project` (+ a backfill for existing projects) |
| an item with no parent is attached to the project root | orphan trees nobody can find | `work_item_guard()` resolves it |
| a child is in the same project as its parent | subtree reads and roll-ups silently wrong | `work_item_guard()` |
| nesting rank `project(0) < activity(1) < task(2)`, child ≥ parent | an *activity* under a *task* (which makes a gantt roll-up meaningless) | `work_item_guard()` |
| no cycles | a node as its own descendant | `work_item_guard()` — the parent's `path` already lists every ancestor, so it is a substring test, not a walk |
| `path` / `depth` follow a move, for the whole subtree | a stale lineage after a drag | `work_item_guard()` (BEFORE) + `work_item_reparent_descendants()` (AFTER, one level at a time, recursing only while a path actually changed) |
| terminal status ⇒ `closed_at` set; leaving it ⇒ cleared | a reopened item that still reads as closed | `work_touch()` |
| `ticket.number` is a per-project sequence | a uuid nobody can say out loud | `ticket_number_assign()`, under a transaction advisory lock so two concurrent inserts cannot collide |
| no self-dependency, no dependency across projects | an unsolvable gantt | `work_item_dep_guard()` |

**`path`** is the materialized `'/'`-joined list of **ancestor ids, each followed by `/`**:
a root is `''`, its child `'<root>/'`, a grandchild `'<root>/<child>/'`. So

- an item's whole subtree is `path LIKE (path || id || '/') || '%'` — one index scan
  (`work_item (path text_pattern_ops)`), no recursive CTE;
- its ancestors, in order, are the path split on `/`;
- the cycle check is `position(id in parent.path) > 0`.

Deleting the **project root** is refused in the library, not the database, deliberately: a
`BEFORE DELETE` trigger refusing it would also break the `ON DELETE CASCADE` from `project`.

## The libraries

### `lib/work-items.js`

Pure data + read models, no HTTP. Every mutation ends with `broadcast('work', …)` (so
`/api/stream` pushes it) **and** appends a `work_item_event` row (`created | status | moved |
assigned | edited | comment`).

- `listWorkItems({projectId, status, kind, ticketId, rootId, tree})` — flat rows, or nested
  (`children: []`) with `tree`. Siblings ordered by `sort_order, created_at`.
- `getWorkItem(id)` → the item + `ancestors` (from `path`, root first) + `breadcrumb` + `children` +
  `open_children` + `descendant_count` + `deps` + `dependents` + `ticket` + `events` (last 50) +
  `zee` + `live_status`.
- `createWorkItem`, `updateWorkItem`, `moveWorkItem(id,{parent_id,sort_order})`, `deleteWorkItem(id)`,
  `setStatus(id,status,{actor,cascade})`, `addDep` / `removeDep`, `projectRoot(projectId)`.
- `boardModel({projectId, rootId})`, `ganttModel({projectId, rootId})`.
- helpers the console may want too: `nestItems`, `flattenTree`, `ancestorIds`, `subtreePrefix`,
  `liveZees(xellIds)`.

Three habits, all deliberate:

1. **Roll-ups are read-model only, never written back.** A stored roll-up is a cache that goes stale
   the first time anyone edits a leaf, and there is nowhere here to invalidate it.
2. **Closing a parent does NOT close its children.** `cascade: true` is opt-in and never implied;
   the read models expose `open_children` so a UI can *warn* and the human answers. A tracker that
   auto-closes has, at some point, closed real open work on somebody's behalf.
3. **A move is its own verb** (and its own event), because it rewrites the path of every descendant.

### `lib/tickets.js`

`listTickets({projectId,status,kind,q})` (with `work_items_count`, `open_work_items_count`,
`comment_count`), `getTicket(id)` (+ comments + linked work items), `createTicket`, `updateTicket`,
`deleteTicket` (keeps the plan — `ticket_id` is `ON DELETE SET NULL` — and reports how many items
were unlinked), `addComment`, and:

`breakdownTicket(id, { items, actor })` — the hinge. Creates the work items (default parent = the
**project root**, default kind `task`), links every one to the ticket, sets `ticket.work_item_id` to
the shallowest created item when unset, moves the ticket `queued → assigned`, and returns
`{ ticket, created, tree, count }`.

Each entry: `{ title, kind?, parent_id?, body?, priority?, assignee?, starts_on?, due_on?,
estimate_hours?, progress?, status?, ref? }`. **`ref` is a caller-supplied local handle** so one
call can build a whole tree: a later entry may name an earlier entry's `ref` as its `parent_id`.
Without it, expressing one thought would take three round trips.

## The read models

### `GET /api/board?project=&root=`

```
{ root, project_id, total, columns: [ { key, label, order, terminal, items: [card…] } ] }
```

One column per `work_status`, in the vocabulary's own order. A **card** is a work item plus
`breadcrumb` (ancestor titles from `path`), `kind`, `priority`, `progress`, `due_on`,
`ticket` (`{id, number, title}` when linked), `zee` (`{slug, hive_status, hive_status_label}` when a
live xell is on it), `open_children`, and `live_status` — `statusFromHive(zee.hive_status)` when a
zee is on it, else `null`.

Default scope: the **whole subtree of the project root**, excluding the root item itself.

### `GET /api/gantt?project=&root=`

```
{ root, project_id, unscheduled_count, rows: [ { id, parent_id, depth, kind, title, status,
  starts_on, due_on, computed_start, computed_end, progress, rolled_progress, estimate_hours,
  assignee, xell_id, unscheduled, deps: [id…] } ] }
```

Rows in **tree order** (depth-first by `sort_order`). Roll-ups:

- `computed_start` / `computed_end` — a parent **with no explicit dates** spans
  `min(children start) … max(children end)`. A parent **with** its own dates keeps them: someone
  stated them on purpose.
- `rolled_progress` — a parent with no explicit progress is the **child-count-weighted** average of
  its children's rolled progress, so a branch with nine subtasks outweighs a branch with one.
- `unscheduled: true` — no dates anywhere in the subtree. Those rows come back with **nulls** and
  the flag. The UI **lists** them; it does not invent dates, because an invented date is
  indistinguishable from a real one the moment it is on screen.

## The endpoints

| method | path | notes |
|---|---|---|
| GET | `/api/work-statuses` | the vocabulary: labels, order, terminal, legal transitions, kinds |
| GET | `/api/tickets?project=&status=&kind=&q=` | `q` is free text over title/body/reporter |
| POST | `/api/tickets` | `project` in the body |
| GET | `/api/tickets/:id` | + comments + linked work items |
| PATCH | `/api/tickets/:id` | title/body/kind/status/priority/reporter/assignee/labels/work_item_id |
| DELETE | `/api/tickets/:id` | work items survive, `unlinked_work_items` says how many |
| POST | `/api/tickets/:id/comments` | `{author, body}` |
| POST | `/api/tickets/:id/breakdown` | `{items:[…], actor}` → the created tree |
| GET | `/api/work-items?project=&tree=1&status=&kind=&root=&ticket=` | |
| POST | `/api/work-items` | `project` in the body (or inherit it from `parent_id`) |
| GET | `/api/work-items/:id` | the full detail model |
| PATCH | `/api/work-items/:id` | `parent_id` ⇒ a move; `status` ⇒ a validated transition |
| DELETE | `/api/work-items/:id` | cascades; the answer says `descendants` |
| POST | `/api/work-items/:id/deps` | `{depends_on_id}` |
| DELETE | `/api/work-items/:id/deps/:depId` | |
| GET | `/api/board?project=&root=` | |
| GET | `/api/gantt?project=&root=` | |

Project-scoped by `?project=` like every other read model here; a POST takes `project` in the body.

**Error contract** — 400 bad input, 404 unknown id, **409 a refused move/delete/transition with the
reason as a sentence a human can read**, and never a bare 500. The split: a 400 says *"you sent
nonsense"*, a 409 says *"what you asked is coherent but conflicts with the state of the tree"* — a
cycle, an activity under a task, deleting the project root, a done item jumping back to working.

## Test

```sh
DATABASE_URL=… node test/work-tracker.test.mjs
```

Stands up two throwaway projects (and one real xell, to exercise the live-zee derivation), covers
the root rule, ticket numbering, breakdown, path/depth on move, every refusal, closed_at
stamp/clear, the board and the gantt — and tears **everything** down in a `finally`, including the
`session_event` rows that would otherwise survive the project delete as orphans (house rule #1: no
test data).

## What parts 2–4 need to know

- **`work_item.xell_id`** is the zee currently on an item; **`assignee`** is free text for when a
  human holds it. `task.work_item_id` already exists (added by 058) for part 2 to stamp a
  dispatched worker's task with the item it was cut for — no new migration needed for that.
- **Never write `live_status` back into `status`.** It is a hint. The stored status is a human's (or
  a verb's) statement of intent; the hive status is a fact about a process.
- **Import the vocabulary, do not retype it.** `GET /api/work-statuses` (or
  `lib/work-status.js`) gives labels, column order, terminal flags and legal transitions.
- **`sort_order` is a double** precisely so a drag can insert between two neighbours
  (`(prev+next)/2`) without renumbering a column.
- **SSE**: every mutation broadcasts on the `work` channel of `/api/stream`, as
  `{kind, item}` / `{kind, ticket}` where `kind` is `created|status|moved|assigned|edited|deleted|
  dep|ticket-created|ticket-updated|ticket-deleted|ticket-comment|ticket-breakdown`.
