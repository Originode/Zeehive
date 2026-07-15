#!/usr/bin/env bash
# Deterministically tear a xell down: purge its ephemeral app tier, unlink junctions, remove the
# worktree + branch, and DELETE THE FOLDER. Mirrors /spin:spinon's safe teardown.
#
#   despawn-xell.sh <worktree_path>
#
# Reports honestly. Every step is best-effort (a missing container or an already-deregistered
# worktree must not abort the rest), but the final verdict is measured, not assumed: if the folder
# is still on disk at the end we emit ok:false with a reason. The previous version printed
# {"removed":...} unconditionally, so a total failure looked like success and left orphaned
# worktrees behind — the exact litter this is supposed to prevent.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true

WT="${1:?usage: despawn-xell.sh <worktree_path>}"
CTX="${SPINOFF_DOCKER_CONTEXT:-ugreen-nas}"

# MAIN = the primary checkout. Ask git first; if this worktree is already deregistered (git says
# "not a working tree") fall back to deriving it from the path, so we can still prune + delete.
MAIN="$(git -C "$WT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | grep -v '/\.claude/worktrees/' | head -1 || true)"
[ -z "$MAIN" ] && case "$WT" in *"/.claude/worktrees/"*) MAIN="${WT%%/.claude/worktrees/*}" ;; esac
BR="$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
[ "$BR" = "HEAD" ] && BR=''   # detached / not a worktree → no branch to delete

# 1) purge this worktree's ephemeral containers + built images (shared stack untouched)
if [ -f "$WT/scripts/spin-env.sh" ]; then
  ( cd "$WT" && SPINOFF_DOCKER_CONTEXT="$CTX" bash scripts/spin-env.sh purge >&2 ) || true
fi

# 2) KILL the zee's own process. Marking the zee 'stopped' in the DB does not stop the agent: the
#    SDK's claude.exe keeps running with this worktree as its cwd, holds the folder open, and the
#    delete below then fails silently — which is how reaped xells were left orphaned on disk.
#    Match on the worktree's basename (its slug), which appears in the agent's command line.
#    Target ONLY the agent binary (claude.exe). Matching every process whose command line mentions
#    the slug also matches this very script (the path is our $1) and the queenzee itself — it will
#    happily kill its own shell mid-teardown.
SLUG="$(basename "$WT")"
powershell.exe -NoProfile -Command \
  "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -like '*$SLUG*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >&2 2>&1 || true
sleep 1   # let Windows release the handles before we try to delete

# 3) unlink junctions/symlinks (node_modules) so a recursive delete can't follow them out
powershell.exe -NoProfile -Command \
  "Get-ChildItem -LiteralPath '$WT' -Recurse -Force -Directory -Attributes ReparsePoint -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object { cmd /c rmdir \$_.FullName }" >&2 2>&1 || true

# 4) deregister the worktree + delete its branch from the MAIN checkout
if [ -n "$MAIN" ] && [ -d "$MAIN" ]; then
  git -C "$MAIN" worktree remove "$WT" --force >&2 2>&1 || true
  [ -n "$BR" ] && [ "$BR" != "main" ] && git -C "$MAIN" branch -D "$BR" >&2 2>&1 || true
  git -C "$MAIN" worktree prune >&2 2>&1 || true
fi

# 5) `git worktree remove` leaves the directory behind when files are locked/in use, and does
#    nothing at all once the worktree is deregistered. Delete what remains.
if [ -e "$WT" ]; then
  rm -rf "$WT" 2>/dev/null || true
  [ -e "$WT" ] && { cmd //c "rmdir /s /q $(cygpath -w "$WT" 2>/dev/null || echo "$WT")" >&2 2>&1 || true; }
fi

# 6) verdict — measured, never assumed
if [ -e "$WT" ]; then
  printf '{"ok":false,"reason":"folder still on disk (locked or in use)","removed":false,"worktree":"%s","branch":"%s"}\n' "$WT" "$BR"
  exit 1
fi
printf '{"ok":true,"removed":true,"worktree":"%s","branch":"%s"}\n' "$WT" "$BR"
