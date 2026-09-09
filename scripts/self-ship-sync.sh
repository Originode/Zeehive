#!/usr/bin/env bash
# SELF-SHIP WORKTREE SYNC — bring the self-hosting checkout's WORKING TREE up to the shipped sha.
#
#   self-ship-sync.sh <repo_root> <ship_ref>
#
# WHY THIS EXISTS (gap found landing ed805cc, 2026-07-19): Zeehive runs as node PROCESSES from the
# main checkout's WORKING TREE. The landing gate advances `master` with `git update-ref` (correct —
# a real push would re-invoke the xource hook and self-deadlock the single-threaded server; see
# landgate.js). But update-ref does NOT touch the working tree, so after a gate-landing the files on
# disk are still the OLD code — a plain restart would run stale bytes. Until now a human closed that
# by hand with `git reset --hard <landed-sha>`. This script IS that step, made safe and automatic:
# the self-ship detached restart calls it AFTER killing the old server and BEFORE starting the new
# one, so nothing pulls the rug from under a live process.
#
# SAFE BY CONTRACT (a reset --hard on a live checkout is sharp):
#   * only ever syncs to the EXACT sha passed in (the human-approved ship ref), resolved up front;
#   * unexpected uncommitted changes are PRESERVED in a labeled `git stash` (mirrors the landing
#     "auto-preserved" convention) — never silently discarded;
#   * a clean tree takes the fast path (reset --hard refreshes it to the ref, no stash);
#   * everything it does is logged, to stderr AND to a log file kept OUTSIDE the working tree (so a
#     later sync's untracked-stash sweep never captures our own log).
#
# Exit 0 = tree is at the ship sha. Non-zero = it is NOT (the caller starts the server anyway: a
# running queenzee on the old-but-committed code beats a dead one that cannot even self-ship a fix).
set -uo pipefail

SRC="${1:?usage: self-ship-sync.sh <repo_root> <ship_ref>}"
REF="${2:?ship_ref}"

# Log outside the tree (parent dir) so we never become an untracked file a future sync would stash.
LOG="$(dirname "$SRC")/zeehive-self-ship-sync.log"
# The per-slot deploy ledger and the shared refusal live in one place, because the console script
# needs exactly the same reasoning and a second copy of it would drift (2026-09-03: it had none).
SHIP_SLOT="self-ship"
. "$(dirname "${BASH_SOURCE[0]}")/lib/ship-direction-local.sh"
say() { local m="[$(date -u +%FT%TZ 2>/dev/null || echo now)] self-ship-sync: $*"; echo "$m" >&2; echo "$m" >>"$LOG" 2>/dev/null || true; }

cd "$SRC" 2>/dev/null || { say "FATAL cannot cd into repo_root '$SRC'"; exit 1; }

# Resolve the target sha ONCE, up front. We sync to this and nothing else — never a moving ref.
TARGET="$(git rev-parse --verify "${REF}^{commit}" 2>/dev/null)" || {
  say "FATAL ship ref '$REF' does not resolve in $SRC — leaving the tree untouched"; exit 1; }
BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
say "syncing working tree of $SRC → ${TARGET:0:12} (ref '$REF'); HEAD was $BEFORE"

# DIRECTION — belt and braces (2026-08-23). The AUTHORITATIVE guard is in the server
# (server/src/lib/ship-direction.js, asked in shipgate.runShipBody before anything is built), and it
# has to be: this script is baked into the SERVER IMAGE and lags master until that image is
# republished, so it cannot protect the very ship that rebuilds it. This is the last line of defence
# for the reset below, nothing more.
#
# The check the file already had (`merge-base --is-ancestor "$PREV" "$TARGET"`, below) is about
# whether STASHING is needed — it guards uncommitted work, never the DIRECTION of the move. This one
# guards the direction: if TARGET is behind what is DEPLOYED, `git reset --hard "$TARGET"` walks the
# deployment BACKWARDS, which is exactly what silently reverted two shipped fixes on 2026-08-23.
# Refuse and leave the tree untouched; a rollback is a revert landed on main and shipped forward,
# never a reset to an older sha.
#
# WHAT "DEPLOYED" IS, AND WHY IT IS NOT `HEAD` (the false refusal of 2026-09-03). This check used to
# compare TARGET against `git rev-parse HEAD`, and in THIS repo that is not what is running: the
# landing gate advances master with `update-ref` and never touches the tree (the whole reason this
# script exists, see the header). So HEAD is the LAST LAND, and it runs ahead of the last DEPLOY by
# every landing that happened since. A ship approved after even one landing was refused as
# "BACKWARDS" — b5a7bde1 on 2026-09-03 was strictly FORWARD of the running code and was bounced with
# "would revert everything shipped since", which was never measured. The prod ledger had allowed it
# one layer up; only this script said no.
#
# So the reference is the sha this script last SYNCED THE TREE TO — the tree every self-ship builds
# its image from, which is the honest local answer to "what is production running". It is recorded
# next to the log, outside the tree. THREE sources, most-trustworthy first:
#   1. the ledger file (written on every successful sync below);
#   2. failing that, the log's last "OK working tree now at <sha>" — an older queenzee wrote no
#      ledger, and this makes the very first ship after this change correct instead of the second;
#   3. failing that, HEAD, but ONLY when the tree still matches it. A clean tree at HEAD means no
#      landing has moved the ref since the last sync, so HEAD does describe the deployed files.
# Nothing known → do not refuse, and say so: the authoritative guard already ran server-side, and a
# refusal must be definite (server/src/lib/ship-direction.js decides the same way).
CURRENT="$(git rev-parse --verify HEAD 2>/dev/null || true)"
DEPLOYED=""; DEPLOYED_SRC=""
DEPLOYED="$(ship_ledger_read "$SRC" "$SHIP_SLOT")"
[ -n "$DEPLOYED" ] && DEPLOYED_SRC="the last sync this script recorded"
if [ -z "$DEPLOYED" ] && [ -r "$LOG" ]; then
  LOGGED="$(sed -n 's/.*OK working tree now at \([0-9a-f]\{7,\}\).*/\1/p' "$LOG" 2>/dev/null | tail -1)"
  if [ -n "$LOGGED" ]; then
    DEPLOYED="$(git rev-parse --verify -q "${LOGGED}^{commit}" 2>/dev/null || true)"
    [ -n "$DEPLOYED" ] && DEPLOYED_SRC="the last successful sync in $(basename "$LOG")"
  fi
