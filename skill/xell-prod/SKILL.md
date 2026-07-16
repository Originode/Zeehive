---
name: xell-prod
description: Bind THIS xell to the PRODUCTION stack — the live prod database becomes its assigned container, so prod DATA work is allowed instead of denied. A human typing this IS the confirmation. Use when the user types "/xell-prod", to check what a xell is bound to, or to release it back to dev.
allowed-tools: Bash
---

The user invoked `/xell-prod`. Here is what this session's xell is bound to **right now**:

!`node "${ZEEHIVE_HOME:-D:/Repos/Zeehive}/scripts/xell-prod.mjs" --status`

## What this is for

A data xell — a CSV import, a backfill, a hotfix against real rows — needs the **production
database**. Dispatched normally it gets `db-shared-dev`, and the prod guard denies it. That is the
guard working, not a bug: the fix is for a human to say "yes, this one, on purpose".

`/xell-prod` is a human saying it. Like `/xell-done`, **a human typing the command IS the
confirmation** — do not then ask them to confirm their own confirmation.

## What it grants, and what it does not

**PROD DATA IS NOT PROD CODE.** This is the line the whole system is built around; do not read
this skill as erasing it.

| | |
|---|---|
| ✅ **The prod DATABASE becomes this xell's** | `exec`/`cp` against it stop being denied. Reading it is now your job, not a violation. |
| ✅ **The app tier points at prod** | prod's server + webapp become this xell's, so you stop running a dev pair nobody looks at. |
| ❌ **Exec into prod's server or webapp** | Still denied. You can SEE prod's app; you cannot reach inside it. |
| ❌ **Prod code deploys** | Still denied. `compose build`/`up`/prodsrc is the ship gate's job → `scripts/xell-ship.mjs`. |
| ❌ **Restart anything** | Still denied, including your own db. That is ops, not data work. |

## WRITES ARE PROMPT-GATED ONLY

There is no gate here. Unlike landing and shipping, **nothing will stop a bad `UPDATE`** — the
guard's answer is yes-or-no for the whole database, not per statement. The prod DB has no backup
mid-flight and the queenzee cannot undo you.

So, before any `INSERT` / `UPDATE` / `DELETE` / migration:

1. **Say exactly what it changes** — which tables, how many rows, and the actual statement.
2. **Say how to undo it.** If you cannot, say that instead — it is the most important sentence.
3. **Get a human to agree.** Then run it.

Reading is free. Read as much as you like, and prefer proving a claim with a `SELECT` over
asserting it.

## Doing the work

Run SQL via the `psql` command printed above. Prod postgres is not exposed and has no `conn_ref` —
`docker --context mardale-prod exec -i <db> psql …` is the sanctioned path, and the binding hands
you the exact command so you never have to guess a container name.

## When you are done

```
node "${ZEEHIVE_HOME:-D:/Repos/Zeehive}/scripts/xell-prod.mjs" --release
```

**Release it.** A xell left bound to prod looks like every other card in the pool, and the next zee
to claim it inherits live prod write access it never asked for and does not know it has.

## Running it

- Plain `/xell-prod` → bind this xell to prod:
  `node "${ZEEHIVE_HOME:-D:/Repos/Zeehive}/scripts/xell-prod.mjs"`
- `/xell-prod status` → the status above is already the answer; do not re-run it.
- `/xell-prod release` → `… xell-prod.mjs --release`
- Testing/experimenting? Target a **dummy** by id: `… xell-prod.mjs --xell <id>`. House rule:
  never test against a live xell.

If the status above already says `⚠ ON PRODUCTION`, it is already bound — say so and get on with
the work rather than re-binding.
