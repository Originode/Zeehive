#!/usr/bin/env bash
# Build one per-xell container (server or webapp) from its worktree code. Run BY the queenzee
# (like provision/despawn/land). Reports the worktree HEAD it built at + whether it was a HOT
# build (fast reload of the running container) vs a COLD build (full image rebuild). Emits one
# JSON line. In simulate mode it records the build without touching Docker (safe on-ramp).
#
#   build-container.sh <worktree> <service> <docker_ctx> <compose_project> <compose_file> <mode> <hot>
#     mode ∈ real | simulate     hot ∈ true | false
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true

WT="${1:?usage: build-container.sh <worktree> <service> <ctx> <project> <file> <mode> <hot>}"
SVC="${2:?service}"; CTX="${3:-ugreen-nas}"; CPROJ="${4:-}"; CFILE="${5:-}"; MODE="${6:-simulate}"; HOT="${7:-false}"

HEAD="$(git -C "$WT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
ok=true; method=simulate

if [ "$MODE" = "real" ]; then
  COMPOSE=(docker --context "$CTX" compose)
  [ -n "$CPROJ" ] && COMPOSE+=(-p "$CPROJ")
  [ -n "$CFILE" ] && [ -f "$WT/$CFILE" ] && COMPOSE+=(-f "$WT/$CFILE")
  if [ "$HOT" = "true" ]; then
    # hot: restart the already-running container so it picks up mounted worktree code — no rebuild
    method=hot
    ( cd "$WT" && "${COMPOSE[@]}" up -d --no-build "$SVC" >&2 ) || ok=false
  else
    # cold: rebuild the image from the current worktree, then recreate
    method=cold
    ( cd "$WT" && "${COMPOSE[@]}" up -d --build "$SVC" >&2 ) || ok=false
  fi
else
  method=$([ "$HOT" = "true" ] && echo hot || echo cold)   # simulate: just record the build
fi

printf '{"ok":%s,"head":"%s","hot":%s,"method":"%s","service":"%s"}\n' "$ok" "$HEAD" "$HOT" "$method" "$SVC"
