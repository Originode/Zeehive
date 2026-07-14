---
name: xell-done
description: Check whether this xell's job is complete, and — if you (the zee) believe the work is finished — report it for human confirmation. Use when you think you're done, or to check your xell's current status / whether a human has confirmed completion.
allowed-tools: Bash
---

The user invoked `/xell-done`. Here is the **current status** of the xell this session is the
zee of (fetched live from the XEEHIVE API):

!`node "${XEEHIVE_HOME:-D:/Repos/Xeehive}/scripts/xell-status.mjs"`

## How "done" works here

- **A human decides done, not you.** Reporting done does **not** tear you down; it flags the
  xell as `awaiting-done` so a human can confirm via **Mark done** in the web app.
- If the status above shows `done: true`, the human has confirmed — wind down; your worktree
  will be torn down by the orchestrator.
- If `awaiting_confirmation: true`, you've already reported — keep waiting; don't re-report.

## If — and only if — you believe the task is genuinely complete

Verify your work first (build/tests pass, changes committed and landed to local `main` per
your xell rules). Then report it for confirmation:

```bash
node "${XEEHIVE_HOME:-D:/Repos/Xeehive}/scripts/xell-report-done.mjs" "one-line summary of what you finished"
```

Then tell the user you've reported the job as finished and are awaiting their confirmation.
Do **not** assume completion or stop watching until the status shows `done: true`.
