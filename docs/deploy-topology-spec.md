# ZEEHIVE Deployment Topology — Spec & Implementation Plan

Status: **Phases 0–5 implemented (unreviewed).** Known scope notes: 2.2's docker-compose-config
inference and 2.4's poller drift-flag are open (drift is exposed on demand via
GET /projects/:id/manifest); §8 OmniBiz runbook is a zee dispatch, still pending; per-site prod
container INVENTORY for a second site (e.g. VPS) is entered when that site is stood up.
Author: Claude (with Mark) · Date: 2026-07-16 (impl. 2026-07-17)

The goal: a scalable software-development lifecycle for OmniBiz **and every future
project** — where onboarding a project is "write a small manifest, point ZEEHIVE at the
folder, pick deploy sites," and where the same project remains fully developable and
deployable **without** the ZEEHIVE harness running.

---

## 1. Problem

Today the deployment knowledge is split three ways and duplicated:

| Where | What it holds | Failure mode |
|---|---|---|
| Compose files (project repo) | Services, dockerfiles, networks, volumes | Can't say *which instance is which* across multiple xells; can't say *where* (context/host) |
| Meta-DB (`project`, `container`) | Instances, contexts, ports, health | Columns exist but the build path ignores them; API-only truth means no harness → no dev |
| Scripts (`build-container.sh`, `spin-env.sh`, `ship-prod.sh`) | The actual build recipe | OmniBiz shape hardcoded (compose name, `omnibiz-spin-` prefix, port bases 3100/5200/90) |

