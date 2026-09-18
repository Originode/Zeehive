# The /api/fleet bottleneck fix — what was measured, what changed

**Date: 2026-09-15.** Production's meta-DB sat at ~700% CPU running 6-7 concurrent copies of ONE
statement: `fetchXellRows()` in `server/src/lib/fleet.js` (the read model behind `GET /api/fleet`
and `streamXells`), each taking 28-33 s. Requests arrived every ~5 s (the console re-fetches per
stream event; the queenzee loops broadcast every 4-30 s) — ~108 `/api/fleet` per 10 min, 19
browser-aborted — so the queue never drained and every other meta-DB query waited behind it.

## The four production numbers (live meta-DB, EXPLAIN (ANALYZE, BUFFERS), 15 xells)

| reading | value |
|---|---|
| JIT compilation per execution, before | **~15 s** (221 functions inline+optimized; plan cost ~1.3M > stock `jit_above_cost`) |
| total per call, before | **28-33 s** |
| total with `SET jit = off` alone | **~11 s** (the remaining cost: 4 × 15 seq scans of `session_event`, ~135k rows / 144 MB, no `xell_id` index) |
| total with index + jit off | see the xell-clone reproduction below — the seq-scan and JIT costs are both structural, and both are removed |

## Reproduction on a clone db (migrated sandbox, same 15-xell / 135k-row shape)

`EXPLAIN (ANALYZE, BUFFERS)` on the exact `fetchXellRows` statement:

| configuration | planning | execution |
|---|---|---|
| no index | 5-22 ms | **~5,000 ms** |
| index `session_event_xell_kind_ts_idx`, jit forced on | 20 ms | 23.6 ms |
| index + `SET LOCAL jit = off` (the shipped configuration) | 10-34 ms | **4.5-7 ms** |

With the index, every `session_event` node in the plan is an Index Scan or Index Only Scan via
`session_event_xell_kind_ts_idx` — zero seq scans — and planning time stays well under 200 ms.
(The JIT block itself does not reproduce on the embedded sandbox postgres — it never engages LLVM
even when forced — so the 15 s JIT figure above is the production measurement; the code now runs
the statement with `SET LOCAL jit = off` regardless.)

## The five changes (each its own commit)

1. **Migration 260** — `session_event_xell_kind_ts_idx ON session_event (xell_id,
   hook_event_name, ts DESC)` + `ANALYZE`. FULL, not partial on the fleet's 8 event kinds: the
   quarantine, spin-detector, fleet-pause and ops-review readers use the same xell-scoped shape
   with other kinds.
2. **JIT off for this one statement** — `fetchXellRows` runs inside a transaction with
   `SET LOCAL jit = off`, so it cannot leak onto the pooled connection and travels with the code.
3. **Server-side coalescing** — `getFleet(projectId)` shares one in-flight promise per project
   id; the entry clears on settle (failure never cached). `streamXells` is not coalesced — it
   emits through a per-caller callback, so two callers cannot share one run.
4. **Console storm** — `streamChange()` in `web/src/App.jsx` keeps one fleet fetch in flight per
   project; changes arriving mid-flight collapse into ONE follow-up fetch when it settles.
   Debounce timings and the project-switch stale-guard are unchanged.
5. **Retention** — the maintenance tick prunes the four bulky `cxell-feed` mirror kinds
   (`assistant`/`user`/`tool_progress`/`result`) older than
   `SESSION_EVENT_RETENTION_DAYS` (default 30). Gate/state kinds are never swept — the fleet
   snapshot and status derivations replay those latest-event-wins with no time bound. The reader
   audit behind the kind list is in the migration's commit message.

## Known, deliberately out of scope

`docker/zeehive/nginx-web.conf` proxies to a host name nginx resolves IPv6-first, fails with
"101: Network unreachable", marks the upstream disabled and retries IPv4 — on every request. The
one-line fix (`resolver … ipv6=off`, or pinning the IPv4 host) touches the deployment playbook
and belongs in its own change.
