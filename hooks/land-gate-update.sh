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
# Under load the API can miss a single 10s deadline (curl rc=28) and decline a push a human
# already approved. The remedy is retry-with-backoff inside a bounded wait — a busy queenzee
# answers before we give up. On genuine exhaustion we still decline, with a message that names
# the attempts and duration so it is not confused with a human rejection. A declined push costs
# one re-push; a bypassed gate costs the fleet its only guarantee.
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

# HOLDING is a decline too — the ref does not move, and it must not — but it is NOT the message
# above. Nobody has been asked to verify anything: another xell's landing is open on this ref, so
# this push was queued behind it (one runway, one card). Telling the zee to "tell your human the
# landing is waiting in the console" would send it chasing a card that does not exist, and a human
# looking for a request nobody raised. Say what actually happened, and what actually comes next.
hold() {
  echo "" >&2
  echo "  ┌─ ZEEHIVE ─────────────────────────────────────────────────────────────" >&2
  echo "  │ HOLDING PATTERN — you are queued for ${REF#refs/heads/}, not held for a human." >&2
  echo "  │" >&2
  echo "  │ Another xell already has a landing open on this ref, and the runway" >&2
  echo "  │ takes ONE at a time: two landings on one ref is how a human approves" >&2
  echo "  │ the first and the second can never fast-forward again." >&2
  echo "  │" >&2
  echo "  │ NOTHING was rejected and NOTHING was dropped: your push is recorded" >&2
  echo "  │ with a position, and your commits are safe on your branch. No card was" >&2
  echo "  │ raised for a human — deliberately." >&2
  echo "  │" >&2
  echo "  │ WHAT TO DO: nothing. Do NOT poll and do NOT push again. When the runway" >&2
  echo "  │ clears the queenzee RESUMES your session and tells you to:" >&2
  echo "  │     zee sync    # the xell ahead landed, so main moved — merge it in" >&2
  echo "  │     zee land    # raises the FRESH request a human decides on" >&2
  echo "  │ To leave the pattern instead:  zee land --withdraw --reason \"…\"" >&2
  echo "  └───────────────────────────────────────────────────────────────────────" >&2
  echo "" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || decline "Gate unreachable: curl not found (failing closed)."

BODY=$(printf '{"project_id":"%s","ref":"%s","old":"%s","new":"%s"}' "$PROJECT_ID" "$REF" "$OLD" "$NEW")

# Ask the gate. Short per-attempt deadline (a human is watching a hung push); we retry below
# rather than stretch a single curl into a minute-long stall with no progress.
ask_gate() {
  curl -s --max-time 10 --connect-timeout 3 \
       -H 'Content-Type: application/json' \
       -X POST "$API/api/land/check" -d "$BODY" 2>/dev/null
}

# Retry with linear backoff. Transient load (the measured cause) clears in seconds; three
# attempts at 10s each, sleeping 1s then 2s between, covers a brief freeze without waiting
# forever on a truly dead API. Bounded total wait ≈ 10+1+10+2+10 = 33s.
RESP=""
RC=1
ATTEMPT=1
MAX_ATTEMPTS=3
STARTED_AT=$(date +%s 2>/dev/null || echo 0)
while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  RESP=$(ask_gate)
  RC=$?
  # A transport success with a body is an answer — even allow:false. Empty body with rc=0 is
  # treated as unreachable (nothing to parse).
  if [ "$RC" -eq 0 ] && [ -n "$RESP" ]; then
    break
  fi
  if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
    echo "  ZEEHIVE: gate did not answer (attempt $ATTEMPT/$MAX_ATTEMPTS, curl rc=$RC) — retrying…" >&2
    sleep "$ATTEMPT"
  fi
  ATTEMPT=$((ATTEMPT + 1))
done

if [ "$RC" -ne 0 ] || [ -z "$RESP" ]; then
  ENDED_AT=$(date +%s 2>/dev/null || echo 0)
  if [ "$STARTED_AT" -gt 0 ] && [ "$ENDED_AT" -ge "$STARTED_AT" ]; then
    ELAPSED=$((ENDED_AT - STARTED_AT))
  else
    ELAPSED='?'
  fi
  # FAIL CLOSED. Name the attempts and duration so this is not read as a human rejection —
  # the zee re-runs the same push once the queenzee is answering again. Nothing is lost.
  decline "Gate did not answer — not a human rejection. Tried ${MAX_ATTEMPTS} times over ~${ELAPSED}s against $API (last curl rc=$RC). Re-run the SAME push when the queenzee is up; do not amend."
fi

case "$RESP" in
  *'"allow":true'*)
    echo "  ZEEHIVE: landing approved by a human — letting ${REF#refs/heads/} move to $(echo "$NEW" | cut -c1-10)." >&2
    exit 0
    ;;
  *'"reason":"rejected"'*)  decline "A human REJECTED this exact commit. Re-pushing it will not help." ;;
  *'"reason":"pending"'*)   decline "Raised for verification in the ZEEHIVE console — waiting on a human." ;;
  *'"reason":"holding"'*)   hold ;;
  *'"reason":"deletion-refused"'*) decline "Deleting ${REF#refs/heads/} is never allowed." ;;
  *'"allow":false'*) decline "Declined by the queenzee." ;;
  *) decline "Gate gave an unreadable answer (failing closed): $(echo "$RESP" | cut -c1-120)" ;;
esac
