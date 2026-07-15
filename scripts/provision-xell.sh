#!/usr/bin/env bash
# Deterministically provision a xell: a fresh git worktree on its own spinoff/ branch,
# plus its ephemeral app tier (server + webapp) via the project's spin-env.sh.
# Prints a single JSON line describing the provisioned xell. No AI in the loop.
#
#   provision-xell.sh <slug> [repo_root] [source_ref]
#
# source_ref is the project's main_branch — NOT always "main". This was hardcoded, so any project
# whose source branch is named something else (Zeehive itself is on master) failed with
# "fatal: invalid reference: main" no matter what its project row said. The caller knows the
# branch; it must pass it rather than let the script assume.
#
# Env: SPINOFF_DOCKER_CONTEXT (default ugreen-nas), DEV_HOST_IP (default 10.1.0.18)
set -euo pipefail

# Never inherit a stray git context from the launching shell — GIT_DIR/GIT_WORK_TREE
# override `git -C` and would make us act on the wrong repo (e.g. Zeehive's .git, which
# has no `main` → "fatal: invalid reference: main"). Always resolve via the -C path below.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true

SLUG="${1:?usage: provision-xell.sh <slug> [root]}"
ROOT="${2:-${OMNIBIZ_ROOT:-D:/Repos/OmniBiz/omnibiz}}"
SRC_REF="${3:-main}"
CTX="${SPINOFF_DOCKER_CONTEXT:-ugreen-nas}"
HOST_IP="${DEV_HOST_IP:-10.1.0.18}"
BRANCH="spinoff/$SLUG"
WT="$ROOT/.claude/worktrees/$SLUG"

# deterministic ports from the slug (mirror of spin-env.sh)
HASH="$(printf '%s' "$SLUG" | md5sum | cut -c1-4)"
SLOT="$(( 16#$HASH % 90 ))"
SERVER_PORT=$((3100 + SLOT))
WEB_PORT=$((5200 + SLOT))
URL="http://$HOST_IP:$WEB_PORT"

# 1) create the isolated worktree on its own branch off the LOCAL source ref (never origin)
if [ ! -e "$WT/.git" ]; then
  git -C "$ROOT" rev-parse --verify --quiet "$SRC_REF" >/dev/null \
    || { echo "source ref '$SRC_REF' does not exist in $ROOT" >&2; exit 1; }
  git -C "$ROOT" worktree add "$WT" -b "$BRANCH" "$SRC_REF" >&2
fi
HEAD="$(git -C "$WT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# 2) bring up this worktree's ephemeral app tier (shares dev db/infra).
#    Skipped when PROVISION_APP_TIER=false — worktree-only provisioning (no NAS churn).
if [ "${PROVISION_APP_TIER:-true}" = "true" ] && [ -f "$WT/scripts/spin-env.sh" ]; then
  ( cd "$WT" && SPINOFF_DOCKER_CONTEXT="$CTX" DEV_HOST_IP="$HOST_IP" bash scripts/spin-env.sh up >&2 )
fi

# 3) emit the machine-readable result the pool maintainer ingests
printf '{"slug":"%s","branch":"%s","worktree":"%s","head":"%s","slot":%d,"server_port":%d,"web_port":%d,"url":"%s","server_container":"omnibiz_spin_server_%s","web_container":"omnibiz_spin_web_%s"}\n' \
  "$SLUG" "$BRANCH" "$WT" "$HEAD" "$SLOT" "$SERVER_PORT" "$WEB_PORT" "$URL" "$SLUG" "$SLUG"
