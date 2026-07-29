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
- `nextStatuses(key)` / `canTransition(from,to)` — the exact sets, because a UI that builds a
  dropdown from a summary sentence will be missing options the server accepts:

  | from | legal next |
  |---|---|
  | any non-terminal (`queued` `assigned` `working` `blocked` `review` `shipping`) | every other non-terminal, plus `done`, plus `cancelled` |
  | `done` | `queued`, `cancelled` |
  | `cancelled` | `queued` |

  Anything may be **cancelled**. A **terminal** item reopens through `queued` rather than dropping
  back into the middle of the flow, so "how did this reach review?" always has an answer in the
  event log. Otherwise any non-terminal status may move to any other, because work really does go
  working → blocked → working → review → blocked, and a state machine that pretends otherwise only
  teaches people to lie to it. `canTransition(x, x)` is **true** — a no-op write is not illegal
  (and `updateWorkItem` skips it entirely rather than writing a pointless event).

  **Read `next[]` from `GET /api/work-statuses`, never from this prose.** The endpoint is generated
  from the same table the server validates against; a sentence in a doc is not.
- `workStatusVocabulary()` — the payload behind `GET /api/work-statuses`, so the console never
  hardcodes a column list, a label or an order.

**`live_status` is advisory and is never written back.** The card's column is always its *stored*
status. A zee going idle for a minute must not silently drag somebody's card into another column.

## Three policies parts 3 and 4 must not misread

These are correct **as built**; they were merely implicit before, which is the same as wrong.

### 1. Root inclusion differs between the views — on purpose

| endpoint | with `?project=` | with `?root=X` | why |
|---|---|---|---|
| `GET /api/board` | the root's whole subtree, **root EXCLUDED** | X's subtree, **X EXCLUDED** | a project root is not a card. It is the scope of the board, and it is returned separately as `root` |
| `GET /api/gantt` | every item, **root INCLUDED** | X **and** its subtree | the project IS the top summary bar — the row whose dates span everything |
| `GET /api/work-items` | every item, **root INCLUDED** | X **and** its subtree | a list is a list; it hides nothing |

So the *same* `?root=` gives the board one fewer row than the gantt. Part 3 must not go looking for
the missing card; part 4 must not treat the top gantt row as a task.

### 2. Nesting is `child_rank >= parent_rank`, and nothing narrower

Ranks are `project(0) < activity(1) < task(2)`. A child's rank must be **greater than or equal to**
its parent's. That means all of these are **legal**:

- activity under project, task under activity — the ordinary shape;
- **task under task** — subtasks, to any depth;
- **activity under activity** — a phase inside a phase.

Only *upward* nesting is refused (an activity under a task), plus a `project` anywhere but the root.
**A tree UI must therefore handle arbitrary depth and repeated kinds** — do not hardcode three
levels.

### 3. `parent_id: null` means "move to the project root"

It does **not** detach an item, and it does not make it a second root (the schema forbids that).
`PATCH /api/work-items/:id {"parent_id": null}` lands the item directly under the project root at
depth 1 — the "drag to top level" gesture. `moveWorkItem` resolves the root itself so the new
`sort_order` is computed among the siblings the item actually lands beside.

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

- compute the item's **subtree prefix** first — `prefix = item.path || item.id || '/'` — then its
  descendants are the rows matching `path LIKE prefix || '%'`: one index scan
  (`work_item (path text_pattern_ops)`), no recursive CTE. Note the match is **strict descendants**;
  the item itself does not match its own prefix, which is exactly why the board (which uses the
  prefix alone) excludes the root while the gantt adds `OR id = <root>`;
- its ancestors, in order, are the path split on `/` (`ancestorIds(path)`);
- the cycle check is `position(id in parent.path) > 0`.

Deleting the **project root** is refused in the library, not the database, deliberately: a
`BEFORE DELETE` trigger refusing it would also break the `ON DELETE CASCADE` from `project`.

## The libraries

### `lib/work-items.js`

Pure data + read models, no HTTP. Every mutation ends with `broadcast('work', …)` (so
`/api/stream` pushes it), and every mutation that leaves a **surviving row** also appends a
`work_item_event`.

**Two vocabularies, deliberately not merged — do not assume one list covers both:**

| | values |
|---|---|
| `work_item_event.kind` (the ledger) | `created` `status` `moved` `assigned` `edited` `comment` |
| broadcast `kind` (the SSE bus) | the six above, **plus** `deleted` and `dep`, **plus** the `ticket-*` kinds |

