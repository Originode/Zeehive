#!/usr/bin/env bash
# SELF-SHIP — restart the LOCAL ZEEHIVE orchestrator with the code at the approved ref
# (docs/deploy-topology-spec.md §6.3). Same contract as ship-prod.sh / build-container.sh:
#
#   self-ship.sh <source_path> <role> <docker_ctx> <mode> [build_ref]
#   → one JSON line {"ok":bool,"head":"<sha>","method":"...","service":"..."}
#
# The paradox this script exists for: the queenzee that runs it IS the thing being replaced.
# So it never restarts anything inline — it prints its JSON immediately and schedules a DETACHED
# helper (Windows: powershell Start-Process) that, after a grace period for the dying server to
# finish writing its ship record: kills whatever listens on the API port, then starts the new
# server. If the kill lands before the record is written, recoverOrphanShips() in the NEW boot
# finishes the ship from durable state + a health probe. web (vite) rides along with the server
# in `npm run dev` setups and needs no separate restart — role webapp is a no-op restart here.
#
# mode=simulate records the ship without touching any process (ZEEHIVE's own test path).
set -uo pipefail

SRC="${1:?usage: self-ship.sh <source_path> <role> <docker_ctx> <mode> [build_ref]}"
ROLE="${2:?role}"; CTX="${3:-default}"; MODE="${4:-real}"; REF="${5:-master}"

HEAD="$(git -C "$SRC" rev-parse --short "$REF" 2>/dev/null || echo unknown)"
PORT="$(grep -E '^PORT=' "$SRC/.env" 2>/dev/null | tail -1 | cut -d= -f2)"
PORT="${PORT:-4700}"

emit() { printf '{"ok":%s,"head":"%s","method":"%s","service":"%s"}\n' "$1" "$HEAD" "$2" "$ROLE"; }

# ── GAP 2: rebuild the CAGE IMAGE as part of the approved Zeehive deploy ─────────────────────────
# New caged-zee capabilities (the `zee` CLI, cage-sshd/seed/attach scripts) ship INSIDE
# zeehive/zee-agent (docker/zeehive/Dockerfile.zee-agent). Deploying Zeehive must rebuild that image
# so freshly-provisioned cages carry the current code — otherwise the fleet silently stays on an old
# image and a shipped capability never actually reaches a zee. This lives HERE, not in shipgate.js,
# on purpose: self-ship.sh is Zeehive's OWN build_script, so the rebuild is automatically scoped to
# the self-hosting project and CANNOT touch OmniBiz's container-build ship path (which shares
# shipgate.js). Cages run on the `default` docker context (server/src/queenzee/intake.js: `const ctx
# = 'default'`), so the image must exist there; CAGE_IMAGE_CTX overrides for an operator who moves
# the fleet's daemon. Best-effort with LOUD failure: a build failure is reported on the ship card
# (this stdout/stderr is captured into the ship_request row + streamed to the console) but does NOT
# abort the code deploy — a running queenzee on new code with a stale cage image beats a blocked
# ship, and the warning is anything but silent.
CAGE_IMAGE="${CAGE_IMAGE:-zeehive/zee-agent}"
CAGE_IMAGE_CTX="${CAGE_IMAGE_CTX:-}"   # empty = the default docker context, where cages actually run
cage_build_cmd() {
  local ctxargs=""
  [ -n "$CAGE_IMAGE_CTX" ] && ctxargs="--context $CAGE_IMAGE_CTX "
  echo "docker ${ctxargs}build -f \"$SRC/docker/zeehive/Dockerfile.zee-agent\" -t \"$CAGE_IMAGE\" \"$SRC/docker/zeehive\""
}
rebuild_cage_image() {
  echo "self-ship: rebuilding cage image $CAGE_IMAGE @ $HEAD so new cages carry this code" >&2
  local ctxargs=()
  [ -n "$CAGE_IMAGE_CTX" ] && ctxargs=(--context "$CAGE_IMAGE_CTX")
  if docker "${ctxargs[@]}" build -f "$SRC/docker/zeehive/Dockerfile.zee-agent" \
        -t "$CAGE_IMAGE" "$SRC/docker/zeehive" >&2; then
    echo "self-ship: CAGE-IMAGE ok — $CAGE_IMAGE rebuilt at $HEAD; new cages will carry this code" >&2
  else
    echo "self-ship: !!! CAGE-IMAGE FAILED — could NOT rebuild $CAGE_IMAGE; the fleet stays on the OLD" >&2
    echo "self-ship: !!! cage image and newly-provisioned cages will run STALE caged-zee code. The" >&2
    echo "self-ship: !!! queenzee restart proceeds (code deploy is the priority); rebuild the cage" >&2
    echo "self-ship: !!! image by hand or re-ship: $(cage_build_cmd)" >&2
  fi
}

