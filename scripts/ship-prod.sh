#!/usr/bin/env bash
# REAL production deploy of ONE service (server|webapp) from source, on the prod docker context.
#
# RUN BY THE QUEENZEE, NEVER BY A ZEE. That is the whole point: a zee deploying by hand ships a
# band-aid — live in prod, absent from main, silently reverted by the next rebuild. The queenzee
# builds from the XOURCE AT MAIN, so what lands in prod is exactly what main will rebuild.
#
# Invoked via the container's stored build_script/build_exec fields (see 010_ship_gate.sql):
#     ship-prod.sh <source_path> <role> <docker_ctx> <mode>
#
#   source_path  the XOURCE working tree (repo root at main) — NOT a xell worktree
#   role         server | webapp
#   docker_ctx   e.g. mardale-prod
#   mode         real | simulate
#
# Emits ONE json line for the Node projector, same contract as build-container.sh:
#     {"ok":true,"head":"<sha>","method":"...","service":"..."}
#
# Mirrors the project's own prodsrc stack: docker-compose.prodsrc.yml on the prod context,
# building from source (no registry images).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true

SRC="${1:?usage: ship-prod.sh <source_path> <role> <docker_ctx> <mode>}"
ROLE="${2:?missing role}"
CTX="${3:?missing docker context}"
MODE="${4:-simulate}"

COMPOSE="$SRC/docker-compose.prodsrc.yml"
ENV_FILE="$SRC/.env"
PROJECT="omnibiz"

emit() { # ok method
  local head
  head="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf '{"ok":%s,"head":"%s","hot":false,"method":"%s","service":"%s","mode":"%s"}\n' \
    "$1" "$head" "$2" "$SVC" "$MODE"
}

case "$ROLE" in
  server) SVC="server" ;;
  webapp) SVC="webapp" ;;
  *) echo "role '$ROLE' is not shippable (server|webapp only)" >&2; SVC="$ROLE"; emit false none; exit 1 ;;
esac

[ -f "$COMPOSE" ] || { echo "compose file not found: $COMPOSE" >&2; emit false none; exit 1; }

# SIMULATE: prove the whole pipeline — request → approve → lock → build → nudge → auto-release —
# without touching the real box. Real deploys are gated on a human approving the request anyway;
# this gate is for verifying ZEEHIVE itself.
if [ "$MODE" != "real" ]; then
  echo "SIMULATE: would deploy '$SVC' to $CTX from $SRC @ $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null)" >&2
  echo "SIMULATE:   docker --context $CTX compose -p $PROJECT --env-file $ENV_FILE -f $COMPOSE build $SVC" >&2
  echo "SIMULATE:   docker --context $CTX compose -p $PROJECT --env-file $ENV_FILE -f $COMPOSE up -d $SVC" >&2
  sleep 2
  emit true simulate
  exit 0
fi

dc() { docker --context "$CTX" compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE" "$@"; }

echo "shipping $SVC → $CTX from $SRC @ $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null)" >&2
if ! dc build "$SVC" >&2; then emit false build-failed; exit 1; fi
if ! dc up -d "$SVC" >&2; then emit false up-failed; exit 1; fi
emit true compose-build
