# Manager zees

> Added 2026-07-28 (migrations 052/053). The fleet's middle layer: a zee that runs other zees.

Until now every zee was a worker and every decision above a worker was a human's. That works while
one human watches a handful of xells; it stops working the moment the hive is big enough that
"which of these twelve needs me?" is itself a job. A **manager zee** is that job, given to an agent —
without giving it any of the powers the gates exist to withhold.

## Two axes: TYPE and HARNESS

They are not the same thing, and 054 stops them contradicting each other:

- **TYPE** (`xell.zee_type`: `worker` | `manager`) is what the QUEENZEE will and will not let this
  zee do — the refusals below. It is decided when the xell is created and it is structural.
- **HARNESS** is the persona, skills and MANUAL a zee wears. Each harness **declares the type it is
  for** (`harness.zee_type` on the row — since 080 there are no harness files), and a xell may only
  wear a harness of its own type. `any` is reserved for the law layer (`core`), which every zee gets.

Why the pairing must be enforced rather than trusted: a harness IS the manual for a type's verbs and
refusals. Hand the manager harness to a worker and you have taught it `zee dispatch`,
`zee suggest-done` and "you hold production read-only" — four doors it does not have — while removing
the one it does (landing). It would spend its turn hammering on refusals. So:

- the DB refuses the assignment (`xell_harness_type_guard`), from either direction — you cannot
  assign a mismatched harness, and you cannot retype a xell out from under the harness it wears;
- a harness cannot be **retyped** while a zee of the other type wears it, and cannot **inherit**
  across types (a manager harness parented on Zee Base would silently merge the worker manual — and
  `zee land` — into a manager's briefing);
- `assignHarness` refuses first with a sentence, so the console shows a reason, not a stack trace;
- every picker asks for the list it is allowed to offer (`GET /api/harnesses?zee_type=…`): the
  composer and the project-default picker show worker personas only; the harness manager shows all
  of them, with a **For zee type** selector when you author one.

## The shape

A manager is an ordinary xell (`xell.zee_type = 'manager'`) with its own cxell, its own hexagon and
its own token. What changes is the trade:

| It GAINS (fleet reach) | It LOSES (repo reach) |
|---|---|
| dispatch workers (stamped `manager_xell_id`) | **zero push/PR access to the xource** |
| converse with them in real time | it writes no code and lands none |
| read **production** (read-only role) | it may not escalate that to writes |
| suggest a xell is done (a human confirms) | it can never mark anything done |

**Shipping is deliberately not blocked.** Holding the production database is not a reason to withhold
the ship gate: a ship is still refused unless the work is landed, still approved by a human, and
still performed by the queenzee from main. A manager is often the right agent to ask for one — it is
the one holding the whole picture.

## How a manager READS in the console (2026-07-29)

A manager's hexagon is not a work-cell, and is no longer drawn as one. The honeycomb's worker card is
built around git — a head sha, a source diffstat, pull/land/PR — and every one of those describes
work a manager is structurally refused. So `web/src/hive/HiveCanvas.jsx` draws it in the **harness
badge's** visual language instead (`drawManagerHex`, beside `drawHarnessBadge`; both seat their
persona with the same `drawAvatarDisc`):

- a **dashed** seat — the badge's "part of the grid, but not a work-cell" tell — inside the
  prod-orange double wall that says "this one holds production";
