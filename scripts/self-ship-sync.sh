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
say() { local m="[$(date -u +%FT%TZ 2>/dev/null || echo now)] self-ship-sync: $*"; echo "$m" >&2; echo "$m" >>"$LOG" 2>/dev/null || true; }

cd "$SRC" 2>/dev/null || { say "FATAL cannot cd into repo_root '$SRC'"; exit 1; }

# Resolve the target sha ONCE, up front. We sync to this and nothing else — never a moving ref.
TARGET="$(git rev-parse --verify "${REF}^{commit}" 2>/dev/null)" || {
  say "FATAL ship ref '$REF' does not resolve in $SRC — leaving the tree untouched"; exit 1; }
BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
say "syncing working tree of $SRC → ${TARGET:0:12} (ref '$REF'); HEAD was $BEFORE"

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
  say "OK working tree now at ${TARGET:0:12} (HEAD $BEFORE → $AFTER)"
  exit 0
fi
say "FATAL 'git reset --hard ${TARGET:0:12}' failed — tree left at $BEFORE (stash, if any, is preserved)"
exit 1
