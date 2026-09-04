#!/usr/bin/env bash
# THE LOCAL DEPLOY LEDGER — what each production slot was last deployed FROM, recorded beside the
# checkout, and the backwards-refusal both ship scripts make from it. Sourced, never executed.
#
# WHY A LEDGER AND NOT `git rev-parse HEAD` (the false refusal of 2026-09-03). The landing gate
# advances master with `update-ref` and never touches the working tree, so in this self-hosting
# checkout HEAD is the last LAND — it runs ahead of the last DEPLOY by every landing since. The
# server's sync guard used to compare against it and refused b5a7bde1, a ship that was strictly
# FORWARD of the running code, with "would revert everything shipped since". Nothing had shipped.
# What a deploy actually moves is a SLOT, so the honest local record is per slot: the sha that slot
# was last deployed from, written by the step that deployed it, read by the next one.
#
# A SLOT is a thing that moves independently. Two today, and they really are independent — on
# 2026-09-03 the server leg of one ship refused while the web leg of the SAME ship built and
# deployed, because only the server had a guard:
#   self-ship  — the queenzee's own working tree (scripts/self-ship-sync.sh resets it)
#   web        — the console image (scripts/ship-zeehive-web.sh builds it from a detached worktree)
#
# The AUTHORITATIVE direction guard is still the server's (server/src/lib/ship-direction.js, asked
# in shipgate.runShipBody from the ship LEDGER, before anything is built). Everything here is the
# last line of defence, and it obeys the same rule: a refusal must be DEFINITE. Nothing recorded
# means "do not know", which means proceed and say so — never a guessed refusal that makes
# production unshippable on a missing file.

# Where a slot's ledger lives: outside the tree (so no sync's untracked-stash sweep ever captures
# it) and scoped by checkout basename, because /repos holds more than one project's checkout and a
# shared ledger would answer with the wrong repo's sha.
ship_ledger_file() {   # <src> <slot>
  printf '%s/zeehive-%s-deployed-%s.sha\n' "$(dirname "$1")" "$2" "$(basename "$1")"
}

# The recorded sha for a slot, resolved in THIS repo (a sha that no longer resolves is not an
# answer). Empty output = nothing known; never an error.
ship_ledger_read() {   # <src> <slot>
  local f; f="$(ship_ledger_file "$1" "$2")"
  [ -r "$f" ] || return 0
  git -C "$1" rev-parse --verify -q "$(tr -d '[:space:]' <"$f")^{commit}" 2>/dev/null || true
}

# Record what a slot now runs. ONLY ever call this after the deploy step actually succeeded — a
# ledger that logs intentions instead of outcomes would refuse the retry of a failed ship.
ship_ledger_write() {  # <src> <slot> <sha>
  printf '%s\n' "$3" >"$(ship_ledger_file "$1" "$2")" 2>/dev/null
}

# Would deploying <target> move this slot BACKWARDS from <deployed>? Only ever true on ancestry:
# a diverged sha is not behind, and an unreadable one is not an answer.
ship_is_backwards() {  # <src> <target> <deployed>
  [ -n "$3" ] || return 1
  [ "$3" != "$2" ] || return 1
  git -C "$1" merge-base --is-ancestor "$2" "$3" 2>/dev/null
}

ship_behind_count() {  # <src> <target> <deployed>
  git -C "$1" rev-list --count "${2}..${3}" 2>/dev/null || echo '?'
}

# The refusal every local guard shares, word for word. "BACKWARDS ship refused" is not free to
# reword: it is what server/src/lib/ship-failure.js keys on to classify the failure as
# 'ship-behind-live', which is what the console renders on the card. Each caller adds its own
# tail — what it left untouched.
# Printed through the caller's say() when it has one (self-ship-sync logs to a file too).
ship_say() {
  if declare -F say >/dev/null 2>&1; then say "$@"; else echo "$*" >&2; fi
}
ship_say_refusal() {   # <target> <deployed> <deployed_src> <behind>
  ship_say "REFUSED: BACKWARDS ship refused — the target ${1:0:12} is an ancestor of what is DEPLOYED"
  ship_say "REFUSED: (${2:0:12}, per $3), $4 commit(s) behind. Deploying it would roll production"
  ship_say "REFUSED: BACKWARDS and revert everything shipped since."
}
