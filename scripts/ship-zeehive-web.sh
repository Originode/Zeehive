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

# The console is its OWN deploy slot: it moves when a web ship succeeds, not when the server one
# does, so it keeps its own ledger and reads nobody else's. Same reasoning, same refusal wording and
# the same ledger format as the server leg — shared, because on 2026-09-03 the two legs of ONE ship
# disagreed (the server leg refused b5a7bde1 as backwards while this script, with no direction check
# at all, happily built and deployed it) and a second copy of the logic is how that happens.
SHIP_SLOT="web"
. "$(dirname "${BASH_SOURCE[0]}")/lib/ship-direction-local.sh"
say() { echo "[$(date -u +%FT%TZ 2>/dev/null || echo now)] ship-zeehive-web: $*" >&2; }

HEAD="$(git -C "$SRC" rev-parse --short "$REF" 2>/dev/null || echo unknown)"
emit() { printf '{"ok":%s,"head":"%s","method":"%s","service":"%s"}\n' "$1" "$HEAD" "$2" "$ROLE"; }

if [ "$MODE" = "simulate" ]; then emit true "simulate"; exit 0; fi

# DIRECTION — belt and braces, exactly as in self-ship-sync.sh. The AUTHORITATIVE guard is
# server-side (server/src/lib/ship-direction.js, asked in shipgate.runShipBody before anything is
# built); this is the last line of defence for the build below, nothing more.
#
# Note what is NOT the reference here. HEAD of $SRC is the last LAND (the landing gate advances
# master with update-ref and never touches the tree), and the live working tree is not what this
# script builds from either — it builds a detached worktree at $REF. The only honest local answer to
# "what is the console container running" is the sha of the last image this script successfully
# deployed, so that is what it records and what it compares against. With no ledger yet — every
# checkout, the first time — there is nothing to compare and the check does not run; it says so
# rather than guessing, because a refusal must be definite.
TARGET="$(git -C "$SRC" rev-parse --verify -q "${REF}^{commit}" 2>/dev/null || true)"
if [ -z "$TARGET" ]; then
  say "direction UNCHECKED — ref '$REF' does not resolve in $SRC (the worktree add below will fail on it)"
else
  DEPLOYED="$(ship_ledger_read "$SRC" "$SHIP_SLOT")"
  if ship_is_backwards "$SRC" "$TARGET" "$DEPLOYED"; then
    ship_say_refusal "$TARGET" "$DEPLOYED" "the last web ship this script recorded" \
      "$(ship_behind_count "$SRC" "$TARGET" "$DEPLOYED")"
    say "REFUSED: nothing was built and no container was touched."
    say "REFUSED: re-request the ship at the current main tip (a human approves the new sha), or land a revert."
    emit false "direction-refused"; exit 1
  fi
  if [ -z "$DEPLOYED" ]; then
    say "direction UNCHECKED — no ledger at $(ship_ledger_file "$SRC" "$SHIP_SLOT") yet, so nothing local"
    say "records what this console is running. Proceeding: the authoritative guard is server-side."
  elif [ "$DEPLOYED" != "$TARGET" ]; then
    say "direction OK — ${TARGET:0:12} is not behind the deployed ${DEPLOYED:0:12} (the last web ship this script recorded)"
  fi
fi

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
  # Record what the console container now runs — the ONE writer of the ledger the guard reads above,
  # written only after the deploy actually succeeded so a failed ship can never claim one. A write
  # failure is not fatal: it only means the next ship's local check has nothing to measure against
  # and will say so (the server-side guard is unaffected).
  if [ -n "${TARGET:-}" ]; then
    ship_ledger_write "$SRC" "$SHIP_SLOT" "$TARGET" \
      || say "WARN could not record the deployed sha in $(ship_ledger_file "$SRC" "$SHIP_SLOT")"
  fi
  say "OK console container deployed at ${TARGET:0:12}"
  emit true "container-build"
else
  emit false "compose-up-failed"; exit 1
fi
