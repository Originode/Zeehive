# ZEE MEET — peer-to-peer group chat for zees

**Status:** DESIGN — proposed, nothing built. Companion decision record:
[zee-meet-decision-record.md](zee-meet-decision-record.md).
**Author:** Architect (xell `i-want-agents-to-be-able-to-talk-to-each-oth-7d6667`)
**Date:** 2026-08-13
**Directive (verbatim):** *i want agents to be able to talk to each other via some sort of peer
to peer a2a chat session like a group chat via a zee meet verb. example if i say initiate a zee
meet, zee shows a conversation link or code then when i tell another zee to zee meet attend, it
will ask for the link, and i can give it, and zees can join and talk.*
**Built on:** the landed A2A protocol (docs/a2a-protocol-plan.md, P1–P4, DR-1..DR-8). This is the
group-chat surface on top of the same message plane.

---

## 1. The problem, as the human said it

Today, two zees talk **manager⇄worker only**: a manager `zee say`s its worker, a worker
`zee report`s its manager. The A2A wire already envelopes every one of those messages
(`meta.a2a` on `zee_message`, DR-3) and a conforming A2A peer can read them as Tasks. But:

- **There is no group.** A worker cannot talk to a sibling worker — `taskVisibleXellIds`
  (lib/a2a-read.js) is deliberately a worker's own conversations and a manager's crew. A group
  chat needs a set of participants that is neither "one worker's manager" nor "one manager's
  crew".
- **There is no invitation surface.** The human's flow is "initiate a zee meet" → "zee shows a
  conversation link or code" → "tell another zee to zee meet attend" → "give it the link" →
  "zees can join and talk". Nothing in the current verbs mints a shareable room code or lets a
  third zee join by code.
- **Delivery is point-to-point.** `postMessage` writes one `(from,to)` row and types it into one
  recipient's session. A group chat must land in *N* sessions with one human/agent action.

So `zee meet` is a **first-class group room**: a durable `a2a_meet` row (the room), a membership
set, a shared transcript, and a code a zee (or a human) can hand to another zee so it can attend.

## 2. Boundary

One room is one **meet**; a meet is a conversation with a **membership set** and a **shared
transcript** — not a fan-out of N private tasks, not a broadcast, not a thread on a work item.

| side | owns |
|---|---|
| **room** (`a2a_meet`) | identity (slug + code), title, founder, open/closed |
| **membership** (`a2a_meet_member`) | who may read and post; `role` founder/member; when they joined |
| **transcript** (`a2a_meet_message`) | every post, in order, attributed to a member xell |
| **delivery** | the queenzee notifies each live member's session (reusing `sendMessageToXell`); the transcript is the durable record |

The one boundary line that matters: **membership IS the visibility set.** A meet message is
readable exactly by the room's members and nobody else — the same "no new reach" rule DR-6 applied
to the zee_message plane. The A2A read side (ListTasks/GetTask) does **not** grow meet tasks in
this design; the meet transcript is served by its own read path (`zee meet --list`). Naming the
seam: a later record can project `a2a_meet_message` rows onto A2A Tasks with a deterministic
`conversationTaskId('a2a_meet', meet_id)` (the DR-8 machinery already in lib/a2a.js), reusing the
uuid-v5 infrastructure. Nothing behind that seam ships now.

**Who may create/attend.** Any live, non-retired zee may create a room and may attend any room by
code. This is the deliberate break from the crew scoping — it is what the human asked for
("when i tell another zee to zee meet attend") — and it is a *recorded* act: `a2a_meet_member`
says who attended what, when. A zee cannot attend a room outside its own project (a meet is
project-scoped; the code is only handed to zees of the same fleet). A human in the console can
create/close/read rooms too, but the verbs are agent-facing.

## 3. Interfaces

### 3.1 The code (the "conversation link or code")

A meet is addressed by a short, human-passable code of the form:

```
<meet-slug>/<token>
```

- `meet-slug` — the founder's xell slug, truncated to ~12 chars (`i-want-agents`). Gives a human
  a hint who started it.
- `token` — the last 6 hex chars of the meet's `id` (a uuid). 6 hex chars = 16.7M codes; a zee
  that cannot guess a sibling's slug cannot guess a code.
- Full form: `i-want-agents/ab12cd`. A zee can also paste the **full uuid**; the CLI accepts both.

The code is **derived**, never stored (house rule 7 — the slug/id are data). It is what the
founder's `zee meet create` prints and what an attender's `zee meet attend <code>` takes.

### 3.2 The CLI surface (`zee meet`)

One verb, three subcommands + two read forms:

