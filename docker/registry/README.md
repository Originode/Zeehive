# Split-build registry

The one piece of infra a split build needs: an OCI registry that both the **build** daemon (where
an image compiles) and the **run** daemon (where the container runs) can reach. Compile on the
beefy host → `push` here → the NAS `pull`s → `up --no-build`. Without it, an image built on one
daemon is invisible to the other.

See [`../../scripts/build-container.sh`](../../scripts/build-container.sh) (the `cold-remote` path)
and [`server/src/lib/build.js`](../../server/src/lib/build.js) (`resolveBuildTarget`).

## 1. Bring the registry up (on the LAN, next to the fleet)

Run it against the **run host's** context so it lives on the LAN — never across the mardale link
(a registry behind a slow link makes split builds slower than building on the NAS):

```sh
docker --context ugreen-nas compose -f docker/registry/docker-compose.yml up -d
docker --context ugreen-nas exec zeehive_registry wget -qO- http://localhost:5000/v2/   # -> {}
```

Then tell the project about it — **console → Project Setup → Build registry**, or set
`project.registry` / the `SPINOFF_REGISTRY` env fallback to:

```
10.1.0.18:5000
```

## 2. Trust the registry on every participating daemon (`daemon.json`)

The registry above serves **plain HTTP**, so each daemon that pushes to or pulls from it must list
it as insecure — otherwise docker demands TLS and every push/pull fails. Merge this into each
daemon's `daemon.json` (create the file if absent), keeping any keys already there:

```json
{
  "insecure-registries": ["10.1.0.18:5000"]
}
```

Apply it on **every context that participates** — the run host and any host you compile on:

| Host | Role | `daemon.json` location | Apply |
|------|------|------------------------|-------|
| `ugreen-nas` (10.1.0.18) | run host + hosts the registry | `/etc/docker/daemon.json` | `sudo systemctl restart docker` |
| `mardale-prod` (10.2.0.16) | optional build host | `/etc/docker/daemon.json` | `sudo systemctl restart docker` |
| this PC (Docker Desktop) | optional LAN build host | Docker Desktop → Settings → **Docker Engine** (edit the JSON there) | Apply & Restart |

> Restarting a daemon bounces every container on it. Do the run host (`ugreen-nas`) during a quiet
> window, and never while a live build or an active headless zee depends on the fleet.

Prefer to avoid the insecure flag entirely? Put a TLS cert on the registry (or front it with the
project's existing reverse proxy) and skip this step — then `project.registry` is the HTTPS name.

## 3. Prove the round-trip before trusting it

Point one **dummy** xell's build at the beefy context and rebuild:

- MCP (as a zee): `zeehive_set_build_context { xell_id, build_ctx: "mardale-prod" }` then `zeehive_build`
- API: `PATCH /api/xells/:id/build-ctx { "build_ctx": "mardale-prod" }` then `POST /api/xells/:id/build`
- Console: right-click the xell's server/webapp chip → **compile on → mardale-prod**

Watch the queenzee log for `compiling on mardale-prod → run on ugreen-nas` and the container settle
`up`. Reset with `build_ctx: ""` (→ back to the run host).

## Garbage collection

Teardown (`removeXellImages`) and the hourly janitor already reclaim a retired xell's images on
both the build and run daemons. The registry keeps its own copy of each pushed image; reclaim those
periodically (deletes are enabled in the compose):

```sh
# after deleting unwanted tags via the registry API, compact the blob store:
docker --context ugreen-nas exec zeehive_registry \
  registry garbage-collect /etc/docker/registry/config.yml
```
