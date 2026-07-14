# XEEHIVE — handover

Paste this into a fresh Claude Code session **opened in `D:\Repos\Xeehive`**.

---

You are picking up **XEEHIVE**, a deterministic agent-environment orchestrator. Read this
whole file, then `README.md`, then skim the design doc at
`C:\Users\Mark\.claude\plans\okay-so-here-is-merry-gizmo.md` (the full rationale).

## What it is (vocabulary)

- **xource** — the source a xell branches from (local `main`). Read-only to xells.
- **xell** — an isolated env: a git worktree + its own `spinoff/<slug>` branch + assigned
  containers (db/server/webapp) + config. Unit the orchestrator spawns/tracks/tears down.
- **zee** — an agent (a Claude Code session) bound to exactly one xell.
- **queenzee** — the orchestrator. **Pure script, NO AI.** Keeps a pool of ready xells,
  binds zees, monitors, maintains (prod backup, refresh), decommissions. Never reads a
  zee's context or interprets prompts.
- **production** is modeled as a xell too, but flagged `is_production` and untouchable by zees.

Core thesis: **provisioning is 100% deterministic and belongs in a script; the AI only does
the actual work, starting from a proven-correct environment.**

## Layout

```
db/migrations/*.sql      schema (001 init, 002 monitor, 003 deploy_lock, 004 production)
server/src/
  db/        migrate.js, seed.js (base: project/runtimes/containers/prod xell), seed_demo.js
  api/routes.js          all HTTP routes
  queenzee/  pool, intake, poller, monitor, reaper, tasks, maintenance, deploylock
  lib/       fleet, timeline, git, sessions (passive poller), claude-cli, provision,
             runtimes, names, logbus, events, status
web/src/     App.jsx, GitRail.jsx (lane graph), Connectors.jsx (circuit routes),
             Terminal.jsx (queenzee log modal), nick.js, api.js, styles.css
mcp/server.js            MCP server (6 tools) wrapping the API
skill/xell, skill/xell-done   Claude slash-command skills
scripts/     provision-xell.sh, despawn-xell.sh, xell-claim.mjs, xell-*-done.mjs
hooks/       settings.hooks.json (harness status hooks) + README
```

## Run it

Meta-DB is Postgres. **Local Docker Desktop was down**, so it currently runs on the
`ugreen-nas` Docker context as container `xeehive_db` at `10.1.0.18:5445` (see `.env`
`DATABASE_URL`). To (re)create + seed + run:

```bash
npm install
docker --context ugreen-nas compose up -d db     # or `docker compose up -d db` if local Docker is up
npm run db:reset                                  # migrate + base seed (project, runtimes, containers, prod xell)
node server/src/db/seed_demo.js                   # 5 demo xells (3 with zees, 2 working) + prod lock + a real live session
# API + queenzee — POOL/POLLER OFF keeps the static demo stable; MONITOR stays on for the terminal:
POOL_ENABLED=false POLLER_ENABLED=false NODE_NO_WARNINGS=1 node server/src/index.js
npm run web                                       # Vite on http://localhost:5180  (widen the window — the pane squashes it)
```

Flip `PROVISION_MODE=real` to actually `git worktree add` + `spin-env up` on ugreen-nas;
`MAINTENANCE_MODE=real` + `MAINTENANCE_ENABLED=true` for real prod `pg_dump`. Default is
**simulate** (models everything in the DB, no live NAS/prod mutation).

## What's real vs simulate / demo

- **Observability is real**: harness hooks (`hooks/settings.hooks.json`) POST to `/api/hooks`;
  the passive poller reads `~/.claude/sessions/*.json` + transcripts; `claude agents --json`
  is the "really active" oracle. `stats-cache.json` is deliberately NOT used.
- **git graph + per-xell diffs are real** (read from the OmniBiz repo).
- **Provisioning + prod backup are simulate by default** (see flags above).
- **`claude remote` spawn** runs the literal CLI but Remote Control needs claude.ai login;
  exact start flags are env-configurable via `CLAUDE_REMOTE_START_TEMPLATE`.
- Demo `viewer_url`s for remote zees are **sample** `https://claude.ai/code/<sid>` strings.

## KNOWN ISSUES / NEXT STEPS

1. **Click-to-open a session doesn't actually open the session (TODO).** Clicking a xell card
   calls `window.open(x.viewer_url)`. Two problems: (a) remote `viewer_url`s are sample
   claude.ai URLs, not captured from a real `claude remote` session; (b) local (desktop)
   zees have no URL. Intended behavior: **open a browser to the real claude.ai session URL,
   OR deep-link to Claude Desktop** (the T-Keyboard opens the desktop to a session via
   `CLAUDE_CODE_SESSION_ID` — see `~/.claude/skills/tkeyboard`). Fix: capture the real session
   URL at remote spawn; add a desktop deep-link (or an API endpoint that focuses the desktop
   session) for local zees; make the card open the right one by `viewer_kind`.
2. **Delete the stale `D:\Repos\Originode`** — this project was renamed from Originode; the old
   folder is a leftover copy (couldn't be deleted while the prior session held it).
3. **Meta-DB on ugreen-nas** is a convenience because local Docker was down — consider moving
   it to local Docker (`docker compose up -d db`, port 5433 per compose default) and updating
   `.env`.
4. Cosmetic: `mcp/server.js` and `scripts/xell-status.mjs` have a harmless duplicated
   `XEEHIVE_API || XEEHIVE_API` fallback from the rename.

## How to talk to it as an agent

- Skill `/xell <task>` claims a ready xell (context injected, not prompted).
- Skill `/xell-done` checks status / reports the job finished (human confirms via "Mark done").
- MCP tools (register `mcp/server.js`, see `mcp/README.md`): `xeehive_get_context`,
  `xeehive_status`, `xeehive_report_done`, `xeehive_prod_lock_{acquire,release,status}`.

The web app is **read-only** (no prompting there); the **▚_ terminal** button by "Status"
opens a live queenzee activity log.
