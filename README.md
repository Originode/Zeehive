# ZEEHIVE

A deterministic agent-environment orchestrator that **runs itself**: start it against nothing,
and it clones this repo from GitHub, onboards itself as its first project, and is ready to cut
isolated environments for AI agents to work in.

## Self-start

Requirements: Docker (with compose). No checkout, no build — published images:

```sh
curl -fsSLO https://raw.githubusercontent.com/Originode/Zeehive/master/docker-compose.bootstrap.yml
docker compose -f docker-compose.bootstrap.yml up -d
```

(Developing ZEEHIVE itself? Clone the repo and build from source instead:
`docker network create zee-hive-net`, then
`docker compose -f docker/zeehive/docker-compose.prod.yml up -d --build meta-db server web`.
That file is the build-from-source twin of the bootstrap one — same project name, same container
names, same ports — so a stack booted either way is shippable by the same scripts.)

That's the whole loop. On first boot the server migrates its **own fresh meta-DB**
(`zeehive_meta_data` volume), then **self-onboards**: it clones this repo into the `zeehive_repos`
volume, registers it as the `Zeehive` project with a pull-only GitHub remote, installs the
landing gate, and sets the spawn template. The console is on **http://localhost:5180**
(API :4700; the from-source developer compose uses :4701 to coexist with a live instance).

To actually dispatch an agent you need one credential: Project setup → **Tokens** → connect
Claude (`claude setup-token`). Then raise the **pool target** and pre-warmed xells appear —
each with its own worktree, branch, and database container. Type a task into **+ new prompt**
and a zee goes to work in one.

- Self-onboard from a fork: set `ZEEHIVE_SELF_REMOTE` (and `ZEEHIVE_GITHUB_TOKEN` for a private
  repo — a fine-grained PAT with Contents: Read-only) in `docker/zeehive/.env`.
- A truly fresh re-run is: delete the `zeehive_meta_data` + `zeehive_repos` volumes and
  `up -d` again.

## The vocabulary

- **xource** — the source a *xell* branches from: the project's local clone and its main branch.
  Read-only to xells. Synced from GitHub **inbound-only** (clone + fast-forward pull); nothing in
  ZEEHIVE ever pushes to a remote — pushing is a human act.
- **xell** — an isolated environment: a git worktree + its own branch + its own containers
  (per-xell database, server, webapp) + generated config (`.zeehive.env`). The unit the
  orchestrator pools, spawns, tracks, and tears down.
- **cxell** — a *caged xell*: the locked-down container a headless zee actually works in
  (`cxell_<slug>` on the `zee-hive-net` network). No docker socket, no host filesystem, a
  default-deny egress firewall — the queenzee API is its only door out, and every privileged
  verb behind that door lands on a human gate. The repo enters as a git bundle; commits leave
  the same way. See [docs/cxell-zee-manual.md](docs/cxell-zee-manual.md).
- **zee** — an agent (a Claude session) bound to exactly one xell, running inside its cxell.
- **queenzee** — the orchestrator. **Pure script, no AI.** It provisions/reaps deterministically,
  keeps the pool warm, monitors health, runs maintenance, and executes the privileged actions
  humans approve. AI is invoked only at dispatch — never in routine loops.

The insight: **provisioning is 100% deterministic and belongs in a script; the AI should only do
the actual work, starting from a proven-correct environment — and anything irreversible needs a
human's click.**

## The gates (how nothing irreversible happens on an agent's say-so)

- **Landing gate** — a zee lands work with `git push . HEAD:main` inside its xell; a git `update`
  hook on the xource asks the queenzee, and the push is **held** until a human approves that
  exact sha in the console. Fails closed. Installed automatically on every onboarded project.
- **Ship gate** — production deploys are requests; a human approves, and the *queenzee* builds
  from the landed main and deploys. A zee never holds the prod lock or runs a prod build.
- **Prod data** — binding a xell to a production database is a per-xell human grant.
- **Done** — a zee proposes it's finished; a human's "Mark done" is what tears the cxell down
  (commits are collected first).

## GitHub-centric, inbound-only

The code lives on GitHub; every instance is born from it (self-onboard) and refreshed from it
(the console's ff-only **Pull**). The dev cycle itself — landing, integration, prod builds —
runs entirely on the local xource and never depends on GitHub being reachable. There is **no
push verb anywhere in the system**: publishing local main to GitHub is a deliberate human act.

## Layout

```
db/migrations/   schema, applied automatically at boot
server/src/
  api/routes.js  every HTTP route (hooks, claim, land/ship gates, self verbs, SSE stream)
  queenzee/      the loops: pool, intake, monitor, landing pad, ship gate, reaper, maintenance
  lib/           provision, cxell driver, remote-git (clone/pull, no push), self-onboard,
                 projects, terminal bridge, fleet, docker, …
web/             the console (React + Vite) — honeycomb fleet view, gates, terminals
docker/zeehive/  Dockerfile.server (the queenzee), Dockerfile.zee-agent (the cxell image),
                 Dockerfile.web, docker-compose.prod.yml, migration playbook (README.md)
scripts/         provisioning/despawn/build/ship scripts + the in-cxell `zee` CLI
docs/            deploy-topology spec, the cxell zee manual
```

## Developing ZEEHIVE with ZEEHIVE

ZEEHIVE is its own first project: work on it happens in xells like any other project. A Zeehive
xell gets its own per-xell meta-DB container (`zeehive_db_spin_<slug>`), and the nested queenzee
inside it runs with simulate-mode safety defaults (`zeehive.yml`) — it can never touch the real
fleet. Landed work reaches the running instance via its **self-ship**: the approved ref is
rebuilt and the server replaces itself, finishing the ship record on the new boot.

Legacy note: a host-process deployment mode (the pre-container era) still exists alongside the
container mode during the migration — [docker/zeehive/README.md](docker/zeehive/README.md) is
the authoritative playbook for what runs where and what remains before full cutover.
