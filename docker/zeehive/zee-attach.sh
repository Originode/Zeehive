#!/bin/bash
# Land a human ATTENDING a caged zee straight in the zee's WORKFLOW. Invoked as the tmux pane
# command by the dashboard terminal bridge: `tmux new -A -s zee -c /work/repo 'zee-attach.sh <sid>'`.
#
#   1. If the headless zee (`claude -p`, the run the queenzee drives for the SSE feed) is still
#      WORKING, stream its activity live — a `tail -f` of the session transcript on disk, rendered
#      by zee-live.mjs — so the attending human sees prior turns + tool calls + results AND new
#      activity as it happens. This is READ-ONLY and starts no second `claude`, so it never forks
#      the running session nor disturbs the -p stdout the SSE feed captures. Ctrl-C skips ahead.
#   2. When the turn ends (or if it had already finished), `claude --resume <sid>` loads the FULL
#      transcript interactively, scrolled to the latest turn. The cage IS the permission system,
#      so we drive with --dangerously-skip-permissions (pre-acknowledged in ~/.claude.json) — no
#      per-tool prompts. Falls back to a fresh session, then a login shell, so the pane (and the
#      zee's box) stays reachable if claude exits.
#
# All first-run prompts (onboarding/theme/trust/bypass) are pre-answered by cage-claude-seed.mjs,
# so this drops straight in on first open and every open.
set -uo pipefail
SID="${1:-}"
PROJ_DIR="$HOME/.claude/projects/-work-repo"
JSONL="$PROJ_DIR/${SID}.jsonl"

# Is the queenzee's headless run for this cage still in flight? (one zee per cage)
live_run() { pgrep -f 'claude --bare -p' >/dev/null 2>&1; }

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

if [[ -n "$SID" ]]; then
  follow_live
  claude --resume "$SID" --dangerously-skip-permissions 2>/dev/null || claude --dangerously-skip-permissions
else
  claude --dangerously-skip-permissions
fi
exec bash -l
