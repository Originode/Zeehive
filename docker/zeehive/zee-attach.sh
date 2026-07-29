#!/bin/bash
# Land a human ATTENDING a cxell zee straight in the zee's WORKFLOW. Invoked as the tmux pane
# command by the dashboard terminal bridge: `tmux new -A -s zee -c /work/repo 'zee-attach.sh <sid>'`.
#
# The cxell's runtime (which vendor CLI the headless zee runs on) arrives as $ZEE_RUNTIME via
# /etc/environment (openCxellSsh writes it; PAM loads it into every SSH login). Per runtime:
#
# claude-code-cxell (default):
#   1. If the headless zee (`claude -p`, the run the queenzee drives for the SSE feed) is still
#      WORKING, stream its activity live — a `tail -f` of the session transcript on disk, rendered
#      by zee-live.mjs — so the attending human sees prior turns + tool calls + results AND new
#      activity as it happens. This is READ-ONLY and starts no second `claude`, so it never forks
#      the running session nor disturbs the -p stdout the SSE feed captures. Ctrl-C skips ahead.
#      That feed is FILTERABLE from the dashboard: the terminal header's ✱ thinking / ⚒ moves chips
#      write /tmp/zee-live-view.json (terminal-bridge.js, over a SECOND ssh channel — never
#      keystrokes, because step 2 hands this pane to claude), and zee-live.mjs watches it, repaints
#      and shows/hides that half of the feed.
#   2. When the turn ends (or if it had already finished), `claude --resume <sid>` loads the FULL
#      transcript interactively, scrolled to the latest turn. The cxell IS the permission system,
#      so we drive with --dangerously-skip-permissions (pre-acknowledged in ~/.claude.json) — no
#      per-tool prompts. Falls back to a fresh session, then a login shell, so the pane (and the
#      zee's box) stays reachable if claude exits.
#
# codex-cxell / kimi-code-cxell:
#   No transcript-follow (that renderer is claude-JSONL-specific) — wait for the headless run to
#   end, then resume the session with the vendor's own resume verb (`codex resume <sid>`,
#   `kimi --continue`) in its skip-approvals mode; same fresh-session → login-shell fallbacks.
#
# All claude first-run prompts (onboarding/theme/trust/bypass) are pre-answered by
# cxell-claude-seed.mjs, so the claude path drops straight in on first open and every open.
#
# ── THE TALK QUEUE (a message sent while the zee was mid-turn) ────────────────────────────────────
# Step 1's feed is read-only in BOTH directions: it renders the transcript and reads nothing from
# the terminal, so anything typed at it — by a human in the browser, or send-keys'd by the queenzee
# for a 📨 message / a manager's `zee say` — was swallowed. The queenzee therefore QUEUES a message
# for a mid-turn zee as a file in $TALK_DIR (server/src/lib/cxell.js, cxellTalkCommand) instead of
# typing it into a void, and this script types it into the interactive session the moment step 2
# takes the pane. "You cannot talk to a working zee" becomes "it arrives when its turn ends".
set -uo pipefail
SID="${1:-}"
RUNTIME="${ZEE_RUNTIME:-claude-code-cxell}"
PROJ_DIR="$HOME/.claude/projects/-work-repo"
JSONL="$PROJ_DIR/${SID}.jsonl"
TALK_DIR="${ZEE_TALK_DIR:-/tmp/zee-talk}"
# Where the drainer types. TMUX_PANE is this exact pane (set by tmux for the pane's command), which
# is more precise than a session name if a second window is ever opened; the session is the fallback
# for a pane started outside tmux.
TALK_TARGET="${TMUX_PANE:-zee}"

# Is the queenzee's headless run for this cxell still in flight? (one zee per cxell)
# ⚠ This pattern is HEADLESS_PROC_PATTERN in server/src/lib/cxell-runtimes.js — the queenzee decides
# "type or queue" with the same test, and the two disagreeing loses messages.
live_run() { pgrep -f 'claude --bare -p|codex exec|kimi -p' >/dev/null 2>&1; }

