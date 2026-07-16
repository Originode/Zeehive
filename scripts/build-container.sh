#!/usr/bin/env bash
# REAL build of ONE service (server|webapp) of a xell's ephemeral app tier, on the dev context.
# Run BY the queenzee (like provision/despawn/land). Mirrors the project's own scripts/spin-env.sh
# exactly — same compose file, project name, --env-file, slug and deterministic ports — but targets
# a single service instead of the whole tier. Emits one JSON line for the Node projector.
#
#   build-container.sh <worktree> <role:server|webapp> <docker_ctx> <hot:true|false> [mode]
#
#   build (hot=false) : `compose build <svc>` + `up -d <svc>`  — rebuilds the image from THIS
#                       worktree's code (layer-cached) and recreates the container.
#   hot   (hot=true)  : `compose up -d --no-build <svc>`       — bounce the container from the
#                       existing image, no rebuild. Fast, but does NOT pick up code changes
#                       (the compose bakes code into the image; there is no source mount).
#   mode=simulate     : record the build without touching Docker (demo/on-ramp escape hatch).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true

WT="${1:?usage: build-container.sh <worktree> <role> <ctx> <hot> [mode]}"
ROLE="${2:?role}"; CTX="${3:-ugreen-nas}"; HOT="${4:-false}"; MODE="${5:-real}"
case "$ROLE" in
  server) SVC=server ;;
  webapp) SVC=webapp ;;
  *) echo "role '$ROLE' is not buildable (server|webapp only)" >&2; exit 2 ;;
esac

HEAD="$(git -C "$WT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# --- the meta-DB's recorded facts win; derivation below is the fallback ------------------------
# The queenzee passes what it recorded at provision time (BUILD_COMPOSE_FILE, BUILD_COMPOSE_PROJECT,
# BUILD_ENV_FILE, SPINOFF_SLUG, SPINOFF_*_PORT). A bare invocation still derives the OmniBiz-shaped
# defaults, exactly mirroring the project's spin-env.sh.
if [ -n "${BUILD_COMPOSE_FILE:-}" ]; then
  case "$BUILD_COMPOSE_FILE" in
    /*|[A-Za-z]:*) COMPOSE="$BUILD_COMPOSE_FILE" ;;   # absolute (posix or windows drive)
    *)             COMPOSE="$WT/$BUILD_COMPOSE_FILE" ;;
  esac
else
  COMPOSE="$WT/docker-compose.spinoff.yml"
fi
if [ -n "${BUILD_ENV_FILE:-}" ]; then
  ENV_FILE="$BUILD_ENV_FILE"
else
  # MAIN = the primary checkout (not under .claude/worktrees) — it owns the real .env.
  MAIN="$(git -C "$WT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | grep -v '/\.claude/worktrees/' | head -1)"
  ENV_FILE="$MAIN/.env"
fi
SLUG="${SPINOFF_SLUG:-$(basename "$WT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/-\+/-/g; s/^-//; s/-$//')}"
PROJECT="${BUILD_COMPOSE_PROJECT:-omnibiz-spin-$SLUG}"
HASH="$(printf '%s' "$SLUG" | md5sum | cut -c1-4)"
SLOT="$(( 16#$HASH % 90 ))"
export SPINOFF_SLUG="$SLUG"
export SPINOFF_SERVER_PORT="${SPINOFF_SERVER_PORT:-$((3100 + SLOT))}"
export SPINOFF_WEB_PORT="${SPINOFF_WEB_PORT:-$((5200 + SLOT))}"
export GIT_COMMIT_HASH="$HEAD"

emit() { printf '{"ok":%s,"head":"%s","hot":%s,"method":"%s","service":"%s","project":"%s"}\n' \
  "$1" "$HEAD" "$HOT" "$2" "$SVC" "$PROJECT"; }

if [ "$MODE" = "simulate" ]; then emit true "simulate"; exit 0; fi

[ -f "$COMPOSE" ]  || { echo "compose file not found: $COMPOSE (is docker-compose.spinoff.yml on this branch?)" >&2; emit false none; exit 1; }
[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE (the main checkout must have its .env)" >&2; emit false none; exit 1; }

dc() { docker --context "$CTX" compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE" "$@"; }

ok=true
if [ "$HOT" = "true" ]; then
  method=hot
  dc up -d --no-build "$SVC" >&2 || ok=false
else
  method=cold
  dc build "$SVC" >&2 && dc up -d "$SVC" >&2 || ok=false
fi
emit "$ok" "$method"