- the **persona disc** of the harness it wears (its avatar art, else its glyph, else ⬢);
- `⬢ slug` on the seam over `manager · ⬡ N crew`, and the crew's **activity** (`N working · N
  waiting`) where a worker's diffstat sits — a manager's work is its crew;
- the same hive status pill every hexagon carries, and `🛡 read-only` where a worker's ship line is;
- **no head sha and no diffstat, anywhere on it.**

Its bloom keeps the five facets it owns (identity, branch, session, containers, machine) and swaps
the two git ones: petal 5 is **CREW** (one status-coloured dot per worker, the colour of that
worker's own hexagon) and petal 6 is **PROD · AGE**. Clicking either opens nothing — `diffPetal()`
returns null for a manager, so a petal that no longer shows a diff can never open the diff viewer.
The buttons follow the same rule (`petalVerbs`, pure and unit-tested): **pull, land and PR are
absent** — offering them would offer a human three clicks that can only return the refusal above —
while build, terminal, nudge, env, message, done and **ship** remain.

### Talking to it — the terminal is NOT read-only (2026-07-29)

A manager is the zee you most need to CONVERSE with: it writes no code, so everything it does for you
it does through a conversation. And it was the zee you could least reach. While its headless turn
ran, its cxell pane was the transcript feed — read-only in both directions — so anything typed at it
in the dashboard terminal was swallowed, and the 📨 button reported "typed into its live session" for
a message that reached nobody. Reported exactly as it felt: *"when i said readonly i didnt mean the
terminal was readonly"* (the read-only stance was about production and the fleet views, never this).

Now a message to a zee that is mid-turn is **queued in its cage and typed into its session the moment
the turn ends**, and the terminal carries a 💬 **talk** composer that says which of the two happened.
Nothing here is manager-specific — it is the same door for every cxell zee — but the manager is the
one whose job it was breaking. The mechanism is the TALK QUEUE in HANDOFF.md (`cxellTalkCommand` in
`server/src/lib/cxell.js`, drained by `docker/zeehive/zee-attach.sh`);
`zee say` between a manager and its crew rides the same path, so a worker that is mid-turn now
hears its manager too.

### Re-tasking the worker that already holds the context

There is a THIRD delivery, and it is the one that lets a manager hand more work to a zee whose turn
has already ENDED rather than spending a fresh xell on a worker with none of the context. The state
decides which one a message gets (`decideMessageDelivery`, `server/src/lib/zee-turn.js`), and the
answer says which happened rather than one word for all three:

| the zee | delivery | what it promises |
|---|---|---|
| its turn has **ENDED** | `resumed` | the queenzee RESUMES its session with your message as the prompt — it is acting on it now |
| it is **MID-TURN** | `queued` | held in its cage, typed in the moment this turn ends; it has **not** read it yet |
| its session cannot be re-invoked | `typed` | keystrokes into the interactive session in its pane |

A `resumed` message is a TURN, and the fleet says so: the zee row goes `working` (named, broadcast)
for the length of it and back to `idle` after, so `zee zees` and the hexagon show a messaged worker
working. That is not cosmetic — a manager once read a restarted worker as idle for a whole turn and
dispatched a second xell to redo work that was already being done. The same recording now covers
every other continuation (a landing approved or gone stale, a runway cleared, a post-ship reflection,
a fleet resume), because all of them come through the one resume.

⚠ A message can only start a turn a human has not stopped: a **fleet pause** still refuses it, and a
decommissioned zee or one in a retired xell is never restarted. And a `typed` turn stays invisible to
the fleet — nothing inside the cage reports turn-start/turn-end (see the KNOWN GAP in
`server/src/queenzee/reaper.js`).

### Its harness takes no cell of its own

A harness normally seats itself in the grid as its **own hexagon cell** (docs/harness-proposal.md §5)
and every xell wearing it has its wire routed through that cell. A manager is the exception, because
the manager hexagon described above **already is** that badge: same dashed seat, same
`drawAvatarDisc` persona. Seating the harness beside it drew the identical avatar twice and spent a
grid cell restating what the manager xell was already saying.

So `getTimeline()` splits the two questions it used to answer with one list:

| field | means | who is in it |
|---|---|---|
| `wearer_ids` | wears this harness | every live xell, **managers included** |
| `consumer_ids` | the badge is *for* it | wearers **minus** managers |

`consumer_ids` drives the cell and the series wire (`HiveCanvas.badgedHarnesses()`,
`Connectors.jsx`), so a harness worn by managers ONLY gets **no cell and no wire** — it still travels
in the payload because the manager hexagon needs its art. `wearer_ids` drives everything about
*wearing* it: the manager's persona lookup (`wearersOf`), the `×N` count on a badge, and the hover
highlight in all three views. Nothing else changes for a worker: it is in both lists, exactly as
before.

`test/manager-hexagon.test.mjs` holds that shape: it transforms the real JSX with esbuild, imports
it, and PAINTS the hexagon at each size against a recording 2D context, asserting what actually
landed on the canvas (and that nothing resembling a sha or a diffstat did). `web/demo.html` seats a
manager and its crew in the mock hive so it can be looked at without a live fleet.

## Why the refusals are structural

Every limit here is enforced somewhere a persuasive agent cannot reach, because a rule that lives
only in a prompt is a rule that lasts until the first clever workaround:

- **No push.** `server/src/queenzee/landgate.js` declines a push whose sha belongs to a manager xell
  and raises **no `land_request`** — so there is not even a card a human could approve. `xellgit.js`
  refuses in `ctx()`, the single door every git write verb passes through. `zee land` refuses with
  the explanation and the alternative (dispatch a worker). Three independent refusals; the first two
  hold even if the third is never called.
- **Read-only production.** The manager gets its **own postgres role** (`zee_ro_<slug>`) with
  `CONNECT` + `SELECT`, `default_transaction_read_only = on`, `NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  and `REVOKE CREATE ON SCHEMA public` (`lib/prod-readonly.js`). Writes are refused by the server,
  not by the agent's restraint. It **fails closed**: if the role cannot be minted, the bind fails —
  there is no fallback to the owner credential. The reaper drops the role with the xell.
  - **Which ADDRESS the DSN carries** is `decideReaderAddress()` (pure, table-tested), and it reuses
    shipmigrate's **`prodDbAddress()`** rather than a second resolver that could disagree with the
    guard deciding whether a write may happen. A prod db that **publishes a host:port** yields that;
    one registered **alias-only** (publishes nothing, reachable only on a docker network — Zeehive's
    own meta db) yields a DSN on the **network alias**, port from the `conn_ref` URL. A row carrying
    **neither** is still refused, now naming the project, the container row and the exact columns to
    fill. (Until 2026-07-28 the mint read `host`/`host_port` only, so an alias-only production made
    "add a manager zee" impossible — it SELECTed `conn_ref` in the same query and never used it.)
  - An alias is only true if the cage can **resolve** it. `ensureCxell()` puts every cxell on
    `zee-hive-net` and nothing else, so `connectCxellToProdNetwork()` joins **that one cxell** (only
    `db-prod-readonly`, only one network) to the prod db's network at cage build, and **fails the
    cage build** rather than hand a manager a DSN that cannot connect. An alias on **another docker
    context** is refused outright: a network on another daemon can never resolve from a cxell, which
    runs on the queenzee's own. Prefer registering a published `host`/`host_port` — it needs no join,
    and docker network membership is per-network, not per-container.
