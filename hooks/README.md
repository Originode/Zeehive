# Status hooks — the deterministic, agent-independent observability channel

The queenzee learns a zee's state from **harness-fired hooks**, not from the model
self-reporting. The harness runs these itself on every session, so an unreliable agent
can't skip them.

## Install (http hooks — preferred)

Merge the `hooks` block from [`settings.hooks.json`](./settings.hooks.json) into
`~/.claude/settings.json`. Each event POSTs to `http://localhost:4700/api/hooks`.

Event → meaning the queenzee records:

| Hook | Zee state |
|------|-----------|
| `SessionStart` | online / attached |
| `UserPromptSubmit` | **working** (prompt injected) — zee gets a codename |
| `PreToolUse` / `PostToolUse` | working (heartbeat) |
| `Stop` | **idle** (turn finished, waiting on user) — name cleared |
| `SubagentStop` / `Notification` | liveness touch |
| `SessionEnd` | stopped |

## Install (command fallback)

If your build lacks the `http` hook type, copy [`post-hook.sh`](./post-hook.sh) to
`~/.claude/hooks/xeehive-post-hook.sh` and use `type: "command"` entries that run it.

## Not required for correctness

Even with **no hooks installed**, the passive poller (`~/.claude/sessions/*.json` +
transcript mtime/`stop_reason` + PID liveness) reconstructs the same state as a fallback.
Hooks just make transitions instant instead of poll-latency.
