# Zeehive production on machine `local`

What runs containerized on this machine's daemon (docker context `desktop-linux`), what still
runs as a host process, and the sanctioned path to full containerization.

## Live today

| piece | form | why |
|---|---|---|
| `zeehive_web` (:5180) | **container** — built bundle behind nginx ([Dockerfile.web](Dockerfile.web)) | A dashboard is stateless and self-contained; nothing ties it to the host. `/api` (incl. SSE) proxies to the queenzee via `host.docker.internal`. |
| `zeehive_server` (:4700) | **host process** (self-ship restart pattern) | It cuts git worktrees for host agent sessions; a worktree's `.git` stores an absolute `gitdir:` that only resolves on the side that wrote it — a Linux queenzee would mint worktrees host sessions can't open, and the meta-DB carries `D:/` paths throughout. |
| `zeehive_db` (meta-DB) | container on THIS machine :5445 (migrated off ugreen-nas 2026-07-18) | Pinned volume `zeehive_db_data`; the ugreen copy is kept STOPPED as a cold fallback. |

Deploy / redeploy the dashboard:

```sh
docker compose -f docker/zeehive/docker-compose.prod.yml up -d --build web
```

This file and `docker-compose.bootstrap.yml` describe the SAME stack (project `zeehive`, same
container names and ports) — bootstrap pulls published images, this one builds from the checkout.
Change identity in one and you must change it in the other, or self-ship breaks on fresh installs.

