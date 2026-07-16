#!/bin/sh
# ZEEHIVE LANDING GATE — installed as the XOURCE's `update` hook by scripts/install-land-gate.sh.
# (Template. The installer bakes in the project id / API base / branch and copies it into the
# project's .git/hooks/update — that copy is machine-local and NOT version-controlled.)
#
# WHY THIS EXISTS: "land locally: git push . HEAD:main" was only ever an instruction in the zee's
# prompt. A zee followed it and put the DTR payroll work on main with nobody watching. The
# queenzee cannot prevent that from the outside — by the time its poller sees the new tip, main
# has already moved. So the gate lives where the action happens: git declines the push itself.
#
# WHAT IT DOES: fires on every push to the protected branch, asks the queenzee whether a human
# has approved THIS EXACT sha, and declines otherwise — raising a request in the console.
#   - `update` runs once per pushed ref, BEFORE the ref moves. exit != 0 → ref does not move.
#   - It fires ONLY on push. Committing/merging directly on main (i.e. Mark working normally)
#     is untouched.
#   - Worktrees share the common .git, so this one file covers every xell.
#
# FAILS CLOSED. No approval service = no landing. A guard that fails open is not a guard: the
# server being down is exactly when a silent landing would go unnoticed. This is the opposite
# stance to the sibling reference-transaction hook, which guards ordinary local work and must
# never wedge it — this one guards a rare, deliberate, irreversible act.
#
# Deliberate override (human, at the console, on purpose):
#   git -c core.hooksPath=/dev/null push . HEAD:main     # or move this file aside
set -u

# ── baked by the installer ───────────────────────────────────────────────────
API="${ZEEHIVE_API:-__API__}"
PROJECT_ID="__PROJECT_ID__"
# Every ref that is a XOURCE — one per line. main is always in it; a xell that is itself a xource
# (its children land into it) adds its spinoff/ branch. The QUEENZEE rewrites this file whenever a
# xource is created or removed; see server/src/lib/protected-refs.js.
PROTECTED_REFS_FILE="__PROTECTED_REFS_FILE__"
# Fallback if the file is missing (fresh install, or someone deleted it): protect main and nothing
# else — the pre-tree behaviour, which is the safe direction to degrade in.
FALLBACK_REF="refs/heads/__MAIN_BRANCH__"

REF="$1"; OLD="$2"; NEW="$3"

# Is this ref protected? The check is LOCAL and stays local ON PURPOSE. Asking the API "is this
# ref a xource?" would be tidier, but it would mean an unreachable queenzee fails closed on EVERY
# push — wedging every zee on every branch, when the thing being protected is a handful of refs.
# A local list keeps the blast radius of an outage exactly where it was before the tree existed:
# pushes to a xource, never anything else.
if [ -f "$PROTECTED_REFS_FILE" ]; then
  grep -qxF "$REF" "$PROTECTED_REFS_FILE" 2>/dev/null || exit 0
else
  [ "$REF" = "$FALLBACK_REF" ] || exit 0
fi

decline() {
  echo "" >&2
  echo "  ┌─ ZEEHIVE ─────────────────────────────────────────────────────────────" >&2
  echo "  │ LANDING HELD — a human must verify this before it reaches ${REF#refs/heads/}." >&2
  echo "  │" >&2
  echo "  │ $1" >&2
  echo "  │" >&2
  echo "  │ Your commits are SAFE on your branch. Nothing is lost — the push was" >&2
  echo "  │ declined, not your work." >&2
  echo "  │" >&2
  echo "  │ WHAT TO DO: tell your human the landing is waiting in the ZEEHIVE" >&2
  echo "  │ console, then re-run the SAME push once they approve it:" >&2
  echo "  │     git push . HEAD:${REF#refs/heads/}" >&2
  echo "  │ Do NOT try to work around this hook. Do NOT amend/rebase to a new sha —" >&2
  echo "  │ approval is bound to the exact commit a human read." >&2
  echo "  └───────────────────────────────────────────────────────────────────────" >&2
  echo "" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || decline "Gate unreachable: curl not found (failing closed)."

BODY=$(printf '{"project_id":"%s","ref":"%s","old":"%s","new":"%s"}' "$PROJECT_ID" "$REF" "$OLD" "$NEW")

# --fail-with-body so a 4xx/5xx is an error but we still see the message; short timeouts because
# a human is watching a hung push.
RESP=$(curl -s --max-time 10 --connect-timeout 3 \
         -H 'Content-Type: application/json' \
         -X POST "$API/api/land/check" -d "$BODY" 2>/dev/null)
RC=$?

[ $RC -eq 0 ] || decline "Gate unreachable: queenzee at $API did not answer (curl rc=$RC). Failing closed."

case "$RESP" in
  *'"allow":true'*)
    echo "  ZEEHIVE: landing approved by a human — letting ${REF#refs/heads/} move to $(echo "$NEW" | cut -c1-10)." >&2
    exit 0
    ;;
  *'"reason":"rejected"'*)  decline "A human REJECTED this exact commit. Re-pushing it will not help." ;;
  *'"reason":"pending"'*)   decline "Raised for verification in the ZEEHIVE console — waiting on a human." ;;
  *'"reason":"deletion-refused"'*) decline "Deleting ${REF#refs/heads/} is never allowed." ;;
  *'"allow":false'*) decline "Declined by the queenzee." ;;
  *) decline "Gate gave an unreadable answer (failing closed): $(echo "$RESP" | cut -c1-120)" ;;
esac
