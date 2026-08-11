# The work tracker — tickets + a work-item hierarchy

**Status:** part 1 of 4 (schema + REST API, server only). Migrations `058_work_tracker.sql`,
`060_work_item_schedule_sanity.sql` and `066_work_tracker_column_meanings.sql`,
`server/src/lib/work-status.js`, `server/src/lib/work-items.js`, `server/src/lib/tickets.js`,
routes in `server/src/api/routes.js`, test `test/work-tracker.test.mjs`.
Parts 2–4 hang zee-assignment and the console (kanban + gantt) off exactly this contract.

**The VERBS — assignment, deploy, the board that moves itself, and the three cxell verbs — are
documented next door in [work-tracker-verbs.md](work-tracker-verbs.md).** This file is the nouns:
the schema, the read models and the policies everything else must not misread.

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

## Five policies the console and the verbs must not misread

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

### 4. A dead xell lends a work item nothing — no zee, and no signal

`work_item.xell_id` is a **durable record of the last assignment**, but a xell dies long before the
work does. `reapXell` never deletes the xell row — it sets `status='retired'` — so the column's
`ON DELETE SET NULL` essentially never fires and the item keeps pointing at a corpse.

The read models therefore resolve **only live xells**. A xell that is `retired`, `husk` or `error`
(the states `hive-status.js` itself classifies as gone or vacant) yields:

```
zee: null        live_status: null        xell_id: <still there, as history>
```

This is enforced at **read time** in `liveZees()`, deliberately *not* by a release hook in the reap
path. A hook is a cache invalidation and it will be missed — `purgeDevXells` reaps in bulk,
`recoverOrphanTeardowns` finishes reaps a dead queenzee left half-done, and a human can update a row
by hand. A `WHERE` clause cannot be bypassed by a code path nobody has written yet.

What this fixed: a reaped xell used to report `hive_status: 'occ-claimed'` (the unclassified
fallback in `hive-status.js`) and therefore `live_status: 'assigned'` — a card claiming an agent was
on work whose agent had been gone for a week. Reaped **with a landing still undecided** it read
`review`, because the reaper releases open **ships** (`releaseXellShips`) but never land requests.
`hiveStatus()` now answers `null` for a retired row rather than letting that fallback speak for it;
every other derivation is unchanged, and every existing caller (`fleet.js`, `managers.crewFor`,
`self.js`) already filtered retired before calling, so nothing there moved.

Two consequences worth stating:

- **A reap must never move the item to `done`.** The agent is gone; the work is not finished. The
  stored status stays exactly as a human left it — the same argument as "closing a parent does not
  close its children".
- **"was: &lt;slug&gt;" is part 2/3's to build**, from the surviving `xell_id` plus the
  `work_item_event` ledger (`kind:'assigned'`). This module will not hand you a dead zee to render.
  Part 3 keeps that contract: its tick NOTES a departed zee in the ledger (with the slug
  denormalized into `detail`) and never nulls the column — see "The board moves itself" below.

### 5. `priority` is 1..5 and **1 is MOST urgent**

Nothing in the original contract said which end was urgent, so the console had to guess (it guessed
right, and said so in a comment: *"the API says nothing about which end is urgent"*). That gap is
worth closing loudly, because the failure is silent and total: if the direction were the other way,
**every board card in production would be coloured backwards** and nothing would throw.

| priority | meaning |
|---|---|
| **1** | most urgent |
| 2 | |
| **3** | the DEFAULT — the middle of the scale |
| 4 | |
| **5** | least urgent |

Why this direction, and not the other:

- the column defaults to **3**, the exact middle of 1..5. A scale whose default sits in the middle
  is one where both ends are extremes — if 5 were "most urgent", the default would be 1;
- it is the near-universal convention a person already carries: P1, "priority one", severity 1,
  Jira, ITIL. A tracker that inverted it would be technically free to and wrong in every reading;
- the console already ships this reading (`Pips` fills as the number *drops*, 1 tinted red, 2 amber,
  tooltip "1 = most urgent"), so stating it changes no rendered pixel — it just stops the next
  person re-deriving it.

