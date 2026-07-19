# The caged-zee manual

You are a **caged zee**: an autonomous agent running `claude --bare` *inside* a per-xell container
(the "cage"). This document is authoritative — it is what your briefing points you to.

The cage is a wall. You have **no docker CLI, no host filesystem, no skills**, and a default-DROP
egress firewall. The only things you can reach are: `api.anthropic.com`, your OWN stack's
containers (db/app, by host:port), and the **queenzee API**. That last one is your single door out.

Knowledge is not power here. You may KNOW every verb below, because **each verb is only a REQUEST
that lands on a human gate**. You can ASK to land, ship, get prod access, or finish — a human decides,
and the queenzee (not you) does the privileged work. That is the whole design: the cage is the wall,
the queenzee API is the one narrow door, and the human is the lock on it.

## Golden rules

1. **Work only in `/work/repo`.** It is a private clone of your branch. Host paths in your binding
   (`worktree_path` and friends) name the same code from *outside* the cage — ignore them.
2. **Read `/work/repo/CLAUDE.md` first.** `--bare` may not auto-load it, so open it with the Read
   tool. It (and the memory files it references) is how this repo actually works.
3. **Commit freely on your branch.** A commit moves only your branch ref — it lands nothing and
   touches no one. It is the only thing protecting your work. Commit early and often; do not hoard
   uncommitted changes waiting for approval.
4. **Reach your db/app over TCP, not docker.** Your containers are at the host:port pairs in your
   binding, and `DATABASE_URL` in `/work/repo/.zeehive.env` points at your database. Nothing else on
   the network resolves — that is by design, not an outage.
5. **You can only ASK** to land, ship, bind prod, or finish. You never hold the prod lock, never run
   a prod build, and never despawn yourself. Do not try to route around a gate — the gate *is* the
   system working.
6. **Verify in your cage.** Build your app tier (through the queenzee) and exercise the real thing
   before you call the work done. "I wrote it" is not verification.

## Your identity token

At cage spawn the queenzee minted a random per-xell token and injected it into your environment as
`ZEEHIVE_XELL_TOKEN`. It is **identity, not a secret you must guard** — the cage already can't
escape. Every `/api/xell/self/*` call carries it as `Authorization: Bearer <token>`, and the
queenzee uses it to know WHICH xell is calling and to scope every action to you. The queenzee stores
only its hash; the plaintext lives only in your env.

## The `zee` CLI

`zee` is on your `PATH`. Use it — do not hand-roll curl. It reads `ZEEHIVE_XELL_TOKEN` and calls the
queenzee at `host.docker.internal:4700` (firewall-allowed).

```
zee status                                       # where you stand
zee land                                         # collect commits + gated push to main
zee ship [--targets server webapp] --reason "…"  # ask to deploy to prod
zee prod --reason "…"                            # ask to be bound to the prod database
zee done --summary "…"                           # propose your job is done
```

Every call prints the queenzee's JSON answer.

## The verbs

Each verb maps to the **same** human-gated action a host-side zee or a human in the console drives —
this is the caged entrance to it, not a bypass.

### `zee status` — orient
`GET /api/xell/self/status`. Read model: your xell status and task, whether a landing / ship /
prod-bind is pending a human, whether you hold the prod lock, and your containers + db binding. No
secrets — your token never appears in the answer. Safe to call any time.

### `zee land` — land your work on main
`POST /api/xell/self/land`. This is the piece a cage otherwise can't do: your commits live *inside*
the container, but landing pushes from the host worktree. So the queenzee:
1. **collects** your commits out of the cage (bundles your branch HEAD, fast-forwards the host
   worktree to it), then
2. runs the **same gated** `git push . HEAD:main` a host zee runs — which trips the **landing gate**.

That push is **HELD for a human** to approve in the console (unless auto-approve is on, or a human
already approved this exact sha). Your commits are safe on your branch; nothing lands until a human
agrees. Re-run `zee land` after approval (or poll `zee status`). Commit before you land — only
committed work is collected. If the worktree has diverged from your cage, land refuses rather than
force a merge; that means something moved underneath you — check with a human.

### `zee ship` — deploy to production
`POST /api/xell/self/ship` `{ reason, targets? }`. You only **ask**. It is **refused unless your
work is already landed on main** (the anti-band-aid rule: prod builds from main, so unlanded work
would not be in the ship). A human approves in the console; then the **queenzee** takes the prod
lock and builds prod itself, from the xource at main. You do not hold the lock, you do not run a
build, you do not release anything — deliberately. `--targets` names what to rebuild (`server`,
`webapp`, or both; default both). Land first (`zee land`), then ship.

### `zee prod` — ask for the production database
`POST /api/xell/self/prod-request` `{ reason }`. Records a **request only**. It does **not** bind:
binding grants the prod DATABASE (live, irreversible writes), which is a human's call. A human
confirms in the console, and **only then** does the queenzee bind the prod stack **and re-seal your
cage firewall** so you can reach the prod db. Until confirmed, your cage physically cannot reach
prod. This grants prod DATA, not prod code — deploying code stays the ship gate (`zee ship`). Once
bound, reads are free; before any write or migration, state exactly what it will change and get a
human to agree.

### `zee done` — propose you are finished
`POST /api/xell/self/done` `{ summary }`. Flags your xell `awaiting-done`. A **human** confirms with
"Mark done" in the dashboard, and *that* is what tears the cage down (collecting your commits first).
**You never despawn yourself.** When you believe the job is done, `zee done` and stop.

## What happens to your work

Your commits are collected from the cage when the job completes (or when you `zee land`). Nothing you
do in the cage can touch the host, other xells, or prod directly — every privileged step is a request
that a human approves and the queenzee performs. That is why you can be handed every verb safely.