if [ "$MODE" = "simulate" ]; then
  # Prove the new steps WITHOUT touching any process/daemon (Zeehive's own test path). Mirror REAL
  # mode exactly: only the server role rebuilds the cage image and syncs the tree (webapp rides
  # along as a no-op restart), so only the server role asserts the commands a real deploy would run.
  if [ "$ROLE" = "server" ]; then
    echo "self-ship: [simulate] would rebuild cage image with: $(cage_build_cmd)" >&2
    echo "self-ship: [simulate] would sync working tree with: bash \"$SRC/scripts/self-ship-sync.sh\" \"$SRC\" \"$REF\"" >&2
  else
    echo "self-ship: [simulate] role $ROLE is a no-op restart (rides with the server); no cage/sync steps" >&2
  fi
  emit true "simulate"; exit 0
fi
if [ "$ROLE" = "webapp" ]; then emit true "noop-rides-with-server"; exit 0; fi

# Real server ship: rebuild the cage image NOW, while this (soon-to-die) queenzee is still alive,
# its docker context reachable, and its output still captured by the ship record. Runs before the
# detached restart is scheduled so a cage-image failure lands on the ship card, not into the void.
rebuild_cage_image

# Detached restart helper. Grace period 3s: long enough for runShip to write 'shipped' and start
# the lock countdown; short enough that the port frees before anyone notices. The new process
# resumes anything the old one left mid-flight (recoverOrphanBuilds + recoverOrphanShips at boot).
#
# TWO LESSONS FROM 2026-07-17, both from a relaunch losing its parent's environment:
#   1. Operational mode flags (PROVISION_MODE=real etc.) must live in .env — dotenv loads them at
#      boot, so a bare `npm run server` cannot silently regress the queenzee to simulate. This
#      script deliberately does NOT try to smuggle the dying process's env through; .env is truth.
#   2. `bash` must resolve to GIT bash. A detached PowerShell inherits the SYSTEM PATH, where
#      C:\Windows\system32\bash.exe (WSL, no distro) shadows Git bash — every provisioning script
#      then fails with an empty error. Prepend Git's bin explicitly.
# GAP 1: SYNC THE WORKING TREE between the kill and the start. The landing gate moved `master` with
# update-ref (no working-tree touch), so the files on disk are still the pre-landing code; without
# this the new process would boot STALE bytes. The order is load-bearing: kill the old server FIRST
# (so nothing is reading the tree we are about to reset), THEN reset --hard to the approved sha, THEN
# start. self-ship-sync.sh is defensive — it stashes any unexpected uncommitted edits under a
# labeled stash before resetting, and only ever moves to the exact ship ref ($REF). We start the
# server regardless of the sync's exit (`;`, not `&&`): a running queenzee on old-but-committed code
# is recoverable; a dead one cannot even self-ship the fix.
SRCWIN="$(echo "$SRC" | sed 's|/|\\\\|g')"
# Forward-slash form for the INNER Git bash: it reliably accepts D:/… paths, whereas backslashes
# routed through the nested PowerShell string are ambiguous (PowerShell/quoting can eat them).
SRCUNIX="$(echo "$SRC" | sed 's|\\\\|/|g')"
powershell.exe -NoProfile -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',('Start-Sleep 3; Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id \$_ -Force -ErrorAction SilentlyContinue }; Start-Sleep 1; \$env:Path = \"C:\Program Files\Git\bin;\" + \$env:Path; Set-Location \"${SRCWIN}\"; bash \"${SRCUNIX}/scripts/self-ship-sync.sh\" \"${SRCUNIX}\" \"${REF}\"; npm run server')" >&2 \
  && emit true "detached-restart" \
  || emit false "detach-failed"