Ships through the gate use [`scripts/ship-zeehive-web.sh`](../../scripts/ship-zeehive-web.sh)
(the `zeehive_web` row's build_script): detached worktree at the approved sha → image build on
the target daemon → `compose up`. Never builds the live working tree.

## The migration to a fully containerized queenzee (agreed 2026-07-18; revised 2026-07-20)

Mark has sanctioned moving the **project folders to the Linux side** to dissolve the gitdir
boundary. Revision 2026-07-20: **GitHub is the inbound transport** (clone/pull only — nothing in
Zeehive ever pushes; Mark pushes by hand), and Mark is decommissioning every existing xell so
both projects restart from ZERO xells. That deletes the old stage 2 (meta-DB `D:/`→`/repos/`
rewrite): there will be nothing to rewrite — projects are simply RE-CREATED in the container via
New Project → Clone from GitHub. Staged, each step reversible:

1. **GitHub inbound** — SHIPPED 2026-07-20: `project.remote_url` (migration 032),
   `server/src/lib/remote-git.js` (probe/clone/pull, fast-forward-only, no push verb exists),
   New Project → Clone from GitHub + per-project ↓ Pull in the console, `github` read-only-PAT
   provider token for private repos.
2. **Container parity** — the image/compose carry everything the host had: entrypoint creates
   the `ugreen-nas`/`mardale-prod` TCP contexts (and the `mardale-prod-alt` SSH context when
   `ZEEHIVE_CTX_MARDALE_ALT` is set) from env; `ZEEHIVE_CTX_MARDALE` is overridable via the
   compose `.env` so `mardale-prod` can be re-pointed at the SSH endpoint while the LAN route
   to the NAS is down (see `docs/onboard-mardale-prod-alt.md` → Failover); `DOCKER_HOST` points
   the `default` context at the mounted socket; volumes for the fleet SSH keypair
   (`zeehive_ssh`) and prod dumps (`zeehive_backups`); `REPOS_DIR=/repos` makes clones land on
   the repos volume; `ZEEHIVE_CXELL_SSH=network` makes the queenzee SSH to cxells by container
   name over `zee-hive-net` (the human's `127.0.0.1:<port>` door is unchanged); cxells get
   `ZEEHIVE_API` injected from `CXELL_API_BASE` (the STABLE host.docker.internal:4700 — the
   compose service name FLAPS during a container recreate, ticket #94) plus `ZEEHIVE_API_FALLBACK`
   from `CXELL_API_FALLBACK` as the second name a script or the CLI can try. Container self-ship is
   `scripts/self-ship-container.sh` (sync → build → sibling `docker:cli` recreate) — selected
   per-site via the container row's `build_script`, so host and container eras coexist as data.
   ⚠ **Harness FILES are not in the image** (and must not be): `harnesses/<key>/` is read from the
   ZEEHIVE PROJECT's clone (`project.repo_root`, i.e. `/repos/Zeehive`), which is why the Zeehive
   project must be onboarded and the repos volume readable before a manager zee gets its manual.
   Boot logs `[harness] <key>: FOLDER MISSING …` and `GET /api/harnesses` carries
   `files_missing`/`bundle_empty` when it is not (fixed 2026-07-29 — before that it was silent and
   every file-backed harness was empty in the deployed queenzee).
3. **Parallel run** — the container (compose profile `experimental`, :4701) against the NEW
   ERA'S OWN meta-DB (`meta-db` service, volume `zeehive_meta_data`) — which is not a throwaway:
   it is the database the new instance keeps forever. Decided 2026-07-20: NOTHING is migrated
   from the old zeehive_db — the new world starts fresh (projects onboarded from GitHub, fresh
   xells), and the old instance keeps its data until it retires. The DATABASE_URL default is the
   in-compose meta-db (it can never resolve to the old zeehive_db, so the two-queenzees guard
   holds); ZEEHIVE_DATABASE_URL still overrides for scratch experiments. Pre-create the cxell
   network once (`docker network create zee-hive-net`) — compose joins it as external. Then:
   New Project → Clone (Zeehive itself, into `/repos`), connect the claude + github tokens, set
   the spawn template to db-isolated, dispatch a cxell zee end-to-end, self-ship.
4. **Zees stay cxell** — the all-cxell runtime is the endgame; credentials come from the
   meta-DB (`provider_token`), so NO `~/.claude` mount is needed for zees. Losses to design
   around: `claude://` deep links can't open Claude Desktop into a container, and host-session
   observability (sessions.js reads of `CLAUDE_HOME`) retires with host zees.
5. **Cutover** — NO data migration, ever (2026-07-20): the new instance keeps its own fresh
   meta-db; the old zeehive_db is never reused. OmniBiz stays on the OLD instance until it is
   onboarded FRESH on the new one (GitHub clone, fresh xells); the old instance and its data are
   left untouched until then. When the old instance retires: container takes :4700 (drop the
   `experimental` profile, flip the port), old zeehive_db + host process stop, old worktrees/
   containers are decommissioned at Mark's pace. Host-zee code paths (local SDK spawn, `claude
   remote`, their monitor passes, hooks/skill host surface) are disabled via `agent_runtime`
   first, deleted in a later cleanup ship.

## The NetBird mesh control plane (docs/netbird-mesh-plan.md §3.1)

`docker-compose.bootstrap.yml` and `docker-compose.prod.yml` both define the self-hosted NetBird
control plane — `netbird-management`, `netbird-signal`, `netbird-relay`, `netbird-dashboard` —
gated behind the **`mesh` compose profile**. That is a deliberate choice: an unscoped `up -d`
boots the pre-mesh stack, and the mesh stays off until a human stands it up **and** points the
queenzee at it. The compose files are only the definition; **live stand-up is a human's deploy,
not something the queenzee does for you**, and it has not been verified in a cage — this section
is the record of how to do it, and it will need adjusting to the NetBird tag you pin (see below).

### What it is, and why the datastore is a one-way door

- The four services are NetBird's own published images (`netbirdio/management`, `netbirdio/signal`,
  `netbirdio/relay`, `netbirdio/dashboard`) — the exact set docs/netbird-mesh-plan.md §3.1 names.
  Coturn/TURN is deliberately **not** included: the fleet is a private LAN, and relay is the
  NAT-traversal fallback NetBird needs here.
- The meta-DB (`mesh_peer`, migration 249) records **intent** — which peers should exist, and the
  setup-key id minted for each. The NetBird management datastore (`netbird_management_data`) is the
  **live** truth — assigned IPs, connectedness, every peer's key material.
- **The management datastore is a one-way door.** Losing it orphans every joined peer at once: the
  queenzee can re-mint intent rows, but every machine/xell/gateway peer must re-join the mesh with
  a fresh setup key, and the old mesh IP space is gone. There is no supported migration path from a
  wiped NetBird store into a fresh one. **Back up the `netbird_management_data` volume before any
  teardown** (`docker run --rm -v zeehive_netbird_management_data:/data -v $(pwd):/backup alpine tar czf
  /backup/netbird-management-$(date +%F).tgz /data`), and treat a restore as the fleet-wide re-join
  it will be.

### Standing it up (one-time bootstrap)

Both compose files already carry the services; the steps below are for a repo checkout driving
`docker/zeehive/docker-compose.prod.yml`. A standalone bootstrap install works the same but the
`netbird/management.json` path is relative to wherever you keep `docker-compose.bootstrap.yml`.

1. **Pin the NetBird tags.** NetBird moves fast and its images' flag surface changes between
   releases (the consolidated port architecture landed around v0.29). Edit the four
   `NETBIRD_*_TAG` vars in your `docker/zeehive/.env` to one release and check that release's
   self-hosted docs before going further. The compose defaults (`:latest`) are for evaluation only.
2. **Write the management config.** Copy the example and edit the endpoints:
   ```sh
   cp netbird/management.json.example netbird/management.json   # from docker/zeehive/
   ```
   `management.json` is read by `netbird-management` from the bind mount `./netbird/management.json`
   (relative to the compose file, so `docker/zeehive/netbird/management.json` in a checkout). The
   example is valid JSON with placeholder `Signal` / `Relay` / datastore-encryption values; fill in
   the LAN addresses/ports you publish below and a real `DataStoreEncryptionKey`/relay secret.
3. **Bring the control plane up.**
   ```sh
   docker compose -f docker/zeehive/docker-compose.prod.yml --profile mesh up -d
   ```
   The services land on the compose network as `netbird-management` / `netbird-signal` /
   `netbird-relay` / `netbird-dashboard`, publishing (defaults, all overridable in your `.env`):

   | service | host port → container | env override |
   |---|---|---|
   | management HTTP API (REST — what `lib/netbird.js` speaks) | `33074 → 443` | `NETBIRD_MGMT_API_PORT` |
   | management gRPC API (agents) | `33073 → 33073` | `NETBIRD_MGMT_GRPC_PORT` |
   | signal | `10000 → 80` | `NETBIRD_SIGNAL_PORT` |
   | relay | `33080 → 33080` | `NETBIRD_RELAY_PORT` |
   | dashboard (optional human UI) | `33081 → 80` | `NETBIRD_DASH_HTTP_PORT` |

   The dashboard needs an OIDC provider (`AUTH_AUTHORITY`/`AUTH_CLIENT_ID`/…) before it can sign
   anyone in; the mesh works without it — the queenzee drives the management REST API, never the
   dashboard.
4. **Point the queenzee at it.** Set these in `docker/zeehive/.env` (never committed) and recreate
   the server so the env reaches it:
   ```sh
   NETBIRD_API_URL=https://netbird-management:443   # or http(s)://<host LAN ip>:33074 for a host-routed install
   NETBIRD_API_TOKEN=<a management API token minted on the control plane>
   ```
   **Both unset = the mesh is disabled** and every mesh path in the queenzee is a legible no-op —
   that is the standing default and the pre-mesh behaviour is unchanged. Only once both are set does
   provisioning mint per-xell peers (mesh-plan §6 phase_3) and the router answer owned roles over the
   mesh (mesh-plan §3.4).
5. **Back up the datastore** (see above) — and schedule it beside the meta-db backups once the mesh
   has live peers. `netbird_management_data` and `netbird_signal_data` are named volumes with
   explicit names, exactly like the `zeehive_*` volumes, so a backup/restore script can mount them
   by bare name.
