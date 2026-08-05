# The Queenzee Minister — the fleet's standing critic of its own orchestrator

> Added 2026-08-03 (migrations 119/120). A manager-type harness, two manager verbs, zero new powers.

The fleet produces evidence about the QUEENZEE all day — landings that sat hours on a gate, ships
that failed and were never retried, loops logging the same error every minute, zees burning tokens
without landing anything, backups failing quietly — and nothing reviewed it. Worker reflections
reach a crew lead about the CREW's work; the queenzee's own conduct was whatever a human happened
to catch in the terminal modal. The **minister** is that review given a persona: a zee whose whole
job is to read the operational record, criticise it, and file each criticism as a **ticket** that
managers and humans then take up.

## The design in one sentence

**A wall between finding and acting**: the minister's read is a fleet-wide, read-only digest, its
only write is a ticket in its own project, and everything in between — deciding, landing, shipping,
touching the meta-DB — belongs to the same gates and humans as before.

## Why a HARNESS on the manager type, not a new zee_type

The manager TYPE (docs/manager-zees.md) already carries exactly the right trade for a critic, with
every refusal structural rather than prompted:

| the critic needs | the manager type already provides |
|---|---|
| fleet-wide visibility | the manager trade's whole point |
| to read production | the SELECT-only postgres role (`lib/prod-readonly.js`) |
| to be unable to act on its own advice | zero push access (landgate/xellgit refuse a manager sha) |
| to post work, not do it | the work tracker, where a ticket is the raw ask |

So `queenzee-minister` (migration 120) is a system-wide **manager-type harness**, parented on
`manager` exactly as `dev-lead` is: the manager manual arrives by inheritance, and the row adds only
the persona, the priorities and the review loop. A new zee_type would re-derive all of the above for
no new refusal. A human seats one from the console like any manager (the harness appears in the
manager pickers via `GET /api/harnesses?zee_type=manager`).

## The two verbs (both plain MANAGER verbs — migration 119 briefs every manager on them)

- **`zee ops [--hours N] [--logs N] [--alerts]`** → `GET /api/xell/self/ops` → `lib/ops-review.js`.
  ONE read-only digest: the queenzee's log ring with the warning/error lines pre-filtered, every
  landing/ship/seed/prod-bind with how long it waited on a human, open tends, the fleet's token
  burn (window totals + top spenders, migration 030's counters) and the backup ledger with its
  failures. Fleet-wide on purpose — the queenzee is one orchestrator, and the cross-project queues
  (one runway per ref, one prod lock, one pool) are precisely what a per-project view would miss.
  `opsDigest()` contains not one writing SQL verb, and `test/queenzee-minister.test.mjs` fails the
  build if one appears: criticism that could ACT would be a second queenzee.
- **`zee ticket --title "…" [--body …] [--kind …] [--priority 1..5] [--notify]`** →
  `POST /api/xell/self/ticket`. Files a ticket in the caller's OWN project (project from the token,
  reporter = the xell slug) — the same raw ask a human types into the tickets window, and the same
  hinge from there: a manager or a human breaks it down into work items (`docs/work-tracker.md`).
  `--notify` drops it into every other live manager's inbox (`notifyManagerOfTicket`, best-effort).
  `zee ticket --list [--q …]` reads what is already filed, so the same criticism is never filed
  twice. `GET /api/xell/self/tickets` is the route under it.

Both are refused for a worker with the explanation (`requireManager`), and both sit in the CLI's
MANAGER-only usage section — which is what `test/cxell-cli-drift.test.mjs` §(e) keys on to demand
they appear in every system-wide manager harness's effective briefing (119 puts them in the shared
manager manual; `manager`, `dev-lead` and `queenzee-minister` all inherit or carry it).

## What the minister optimises for (its manual, migration 120)

1. **Queenzee efficiency** — gate waits, stale landings, unretried failed ships, noisy loops,
   silent backup failures, pool waste.
2. **Zee token consumption** — the burn table's top spenders, xells that burned large and landed
   nothing, re-briefing where a swap or a sync existed.
3. **Safety of its own suggestions** — a proposal must never break the running system, the ZEEHIVE
   source or the meta-DB: additive, gated, reversible changes preferred; anything touching a gate,
   guard, hook, firewall or the prod database is flagged for humans with a "what could this break"
   note; a criticism that needs a bypass is wrong by construction.

## What it deliberately cannot do

Land (structural), write production (SELECT-only role), open or approve any gate, mark anything
done, or change the queenzee's config from its digest. Its tickets change nothing until someone
takes them up — that is not a limitation of the first version, it is the product working.