- **One level deep.** The 052 guard trigger refuses a manager with a manager, a worker reporting to
  a worker, anything managing itself, and production being (or having) a manager.
- **Type and manual cannot drift apart.** See the two-axis section above: a manager always wears a
  manager harness, a worker never does, and neither can be switched to make it otherwise.
- **Managers are added by humans only.** `zee dispatch` refuses `role=manager` and refuses to hand a
  worker the manager harness or a database of the dispatcher's choosing. A manager that could mint
  managers is a fleet that grows sideways with nobody's consent. Since 084 a manager may mint
  **worker** personas of its own (`zee harness`, below) — and that verb refuses a manager persona for
  exactly this reason, in the same file as the dispatch refusal.
- **One project's personas stay in one project.** A manager authors harnesses scoped to its own project
  (`harness.project_id`, 084), and the scope rule is enforced in DB triggers from both directions: a
  xell may only wear a harness that is global or its own project's, a harness may only inherit one that
  is global or in its own project (inheritance merges TEXT), and it cannot be re-scoped out from under
  the xells wearing it. Every system-wide harness is off-limits to it entirely.

## Adding one: the programme is a PROMPT, so it gets the composer

`⬢ + manager zee` (`web/src/Manager.jsx`) opens the **same modal a worker prompt is written in** —
`web/src/Dispatch.jsx` with `manager` set — and POSTs the result to `/api/managers`. It used to be a
one-line `showPrompt()` `<input>`, which had the manager's **programme** (the standing brief an agent
runs a whole crew from, and the longest-lived prompt in the fleet) typed blind into a text field:
nothing visible past ~60 characters, no paste of a backlog or a screenshot, Enter fires it, and no
choice of model, autonomy, harness or account. The worker below it had the full composer.

One composer, and the manager variant differs only where a manager genuinely differs:

- **Harnesses offered are manager-type** (`GET /api/harnesses?zee_type=manager`) — 054's guard would
  refuse a worker persona anyway — and **"core only" is not offered**: a manager's manual *is* its
  harness, and a manager that has not read it does not know which doors it has.
