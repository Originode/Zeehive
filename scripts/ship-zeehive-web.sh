#!/usr/bin/env bash
# Ship the ZEEHIVE production dashboard — as a CONTAINER on machine 'local' (desktop-linux).
# Same contract as self-ship.sh / ship-prod.sh, so the shipgate drives it unchanged:
#
#   ship-zeehive-web.sh <source_path> <role> <docker_ctx> <mode> [build_ref]
#   → one JSON line {"ok":bool,"head":"<sha>","method":"...","service":"..."}
#
# Builds from a DETACHED worktree at the approved ref — never from the live working tree, whose
# uncommitted edits would otherwise ride into prod unreviewed. The image is built straight on the
# target daemon (no registry hop needed: build and run are the same context here).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE 2>/dev/null || true
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SRC="${1:?usage: ship-zeehive-web.sh <source_path> <role> <docker_ctx> <mode> [build_ref]}"
ROLE="${2:-webapp}"; CTX="${3:-desktop-linux}"; MODE="${4:-real}"; REF="${5:-master}"
[ -n "$CTX" ] || CTX="desktop-linux"

HEAD="$(git -C "$SRC" rev-parse --short "$REF" 2>/dev/null || echo unknown)"
emit() { printf '{"ok":%s,"head":"%s","method":"%s","service":"%s"}\n' "$1" "$HEAD" "$2" "$ROLE"; }

if [ "$MODE" = "simulate" ]; then emit true "simulate"; exit 0; fi

# Detached checkout of exactly the approved sha. Lives under the repo (a real Windows path the
# docker CLI accepts); its own copy of .dockerignore keeps the context lean.
CTXDIR="$SRC/.ship-web-ctx"
git -C "$SRC" worktree remove --force "$CTXDIR" >/dev/null 2>&1 || true
rm -rf "$CTXDIR" 2>/dev/null || true
if ! git -C "$SRC" worktree add --detach "$CTXDIR" "$REF" >&2; then
  emit false "worktree-add-failed"; exit 1
fi

docker --context "$CTX" build -f "$CTXDIR/docker/zeehive/Dockerfile.web" -t zeehive-web:prod "$CTXDIR" >&2
BUILD=$?
git -C "$SRC" worktree remove --force "$CTXDIR" >&2 2>&1 || true

if [ $BUILD -ne 0 ]; then emit false "image-build-failed"; exit 1; fi

if docker --context "$CTX" compose -f "$SRC/docker/zeehive/docker-compose.prod.yml" up -d --no-build web >&2; then
  emit true "container-build"
else
  emit false "compose-up-failed"; exit 1
fi