**Careful — this repo contains the opposite convention nearby.** `machine_pool.dev_priority` is
ordered `DESC` (see `lib/machines.js`, `queenzee/intake.js`): for MACHINES, a **higher** number
wins. The two columns are unrelated and the names rhyme, which is exactly how somebody transfers one
convention onto the other. `work_item.priority` and `ticket.priority` are 1-is-most-urgent; nothing
about the machine pool applies to them.

Nothing on the server orders by `priority` — no read model sorts on it, so there is no behaviour
that would have broken either way. This is a **display and judgement** contract, and now it is one.

It is also stated **in the database**: migration 066 puts this same sentence on
`work_item.priority` and `ticket.priority` as a column comment (along with `progress`, the dates,
`depth`, `status` and `ticket.number`), because `\d+ work_item` in psql is the first place somebody
stands when they are re-deriving a meaning — and until then it answered with a range and nothing else.

## The schema (migration 058)

```
ticket(id, project_id, number, title, body, kind, status, priority, reporter, assignee,
       labels text[], work_item_id, created_at, updated_at, closed_at)   UNIQUE(project_id, number)
ticket_comment(id, ticket_id, author, body, created_at)
work_item(id, project_id, parent_id, kind, title, body, status, priority, ticket_id, xell_id,
          assignee, starts_on, due_on, estimate_hours, progress, sort_order, path, depth,
          created_by, created_at, updated_at, closed_at)
work_item_event(id, work_item_id, ts, kind, from_status, to_status, actor, detail jsonb)
task.work_item_id                                              -- added for part 2

> **REHAB 3/4**: `work_item_dep` is RETIRED (migration 188). finish→start edges now live in the
> workflow model's `dependency` table (from_id = prerequisite, to_id = dependent, type 'FS'),
> which the work-tracker readers (board/gantt/drawer) have read since REHAB 2/4 and the writers
> have written since REHAB 3/4. `work_item` itself stays as the ATTRIBUTE ANNEX — it still carries
> body, ticket_id, xell_id, progress, the exact stored status and the audit trail
> (`work_item_event`), because the model does not own those yet.
```

### CHAIN vs NESTING — the edge is a public contract

Two different "ordering" ideas live on the plan, and they are told apart **from the rows alone**:

