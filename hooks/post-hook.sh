#!/usr/bin/env bash
# Fallback for Claude Code builds without the http hook type: a `command` hook that
# forwards the hook JSON (received on stdin) to the queenzee. Wire it in settings.json as:
#   { "type": "command", "command": "bash ~/.claude/hooks/zeehive-post-hook.sh" }
# The harness runs this deterministically; it needs no model cooperation.
API="${ZEEHIVE_API:-http://localhost:4700}"
payload="$(cat)"
curl -s -m 3 -X POST "$API/api/hooks" -H 'content-type: application/json' --data "$payload" >/dev/null 2>&1 || true
exit 0
