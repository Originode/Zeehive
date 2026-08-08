# Visual Verification — why it "still does not work", and the answer to port-forwarding

**Date:** 2026-08-08
**Author:** Architect (visual-verification-still-does-not-work-why-570361)
**Status:** Diagnosed with live evidence; one surgical fix implemented (offer-time liveness).
**Supersedes nothing** — extends `docs/common-xell-network-plan.md` (the /xell-web design), which
remains correct and is now verified live on the fleet.

---

## 1. What actually works today (verified on the FLEET, not assumed)

Every probe below was run 2026-08-08 from this cxell **against the real console/queenzee**
(`host.docker.internal:5180` / `:4700`), with a known-good control alongside:

| Layer | Probe | Result |
|---|---|---|
| Console nginx `/xell-web/` location | `GET :5180/xell-web/<my-slug>/` | live (proxied through) |
| Queenzee express route | `GET :4700/api/xell-web/<my-slug>/` | live (same answer) |
| Upstream resolution | 502 body names `upstream: http://127.0.0.1:5379` — the exact port my binding assigns | correct |
| HTML through the proxy (after `zee build webapp --wait`) | `GET /xell-web/<slug>/` | **200**, assets base-prefixed `/xell-web/<slug>/…` |
| Assets | `GET /xell-web/<slug>/src/main.jsx` | **200** |
| The reviewed app's OWN `/api` (after `zee build server --wait`) | `GET /xell-web/<slug>/api/fleet` | **200**, and it answers from **my xell's** server (different project id than the outer console) |
| Websocket (Vite HMR) | Upgrade to `/xell-web/<slug>/` | **101 Switching Protocols** |
| The offer verb | `zee verify-webapp` | open offer, `url: /xell-web/<slug>/` (the derived path) |

So the transport — nginx → queenzee proxy → per-xell upstream, tracked in the meta-DB — is
**shipped, live, and works end to end**. The plan in `common-xell-network-plan.md` §8 is no longer
"needs the real queenzee": it has it, and it holds.

## 2. So why does a human still experience "does not work"?

Because the **offer** was decoupled from the **liveness of what it points at**. Concretely, the
failure modes that produce a dead card in front of a human:

1. **The offer never checked anything was listening.** `selfVerifyWebapp` offered on the strength
   of a container ROW existing. A zee that called `zee verify-webapp` before (or instead of)
   `zee build webapp --wait` put a card up whose link is a raw JSON 502 in a new tab. Verified: the
   exact 502 (`ECONNREFUSED 127.0.0.1:5379`) is what this xell's URL returned before the build.
2. **The webapp alone is not the review — the app tier is.** With only the webapp built, the HTML
   and assets load, but the reviewed SPA's every `/api` call 502s (verified: `/xell-web/<slug>/api/…`
   → `ECONNREFUSED 127.0.0.1:4879` until `zee build server --wait`). The human sees a hollow,
   broken page and reasonably reports "it does not work". Nothing told the zee the server half was
   required.
3. **Offers outlive the processes.** The app tier dies with the xell (teardown, crash, respawn),
   but an open offer card stays, still saying "built and running". Any click after teardown → 502.
4. **Offers predating the /xell-web fix** carried the stored LAN URL (`http://10.2.0.16:53xx`),
   which never worked. Any such card still open kept the experience "still broken" even after the
   proxy shipped. (The stale test assertion fixed in this change proves the old shape existed.)

## 3. The fix in this change (smallest correct)

**Offer-time liveness.** `zee verify-webapp` now probes the SAME upstreams the `/xell-web` proxy
dials (`probeRoleUpstream` in `webapp-proxy.js`, which owns upstream resolution — the offer and the
proxy can never disagree about what "up" means):

- webapp upstream dead → **refused**, message names `zee build webapp --wait`;
- webapp up but a server ROLE exists and is dead → **refused** (the hollow-shell case), message
  names `zee build server --wait`;
- no server role at all → allowed (nothing to require);
- the probes run **before** the existing-open-offer shortcut, so re-offering with a dead app tier
  tells the truth instead of reasserting a live link.

