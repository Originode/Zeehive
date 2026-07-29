# CLAUDE.md — start here

**ZEEHIVE** is a deterministic agent-environment orchestrator: it cuts isolated environments
(**xells**), runs agents (**zees**) inside caged containers (**cxells**), and puts a human gate in
front of everything irreversible. It orchestrates itself — work on ZEEHIVE happens in ZEEHIVE xells.

Read this file, then [README.md](README.md). That is the whole orientation. **Everything else in
this repo is reference, not instructions** — see the doc map at the bottom, and read the warning
about `HANDOFF.md` before you open it.

---

## 1. First: work out which surface you are on

The repo is worked on from two places, and they have **different, non-overlapping toolsets**. Nearly
every orientation mistake made here is a zee running the other surface's verbs.

```sh
# One command tells you:
test -n "$ZEEHIVE_XELL_TOKEN" && echo "CXELL (caged zee)" || echo "HOST (or plain checkout)"
```

| | **cxell zee** (almost certainly you) | **host session / human** |
|---|---|---|
| workspace | `/work/repo` — a private clone of YOUR branch | a real checkout of the project |
| docker | **none.** No CLI, no socket | the daemon, contexts, compose |
| host filesystem | **none.** The repo is all you can see | all of it |
| network | default-DROP egress: `api.anthropic.com`, your own containers, the queenzee API | whatever the machine has |
| verbs | the **`zee`** CLI (§2) | `scripts/xell-*.mjs`, `skill/`, the console, MCP |
| main/master | **not a ref in here** — `git fetch`/`git rebase main` cannot work; use `zee sync` | normal git |

If you are in a cxell, **the host column does not exist for you**. `docker`, `docker --context …`,
`scripts/provision-xell.sh`, the `/xell` slash-commands and the MCP server are all real code in this
repo and all unreachable from your cage — by design, not by outage. Do not try to route around it;
the cage is the product working.

## 2. If you are a cxell zee

**Your manual is `.zeehive/harness/memory/cxell-zee-manual.md`, in your own workspace** — every verb,
its gate, and the golden rules. It is authoritative and it is delivered to your xell from the meta-DB
(harness `zee-base`), so it is always current for the queenzee you are talking to. It is deliberately
**not** a file in `docs/`: a checked-in copy would rot the day the API moved. That path is INJECTED,
not tracked (`.gitignore`) — it is there when you Read it and it is not part of any diff you land, so
never commit it and never "restore" it if a merge disagrees with it.

The shape of it:

- **`zee build [server|webapp|all] [--wait]`** — the ONE verb that acts immediately, because
  building your own throwaway containers needs no human. **Commit first** (it builds your commits),
  and run `--wait` in the **background** — never hand-roll a `curl | grep` poll against your own app.
- **Everything else is only a REQUEST** that lands on a human: `zee land` (push to main),
  `zee ship` (deploy prod), `zee prod` / `zee seed` (prod data), `zee done` (finish).
  You never hold the prod lock and you never despawn yourself.
- **`zee sync`** is how you rebase/catch up (the queenzee delivers current main INTO the cage and
  merges it). **`zee db-catchup`** is the same idea one layer down, for your database.
- **`zee status`**, **`zee work`**, **`zee working`**, **`zee tend --reason "…"`** to orient, report
  and ask for a human.

**Commit early and often.** A commit moves only your branch ref — it lands nothing, touches no one,
and it is the only thing protecting your work.

## 3. Running and verifying your change

Your database is your own container (`DATABASE_URL` in `.zeehive.env`, which is **generated** — do
not edit it). It is a throwaway copy: migrate, seed or destroy it freely.

```sh
set -a; . ./.zeehive.env; set +a     # DATABASE_URL + this xell's ports and safety flags

npm install
npm run db:migrate                   # db/migrations/*.sql, forward-only, filename-ordered
npm run server                       # queenzee + API on $PORT
npm run web                          # console on $ZEEHIVE_WEB_PORT
npm run dev                          # both

node test/<name>.test.mjs            # tests are standalone node scripts, no runner
```

There is **no `npm test`**. Each file in `test/` is run directly and prints `✓`/`✗ FAIL` lines; the
integration ones stand up real git repos and throwaway postgres rows against `DATABASE_URL`. Run the
ones your change touches, and add to them the same way — the existing tests document what they cover
in a header comment, and that header is part of the deliverable.

A Zeehive xell inherits **simulate-mode safety defaults** (`zeehive.yml` → `BUILD_MODE`,
`PROVISION_MODE`, `SHIP_MODE` = `simulate`, `POOL_TARGET_READY=0`): the nested queenzee you run is a
subject under test and can never touch the real fleet. That is why your local run provisions nothing.

**"I wrote it" is not verification.** Exercise the real thing in your own containers before you call
the work done.