`deleted` is bus-only and **there is no `deleted` event, ever**: `work_item_event.work_item_id` is
`ON DELETE CASCADE`, so an event written for a deleted item would be deleted along with it. A
consumer waiting for one will wait forever. `dep` is bus-only too (a dependency edit is recorded
against the item as an `edited` event, with `{added_dep}` / `{removed_dep}` in `detail`), and
`comment` is ledger-only.

- `listWorkItems({projectId, status, kind, ticketId, rootId, tree})` — flat rows, or nested
  (`children: []`) with `tree`. Siblings ordered by `sort_order, created_at`.
- `getWorkItem(id)` → the item + `ancestors` (from `path`, root first) + `breadcrumb` + `children` +
  `open_children` (direct) + `descendant_count` + `open_descendant_count` (whole subtree) + `deps` +
  `dependents` + `ticket` + `events` (last 50) + `zee` + `live_status`. Every item shape also
  carries `status_label`, `next_statuses` and `ancestor_ids`, so a detail pane needs no second call
  to know what it may do next.
- `createWorkItem`, `updateWorkItem`, `moveWorkItem(id,{parent_id,sort_order})`, `deleteWorkItem(id)`,
  `setStatus(id,status,{actor,cascade})`, `addDep` / `removeDep`, `projectRoot(projectId)`.
- `inTransaction(fn)` + `dbRunner(client)` — how a multi-write verb becomes atomic (see the
  breakdown guarantee below). `createWorkItem(input, {client, pending})` participates when handed a
  client; **part 2 should use this** if dispatching a zee ever has to write more than one row.
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

Three things about it that are easy to get wrong:

- **It is ADDITIVE, not idempotent.** Calling it twice on the same ticket creates a *second* set of
  items; it does not reconcile or replace the first. A "re-break-down" button duplicates the plan
  unless the caller deletes the previous items first. Left additive on purpose — a ticket
  legitimately grows more work as it is understood, and a reconcile would have to guess which
  existing items the author meant to keep.
- **`ref` resolves BACKWARDS only.** A ref must be declared by an *earlier* entry in the same array.
  A forward or unknown ref is refused by name — `item "child": parent_id "later" is neither a work
  item id nor a ref declared by an EARLIER item in this breakdown (refs so far: …). A ref must be
  defined before it is used. Nothing was created.` — rather than reaching postgres as a uuid cast.
- **It is ONE TRANSACTION — all or nothing.** See the guarantee below.

#### The breakdown transaction guarantee

A breakdown either **builds the whole plan** or **leaves the ticket exactly as it was**. If entry 5
of 6 is rejected — a bad ref, a missing title, an activity under a task, any database refusal —
then:

- **zero** work items exist (entries 1–4 are rolled back with the rest);
- the ticket keeps its old `status` and `work_item_id` (it does not move `queued → assigned`);
- no `work_item_event` rows survive;
- **nothing was broadcast** on `/api/stream` — SSE events are collected during the transaction and
  emitted only after the `COMMIT`, so the console is never shown a card the database does not have;
- the error names the offending entry and ends with *"Nothing was created."*

This matches how every other irreversible act in this repo behaves — a landing is one sha, a seed
runs in its own transaction, a ship is all-or-nothing. Half a plan is worse than none: a manager who
asked for six items and got four, with no error path back to a clean state, has to work out by hand
which two are missing.

The mechanism is small and reusable: `inTransaction(fn)` in `lib/work-items.js` checks out a client,
runs `fn({client, pending})` inside `BEGIN`/`COMMIT`, and flushes `pending` broadcasts only on
success. `createWorkItem(input, {client, pending})`, `projectRoot(projectId, client)` and
`logWorkEvent(…, {client})` take part when handed a client and use the pool otherwise — so reads
inside the transaction see the rows the *same* transaction just inserted (which is what gives
siblings created in one breakdown their increasing `sort_order`). Pinned in the test:
`1000 < 2000 < 3000 < 4000 < 5000`.

## The read models

### `GET /api/board?project=&root=`

```
{ root, project_id, total, columns: [ { key, label, order, terminal, items: [card…] } ] }
```

One column per `work_status`, in the vocabulary's own order — **including the empty ones**, so the
console never has to invent a column list.