# Deliver queued operator messages into whatever holds the pane now, oldest first, one Enter each.
# Runs in the BACKGROUND for as long as the interactive session owns this pane, so a message that
# arrives while the human is reading also lands without them doing anything.
#
# Deliberate choices, each one a way this could go wrong:
#   • started only AFTER the live feed is done — typing into the feed is the bug being fixed;
#   • an opening sleep, because `claude --resume` needs a beat before its prompt box accepts input
#     (the same reason the queenzee sleeps 6 when IT starts the session);
#   • the file is removed BEFORE it is typed, so a crash mid-delivery loses a message rather than
#     repeating it — a duplicated instruction to an agent is worse than a lost one;
#   • newlines are collapsed to spaces: Enter SUBMITS in the TUI, so a multi-line paste would fire
#     off half-messages. Long/rich text never comes through here anyway (the queenzee hands that
#     over as files in .zee-inbox and queues a one-line pointer to them).
drain_talk() {
  mkdir -p "$TALK_DIR" 2>/dev/null
  sleep "${1:-8}"
  local f msg
  while :; do
    for f in "$TALK_DIR"/*.msg; do
      [[ -e "$f" ]] || continue
      msg="$(tr '\r\n' '  ' < "$f")"
      rm -f "$f"
      [[ -n "${msg// /}" ]] || continue
      tmux send-keys -t "$TALK_TARGET" -l "$msg" 2>/dev/null || true
      sleep 0.3
      tmux send-keys -t "$TALK_TARGET" Enter 2>/dev/null || true
      sleep 1
    done
    sleep 2
  done
}

start_talk_drain() {
  drain_talk "${1:-8}" &
  TALK_PID=$!
  trap 'kill "$TALK_PID" 2>/dev/null' EXIT
}

follow_live() {
  [[ -n "$SID" && -f "$JSONL" ]] || return 0
  live_run || return 0
  # SAY that this pane cannot hear you, and where the door is. A human who types here while the
  # feed is up gets no echo and no answer, and the honest reading of that is "the terminal is
  # read-only" — which is exactly how it was reported.
  printf '\033[2m── attaching live — the zee is working; streaming its activity (Ctrl-C to jump to the session) ──\033[0m\r\n'
  printf '\033[2m   this pane is a READ-ONLY feed until the turn ends. To talk to it now, use 💬 talk in the\r\n'
  printf '   terminal header (or the 📨 button on its hexagon): your message is typed into its session\r\n'
  printf '   the moment this turn finishes.\033[0m\r\n'
  local fifo tpid npid stop=0
  fifo="$(mktemp -u)"; mkfifo "$fifo"
  tail -n +1 -f "$JSONL" > "$fifo" 2>/dev/null & tpid=$!
  node /usr/local/bin/zee-live.mjs < "$fifo" & npid=$!
  trap 'stop=1' INT
  while [[ $stop -eq 0 ]] && live_run; do sleep 2; done
  trap - INT
  sleep 1                      # let the last transcript lines drain through the fifo
  kill "$tpid" "$npid" 2>/dev/null
  wait "$tpid" "$npid" 2>/dev/null
  rm -f "$fifo"
  printf '\033[1;32m── turn complete — loading the full session ──\033[0m\r\n'
}

# Vendors without a live transcript renderer: just say the zee is working and wait for the
# headless turn to end before resuming, so we never fork a second agent under a running one.
wait_live() {
  live_run || return 0
  printf '\033[2m── the zee is working (headless) — waiting for its turn to end before attaching (Ctrl-C to attach now) ──\033[0m\r\n'
  local stop=0
  trap 'stop=1' INT
  while [[ $stop -eq 0 ]] && live_run; do sleep 2; done
  trap - INT
}

# Each branch: wait out the headless turn (feed or plain wait), THEN start the queue drainer, THEN
# hand the pane to the interactive session. The order is the whole contract — a drainer started any
# earlier would type into the read-only feed, which is the failure it exists to end.
case "$RUNTIME" in
  codex-cxell)
    wait_live
    start_talk_drain
    if [[ -n "$SID" ]]; then
      codex resume "$SID" --dangerously-bypass-approvals-and-sandbox \
        || codex --dangerously-bypass-approvals-and-sandbox
    else
      codex resume --last --dangerously-bypass-approvals-and-sandbox \
        || codex --dangerously-bypass-approvals-and-sandbox
    fi
    ;;
  kimi-code-cxell)
    wait_live
    start_talk_drain
    # kimi resumes by workdir, not id (headless print mode never surfaces one); --yolo because
    # the cxell is the permission system, same stance as the other runtimes
    kimi --continue --yolo || kimi --yolo
    ;;
  *)
    if [[ -n "$SID" ]]; then
      follow_live
      start_talk_drain
      claude --resume "$SID" --dangerously-skip-permissions 2>/dev/null || claude --dangerously-skip-permissions
    else
      start_talk_drain
      claude --dangerously-skip-permissions
    fi
    ;;
esac
exec bash -l
