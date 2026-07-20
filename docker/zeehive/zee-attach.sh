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
set -uo pipefail
SID="${1:-}"
RUNTIME="${ZEE_RUNTIME:-claude-code-cxell}"
PROJ_DIR="$HOME/.claude/projects/-work-repo"
JSONL="$PROJ_DIR/${SID}.jsonl"

# Is the queenzee's headless run for this cxell still in flight? (one zee per cxell)
live_run() { pgrep -f 'claude --bare -p|codex exec|kimi -p' >/dev/null 2>&1; }

follow_live() {
  [[ -n "$SID" && -f "$JSONL" ]] || return 0
  live_run || return 0
  printf '\033[2m── attaching live — the zee is working; streaming its activity (Ctrl-C to jump to the session) ──\033[0m\r\n'
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

case "$RUNTIME" in
  codex-cxell)
    wait_live
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
    # kimi resumes by workdir, not id (headless print mode never surfaces one); --yolo because
    # the cxell is the permission system, same stance as the other runtimes
    kimi --continue --yolo || kimi --yolo
    ;;
  *)
    if [[ -n "$SID" ]]; then
      follow_live
      claude --resume "$SID" --dangerously-skip-permissions 2>/dev/null || claude --dangerously-skip-permissions
    else
      claude --dangerously-skip-permissions
    fi
    ;;
esac
exec bash -l
