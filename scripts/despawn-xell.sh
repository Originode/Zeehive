#!/usr/bin/env bash
# Deterministically tear a xell down: purge its ephemeral app tier, unlink junctions,
# remove the worktree + branch. Mirrors /spin:spinon's safe teardown.
#
#   despawn-xell.sh <worktree_path>
set -euo pipefail

WT="${1:?usage: despawn-xell.sh <worktree_path>}"
CTX="${SPINOFF_DOCKER_CONTEXT:-ugreen-nas}"

# resolve MAIN checkout (the entry not under .claude/worktrees) so we can operate from outside WT
MAIN="$(git -C "$WT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | grep -v '/\.claude/worktrees/' | head -1 || true)"
BR="$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

# 1) purge this worktree's ephemeral containers + built images (shared stack untouched)
if [ -f "$WT/scripts/spin-env.sh" ]; then
  ( cd "$WT" && SPINOFF_DOCKER_CONTEXT="$CTX" bash scripts/spin-env.sh purge >&2 ) || true
fi

# 2) unlink any junctions/symlinks (node_modules) so a recursive remove can't follow them
powershell.exe -NoProfile -Command \
  "Get-ChildItem -LiteralPath '$WT' -Recurse -Force -Directory -Attributes ReparsePoint -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object { cmd /c rmdir \$_.FullName }" >&2 2>&1 || true

# 3) remove the worktree + branch from the MAIN checkout
if [ -n "$MAIN" ]; then
  git -C "$MAIN" worktree remove "$WT" --force >&2 || true
  [ -n "$BR" ] && [ "$BR" != "main" ] && git -C "$MAIN" branch -D "$BR" >&2 || true
  git -C "$MAIN" worktree prune >&2 || true
fi

printf '{"removed":"%s","branch":"%s"}\n' "$WT" "$BR"