Any HTTP answer (even a 404) counts as alive — the probe proves a listener, not an app's health.
Covered in `test/visual-verify.test.mjs` (offer-time liveness section, real listeners on real ports).

## 4. Decision record — "why not just make the queenzee track ports that link to each xell via
## their docker network, and forward traffic to the mapped port?"

**Decision:** Rejected as a *replacement*; recognised as *already built* where it applies. The
queenzee's meta-DB **is** the port tracker (`container.host / host_port / docker_ctx`, written at
provision), and the `/xell-web/<slug>/` proxy **is** the forwarder. No second forwarding layer is
added.

**Context.** Zeehive's own xells run their app tier as `runner: process` — bare Node/Vite processes
**inside the queenzee container**, not docker containers. There is no per-xell docker network and
no docker-mapped port to track for them: `docker inspect` would return nothing, because docker is
not involved past the queenzee container itself. The thing the proposal wants tracked does not
exist for exactly the xells that were failing.

**Options considered:**

- **A. Track docker network/port mappings and forward to them** (the proposal). For: correct
  instinct — a single forwarding hub keyed by tracked ports, zero per-xell config. Against: for
  process-runner xells there is no docker mapping to track (the ports are process listeners inside
  the queenzee container, already recorded in the meta-DB); for compose-runner xells the
  `host:host_port` branch of `resolveRoleUpstream` already does literally this. Adopting it as a
  new mechanism would duplicate the meta-DB with a docker-derived second source of truth that is
  *empty* for the failing case. And it would not have fixed the observed failure at all: a
  forwarded port to a dead or half-built process is still a dead page — the failure was **liveness
  and offer honesty**, not routing.
- **B. Fix the offer to be truthful about liveness** (chosen). For: the observed 502s are exactly
  offers pointing at nothing; the fix is ~40 lines at the seam that already owns upstream
  resolution; testable with real listeners. Against: does not cure offers rotting after teardown
  (follow-up 1).
- **C. Move Zeehive xell app tiers into real per-xell docker containers so ports ARE docker
  mappings.** For: makes the proposal literally true; stronger isolation. Against: rewrites the
  process-runner tier for a problem the proxy already solves; rejected before in
  common-xell-network-plan §5.1-B for the same reason (over-scoped).

**Consequences.** Easy: a zee can no longer put a dead link in front of a human; the refusal names
the one command that fixes it. Hard: an offer can still rot AFTER it is made (teardown) — see
follow-ups. Impossible: nothing; the probe is additive at the verb.

**Reversibility.** Delete the probe block and the verb reverts to row-existence semantics. No
schema change, no data migration.

**What would change our mind.** If the fleet moves xell app tiers into per-xell docker containers
(option C for other reasons), the meta-DB port columns should then be written FROM docker's own
mappings at provision — the tracking idea lands there, and the proxy still needs no change.

## 5. Follow-ups (in priority order)

1. **Settle open offers at xell teardown** (`status='dismissed', dismissed_by='teardown'` when the
   xell is despawned/reaped) — closes failure mode 3. One UPDATE in the despawn path.
2. **Card honesty over time**: the console card could re-probe (via a HEAD to the offer URL, same
   origin) and grey out a dead offer instead of promising "built and running".
3. **Sweep pre-fix offers**: any open offer whose `url` does not start with `/xell-web/` is from
   before the proxy and is dead by construction; dismiss them (data hygiene, one UPDATE).

## 6. Verification in this xell

- `test/visual-verify.test.mjs` — ALL PASSED (including the three new liveness assertions and the
  corrected derived-URL assertion, which FAILED before the code/test were reconciled).
- `test/xell-webapp-network.test.mjs` — ALL PASSED (webapp-proxy.js edit did not disturb it).
- Live fleet probes in §1, including a real open offer (`zee verify-webapp`) whose URL was verified
  to serve HTML 200 / assets 200 / own-API 200 / websocket 101 **before** offering it.

---

