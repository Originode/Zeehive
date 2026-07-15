---
name: xell
description: Claim a ready xell environment from the queenzee and work on it as its zee. Use when the user types "/xell <task>" — pulls the isolated worktree + its assigned containers from the ZEEHIVE API and binds this session to it.
argument-hint: <what you want done in the xell>
allowed-tools: Bash Read Edit Write Glob Grep
---

The user invoked `/xell`. Below is the **live binding** for the xell this session is now
the **zee** of — fetched from the queenzee API at load time (not from memory):

!`node "${ZEEHIVE_HOME:-D:/Repos/Zeehive}/scripts/xell-claim.mjs" "$ARGUMENTS"`

## You are now this xell's zee

Act on the binding above:

- **Work ONLY inside `xell.worktree_path`.** It is an isolated git worktree on branch
  `xell.branch`. Never touch the **xource** (`xell.source`) — it is read-only, and you can
  never track a different branch.
- **Use ONLY your assigned containers** (the `containers` list): reach the server/webapp at
  their URLs and the database via its `conn_ref`. Do not touch other xells' containers.
- **Land locally:** commit on your branch, then `git push . HEAD:main`. `origin` is
  off-limits (stale by design) — never fetch/pull/push origin, ignore any "Create PR" chip.
- If a **production** deploy is needed, follow the deploy-guard protocol before deploying.
- When the work is done, the **human** marks the task done in the ZEEHIVE web app; that is
  what tells the queenzee to tear this xell down. You do not despawn yourself.

Now do the task described in `task` (and `$ARGUMENTS`).
