#!/usr/bin/env bash
# REAL production deploy of ONE service (server|webapp) from source, on the prod docker context.
#
# RUN BY THE QUEENZEE, NEVER BY A ZEE. That is the whole point: a zee deploying by hand ships a
# band-aid — live in prod, absent from main, silently reverted by the next rebuild. The queenzee
# builds from the XOURCE AT MAIN, so what lands in prod is exactly what main will rebuild.
#
# Invoked via the container's stored build_script/build_exec fields (see 010_ship_gate.sql):
#     ship-prod.sh <source_path> <role> <docker_ctx> <mode> [build_ref]
#
#   source_path  the XOURCE checkout — used ONLY for its git dir and its untracked .env.
#                We never build its working tree: it is shared, it has ~17 worktrees hanging off
#                it, and old ad-hoc sessions leave its HEAD parked wherever they finished. It sat
#                detached 542 commits behind main for months while this script happily built it.
#   role         server | webapp
#   docker_ctx   e.g. mardale-prod
#   mode         real | simulate
#   build_ref    production's BUILD SOURCE — local main (or the exact sha the human approved).
#                origin is a backup and is never read here.
#
# What actually gets built is a throwaway worktree DETACHED at build_ref, so "builds from main" is
# a mechanism rather than a comment. Detached matters: `git push . HEAD:main` is how zees land, and
# git refuses a push to a branch that is checked out in any worktree. Check main out here and you
# break landing for everyone.
#
# Emits ONE json line for the Node projector, same contract as build-container.sh:
#     {"ok":true,"head":"<sha>","method":"...","service":"..."}
#
# Mirrors the project's own prodsrc stack: docker-compose.prodsrc.yml on the prod context,
# building from source (no registry images).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true

SRC="${1:?usage: ship-prod.sh <source_path> <role> <docker_ctx> <mode> [build_ref]}"
ROLE="${2:?missing role}"
CTX="${3:?missing docker context}"
MODE="${4:-simulate}"
BUILD_REF="${5:-main}"

# The build source, materialised. Kept between ships (detached, re-pointed each time) so docker
# keeps its layer cache instead of rebuilding prod from scratch every deploy.
BUILD_TREE="$(dirname "$SRC")/.zeehive-buildsrc/$(basename "$SRC")"
ENV_FILE="$SRC/.env"          # untracked, lives only in the xource checkout — never in a worktree
COMPOSE="$BUILD_TREE/docker-compose.prodsrc.yml"
PROJECT="omnibiz"
HEAD=unknown

emit() { # ok method
  printf '{"ok":%s,"head":"%s","hot":false,"method":"%s","service":"%s","mode":"%s"}\n' \
    "$1" "$HEAD" "$2" "$SVC" "$MODE"
}

# role → compose service. NOT identity: prodsrc calls the backend `omnibiz` (it builds
# server/Dockerfile into omnibiz_server_prod), while docker-compose.spinoff.yml calls it `server`.
# This script was copied from build-container.sh, which maps server→server correctly for the
# SPINOFF compose — that mapping was never true here, so every real ship died on
# "no such service: server" before it built anything.
case "$ROLE" in
  server) SVC="omnibiz" ;;
  webapp) SVC="webapp" ;;
  *) echo "role '$ROLE' is not shippable (server|webapp only)" >&2; SVC="$ROLE"; emit false none; exit 1 ;;
esac

[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; emit false none; exit 1; }

# Resolve the build source to a sha in the XOURCE's git dir (origin is never consulted).
HEAD_FULL="$(git -C "$SRC" rev-parse --verify "${BUILD_REF}^{commit}" 2>/dev/null)" || {
  echo "cannot resolve build ref '$BUILD_REF' in $SRC" >&2; emit false none; exit 1; }
HEAD="$(git -C "$SRC" rev-parse --short "$HEAD_FULL")"

# Materialise it. --detach, always: see the header — main checked out here would break landing.
git -C "$SRC" worktree prune >&2 2>/dev/null || true
if [ -e "$BUILD_TREE/.git" ]; then
  git -C "$BUILD_TREE" checkout --detach --force "$HEAD_FULL" >&2 || {
    echo "cannot re-point build source to $HEAD" >&2; emit false none; exit 1; }
  git -C "$BUILD_TREE" clean -fdx -e .env >&2 || true
else
  mkdir -p "$(dirname "$BUILD_TREE")"
  git -C "$SRC" worktree add --detach "$BUILD_TREE" "$HEAD_FULL" >&2 || {
    echo "cannot create build source worktree at $BUILD_TREE" >&2; emit false none; exit 1; }
fi

[ -f "$COMPOSE" ] || { echo "compose file not found: $COMPOSE" >&2; emit false none; exit 1; }

# Prod logs its own version from this, so a ship must stamp it — build-container.sh already does.
export GIT_COMMIT_HASH="$HEAD"

# SIMULATE: prove the whole pipeline — request → approve → lock → build → nudge → auto-release —
# without touching the real box. Real deploys are gated on a human approving the request anyway;
# this gate is for verifying ZEEHIVE itself.
if [ "$MODE" != "real" ]; then
  echo "SIMULATE: would deploy '$SVC' to $CTX from build source $BUILD_REF @ $HEAD" >&2
  echo "SIMULATE:   docker --context $CTX compose -p $PROJECT --env-file $ENV_FILE -f $COMPOSE build $SVC" >&2
  echo "SIMULATE:   docker --context $CTX compose -p $PROJECT --env-file $ENV_FILE -f $COMPOSE up -d $SVC" >&2
  sleep 2
  emit true simulate
  exit 0
fi

dc() { docker --context "$CTX" compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE" "$@"; }

# Fail on a service the compose file does not define, rather than letting `build` say
# "no such service" three layers down. A rename upstream should be a clear error here.
if ! dc config --services 2>/dev/null | grep -qx "$SVC"; then
  echo "compose defines no service '$SVC' (role $ROLE) in $COMPOSE" >&2
  echo "  services: $(dc config --services 2>/dev/null | tr '\n' ' ')" >&2
  emit false no-such-service; exit 1
fi

echo "shipping $SVC → $CTX from build source $BUILD_REF @ $HEAD" >&2
if ! dc build "$SVC" >&2; then emit false build-failed; exit 1; fi
if ! dc up -d "$SVC" >&2; then emit false up-failed; exit 1; fi
emit true compose-build
