#!/usr/bin/env bash
# Install the ZEEHIVE landing gate into a project's XOURCE as its `update` hook.
#
#   install-land-gate.sh <repo_root> <project_id> <main_branch> [api_base]
#   install-land-gate.sh --status <repo_root>
#   install-land-gate.sh --uninstall <repo_root>
#
# The hook is MACHINE-LOCAL: .git/hooks is not version-controlled and does not travel with a
# clone, so this must be run once per machine per project. Re-run it after changing a project's
# main_branch — the protected ref is baked in (so that a queenzee outage can only ever block
# pushes to main, never to any other branch).
#
# Refuses to clobber a foreign update hook: an unrelated hook there is someone else's decision.
set -uo pipefail

TEMPLATE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$TEMPLATE_DIR/hooks/land-gate-update.sh"
MARKER="ZEEHIVE LANDING GATE"

hooks_dir() { # <repo_root> — honour core.hooksPath (OmniBiz sets it to an absolute path)
  local hp; hp="$(git -C "$1" config --get core.hooksPath 2>/dev/null || true)"
  if [ -n "$hp" ]; then
    case "$hp" in /*|[A-Za-z]:[\\/]*) printf '%s\n' "$hp" ;;    # already absolute
                  *) printf '%s\n' "$(cd "$1" && cd "$hp" 2>/dev/null && pwd)" ;; esac
    return
  fi
  # --path-format=absolute is REQUIRED: bare --git-common-dir answers a RELATIVE '.git', which
  # would resolve against the caller's cwd and quietly install the gate into the wrong repo.
  printf '%s\n' "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/hooks"
}

case "${1:-}" in
  --status)
    RR="${2:?usage: --status <repo_root>}"; HD="$(hooks_dir "$RR")"; H="$HD/update"
    if [ -f "$H" ] && grep -q "$MARKER" "$H" 2>/dev/null; then
      echo "installed: $H"
      grep -E '^(API|PROJECT_ID|PROTECTED_REF)=' "$H" | sed 's/^/  /'
      [ -x "$H" ] && echo "  executable: yes" || echo "  executable: NO (git will ignore it!)"
    elif [ -f "$H" ]; then echo "FOREIGN update hook present (not ours): $H"; exit 2
    else echo "not installed ($H)"; exit 1; fi
    exit 0 ;;
  --uninstall)
    RR="${2:?usage: --uninstall <repo_root>}"; HD="$(hooks_dir "$RR")"; H="$HD/update"
    if [ -f "$H" ] && grep -q "$MARKER" "$H" 2>/dev/null; then rm -f "$H"; echo "removed $H"; exit 0; fi
    echo "nothing of ours to remove at $H"; exit 1 ;;
esac

REPO_ROOT="${1:?usage: install-land-gate.sh <repo_root> <project_id> <main_branch> [api_base]}"
PROJECT_ID="${2:?missing project_id}"
MAIN_BRANCH="${3:?missing main_branch}"
API_BASE="${4:-http://localhost:4700}"

[ -f "$TEMPLATE" ] || { echo "template missing: $TEMPLATE" >&2; exit 1; }
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo: $REPO_ROOT" >&2; exit 1; }
git -C "$REPO_ROOT" rev-parse --verify --quiet "$MAIN_BRANCH" >/dev/null \
  || { echo "no such branch '$MAIN_BRANCH' in $REPO_ROOT" >&2; exit 1; }

HD="$(hooks_dir "$REPO_ROOT")"; HOOK="$HD/update"
mkdir -p "$HD"

if [ -f "$HOOK" ] && ! grep -q "$MARKER" "$HOOK" 2>/dev/null; then
  echo "REFUSING: a foreign 'update' hook already exists at $HOOK" >&2
  echo "  Move it aside (or merge the gate into it) yourself — it is not mine to overwrite." >&2
  exit 1
fi

# sed with | delimiters: Windows paths and URLs both contain /
sed -e "s|__API__|$API_BASE|g" \
    -e "s|__PROJECT_ID__|$PROJECT_ID|g" \
    -e "s|__MAIN_BRANCH__|$MAIN_BRANCH|g" \
    "$TEMPLATE" > "$HOOK"
chmod +x "$HOOK"

echo "installed landing gate → $HOOK"
echo "  project : $PROJECT_ID"
echo "  protects: refs/heads/$MAIN_BRANCH  in  $REPO_ROOT"
echo "  api     : $API_BASE  (FAILS CLOSED if unreachable)"
echo
echo "Verify with:  $0 --status $REPO_ROOT"
