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

# ── GAP 2: rebuild the CXELL IMAGE as part of the approved Zeehive deploy ─────────────────────────
# New cxell-zee capabilities (the `zee` CLI, cxell-sshd/seed/attach scripts) ship INSIDE
# zeehive/zee-agent (docker/zeehive/Dockerfile.zee-agent), so deploying Zeehive must rebuild that
# image or the fleet silently stays on an old one and a shipped capability never reaches a zee.
# This lives HERE, not in shipgate.js, on purpose: self-ship.sh is Zeehive's OWN build_script, so
# the rebuild is scoped to the self-hosting project and CANNOT touch OmniBiz's container-build ship
# path (which shares shipgate.js). Cxells run on the `default` docker context
# (server/src/queenzee/intake.js: `const ctx = 'default'`), so the image must exist there;
# CXELL_IMAGE_CTX overrides for an operator who moves the fleet's daemon.
#
# The implementation is SHARED with self-ship-container.sh (scripts/lib/cxell-image.sh) — it used to
# be copied into both and they had already drifted. Read that file for the two defects it fixes:
# the context is now materialized from the SHIP REF (this script runs BEFORE self-ship-sync.sh, so
# the working tree here is still pre-landing code), and a failed rebuild now FAILS THE SHIP instead
# of being reported into a log nobody opens. CXELL_IMAGE_REQUIRED=0 is the escape hatch.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cxell-image.sh"

if [ "$MODE" = "simulate" ]; then
  # Prove the new steps WITHOUT touching any process/daemon (Zeehive's own test path). Mirror REAL
  # mode exactly: only the server role rebuilds the cxell image and syncs the tree (webapp rides
  # along as a no-op restart), so only the server role asserts the commands a real deploy would run.
  if [ "$ROLE" = "server" ]; then
    echo "self-ship: [simulate] would rebuild cxell image with: $(cxell_build_cmd)" >&2
    echo "self-ship: [simulate] a cxell-image failure would $(cxell_image_required \
            && echo 'FAIL THE SHIP (CXELL_IMAGE_REQUIRED=0 to override)' \
            || echo 'be reported but NOT fail the ship (escape hatch CXELL_IMAGE_REQUIRED=0 is set)')" >&2
    echo "self-ship: [simulate] would sync working tree with: bash \"$SRC/scripts/self-ship-sync.sh\" \"$SRC\" \"$REF\"" >&2
  else
    echo "self-ship: [simulate] role $ROLE is a no-op restart (rides with the server); no cxell/sync steps" >&2
  fi
  emit true "simulate"; exit 0
fi
if [ "$ROLE" = "webapp" ]; then emit true "noop-rides-with-server"; exit 0; fi

# Real server ship: rebuild the cxell image NOW, while this (soon-to-die) queenzee is still alive,
# its docker context reachable, and its output still captured by the ship record. Runs before the
# detached restart is scheduled so a cxell-image failure lands on the ship card, not into the void —
# and, since the restart is scheduled BELOW, a fatal failure here means the deploy never starts.
# That ordering is the point: "ship failed, nothing changed" is recoverable and visible; "ship
# succeeded, fleet image silently stale" is neither (it cost two zees a forensics detour on cad07a8).
if ! rebuild_cxell_image; then
  if cxell_image_required; then
    echo "self-ship: !!! ABORTING THE SHIP — the queenzee is NOT being restarted and prod still runs" >&2
    echo "self-ship: !!! the previous code. Nothing is half-applied. Fix the cxell image (or re-run" >&2
    echo "self-ship: !!! this ship with CXELL_IMAGE_REQUIRED=0 to accept a knowingly stale fleet" >&2
    echo "self-ship: !!! image), then approve the ship again." >&2
    emit false "cxell-image-failed"; exit 1
  fi
  echo "self-ship: CXELL_IMAGE_REQUIRED=0 — proceeding with a KNOWINGLY STALE cxell image; every" >&2
  echo "self-ship: cxell spawned from now on runs the OLD image until someone rebuilds it." >&2
fi

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