## 7. Decision record — direct ports replace the path prefix (supersedes §4 and common-xell-network-plan Decision 5.1)

**Date:** 2026-08-08 (same day, after the human's decision)

#### Decision
A xell webapp is opened at **`http://<console-hostname>:<host_port>/`** — the xell's own port, on
the same hostname the human loaded the console from. The meta-DB's `container.host_port` (already
allocated per xell: `project.port_web_base + slot`, fleet-unique because projects' ranges are
disjoint) IS the port mapping; the queenzee server container **publishes the per-project web
ranges** (compose `ports:` — Zeehive 5300-5389, omnibiz 5200-5289) and `lib/preview-ports.js`
makes every tracked port answer on the container's external interface: wildcard-bound processes
are reached by docker publishing alone; loopback-only and remote-context upstreams get a TCP
forward on the same port number. `/xell-web/<slug>/*` survives only as a **302 redirect** onto the
port (path preserved) so old cards and bookmarks keep working. Vite `base` returns to `'/'`.

#### Context
The human rejected the path-prefix presentation after the deploy of the offer-liveness fix itself
tore down every process-runner webapp (they live inside the queenzee container; recreating it on a
ship kills them) and their card 502'd: *"stop hiding it in a path. just route the port directly"*,
with the example — console at `localhost:5180`, queenzee maps a local port to the xell's webapp,
human opens `localhost:<port>`. This is a presentation decision that was the human's to make, and
it is now made.

#### Options considered
- **A. A dedicated preview-port pool (the example's literal `5181 → cell:5180`).** For: ports can
  be dense and separate from the app-tier allocation. Against: needs new allocation state (a
  column or table, so a migration), a second port ledger to drift from the first, and the number a
  human sees differs from the number every binding, doc and probe already names. Rejected: cost
  with no payer — the meta-DB already allocates a unique fleet-wide web port per xell.
- **B. Same-port publishing + forwarder** (chosen). For: zero new state — `container.host_port` is
  already the mapping; docker does the routing for wildcard binders; ~130 lines of forwarder cover
  loopback-only and remote upstreams; the port a zee is told is the port a human types. Against:
  compose must publish a range per project (a new project's web range is a compose edit + server
  recreate — documented in the compose files), and ~180 published ports cost one docker-proxy
  process each under the default userland proxy (small; disable the userland proxy or narrow the
  ranges if it ever matters).
- **C. Keep the path proxy.** Rejected by the human, explicitly. Kept only as a 302.

#### Consequences
- **Easy:** `http://localhost:5379` next to `http://localhost:5180` — no path, no Vite base, no
  base-aware fetch wrapper doing real work, no websocket proxying (the direct port carries HMR
  natively). The console card/chip swap only the hostname (`previewHref`), so LAN and localhost
  users both work with one stored URL.
- **Hard:** the ranges are fixed at container-create; a new project needs its web range added to
  both compose files. The forwarder must never squat a port a restarting process wants back — it
  binds only while the upstream answers, releases on death (tick-wide race, mitigated by
  close-on-refused-dial; recorded in preview-ports.js).
- **Impossible:** nothing removed — the redirect keeps every old URL alive.

#### Reversibility
Fully reversible: revert the compose ranges, the forwarder wiring and the redirect, restore the
proxy middlewares from git history. No schema change in either direction.

#### What would change our mind
- If xell app tiers move OUT of the queenzee container into per-xell containers, docker publishes
  their ports at provision and the forwarder (not the port scheme) retires.
- If the fleet ever spans hosts a LAN/WG route cannot reach, a hostname-swapped port cannot work
  from the human's browser and the path-on-console-origin presentation would need to return for
  exactly those xells.

## 8. Still true after this change

- Offer-time liveness (§3) — unchanged; the probe dials the same upstreams.
- The restart mortality: a queenzee redeploy still kills process-runner webapps. Direct ports do
  not change that; the liveness probe keeps dead offers from being MADE, and settling open offers
  at teardown (follow-up §5.1) is still the missing piece.