Inconsistency comes from **duplication**: the same fact (e.g. "spinoffs use
`docker-compose.spinoff.yml` with ports 3100+slot") is written in three places and only
agrees by coincidence.

## 2. Design principles

1. **Single owner per fact.** Every fact has exactly one authoritative home; everything
   else is a *derived projection* that can be regenerated (never hand-edited).
2. **Derivation over storage.** Where a value is a pure function of another (ports from
   slug via `md5 % mod`), both worlds compute it; the DB caches, it never invents.
3. **Projections, not generated code.** ZEEHIVE emits *data* files (a per-worktree env
   file) that the repo's own scripts consume. It never generates executable logic into
   the repo — generated scripts rot into a second source of truth.
4. **Identity lives on the runtime object.** Docker labels stamp every container with
   its project/xell/role/tier/site, so "which container is which" is answerable from
   the Docker side with no harness and no name-parsing.
5. **Declared + observed + reconciled.** The meta-DB describes intent; Docker holds
   reality; the existing monitors (health prober, pool reconciler) close the loop. New
   state (manifest hash, site reachability) joins that pattern rather than being
   asserted once and trusted forever.

## 3. The four truth layers

### 3.1 Repo manifest — `zeehive.yml` (owns the SHAPE)

A small versioned file at the project repo root declaring what compose files cannot:
role→service mapping, env conventions, port scheme, ship entry points, and
**bootstrap prerequisites** (external networks/volumes that must exist before a tier
can come up). It travels with branches — a xell whose branch changes the stack shape
carries a matching manifest.

Concrete OmniBiz manifest (target state):

```yaml
# zeehive.yml — how ZEEHIVE builds, runs, and ships this project.
version: 1
project: omnibiz

env:
  file: .env                # real env, lives in the MAIN checkout only (never worktrees)
  example: .env.example     # what onboarding validates against
  generated: .zeehive.env   # per-worktree projection ZEEHIVE writes (gitignored)

tiers:
  dev:
    compose: docker-compose.dev.yml
  spinoff:
    compose: docker-compose.spinoff.yml
    project_name: "omnibiz-spin-{slug}"          # compose -p
    parameters: [SPINOFF_SLUG, SPINOFF_SERVER_PORT, SPINOFF_WEB_PORT, GIT_COMMIT_HASH]
    ports:                                        # slot = md5(slug)[0:4] % mod
      server: { env: SPINOFF_SERVER_PORT, base: 3100, mod: 90 }
      webapp: { env: SPINOFF_WEB_PORT,   base: 5200, mod: 90 }
    requires:                                     # bootstrap-order facts, verified at provision
      networks: [omnibiz_omnibiz-net]             # external — created by the dev stack
      volumes:  [omnibiz_synapse_data_dev]        # external — appservice registration
  prod:
    # NOTE: prod tiers are per-SITE; sites may override compose (see §5).
    compose: docker-compose.prodsrc.yml
    requires:
      volumes: [postgres_data_prod]               # external — the real data; never auto-created

roles:                       # ZEEHIVE role → compose service (per tier where they differ)
  server: { service: server, buildable: true }
  webapp: { service: webapp, buildable: true }
  db:     { service: postgres, buildable: false } # shared/pinned infra — never a per-xell build
  # everything else in the compose is role 'infra' by default

ship:
  script: scripts/zeehive/ship.sh    # moves INTO this repo (from ZEEHIVE's scripts/ship-prod.sh)
  exec: bash
  targets: [server, webapp]
```

**What deliberately stays OUT of the manifest:** docker contexts, host IPs, DNS names,
tunnel tokens — those are facts about *your machines*, not about the project (§3.2).
And anything compose already declares (dockerfiles, internal ports, service deps,
network wiring) — read via `docker compose config --format json`, never copied.

### 3.2 Meta-DB (owns INSTANCES and SITES)

What a static file cannot express: which xells exist, which containers belong to whom,
allocated ports, health, build commits — **plus the new `deploy_site` table** (§5):
where each tier runs (docker context or local machine), how it's reached (ingress),
and per-site env/secrets references. The API layer surfaces all of it, as today.

### 3.3 Docker labels (own runtime IDENTITY)

Provisioning and compose stamp every ZEEHIVE-managed container:

```yaml
labels:
  zeehive.project: omnibiz
  zeehive.xell: ${SPINOFF_SLUG}       # or 'production' / '-' for shared tiers
  zeehive.role: server
  zeehive.tier: spinoff
  zeehive.site: dev                    # deploy_site.key
```

Payoff: `docker ps --filter label=zeehive.xell=<slug>` answers "which container is
which" with no harness; the health prober filters by label instead of the current
fuzzy name-suffix matching (`matchState` in `server/src/queenzee/containers.js`);
reconciliation becomes exact (a container with labels but no DB row = orphan; a DB row
with no labeled container = gone).

### 3.4 Generated projection — `.zeehive.env` (harness-free operability)

At provision, ZEEHIVE writes a gitignored env file into the worktree:

```bash
# .zeehive.env — GENERATED by ZEEHIVE from the meta-DB. Do not edit; regenerate via the console.
SPINOFF_SLUG=swift-cove-a1b2
SPINOFF_SERVER_PORT=3142
SPINOFF_WEB_PORT=5242
ZEEHIVE_SITE=dev
ZEEHIVE_DOCKER_CONTEXT=ugreen-nas
```

Parameters only — **never secrets** (the real `.env` in the main checkout keeps those;
the meta-DB keeps only `conn_ref` secret *names*, as today). The repo's `spin-env.sh`
prefers this file when present and falls back to its own derivation when absent — so
`docker compose --env-file … up` works with ZEEHIVE stopped, and both worlds compute
identical values because ports are a pure function of the slug (principle 2).

## 4. Docker aspects

### 4.1 `.env` layering

| File | Owner | Contents |
|---|---|---|
| `.env` (main checkout) | Human/project | Real secrets + site-agnostic config. Never in worktrees, never in the meta-DB. |
| `.env.example` | Repo | The contract; onboarding validates `.env` has every non-optional key. |
| `.zeehive.env` (worktree) | ZEEHIVE (generated) | Instance parameters only (slug, ports, site, context). Gitignored. |
| Per-site env (`.env.prod.<site>`) | Human, on the prod host or main checkout | Site secrets: `TUNNEL_TOKEN`, domain names, TURN credentials. Referenced by `deploy_site.env_file`, content never stored in the DB. |

Compose layering: `--env-file <main>/.env --env-file <wt>/.zeehive.env` (later wins) —
one mechanism for both harness and harness-free runs.

### 4.2 Networks

The working pattern (keep it, model it): a **shared external network** per site
(`omnibiz_omnibiz-net`, created by the canonical dev stack) that spinoff stacks join to
reach shared services **by alias** (`postgres`, `synapse`, `livekit`, `mosquitto`),
plus a **private per-spinoff network** for the spinoff's own server↔webapp link.

What ZEEHIVE adds:

- The manifest's `requires.networks` list is **verified at provision** (`docker
  --context <ctx> network inspect`) with a clear error naming the bootstrap step,
  instead of today's crash-loop discovery.
- **Alias verification** joins the health prober: for each `requires` network, check
  the expected aliases resolve. This directly guards the known failure where a
  hand-`docker run` db drops the `postgres` alias on `omnibiz_omnibiz-net` and
  crash-loops every spinoff on next rebuild — the prober should say *"db is up but the
  `postgres` alias is missing on omnibiz_omnibiz-net"* rather than "everything is down."
- Cross-host container networking (dev NAS ↔ prod host, or site↔site) is an **ingress
  concern**, not a compose concern — see §4.4 (WireGuard).

### 4.3 Volumes

- `requires.volumes` in the manifest = external volumes that are **data, not
  disposable state** (`postgres_data_prod`, `omnibiz_synapse_data_dev`). Rules:
  - Provision verifies they exist; never auto-creates them (creating an empty
    `postgres_data_prod` and starting a db on it is a catastrophe dressed as a fix).
  - Despawn/reap **never removes** external volumes; per-xell anonymous/named volumes
    created by the spinoff project are removed with `compose down -v` scoped to the
    project name only.
  - The backup subsystem (006/008 migrations) keys off the same list: a volume named in
    `requires` under a `db` role is a backup target.
- Everything else (caddy_data, redis_data, media volumes) stays compose-owned and
  site-scoped by compose project name; ZEEHIVE doesn't model it.

### 4.4 Ingress & reachability (per SITE)

Each `deploy_site` row carries an `ingress` descriptor — how humans and other systems
reach the stack, and which container (if any) implements it:

```jsonc
// deploy_site.ingress (jsonb)
{
  "kind": "cloudflare-tunnel",          // lan | reverse-proxy | cloudflare-tunnel | wireguard
  "public_url": "https://app.example.com",
  "proxy_role": "infra:caddy",          // the reverse proxy in front (if any)
  "provider_container": "cloudflare_tunnel",  // the container that IS the ingress
  "notes": "WebRTC media (UDP 7882/TCP 7881) does NOT traverse the tunnel — TURN required"
}
```

Supported kinds and what ZEEHIVE does with each:

| kind | Meaning | ZEEHIVE behavior |
|---|---|---|
| `lan` | Reached by host IP:port (the dev NAS today) | URL health = TCP/HTTP probe on `host:port`. |
| `reverse-proxy` | Caddy/nginx in front, DNS → host | Probe `public_url`; the proxy container's health gates "site reachable". |
| `cloudflare-tunnel` | `cloudflared` container with `TUNNEL_TOKEN`, DNS at Cloudflare | The tunnel container is part of the modeled stack (`role=infra`, `provider_container`); **site reachability = tunnel container up AND `public_url` answers**. Caveats recorded in `notes` surface on the console site card (e.g. LiveKit media needs TURN — signaling-only through the tunnel). Token lives in the site env file, never the DB. |
| `wireguard` | Site joined to a WG mesh — containers/hosts reach each other over the tunnel network | `deploy_site.host` may be a WG address (e.g. `10.8.0.x`); docker context endpoints may ride it (`ssh://user@10.8.0.x`). If WG itself runs as a container, model it `role=infra` so its health gates cross-site features (e.g. prod→dev db pulls, site-to-site backups). |

Reachability joins the monitor loop: per site, probe `public_url` (or host:port) on the
containers cadence and stamp `deploy_site.reachable_at` — so the console can say "prod
is up but not reachable through the tunnel," which is a different incident than "prod
is down."

## 5. Multiple production deployments

OmniBiz already has two prod shapes: the **LAN Proxmox host** built from source
(`docker-compose.prodsrc.yml`, context `mardale-prod`, behind caddy + cloudflare
tunnel) and the **VPS registry-image stack** (`docker-compose.prod.yml`, currently
unmanaged). The single `project.docker_ctx_prod` column cannot express this.

### 5.1 Schema: `deploy_site` (new migration `015_deploy_sites.sql`)

```sql
CREATE TABLE deploy_site (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project ON DELETE CASCADE,
  key          text NOT NULL,               -- 'dev' | 'mardale-prod' | 'vps' | ...
  tier         container_tier NOT NULL,     -- dev | prod   (spinoff instances live on the dev site)
  docker_ctx   text NOT NULL DEFAULT 'default',  -- 'default' = THIS machine's daemon; never NULL
  host         inet,                        -- LAN or WG address of the daemon host
  compose_file text,                        -- overrides manifest tier compose (vps → docker-compose.prod.yml)
  env_file     text,                        -- site secrets file (path, content never stored)
  ingress      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- §4.4
  reachable_at timestamptz,
  is_default   boolean NOT NULL DEFAULT false,       -- the site `tier` traffic goes to by default
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
-- exactly one default site per (project, tier)
CREATE UNIQUE INDEX deploy_site_default_uq ON deploy_site (project_id, tier) WHERE is_default;

ALTER TABLE container    ADD COLUMN site_id uuid REFERENCES deploy_site ON DELETE SET NULL;
ALTER TABLE ship_request ADD COLUMN site_id uuid REFERENCES deploy_site;   -- NULL = default prod site
ALTER TABLE deploy_lock  ADD COLUMN site_id uuid REFERENCES deploy_site;   -- lock is PER SITE
```

Backfill: create `dev` + `mardale-prod` sites from `project.docker_ctx_dev/_prod` +
host IPs; point every existing container at its site by matching `docker_ctx`. The old
project columns become deprecated (kept one release for rollback, then dropped).

`docker_ctx = 'default'` is the sanctioned spelling of **"just the local machine"** —
Docker guarantees that context exists — so "local" is a first-class site, not a NULL
convention (NULL currently means "unmonitored" and stays that way).

### 5.2 Semantics

- **One production xell per prod site** — slug `production` for the default site,
  `production-<key>` for others. Existing mechanics (`is_production`, untouchable-xell
  guards, prod-diff) apply per site unchanged; prod-diff compares against *that site's*
  db container.
- **Ship targets a site.** `/ooney` names roles *and* a site (default: default prod
  site). The ship gate cascade (land → schema parity → clean build → human clearance)
  runs against the chosen site's context, compose (site override or manifest), and env
  file. Migrations (014) apply to the target site's db; the ledger is per-database, so
  per-site parity falls out naturally.
- **Deploy lock is per site.** Shipping to the VPS must not block a LAN-prod hotfix.
  Console lock badges show site-scoped holders.
- **Promotion styles coexist:** from-source (`prodsrc`) and registry-image (`prod.yml`)
  are just different `build_script`/compose per site — the container row's
  `build_exec`/`build_script` contract (migration 010) already supports this; a
  registry-image site's ship script does `pull` + `up -d` instead of `build`.

## 6. ZEEHIVE as a project of ZEEHIVE (self-hosting, seeded by default)

ZEEHIVE develops itself the way it develops everything else: through xells. Today
Zeehive work happens directly on the live checkout — the orchestrator edits the code
it is currently running, with no isolation. Self-hosting fixes that and, because
Zeehive's runtime shape differs from OmniBiz's, it forces the spec to earn two of its
own claims: `docker_ctx='default'` (the server runs as **local processes**, not
containers) and a **non-compose tier driver**.

### 6.1 Shape

| Piece | Reality | Modeled as |
|---|---|---|
| Running instance (API :4700 + web) | Node processes on Mark's machine | Prod site `local` (`docker_ctx='default'`), roles `server`/`webapp` with `runner: process` — health by URL probe, not `docker ps` |
| Meta-DB (`zeehive_db`, :5445) | Postgres container (compose `name: zeehive`, pinned) | `role=db, tier=prod` on its site — **the meta-DB is to Zeehive what the prod db is to OmniBiz**: pinned, backed up by the existing maintenance subsystem, never rebuilt by a ship |
| The instance itself | The thing that manages everything | Untouchable `production` xell, per §5 |
| A Zeehive xell | Worktree + its own full stack | Per-xell meta-DB container (`zeehive_db_spin_<slug>`, labeled, slot-ported) provisioned by ZEEHIVE; API + web started **by the zee** in the worktree (`npm run dev`) with ports/URL from `.zeehive.env` |

The manifest gains a `runner: process` tier driver: no compose, no image — the role
declares a start command, a port env var, and a health URL. ZEEHIVE provisions only
the docker-backed roles (the db) and probes process roles by URL; the projection file
carries everything the processes need (`PORT`, web port, `DATABASE_URL` → the xell's
own db).

### 6.2 Isolation rules (hard requirements)

1. **Never the real meta-DB.** The generated `DATABASE_URL` always points at the
   xell's own db; provisioning refuses outright if the resolved URL equals the
   managing instance's `config.databaseUrl`. Two queenzees reconciling one meta-DB
   would reap each other's xells — this failure class has already destroyed live work
   once, so it's a guard, not a convention.
2. **A nested queenzee is a subject under test, not a manager.** The projection for a
   Zeehive xell defaults `BUILD_MODE=simulate`, `PROVISION_APP_TIER=false`,
   `POOL_TARGET_READY=0` — the xell's queenzee provisions nothing real, reaps nothing
   real. Its database is seeded with `seed_demo.js` (which exists for exactly this).
3. **Hooks report outward.** The zee's session hooks keep pointing at the *managing*
   instance's `ZEEHIVE_API` — the inner dev instance never learns about, or acquires,
   the session that is editing it.

### 6.3 Self-ship

Shipping Zeehive to its `local` prod site means the orchestrator restarts **itself**
mid-ship. The ship script must detach (spawn the new process outside the dying one's
tree), and the new process finishes the job from durable state: on boot it already
runs `recoverOrphanBuilds()`; it additionally resumes any `ship_request` in
`status='shipping'` and marks it shipped/failed from a post-restart health check.
Meta-DB migrations ride the ship exactly as app migrations do for OmniBiz (the
ledger-in-app-db mechanism from migration 014 applies to Zeehive's own db unchanged).

Two steps the self-ship must perform that a container ship does not (closed 2026-07-19,
after landing ed805cc exposed both):

- **Working-tree sync.** The queenzee runs from the main checkout's *working tree*, but
  the landing gate advances `master` with `git update-ref` (a real push would re-invoke
  the xource hook and self-deadlock the single-threaded server — see `landgate.js`), and
  update-ref never touches the working tree. So after a gate-landing the files on disk are
  still the *old* code; a bare restart boots stale bytes. `scripts/self-ship-sync.sh`
  (invoked by the detached restart **after** the kill, **before** the start) resets the
  checkout to the exact approved ship sha. It is defensive: genuinely-uncommitted work is
  preserved in a labeled `git stash` first, while the *expected* update-ref delta (the tree
  matching an ancestor of the ship sha) is recognised and reset without a redundant stash.
- **Cage-image rebuild.** New caged-zee capabilities ship inside `zeehive/zee-agent`
  (`docker/zeehive/Dockerfile.zee-agent` — the `zee` CLI, cage-sshd/seed/attach scripts).
  `self-ship.sh` rebuilds that image on the `default` docker context (where cages run) as
  part of the approved ship, so new cages carry the shipped code. Best-effort with loud,
  recorded failure: a build failure is reported on the ship card but does not abort the
  code deploy. Both steps live in `self-ship.sh` (Zeehive's own `build_script`), so they are
  scoped to self-hosting and never touch OmniBiz's container-build ship path.

## 7. Implementation plan (ZEEHIVE side)

Each phase lands independently and is useful on its own.

### Phase 0 — stop the bleeding (no schema changes)

| # | Task | Where |
|---|---|---|
| 0.1 | Thread recorded columns through the dev build: `build.js` reads `compose_file`/`compose_project` from the container row, `env_file` + port bases from project, passes as script args | `server/src/lib/build.js`, `scripts/build-container.sh` |
| 0.2 | Fix global-ctx leaks: provision + reaper use `project.docker_ctx_dev \|\| config.dockerCtx` | `server/src/lib/provision.js:58`, `server/src/queenzee/reaper.js:85` |
| 0.3 | `computePorts` reads `port_server_base/port_web_base/port_slot_mod` from the project row | `server/src/lib/provision.js:17` |

**Accept:** a second project with different compose/ports/context provisions and builds
correctly with zero script edits.

### Phase 1 — sites + settings surface

| # | Task |
|---|---|
| 1.1 | Migration `015_deploy_sites.sql` (§5.1) + backfill + seed update |
| 1.2 | `GET /docker/contexts` — `docker context ls --format json` so the UI offers real contexts (kills typo'd-context-unreachable-forever) |
| 1.3 | `PATCH /projects/:id` + site CRUD (`GET/POST/PATCH/DELETE /projects/:id/sites`) |
| 1.4 | ProjectMenu: Add-form gains a "Deployment" section (dev site + prod site pickers, `default` = this machine); new Edit-project panel for after-the-fact changes |
| 1.5 | Consumers resolve context via site: provision, build, ship, shipmigrate, maintenance/backup, prod-diff, health prober |
| 1.6 | Site reachability probe (§4.4) + console site card (ingress kind, public URL, reachable dot, notes) |

**Accept:** contexts/hosts are editable in the console; every docker invocation
resolves through a site row; the dashboard shows per-site reachability.
**Guard:** editing a site changes where *future* containers go — it never migrates or
restarts live ones (the prod db is pinned outside compose; a context edit must not
touch it).

### Phase 2 — manifest + onboarding inference

| # | Task |
|---|---|
| 2.1 | Manifest schema + parser/validator (`server/src/lib/manifest.js`): YAML → validated object; helpful errors |
| 2.2 | Onboarding: on project add, read `zeehive.yml`; run `docker compose -f <tier> config --format json` per tier to enumerate services, dockerfiles, internal ports; propose role map; verify `.env` vs `.env.example`; verify `requires` nets/volumes per site |
| 2.3 | No manifest? Generate a draft from compose-file scan + heuristics, show it in the console for confirmation, and offer to write it into the repo (the ONE artifact ZEEHIVE may write into a repo, since the human confirms and commits it) |
| 2.4 | Store manifest hash on the project; poller re-hashes per xell branch and flags drift ("this xell's branch changed the stack shape") instead of building against stale assumptions |
| 2.5 | Provision/build/ship read tier compose + parameters from the (branch-local) manifest; container rows keep cached copies stamped `source='manifest'` for display only |
| 2.6 | Naming templates (Appendix A): manifest `naming:` section for container/image/compose-project names, default derived from `project.name`; consumed by provision, rename-xell, xell-db, provision-xell.sh |
| 2.7 | Migration 016: `project.db_name` / `db_user` columns (the app database's identity is a PROJECT fact — the global `PROD_DB_NAME` env is wrong the moment a second project exists); consumed by proddiff, shipmigrate, xell-db, intake, xell-prod |

**Accept:** `createProject` on a manifest-bearing repo needs only name + folder +
sites; a manifest-less repo gets a guided draft; grep for `omnibiz` in `server/src` +
`scripts/` finds only the seed, fallback defaults, and comments (Appendix A burn-down).

### Phase 3 — labels, prober, projection

| # | Task |
|---|---|
| 3.1 | Provisioning passes label env vars; `check-containers.sh` gains a label-filter mode (`docker ps --filter label=zeehive.project=<p>` with `--format` including labels); `matchState` fuzzy matching kept only as fallback for pre-label containers |
| 3.2 | Reconciler: labeled container with no DB row → surfaced as orphan; DB row with no labeled container → down (exact, replaces name-heuristics) |
| 3.3 | Emit `.zeehive.env` at provision (and a `POST /xells/:id/regenerate-env`); despawn removes it |
| 3.4 | Alias verification for `requires.networks` (§4.2) joins the prober |

**Accept:** `docker ps --filter label=zeehive.xell=<slug>` lists exactly that xell's
stack on the right daemon; killing the ZEEHIVE server leaves a worktree that builds and
runs with plain `docker compose` + the two env files.

### Phase 4 — multi-prod

| # | Task |
|---|---|
| 4.1 | Production xell per prod site (`production-<key>`); seed/backfill keeps existing `production` as the default site's |
| 4.2 | `/ooney` + ship console take a site parameter; ship gate + migrations + prod-diff run against the chosen site |
| 4.3 | Deploy lock scoped by `site_id`; console badges + MCP lock tools site-aware |
| 4.4 | Register the VPS as a second OmniBiz prod site (`vps`, `docker-compose.prod.yml`, registry-image ship script) — the acceptance test for the whole phase |

**Accept:** two prod sites ship independently, with independent locks, diffs, and
schema ledgers; the console never shows an ambiguous "prod."

### Phase 5 — ZEEHIVE self-hosting (§6)

| # | Task |
|---|---|
| 5.1 | `seedZeehive()` joins the default seed: Zeehive project row, sites (`local` prod site with `docker_ctx='default'`; the meta-DB container on its real context), pinned `zeehive_db` container row (`role=db, tier=prod`), untouchable `production` xell |
| 5.2 | Manifest `runner: process` driver: role declares start command + port env + health URL; provisioning skips docker for process roles; health prober probes their URL (reuses the §4.4 reachability mechanic) |
| 5.3 | Per-xell meta-DB provisioning: `zeehive_db_spin_<slug>` (labeled, slot-ported off a dedicated base), `.zeehive.env` with `DATABASE_URL`/`PORT`/web port **plus the §6.2 safety defaults**; hard guard: refuse to emit a `DATABASE_URL` equal to the managing instance's own |
| 5.4 | Zeehive repo compliance: its own `zeehive.yml` (process tier for server/web, compose tier for the per-xell db), `.zeehive.env` in `.gitignore`, `seed_demo` wired as the xell seed |
| 5.5 | Self-ship: detached-restart ship script for the `local` site + boot-time resume of `status='shipping'` ship_requests with post-restart health check (§6.3) |

**Accept:** a zee claims a Zeehive xell, runs `npm run db:reset && npm run dev` against
its own db/ports straight from `.zeehive.env`, and its dev instance provisions only
simulated state; the real dashboard shows the xell's process roles via URL probes;
reaping it removes the db container + worktree and touches nothing real; a self-ship
restarts the orchestrator and the ship record lands `shipped` afterwards.

## 8. OmniBiz compliance runbook (dispatch to a zee xell)

Step-by-step tasks to make the **OmniBiz repo** ZEEHIVE-compliant. Dispatch via
`/xell` with `--project OmniBiz` (dispatching from the Zeehive repo without `--project`
resolves the wrong project). All work lands through the normal land gate; nothing here
touches prod or live shared containers.

**Task 1 — write `zeehive.yml`.** Author the manifest exactly as §3.1, at the repo
root. Verify every referenced file exists on the branch. Validate:
`docker compose -f docker-compose.spinoff.yml config --quiet` (and dev/prodsrc).

**Task 2 — label the spinoff compose.** In `docker-compose.spinoff.yml`, add to both
`server` and `webapp` services:
```yaml
labels:
  zeehive.project: omnibiz
  zeehive.xell: ${SPINOFF_SLUG}
  zeehive.role: server        # webapp on the webapp service
  zeehive.tier: spinoff
  zeehive.site: ${ZEEHIVE_SITE:-dev}
```
Verify: `spin-env.sh up` on the xell's own stack, then
`docker --context ugreen-nas ps --filter label=zeehive.xell=<this-slug>` shows exactly
two containers. **Test only against this xell's own spinoff containers — never the
shared dev stack or any other xell's.**

**Task 3 — label dev + prodsrc composes.** Same labels with `zeehive.xell: "-"`,
`zeehive.tier: dev`/`prod`, correct roles (`db` on postgres, `infra` on
caddy/tunnel/redis/synapse/livekit/mosquitto/markitdown/element). Compose-validate
only (`config --quiet`) — do **not** `up` the dev or prod stacks; labels apply on their
next scheduled recreation. Note in the PR that labels take effect lazily.

**Task 4 — teach `spin-env.sh` the projection.** Prefer `.zeehive.env` when present:
```bash
if [ -f "$WT/.zeehive.env" ]; then set -a; . "$WT/.zeehive.env"; set +a; fi
```
before the SLUG/port derivation (which stays as fallback + cross-check: if both exist
and disagree, print a loud warning and trust the file). Export `ZEEHIVE_SITE` default
`dev`. Add `.zeehive.env` to `.gitignore`.

**Task 5 — bring the ship script home.** Copy ZEEHIVE's `scripts/ship-prod.sh` to
`scripts/zeehive/ship.sh` in the OmniBiz repo, keeping the exact contract
(`<exec> <script> <source_path> <role> <docker_ctx> <mode> [build_ref]`, one JSON
result line). Parameterize the compose file via the manifest value instead of the
hardcoded `docker-compose.prodsrc.yml`. Do not wire it up — ZEEHIVE's seed/site config
flips `container.build_script` to the in-repo path in Phase 2 (ZEEHIVE side).

**Task 6 — env contract check.** Diff `.env.example` against the variables the three
compose files consume (`docker compose config` interpolation warnings are the
oracle). Add any missing keys to `.env.example` with placeholder values — especially
prod-site secrets (`TUNNEL_TOKEN`, domains) so a future site setup knows what it needs.
Never commit real values.

**Task 7 — document the bootstrap order.** Add `docs/zeehive-bootstrap.md` to OmniBiz:
dev stack creates `omnibiz_omnibiz-net` + `omnibiz_synapse_data_dev`; spinoffs require
both; prod requires external `postgres_data_prod` (never auto-create); the `postgres`
network alias is load-bearing (document the `docker run` alias-drop failure and its
fix). This is the page a human reads when `requires` verification fails.

**Task 8 — verify end-to-end, then land.** From the xell: `spin-env.sh purge && spin-env.sh up`
using the manifest-declared values; confirm labels, ports, and URL; run the normal
land-gate flow. The ship-script change is exercised later by a SIMULATE-mode ship from
the ZEEHIVE console — not by this zee.

Sequencing: Tasks 1–4 and 6–7 are one landing; Task 5 can ride along (inert until
ZEEHIVE Phase 2). ZEEHIVE Phase 0 is independent; Phase 2.5 and 3.x consume what this
runbook produces.

## 9. Open questions

1. **Manifest scope creep** — resist adding deploy *policy* (approval rules, locks) to
   `zeehive.yml`; policy is queenzee/console domain. Revisit only if a project needs
   repo-versioned policy.
2. **Site env files on remote hosts** — `deploy_site.env_file` is a path; for a remote
   context, is it a path on the *remote* host (compose resolves it there) or shipped at
   deploy time? Current prodsrc practice (path on the prod host) is the default; revisit
   for the VPS site.
3. **WireGuard as managed infra** — if site-to-site WG becomes load-bearing (prod→dev
   backup pulls), does ZEEHIVE own the WG container per site (`role=infra`) or treat it
   as host-level (unmanaged, like the docker daemon itself)? Leaning host-level until a
   concrete need.
4. **Non-compose projects** — partially answered: the `runner: process` driver (§6)
   is the first non-compose tier and Zeehive itself is its reference implementation.
   Plain-Dockerfile or k8s drivers remain future work behind the manifest's `version`
   field.

## Appendix A — OmniBiz hardcode inventory

Every place ZEEHIVE's own code/scripts bake in OmniBiz's shape, and where each fact's
real home is. Rule of thumb: **naming and structure → manifest (Phase 2); identity of
the app database → project row; where things run → deploy_site; deploy mechanics →
scripts in the project repo.** Items marked ✅ were de-hardcoded in the Phase 0/1
implementation (they retain OmniBiz values only as last-resort fallbacks).

| Hardcode | Where | Real home | Phase |
|---|---|---|---|
| Spinoff compose file, env-file location, ports | `build-container.sh`, `provision.js` | container row / project row (recorded at provision) | ✅ 0 |
| Dev/prod docker contexts + hosts | `provision.js`, `reaper.js`, `maintenance.js`, `xell-db.js` | `deploy_site` via `resolveSite()` | ✅ 1 |
| `psql -d omnibiz` literals in zee bindings | `intake.js:245`, `xell-prod.js:76` | `config.prodDbName` today; `project.db_name` eventually | ✅ (interim) |
| Naming templates: `omnibiz_spin_server_<slug>`, `omnibiz_spin_web_<slug>`, `omnibiz_db_spin_<slug>`, image tags `omnibiz-spin-*:<slug>`, compose project `omnibiz-spin-<slug>` | `provision.js`, `rename-xell.js`, `xell-db.js`, `provision-xell.sh`, fallbacks in `build-container.sh` | manifest `naming:` templates (`{project}_spin_{role}_{slug}` …), default derived from `project.name` | 2 |
| App-db identity: db name/user (`config.prodDbName` is GLOBAL — wrong once there are two projects), db password default in `provision-xell-db.sh` | `proddiff.js`, `shipmigrate.js`, `xell-db.js`, `intake.js`, `xell-prod.js` | new `project.db_name` / `db_user` columns (migration 016); queenzee needs these without reading the repo, so a column, not manifest-only | 2 |
| Isolated-db image fallback `omnibiz-postgis:18-3.6-h3` | `xell-db.js` | derived from the source container (already primary path); manifest override | 2 |
| `scripts/spin-env.sh` as the app-tier up/purge contract | `provision-xell.sh`, `despawn-xell.sh` | correct SHAPE (project-owned script); path becomes manifest `tiers.spinoff.scripts: {up, purge}` | 2 |
| Role→service map `server→omnibiz` for prodsrc, compose project `omnibiz`, `--no-deps` prod-db dance | `ship-prod.sh` | moves INTO the OmniBiz repo (runbook Task 5), parameterized by manifest | 2 + runbook |
| `OMNIBIZ_ROOT` env + `config.omnibizRoot` | `config.js`, `reaper.js` cwd (✅ now project-scoped), seed | seed bootstrap only — acceptable; new projects come via onboarding, not env | — |
| `seed.js` container inventory + sites | `seed.js` | intentionally OmniBiz-specific (the reference project); future projects onboard via Phase 2 inference, never hand-seeds | — |
