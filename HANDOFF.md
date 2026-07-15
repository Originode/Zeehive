# ZEEHIVE — handover

Paste this into a fresh Claude Code session **opened in `D:\Repos\Zeehive`**.

**Every factual claim here was verified against the live system on 2026-07-15.** It will rot
anyway — the previous version told two sessions to delete a folder that no longer existed, and
listed as "broken" two things that had since been fixed. **Check before you trust.** If you find
a claim that is wrong, fix the line; do not work around it.

---

You are picking up **ZEEHIVE**, a deterministic agent-environment orchestrator. Read this whole
file, then `README.md`, then skim the design doc at
`C:\Users\Mark\.claude\plans\okay-so-here-is-merry-gizmo.md` (the full rationale — verified present).

## What it is (vocabulary)

- **xource** — the source a xell branches from (the project's local `main_branch`). Read-only to xells.
- **xell** — an isolated env: a git worktree + its own `spinoff/<slug>` branch + assigned
  containers (db/server/webapp). The unit the orchestrator spawns, tracks and tears down.
- **zee** — an agent (a Claude Code session) bound to exactly one xell. The worker. *The product is
  named for the zee, not the xell — hence Zeehive.*
- **queenzee** — the orchestrator. **Pure script, NO AI.** Keeps a pool of ready xells, binds zees,
  monitors, maintains (prod backup), decommissions. Never reads a zee's context or interprets prompts.
- **production** is modeled as a xell too, flagged `is_production` and untouchable by zees.

Core thesis: **provisioning is 100% deterministic and belongs in a script; the AI only does the
actual work, starting from a proven-correct environment.**

## Projects (both live in the same meta-DB)

| project | repo_root | main_branch | target_ready |
|---|---|---|---|
| OmniBiz | `D:\Repos\OmniBiz\omnibiz` | `main` | 3 |
| Zeehive | `D:\Repos\Zeehive` | `master` | 0 |

Zeehive orchestrates **itself** as of the rename. Its pool target is 0, so it warms nothing — it
provisions on demand only. `/xell` resolves the project from the **invoker's cwd**; there is no
default, and an unresolvable cwd refuses rather than guessing (that guess used to silently hand
out an OmniBiz worktree to a session standing in this repo).

## Layout

```
db/migrations/*.sql      001 init · 002 monitor · 003 deploy_lock · 004 production
                         005 container_build · 006 db_backups · 007 container_restoring
                         008 async_backup_jobs
server/src/
  db/        migrate.js, seed.js, seed_demo.js  ← seed_demo is DEAD to us (see House rules)
  api/routes.js          all HTTP routes
  queenzee/  pool (reconciler), intake (claim+dispatch), landing, poller, monitor, containers,
             reaper, tasks, maintenance, deploylock
  lib/       fleet, timeline, git, sessions, session-title, claude-cli, provision, project-resolve,
             rename-xell, build, xell-db, reveal, runtimes, names, projects, logbus, events, status
web/src/     App.jsx, Container.jsx (reusable chip), GitRail.jsx, Connectors.jsx, Backups.jsx,
             ProjectMenu.jsx, Terminal.jsx (queenzee log modal), nick.js, api.js, styles.css
mcp/server.js            MCP server wrapping the API
skill/xell, skill/xell-done   source of the slash-command skills (installed copies live in
                              ~/.claude/skills/ — edit BOTH or they drift)
scripts/     provision-xell.sh, provision-xell-db.sh, despawn-xell.sh, land-xell.sh,
             rename-xell.sh, build-container.sh, check-containers.sh, xell-*.mjs
```

## Run it

Meta-DB is Postgres on the `ugreen-nas` Docker context: container **`zeehive_db`** at
`10.1.0.18:5445` (`.env` → `DATABASE_URL`). It was migrated from the old `xeehive_db` by
pg_dump/pg_restore, verified table-by-table.

```bash
npm install
docker --context ugreen-nas compose up -d db     # compose pins `name: zeehive` — do not remove it
# Mark's standard run — REAL provisioning, pool on, no app tier:
PROVISION_MODE=real PROVISION_APP_TIER=false POOL_ENABLED=true POLLER_ENABLED=false \
  NODE_NO_WARNINGS=1 node server/src/index.js
npm --workspace web run dev                       # dashboard on http://localhost:5180
```

`docker-compose.yml` pins `name: zeehive` deliberately: compose otherwise derives the volume
prefix from the **folder name**, so moving the repo would make it look for a volume that doesn't
exist and quietly start an **empty meta database**.

Flags: `PROVISION_MODE=real|simulate` · `PROVISION_APP_TIER` (false = worktree only, no NAS
containers) · `POOL_ENABLED` · `POLLER_ENABLED` · `BUILD_MODE=real|simulate` · `ZEE_MODEL`
(default `opus`) · `LAND_MAX_BEHIND` · `MAINTENANCE_MODE`/`MAINTENANCE_ENABLED` (real prod pg_dump).

## What's real vs simulate

- **Real**: provisioning (git worktrees), container health, docker builds, per-xell diffs, the git
  graph, prod backups, the db-attach flags, `claude://resume` deep-links on xell cards.
- **Hooks are NOT installed.** `POST /api/hooks` exists and returns 202, but there are no hooks in
  `~/.claude/settings.json` — nothing calls it. Live session state comes from the **active-session
  monitor** instead. (`hooks/settings.hooks.json` is a template, not something that's running.)
- **Provisioning is `simulate` by default in code** — Mark always runs `real`.

## House rules (learned the hard way — do not relearn them)

1. **No test data.** `seed_demo.js` exists; never run it. Mark: *"no more test data."*
2. **Never touch a xell you did not create.** Reap/tear down **only** dummies you spawned,
   targeted **by explicit slug or id** — never "the first card", never a `ready` xell (Mark
   commissions those too). A past session reaped his live DTR zee mid-task and lost real work.
3. **`origin` is off-limits to zees** — they land with `git push . HEAD:main`, never to origin.
4. **A human marks a xell done**, not the zee. `/xell-done` typed by a human IS the confirmation.
5. **Builds go through the queenzee** (`build.*` in the binding), never ad-hoc `docker compose`.
6. **`db-shared-prod` is LIVE production data** — never a default, must be asked for.

## KNOWN ISSUES / NEXT STEPS

1. **Delete the leftover `D:\Repos\Xeehive`** — Zeehive was built fresh from the pushed commit
   because the folder could not be renamed while a Claude Code session held it as its cwd. The old
   folder is a clean, fully-pushed duplicate holding nothing unique. Run
   `pwsh -File D:\Repos\remove-old-xeehive.ps1` (it refuses unless the new folder is complete).
   *This is the third time a rename has left a leftover — Originode → Xeehive → Zeehive.*
2. **Drop the meta-DB rollback** once you're confident: container `xeehive_db` (stopped) and
   volume `xeehive_xeehive_pgdata` on `ugreen-nas` are the pre-migration copy, kept on purpose.
3. **Dispatch is one-shot** (open decision). A dispatched zee runs exactly one `query()` turn and
   then idles until a human prompts it — Mark: *"the zees are really slow, I have to keep prompting
   them back."* Either add a continuation loop in `spawnHeadless`, or keep one-shot and size tasks
   to fit one turn. Not decided.
4. **Zeehive's pool target is 0** — set `pool_config.target_ready` if you want it warming xells.
5. **Skills are duplicated** — `skill/` in the repo vs the installed `~/.claude/skills/`. Editing
   one silently leaves the other stale.

## How to talk to it as an agent

- `/xell <task>` — claims a ready xell **only if your cwd IS its worktree**; otherwise it refuses
  and offers a confirmed dispatch (`scripts/xell-dispatch.mjs`, `--mode 1..5`, default 5=bypass;
  `--attended`; `--db`/`--dump`/`--db-container`).
- `/xell-done` — marks this xell done and tears it down.
- MCP (`mcp/server.js`): `zeehive_get_context`, `zeehive_status`, `zeehive_report_done`,
  `zeehive_prod_lock_{acquire,release,status}`.

The web app is **read-only** (no prompting there); the **▚_ terminal** button by "Status" opens a
live queenzee activity log.