A **card** carries: `id`, `project_id`, `parent_id`, `kind`, `title`, **`status`**,
**`status_label`**, `priority`, `progress`, **`depth`**, **`sort_order`**, `assignee`, `starts_on`,
`due_on`, `breadcrumb` (ancestor titles from `path`), `ticket` (`{id, number, title}` when linked),
`zee` (`{slug, hive_status, hive_status_label}` when a live xell is on it), `open_children` (direct
children not in a terminal status), and `live_status` — `statusFromHive(zee.hive_status)` when a zee
is on it, else `null`.

`status`, `status_label`, `depth` and `sort_order` are on the card precisely because a
drag-and-drop column needs all four: the column it belongs to, its label, its indent, and its rank.

Default scope: the **whole subtree of the project root, root excluded** — see the root-inclusion
table above.

### `GET /api/gantt?project=&root=`

```
{ root, project_id, unscheduled_count, rows: [ { id, parent_id, depth, kind, title, status,
  starts_on, due_on, computed_start, computed_end, progress, rolled_progress, estimate_hours,
  assignee, xell_id, unscheduled, deps: [id…] } ] }
```

Rows in **tree order** (depth-first by `sort_order`). Roll-ups:

Rows include the root (see the root-inclusion table). Roll-ups:

- `computed_start` / `computed_end` — a parent **with no explicit dates** spans
  `min(children start) … max(children end)`. A parent **with** its own dates keeps them: someone
  stated them on purpose. Only the missing end is rolled — a parent with a `starts_on` and no
  `due_on` keeps its start and rolls its end.
- `rolled_progress` — a parent with no explicit progress is the **leaf-count-weighted** average of
  its children's rolled progress (each child weighs the number of leaves beneath it, *not* its
  number of direct children), so a branch with nine subtasks outweighs a branch with one.

  **"No explicit progress" is implemented as `progress === 0`.** There is no way to state a
  deliberate 0% on a parent — it will always show the rolled average instead. Leaves always report
  their own `progress` as `rolled_progress`.
- `unscheduled: true` — no dates anywhere in the subtree. Those rows come back with **nulls** and
  the flag, and `unscheduled_count` totals them. The UI **lists** them; it does not invent dates,
  because an invented date is indistinguishable from a real one the moment it is on screen.

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
| POST | `/api/tickets/:id/breakdown` | `{items:[…], actor}` → the created tree. **One transaction**: all six items or none |
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

**Malformed id vs unknown id.** They are different mistakes — a typo in a URL, and a link to
something that was deleted — so they get different answers:

| you sent | answer |
|---|---|
| `/api/work-items/not-a-uuid` | **400** `{"error":"\"not-a-uuid\" is not a valid work item id"}` |
| `/api/work-items/<well-formed but unknown>` | **404** `{"error":"no such work item"}` |

The same holds for ticket ids and for `parent_id` / `depends_on_id` / `ticket_id` / `xell_id` /
`project` in a body, each naming the field it rejected (`… is not a valid parent work item id`). An
unknown `?status=` or `?kind=` filter is likewise a 400 listing the legal values, never a postgres
enum cast error.

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
  (`(prev+next)/2`) without renumbering a column. Send it however you like: `{sort_order}` alone,
  or `{parent_id, sort_order}` together — **both work, including when `parent_id` is unchanged**.
  (They did not always: a same-column drag was silently dropped until the regression now pinned in
  `test/work-tracker.test.mjs`.) When the parent *does* change, the move applies the rank; you get
  exactly one `moved` event either way.
- **SSE**: every mutation broadcasts on the `work` channel of `/api/stream`. The payload shape
  varies by kind — do not assume `{kind, item}` throughout:

  | broadcast `kind` | payload |
  |---|---|
  | `created` `status` `moved` `assigned` `edited` `dep` | `{kind, item}` |
  | `deleted` | `{kind, item, descendants}` |
  | `ticket-created` `ticket-updated` `ticket-deleted` | `{kind, ticket}` |
  | `ticket-comment` | `{kind, ticket, comment}` |
  | `ticket-breakdown` | `{kind, ticket, created}` — `created` is a **count**, not the items |

  And remember the ledger is a different list (no `deleted`, no `dep`; it has `comment`).
- **Ticket writes are only partly audited.** A ticket edit or comment appends a `work_item_event`
  **only when the ticket already has a linked `work_item_id`** — the event hangs off that item's
  ledger. `createTicket` appends none at all (there is nothing yet to hang it on). If part 3 needs a
  full ticket history, that is a new table, not something to read out of `work_item_event`.
