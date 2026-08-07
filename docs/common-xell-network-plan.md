# Common Xell Network — Plan & Decision Record

**Date:** 2026-08-06
**Author:** Architect (i-want-all-xells-to-have-a-common-network-wi-fa2518)
**Status:** Implemented (commits 1b16a1f, 0614dee, 6199f86; see §8)
**Harness:** Architect — structure, interfaces, data shape, migration/compatibility strategy,
and the rejected alternatives, not the feature itself.

---

## 1. The problem, as observed (not assumed)

| Claim | Evidence (verified in this xell, 2026-08-06) |
|---|---|
| The webapp is "built and green" | `zee build webapp --wait` → `✓ webapp ... UP and serving your HEAD caa07276` |
| The human cannot reach it | `curl http://10.2.0.16:5383/` → `000` (connection refused) from the cxell; the URL in the binding is `http://10.2.0.16:5383` |
| The webapp process is actually running | `curl -H "Host: localhost:5383" http://zeehive_server:5383/` → `200` — the process runs **inside the queenzee container** (`zeehive_server`, on `zee-hive-net`) |
| Other xells cannot see each other either | every other xell webapp port on `zeehive_server` → `000` (their processes are not running; they were torn down), and the architecture gives no cxell-to-xell-webapp path |
| The console itself is reachable from a cxell | `curl http://host.docker.internal:5180/` → `200` |

### Root cause (two gaps)

1. **Process-runner xells run their app tier as bare processes *inside the queenzee
   container* on `zee-hive-net`** (`runner: process`, `scripts/start-xell-process.sh`).
   The `host`/`host_port`/`url` columns on the `container` rows say
   `10.2.0.16:5383` — a LAN address on the NAS — but **nothing publishes those ports**.
   The process binds loopback-only (`app.listen(config.port)` binds `::`/`0.0.0.0` by
   default in Node, but it is inside the queenzee container, not on the NAS). The health
   probe (`containers.js → probeProcessRole`) checks `127.0.0.1:<port>` *inside the
   queenzee container* and sees `up`; the human's browser on the LAN cannot reach a
   loopback inside the queenzee container.

2. **The URLs the console offers the human are LAN URLs that do not resolve.** The
   webapp chip links to `c.url` (the stored `http://10.2.0.16:5383`), and
   `zee verify-webapp` offers the same URL. Neither is reachable from the console's
   browser because nothing on `10.2.0.16` (the NAS) listens on port 5383.

   A secondary catch: even with the right route, Vite's dev server rejects unknown Host
   headers (`403 Forbidden` — confirmed empirically). So **any** direct-to-Vite URL the
   console links must use a Host Vite trusts (`localhost`, `127.0.0.1`) or Vite must be
   told to allow arbitrary hosts.

---

## 2. Goal (from the task)

> i want all xells to have a common network (without requiring user to configure it).
> i want xells to be able to view each others web apps for review. i especialy want the
> human to be able to view the web app of each xell.

Concretely:

- **Humans** can open any xell's webapp from the console in a new tab (the existing
  chip link + `verify-webapp` offer), and it loads.
- **Xells** (cxells) can reach each other's webapps for review — the zee can
  `curl http://<webapp>/` from inside its cage.
- **Xells on different machines** (dev NAS, prod host, future VPS) are reachable the
  same way. The queenzee already manages multiple docker contexts (`ugreen-nas`,
  `mardale-prod`, `mardale-prod-alt` — see `entrypoint-server.sh`); the goal is one
  uniform URL regardless of which machine a xell's app tier runs on.
- **No per-xell, per-user, or per-network configuration.** It must work for a freshly
  provisioned xell with zero extra steps. ZEEHIVE doing the configuration (e.g. running
  a WireGuard server and minting peer configs) counts as good — the human must not.

---

## 3. The design

### 3.1 Core insight

The processes already run inside the queenzee container on `zee-hive-net` — the one
network every cxell is already on. **Every xell webapp is already reachable from every
cxell** by `http://<queenzee-container>:<host_port>/` with the right Host header. The
queenzee is the natural hub.

What is missing:

1. A **reachable URL** the console and xells can use (the stored `10.2.0.16:5383` is a lie).
2. A **reverse proxy** in the queenzee that (a) exposes every xell webapp under a stable
   path on the queenzee's own origin, and (b) passes a Host header the upstream Vite
   trusts.