fi
if [ -z "$DEPLOYED" ] && [ -n "$CURRENT" ] && git diff --quiet HEAD -- 2>/dev/null; then
  DEPLOYED="$CURRENT"; DEPLOYED_SRC="HEAD (the tree matches it, so no landing has moved the ref since)"
fi

if ship_is_backwards "$SRC" "$TARGET" "$DEPLOYED"; then
  ship_say_refusal "$TARGET" "$DEPLOYED" "$DEPLOYED_SRC" "$(ship_behind_count "$SRC" "$TARGET" "$DEPLOYED")"
  say "REFUSED: Tree left at $BEFORE, untouched."
  say "REFUSED: re-request the ship at the current main tip (a human approves the new sha), or land a revert."
  exit 1
fi
if [ -z "$DEPLOYED" ]; then
  say "direction UNCHECKED here — nothing local records what is deployed (no ledger, no prior sync in"
  say "the log, and the tree does not match HEAD, so HEAD is only the last LANDED ref). Proceeding: the"
  say "authoritative guard is server-side (shipgate.runShipBody), and a refusal must be definite."
elif [ "$DEPLOYED" != "$CURRENT" ]; then
  say "direction OK — ${TARGET:0:12} is not behind the deployed ${DEPLOYED:0:12} ($DEPLOYED_SRC);"
  say "HEAD is ${CURRENT:0:12}, which is the last LAND, not the last deploy — that is expected here."
fi

# Decide whether to stash. THE SUBTLETY (measured 2026-07-19): after the landing gate's
# `update-ref` advances master, the working tree still holds the PRE-landing commit's files, so
# `git status` reports the whole ref-move delta as "changes" — but that is EXPECTED and fully
# recoverable (the pre-landing commit is an ancestor of the ship sha, so nothing it holds is lost by
# resetting). Stashing that every ship would litter the checkout with redundant stashes of old code.
# So we only PRESERVE genuinely-unsaved work: content the tree holds that is NOT the pre-landing
# state. PREV is the ref's previous position (its reflog); if the tree matches PREV exactly (tracked
# AND untracked), the dirtiness is purely the ref move → reset straight to the ship sha, no stash. If
# it differs from PREV — a human/process left real edits — OR PREV is unknowable, we stash first
# (fail safe: an unknown provenance is treated as precious, never discarded).
DIRTY="$(git status --porcelain 2>/dev/null)"
if [ -z "$DIRTY" ]; then
  say "tree is clean — fast path (reset --hard just refreshes files to the ship sha)"
else
  PREV="$(git rev-parse -q --verify 'HEAD@{1}' 2>/dev/null || true)"
  pure_refmove=0
  if [ -n "$PREV" ] && git merge-base --is-ancestor "$PREV" "$TARGET" 2>/dev/null \
       && git diff --quiet "$PREV" -- 2>/dev/null \
       && [ -z "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
    pure_refmove=1
  fi
  if [ "$pure_refmove" = 1 ]; then
    say "tree matches the pre-landing commit ${PREV:0:12} (an ancestor of the ship sha) — this is the"
    say "expected update-ref delta, nothing unsaved to lose; resetting to the ship sha without a stash"
  else
    LABEL="zeehive-self-ship: auto-preserved before sync to ${TARGET:0:12} @ $(date -u +%FT%TZ)"
    if git stash push --include-untracked -m "$LABEL" >/dev/null 2>&1; then
      say "PRESERVED unexpected uncommitted changes in stash: '$LABEL' (recover with: git stash list / git stash show -p)"
    else
      say "WARN tree was dirty but 'git stash push' failed — NOT resetting over unsaved work; leaving tree as-is"
      exit 1
    fi
  fi
fi

# Move to the exact approved sha. This is the same operation the human did by hand, but bounded to
# the resolved TARGET (not a ref that could move between resolve and reset).
if git reset --hard "$TARGET" >/dev/null 2>&1; then
  AFTER="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  # Record what the tree — and so the image built from it — now holds. This is the ONE writer of the
  # ledger the direction guard reads at the top; write it only after the reset actually succeeded, so
  # a failed sync can never claim a deploy. A write failure is not fatal: the guard degrades to the
  # log line below, which this same call has already emitted.
  ship_ledger_write "$SRC" "$SHIP_SLOT" "$TARGET" \
    || say "WARN could not record the deployed sha in $(ship_ledger_file "$SRC" "$SHIP_SLOT") (the direction guard will fall back to the log)"
  say "OK working tree now at ${TARGET:0:12} (HEAD $BEFORE → $AFTER)"
  exit 0
fi
say "FATAL 'git reset --hard ${TARGET:0:12}' failed — tree left at $BEFORE (stash, if any, is preserved)"
exit 1
