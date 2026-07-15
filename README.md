# ZEEHIVE

Deterministic agent-environment orchestrator.

- **xource** — the source a *xell* branches from (e.g. local `main`). Read-only to xells.
- **xell** — an isolated environment: a git worktree + its own branch + assigned
  containers (db/server/webapp) + config. The unit the orchestrator spawns/tracks/tears down.
- **zee** — an agent (a Claude Code session) bound to exactly one xell.
- **queenzee** — the orchestrator. **Pure script, no AI.** It reads xell/zee *status*,
  keeps a pool of pre-warmed empty xells, spawns/despawns deterministically, and runs
  maintenance (prod DB backup, refresh stale xell DBs). It never reads a zee's context or
  interprets prompts.

The insight: **provisioning is 100% deterministic and belongs in a script; the AI should
only do the actual work, starting from a proven-correct environment.**

## Layout

```
db/migrations/ 001 init · 002 monitor · 003 deploy_lock · 004 production
               005 container_build · 006 db_backups · 007 container_restoring
               008 async_backup_jobs
server/        Node API + queenzee loops
  src/
    db/        migrate.js, seed.js, seed_demo.js (NEVER run — see House rules), pool.js
    api/       routes.js — every HTTP route (hooks, claim, tasks, read models, SSE stream)
    queenzee/  pool (reconciler), intake, landing, poller, monitor, containers,
               reaper, tasks, maintenance, deploylock
    lib/       fleet, timeline, git, sessions, session-title, claude-cli, provision,
               project-resolve, rename-xell, build, xell-db, reveal, runtimes, names,
               projects, logbus, events, status
web/           React + Vite visualization (read-only)
mcp/server.js  MCP server wrapping the API
skill/         /xell + /xell-done Claude skills (installed copies live in ~/.claude/skills/
               — edit BOTH or they drift)
scripts/       provision-xell.sh, provision-xell-db.sh, despawn-xell.sh, land-xell.sh,
               rename-xell.sh, build-container.sh, check-containers.sh, xell-*.mjs
hooks/         settings.json hooks snippet + post-hook.sh — a TEMPLATE, not installed
```

## Quick start

```bash
cp .env.example .env            # edit DATABASE_URL etc.
npm install
docker --context ugreen-nas compose up -d db   # meta-DB `zeehive_db` at 10.1.0.18:5445
npm run db:reset                # migrate + seed OmniBiz
npm run server                  # API + queenzee on :4700
npm run web                     # Vite dev server on :5180
```

The meta-DB lives on the `ugreen-nas` Docker context, not localhost — drop `--context` only if
you deliberately want a throwaway local one. `docker-compose.yml` pins `name: zeehive`
deliberately: compose otherwise derives the volume prefix from the **folder name**, so moving
this repo would make it look for a volume that doesn't exist and quietly start an **empty** meta
database. Do not remove that line.

Mark's standard run — real provisioning, pool on, no app tier:

```bash
PROVISION_MODE=real PROVISION_APP_TIER=false POOL_ENABLED=true POLLER_ENABLED=false \
  NODE_NO_WARNINGS=1 node server/src/index.js
```

## Observability (how status is known without trusting the agent)

Two model-independent channels were designed. **Only the second is actually running:**

1. **Push — harness hooks. NOT INSTALLED.** The design: `~/.claude/settings.json` posts
   `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Stop` / `SessionEnd` … to
   `POST /api/hooks`, which the harness fires itself so the model can't skip them.
   `POST /api/hooks` exists and returns 202, but `~/.claude/settings.json` has **no hooks key**,
   so nothing ever calls it. `hooks/settings.hooks.json` is a template, not a live config.
2. **Passive poll — the live channel.** `~/.claude/sessions/<PID>.json` (PID↔session↔cwd) joined
   with the transcript's mtime + last `stop_reason`, gated on live PIDs. Plus the **active-session
   monitor** (`queenzee/monitor.js`), which is where live zee state actually comes from today.

`stats-cache.json` is deliberately **not** used (daily rollup, no per-session data).
"Done" is a human decision surfaced in the web app — `Stop`=idle is necessary, not sufficient.

## The landing gate (how main is protected without trusting the agent)

Same principle, applied to the one irreversible thing a zee does. "Land locally: `git push .
HEAD:main`" was only an instruction in the prompt — so a zee followed it and put work on `main`
with nobody told. Observing that after the fact is useless: the ref has already moved.

So the enforcement sits where the action happens. An `update` hook on the xource
(`hooks/land-gate-update.sh` → `scripts/install-land-gate.sh`) fires on every push to the
project's `main_branch`, asks `POST /api/land/check`, and **declines unless a human already
approved that exact sha** in the console. The push becomes a *request*; the human decides; the
zee re-runs the same push once approved. It **fails closed**, and it fires only on push — working
on `main` directly is untouched.

Machine-local: `.git/hooks` is not version-controlled and does not travel with a clone, so the
installer must be run once per machine per project.

See `C:\Users\Mark\.claude\plans\okay-so-here-is-merry-gizmo.md` for the full design.