- **No production-DB toggle.** Adding a manager mints its SELECT-only role and binds it, failing
  closed. A switch would be a lie in both positions, so the field states the fact instead.
- **A blank programme is legal** and means `DEFAULT_MANAGER_BRIEF` (study the project, propose a
  plan, ask a human before starting a crew) — the footer says so rather than leaving you to guess.
- **Persona, provider and account are all picked inside it.** The worker prompt buttons are
  one-per-HARNESS (docs/harness-proposal.md §3.2d), so clicking one pins the persona and the
  composer derives the rest of the choices from its model policy. The manager is a single button for
  the whole fleet, so it picks the persona in here too — and re-asks
  `GET /api/dispatch/options?zee_type=manager&harness=…` whenever that changes, which is what keeps
  the providers, accounts and models it offers to the ones the spawn would actually accept.

Model, autonomy mode, supervision (headless/attended) and pasted attachments are the shared controls,
and `createManagerZee` forwards all of them — `headless` and `images` (the wire field's legacy name)
used to be dropped on the floor.

## The verbs

Manager-only: `zee zees` (the crew read model), `zee dispatch`, `zee swap`, `zee say`,
`zee suggest-done`, `zee harness`. Open to any zee that has a manager: `zee report` (including the
reflection) and `zee inbox`. All of them are `/api/xell/self/*` calls scoped by the caller's own token,
so a manager can only ever reach **its own** crew, and a worker only its own manager.

### `zee swap` — a different zee, the SAME xell

`POST /api/xell/self/swap` `{ to, harness, task?, model?, mode? }`. Replaces the zee working one of the
manager's own crew xells with a fresh one wearing a different **worker** harness, and keeps the xell:
same branch, same commits, same containers, same database, same work-item card, same
`manager_xell_id`. `zee dispatch` can only ever open a NEW xell, so before this the only way to change
the persona on a job was to abandon the job — which is why no manager ever ran a Scout, then a
Builder, then a Reviewer over one piece of work.

**Why it is a verb in the server and not "re-dispatch into the same xell".** `dispatchXell` →
`spawnCxell` → `ensureCxell` runs `docker rm -f <cage>`, and `cloneIntoCxell` re-clones `/work/repo`
from the **host worktree**. A caged zee's commits live inside its container until something collects
them, and only the land/build/sync paths do — so a zee that committed and never landed has work that
exists in exactly one place, and the recreate destroys it. `selfSwap` therefore calls
`collectCxellDiffToWorktree()` **first** and **refuses the whole swap** when the collect fails on a
running cage. `test/manager-swap.test.mjs` reads that ordering out of a recorded docker call log
rather than trusting the comment.

It dispatches with `rename: false` (added to `dispatchXell` for this): a rename moves the branch, the
worktree folder, the container names and the ports, which is exactly what a swap promises not to do.
The outgoing `zee` row is retired (`status='stopped'`, `last_stop_reason` naming the manager and the
incoming persona), never deleted — it is the record of what that agent did.

The incoming zee is briefed as an **inheritor** (`swapBrief()`): the branch already carries work, what
the previous zee was asked to do, what it last reported, a git summary of the branch, and the card it
is on. A fresh zee that re-reads the whole repo and re-does the previous phase is the failure mode the
verb exists to remove.

Refused, each with a sentence: a xell that is not this manager's crew, a manager target, a manager
harness, another project's persona — and any xell with a **human gate open** on it (a pending/approved/
holding `land_request`, a pending ship, an open done suggestion), because swapping under an open card
points a human's decision at a zee that no longer exists.

#### …and the same thing from the CONSOLE (`POST /api/xells/:id/swap`)

A human swaps from the honeycomb: the flower's **branch petal** carries `♻ swap zee` beside
`✓ mark done` — deliberately side by side, because they are each other's alternative (swap keeps the
xell and changes who is in it; done tears it down), and "the persona in this xell is wrong" used to
have only the destructive answer. `web/src/SwapZee.jsx` picks the persona (only ones valid for that
xell's `zee_type`), optionally a brief/model/mode, and the refusal is shown as **the server's own
sentence** in a toast.

**Both callers run ONE function**: `swapZeeInXell()` in `server/src/queenzee/self.js`. `selfSwap` is
the manager's *authorisation* in front of it (my crew, a worker target, a worker persona of my
project); `swapXellZeeAsHuman()` is the human's (any non-retired xell in the project, crew or not — a
human already dispatches into any xell, so this grants no new authority and opens no gate). The
collect-before-recreate ordering, the open-gate refusal, the retire, the `rename:false` re-dispatch and
the handover live in the core, once — a second copy in a route would be a second path to
`docker rm -f` with no collect in front of it. `test/human-swap.test.mjs` asserts that ordering
through the HUMAN entry point and that neither caller collects or dispatches on its own.

