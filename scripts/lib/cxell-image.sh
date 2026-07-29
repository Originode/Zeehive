#!/usr/bin/env bash
# CXELL-IMAGE REBUILD — the ONE implementation, sourced by both self-ship variants.
#
#   source "<repo>/scripts/lib/cxell-image.sh"
#   rebuild_cxell_image   # 0 = image is current; 1 = it is NOT (caller decides fatality)
#   cxell_image_required  # 0 = a failure must fail the SHIP; 1 = escape hatch engaged
#
# WHY THIS FILE EXISTS. New cxell-zee capabilities (the `zee` CLI, cxell-sshd/seed/attach) ship
# INSIDE zeehive/zee-agent, so deploying Zeehive must rebuild that image or the fleet silently
# stays on an old one and a shipped capability never reaches a zee. That step used to be copied
# into self-ship.sh and self-ship-container.sh, and the two had already drifted.
#
# IT ALSO FIXES TWO REAL DEFECTS, both measured on the cad07a8 ship (2026-07-28):
#
#  1. THE BUILD READ THE WRONG BYTES. The host variant runs BEFORE self-ship-sync.sh (it must —
#     the tree may only be reset AFTER the old server is killed), and the landing gate advances
#     the branch with `git update-ref`, which does not touch the working tree. So `docker build
#     … "$SRC"` built the PRE-LANDING tree: the shipped Dockerfile and the shipped scripts/zee
#     were not in the context at all. With every input unchanged, docker hit cache on every layer
#     and produced a BYTE-IDENTICAL image — a "successful" rebuild that rebuilt nothing. Measured:
#     a cxell cut after that ship carried baked files stamped 17:04:24.483984253, identical to the
#     nanosecond to a cxell cut BEFORE it.
#     FIX: the context is materialized from the SHIP REF itself — `git archive <sha>` piped into
#     `docker build -`. It cannot read the working tree, so it cannot read stale bytes, and the
#     image is the shipped commit BY CONSTRUCTION rather than by ordering luck.
#     (A stdin tar context means .dockerignore does not apply — nor does it need to: `git archive`
#     carries exactly the TRACKED files, which is what .dockerignore was approximating. node_modules,
#     .git and db_backups are untracked and simply are not in it.)
#
#  2. THE FAILURE WAS SILENT. The old code was best-effort: it logged loudly to stderr and then
#     let the ship report SUCCESS anyway. Nothing on the ship card said the fleet image was stale,
#     so nobody could see it without reading a build log they had no reason to open — it took two
#     workers and a mtime forensics detour to find. Now the caller FAILS THE SHIP on a failed
#     rebuild (see cxell_image_required): a queenzee running new code with a silently stale fleet
#     image is precisely the outcome nobody can detect, and "ship failed, nothing changed" is a
#     strictly better state than "ship succeeded, fleet is a lie". The stance is deliberate and
#     reversible per-ship, not a new law:
#
#       CXELL_IMAGE_REQUIRED=0   → the ESCAPE HATCH. Rebuild failure is reported just as loudly
#                                  but does not fail the ship. For the operator who genuinely
#                                  needs the code deploy through with a known-stale fleet image
#                                  (e.g. no docker on this host). It must be passed on purpose.
set -uo pipefail

CXELL_IMAGE="${CXELL_IMAGE:-zeehive/zee-agent}"
CXELL_IMAGE_CTX="${CXELL_IMAGE_CTX:-}"          # empty = the default docker context, where cxells run
CXELL_IMAGE_DOCKERFILE="docker/zeehive/Dockerfile.zee-agent"
CXELL_IMAGE_STATUS="unknown"                    # ok | failed | skipped-not-required
export CXELL_IMAGE CXELL_IMAGE_CTX CXELL_IMAGE_STATUS

# Is a failed rebuild fatal to the ship? 0 = yes (default), 1 = no (escape hatch engaged).
cxell_image_required() { [ "${CXELL_IMAGE_REQUIRED:-1}" != "0" ]; }