- **NESTING** — `work_node.parent_id` (or, on the tracker's attribute annex, `work_item.parent_id`).
  It says **"part of"**: a task belongs to its activity, an activity to its project. Every node except
  the plan root has exactly one parent. There is no ordering *between separate items* here.
- **CHAIN** — a row in the `dependency` table. It says **"after"**: one item waits for another item.
  The two endpoints are **separate nodes** — the model's I6 trigger refuses an ancestor/descendant
  pair (a chain may not duplicate a nesting relation). The gantt's critical path runs along chains.

**The direction is load-bearing, and the retired table meant the opposite.** In the model,
`dependency.from_id` is the **PREDECESSOR** (the thing that must finish first) and `dependency.to_id`
is the **DEPENDENT** (the thing that waits): `from_id → to_id` reads "from finishes, then to starts".
The retired `work_item_dep` table stored this **the other way round** — `work_item_id` was the
DEPENDENT and `depends_on_id` was the PREREQUISITE — so anyone carrying a mental model from the old
table will hand the edge over backwards. The write verb (console `depends on` picker, `zee dep
--item <dependent> --on <prerequisite>`) takes the DEPENDENT first and the PREREQUISITE second, and
the writer (`lib/work-items.js` `addDep`) flips them into `from_id=prerequisite, to_id=dependent`.

**The readers/walkers a caller should use:** there is no standalone JS predecessor/successor helper —
the gantt reads `union_edge` (the leaf-expanded view: sibling order + every dependency, with the
direction already resolved to the leaf level) for a whole plan at once, and the model's SQL helpers
(`wn_first_leaves` / `wn_last_leaves` / `wn_ancestors`) walk the TREE. A caller that needs one node's
chains queries `dependency` directly: `WHERE from_id = $node` gives its successors (things that wait
on it), `WHERE to_id = $node` gives its predecessors (things it waits on).

### What the durations card actually changed (read this before you trust a critical-path claim)

Migration **194** (the durations-from-evidence change) makes every plan's **durations** real:
an explicit `estimate` wins, else the measured actual from closed executions, else a stated 1-day
default — so a gantt draws bars of evidence-derived length on every plan. What it does **not** do is
make **slack and criticality** meaningful everywhere: those are computed by CPM from `dependency`
edges, and a plan with no edges has every node trivially critical with one identical slack value —
the maths is correct, there is just nothing to rank. Measured on the live plans (2026-08-11): the
Zeehive plan (3 edges) is a real gantt — 69 distinct slack values, 20/164 critical; the omnibiz plan
(**0 edges**) still comes back 355/355 critical with 1 slack value. Durations vary there (17 distinct),
so bars are real; the critical path is not yet meaningful. That is a **data gap, not a bug**: the fix
is the chain-capture path (`zee dep` + the console `depends on` picker), and chains must come from
real "after" relationships as work is cut — never be invented to make the chart look non-degenerate.

**The other half of the gap is dates and estimates, not chains.** Measured on the live plans the
same day: **0 of 519 work items carry an estimate or a start/due date** — so every bar is a 1-day
default (194's fallback) and every schedule is anchored at `now()`. The chart is honest about this
(the duration_source tooltip says "1-day default"; the edge banner says when order is inferred), but
it means the bars are placeholders until a human enters real data. What a human would actually enter,
per card, for the chart to mean something:

- **an `estimate`** (hours) on every task — the only thing that makes a bar's *length* real (194's
  first choice; otherwise the default 1 day stands, or the measured actual once the task has run);
- **a `starts_on` / `due_on`** on the cards that anchor the plan — the only thing that makes the
  *window* real (the CPM otherwise anchors everything at the project start `now()` and lays bars
  forward from there);
- **a `dependency` chain** between cards that are really "after" each other — the only thing that
  makes *slack and criticality* meaningful (the other half of this section).

All three are already writable: the console drawer PATCHes `estimate_hours` / `starts_on` / `due_on`
and the `depends on` picker writes the model edge, and a manager can do the same from the CLI with
`zee item --estimate/--starts-on/--due-on` and `zee dep`. Nothing more needs to be built — the chart
means something as soon as the data is entered.

Migration **060** adds one constraint to the above: `work_item_dates_ordered` — `due_on` may
not precede `starts_on` (see "The schedule invariant" below). It repairs any already-inverted row
by **clearing `due_on`** rather than swapping the pair or pinning it to `starts_on`: an inverted
pair means one of the two dates is wrong and we cannot know which, so "no end date" is the only
thing actually true about such a row.

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
| no self-dependency, no dependency across projects | an unsolvable gantt | the model's I5 trigger (REHAB 3/4: the retired `work_item_dep_guard()` stated it in words; `addDep` now states the same sentence first) |

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

`ticketCode(row)` — the short handle a human copies: `TKT-<number>-<4 hex of the id>`, **derived,
never stored**. `ref` (`#16`) is what a person says out loud and is only unique per project; the code
is that number made unambiguous across projects, from two immutable columns, so there is no column
to migrate and no way for it to disagree with the row. Every shaped ticket carries it as `code`.

`ticketManagers(id)` / `notifyManagerOfTicket(id, { xellId, by })` — handing a ticket to a manager
zee. The first is a picker read model (the manager xells of *this* ticket's project as they are right
now, each with `live`: whether it has a cxell session a message can be typed into) built the same way
as `work-assign.js`'s `candidatesFor`. The second sends through the **existing** delivery path —
`managers.postMessage` → `sendMessageToXell`, the console's 📨 door — so the message is stored in the
manager's inbox and typed into its live session, and the not-delivered verdict is passed back
verbatim rather than rounded up to "sent". It is a NOTIFICATION: it assigns nothing and opens no
gate, and the text says so.

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

### `lib/reflections.js` — the reflections ledger

A **reflection** is not a ticket noun at all: it is a `zee_message` with `kind='reflection'`, written
by a zee right after its own work SHIPS (`queenzee/shipgate.js` re-invokes it, gated by the harness's
`enable_reflection`). It lives in this doc because of where it ENDS UP — the ledger's one action turns
one into a ticket, and the ticket is an ordinary ticket from that moment on.

Why it needed a read of its own: a reflection is addressed to that zee's **manager**, and the only
readers were the manager's own `zee inbox` and the per-xell Directives panel. A reflection addressed
to a manager xell that has since been RETIRED is therefore in nobody's window at all.

- `listReflections({projectId, limit, since})` — project-wide, **newest first**. Each row carries the
  writer (`from`) and its **source xell** (`from_xell_id`/`from_xell_slug`/`from_xell_status`; a null
  id with a slug means the xell was reaped), the recipient manager (`to`, `to_xell_id`,
  `recipient_retired`), `read_at`, `at`, the whole `body`, and the `ticket` it was filed as (or null).
  `orphaned` is true in the three cases where nobody will ever read it as a message — never addressed
  (the zee had no manager), the recipient xell row is gone, or the recipient is retired — each with
  its own `orphan_reason` sentence.
- `fileReflectionAsTicket(id, {kind, priority, by})` — the action. Goes through **`createTicket`**,
  never a second creation path: title = the reflection's first line (markdown ornament stripped,
  trimmed to 160), body = the reflection **verbatim** plus the source xell slug and the date,
  `kind='chore'` by default, `reporter` = the zee that wrote it.