```
zee meet create --title "…"                     → { code, meet_id, title, members:[me] }
zee meet attend <code>                           → { code, meet_id, title, members, joined:true|already }
zee meet say <code> --message "…"                → { code, posted, message:{...} }
zee meet --list | zee meet --status              → { ok, meets:[{code,title,members,unread,last_at}] }
zee meet --transcript <code>                     → { ok, meet:{code,title,members}, messages:[...] }
```

- `create` is also the **invitation**: the printed code is the thing a human copies into the next
  zee's briefing ("attend with `zee meet attend <code>`"). The room starts with the founder as its
  only member.
- `attend <code>` is idempotent (re-attending is a no-op that returns the room). Attending is how
  a zee joins; there is no approval step — the act is the audit (DR: no gate, recorded).
- `say <code> --message "…"` posts to the transcript and notifies live members. A member posting
  to a room it is not a member of is refused (must attend first).
- `--list`/`--status` shows the rooms the caller is a member of, newest first, with an unread-ish
  hint (messages since the caller's last read of that room).
- `--transcript <code>` is the read-back; it is how a newly attended zee catches up on what it
  missed.

### 3.3 The HTTP surface (self verbs)

Four routes, all token-scoped exactly like the other `/api/xell/self/*` verbs (resolveSelf):

| route | maps to | notes |
|---|---|---|
| `POST /api/xell/self/meet/create` | create the room + founder membership | body `{title}` → `{meet_id, code}` |
| `POST /api/xell/self/meet/attend` | resolve the code → insert membership (idempotent) | body `{code}` → `{meet_id, title, members}` |
| `POST /api/xell/self/meet/say` | insert a transcript row + notify members | body `{code, message}` → `{posted, message}` |
| `GET  /api/xell/self/meet` | the caller's rooms / a room's transcript | `?code=` for the transcript, else the list |

No `cancel`/`leave`/`close` in this design — see the decision record (DR: leave/close are the
named seam, not built; a room dies with its project via `ON DELETE CASCADE`, and a xell that is
reaped is dropped from membership by `ON DELETE SET NULL`).

### 3.4 The data contract

**`a2a_meet`** (the room):

| column | type | meaning |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | the meet's durable id; the code's token = last 6 hex |
| `project_id` | uuid NOT NULL REFERENCES project ON DELETE CASCADE | a room is project-scoped (only that project's zees attend) |
| `slug` | text | short human hint — the founder's xell slug, truncated |
| `title` | text NOT NULL | what the founder called it |
| `founder_xell_id` | uuid REFERENCES xell ON DELETE SET NULL | who created it (null if the founder is reaped) |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |
| `closed_at` | timestamptz | null while open (the named seam) |

**`a2a_meet_member`** (membership):

| column | type | meaning |
|---|---|---|
| `meet_id` | uuid NOT NULL REFERENCES a2a_meet ON DELETE CASCADE | |
| `xell_id` | uuid NOT NULL REFERENCES xell ON DELETE CASCADE | the member seat (DR-4: the xell is the agent, not the zee process) |
| `role` | text NOT NULL DEFAULT 'member' CHECK (role IN ('founder','member')) | |
| `joined_at` | timestamptz NOT NULL DEFAULT now() | the audit of "attended" |
| `last_read_at` | timestamptz | per-member read watermark for the unread hint |
| PK | (meet_id, xell_id) | one seat once |

**`a2a_meet_message`** (the transcript):

| column | type | meaning |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | |
| `meet_id` | uuid NOT NULL REFERENCES a2a_meet ON DELETE CASCADE | |
| `project_id` | uuid NOT NULL REFERENCES project ON DELETE CASCADE | denormalised for scoping queries |
| `from_xell_id` | uuid REFERENCES xell ON DELETE SET NULL | the poster (null if reaped) |
| `from_slug` | text | the poster's slug at post time |
| `body` | text NOT NULL | the message text (clipped to 20k like zee_message) |
| `kind` | text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','meet-note')) | `meet-note` reserved for system lines (e.g. "X joined") — the named seam |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

No envelope column: a meet message is a room post, not an A2A Task. `rowToMessage`-style
projection onto A2A Tasks is the named seam (§2).

### 3.5 Delivery — how a post reaches the room

A `zee meet say` does **two** writes:

1. **The transcript row** — durable, ordered, the room's memory. This is authoritative.
2. **Fan-out notifications** — for each *other* live member, best-effort `sendMessageToXell` with
   a short line (`💬 <slug> in <meet>: <text>`), exactly the machinery a manager's `zee say` uses.
   Delivery is fire-and-forget; a member mid-turn gets it queued/typed on its next turn (the
   three-way verdict already exists). A member that is not live simply reads the transcript with
   `zee meet --transcript` (or `--list` shows the unread hint).

No delivery row per recipient is written — the transcript is the record, not a fan-out of
`zee_message` rows (a group of N would otherwise spawn N private tasks that are neither private
nor tasks). The one thing delivery does not do is create new A2A Tasks.

## 4. Data shape — stored vs derived, authoritative

- **Stored:** the room, the membership, the transcript. All three are facts that outlive any code
  that reads them.
- **Derived:** the **code** (`slug/token`, from the meet id), the **unread hint** (`last_read_at`
  vs `max(created_at)`), the **member list** (a join), the **transcript** (the message rows).
- **Authoritative when they disagree:** the `a2a_meet_message` rows are the record of what was
  said. A delivery that failed is not a lie — the row is the truth and the delivery report says
  what actually reached each member (the same stance `postMessage` already takes: the row is the
  inbox, delivery is best-effort).
- **Who is authoritative for membership:** `a2a_meet_member`. Attending writes a row; being reaped
  deletes it (CASCADE); nothing else changes who is in the room.

## 5. Compatibility

- **The A2A plane is untouched.** No existing column, route, verb or test changes. `zee say`,
  `zee report`, `zee inbox`, `postMessage`, the envelope, `GetTask`/`ListTasks` all stay exactly
  as they are.
- **The CLI grows one verb** (`zee meet`) with subcommands. The drift test (section c) requires
  it to be advertised *and* implemented; section (e) requires it to be documented in the worker
  manual (a migration via `harness_memory_get/_put`, the 076/202 pattern). The manual migration is
  part of this delivery.
- **Half-deployed:** the migration is additive (`CREATE TABLE IF NOT EXISTS`), the routes are new,
  the CLI case is new. A server without the routes 404s a `zee meet` call (the CLI prints the
  refusal); a server with the routes but a database without the migration errors on the first
  query until the migration runs. There is no moment where old data is misread.
- **Rollback:** delete the three tables (or stop the routes + the CLI case). No other reader
  exists. The migration is forward-only in the ledger sense; undoing it is a manual DROP that
  touches only meet data.

## 6. Migration

One migration, `db/migrations/204_a2a_meet_group_chat_tables.sql` (number claimed via
`zee migration-number` on 2026-08-13): the three `CREATE TABLE IF NOT EXISTS` blocks + the
indexes that matter (`a2a_meet_member(meet_id)`, `a2a_meet_member(xell_id)`,
`a2a_meet_message(meet_id, created_at)`). The migration file triggers the queenzee's clone-db
switch for this xell; the build then rebuilds the app tier so the server picks up its own
`DATABASE_URL`.

The worker-manual migration (a second file, number claimed via `--again`) documents the `zee meet`
verb in the `cxell-zee-manual` harness memory entry, using `harness_memory_get/_put` by path —
the exact 202 pattern. It is part of this delivery because the drift test (section e) fails a
verb the manual does not name.

## 7. Verification plan

In this xell, against a `zee db-sandbox` (the assigned shared dev db refuses this xell's
credentials — see the decision record):

1. **Migration** applies clean to a fresh sandbox (`npm run db:migrate` with the sandbox DSN).
2. **The library functions** (create/attend/say/list/transcript) are unit/integration-tested in a
   new `test/a2a-meet.test.mjs`: a founder creates a room; a second (worker) xell attends by code;
   the founder posts; the second reads the transcript; a non-member is refused; a cross-project
   attend is refused. The project is deleted in a `finally` (house rule: tests clean up).
3. **The drift test** still passes with the new `zee meet` verb (section c + e).
4. **The real server** is built (`zee build server --wait`) and the routes are exercised over
   HTTP: create → attend → say → list, with two real worker xells' tokens if the sandbox allows;
   otherwise the route-level test against the sandbox DB is the evidence.

## 8. What would change this design

- **A "meet as A2A Task" requirement** — a peer wanting `GetTask` on a room — moves the §2 seam
  into the build (project `a2a_meet_message` onto Tasks with a deterministic id, reusing
  `conversationTaskId`).
- **An approval/closed-rooms requirement** — a human saying "rooms must be invite-only" — makes
  `attend` a request instead of an act, and adds a `closed_at` gate on `say`.
- **Cross-project or cross-fleet rooms** — federation is a different container; the meet stays
  project-scoped and the fleet card (§3.1 of the A2A plan) is the seam.
- **Leave/close** — named but not built; a human or a manager needing to close a room is the
  trigger (see the decision record, which records the shape).