## 4. Layout

```
db/migrations/   forward-only, filename-ordered SQL. The FOLDER is the truth — never a list in a doc.
                 The manual + spawn briefing zees read are SEEDED here too (into harness `zee-base`),
                 so changing what a zee is told is a MIGRATION, not a doc edit.
server/src/
  api/routes.js  every HTTP route (hooks, claim, the gates, /xell/self/* verbs, SSE stream)
  queenzee/      the loops: pool, intake, monitor, landing + landgate + landingpad, shipgate +
                 shipmigrate, seedgate, reaper, maintenance, dbclone, proddiff, worksync, self
  lib/           provision, cxell driver, git, harness, work-items, remote-git (clone/pull, no
                 push), projects, fleet, notify, …
  db/            migrate.js, seed.js  (seed_demo.js is DEAD — see house rules)
web/src/         the console (React + Vite): App.jsx, hive/ (honeycomb canvas), work/ (board+gantt),
                 Landing.jsx · Ship.jsx · ProdData.jsx (the human GATES), ZeeTerminal.jsx, DiffViewer.jsx
harnesses/       persona/skill/memory layers a xell wears (core, hermes, manager, …)
hooks/           land-gate-update.sh (the xource push gate), prod-guard.mjs (+ its canary)
scripts/         provisioning/build/ship/land scripts, and `zee` — the ONE copy of the in-cxell CLI
docker/zeehive/  Dockerfile.{server,web,zee-agent}, compose, and the deployment playbook (README.md)
mcp/server.js    MCP server wrapping the API (host surface)
skill/           source of the `/xell*` slash-commands (host surface)
test/            standalone integration tests (see §3)
docs/            specs and rationale (see the doc map)
```

## 5. House rules (learned the hard way — do not relearn them)

1. **No test data.** `server/src/db/seed_demo.js` exists; never run it. Tests clean up what they
   create, in a `finally`, whatever happens.
2. **Never touch a xell you did not create**, and never one you were not given. A past session
   reaped a live zee mid-task and lost real work.
3. **`origin` is off-limits.** Zees land with `git push . HEAD:main` (from a cxell: `zee land`),
   which a git hook on the xource **holds for a human**. Publishing outward is a human's click.
4. **A human marks a xell done**, not the zee.
5. **Builds go through the queenzee** (`zee build`), never ad-hoc docker or compose.
6. **Prod data is never a default** — `db-shared-prod` is the live database and must be asked for.
   When the job is really "rows into prod", that is `zee seed`, not a bind.
7. **Names, containers, couplings and status are DATA** — they live in the meta-DB and the API
   resolves them live. Never restate one in a doc; a container name written into prose is stale at
   the next rebuild, and one of those sent zees at an exited husk for weeks.
8. **What a zee is told is versioned like code.** The manual, the briefing and the CLI usage must
   move together (`test/cxell-cli-drift.test.mjs` fails the build if they drift).

## 6. Doc map — which file answers what

| you want | read |
|---|---|
| what ZEEHIVE is, the vocabulary, the gates | [README.md](README.md) |
| **your verbs as a caged zee** | `.zeehive/harness/memory/cxell-zee-manual.md` (in your xell) |
| a zee that runs other zees | [docs/manager-zees.md](docs/manager-zees.md) |
| tickets, work items, the board | [docs/work-tracker.md](docs/work-tracker.md) (nouns) · [docs/work-tracker-verbs.md](docs/work-tracker-verbs.md) (verbs) |
| harnesses (persona/skill/memory layers) | [docs/harness-proposal.md](docs/harness-proposal.md) |
| the role-specialised worker personas (Scout, Builder, Reviewer, …) | [docs/dev-crew.md](docs/dev-crew.md) |
| the manager harness that runs that crew | [docs/dev-crew-lead.md](docs/dev-crew-lead.md) |
| how a zee's db catches up to prod's schema | [docs/schema-catchup-plan.md](docs/schema-catchup-plan.md) |
| projects, manifests, deploy sites | [docs/deploy-topology-spec.md](docs/deploy-topology-spec.md) |
| what runs where in production, and the cutover | [docker/zeehive/README.md](docker/zeehive/README.md) |
| **why** a gate is shaped the way it is; traps already paid for | [HANDOFF.md](HANDOFF.md) — **history, not instructions** |

⚠ **About `HANDOFF.md`.** It is the rationale of record — the reasoning behind the landing gate, the
ship gate, the prod guard, and a list of expensive mistakes worth not repeating. Code comments cite
it. But it was written for a **host** session on one Windows machine in an earlier era of this repo,
and zees have repeatedly read it as their orientation and gone chasing paths, containers and verbs
that do not exist here. **This file is your orientation; HANDOFF.md is background reading.** Anything
in it that names a drive letter, a docker context or a machine is history — check before you trust.