- `reflectionTitle(body)` / `reflectionTicketBody(row)` are pure and exported, so the console can show
  a human the same headline the server will use.

**Filed once.** `zee_message.ticket_id` (migration 128, `ON DELETE SET NULL`) is the link, and the
write CLAIMS it conditionally (`WHERE ticket_id IS NULL`) rather than trusting the read before it: two
clicks at one instant would otherwise make two tickets and remember only the second. A second attempt
is a **409** naming the ticket that already exists; deleting that ticket unlinks the reflection, which
legitimately re-opens it for filing.

**READING MARKS NOTHING READ**, here and in the console. `read_at` is the receipt for the AGENT's own
`zee inbox` (`managers.inboxFor`), and a human reading the ledger must not clear a zee's unread flags —
the same rule `messagesForXell` states for the per-xell audit view. Nothing in `lib/reflections.js`
writes `read_at`, and the console's client has exactly two calls: the read and the file.

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
{ root, project_id, unscheduled_count,
  span: { start, end, days } | null,
  rows: [ { id, parent_id, depth, kind, title, status, status_label,
            starts_on, due_on, actual_start, actual_end,
            computed_start, computed_end, computed_actual_start, computed_actual_end, span_days,
            progress, rolled_progress, estimate_hours, assignee, xell_id,
            unscheduled, deps: [id…] } ] }