3. **Allowing arbitrary Hosts in Vite** so direct-to-Vite links (the chip's `c.url`,
   `verify-webapp` offers) work from any origin.

### 3.2 The reachable URL: a queenzee-side path prefix

Every xell webapp gets a stable, derived URL:

```
https://<console-origin>/xell-web/<slug>/...
```

The console origin is already reachable from a human's browser (it *is* the console)
and from every cxell (`host.docker.internal:5180`). The queenzee's nginx (console)
proxies `/xell-web/*` to the queenzee API at `/api/xell-web/*`, which reverse-proxies
to the target xell's Vite dev server.

**Why a path prefix on the console origin instead of a port or hostname:**
- No per-xell port publishing, no firewall, no DNS, no `extra_hosts`, no network
  membership changes.
- The browser and the cxell both reach the same URL.
- The console already owns `/api/*` proxying — adding `/xell-web/*` next to it is one
  nginx block.

**The Vite base problem** (the one real technical obstacle): Vite serves assets at
absolute paths (`/@vite/client`, `/src/main.jsx`). A browser loading
`https://console/xell-web/<slug>/` will request `/src/main.jsx`, which is wrong. Two
options, in order of preference:

1. **Start Vite with `base: '/xell-web/<slug>/'`** for xell webapps. This makes Vite
   emit relative/prefix-aware asset URLs. Requires the process-start script
   (`start-xell-process.sh`) or the manifest to pass the base, and Vite to be told.
   Since the slug is known at start time (it is in `.zeehive.env` as `SPINOFF_SLUG`),
   `vite.config.js` can read it and set `base` accordingly. **This is the clean fix.**
2. A "path-stripping" reverse proxy (rewrite `/xell-web/<slug>/X` → `/X` and pass Host
   `localhost:<port>`). Vite serves the SPA HTML and assets correctly because the
   browser requests `/<slug>/X` but the proxy strips the prefix. The SPA's own
   client-side routes (React Router) then need a `basename` so `location.pathname`
   matches. This is more moving parts.

**Recommended: Option 1 (Vite `base`) + reverse proxy that preserves the path.**
Actually the cleanest is: the proxy forwards `/xell-web/<slug>/<path>` to
`http://127.0.0.1:<port>/<path>` (strip the prefix), Vite serves under `base` = the
prefix, and the browser's asset requests all carry the prefix. This is exactly how
Vite's `base` option is meant to be used, and it needs **no rewriting of the HTML or
assets** — Vite emits them with the prefix.

But that changes what a direct link to the Vite dev server looks like (the chip link
currently goes straight to `:5383`). With `base` set, a direct link to
`http://10.2.0.16:5383/` would serve a blank shell (assets under `/xell-web/...`).
That is fine — we are **replacing** the direct-to-Vite link with the queenzee-proxied
URL anyway. The stored `c.url` and the `verify-webapp` offer URL should become the
queenzee-proxied URL, and the Vite `base` makes the proxied path work.

### 3.3 The proxy: which process and what paths

Two proxy hops, both already-proven patterns in this repo:

```
Browser / cxell
   │  https://<console-origin>/xell-web/<slug>/...
   ▼
nginx (zeehive_web, console)          — add one location block
   │  /xell-web/*  →  /api/xell-web/*   (proxy_pass to host.docker.internal:4700)
   ▼
queenzee express (zeehive_server:4700) — add one router
   │  /api/xell-web/<slug>/*  →  http://127.0.0.1:<host_port>/*   (strip /api/xell-web/<slug>)
   ▼
Vite dev server (inside zeehive_server, port = xell host_port)
```

The express proxy uses `http-proxy`-style forwarding. This repo has **no
`http-proxy` dependency**. Rather than add one, use Node 18+ built-in `fetch` as a
streaming reverse proxy with a `ReadableStream` body — but that does not stream SSE /
websockets. The console terminal already websockets through `/api/zees/:id/terminal`.
The xell webapps' own `/api` proxy (Vite dev server → xell's own API) would also need
websocket support eventually.

