#!/usr/bin/env bash
# START A PROCESS ROLE — the 🔨 verb for `runner: process` xells (spec §6.1). Where a compose
# project would `docker compose build && up`, a process role is (re)started in its worktree:
#
#   start-xell-process.sh <worktree> <role> <port> <mode> <start_cmd...>
#   → one JSON line {"ok":bool,"head":"<sha>","method":"...","service":"<role>"}
#
# The process reads its own parameters from the worktree's .zeehive.env (config.js and
# vite.config.js both load it), so nothing is smuggled through the environment — the projection
# is truth, same rule as .env on the live checkout. Output goes to .zeehive-<role>.log in the
# worktree so a zee can read its own crash.
#
# Lessons inherited from self-ship.sh: the restart helper must be DETACHED (a killed parent must
# not take the server with it), and `bash` must be GIT bash — a detached PowerShell inherits the
# SYSTEM PATH where WSL's bash.exe shadows it.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE 2>/dev/null || true

WT="${1:?usage: start-xell-process.sh <worktree> <role> <port> <mode> <start_cmd...>}"
ROLE="${2:?role}"; PORT="${3:?port}"; MODE="${4:-real}"; shift 4
START="${*:-npm run server}"

HEAD="$(git -C "$WT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
emit() { printf '{"ok":%s,"head":"%s","method":"%s","service":"%s"}\n' "$1" "$HEAD" "$2" "$ROLE"; }

if [ "$MODE" = "simulate" ]; then emit true "simulate"; exit 0; fi
if [ ! -d "$WT" ]; then emit false "no-worktree"; exit 1; fi

# The worktree must be able to run at all — a pooled xell may never have had npm install.
# `npm ci` NOT `npm install`: install rewrites package-lock.json, the pool reads that as a
# dirty worktree and decommissions the xell right after its first build — an endless
# provision→build→reap loop (seen live on the boot instance, 2026-07-20). ci never touches
# the lock; plain install remains the fallback for a worktree without one.
#
# 2026-07-29 (ticket #14): that rule was stated in this comment and NOT enforced by the code below
# it. `[ -f lock ] && npm ci || npm install` runs the `||` branch when EITHER test fails — including
# when `npm ci` itself fails. So a worktree WITH a lockfile that had drifted still ran `npm install`,
# rewrote the lock, and re-armed the exact loop this comment warns about. Spelled out as if/else so
# the failure is loud instead of papered over: a `ci` that cannot run is a repo state someone must
# fix deliberately, and this script's job is to say so, not to mutate the tree until it installs.
if [ ! -d "$WT/node_modules" ]; then
  if [ -f "$WT/package-lock.json" ]; then
    echo "node_modules missing — npm ci (first start of this worktree)" >&2
    (cd "$WT" && npm ci --no-audit --no-fund) >&2 \
      || { echo "npm ci FAILED — package-lock.json disagrees with package.json. NOT falling back to 'npm install': that would rewrite the lock in a worktree the pool watches." >&2
           emit false "npm-ci-failed"; exit 1; }
  else
    echo "node_modules missing and NO package-lock.json — npm install (there is no lock to rewrite)" >&2
    (cd "$WT" && npm install --no-audit --no-fund) >&2 \
      || { emit false "npm-install-failed"; exit 1; }
  fi
fi

# Kill whatever already listens on this role's port (restart semantics), then start detached.
# Two branches for the two eras: git-bash on the Windows host (PowerShell detach — the lessons
# in the header), plain nohup inside the Linux container (where powershell.exe famously is
# "command not found" — seen live on the first in-container process start, 2026-07-20).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    WTWIN="$(echo "$WT" | sed 's|/|\\\\|g')"
    LOG="$WTWIN\\\\.zeehive-$ROLE.log"
    powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id \$_ -Force -ErrorAction SilentlyContinue }" >&2
    powershell.exe -NoProfile -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',('\$env:Path = \"C:\Program Files\Git\bin;\" + \$env:Path; Set-Location \"${WTWIN}\"; ${START} *>> \"${LOG}\"')" >&2 \
      || { emit false "detach-failed"; exit 1; }
    ;;
  *)
    LOG="$WT/.zeehive-$ROLE.log"
    fuser -k -n tcp "$PORT" >/dev/null 2>&1 || true
    # THE PROJECTION MUST WIN: dotenv never overrides existing env vars, and this child inherits
    # the QUEENZEE's own environment — its DATABASE_URL pointed every nested server at the
    # managing meta-DB, where the parent eternally holds the single-queenzee advisory lock, so
    # the xell's server "waited for the previous queenzee" forever and its port never answered
    # (the entire first day of in-container process starts died on this). Unset every key the
    # worktree's .zeehive.env owns so dotenv re-reads them from the file — including the §6.2
    # simulate safety flags.
    UNSET_ARGS="$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*' "$WT/.zeehive.env" 2>/dev/null | sed 's/^/--unset=/' | tr '\n' ' ')"
    # shellcheck disable=SC2086
    nohup env $UNSET_ARGS bash -c "cd '$WT' && exec ${START} >> '$LOG' 2>&1" >/dev/null 2>&1 &
    disown 2>/dev/null || true
    ;;
esac

# Honest ok: the URL answering is the health truth, so wait for the port to answer before
# claiming success — up to 180s: a cold start stacks nested npm invocations plus vite's
# first-run dependency optimization, and in-container that overran the old 60s window while
# the process came up healthy right behind the FAILED verdict (seen live 2026-07-20).
for _ in $(seq 1 180); do
  if curl -s -o /dev/null --max-time 2 "http://localhost:${PORT}"; then
    emit true "process-start"; exit 0
  fi
  sleep 1
done
echo "port ${PORT} never answered — see ${LOG}" >&2
emit false "start-timeout"; exit 1
