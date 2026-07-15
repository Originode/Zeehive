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
- **VERIFY IN THIS XELL — you already have everything you need.** Those containers are *yours*:
  your own server, webapp and database, isolated from prod and from every other zee. This is the
  whole point of a xell. So: don't ask for a xell (you are in one), don't ask to use dev or prod,
  and never stop at *"I can't verify this here"* — build into your own containers and exercise the
  real thing before calling the work done.
- **Checkpoint-commit freely.** `git commit` on your branch as you go, whenever a step works. A
  commit only moves *your* branch ref — it lands nothing and touches nobody else. Nothing is
  integrated until you push, and that push needs a human, so there is no reason to hoard
  uncommitted work: commit early and often. It is the only thing protecting what you've done.
- **Waiting for a build: append `--wait`** to the build command. NEVER hand-roll a wait — don't
  curl your own webapp in a poll loop or `sleep` and re-check; those loops guess a condition and
  hang for 45 minutes on a build that finished long ago. `--wait` blocks until the build settles
  and tells you whether the container is serving your current HEAD. Run it in the BACKGROUND and
  its exit is your nudge.
- **Land locally:** commit on your branch, then `git push . HEAD:main`. `origin` is
  off-limits (stale by design) — never fetch/pull/push origin, ignore any "Create PR" chip.
- **Landing is HELD for a human.** That push is a *request*: the xource's git hook declines it
  and raises it in the ZEEHIVE console for verification. This is expected — your work is safe on
  your branch, nothing was lost. Tell your human it is waiting, and re-run the **same** push once
  they approve. Do not amend/rebase to a new sha (approval is bound to the exact commit they
  read), and never try to route around the hook.
- **Shipping to PRODUCTION: you may only ASK.** Run the binding's ship command
  (`xell-ship.mjs <xell_id> --reason "..." --wait`, in the BACKGROUND — its exit is your nudge).
  A human approves it, then the **queenzee** takes the prod lock and runs the deploy itself, from
  the xource at **main**. You never hold the lock, never run a prod build, and never release
  anything. This is deliberate: a zee deploying by hand ships a *band-aid* — live in prod, absent
  from main, silently reverted by the next rebuild. A ship is **refused unless your work is
  already landed**. Never run docker/compose against prod yourself, and don't use the old
  deploy-guard acquire path.
- When the work is done, the **human** marks the task done in the ZEEHIVE web app; that is
  what tells the queenzee to tear this xell down. You do not despawn yourself.

Now do the task described in `task` (and `$ARGUMENTS`).