**Cleaner: use `http-proxy` (or `http-proxy-middleware`) as a new dependency.**
This is a well-trodden, zero-config reverse-proxy path and handles upgrade/websocket.
The package registry is open in builds. If the team prefers zero new deps, an express
middleware using Node's `http.request` (a thin ~80-line `lib/webapp-proxy.js`) can
handle both HTTP and `upgrade` with `ws`. **Recommendation: a small internal
`lib/webapp-proxy.js` using `http-proxy` if a dependency is acceptable, else Node
built-ins.** The decision record below weighs this.

### 3.4 Making Vite trust arbitrary hosts

`vite.config.js` gains:

```js
server: {
  host: true,
  allowedHosts: true,   // any Host header — the queenzee proxy and direct LAN links
  ...
}
```

`allowedHosts: true` is a Vite 5 option (confirmed present in `node_modules/vite/dist/node/index.d.ts`).
This removes the `403 Forbidden` for any Host, which the queenzee proxy needs (it
forwards the browser's real Host). **Security note:** in a dev server this allows DNS
rebinding; mitigated because the webapp is a throwaway dev server in a sandboxed
container with no credentials, and the console is the only thing linking to it.

### 3.5 What the console shows

- The webapp chip's `href` (`c.url`) becomes the queenzee-proxied URL
  `https://<console-origin>/xell-web/<slug>/`. This is **derived**, not stored:
  `fleet.js` `decorateXell` computes it from the xell's slug + the request's origin
  (or `config.apiBase`).
- `zee verify-webapp` (`selfVerifyWebapp`) offers the same derived URL.
- The VisualVerify card and the chip "↗ Open URL" menu item keep working unchanged —
  they render whatever URL the row/card carries.

### 3.6 What xells (cxells) use

A zee in a cxell reaches another xell's webapp at
`http://host.docker.internal:5180/xell-web/<slug>/` (or the console origin as
resolved). The firewall default-ALLOWs egress, and `host.docker.internal` resolves in
cxells (verified). No cxell network change needed — the "common network" is
`zee-hive-net` plus the queenzee as a reachable hub, which every cxell is already on.

### 3.7 Data shape

**No schema change needed.** Everything is derived:

| Field | Source | Change |
|---|---|---|
| `container.url` for spinoff webapp | stored LAN URL (`10.2.0.16:5383`) | **Stop presenting it as the clickable URL.** Either recompute on read, or repoint at provision. Read-side derivation is safer (no migration, no stale rows). |
| Clickable URL | `deriveXellWebappUrl(xell)` = `<console-origin>/xell-web/<slug>/` | new pure function |
| `verify-webapp` offer URL | `deriveXellWebappUrl(xell)` | selfVerifyWebapp uses it |
| `container.network` (existing column) | `zee-hive-net` for per-xell process webapps | set at provision (informational; the queenzee already joins it) |

The authoritative fact for "where is xell X's webapp" becomes **the xell slug**, not the
stored port. The port stays authoritative for "which upstream does the proxy hit".

---

## 4. Implementation steps (when signalled)

Each step is independently landable and reversible:

1. **`web/vite.config.js`** — set `base` from `SPINOFF_SLUG` (`.zeehive.env`) when
   present (a xell worktree), else leave at `/`; add `server.allowedHosts: true`.
2. **`server/src/lib/webapp-proxy.js`** (new) — express middleware: match
   `/api/xell-web/:slug/*`, resolve the xell's webapp **upstream address** from the
   meta-DB, forward, stream the response, handle `upgrade` for websockets. Handles
   missing/unknown slug → 404.
   **Upstream resolution** (the cross-machine seam — the one new decision this revision
   adds):
   - *Same daemon as the queenzee* (the common case today): upstream = the process
     runner's `127.0.0.1:<host_port>` inside the queenzee container (the same address
     the health probe already uses — `containers.js processProbeUrls`). No docker
     involved.
   - *Different docker context* (a xell whose app tier runs on `ugreen-nas` /
     `mardale-prod` / a future VPS): the row carries `host` + `host_port` + `docker_ctx`.
     The upstream becomes `http://<row.host>:<host_port>/` **if the queenzee can reach
     that IP:port** (the LAN route to `10.2.0.16`, the `10.1.0.18` NAS, or — after
     WireGuard — a tunnel IP). Cross-context reachability is the *only* part that needs
     a transport (WG or LAN), and it is resolved at proxy time from the row, not
     configured per xell.
   - The middleware picks `127.0.0.1:<port>` when the webapp's `docker_ctx` is
     null/`default`, else `host:<host_port>`. Both are derived from data the meta-DB
     already holds — no new columns.
