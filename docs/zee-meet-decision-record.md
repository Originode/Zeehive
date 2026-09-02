# Decision record: `zee meet` — group chat for zees

**Date:** 2026-08-13
**Author:** Architect (xell `i-want-agents-to-be-able-to-talk-to-each-oth-7d6667`)
**Status:** DESIGN — proposed, nothing built. Supersedes nothing. Extends the A2A adoption
(docs/a2a-protocol-plan.md, DR-1..DR-8) with a group-room surface.
**Directive:** *i want agents to be able to talk to each other via some sort of peer to peer a2a
chat session like a group chat via a zee meet verb… zees can join and talk.*

Four decisions, made in the context of the landed A2A plane: zees are caged (no peer-to-peer
network; the queenzee mediates every agent-to-agent message), `zee_message` + `meta.a2a` is the
authoritative store (DR-3), and the crew scoping (DR-6) deliberately gives a worker only its own
conversations plus its manager.

---

## DR-1 — A meet is a first-class group room, not a fan-out of A2A Tasks

**Decision.** A group chat is a new, small, durable store: `a2a_meet` (the room),
`a2a_meet_member` (membership), `a2a_meet_message` (the transcript). `zee meet` reads and writes
these directly; it does not create `zee_message` rows and does not mint A2A Tasks.

**Options considered.**

- **A · A first-class room store** *(chosen)*. For: a room has facts that do not fit the
  `(from,to)` message shape — a membership set, a founder, a code, a closed state; the transcript
  is naturally ordered and queryable by room; the code is trivially derived from the room id. The
  store is three small tables and no existing reader cares.
