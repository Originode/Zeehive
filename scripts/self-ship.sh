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

if [ "$MODE" = "simulate" ]; then emit true "simulate"; exit 0; fi
if [ "$ROLE" = "webapp" ]; then emit true "noop-rides-with-server"; exit 0; fi

# Detached restart helper. Grace period 3s: long enough for runShip to write 'shipped' and start
# the lock countdown; short enough that the port frees before anyone notices. The new process
# resumes anything the old one left mid-flight (recoverOrphanBuilds + recoverOrphanShips at boot).
SRCWIN="$(echo "$SRC" | sed 's|/|\\\\|g')"
powershell.exe -NoProfile -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',('Start-Sleep 3; Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id \$_ -Force -ErrorAction SilentlyContinue }; Start-Sleep 1; Set-Location \"${SRCWIN}\"; npm run server')" >&2 \
  && emit true "detached-restart" \
  || emit false "detach-failed"