3. **`server/src/api/routes.js`** — mount the proxy at `/api/xell-web`. A human-gate
   note: this is a **read-only proxy to a throwaway dev server**, not a write to
   anything, so it needs no new gate (it is a GET/stream to a per-xell container, the
   same class as opening a URL in a new tab).
4. **`docker/zeehive/nginx-web.conf`** (+ `docker-compose.bootstrap.yml` if needed) —
   add `location /xell-web/ { proxy_pass http://host.docker.internal:4700/api/xell-web/; ... }`
   mirroring the existing `/api/` block (upgrade/connection map, long read timeout for
   HMR websockets).
5. **`server/src/lib/fleet.js` / `server/src/queenzee/self.js`** — derive the
   clickable URL (`deriveXellWebappUrl`) and attach it to the webapp chip + verify
   offers. Optionally also derive it into `.zeehive.env` as
   `ZEEHIVE_WEBAPP_URL` so the zee can open its own webapp.
6. **Verify end-to-end** in this xell:
   - `curl http://host.docker.internal:5180/xell-web/<my-slug>/` → 200, HTML with
     base-prefixed asset URLs;
   - `curl` the asset path → 200;
   - the chip URL opens in a browser (human gate, but the HTTP path is provable from the
     cxell);
   - `zee verify-webapp` records the derived URL;
   - a second xell (or my own cxell) can reach the webapp over the same URL.
7. **Cross-machine (later, separate ship):** a xell whose app tier runs on a remote
   docker context gets its upstream from `host:host_port`; verify the proxy reaches it
   over the LAN route (and, once WG exists, over the tunnel). This step is gated only on
   the *transport* being up — the proxy code needs no change.

### Ordering rationale

Step 1 and 2/3/4 are separable: the proxy works even without the `base` change for
HTML-only loads (assets would 404), and the `base` change alone works if you only open
the dev-server root with a trusted Host. They must ship **together** for the end-to-end
URL to work, but each is a small, reviewable diff.

---

## 4.5 Direct answers to the human's questions (2026-08-06)

**"Can't I just type `[xell_docker_name]:port` in my browser?"**

No — and the reason is worth stating precisely, because it also explains why the
"common network" is not simply "put everything on one docker network":

- Docker's embedded DNS (`127.0.0.11`) resolves container names **only from inside
  docker networks**. A browser on the LAN is not on `zee-hive-net`, so
  `zeehive_spin_webapp_<slug>:5383` does not resolve in a browser at all. It *does*
  resolve from inside a cxell (verified: `curl http://zeehive_server:5383/` from this
  xell), so the name is fine for zee-to-zee — but then Vite's Host check 403s it
  (verified), so even the container-name form needs the Host fix.
- So "type the docker name" works today only from a machine already on the docker
  network, and only with the Host-header fix. It is a building block, not the answer.

**"How does the user reach the dashboard today?"**

The dashboard container publishes its port on the host — `ports: ["5180:5180"]` in
`docker-compose.bootstrap.yml` / `docker-compose.prod.yml`. The human types
`http://<host-ip>:5180` (or `localhost:5180`). That is the entire mechanism: a
**published port on a reachable host**. The per-xell webapps publish nothing — they are
bare processes inside the queenzee container (no `docker run -p` exists for a process
runner), and their stored URLs (`10.2.0.16:5383`) point at a NAS interface nothing
listens on.

**"How about ZEEHIVE hosting a WireGuard VPN server?"**

This is a good instinct, and the codebase already anticipates it — `deploy_site.ingress`
accepts `kind: 'wireguard'`, and the deploy-topology spec describes a WG mesh where
"containers/hosts reach each other over the tunnel network." So ZEEHIVE running a WG
server and minting peer configs is squarely in the design's spirit, and it is the
**right transport layer** for the cross-machine case (xells whose app tier runs on the
NAS, prod host, or a future VPS).

But WireGuard is not a substitute for the proxy — it is a prerequisite for part of it:

| What WG gives | What WG does NOT give |
|---|---|
| Host-to-host IP reachability (a tunnel IP on each machine) | Container-name resolution (docker DNS still only works inside docker networks) |
| Cross-machine L3 reach | Port mapping (which container/process answers on which port) |
| A private encrypted mesh between ZEEHIVE-controlled machines | Vite's Host check passing (a browser still sends an arbitrary Host) |