```

Rows in **tree order** (depth-first by `sort_order`), and they **include the root** (see the
root-inclusion table). Roll-ups:

- `computed_start` / `computed_end` — a parent **with no explicit dates** spans
  `min(children start) … max(children end)`. A parent **with** its own dates keeps them: someone
  stated them on purpose. Only the missing end is rolled — a parent with a `starts_on` and no
  `due_on` keeps its start and rolls its end.
- `actual_start` / `actual_end` — the **DERIVED** actuals, from migration 159. These are what the
  record *proves* happened (the first event into assigned/working, or the first zee_turn of a linked
  xell = start; the terminal event, or the first landed landing = end), maintained by triggers as a
  byproduct of the queenzee's own event writes — **never agent-submitted**. They are distinct from
  `starts_on`/`due_on` (the PLAN) and the gantt draws them as a separate read-only bar. A null
  `actual_end` is "still in flight".
- `computed_actual_start` / `computed_actual_end` — the actual span rolled up the same way as the
  plan: a parent whose own ledger is silent (a project/activity is rarely assigned to a zee) still
  gets the real bar its subtree earned. A parent **with** its own actuals keeps them.
- `rolled_progress` — a parent with no explicit progress is the **leaf-count-weighted** average of
  its children's rolled progress (each child weighs the number of leaves beneath it, *not* its
  number of direct children), so a branch with nine subtasks outweighs a branch with one.

  **"No explicit progress" is implemented as `progress === 0`.** There is no way to state a
  deliberate 0% on a parent — it will always show the rolled average instead. Leaves always report
  their own `progress` as `rolled_progress`.
- `unscheduled: true` — **no dates anywhere in the subtree, planned OR actual**. Those rows come back
  with **nulls** and the flag, and `unscheduled_count` totals them. The UI **lists** them; it does
  not invent dates, because an invented date is indistinguishable from a real one the moment it is
  on screen. A row whose PLAN is empty but whose RECORD has actuals draws a real bar and is not
  listed.
- `span_days` (per row) and `span: {start, end, days}` (per model) — how wide the bar is, and how
  wide the whole chart is, in **whole inclusive days** (a task starting and ending the same day is
  `1`, not `0`). `null` when the row is unscheduled, and `span` is `null` when nothing is scheduled
  at all. The model's `span` includes the actual extent too — a chart whose bars are all actuals
  (the 470-item / 0-plan case this exists for) still gets a window.

### The schedule invariant, and the span that is *not* one

**`due_on` may never precede `starts_on`.** It is a `CHECK` constraint (`work_item_dates_ordered`,
migration 060) *and* a lib-level refusal, so a caller gets a sentence —

> `"scheduled thing": due_on 2026-08-01 is before starts_on 2026-08-10 — a work item may not finish
> before it starts. Give due_on on or after starts_on, or leave it empty for "no end yet".`

— rather than `new row for relation "work_item" violates check constraint …`. A **400**, not a 409:
it is bad input, not a conflict with the state of the tree. Patching **one** date is validated
against the **stored** other, which is the half that used to slip through. Still legal: equal dates
(a real one-day task), and either end missing.

Why it is an invariant and not a UI concern: a chart cannot draw a negative bar, so it renders a
stub — **visually identical to a legitimate one-day task**. The schedule was wrong and the picture
looked right, which is the worst pair of properties a read model can have.

**Nothing bounds how far apart the two dates may be**, and that is deliberate. `0001-01-01` →
`9999-12-31` is legal, ordered, and absurd: 2,958,099 days. The gantt returns it **faithfully** and
**states `span_days`**. It does not clamp, because truncating a stored date would invent a date, in
exactly the way inventing a start for an unscheduled row would — and because how much window to show
is the renderer's decision, not the server's. The number is there so a client can clamp *knowingly*,
and say that it clamped, instead of discovering the scale by trying to draw it.

(Dates are emitted with a **4-digit-padded year**. `0001-01-01` used to come back as `1-01-01`,
which is not ISO 8601 and gives `NaN` or a silently different day depending on the runtime.)

## The endpoints

These are the CONSOLE endpoints, authenticated as the console. A DEPLOYED project — omnibiz
filing into its own board from somebody else's server — comes in through a second, key-authenticated
door at `/api/ext/v1`, documented in [ticketing-api.md](ticketing-api.md). It creates ORDINARY rows in
these same tables: everything below applies to an externally-filed ticket unchanged.

| method | path | notes |
|---|---|---|
| GET | `/api/work-statuses` | the vocabulary: labels, order, terminal, legal transitions, kinds |
| GET | `/api/tickets?project=&status=&kind=&q=` | `q` is free text over title/body/reporter |
| POST | `/api/tickets` | `project` in the body |
| GET | `/api/tickets/:id` | + comments + linked work items |
| PATCH | `/api/tickets/:id` | title/body/kind/status/priority/reporter/assignee/labels/work_item_id |
| DELETE | `/api/tickets/:id` | work items survive, `unlinked_work_items` says how many |
| POST | `/api/tickets/:id/comments` | `{author, body}` |
| GET/POST | `/api/tickets/:id/attachments` | the evidence on a ticket — images and text logs, metadata on the way out, `content_base64`/`text` on the way in |
| GET/DELETE | `/api/tickets/:id/attachments/:attachmentId` | download the raw bytes (always a download, `nosniff`), or remove one |
| POST | `/api/tickets/:id/breakdown` | `{items:[…], actor}` → the created tree. **One transaction**: all six items or none |
| GET | `/api/tickets/:id/managers` | the manager zees of this ticket's project, resolved live, each with `live` + a `why` line |
| POST | `/api/tickets/:id/notify` | `{xell_id, by}` → tells that manager about the ticket. Answers `{code, delivered, delivery, note}` |
| GET | `/api/reflections?project=&limit=&since=` | the reflections ledger, newest first. Reading marks NOTHING read |
| POST | `/api/reflections/:id/ticket` | `{kind?, priority?, by?}` → files it as a ticket through `createTicket`. **409** if it already is |
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

**The status is carried on the error, never read out of its text.** `lib/work-items.js` exports
`bad()` / `notFound()` / `refuse()` (400 / 404 / 409) and tags every refusal it raises;
`httpStatusOf(err)` is what the route answers with, defaulting to 400 for anything untagged. A
refusal raised by one of migration 058's **guard triggers** is classified by its postgres **error
code** — `P0001` (a plpgsql `RAISE EXCEPTION`) is 409 — so a trigger message could be rewritten in
any words, or any language, and stay a 409.

This replaced a regex over the message text, which had quietly made every refusal sentence
load-bearing prose: reword one and its HTTP status flipped with **nothing to catch it** — no test
failing, no log line, and every client branching on 409-vs-400 wrong from then on. Pinned by
assertions that an error stuffed with every old trigger word stays 400 when tagged 400, and a bland
sentence stays 409 when tagged 409. (`lib/work-assign.js` already worked this way; this is part 1
adopting its own follow-up.)

## Part 3 — putting a ZEE on a work item

Parts 1 and 2 give the hive a PLAN. Part 3 is what makes the plan reach the agents, and the fleet
reach the plan:

| direction | what it means |
|---|---|
| **plan → fact** | a human (or a manager zee) puts a zee ON an item — `assign`, `deploy` |
| **fact → plan** | the item then follows that zee by itself — `queenzee/worksync.js` |

Nothing here is a new gate, and nothing here is a way round one. A dispatched worker still lands its
own work through the landing gate, still ships through the ship gate, and is still marked done by a
human. What changed is only that the board knows about it.

### Assignment — `server/src/lib/work-assign.js`

A separate module from `work-items.js` on purpose: `work-items.js` owns the PLAN's domain and knows
nothing about the fleet; everything in `work-assign.js` reaches into xells, dispatch and the
queenzee. One module per direction keeps the plan usable with no fleet at all, and puts every
refusal in one readable place.

- **`assignWorkItem(id, { xell_id, actor })`** — links an existing xell: sets `work_item.xell_id`,
  moves `queued` → `assigned` (and *only* that transition — an item already `working` is further
  along than this verb knows), stamps the xell's newest `task.work_item_id`, and writes the ledger
  entry. All of it in ONE `inTransaction`, so a card is never linked without its task stamp.
  Re-assigning the same xell is an idempotent no-op — and a *self-healing* one: if an earlier attempt
  linked the xell but died before the status moved, the retry finishes the move.
- **`unassignWorkItem(id, { actor })`** — clears the link and the task stamp. It deliberately does
  **not** change the status: an item reached `working` because work happened, and taking the zee off
  does not un-happen it. Guessing a status backwards would overwrite the one thing the history is for.
- **`deployWorkItem(id, { task, model, mode, harness, actor, managerXellId })`** — the real verb.
  It DISPATCHES a fresh worker for the item and assigns it, through the **existing** dispatch paths
  (`selfDispatch` when a manager deploys, `dispatchXell` when the console does). There is
  deliberately no second spawn path: one here would be a hole punched straight through the manager
  layer's refusals (no prod, no manager type, no manager harness for a dispatched worker).
- **`candidatesFor(id)`** — the xells that could take this item: the ready pool plus live workers
  with no open item, in this project only. Never a manager, never production, never one being torn
  down, never the xell already on the item — a picker that offers a choice the server then rejects
  is worse than one that offers fewer.
- **`reportItemStatus(id, { status, progress, note, actor })`** — a zee (or a manager) reporting
  where the WORK has got to. Which moves are legal is `canTransition()`'s answer, not this file's.

It borrows rather than restates: the vocabulary (`isTerminal`/`canTransition`/`nextStatuses` — the
TERMINAL fence is *derived* from `WORK_STATUS`, not a second list), the transaction (`inTransaction`
+ `dbRunner`), the ledger (`logWorkEvent`, with part 1's own kinds and no invented seventh), the zee
chip (`liveZees`) and the id contract (`assertId`).

#### The refusals are the point

Every one is a full sentence with an HTTP code (`400` you asked wrong · `404` it does not exist ·
`409` it exists and the answer is still no), because the sentence is what a human reads:

| refused | why |
|---|---|
| a xell from another project | a xell only ever works in its own project |
| production | production is not a worker; it is what the work ships to |
| a MANAGER zee | a manager writes no code and lands none — it *dispatches* one that can |
| a xell retired or tearing down | its worktree is going away, and with it anything unlanded |
| a xell already on another open item | one zee, one item |
| deploying onto an item that already has a live zee | two agents on one job |
| deploying onto a `done`/`cancelled` item | a whole worker spent on work somebody ended |

#### The brief a deployed worker receives

`briefForWorkItem()` is pure and exported, so it can be read and tested without dispatching
anything. It folds the item's **title and body**, its **ancestor chain** (so the worker knows which
project/activity it sits under), its **linked ticket including the ticket's own words** (the card's
ticket read carries no body — the brief fetches it), its **dates/estimate/priority**, and the
deployer's extra `--task` text into one briefing, and closes with how to report progress and the
fact that reporting is not landing. This is why breaking a ticket down properly pays: a well-cut item
briefs its worker for free.

*(058 has no `acceptance` column; the item body and the ticket carry that substance today. If one is
ever added, `briefForWorkItem` already renders it.)*

### The board moves itself — `server/src/queenzee/worksync.js`

A 30 s queenzee tick (`WORKSYNC_ENABLED=false` to stop it, `WORKSYNC_INTERVAL_MS` to retune), same
shape as `queenzee/dbclone.js`. For every item with a live `xell_id`:

```
work_item.xell_id → liveZees() → the xell's HIVE STATUS → statusFromHive() → the item's status
```

`liveZees()` is part 1's own batched helper, used verbatim: the hive status a card is moved by must
be the one the hexagon shows and the one the board chip already prints, or the two eventually
disagree and nobody knows which is right.

**The policy, which is the load-bearing decision of the whole part:** the tick may only move an item
*between the in-flight statuses* — `assigned, working, blocked, review, shipping`, derived as
"neither terminal nor `queued`". It will never

- move an item to `done` or `cancelled` — **finishing is a decision**, and this repo is built on the
  rule that a decision belongs to a human: a push is held at the landing gate, a prod deploy is a
  request the queenzee performs only once someone approves it, a zee cannot mark even itself done.
  This is not hypothetical: `statusFromHive` really does map `occ-done` **and `occ-doneRequest`** to
  `done`, and both of those mean *the xell is being torn down or asking to be* — which says nothing
  about whether the work is complete. The fence is what stands between those two facts;
- move an item OUT of a terminal status — once a human has decided, no tick un-decides it;
- move a `queued` item — starting work is what assignment is for;
- touch an item nobody is on — no zee, no fact, it stays plan.

When the assigned xell is **gone** (retired, or its row deleted) the tick **notes it in the ledger
and changes nothing else** — not the status, and not the link:

> **`xell_id` is history. Liveness is resolved at READ time, never by nulling the column.**

That is policy 4 above, and part 3 obeys it rather than adding a second guard. `liveZees()` already
filters `retired`/`husk`/`error` and `hive-status.js` answers `null` for a retired row, so a stale id
cannot lie to anyone — the card comes back `zee: null, live_status: null` with the id still on it. A
write-time guard would be exactly the cache invalidation policy 4 warns about (missed by
`purgeDevXells`, by `recoverOrphanTeardowns` finishing a half-done reap, and by a human editing a
row), and it would cost the board its **provenance**: which agent was actually on this work. A
tracker that forgets that thirty seconds after a reap is less trustworthy, not more. So "was:
&lt;slug&gt;" renders from the column, with the ledger entry — a `kind:'assigned'` row whose `detail`
carries `zee_gone`, the id and the **denormalized slug** — as corroboration.

The note is written **once per dead xell**, not once per tick: the link survives now, so the branch
would otherwise restate itself every 30 seconds and turn an item's history into a stutter.

A `husk`/`error` xell is *not* treated as gone at all — it is awaiting housekeeping and may come
back, and `liveZees` already refuses to speak for it, so that card is left completely untouched.

Every move it makes is a `work_item_event` with `actor:'queenzee'`, so the history reads honestly as
"the board moved itself", and every move is announced as `{ kind, item }` — the shape this document
pins — so a console can patch a self-moving card without a refresh.

### The endpoints part 3 adds

| route | what |
|---|---|
| `POST /api/work-items/:id/assign` `{ xell_id }` | link an existing xell |
| `DELETE /api/work-items/:id/assign` | unlink (status untouched) |
| `POST /api/work-items/:id/deploy` `{ task?, model?, mode?, harness? }` | dispatch a worker for it |
| `GET /api/work-items/:id/candidates` | who could take it |

Same error contract as the rest of the section. Refusals from `work-assign.js` carry an explicit
`err.status` (a "that xell is a manager zee" 409 is not something a regex should have to guess at);
anything thrown out of `work-items.js` still falls through to `workErr`'s sentence matching.

### The cxell verbs (`scripts/zee` → `/api/xell/self/*`)

**Scope is resolved from the caller's TOKEN, never from a parameter.** A manager may touch any item
in its own project; a worker may touch only the item it is assigned to.

- **`zee work [--board] [--item <id>]`** — a MANAGER sees its project's plan in tree order
  (depth-first) with each item's status, assignee and live zee; `--board` drops the project root. A
  WORKER sees the one item it is executing, with the ancestors, ticket and history it was briefed
  from. A worker that knows which item it is executing can say so in its report.
- **`zee assign --item <id> --task "…"`** (MANAGER only) — deploys a worker for that item through
  the same path `zee dispatch` uses, so the worker is still stamped `manager_xell_id`, still seated
  next to its manager, still on its own throwaway db, and a manager still cannot hand it prod, the
  manager type or the manager harness. Returns the new worker's slug.
- **`zee item [<id>] --status <s> [--progress N] [--note "…"]`** — reports where the WORK has got
  to. Setting `done` is allowed (a report of fact) and explicitly does **not** touch the xell's own
  done/land/ship state. A worker may omit the id: the server resolves it from the token.

### The manuals — `db/migrations/059_work_tracker_verbs.sql`

A verb that is not in the manual does not exist to a zee. 059 teaches both, following 053 exactly in
spirit — anchored replacements inside the manual text stored in `harness.bundle`, guarded so they are
idempotent and simply **do not fire** when an anchor has moved (a human may have edited the manual in
the harness manager, and a half-rewritten manual is worse than an out-of-date one):

- the **manager** manual — `zee work`, `zee assign`, `zee item`, plus a paragraph on what the work
  tracker is and why a manager should break a ticket down before dispatching anybody. That harness is
  FILE-BACKED (`harnesses/manager/`, reloaded by `refreshHarnesses()` at every boot), so
  `harnesses/manager/memory/manager-zee-manual.md` is edited in the same commit — **edit both or they
  drift**. The test reverse-applies the migration to the file and re-applies it, so the two are
  proven byte-for-byte identical rather than merely similar.
- the **worker** manual (`zee-base`, DB-owned — a migration is the only way to change it) — `zee
  work`, `zee item`, and the fact that a worker may only touch its OWN item.

## Test

```sh
DATABASE_URL=… node test/work-tracker.test.mjs    # parts 1-2: the plan itself
DATABASE_URL=… node test/work-assign.test.mjs     # part 3: putting a zee on it
DATABASE_URL=… node test/reflections-ledger.test.mjs   # the reflections ledger + its console window
```

Stands up two throwaway projects (and one real xell, to exercise the live-zee derivation), covers
the root rule, ticket numbering, breakdown, path/depth on move, every refusal, closed_at
stamp/clear, the board and the gantt — and tears **everything** down in a `finally`, including the
`session_event` rows that would otherwise survive the project delete as orphans (house rule #1: no
test data).

`work-assign.test.mjs` does the same for part 3 on its own throwaway project and fleet (a manager, a
worker, a ready xell, one being torn down, a production xell and a foreign project): assignment and
its idempotence, every refusal and its code, the candidate picker, the deploy brief **with the
dispatch path stubbed** — a test never spawns an agent — the worksync fence in both directions
(including the `occ-done` → `done` hazard it exists for), the token-scoping of the three cxell
verbs, the SSE payload shape, and the proof that migration 059 and the manager harness file say the
same words. If 058 is not applied to the target database it **skips loudly** rather than passing.

## What parts 2–4 need to know

(How they actually used it, and what they built on top: [work-tracker-verbs.md](work-tracker-verbs.md).)

- **`work_item.xell_id`** is the zee currently on an item — read models resolve it only while
  the xell is LIVE (see policy 4); **`assignee`** is free text for when a
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