Two rules the core adds for both: the persona's `zee_type` must **match the xell's** (a swap changes
who is in a xell, never what the xell is), and a **manager xell is refused** — re-dispatching one
re-mints its production read-only role (a live `CREATE/ALTER ROLE` + password rotation), which must
not ride behind a re-crewing click.

And when a human swaps a xell that **has** a manager, that manager is **told**
(`notifyManagerOfSwap()` in `lib/managers.js` — a report in its inbox, typed into its live session if
it has one). Otherwise it goes on briefing a persona that left: it says
`zee say --to <slug>` expecting the Scout it dispatched and a Reviewer answers. The incoming zee's
handover says a **human** put it there, and still carries the manager block so it knows who is
watching.

### `zee harness` — minting the crew's ROLES (migration 084)

A crew needs roles, and until 084 every persona was system-wide and only a human could add one: a
manager that wanted a specialist had to ask, wait, and then watch it appear in every other project's
picker. So a manager authors **worker personas scoped to its own project**.

| verb | route | what it does |
|---|---|---|
| `zee harness` | `GET /api/xell/self/harnesses` | the personas this project may use — the system-wide ones plus its own, each marked with whether it is the manager's to edit |
| `zee harness <key>` | `GET /api/xell/self/harness/:key` | read one: its own text in full, the inherited chain **described** (a persona's inherited manual is 30k+ characters the caller already carries) |
| `zee harness --new --label "…" [--parent <key>] [--spec <file.json>]` | `POST /api/xell/self/harness` | create one, scoped to the caller's project |
| `zee harness <key> --label/--summary/--personality-file/--spec/--parent/--enabled` | `PUT /api/xell/self/harness/:key` | edit it |
| `zee harness <key> --delete` | `DELETE /api/xell/self/harness/:key` | delete it |

Persona TEXT comes from files (`--personality-file`, `--spec <file.json>` carrying
`{personality, summary, glyph, skills[], memory[]}`), because a 3k personality does not belong in a
shell flag. It is **not human-gated**, for the same reason `zee dispatch` is not: what it produces is
visible to one project and can only ever be worn by a caged worker whose every irreversible act still
lands on the same human gates.

The **stored key is derived**, not chosen: the project plus the label, slugged (`zee harness --new
--label "Security Reviewer"` in project `acme` → `acme-security-reviewer`). A caller-supplied `key` is
refused rather than silently rewritten. That is because a key is unique across every scope and it is
how a harness is addressed *outside* its project — `--harness <key>` on a dispatch, and
`harness_memory_put('<key>', …)` in a fleet-wide migration — so a chosen one could take a name the
fleet needs, and the uniqueness collision doubled as an existence oracle for other projects' rows. A
collision inside the caller's own project names its own row; one with a row it cannot see is
disambiguated silently and disclosed to nobody.

The refusals are the interesting half, and they are structural (`self.js`, plus 084's triggers under
them). A manager may **not**: create or edit a **manager** persona (a fleet that mints its own bosses
grows sideways with nobody's consent); touch **any** system-wide harness — the refusal points it at
`--parent <key>` instead, which is the supported way to build on one; touch another project's harness,
or inherit one, or dispatch a worker into one; set anything that is not persona (`is_law_core`,
`bridge`, `project_id` — that last one because the project is resolved from its **token**); give one of
its own personas a memory or skill entry that lands on a file path it **inherits** (a leaf that could
take `.zeehive/harness/memory/cxell-zee-manual.md` could forge the manual its workers are told to
trust — the merge gives an inherited path to the ancestor as well, so a row written past the API cannot
shadow one either); or **delete or disable** a harness a **live** xell is wearing *or inheriting*, both
of which end with a running zee whose next briefing has lost the chain. Each one answers with a
sentence naming what to do instead. `test/harness-project-scope.test.mjs` fires the scope refusals and
`test/harness-manager-guards.test.mjs` the forgery/removal ones, one assertion each.

What it MAY inherit is the whole point: a global worker harness (`zee-base` for the cxell manual,
`dev-base` for the dev craft) or one of its own project's, so a new role starts from the fleet's craft
and adds only this project's specifics.

`zee suggest-done` raises a `done_suggestion` row, lights `occ-doneSuggest` (`done?`) on the target's
hexagon and a card in the console. A human types **DONE** to confirm; that marks the task done and
reaps the cxell (commits collected first). There is no `/xell/self/` route that decides one. If the
reap refuses because the xell is mid-turn, the decision is **held** (`approved-held`, ticket #75): the
card stays up as "Approved — waiting for the turn to end", the held-done reaper closes the xell
automatically the moment the turn ends, and a human can still close it immediately with **Close it
anyway** — a deliberate force that tears the live turn down, typed **CLOSE**.

## The reflection stage

When a ship succeeds, `queenzee/shipgate.js` re-invokes the shipping zee with a reflection prompt
(`queenzee/nudge.js`): review what actually went live, and report **improvements**, **errors/risks**
and **follow-ups** to your manager with `zee report --kind reflection`. It lands in the manager's
inbox (and is typed into its live session), or — with no manager — is recorded for the humans.

This is the only systematic feedback the fleet produces about its own work. A ship used to be the end
of a zee's story: the containers swapped, the card went quiet, and everything the zee had learned
died with the cxell, at the exact moment it knew the most.

## The rule about loopholes

The manager's manual (the `manager` harness's `memory/manager-zee-manual.md` entry, in the meta-DB)
states, and the binding rules repeat, that a manager must **never dispatch a worker in a way that
gives it reach beyond its own xell** — no touching the xource, another xell, production, `origin`,
docker or any hook/gate/firewall/CLI; no splitting a change so each half slips past a review; nothing
on its behalf that it is itself refused. A worker's only legitimate reach outside its xell is talking to its
manager and to the queenzee.

The worker manual (migration 053) carries the **other half**: if a manager ever asks for one of those
things, the worker refuses and raises it with `zee tend`. Neither side is trusted to police itself,
because an instruction is not more legitimate for having come from another agent.

## The honeycomb

Workers are **seated next to their manager**: `web/src/hive/HiveCanvas.jsx → seatXells()` places each
manager, fills the free cells nearest it (ring by ring) with its crew, and only then lays everyone
else out in reading order. A manager's hexagon is double-walled in production orange; its workers
name the crew they belong to. With no managers in the fleet the layout is exactly what it was.

## Files

- `db/migrations/052_manager_zee.sql` — the type column, `manager_xell_id`, `zee_message`,
  `done_suggestion`, `db-prod-readonly`, `prod_ro_dsn`, the guard trigger, the manager harness row.
- `db/migrations/054_zee_type.sql` — renames `xell.role` → `xell.zee_type`, adds `harness.zee_type`,
  and the two triggers that keep type and harness in agreement.
- `db/migrations/084_harness_project_scope.sql` — `harness.project_id` (NULL = system-wide, the
  default) and the three scope triggers: wearing, re-scoping/inheriting, and the project default.
- `db/migrations/053_manual_manager_crew.sql` — teaches the DB-owned worker manual the crew verbs and
  the reflection stage.
- `server/src/lib/managers.js` — the domain (crew, messages, done suggestions).
- `server/src/lib/manager-spawn.js` — adding one (human only) + the read-only prod bind.
- `server/src/lib/prod-readonly.js` — the SELECT-only role, minted and dropped.
- `server/src/queenzee/self.js` — the crew verbs + the manager refusals.
- the `manager` harness ROW in the meta-DB (080) — the persona, the `dispatch-brief` skill and a
  manual of its own; edited in the console's harness manager or by migration, never on disk.
- `web/src/Manager.jsx` — "+ manager zee" (opens the composer) and the done-suggestion gate.
- `web/src/Dispatch.jsx` — the one composer, in its worker and `manager` variants.
- `test/manager-compose.test.mjs` — the console wiring for adding one, asserted statically.
- `test/manager-zee.test.mjs` — 55 assertions over all of it.