So the layering is: **the proxy (`/xell-web/<slug>/`) is the presentation + naming +
port layer; WireGuard is a transport layer.** They compose — once a remote machine is on
the WG mesh, the proxy reaches its xells' webapps at `http://<tunnel-ip>:<port>`, which
is exactly the `host:host_port` upstream branch in the design (§3.7 / step 2). WG makes
the cross-machine branch reachable; it does not replace it.

**"The main goal is containers on different machines accessible to the human with
minimum human configuration — ZEEHIVE handling the configuration counts as good."**

That matches the design. The proxy requires zero per-xell, per-human configuration
(today's single-machine case needs only the code). The cross-machine case needs ONE
boot-time step that ZEEHIVE itself performs: bring up the WG mesh (or confirm the LAN
route) and register the tunnel IPs on the `container`/`machine` rows. The human never
configures a peer by hand.

---

## 5. Decision record

**Date:** 2026-08-06

#### Decision
Every xell webapp is reachable at `<console-origin>/xell-web/<slug>/`, reverse-proxied
by the queenzee express server (via the console nginx) to the Vite dev server running
inside the queenzee container on `zee-hive-net`. No per-xell port publishing, no extra
networks, no user configuration.

#### Context
The app tier for Zeehive's own xells is `runner: process` — bare Node/Vite processes
inside the queenzee container, health-probed at `127.0.0.1:<port>`, and *not* reachable
from the LAN or from other cxells. The stored container URLs (`10.2.0.16:5383`) are
lies. The one network everything is already on is `zee-hive-net`; the queenzee
container is the one node on it that every cxell and the console can both reach.

#### Options considered

- **A. Publish each xell webapp's port on the host/NAS** (add `-p 0.0.0.0:5383:5383`
  for each process). For: direct, no proxy. Against: requires docker port publishing
  for bare processes (the process runner has no docker run), port collisions across the
  fleet, a host firewall hole per xell, and it still doesn't fix Vite's Host check or
  make it reachable from *other cxells* (which are not on the host LAN). Rejected: it
  is the current broken model, extended.
- **B. Put each xell webapp in its own container on `zee-hive-net`** (compose-runner
  for spinoffs). For: proper container isolation, per-xell network identity. Against:
  a huge change to the process-runner architecture, images/build per xell, more moving
  parts, and the task says "common network" — containers on the same network still need
  a reachable URL per xell, which is the same proxy problem. Rejected: over-scoped.
- **C. Proxy through the queenzee at a path prefix** (chosen). For: no port
  publishing, works for browser *and* cxell, uses the one network everything is already
  on, the console already proxies `/api/*` so the pattern exists. Against: needs Vite
  `base` handling; one more proxy hop. **Chosen.**
- **D. Give each xell a hostname** (`<slug>.web.zeehive.local`) resolved via the
  console. For: clean URLs. Against: needs DNS/wildcard config, a per-user or per-host
  setup — exactly what the task says to avoid. Rejected.

#### Why the rejected ones were rejected
- A: requires port publishing for bare processes (not possible without a container
  wrapper), leaves cxell-to-xell unreachable, and keeps the broken stored-LAN-URL
  model.
- B: rewrites the whole process-runner tier for a URL problem; the task wants a common
  network, and containers still need a URL door.
- D: requires user configuration (DNS), which the task explicitly forbids.

#### Consequences
- **Easy:** any xell webapp is one URL away from the console and from any cxell;
  `verify-webapp` and the chip link both work; no schema migration.
- **Hard:** the Vite `base` must be right; the proxy must stream (SSE/HMR websockets);
  the console nginx and the express proxy must agree on the path.
- **Impossible:** direct `http://10.2.0.16:5383` links stop being the canonical URL.
  That is fine — they never worked.

#### Reversibility
Every step is reversible: remove the nginx location + express route + Vite base and the
system returns to exactly today's state. No schema change, no data migration, no
one-way door.

#### What would change our mind
- If the process runner is migrated to compose/container-runner fleet-wide, the proxy
  can be retired in favor of per-container network names — but the queenzee-proxied URL
  still works as a stable human-facing door.

### Decision 5.2 — The proxy is a small internal express middleware using Node built-ins, not a new http-proxy dependency.