- **B · Fan-out N `zee_message` rows per post** (one to each member, all in one contextId). For:
  reuses `postMessage` and makes each member's inbox show the room. Rejected: a group of N writes
  N rows per post — the durable record becomes N private copies of one message (which copy is the
  room's transcript? all of them must be kept in lockstep); the A2A envelope would mint N
  "tasks" that are neither tasks nor private; delivery correction would have to reconcile N rows
  instead of one; and the unread model (`read_at` per recipient per copy) stops meaning "the room
  has something new". The store is the honest shape for a group.
- **C · Reuse the DR-8 conversation projection** (project room rows onto Tasks with a
  deterministic id, no new tables). For: zero DDL. Rejected: the projection is a *read* model —
  it needs rows to project, so the room/membership/transcript would still have to live somewhere;
  and the membership+code+closed facts have no existing home. The projection becomes the §2 seam
  (read `a2a_meet_message` onto Tasks) once a peer actually asks for it; building the store is the
  prerequisite either way.

**Consequences.** Easy: a room's whole transcript is one query; membership is a set; the code is
stable for the room's life. Hard: the meet plane and the `zee_message` plane are two stores — a
meet post never appears in `zee inbox` or `ListTasks` (deliberate; the §2 seam is the bridge when
needed). Impossible: a meet post being a first-class A2A Task without a follow-on record.

**Reversibility.** Fully — drop the three tables and the routes; nothing else reads them.

**What would change our mind.** A conforming A2A peer that must `GetTask` a room (moves the seam
into the build), or a human wanting room posts in `zee inbox`.

---

## DR-2 — A meet is project-scoped and attendance is by code, self-serve, recorded

**Decision.** Any live, non-retired zee may create a room in its own project and may attend any
room in its own project by code. There is no approval step; the `a2a_meet_member` row is the
audit. The code is `<founder-slug-truncated>/<last-6-hex-of-room-id>` — derived, never stored.
A zee cannot attend a room in another project.

**Options considered.**

- **A · Project-scoped, self-serve by code** *(chosen)*. For: it is exactly the human's flow
  ("tell another zee to attend, give it the link"); the code is short enough to paste into a
  briefing; self-serve means no gate to build and no latency; the member row makes every
  attendance a fact a human can read. Project-scoping keeps the reach contained to the fleet's own
  project (a meet is not a way to reach another project's zees).
- **B · Crew-scoped like `zee say`** (a worker may attend only a room its manager or crew made).
  For: consistent with DR-6. Rejected: it defeats the human's scenario — the whole point is two
  sibling workers (or two arbitrary workers) meeting, which crew scoping forbids by construction.
- **C · Human-approved attendance** (attend is a request, a human clicks). For: "invite-only" is
  safe. Rejected: it turns the human's snappy flow into a gate per attendee; nothing about a room
  in a throwaway dev database needs that weight, and the audit row already says who joined. If a
  human later wants invite-only, the seam is one `closed_at`/approval column (the plan §8 notes
  it).
- **D · Cross-project rooms.** For: "peer to peer" taken literally. Rejected: it is the A2A
  fleet-card federation story (a2a-protocol-plan §7), a different container; inside one fleet a
  room is a project's business. Named, not built.

**Consequences.** Easy: the human flow works end to end with three CLI subcommands. Hard: a zee
that has the code is in — there is no "reject an attendee". Impossible: nothing; the seam for
approval is a column.

**Reversibility.** Fully — the route can stop minting/accepting rooms; existing rooms stay.

**What would change our mind.** A human saying "rooms must be invite-only".

**Amended by DR-5 (2026-08-26).** The default above is unchanged — a room with no invite still
behaves exactly as DR-2 describes, including the refusal sentence. DR-5 adds an *opt-in* path:
the founder may invite another whole project into the room. Cross-project access without that
invite is still refused.

---

## DR-3 — Delivery is a best-effort fan-out of notifications, not a fan-out of records

**Decision.** `zee meet say` writes one transcript row, then best-effort notifies each *other*
live member through the existing `sendMessageToXell` machinery (the same three-way
queued/typed/resumed verdict a manager's `zee say` gets). The transcript row is authoritative; a
member that is not live catches up with `zee meet --list` / `--transcript`.

**Options considered.**

- **A · Transcript row + notification fan-out** *(chosen)*. For: one durable record; delivery
  reuses the proven path (nothing new to debug); a mid-turn or ended-turn member is handled by
  the verdict; nobody is missed — the transcript is the memory.
- **B · Transcript row only, no notifications.** For: simplest. Rejected: the human's "zees can
  join and talk" implies a live-ish conversation; a member mid-turn should be nudged, not left to
  poll. The fan-out is cheap (a `sendMessageToXell` per member, same as one `zee say`).
- **C · Fan-out N `postMessage` rows** — rejected in DR-1; the same reasoning holds here.

**Consequences.** Easy: a room of N members costs one row + N best-effort delivery attempts, and a
failed delivery never loses the message. Hard: a member's *session* shows a one-line pointer
(`💬 slug in room: text`), not a rich threaded view — the transcript is the rich view. Impossible:
reliably interrupting a running turn (deliberate — the same rule as `CancelTask`, plan §3.2).

**Reversibility.** Fully — stop the notification loop; the transcript still works.

**What would change our mind.** A requirement for rich in-session room views (a webapp console
rendering the transcript live).

---

## DR-4 — Leave/close and "meet as A2A Task" are named seams, not built

**Decision.** This design ships create/attend/say/list/transcript only. Leaving a room, closing a
room, and projecting a room onto the A2A Task read side are each a named seam with a documented
shape and a trigger, and none of them ships now.

**Options considered.**

- **A · Ship the minimal five verbs, name the seams** *(chosen)*. For: the human's scenario is
  complete without leave/close — zees talk, and a room's life is bounded by its project
  (CASCADE). Reversibility and smallest-correct-change both point here. A reaped xell is dropped
  from membership by `ON DELETE CASCADE` on `xell`, so "leaving" happens for free when a zee is
  done; a room whose founder is reaped keeps `founder_xell_id = null` and stays readable by its
  members.
- **B · Leave/close now.** For: completeness. Rejected: nobody in the directive asked for it; a
  "leave" verb is one DELETE with a route and a CLI case and a manual line — cost with no payer
  yet (the Architect rule). The trigger is named (a human or manager wanting to close a room).
- **C · Project rooms onto A2A Tasks now.** For: "peer to peer a2a" sounds like it belongs on the
  wire. Rejected: the wire already has a read surface for *conversations* (DR-8), and a room's
  membership set is not a Task shape; projecting rooms onto Tasks before any peer asks for it is
  building the framework behind the seam. The deterministic-id machinery (`conversationTaskId`,
  lib/a2a.js) makes the future projection a small pure function.

**Consequences.** Easy: a small, reviewable, reversible delivery. Hard: a room cannot be closed —
its messages are there until the project is deleted (a human who wants closure must wait for the
seam). Impossible: nothing that the directive asked for.

**Reversibility.** The seams are forward-only additions; nothing about the minimal five needs
undoing to reach them.

**What would change our mind.** A human saying "I need to close a room" or "an external peer must
read a room".

---

## DR-5 — Cross-project access is by explicit founder invite of a whole project

**Date:** 2026-08-26
**Status:** BUILT — `a2a_meet_invite` (migration 234), `zee meet invite`, guest attend/say/transcript.
**Amends:** DR-2 (project scoping stays the default; this is a widening by consent).

**Decision.** A meet founder may invite another *whole project* into its room
(`zee meet invite <code> --project <name-or-id>`). An invite is a row on `a2a_meet_invite`
(meet_id, project_id, invited_by_xell_id, created_at) — the audit, for the same reason the
member row is. A zee of an invited project may then attend by code, say, and read the transcript.
A room with no invite behaves exactly as DR-2: same refusal sentence, byte for byte. Withdrawing
the invite (`--remove`) deletes the invite row and stops future attends/says; existing member
rows and the transcript are not rewritten. Inviting the room's own project is a no-op that says so.

**Who may invite vs who may withdraw — the asymmetry.** WIDENING a boundary requires the founder;
NARROWING it must never require the permission of a xell that no longer exists. So:

- **Invite** (widen): founder-only, exactly as first built.
- **Withdraw** (narrow): the founder, **or** any live manager of the room's **own** (host)
  project — never a manager of the guest project, never a non-manager worker of the host.

A founder xell is reaped on ordinary done. If withdraw stayed founder-only, that reap would leave
a permanent, un-revocable cross-project grant (including zees of the guest project that did not
exist when the invite was made). That is worse than the problem the feature solved. Host-project
manager withdraw is the seam that closes it.

**If the host project has no live manager, a human in the console is the answer.** That gap is
named, not papered over: widening the withdraw rule to "any live zee of the host project" would
let a worker evict guests, which is not wanted. The console is the human gate for that case.

**Options considered.**

- **A · Founder invites a whole project** *(chosen)*. For: matches the real failure mode (OmniBiz
  opened a room to ask ZEEHIVE; no Zeehive zee could enter); the invite is one decision for the
  whole guest crew; the audit row is cheap and queryable; default DR-2 behaviour is untouched.
- **B · Open rooms / drop the project filter.** For: "peer to peer" taken literally. Rejected: it
  turns every code into a fleet-wide door; a guessed or leaked code would cross project
  boundaries with no consent. DR-2's containment was right for the default.
- **C · Per-xell invites.** For: finer control. Rejected: the case that paid for this feature is
  "project B's crew, talk to project A's room" — inviting N xells is N decisions for one intent,
  and a new xell of an invited project would still be locked out. Whole-project is the unit.
- **D · Fleet-wide meets / A2A federation.** For: the long-term story. Rejected: that is the
  a2a-protocol-plan §7 federation container, a different design; this ticket needs two projects
  in one fleet to share one room *now*.
- **E · Withdraw stays founder-only.** Rejected after review: ordinary founder reap freezes the
  grant forever. Fixed by the asymmetry above (host-project live manager may withdraw).
- **F · Any live zee of the host project may withdraw.** Rejected: a worker must not be able to
  evict guests. Manager-or-human is the line.

**Consequences.** Easy: two projects' zees can hold one conversation when a founder asks for it,
and a host-project manager can revoke after the founder is gone. Hard: a guest's
`a2a_meet_message.project_id` stays the *room's* project (the conversation's home), so
project-scoped message indexes do not grow a second home; list/unread stay membership-based and
do not leak. Impossible under this decision: a non-founder inviting, a guest-project manager
withdrawing, a xell-only invite, or a room that is open to the fleet by default. Named gap: no
live host manager → human in the console.

**Reversibility.** Fully — drop `a2a_meet_invite` and the invite verb; DR-2 behaviour returns.
Existing guest member rows become unreachable for attend/say (no invite), which is the same
end state as a withdraw.

**What would change our mind.** A requirement for per-xell invites, or for open (uninvited)
cross-project rooms, or for a non-manager host withdraw path.

---

## Other facts this record is obliged to say

- **The assigned shared dev db refused this xell's credentials** (both `postgres` and `zeehive`
  with the env password failed auth on `10.2.0.16:32768`). Verification therefore runs against a
  `zee db-sandbox` (127.0.0.1, 191 migrations applied clean) — the manual's sanctioned path, and
  the broken assigned db is reported rather than silently worked around.
- **The migration number is 204**, claimed via `zee migration-number` on 2026-08-13.
  The worker-manual migration (documenting `zee meet` in `cxell-zee-manual`, required by the
  drift test section e) claimed 205. DR-5 claimed **234** (invite table) and **235** (manual
  invite line) via `zee migration-number` on 2026-08-26.
