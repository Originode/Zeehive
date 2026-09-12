# NetBird Mesh — Plan & Decision Record

**Date:** 2026-09-07
**Author:** Architect (bright-grove-d665cf)
**Status:** Phases 0–1 implemented, phase 3–4 seams built (see §11 — added when the human asked
this xell to implement; the plan sections below are the original decision record, unedited)
**Supersedes/extends:** `docs/common-xell-network-plan.md` Decision 5.4 (the WireGuard
transport layer) — this plan is that decision, made concrete with a managed control plane.

---

## 1. The problem, as observed (not assumed)

Three distinct faults share one root, and only one of them is a bug. All three are live in the
project's CURRENT CONDITIONS as of 2026-09-02:

| Fault | Evidence |
|---|---|
| **Host-port exhaustion / collision.** Every xell publishes unique host ports (server, webapp, per-xell clone db), allocated `base + slot mod window` per machine. | `provision.js` carries a whole subsystem for it — formula slot, bounded walk, live daemon probe, and a collision *repair* path (`repairCollidedAppPorts`) — and it still fails: `Bind for 0.0.0.0:5382 failed: port is already allocated` (swift-ridge, 2026-09-02), clone-db bind collision on 5500 (TKT-85-DDC9 family). The window is `mod: 90` per role per machine (`zeehive.yml`), and squatting husks shrink it further. |
| **Docker network address-pool exhaustion.** Every spin stack creates `zeehive-spin-<slug>_default`; retired xells leave theirs behind until the daemon has no subnets left. | `all predefined address pools have been fully subnetted` on BOTH build hosts (local + mardale-prod, TKT-178-06E1, confirmed 2026-09-02). Root cause is a pruning gap, §1.1. |
| **Xells cannot reach their stuff; addresses are baked lies.** A xell's db/app addresses are `host:host_port` LAN pairs stamped at provision; when the topology shifts they silently rot. | This xell's own binding: `10.1.0.15:32773` for the shared dev db → `ECONNREFUSED` (down since Aug 13). TKT-184: `config.js` defaults every client to `http://host.docker.internal:4700`, wrong on any remote machine, "the failure is silent". The cage-age condition (TKT-179): env "is baked at container creation and never re-minted". |

### 1.1 The pruning gap (the only true bug of the three)

`server/src/queenzee/reaper.js` (`reapXell`) tears down, in order: despawn script (which runs
`spin-env.sh purge` **from inside the worktree** — the only place a `compose down` that would
remove the network happens) → `removeXellImages` → `removeCxell` → `stopAndRemoveContainer`
per owned container row → `DELETE FROM container`. Two consequences:

- If the worktree is gone or the purge fails, the queenzee-side fallback removes **containers
  only**. **Nothing on the queenzee side ever removes the spin NETWORK**, so every degraded
  teardown leaks one subnet until the pool is gone. That is TKT-178, mechanically.
- The fallback also cannot remove a container the despawn script half-removed on a *remote*
  context if its row was already dropped — the husk then squats its host port (the TKT-85
  squat family; `repairCollidedAppPorts` exists because of it).

`server/src/lib/docker-repair.js` already knows how to find and remove exactly these leftovers
(empty `-spin-` networks not in any manifest `requires`; husk containers whose spin-slug
resolves to a retired xell) — but only as a medic lever a human dispatches. The detection is
written and safe; what is missing is (a) the reaper doing its own network cleanup as a
**last step of mark-done**, and (b) a scheduled reconciler for what the reaper misses.

### 1.2 Why ports are the root, not just a symptom

The port machinery exists ONLY because every per-xell service must own a unique number in one
flat per-machine 16-bit namespace shared with everything else on the host. Everything downstream
follows: allocation windows, collision repair, husks squatting ports, `.zeehive.env` DSNs that
name a `host:port` pair that stops being true, and a human-facing URL scheme
(`10.1.0.15:5360`) that encodes placement into identity. Remove per-xell host publishing and
that entire class of fault has nothing to stand on.

---

## 2. Goal (from the task)

> instead of ports, install a netbird control plane on the queenzee machine and map all xells
> on same port but different host names. so wise-delta-xxxx or keen-summit-12e3 or
> nimble-grove-xxx … all reachable from queenzee on same port, at the same time.
> xells/xhips should be mapped in netbird control plane via api, and zeehive will now also act
> as router that allows zees to know how to reach their stuff, especially their dev dbs.
> also: queenzee still not pruning old docker stale xell containers — should be a last step
> when marking done to a xell.

Concretely:

- **Identity = hostname, placement = invisible.** `wise-delta-a1b2.<mesh-domain>:5432` is that
  xell's db, `:4700` its server, `:5180` its webapp — the SAME canonical ports for every xell
  (the manifest's existing `internal` ports), on any machine, forever. No slots, no windows,
  no walk, no repair.
- **Peer lifecycle is API-driven by the queenzee**: a peer is minted when a xell/xhip is
  provisioned and deleted when it is reaped — no human configures a peer (the standing
  requirement from `common-xell-network-plan.md` §2 and Decision 5.4).
- **ZEEHIVE is the router, both senses**: the *directory* (an API a zee asks "how do I reach
  my db?" and gets the currently-true answer, instead of trusting an env baked at cage
  creation) and the *gateway* (the hop that lets a caged zee reach mesh addresses without
  running a mesh agent itself).
- **Teardown stops leaking**: network + peer removal are reap steps, and a janitor reconciles
  the daemons and the control plane against the meta-DB on a schedule.

---

## 3. The design

### 3.0 Shape at a glance

```
                     ┌──────────────────────────────────────────────────────┐
                     │ queenzee machine                                     │
                     │  ┌────────────────┐   ┌──────────────────────────┐   │
 humans / console ──▶│  │ NetBird mgmt   │   │ queenzee (zeehive_server)│   │
                     │  │ +signal +relay │◀──│  lib/netbird.js (API)    │   │
                     │  │ (compose svcs) │   │  /api/xell/self/routes   │   │
                     │  └────────────────┘   └──────────────────────────┘   │
                     │  ┌────────────────┐                                  │
   cxells ──route──▶ │  │ mesh-gateway   │  (netbird peer + ip_forward)     │
   (zee-hive-net)    │  └────────────────┘                                  │
                     └──────────────┬───────────────────────────────────────┘
                                    │ WireGuard (NetBird data plane)
              ┌─────────────────────┼──────────────────────┐
        ┌─────▼─────┐        ┌──────▼──────┐        ┌──────▼──────┐
        │ machine   │        │ xell stack  │        │ xell stack  │
        │ peer      │        │ mesh sidecar│        │ mesh sidecar│
        │ (per host)│        │ wise-delta… │        │ keen-summit…│
        │ shared dbs│        │ db/srv/web  │        │ db/srv/web  │
        └───────────┘        └─────────────┘        └─────────────┘
```

### 3.1 The control plane: self-hosted NetBird beside the queenzee

NetBird self-hosted = management service (REST API + gRPC), signal service, relay/TURN, and an
optional dashboard — all containers. They join the queenzee's own compose tier
(`docker-compose.bootstrap.yml` / prod compose, same authorship rules as every queenzee-owned
service), published on the queenzee machine. This is squarely Decision 5.4's "ZEEHIVE operates
the mesh", with the part that decision called **hard** — "WG key/peer lifecycle must be
automated (provision → generate a peer → register the tunnel IP → hand the config over)" —
bought instead of built: setup keys, peer registry, IP allocation (100.64.0.0/10 by default),
peer DNS (`<hostname>.<mesh-domain>`), NAT traversal and access-control policies are the
product, driven over its management API.

The management API token is queenzee config (env, like every other credential the queenzee
holds), surfaced in `zee infra settings` as *presence only* — never the value. The management
datastore (its keys and peer registry) is state to back up: losing it orphans every peer (same
one-way-door note as WG server keys in Decision 5.4).

### 3.2 Peers: who is on the mesh

| Peer kind | One per | Hostname | Purpose |
|---|---|---|---|
| `machine` | build/db host (local, mardale-prod, ugreen-nas…) | `<machine-key>` | Reach the host's *shared* singletons (shared dev dbs keep their published port — they are few, static, and not the exhaustion source). Installed by the existing human-gated bootstrap seam (`zee infra bootstrap --perform`): agent install is a host-level prerequisite, exactly what that card is for. |
| `xell` | spin stack | `<xell-slug>` | The xell's network identity. A **mesh sidecar** container in the generated spin compose (see 3.3). |
| `xhip` | attached device xhip | `<xhip-name>` | Same sidecar shape for device stacks (adb over the mesh instead of a published serial port). Same lifecycle verbs (`devices.js` attach/reaper detach). |
| `gateway` | queenzee machine | `zeehive-gw` | The cxell data-plane hop (3.5). |

Groups mirror kinds (`machines`, `xells`, `gateway`, `prod`) and carry the project
(`project:<name>`). Setup keys are minted per-peer via the API: ephemeral, usage-limit 1,
auto-groups set — a leaked key mints nothing extra.

### 3.3 The per-xell mesh sidecar (how "same port, different hostname" is real)

`lib/compose-gen.js` adds one generated service per spin stack: the NetBird agent container,
`hostname: <slug>`, `cap_add: [NET_ADMIN]`, `devices: [/dev/net/tun]`, attached to the stack's
own network, with `NB_SETUP_KEY` injected from the per-xell key the provisioner minted. The
sidecar owns the peer IP; canonical ports terminate on it and forward one hop to the role
containers over the stack network:

```
<slug>.<mesh-domain>:5432 → db:5432      (the manifest's internal ports — already canonical)
<slug>.<mesh-domain>:4700 → server:4700
<slug>.<mesh-domain>:5180 → webapp:5180
```

> **Name caveat, verified live against v0.78.1 (§11):** NetBird publishes a peer as
> `<slug>-<ip octet3>-<ip octet4>.<mesh-domain>`, not `<slug>.<mesh-domain>` (peer.go
> `getPeerIPDNSLabel`). The spelling above is the INTENDED, stable name — the form the router's
> answers and the manifest should carry — but it is not a name NetBird's DNS answers today. See
> the §10 follow-up before handing this DSN to anything outside the router.

The forward is iptables DNAT in the sidecar (or socat for a first cut) — generated from the
same manifest `ports.*.internal` values the compose generator already reads. The
`base/mod/slot` fields become **unused for reachability** and are kept only during migration
(§6). `ports:` publishing disappears from the generated spin compose at the end state — which
is the actual exhaustion fix.

Nothing about the role containers changes: same images, same internal ports, same stack
network. A xell with no sidecar (old compose) keeps working via published ports until rebuilt.

### 3.4 ZEEHIVE as router — the directory half

New read-only endpoint + verb (self-scoped, token-authenticated like every `/api/xell/self/*`):

```
GET /api/xell/self/routes            →  zee routes
{
  "ok": true,
  "mesh": { "domain": "<mesh-domain>", "cidr": "100.64.0.0/10", "gateway": "<gw mesh ip>" },
  "routes": {
    "db":     { "hostname": "<slug>.<mesh-domain>", "ip": "100.x.y.z", "port": 5432,
                "dsn": "postgresql://…", "source": "mesh", "probed": "ok|refused|unknown" },
    "server": { "hostname": "…", "ip": "…", "port": 4700, "url": "http://…", "source": "mesh" },
    "webapp": { "hostname": "…", "ip": "…", "port": 5180, "url": "http://…", "source": "mesh" }
  },
  "fallback": { "db": { "host": "10.1.0.15", "port": 32773, "source": "legacy-port" }, … }
}
```

Contract points, decided now because callers are stuck with them:

- **The answer is derived at call time** from the meta-DB + control plane, never baked. This is
  the fix for the whole "env is baked at container creation and never re-minted" class
  (TKT-179's cage-age condition, TKT-184's wrong default, this xell's dead DSN): a zee that
  gets `ECONNREFUSED` asks the router and gets the *currently-true* address.
- `source` says which world answered (`mesh` | `legacy-port`) so migration is observable per
  caller. `probed` is best-effort liveness (a bounded TCP dial), never a gate.
- `.zeehive.env` generation (`provision.js` projection) switches `DATABASE_URL` and friends to
  mesh addresses when the xell has a peer, keeping the legacy pair as
  `DATABASE_URL_FALLBACK` during migration. The env stays a *snapshot*; the router is the
  *live* answer; disagreement resolves in the router's favor.
- Reads are open to the calling xell about ITSELF (and its `uses` containers). It never
  answers about another xell's stack — same scope rule as every self verb.

### 3.5 ZEEHIVE as router — the data-plane half (cages)

cxells must reach mesh addresses (their db lives there now), but a per-cage NetBird agent is
deliberately NOT the first step (peer sprawl; needs `/dev/net/tun` added to `cxell.js` run
args; per-cage identity buys nothing while the firewall seal exists). Instead:

- A `mesh-gateway` container on `zee-hive-net` (the one network every cxell is already on)
  runs the queenzee machine's `gateway` peer with `ip_forward` + MASQUERADE toward the mesh.
- The cxell seal (`cxell-firewall.sh`, already root + NET_ADMIN) adds one line:
  `ip route add 100.64.0.0/10 via <gateway's zee-hive-net IP>`.
- Name resolution inside cages: phase 1 hands **IPs** through `zee routes` / `.zeehive.env`
  (NetBird peer IPs are stable for a peer's lifetime, and the router re-answers if one
  changes). Real DNS in cages (dnsmasq on the gateway + `--dns` at cage spawn) is a follow-up,
  not a prerequisite — hostnames are already authoritative in the meta-DB either way.

**The prod seal does not weaken.** Two independent layers: (a) the cage firewall keeps dropping
prod addresses — now including prod peers' mesh IPs — exactly as today, re-sealed on a
human-approved prod bind; (b) NetBird policies are default-deny between groups: `gateway` and
`xells` get no policy to `prod` at all, so prod is unreachable at the *transport* even if a
cage's iptables were wrong. A human-approved `zee prod` bind flips both: the cage seal (as
today) and a narrow, logged control-plane policy. Defense in depth, and the policy change is
itself an auditable API act.

### 3.6 Teardown stops leaking (the task's "last step when marking done")

Reap order in `reapXell` gains two steps after the owned-container loop and BEFORE the
`container` rows are dropped (the rows are the only record of names/contexts — same reasoning
as the existing `removeXellImages` placement):

1. **`removeXellNetworks(ctx, slug)`** — `docker network rm` every network named by this
   xell's rows (`container.network`, `compose_project` + `_default`), on the xell's own
   stamped context. Idempotent, best-effort, logged like its siblings — but now the queenzee
   does it itself instead of hoping the worktree-side purge ran.
2. **`deregisterMeshPeer(xellId)`** — delete the xell's peer(s) via the management API, stamp
   `mesh_peer.removed_at`. A control-plane peer must never outlive its xell.

And the reconciler for whatever best-effort misses: a scheduled janitor (queenzee tick, per
machine) runs `planDockerRepair` and auto-performs ONLY its two provably-throwaway step kinds
— empty `-spin-` networks not in any manifest `requires`, and husk containers whose spin-slug
resolves to a **retired** xell in this meta-DB — the exact safety line `docker-repair.js`
already draws in code. Everything else stays a reported `cannot` for the medic plane. Same
pass, third trigger (boot janitor / medic button / schedule); plus a mesh pass: a NetBird peer
whose hostname matches no live xell/machine/xhip row → deleted.

This is deliberately **phase 0** and independent of NetBird: it fixes TKT-178's disease with
code that already exists, and nothing later in this plan works on daemons whose address pools
are exhausted.

---

## 4. Data shape

One new table (authoritative mapping between fleet rows and control-plane peers):

```sql
CREATE TABLE mesh_peer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('machine','xell','xhip','gateway')),
  xell_id       uuid REFERENCES xell ON DELETE SET NULL,      -- iff kind='xell'
  machine_id    uuid,                                          -- iff kind='machine'
  hostname      text NOT NULL,                                 -- <slug> / <machine-key>; UNIQUE while active
  nb_peer_id    text,                                          -- the control plane's id, once joined
  nb_setup_key_id text,                                        -- which key minted it (audit)
  ip            inet,                                          -- the mesh IP, once assigned
  status        text NOT NULL DEFAULT 'minted',                -- minted|joined|removed|degraded
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);
CREATE UNIQUE INDEX mesh_peer_active_hostname ON mesh_peer (hostname) WHERE removed_at IS NULL;
```

Authority when the two worlds disagree — written down because this is the question every
reconciler bug becomes:

- The **meta-DB is authoritative for INTENT** (which peers should exist): a peer in the control
  plane with no active `mesh_peer` row is a leak → janitor deletes it.
- The **control plane is authoritative for LIVE state** (assigned IP, connected/last-seen):
  `mesh_peer.ip` is a cache stamped on join, refreshed by the janitor, and the router endpoint
  may re-read the API on a miss.
- `container.host` / `host_port` / `url` keep their meaning for legacy/shared rows and DURING
  migration; end state for per-xell rows: `host_port` NULL, `url` derived from
  `mesh_peer.hostname` + the manifest internal port. No columns are dropped (data outlives
  code; shared singletons and prod still use them).

The hand-rolled `wireguard_server` / `wireguard_peer` tables (migration 152) are **frozen, not
dropped**: the human "download a .conf" surface keeps working until the NetBird dashboard +
a human setup key replace it, then a follow-up retires the tables. No migration rewrites them.

Migration numbering: taken at build time via `zee migration-number` (not claimed here).

---

## 5. Interfaces (contracts before implementation)

**`server/src/lib/netbird.js`** — bounded management-API client, same injected-adapter,
never-throws-raw shape as `build-readiness.js` / `docker-repair.js` so it table-tests without
a control plane:

```
createSetupKey({ name, autoGroups, ephemeral: true, usageLimit: 1, expiresInSec }) → { id, key }
getPeerByHostname(hostname) → { id, ip, connected, lastSeen } | null
deletePeer(nbPeerId) → { ok }        # idempotent: 404 counts as ok
listPeers() → [...]                  # janitor's read
ensureGroup(name) → { id }
ensurePolicy({ name, sourceGroups, destGroups, ports }) → { id }   # prod-bind uses this
```

Every call: bounded timeout, `{ ok:false, reason }` on failure (an unreachable control plane
degrades to legacy-port answers, never a hang in provision/reap paths).

**`reapXell` additions** (§3.6): `removeXellNetworks`, `deregisterMeshPeer` — both best-effort
+ logged, both BEFORE `DELETE FROM container`.

**Janitor**: a queenzee tick per machine context; auto-performs only `stale-network` +
retired-slug husk steps from `planDockerRepair`, plus the mesh orphan-peer pass; everything
else surfaces to the medic plane. Every act is an `activity` line (the receipt pattern).

**Router**: `GET /api/xell/self/routes` + `zee routes` as specified in §3.4. Additive to
`zee status` (which keeps its shape).

**Provisioner**: mint peer + setup key before compose-gen; inject `NB_SETUP_KEY`; write
`mesh_peer` row; on provision failure the minted key is ephemeral/usage-1 and the janitor
removes the never-joined peer.

---

## 6. Migration & compatibility (running system, old data, old callers, half-deployed fleet)

Each phase is independently landable, stop-safe, and has a way back.

| Phase | What ships | Stop-safe because | Way back |
|---|---|---|---|
| **0. Prune** | Reap-time network removal + scheduled janitor (docker-repair subset). No NetBird anywhere. | Pure cleanup of provably-dead resources; unblocks today's wedged hosts (a human still prunes the *current* backlog once — the janitor keeps it flat after). | Remove the tick; the medic lever remains. |
| **1. Control plane** | NetBird services in the queenzee compose; `lib/netbird.js`; `mesh_peer` migration; token in config. Nothing consumes it. | Additive services + an empty table. | `compose down` the services; table stays empty. |
| **2. Machine peers** | Bootstrap-card step installs agents on build hosts; machine rows get peers; router endpoint ships answering `legacy-port` for everything, `mesh` for machine-level targets (shared dev dbs). | Every existing address keeps working; the router is a new, optional read. | Uninstall agents (bootstrap card again); router falls back to legacy answers. |
| **3. Xell sidecars — dual-stack** | compose-gen adds the sidecar; provisioner mints peers; `.zeehive.env` gains mesh DSN + `_FALLBACK`; **ports still published**. Old xells untouched until rebuilt (a rebuild regenerates compose — the existing "cage env is baked" reality means old cages simply keep their working legacy pair). | Both address families are true at once; per-caller `source` shows adoption. | Regenerate compose without the sidecar; env projection reverts. |
| **4. Cage routing + prod policy** | mesh-gateway container; one route line in the cage seal; default-deny NetBird policies; prod-bind flips policy + seal together. | Cages that predate the seal change still use legacy ports (published until phase 5). | Remove route line + gateway; policies were default-deny (removing them denies more, never less). |
| **5. Stop publishing** | Generated spin compose drops per-xell `ports:`; allocator paths (`freeAppSlot`, walk, squat-repair) become dead code behind the sidecar and are removed; `preview-ports` forwards to mesh upstreams (its `targetFor` already reads a row — it gains the mesh branch, same seam as `webapp-proxy`'s upstream resolution). | Only after phases 2–4 have run long enough that router `source` telemetry shows no `legacy-port` consumers for per-xell targets. | Re-add `ports:` to the generator (allocation code restorable from git); this is the step to take slowly. |

**One-way doors, named:** (a) the control plane's datastore/keys — back up from phase 1, losing
it orphans every peer (re-mint is automated but a fleet-wide re-join event); (b) deleting the
allocator code in phase 5 — cheap to restore from git but re-publishing needs a re-provision
wave, so phase 5 waits for the telemetry. Everything else is two-way.

**Old callers inventory** (checked against the code, not assumed): host-zee scripts and humans
using `container.url` → unchanged until phase 5, then the URL column carries the mesh URL;
`webapp-proxy` / `preview-ports` → gain a mesh upstream branch (both already resolve upstreams
from the row — the seam exists); health probes (`containers.js`) → probe the mesh address for
sidecar stacks, same dial; the firewall seal → extended, never replaced; grok/OAuth/gateway
concerns of TKT-179 → untouched (different layer; noted to keep this plan honest about scope).

---

## 7. Decision record

### DR-1 — Per-xell reachability moves from allocated host ports to mesh hostnames with canonical ports; NetBird (self-hosted, on the queenzee machine) is the mesh.

**Date:** 2026-09-07

**Context.** Per-xell host publishing exhausts and collides (TKT-85 live), leaked spin networks
exhaust daemon address pools (TKT-178 live, both hosts), and stamped `host:port` addresses rot
silently (TKT-184, this xell's own dead DSN). `common-xell-network-plan.md` Decision 5.4
already chose a ZEEHIVE-operated WG mesh as the transport layer and named peer-lifecycle
automation as the hard, unbuilt part. The task names NetBird.

**Options considered.**

- **A. Keep ports; harden the allocator** (central lease table, wider windows, more repair).
  *For:* no new infrastructure; the allocator exists. *Against:* the namespace is one flat
  per-machine range shared with everything on the host — no allocator ends collisions with
  things it does not allocate (husks, other stacks, the OS); the repair path exists because
  this already failed; does nothing for rotting addresses or cross-machine reach. **Rejected:
  it is the current broken model, extended — the same verdict §5's option A got in the
  common-network DR.**
- **B. Finish the hand-rolled WG layer** (migration 152, `lib/wireguard.js`). *For:* zero new
  vendor; keys already mint natively; consistent with DR 5.4. *Against:* what is missing is
  precisely the expensive part — a running interface, peer lifecycle, NAT traversal/relay,
  DNS, ACLs, reconciliation. That is a management plane, and building one by hand is months of
  undifferentiated work NetBird already is (NetBird *is* WireGuard plus exactly this).
  **Rejected: DR 5.4 called lifecycle automation the hard consequence; buy it, don't build it.**
- **C. Tailscale / headscale.** *For:* most mature UX of the family. *Against:* the official
  coordination plane is a hosted third-party service (an outbound dependency for the fleet's
  internal addressing); headscale is a community reimplementation where the management API and
  ACL surface we would automate against is the least-stable part. NetBird is first-party
  self-hostable including relay + management REST API, which is the piece this design drives.
  **Rejected for fit, not quality; C is the fallback if NetBird self-hosting proves fragile.**
- **D. Docker swarm / cross-host overlay networks.** *For:* docker-native hostnames. *Against:*
  requires converting every daemon to swarm; docker subnet allocation is the disease we are
  treating; container DNS still stops at the docker boundary (no human/browser/cage reach —
  §4.5 of the common-network plan proved this class); process-runner projects have no
  container to join. **Rejected.**
- **E. Extend the queenzee TCP proxy (`preview-ports`) to all roles including dbs.** *For:*
  no agents anywhere; pattern exists. *Against:* keeps the per-xell port namespace (the
  disease) since each xell still needs a distinct number on the shared origin; every db
  connection in the fleet then dies on a queenzee restart; the queenzee becomes a data-plane
  bottleneck for bulk traffic it has no business carrying. **Rejected as the primary model;
  it remains the presentation layer for humans (unchanged) and the migration fallback.**
- **F. NetBird control plane on the queenzee machine; per-stack sidecar peers; canonical
  internal ports; API-driven lifecycle.** **Chosen.**

**Consequences.** *Easy:* placement becomes pure meta-DB data (a xell moves machines without a
single address changing — the containerized-spinoff goal in `zeehive.yml`'s own header);
allocation/collision code deletes; teardown leaks become a janitor's no-op; prod gets a second,
transport-level seal. *Hard:* the control plane is new operated state (backup, upgrade, one
more thing down means degraded-to-fallback); the sidecar adds one container per stack; cages
need the gateway hop. *Impossible after phase 5:* addressing a xell by host:port — deliberate.

**Reversibility.** Phases 0–4 are two-way (§6). Phase 5 is slow-reversible (re-publish +
re-provision wave). The control-plane datastore is the one artifact that must never be lost.

**What would change our mind.** (a) NetBird's self-hosted management proving operationally
heavier than the ports pain — measured by janitor/medic incident volume before phase 3 commits
the fleet; (b) a fleet consolidated onto one machine forever (then plain docker networks +
the existing proxy suffice and this is over-engineering); (c) per-connection relay overhead
showing up in db benchmarks (then machine-peers-only — option shrink — still deletes the port
allocator, and sidecars stay LAN-local).

### DR-2 — Pruning is a reap step plus a scheduled reconciler, reusing docker-repair's safety line; it ships first and does not wait for the mesh.

**Date:** 2026-09-07

**Context.** §1.1. The reaper never removes networks; `spin-env.sh purge` only runs from an
intact worktree; docker-repair's stale-leftover detection exists but fires only on a medic's
button. Both build hosts are wedged by exactly this today.

**Options considered.** (a) *Only* strengthen the reaper — rejected alone: best-effort steps
miss (remote ctx down at reap time), and the current backlog predates any reaper fix; (b)
*only* a cron janitor — rejected alone: the leak window stays a whole tick, and "the reaper
leaks by design" is not a sentence to write; (c) **both, with the janitor auto-performing
ONLY docker-repair's two provably-throwaway step kinds** — chosen; the safety line is already
drawn in code and reviewed; (d) `docker network prune`/`system prune` on a schedule —
rejected: prunes by attachment, not ownership; on a shared daemon it removes other projects'
idle-but-wanted resources; the manifest-`requires` guard exists because of this.

**Consequences.** *Easy:* TKT-178's class ends; the medic lever stays for everything outside
the line. *Hard:* the janitor must never race an in-flight provision — it only touches
networks with zero attached containers and slugs that are already `retired`, both stable
facts. **Reversibility:** remove the tick. **Changes our mind:** a single verified case of the
janitor removing something live — then it demotes to plan-and-report (medic card) fleet-wide.

### DR-3 — Cages reach the mesh through a queenzee gateway, not per-cage agents; the router endpoint is the source of truth for "how do I reach my stuff".

**Date:** 2026-09-07

**Context.** cxells have NET_ADMIN but no TUN device; env in a cage is baked at creation and
provably rots; the task says "zeehive will now also act as router".

**Options considered.** (a) per-cage NetBird agents — deferred, not rejected: buys per-cage
transport identity/ACLs at the cost of TUN in every cage and peer counts scaling with cages;
adopt later if per-cage ACLs are ever needed; (b) **gateway container + one route in the seal +
a live `routes` endpoint** — chosen: zero new per-cage software, the seal script is already the
place per-cage network truth is written, and the *directory* half fixes the baked-env rot for
every consumer at once; (c) hosts-file/env re-minting into running cages — rejected: fights
the "env is baked" reality instead of accepting it; a push model into thousands of cages is a
reconciliation swamp; the pull model (`zee routes`) is one bounded read.

**Consequences.** *Easy:* a zee with a dead DSN has a one-verb answer; migration is observable
via `source`. *Hard:* the gateway is a single hop for cage→mesh traffic (acceptable: cage
traffic is interactive/test-scale; the app tier's own traffic never crosses it).
**Reversibility:** full. **Changes our mind:** gateway saturation, or a real need for per-cage
transport ACLs — both lead to (a), which this design leaves a clean seam for (a cage is just
one more peer kind).

---

## 8. Deliberately NOT in scope

- **Building any of it in this xell.** This is the Architect deliverable; phases 0–5 are
  separate, ordered work items (suggested cut: one per phase, phase 0 first and urgent).
- **Prod app-tier topology.** Prod's compose, the 4701 publish (TKT-179 standing condition:
  never remove those lines), and the ship path are untouched. Prod containers may *gain* a
  machine peer for reachability, behind the default-deny policy; nothing prod-side is required
  for phases 0–3.
- **Replacing the human-facing webapp presentation layer.** `/xell-web/<slug>/` and
  preview-ports stay the human door; this plan changes their *upstreams*, not their contract.
- **Per-cage mesh agents and in-cage mesh DNS** — named seams (DR-3, §3.5), not built.
- **Retiring migration-152 WG tables** — follow-up after the NetBird dashboard covers the
  human-download use case.

## 9. What I am least sure about (said plainly)

1. **Sidecar DNAT vs. NetBird's own ingress features.** NetBird has been growing
   port-forward/ingress features; if the deployed version can express "peer port → stack
   service" natively, the sidecar's iptables half shrinks to config. The builder of phase 3
   should check the shipped version's API first — the *shape* (a peer per stack, canonical
   ports) does not change either way.
2. **Relay throughput for db traffic** when a direct WireGuard path cannot be established
   (double-NAT between build hosts). LAN-internal peers should go direct; if a benchmark shows
   relay in the path for bulk db work, see DR-1's "changes our mind" (c).
3. **The exact NetBird management API surface** (endpoints/fields in §5) was written from its
   documented REST API; the builder had to pin a management version and freeze `lib/netbird.js`
   against it. **CLOSED (2026-09-12) — pinned to v0.78.1 and driven live**; the pinning caught two
   real drifts (a 422 on every policy create, and the peer DNS-label scheme). See §11
   "Live against a real NetBird management server" for the versions, the evidence, and the two
   shapes that differ from the documented REST API.

## 10. Follow-ups after this lands

1. Cut phase 0 as its own urgent work item (reaper steps + janitor) — it needs no NetBird
   decision at all and both build hosts are wedged on its absence today.
2. A one-time human prune of the current network/husk backlog (the janitor keeps it flat
   afterwards, but cannot start containers on a daemon that is already out of pools).
3. Phase-3 telemetry: count `source: legacy-port` answers per day — the number that gates
   phase 5.
4. Retire `wireguard_server`/`wireguard_peer` + `lib/wireguard.js` once the dashboard covers
   the human-download case (supersession note goes in that change's DR).
5. **Make the mesh name real** (found live, §11): NetBird answers
   `<slug>-<ip3>-<ip4>.<mesh-domain>`, so §3.4's `<slug>.<mesh-domain>` resolves only for the
   router's own answers. Either give the peer an `extra_dns_labels` entry of `<slug>` (the field
   exists in v0.78.1 and is the supported way) or render the IP-suffixed name from
   `mesh_peer.ip`. Do it before a human is handed a DSN from `zee routes` to paste into psql.

---

## 11. Implementation status (2026-09-07, same xell, on the human's instruction)

### Delivered

- **Phase 0 — pruning** (`f83608ad`): `lib/docker.js removeNetwork` (daemon API, in-use refusal
  is a verdict, SSH refused); `reaper.js xellNetworkCandidates` (pure, slug-guarded) + network
  removal after the owned containers, before the rows drop; `lib/docker-repair.js
  sweepDockerLeftovers` + `startDockerJanitor` (hourly; auto-performs ONLY stale-network +
  stale-container; dry-run unless `PROVISION_MODE=real`; knobs `DOCKER_JANITOR_ENABLED/_MS/
  _DRY_RUN`), registered in `index.js`. Test: `test/docker-janitor.test.mjs`.
- **Phase 1 — control-plane client + registry** (`106b8690`): migration 249 `mesh_peer`
  (intent/live split, active-hostname partial unique index, kind binding); `lib/netbird.js`
  (bounded injected adapter; setup keys one-off/usage-1/ephemeral; the key is returned once and
  never stored; `deregisterXellPeers` rides the reap's destructive verdict and a failed delete
  keeps the row active for retry; `sweepOrphanMeshPeers` deletes only removed-row / retired-slug
  peers — unknown hostnames are reported, never deleted); config `NETBIRD_API_URL` /
  `NETBIRD_API_TOKEN` / `MESH_DOMAIN` (both unset = every entry point a legible no-op). The
  docker janitor tick runs the mesh pass (non-dry-run only). Test: `test/netbird-mesh.test.mjs`.
- **Router, directory half** (`1de5d32a`): `GET /api/xell/self/routes` + `zee routes` +
  migration 250 (worker manual, anchored `harness_memory_put`). `lib/mesh-routes.js` is the pure
  derivation; contract as §3.4 (source telemetry, owned-roles-only mesh answers, fallback
  dual-stack, DSN re-addressed keeping credentials, bounded db probe). Live-verified in-cage:
  real server on loopback against a sandbox meta-DB, real bearer token, legacy AND mesh answers
  over HTTP and via the CLI. `cxell-cli-drift` green.
- **Phase 3 seam — the sidecar** (`c9c1150b`): `compose-gen.js` generates the `mesh` service
  behind `tiers.spinoff.mesh.enabled` (netbird agent, hostname = slug, canonical-port DNAT
  wrapper exec'ing the image's own entrypoint, idle-without-key guard). Opt-in only; the
  committed spinoff compose is untouched; role ports still publish (dual-stack until phase 5).
- **Control-plane compose** (§3.1, `30840ab3`): the NetBird management/signal/relay/dashboard
  services behind the `mesh` profile in BOTH queenzee compose files (bootstrap + prod twin, same
  container names + ports in lockstep), named datastore volumes declared (`netbird_management_data`
  is the documented one-way door), and the server env passing `NETBIRD_API_URL`/`NETBIRD_API_TOKEN`
  through EMPTY by default + `MESH_DOMAIN`. An unscoped `up -d` boots the exact pre-mesh stack.
  Test: `test/netbird-compose.test.mjs`. Live stand-up stays a human deploy (write
  `netbird/management.json`, set the token, back up the datastore).
- **Provisioner integration** (§6 phase 3, `9e8c95c1`): the provision path mints the per-xell peer
  and relays `SPINOFF_MESH_SETUP_KEY` / `SPINOFF_MESH_MGMT_URL` into the build env + `.zeehive.env`
  (mesh-DSN projection with `DATABASE_URL_FALLBACK`), guards on the manifest's
  `tiers.spinoff.mesh.enabled` opt-in, and re-checks the join before every emit. Mesh unset → every
  relay is a legible no-op. Test: `test/netbird-provision-env.test.mjs`.
- **Machine peers via the bootstrap card** (§3.2 phase 2) + the **gateway + cage route +
  default-deny prod policies** (§3.5) — this increment: the human-gated bootstrap card
  (`planBuildBootstrap`/`performBuildBootstrap`) plans and performs a `mesh-machine-peer` step —
  mints the machine's kind=`machine` intent row + a one-off setup key that rides the step receipt
  and is never stored; `selfRoutes` answers USED shared containers through their machine's joined
  peer (kept published port, DSN re-addressed) while owned roles still answer through the xell's own
  peer; the `mesh-gateway` agent service joins zee-hive-net (external; compose never owns it) and
  `cxell-firewall.sh` adds the one `ip route replace` of `100.64.0.0/10` via the gateway when
  `MESH_GATEWAY_IP` is set (unset = no mesh line, legacy ports stay the whole story);
  `netbird.js` grows the default-deny policy guard (`policyIsDefaultDenySafe` refuses any
  prod-destination grant that is not a narrow named port BEFORE a control-plane call) and
  `decideProdBind` flips the one narrow `xells→prod:<db>` policy a human-approved prod bind needs.
  Tests: `test/build-bootstrap.test.mjs`, `test/mesh-routes.test.mjs`, `test/netbird-policies.test.mjs`,
  `test/netbird-compose.test.mjs`. The committed `docker-compose.spinoff.yml` is untouched.
- **The cage's route was dead; the seal now resolves it** (`b012a91f`): the `ip route replace` line
  above landed with the gateway, but nothing ever set `MESH_GATEWAY_IP` — `sealCxell` shells
  `docker exec -u 0 … cxell-firewall.sh` and `docker exec` inherits nothing, so the branch could
  not fire on ANY install. The address cannot be configuration (docker reassigns it on every
  recreate, and `zee-hive-net` is external and per docker host), so `lib/cxell.js
  resolveMeshGatewayIp` inspects the running `zeehive_mesh_gateway` on the CAGE'S OWN context at
  seal time and passes `-e MESH_GATEWAY_IP=…`. Mesh disabled → null with NO docker call and an argv
  byte-identical to the pre-mesh seal; no gateway on this machine → logged as ordinary, seal
  continues; `config.meshGatewayIp` (`MESH_GATEWAY_IP`) is the validated escape hatch for a gateway
  this compose did not create. Only ever ADDS a route — the prod DROP list is untouched. Test:
  `test/mesh-gateway-seal.test.mjs` (27 assertions, verified red before the fix). Documented for the
  operator in `docker/zeehive/README.md`.

### Verified live vs verified by test (2026-09-10, the inheriting xell)

Live, in-cage: a migrated sandbox meta-DB (`zee db-sandbox --migrate`) + a real queenzee on
loopback + real bearer tokens, driving real endpoints over HTTP —
`GET /api/xell/self/routes` returning the legacy-only answer with the mesh unset; the same endpoint
with mesh rows present returning a USED shared db through its MACHINE peer (published port kept, DSN
re-addressed, credentials preserved) and owned roles through the xell's own peer with the full
`fallback` block; and the identical payload through the real `scripts/zee routes` CLI.

By test only (the honest limits): the provisioner relay (§6 phase 3) is exercised against tables and
fakes, not a live provision; the bootstrap card's `mesh-machine-peer` step cannot be executed from a
cage at all — `planBuildBootstrap` refuses with `cannot reach context '…': spawn docker ENOENT`,
which is correct (a cage has no docker CLI, by design) and means the plan/perform path must be
proven by a human on a machine with contexts. Every mesh path was exercised with the control plane
ABSENT; nothing here has ever spoken to a live NetBird API.

Two suites are red on `main` and were red before this work (proved by stashing onto clean HEAD):
`test/manual-cage-claims.test.mjs` (4 — migration 115's anchors are no longer byte-present in the
injected manual, which has been rewritten since) and `test/dk-verdict-contract.test.mjs` (2 —
undeclared marker `IDENTITY_OK`, uncovered declared marker `WROTE_TRACKED`). Neither touches mesh
code; left alone deliberately. Also worth knowing: a queenzee left running against the sandbox DB
will reap the fixture xells out from under `test/netbird-provision-env.test.mjs` mid-run and make it
look flaky — stop the server before running the db suites.

### Live against a real NetBird management server (2026-09-12, this xell — §9.3 CLOSED)

`lib/netbird.js` is no longer written from documentation. A REAL NetBird management server
**v0.78.1** was booted on `127.0.0.1` inside the cage (sqlite store, no IdP, no TLS, no Signal) and
every exported function was driven at it over HTTP by **`test/netbird-live-api.test.mjs`**.

**The pin.** Management = `netbirdio/management:0.78.1`, pulled from the Docker Hub registry over
HTTPS (there is no management binary on the GitHub release), linux/amd64 manifest
`sha256:c78ba74d0747…`, binary `sha256:03325d3249c6…`. Client = the GitHub release
`netbird_0.78.1_linux_amd64.tar.gz`, binary `sha256:dec903b426de…` (`netbird version` → 0.78.1).
`scripts/fetch-netbird-binaries.mjs` re-pulls both and verifies those sha256s, so "verified against
v0.78.1" cannot silently drift to a different build. The compose defaults are now pinned to the same
tag (`docker-compose.bootstrap.yml` + `docker/zeehive/docker-compose.prod.yml`, all five `netbirdio/*`
images) instead of `:latest`; bumping them means re-running the live test.

**Live-verified (real server, real PAT, real rows):** `GET /api/peers` 200 with a live token and 401
without one; `createSetupKey` → a real key that the control plane then lists with `usage_limit 1`,
`ephemeral true`, unrevoked, carrying its `auto_groups`; `ensureGroup` create-then-find (one id, no
duplicate); `listPeers`; `getPeerByHostname` (hit, and a stranger → `peer: null`, not a failure);
`deletePeer` → real delete, and a repeat DELETE's **404 → `alreadyGone`**; `listPolicies`;
`ensurePolicy` create + find-by-name idempotency + the no-ports variant; the real policy round-trips
with the group ids, `protocol tcp`, `ports ["5432"]`, `enabled`; `ensureProdBindMeshPolicy` →
exactly `xells→prod tcp:5432`; and against a migrated sandbox meta-DB (`zee db-sandbox --migrate`)
the intent-row paths: `mintPeer` → `markPeerJoined` (caches the control plane's peer id + IP) →
`deregisterXellPeers` (real delete + row stamp, idempotent) → `sweepOrphanMeshPeers` (a removed-row
peer deleted, an unknown hostname reported and left alive). Finally a REAL `netbird` **agent**
registered through the API with a setup key OUR client minted (e.g. `mesh-e2e-agent`, ip
`100.64.33.167`, dns_label `mesh-e2e-agent-33-167.netbird.selfhosted`) and our client deregistered
it — the end-to-end story this plan rests on.

**Drift found and fixed (the point of the exercise):**

1. **Every `ensurePolicy` call was a 422.** The rule body posted `source`/`destination` and no
   `protocol`; the real `PolicyRuleUpdate` wants **`sources`/`destinations`**, a REQUIRED
   **`protocol`**, and a rule-level **`enabled`** — the server answered
   `422 specify either sources or source resources and destinations or destination resources`.
   Ports are also refused on protocol `all`/`icmp`
   (`for ALL or ICMP protocol ports is not allowed`), so the fix derives the protocol: `tcp` when
   the rule names ports (the only grants this module makes are db ports), `all` otherwise, with
   `ports` omitted there. Fix at `lib/netbird.js ensurePolicy`; `test/netbird-policies.test.mjs`
   now pins the corrected body.
2. **The peer DNS label is IP-suffixed, and the documented `<hostname>.<domain>` is wrong.**
   `getPeerIPDNSLabel` (management/server/peer.go) builds
   `<hostname>-<ipv4 octet 3>-<ipv4 octet 4>.<dns-domain>` — a peer `mesh-e2e-seed` on
   `100.64.171.11` is published as `mesh-e2e-seed-171-11.netbird.selfhosted`, and that is exactly
   what the API's `dns_label` field answered. `meshFqdn(hostname, ip)` now produces that name (and
   the one-arg form is documented as the INTENDED name only); `getPeerByHostname` still resolves by
   the authoritative `hostname` field, so peer lookup was never broken, but the §3.4
   `<slug>.<mesh-domain>` DSN spelling is not a name NetBird DNS would answer — see the follow-up
   in §10.
3. **Read shape ≠ write shape.** The policy CREATE body takes group ID strings; the policy READ
   body returns `GroupMinimum` objects (`{id,name,peers_count}`) for `sources`/`destinations`. No
   code change needed (find-by-name reads only `name`/`id`), but a future consumer must not assume
   symmetry.
4. **`docker/zeehive/netbird/management.json.example` could not boot a real server.**
   `DataStoreEncryptionKey: "CHANGE-ME-32-byte-…"` is not valid base64 → the server dies with
   `failed to create field encryptor: decode encryption key: illegal base64 data at input byte 5`.
   The example now carries a VALID base64 32-byte placeholder, and `test/netbird-compose.test.mjs`
   asserts it decodes to 32 bytes. The example's `HttpConfig.Address` no longer exists in v0.78.1's
   `HttpServerConfig` (the listen address is the `--port` flag) and is gone; the README says both.

**Honest limits.** The install's own control plane is still not stood up (§3.1, item 1 below). The
harness seeds the store by hand — with `IdpManagerConfig.ManagerType: "none"` there is NO supported
way to create the first account/user/PAT, which is itself a finding for the human deploy — so those
row shapes are read off the server's source and a future release could break the HARNESS before it
breaks `lib/netbird.js`. The agent registers headless (no Signal server): the peer row and the
registration are proven, a WireGuard tunnel is not; likewise no TLS/dashboard/relay/TURN. Peer rows
for the read/delete assertions are seeded directly into sqlite (the REST API has no create-peer
endpoint) — peer CREATION by a real agent is what the optional client section proves.

Reproduce: `node scripts/fetch-netbird-binaries.mjs` then
`zee db-sandbox --migrate` and
`DATABASE_URL="$(…)" node test/netbird-live-api.test.mjs`. Without the binary it skips loudly; with
the binary but an unmigrated meta-DB it proves the REST surface and skips the intent-row half
loudly. Two consecutive full runs passed.

### NOT done (the honest list — each is a follow-up work item)

1. **Standing up the control plane LIVE** (§3.1): a human on the queenzee machine runs
   `docker compose --profile mesh up -d`, writes `netbird/management.json`, sets
   `NETBIRD_API_URL`/`NETBIRD_API_TOKEN` (and `NETBIRD_GATEWAY_SETUP_KEY` for the gateway) in the
   install's `.env`, and does the datastore backup. The compose seam is shipped and the API client
   is now live-proven against v0.78.1 (§11), but the install's own running control plane is still
   the human deploy — including the first account/user/PAT, which no supported path creates when
   `IdpManagerConfig.ManagerType` is `"none"` (see §11's honest limits).
2. **Per-cage mesh agents and in-cage mesh DNS** — named seams (DR-3, §3.5), not built. The cage's
   path to the mesh is the gateway route, not an in-cage agent.
3. **Phase 5** (stop publishing ports, delete the allocator) — gated on `source: legacy-port`
   telemetry, as planned.
4. The **current backlog** on the wedged hosts still needs one human prune (or a medic
   `docker_repair` dispatch per machine) — the janitor keeps it flat only from then on.