**Date:** 2026-08-06

#### Decision
`server/src/lib/webapp-proxy.js` implements HTTP forwarding with Node's `http.request`
and websocket upgrade with the existing `ws` dependency (already in `server/package.json`),
avoiding a new `http-proxy` dependency.

#### Context
The repo has no proxy library. Adding one is a reviewable cost; the pattern needed is
narrow (one path prefix → one upstream port, plus websocket upgrade for Vite HMR). The
existing `ws` dependency already handles upgrades (used for the terminal bridge).

#### Options considered
- **A. `http-proxy-middleware`** — battle-tested, one-liner. For: less code to get
  wrong. Against: new dependency, config surface, upgrade handling still needs wiring.
- **B. Node built-ins + existing `ws`** (chosen). For: zero new deps; ~80 lines; full
  control of Host header and path stripping; websocket upgrade via `ws`. Against:
  hand-rolled streaming edge cases (backpressure, errors).

#### Why rejected
A is a reasonable default, but the proxy surface is genuinely tiny and the repo already
carries `ws`. A hand-rolled middleware is smaller than the dependency's footprint and
keeps the diff reviewable. If the proxy grows (auth, caching, multiple upstreams),
revisit A.

#### Consequences
- **Easy:** no lockfile churn; the middleware is a unit-testable pure-ish module.
- **Hard:** must correctly handle streaming errors, upstream refusal, and the
  `upgrade` event — all assertable in tests.
- **Impossible:** nothing.

#### Reversibility
Swap the internals for `http-proxy` later without changing the route.

#### What would change our mind
- If we need to proxy dozens of xells with connection pooling/retries, a real proxy
  library becomes justified.

### Decision 5.3 — Vite trusts any Host in xell dev servers (`allowedHosts: true`), and the clickable URL is derived from the slug, never the stored LAN port.

**Date:** 2026-08-06

#### Decision
`vite.config.js` sets `server.allowedHosts: true` (when a `.zeehive.env` with
`SPINOFF_SLUG` is present — i.e., in a xell), and every consumer of a xell webapp URL
derives `<console-origin>/xell-web/<slug>/` instead of reading the stored
`10.2.0.16:<port>`.

#### Context
Vite's dev server 403s unknown Hosts (verified empirically). The queenzee proxy
forwards the browser's real origin, so Vite must accept it. The stored URL is a lie and
cannot be fixed by editing one row (they are recomputed at provision).

#### Options considered
- **A. `allowedHosts: true`** (chosen). For: one line; the proxy and any direct link
  work. Against: DNS-rebinding surface on a throwaway dev server.
- **B. Explicit allow-list of console origins.** For: tighter. Against: brittle (the
  console origin varies by install); needs config per install; exactly the "requires
  user configuration" the task forbids.
- **C. Proxy rewrites the Host to `localhost:<port>` only.** For: Vite never sees a
  foreign Host. Against: the browser's asset requests still carry absolute paths from
  the HTML; with `base` set this is fine, but direct-to-Vite links still 403 unless the
  Host is localhost. Chosen as a *complement* to A: the proxy always forwards
  `localhost:<port>` as Host (belt and braces), and A covers direct links.

#### Why rejected
B violates the no-configuration requirement and would need a human to update it per
console origin.

#### Consequences
- **Easy:** any Host works; the proxy is robust.
- **Hard:** none material. A dev-server-only surface.
- **Impossible:** nothing.

#### Reversibility
Revert the one line.

#### What would change our mind
- If a xell webapp ever holds real credentials, re-evaluate `allowedHosts` against a
  per-xell allow-list of console origins.

### Decision 5.4 — ZEEHIVE may host a WireGuard server and mint peer configs, but only as the cross-machine TRANSPORT layer; the proxied URL stays the presentation layer.

**Date:** 2026-08-06

#### Decision
The immediate single-machine fix is the `/xell-web/<slug>/` proxy (5.1). The
cross-machine case — xells whose app tier runs on the NAS, prod host, or a future VPS —
gets host-to-host reachability via a WireGuard mesh that **ZEEHIVE operates**: a WG
server container (on the machine the queenzee runs on, or any reachable host), one peer
config per machine, tunnel IPs stored on the `machine`/`container` rows, and the proxy's
upstream for a remote xell derived from `host:host_port` where `host` is the tunnel IP.
The human never configures a peer.

