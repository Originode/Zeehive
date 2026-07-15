#!/usr/bin/env bash
# Rename a xell's worktree + branch to a human-readable slug. Run BY the queenzee (like
# provision/despawn/land/build). Pooled xells are minted before any task exists, so they get a
# random slug ("calm-summit-403da6") — unreadable in Claude Code's sidebar, which names a worktree
# by its FOLDER. Once we know what the xell is for, rename it to something a human can track.
#
#   rename-xell.sh <repo_root> <old_slug> <new_slug>
#
# Emits one JSON line. Refuses (ok:false) rather than half-moving: the caller only renames xells
# with no built containers, but we still verify the destination is free and the source is a real
# worktree before touching anything.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true

ROOT="${1:?usage: rename-xell.sh <repo_root> <old_slug> <new_slug>}"
OLD="${2:?old_slug}"; NEW="${3:?new_slug}"
OLD_WT="$ROOT/.claude/worktrees/$OLD"
NEW_WT="$ROOT/.claude/worktrees/$NEW"

emit() { printf '{"ok":%s,"reason":"%s","worktree":"%s","branch":"%s","slug":"%s"}\n' "$1" "$2" "$NEW_WT" "spinoff/$NEW" "$NEW"; }

[ "$OLD" = "$NEW" ] && { emit true noop; exit 0; }
[ -e "$OLD_WT/.git" ] || { echo "no worktree at $OLD_WT" >&2; emit false no-source; exit 1; }
[ -e "$NEW_WT" ] && { echo "destination already exists: $NEW_WT" >&2; emit false dest-exists; exit 1; }

# 1) move the worktree (git rewrites its admin pointers — never use plain mv)
git -C "$ROOT" worktree move "$OLD_WT" "$NEW_WT" >&2 || { emit false move-failed; exit 1; }

# 2) rename its branch to match. If this fails the worktree already moved, so report the move as
#    ok but flag the branch — the caller records the real branch name either way.
if git -C "$ROOT" show-ref --verify --quiet "refs/heads/spinoff/$OLD"; then
  git -C "$ROOT" branch -m "spinoff/$OLD" "spinoff/$NEW" >&2 || { emit true branch-rename-failed; exit 0; }
fi

emit true renamed
