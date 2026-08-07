# Decision Record: Dashboard live stream over a WebSocket

**Date:** 2026-08-06
**Author:** Architect (instead-of-spamming-timeline-diffs-and-fleet-30ad3d)
**Status:** Implemented

## Decision

The console's live stream is WebSocket-first. `subscribe()` in `web/src/api.js`
connects to `/api/stream/ws` (a `ws` upgrade on the same HTTP server the API binds),
falls back to the existing SSE route `/api/stream` when the websocket cannot open,
and hands every event's **type** to the caller. The App shell's live-update path
(`streamChange`) re-reads **only the read model an event type can have moved** —
the fleet snapshot for most events, the git graph + diffs too for `land`/`ship`/
`project` — instead of re-fetching fleet + timeline + diffs on every event.

The two live channels carry the same wire contract, so a consumer cannot tell which
one it is on: a leading `snapshot` frame (the whole fleet read model, project-scoped),
then one typed frame `{ type, payload }` per event, with a `ping` keep-alive.

## Context

The dashboard subscribed to `/api/stream` (SSE) and, on **every** event, re-ran the
fleet + timeline + diffs read models over plain HTTP. A busy hive emits a `zee` or
`xell` broadcast every few seconds (a zee's hook fires on every tool use; the poller
touches zees on its own tick; the container monitor broadcasts each health change),
so each open tab continuously re-fetched three heavy read models it had just fetched
a moment before. The cost compounds across open tabs — the "spamming timeline, diffs
and fleet API requests" this record exists to stop.

Three distinct costs were being paid:

1. **Bandwidth and queenzee load.** `getFleet` runs ~25 queries and several shell
   outs; `getTimeline` shells out to `git log`; `getDiffs` runs a git diff per xell
   and, for a live cxell zee, a `docker exec` per xell per call (cached 12 s, but
   still). A hive with 20 hexagons on 4 tabs re-fetched all of that every few
   seconds, per tab.
2. **Latency on the one thing that is time-critical.** A human watching a held
   landing or a paused fleet sees it move only after a full 3-way re-fetch resolves.
3. **The git graph churned.** Timeline re-fetching re-rendered the graph for events
   (a container health flap, a zee status) that cannot have moved any commit, so the
   canvas redrew and connector wires re-routed for no reason.

## Options considered

### Option A: WebSocket channel, SSE fallback, type-aware re-reads (chosen)
- **For:** One multiplexed connection per tab; the server pushes the snapshot on
  connect (no client poll); the caller gets the event type so it can re-read only
  what moved; the SSE route stays as a native-reconnecting fallback so a proxy that
  drops the upgrade degrades gracefully. `ws` is already a dependency (the cxell
  terminal bridge), and both the vite dev proxy and the prod nginx already proxy
  websockets under `/api` — no new port, no new proxy config.
- **Cost:** A second transport to keep in contract with the first. Mitigated by a
  single `STREAM_TYPES` authority in `api.js` and an integration test
  (`test/live-stream-ws.test.mjs`) that pins the wire contract.

### Option B: Keep SSE, add server-side event coalescing/debounce
- **For:** No new transport; the client code stays as-is.
- **Rejected because:** SSE with one EventSource per consumer already multiplies
  connections per tab, and coalescing on the server does not tell the client *which*
  read model to re-read — the graph would still re-render on every event. The core
  waste (re-fetching the whole world on every event) survives; only the rate shrinks.

### Option C: SSE + client-side debounce, keep the whole-world re-fetch
- **For:** The smallest possible change.
- **Rejected because:** It cuts the *rate* of spam but not the *size* — every
  event still re-reads timeline + diffs it cannot have changed. The git graph keeps
  churning. This is Option B without the server-side benefit.

### Option D: WebSocket that replaces SSE entirely (no fallback)
- **For:** One transport, nothing to keep in step.
- **Rejected because:** The SSE route predates this change and other consumers rely
  on its native reconnect. A websocket that cannot open (an old proxy, a
  connection that drops the upgrade) would leave the dashboard silent forever
  without retry logic we would have to write by hand. The fallback costs ~15 lines
  and buys EventSource's battle-tested reconnect.

### Option E: Per-channel WebSockets (a socket per event type)
- **For:** A consumer opens only the channels it wants.
- **Rejected because:** It re-introduces the per-consumer connection fan-out that
  SSE had, and the work tracker (the one consumer that wants a single channel today)
  would pay one socket per tab for no benefit. A future consumer can filter on the
  client side; the seam is left there.

## Why the rejected ones were rejected

- **B / C (rate-only fixes):** They reduce how often, not how much. The git graph
  still re-renders on events that cannot move a commit, and the fleet read model is
  still re-fetched wholesale. They cost the least but fix the least — the measured
  symptom (fleet + timeline + diffs spamming) survives at a slower cadence.
- **D (no fallback):** Loses the resilience the SSE route already provides, for no
  consumer-facing gain. A reconnection loop is exactly the kind of client logic the
  platform already gives us for free via EventSource.
- **E (per-channel sockets):** Adds connection fan-out, the thing the change is
  trying to remove, and no current consumer needs a single channel alone.

## Consequences

- **Easy now:** the honeycomb, the graph and the panels all update from the same
  socket; `onChange(type)` lets any future surface re-read only what it cares about;
  the WS channel rides the existing ws-aware proxies (vite `ws: true`, nginx `map
  $http_upgrade`), so there is no new infrastructure.
- **Harder:** there are now two transports that must stay in contract. The shared
  `STREAM_TYPES` list and the integration test are the guard; the SSE route is
  deliberately unchanged in behavior so a regression shows up as a contract test
  failing, not a silent divergence.
- **A subtlety to keep:** the WS channel connects with `?project=` and the SSE
  route does too — a project switch re-connects the socket. The App shell re-creates
  the subscription on `projectId` change, so the two stay in step. The `streamChange`
  debounce holds the *last* re-read, keyed by the project at schedule time, and drops
  it if the project moved while it waited.

## Reversibility

The SSE route is untouched and still serves every consumer that used it — removing
the WS channel (or reverting `subscribe()` to SSE-only) is a ~40-line revert with no
data migration. The App shell's `loadAll`/`refresh`/`streamChange` split keeps the
old `refresh()` as a thin wrapper, so the previous behavior is one rename away. The
whole change is a two-way door; nothing here is irreversible.

## What would change our mind

- If the `ws` upgrade path proves fragile in an environment the SSE route handled
  (a proxy that half-drops upgrades, a firewall that eats keep-alives), the fallback
  is already there — but if it triggers routinely in production, that is evidence the
  WS-first ordering is wrong and should flip to SSE-first with a WS upgrade path.
- If a consumer needs fine-grained filtering (only ships, only work), that is the
  per-channel option (E) re-opened with a real user.