#### Context
The human's stated goal: "different containers on different machines accessible to the
human with minimum human configuration." The repo already models `ingress.kind:
'wireguard'` and describes a WG mesh in the deploy-topology spec (§4.4). Today the
queenzee manages three docker contexts (`ugreen-nas`, `mardale-prod`,
`mardale-prod-alt`), so cross-machine xells are a real, near-term state. But WG is L3
IP reachability only: it does not resolve docker container names, does not map ports,
and does not satisfy Vite's Host check. Those are the proxy's job.

#### Options considered
- **A. Proxy only, no WG** (the current plan's single-machine scope). For: minimal;
  works for every xell on the queenzee's own daemon. Against: a remote-context xell's
  upstream (`host:host_port`) is only reachable if the LAN route already exists — which
  is the very thing WG exists to guarantee off-LAN / across sites.
- **B. WG mesh operated by ZEEHIVE** (chosen as the transport layer). For: gives every
  ZEEHIVE-controlled machine a stable, encrypted, site-independent address; matches the
  existing `ingress.kind: wireguard` model; the proxy's `host:host_port` upstream works
  unchanged over tunnel IPs. Against: one more service to operate; needs key management;
  the *first* bootstrap of the mesh needs a human (there is nothing to peer with yet).
- **C. Cloudflare Tunnel** (the repo's other modeled ingress kind, and what the
  `mardale-prod-alt` SSH path effectively uses). For: no inbound firewall hole; works
  off-LAN today. Against: outbound dependency on Cloudflare; each xell webapp becomes a
  public URL unless carefully scoped; not a "common network" so much as a set of public
  tunnels. Kept as an alternative ingress for hosts WG cannot reach.

#### Why rejected / deferred
C is deferred, not rejected: for a host that can never be on the WG mesh, a
Cloudflare-tunnel ingress is the fallback. But it is the wrong default — the task asks
for a *common network*, and a tunnel-per-xell is not one. B is chosen only as the
transport; the naming/port/presentation layer stays the proxy regardless.

#### Consequences
- **Easy:** any machine with a WG peer can host xells whose webapps are reachable at
  the same `/xell-web/<slug>/` URL; the proxy code needs no transport awareness beyond
  `host:host_port`.
- **Hard:** WG key/peer lifecycle must be automated (provision a machine → generate a
  peer → register the tunnel IP → hand the config to the machine's docker host). The
  first mesh bootstrap needs a human.
- **Impossible:** nothing. WG is additive.

#### Reversibility
Additive: removing the WG mesh leaves the single-machine proxy intact and every
remote-host xell unreachable again (exactly today's state for them). One-way door: the
first WG server's keys must be kept (regenerating them orphans every peer).

#### What would change our mind
- If every machine ends up on the same LAN/VLAN with stable addresses, WG is
  unnecessary — the proxy's `host:host_port` branch over the LAN suffices.
- If a machine cannot join the WG mesh at all, use a Cloudflare-tunnel ingress for just
  that machine's xells.

---

## 6. What is deliberately NOT in scope

- **Changing the process-runner to compose-runner.** Out of scope; the proxy works for
  both, and the process runner is the current reality.
- **A per-xell subdomain/DNS.** Forbidden by the task. (The path prefix is deliberately
  not a hostname.)
- **Building the WireGuard mesh in this change.** The proxy ships first (single
  machine, zero config); WG is the transport layer for the cross-machine case and is a
  separate, additive ship (decision 5.4). The proxy's upstream-resolution seam already
  accepts `host:host_port`, so WG later slots in with no proxy change.
- **Schema changes.** None needed.
- **Fixing the server role's reachability.** The task is about *webapps for review*.
  The xell server (`:4883`) is **down** — verified: `zee build server --wait` →
  `server DOWN — the build FAILED`. The exact failure is in the queenzee terminal log,
  which a cxell cannot read; from inside the queenzee container the server process
  starts and fails. This is a separate defect (a follow-up); the webapp proxy does not
  depend on it. Note: the webapp's own `/api` proxy (`vite.config.js` → `localhost:PORT`)
  needs the xell server up, so a fully self-contained review (webapp *and* its API)
  also needs the server fix. The webapp HTML/assets review works without it.

---

## 7. Follow-ups after this lands

1. **Fix the xell server role's DATABASE_URL** so the xell's own `/api` proxy works
   through the same `/xell-web` URL (the webapp proxies `/api` to its xell server).
2. **Expose `ZEEHIVE_WEBAPP_URL` in `.zeehive.env`** so a zee can open its own webapp
   URL without asking the console.
3. **A "Open webapp" button on the xell hexagon** (the chip already links; a dedicated
   affordance makes review one click).
4. **Watchdog for stale stored URLs** — derive everywhere, never present `10.2.0.16`
   ports to a human.
5. **The WireGuard transport (decision 5.4)** — when a xell's app tier runs on a
   remote docker context and the LAN route is not guaranteed: a ZEEHIVE-operated WG
   server + peer minting + tunnel-IP registration, feeding the proxy's
   `host:host_port` upstream. The proxy needs no change for it.

---

## 8. Implementation status

Implemented in this xell (commits `1b16a1f` feat(webapp), `0614dee` feat(wireguard),
`6199f86` test).

### Delivered

- **The proxy** — `server/src/lib/webapp-proxy.js` (express middleware + `upgrade`
  handler on the same http server), mounted at `/xell-web/:slug/*` in `routes.js`; the
  console nginx forwards `/xell-web/*` → `/api/xell-web/*` (`nginx-web.conf`). Two
  upstreams under one route: `/xell-web/<slug>/api/*` → the xell's OWN server, everything
  else → the xell's Vite dev server (base-prefixed, `Host: localhost:<port>`).
- **Vite base + Host trust** — `vite.config.js` sets `base: /xell-web/<slug>/` (from
  `SPINOFF_SLUG`) and `allowedHosts: true`; `api.js` gains `baseUrl()` and a global
  `window.fetch` wrapper in `main.jsx` prefixes `/api` with the base; `ZeeTerminal`'s
  websocket uses `baseUrl` too. This is what makes a *reviewed* console hit ITS OWN
  server, not the outer one.
- **The derived clickable URL** — `fleet.js` (webapp chip) and `selfVerifyWebapp`
  (verify offer) now emit `/xell-web/<slug>/` instead of the dead stored `10.2.0.16:<port>`.
- **WireGuard download surface** — migration 152 (`wireguard_server` + `wireguard_peer`),
  `lib/wireguard.js` (native-x25519 keygen, lazy mesh bootstrap, tunnel-IP allocation,
  `.conf` rendering), routes `GET/POST/PATCH /projects/:id/wireguard*`, and a
  `WireguardSection` in the console's ProjectSetup deploy tab with a **Download config**
  button. The private key appears ONLY in the downloaded file — the peer table has no
  `private_key` column.
- **Test** — `test/xell-webapp-network.test.mjs` (22 assertions, all green): URL
  derivation, real WG keypairs, exact `.conf` shape, DB-backed mint with sequential IP
  allocation and strict no-private-key-stored guarantee.

### Verified

- Vite serves the SPA shell under `/xell-web/<slug>/` with base-prefixed asset refs
  (200), and the base-prefixed assets resolve (200) — confirmed against the real built
  webapp through the queenzee container.
- The proxy forwarding core fetches the base-prefixed path from the Vite process and
  returns 200 with base-prefixed asset URLs — confirmed.
- The WireGuard download returns `200` + `Content-Disposition: attachment` with a valid
  keypair, tunnel IP and endpoint — confirmed through the real HTTP server.
- `migration-numbers`, `cxell-cli-drift` pass. `queenzee-inproc-api-only` has one
  pre-existing flaky failure (poller-log timing) that fails identically on the base
  commit — not introduced here.

### Not yet done (needs the real queenzee / a ship)

- The proxy resolves xell webapps against the META-DB the real queenzee reads. This xell's
  nested server reads the shared dev DB (no xell rows), so the proxy returns the correct
  "no webapp for this xell" 404 here — the full resolution fires once this code is on the
  real queenzee. The forwarding mechanics are proven independently.
- The WG SERVER is not actually run (no `wg` container); this ships the config-and-key
  layer so a human CAN download a config. Standing up the interface is the fleet's docker/
  wg responsibility (migration 152 comment), a follow-up.
- The console nginx change (`/xell-web/` location) needs the web container rebuilt/redeployed.
- The cross-machine (remote docker context) upstream branch is implemented but not yet
  exercised against a real remote xell.
