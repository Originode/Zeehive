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
db/            SQL you can also apply by hand (mirrors server/src/db)
server/        Node API + queenzee loops
  src/
    db/        migrate.js, seed.js, schema.sql, seed data
    api/       hooks, xell-claim, tasks, read models, SSE stream
    queenzee/  pool, intake, projector, reaper, maintenance
    lib/       sessions (passive poller), provision, runtimes, names
web/           React + Vite visualization (read-only)
skill/         /xell Claude skill (dynamic-context-injection)
scripts/       provision-xell.sh, despawn-xell.sh
hooks/         settings.json hooks snippet + post-hook.sh
```

## Quick start

```bash
cp .env.example .env            # edit DATABASE_URL etc.
docker compose up -d db         # local Postgres on :5433
npm install
npm run db:reset                # migrate + seed OmniBiz
npm run server                  # API + queenzee on :4700
npm run web                     # Vite dev server
```

## Observability (how status is known without trusting the agent)

Two model-independent channels, both used:

1. **Push — harness hooks.** `~/.claude/settings.json` posts `SessionStart` /
   `UserPromptSubmit` / `PreToolUse` / `Stop` / `SessionEnd` … to `POST /api/hooks`. The
   harness fires these itself; the model can't skip them. `Stop` = zee went idle.
2. **Passive poll.** `~/.claude/sessions/<PID>.json` (PID↔session↔cwd) joined with the
   transcript's mtime + last `stop_reason`, gated on live PIDs. Fallback/audit.

`stats-cache.json` is deliberately **not** used (daily rollup, no per-session data).
"Done" is a human decision surfaced in the web app — `Stop`=idle is necessary, not sufficient.

See `C:\Users\Mark\.claude\plans\okay-so-here-is-merry-gizmo.md` for the full design.