# The exact command, for simulate mode and for the "rebuild it by hand" line in a failure report.
# One string, so what simulate PRINTS is what real mode RUNS.
cxell_build_cmd() {
  local ctxargs=""
  [ -n "$CXELL_IMAGE_CTX" ] && ctxargs="--context $CXELL_IMAGE_CTX "
  echo "git -C \"$SRC\" archive --format=tar \"$REF\" | docker ${ctxargs}build -f \"$CXELL_IMAGE_DOCKERFILE\" -t \"$CXELL_IMAGE\" -"
}

_cxi() { echo "self-ship: $*" >&2; }

# Rebuild zeehive/zee-agent from the SHIP REF. 0 = the image now carries this commit; 1 = it does
# not. Never mutates the working tree, never touches a running container.
rebuild_cxell_image() {
  local sha tar rc
  sha="$(git -C "$SRC" rev-parse --verify "${REF}^{commit}" 2>/dev/null)"
  if [ -z "$sha" ]; then
    CXELL_IMAGE_STATUS="failed"
    _cxi "!!! CXELL-IMAGE FAILED — ship ref '$REF' does not resolve in $SRC; refusing to build the"
    _cxi "!!! cxell image from an unknown revision (that is how the fleet ends up on stale code)."
    return 1
  fi
  # The Dockerfile must exist AT THE SHIP REF, not on disk: on the host variant the working tree is
  # still the pre-landing code at this point, so an on-disk check would answer about the wrong tree.
  if ! git -C "$SRC" cat-file -e "${sha}:${CXELL_IMAGE_DOCKERFILE}" 2>/dev/null; then
    CXELL_IMAGE_STATUS="failed"
    _cxi "!!! CXELL-IMAGE FAILED — ${CXELL_IMAGE_DOCKERFILE} does not exist at ${sha:0:12}."
    return 1
  fi

  _cxi "rebuilding cxell image $CXELL_IMAGE from ${sha:0:12} (context = git archive of the SHIP REF,"
  _cxi "not the working tree — the tree is still pre-landing code at this point in a host ship)"

  # Two explicit steps rather than one pipeline, so a failure is attributable to git or to docker.
  tar="$(mktemp -t cxell-ctx.XXXXXX 2>/dev/null || echo "${TMPDIR:-/tmp}/cxell-ctx.$$.tar")"
  if ! git -C "$SRC" archive --format=tar "$sha" > "$tar" 2>/dev/null; then
    rm -f "$tar"
    CXELL_IMAGE_STATUS="failed"
    _cxi "!!! CXELL-IMAGE FAILED — 'git archive' of ${sha:0:12} out of $SRC produced nothing."
    return 1
  fi

  local ctxargs=()
  [ -n "$CXELL_IMAGE_CTX" ] && ctxargs=(--context "$CXELL_IMAGE_CTX")
  docker "${ctxargs[@]}" build -f "$CXELL_IMAGE_DOCKERFILE" -t "$CXELL_IMAGE" - < "$tar" >&2
  rc=$?
  rm -f "$tar"
  if [ $rc -eq 0 ]; then
    CXELL_IMAGE_STATUS="ok"
    _cxi "CXELL-IMAGE ok — $CXELL_IMAGE rebuilt at ${sha:0:12}; new cxells carry this code"
    return 0
  fi
  CXELL_IMAGE_STATUS="failed"
  _cxi "!!! CXELL-IMAGE FAILED — could NOT rebuild $CXELL_IMAGE at ${sha:0:12} (docker exit $rc)."
  _cxi "!!! Every cxell spawned from now on carries the OLD image. The queenzee's spawn-time CLI"
  _cxi "!!! refresh (lib/cxell.js) still installs a current \`zee\`, so the staleness may not even"
  _cxi "!!! be visible from inside a cage — it is exactly the failure nobody can see."
  _cxi "!!! Rebuild by hand, then re-ship: $(cxell_build_cmd)"
  return 1
}
