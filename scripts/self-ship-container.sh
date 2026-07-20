#!/usr/bin/env bash
# SELF-SHIP, CONTAINER ERA — rebuild and recreate the CONTAINERIZED queenzee at the approved ref.
# Same contract as self-ship.sh (which stays the host-process variant until cutover); selection
# between the two is DATA: the Zeehive `server` container row's build_script names one of them.
#
#   self-ship-container.sh <source_path> <role> <docker_ctx> <mode> [build_ref]
#   → one JSON line {"ok":bool,"head":"<sha>","method":"...","service":"..."}
#
# Runs INSIDE the queenzee container (git/bash/docker CLI + compose plugin are in the image; the
# local daemon is the mounted socket). The paradox is the same as the host variant — the process
# running this script dies mid-ship — but the resolution is container-native:
#   1. sync the /repos checkout to the approved sha (the landing gate moved the ref with
#      update-ref, so the tree is stale — same GAP the host variant closes),
#   2. `docker compose build server` NOW, while this queenzee is alive and its output still
#      lands on the ship card,
#   3. emit the JSON, then detach the RECREATE to a sibling helper container (docker:cli on the
#      mounted socket): an in-process `&` child would die with us, a sibling survives. It sleeps
#      a grace period, then `compose up -d server` swaps us for the new image.
# recoverOrphanShips() on the new boot finishes the ship record from durable state, exactly as
# on the host.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE 2>/dev/null || true

SRC="${1:?usage: self-ship-container.sh <source_path> <role> <docker_ctx> <mode> [build_ref]}"
ROLE="${2:?role}"; CTX="${3:-default}"; MODE="${4:-real}"; REF="${5:-master}"

COMPOSE_FILE="$SRC/docker/zeehive/docker-compose.prod.yml"
# The server service sits behind the `experimental` profile until cutover, and compose does NOT
# auto-enable a profile just because the service is named on the command line — without this,
# `build server`/`up -d server` answer "no such service". Harmless after cutover drops the
# profile: enabling a profile no service carries is a no-op.
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-experimental}"
HEAD="$(git -C "$SRC" rev-parse --short "$REF" 2>/dev/null || echo unknown)"

emit() { printf '{"ok":%s,"head":"%s","method":"%s","service":"%s"}\n' "$1" "$2" "$3" "$ROLE"; }

# Cage-image rebuild — same GAP-2 rationale and same loud-but-non-fatal stance as self-ship.sh:
# new caged-zee capabilities ship inside zeehive/zee-agent, and a stale fleet image is a silent
# capability loss. Cages run on the local daemon (the mounted socket).
CAGE_IMAGE="${CAGE_IMAGE:-zeehive/zee-agent}"
rebuild_cage_image() {
  echo "self-ship: rebuilding cage image $CAGE_IMAGE @ $HEAD" >&2
  if docker build -f "$SRC/docker/zeehive/Dockerfile.zee-agent" -t "$CAGE_IMAGE" "$SRC/docker/zeehive" >&2; then
    echo "self-ship: CAGE-IMAGE ok — new cages will carry $HEAD" >&2
  else
    echo "self-ship: !!! CAGE-IMAGE FAILED — the fleet stays on the OLD image; rebuild by hand or re-ship" >&2
  fi
}

if [ "$MODE" = "simulate" ]; then
  if [ "$ROLE" = "server" ]; then
    echo "self-ship: [simulate] would sync $SRC to $REF, rebuild $CAGE_IMAGE, compose build server," >&2
    echo "self-ship: [simulate] then detach a docker:cli sibling to 'compose up -d server'" >&2
  fi
  emit true "$HEAD" "simulate"; exit 0
fi
if [ "$ROLE" = "webapp" ]; then
  # webapp is its own container with its own build_script (ship-zeehive-web.sh) — reaching this
  # script with role webapp means the inventory is miswired; refuse loudly instead of no-opping.
  echo "self-ship: role webapp does not ship via self-ship-container.sh — use ship-zeehive-web.sh" >&2
  emit false "$HEAD" "wrong-role"; exit 1
fi

# 1 — sync the checkout to the approved sha (defensive stash inside self-ship-sync.sh). Unlike
# the host variant, this runs BEFORE the build (the image is built FROM this tree) and before
# anything dies, so failure lands on the ship card and aborts cleanly.
if ! bash "$SRC/scripts/self-ship-sync.sh" "$SRC" "$REF" >&2; then
  emit false "$HEAD" "tree-sync-failed"; exit 1
fi
HEAD="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo "$HEAD")"

rebuild_cage_image

# 2 — build the new server image now, output onto the ship card.
if ! docker compose -f "$COMPOSE_FILE" build server >&2; then
  emit false "$HEAD" "image-build-failed"; exit 1
fi

# 3 — detach the recreate to a sibling container and report. Grace 3s: enough for runShip to
# write 'shipped'; the sibling holds only the socket + the repos volume, so it outlives us and
# --rm cleans it up. It mounts zeehive_repos at /repos exactly like the queenzee container, so
# $COMPOSE_FILE (an /repos/... path here) resolves identically inside the sibling. The compose
# project name stays pinned by the file's `name:` — never pass -p.
if docker run -d --rm \
     -e COMPOSE_PROFILES="$COMPOSE_PROFILES" \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v zeehive_repos:/repos:ro \
     docker:cli sh -c "sleep 3; docker compose -f '$COMPOSE_FILE' up -d server" >&2; then
  emit true "$HEAD" "sibling-recreate"
else
  emit false "$HEAD" "detach-failed"; exit 1
fi
