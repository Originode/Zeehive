#!/usr/bin/env bash
# Assess a pooled xell's worktree against the source and, when it's a clean catch-up,
# fast-forward it onto the source tip. Run BY the queenzee (like provision/despawn/
# check-containers). Deterministic, no AI. The Node reconciler uses the reported `reason`
# to decide: keep (ready), or decommission + reprovision fresh.
#
#   land-xell.sh <worktree_path> <source_branch> [max_behind]
#
# reason ∈ current | landed | dirty | diverged | too-far | ff-failed | no-worktree
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true

WT="${1:?usage: land-xell.sh <worktree_path> <source_branch> [max_behind]}"
SRC="${2:-main}"
MAX="${3:-200}"
G() { git -C "$WT" "$@"; }

emit() { # reason
  local head ahead behind
  head="$(G rev-parse HEAD 2>/dev/null || echo unknown)"
  behind="$(G rev-list --count "HEAD..$SRC" 2>/dev/null || echo 0)"
  ahead="$(G rev-list --count "$SRC..HEAD" 2>/dev/null || echo 0)"
  printf '{"reason":"%s","head":"%s","ahead":%s,"behind":%s}\n' "$1" "$head" "${ahead:-0}" "${behind:-0}"
}

[ -e "$WT/.git" ] || { printf '{"reason":"no-worktree","head":"unknown","ahead":0,"behind":0}\n'; exit 0; }

# .zeehive.env is OUR OWN generated projection (emitXellEnv writes it into every worktree,
# and it is not in the project's .gitignore) — counting it as dirt made the pool decommission
# every freshly provisioned xell on the next tick, churning forever (2026-07-17).
dirty="$(G status --porcelain -- ':(exclude).zeehive.env' 2>/dev/null | head -1)"
behind="$(G rev-list --count "HEAD..$SRC" 2>/dev/null || echo 0)"
ahead="$(G rev-list --count "$SRC..HEAD" 2>/dev/null || echo 0)"

if [ -n "$dirty" ]; then emit dirty; exit 0; fi            # uncommitted junk → decommission
if [ "${ahead:-0}" -gt 0 ]; then emit diverged; exit 0; fi # a pooled xell with own commits is anomalous
if [ "${behind:-0}" -eq 0 ]; then emit current; exit 0; fi # already on the source tip → ready
if [ "${behind:-0}" -gt "${MAX:-200}" ]; then emit too-far; exit 0; fi  # too stale → decommission

if G merge --ff-only "$SRC" >&2 2>/dev/null; then emit landed; else emit ff-failed; fi
