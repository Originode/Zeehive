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
  for** (`harness.zee_type`, from `zee_type:` in its `HARNESS.yml`), and a xell may only wear a
  harness of its own type. `any` is reserved for the law layer (`core`), which every zee gets.

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
  managers is a fleet that grows sideways with nobody's consent.

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
- **Account picker.** The prompt buttons are one-per-connected-account, so clicking one *is* the
  choice; the manager is a single button, so it makes that choice inside the composer.

Model, autonomy mode, supervision (headless/attended) and pasted images are the shared controls, and
`createManagerZee` forwards all of them — `headless` and `images` used to be dropped on the floor.

## The verbs

Manager-only: `zee zees` (the crew read model), `zee dispatch`, `zee say`, `zee suggest-done`.
Open to any zee that has a manager: `zee report` (including the reflection) and `zee inbox`.
All of them are `/api/xell/self/*` calls scoped by the caller's own token, so a manager can only ever
reach **its own** crew, and a worker only its own manager.

`zee suggest-done` raises a `done_suggestion` row, lights `occ-doneSuggest` (`done?`) on the target's
hexagon and a card in the console. A human types **DONE** to confirm; that marks the task done and
reaps the cxell (commits collected first). There is no `/xell/self/` route that decides one.

## The reflection stage

When a ship succeeds, `queenzee/shipgate.js` re-invokes the shipping zee with a reflection prompt
(`queenzee/nudge.js`): review what actually went live, and report **improvements**, **errors/risks**
and **follow-ups** to your manager with `zee report --kind reflection`. It lands in the manager's
inbox (and is typed into its live session), or — with no manager — is recorded for the humans.

This is the only systematic feedback the fleet produces about its own work. A ship used to be the end
of a zee's story: the containers swapped, the card went quiet, and everything the zee had learned
died with the cxell, at the exact moment it knew the most.

## The rule about loopholes

The manager's manual (`harnesses/manager/memory/manager-zee-manual.md`) states, and the binding rules
repeat, that a manager must **never dispatch a worker in a way that gives it reach beyond its own
xell** — no touching the xource, another xell, production, `origin`, docker or any
hook/gate/firewall/CLI; no splitting a change so each half slips past a review; nothing on its behalf
that it is itself refused. A worker's only legitimate reach outside its xell is talking to its
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
- `db/migrations/053_manual_manager_crew.sql` — teaches the DB-owned worker manual the crew verbs and
  the reflection stage.
- `server/src/lib/managers.js` — the domain (crew, messages, done suggestions).
- `server/src/lib/manager-spawn.js` — adding one (human only) + the read-only prod bind.
- `server/src/lib/prod-readonly.js` — the SELECT-only role, minted and dropped.
- `server/src/queenzee/self.js` — the crew verbs + the manager refusals.
- `harnesses/manager/` — the persona, the `dispatch-brief` skill, and a manual of its own.
- `web/src/Manager.jsx` — "+ manager zee" (opens the composer) and the done-suggestion gate.
- `web/src/Dispatch.jsx` — the one composer, in its worker and `manager` variants.
- `test/manager-compose.test.mjs` — the console wiring for adding one, asserted statically.
- `test/manager-zee.test.mjs` — 55 assertions over all of it.
