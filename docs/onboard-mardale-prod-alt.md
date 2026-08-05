# Onboard `mardale-prod-alt` — reach the Mardale prod daemon from anywhere

`mardale-prod` reaches the Mardale production NAS over the LAN/VPN
(`tcp://10.2.0.16:2375`). `mardale-prod-alt` reaches the **same machine** through an SSH
tunnel over Cloudflare Access — so the docker CLI works from any machine with
`cloudflared` + the SSH key, not just machines on the Mardale network.

- **Target** : SSH host `ssh.omnibiz.express` (behind Cloudflare Access), SSH user `mnrevelo`
- **Result** : `docker --context mardale-prod-alt ps` lists the prod containers
  (`omnibiz_server_prod`, `omnibiz_db_prod_v184`, `cloudflare_tunnel`, …)
- **Never remove or modify** the sibling `mardale-prod` context — it is the LAN/VPN path and
  the default ship target. The alt context is additive.

> ⚠ This is a **host-machine** runbook: every step runs on a workstation or server that has
> Docker + Cloudflare Access (the "queenzee host"). It **cannot** be performed from inside a
> Zeehive cxell — a cxell has no docker CLI and no egress to the SSH host (default-DROP
> firewall; only the queenzee API and the xell's own containers resolve). If you are a zee
> handed this task, land the *code* parts (entrypoint env, docs) and raise the *host* parts
> to a human.

## 1. Install cloudflared

- **Windows** : `winget install --id Cloudflare.cloudflared`
  (the MSI adds it to the **machine** PATH — open a new terminal or call it by full path)
- **macOS** : `brew install cloudflared`
- **Linux** : official Cloudflare apt/rpm repo

## 2. Add the SSH config entry (`~/.ssh/config`)

```
Host ssh.omnibiz.express
    User mnrevelo
    ProxyCommand cloudflared access ssh --hostname %h
    StrictHostKeyChecking accept-new
    ServerAliveInterval 30
    IdentityFile ~/.ssh/id_ed25519_mardale
```

**Windows only:** OpenSSH for Windows does **not** support `ControlMaster` / `ControlPath` /
`ControlPersist` — omit them. And because Windows ssh runs `ProxyCommand` through `cmd.exe`,
quoting `C:\Program Files (x86)\...` is unreliable; use the 8.3 short path instead:

```
ProxyCommand C:\PROGRA~2\cloudflared\cloudflared.exe access ssh --hostname %h
```

## 3. Generate a key for THIS machine

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_mardale -C "<user>@<machine>-docker-alt"
```

- **No passphrase.** Windows OpenSSH cannot multiplex, so there is no reuse to amortize a
  prompt.
- PowerShell gotcha: `-N '""'` sets the *literal* passphrase `""`, it does **not** mean empty.
  Verify with `ssh-keygen -y -f <key>` — if it asks for a passphrase, strip it with
  `ssh-keygen -p -f <key> -P '""' -N ''`.

## 4. Authenticate to Cloudflare Access

```sh
cloudflared access login ssh.omnibiz.express
```

Opens a browser. Re-run whenever a `Connection timed out during banner exchange` appears.

## 5. Install the public key on the NAS (asks for the `mnrevelo` password once)

Use a form that does **not** introduce CRLF (PowerShell pipes append CRLF, and a trailing `\r`
silently breaks `authorized_keys` matching):

```powershell
$k = (Get-Content "$env:USERPROFILE\.ssh\id_ed25519_mardale.pub" -Raw).Trim()
ssh ssh.omnibiz.express "mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\n' '$k' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

(macOS/Linux: `ssh-copy-id -i ~/.ssh/id_ed25519_mardale.pub ssh.omnibiz.express`)

## 6. Create the context

```sh
docker context create mardale-prod-alt \
  --description "Mardale Production NAS via Cloudflare Access SSH" \
  --docker "host=ssh://mnrevelo@ssh.omnibiz.express"
```

## Verify (all three must pass)

```sh
ssh -o BatchMode=yes ssh.omnibiz.express "id; command -v docker"     # BatchMode proves key-only auth; expect group 988(docker) and /usr/bin/docker
docker --context mardale-prod-alt ps
docker --context mardale-prod-alt info --format '{{.ID}} {{.Name}}'
```

## How the queenzee learns about this context

Once a human has stood the context up on the queenzee host, the containerized queenzee
**auto-creates it from env** at boot (`docker/zeehive/entrypoint-server.sh`):

| env var | value | note |
|---|---|---|
| `ZEEHIVE_CTX_MARDALE_ALT` | `ssh://mnrevelo@ssh.omnibiz.express` | set in `docker/zeehive/docker-compose.prod.yml`; unset = skip |

Because an SSH docker context cannot be driven over the docker **HTTP API**, only the parts of
ZEEHIVE that shell out to the `docker` CLI can use it (builds via `--context`, the console's
`docker --context … exec/ps` terminals, ship scripts). The HTTP-based monitors (health,
discovery, reaper — `server/src/lib/docker.js`) keep pointing at a TCP context; an SSH endpoint
is refused with an explicit error rather than a confusing "unsupported docker endpoint".

## The Deploy sites tab is the source of truth (the queenzee auto-heals)

Since migration 109, each deploy site in **Project Settings → Deploy sites** declares a
`docker_endpoint` — the full `host=` string its `docker_ctx` should dial
(`tcp://10.2.0.16:2375`, `ssh://mnrevelo@ssh.omnibiz.express`, …). The queenzee **reconciles its
own docker context to match**: `docker context create` if missing, `docker context update` if it
drifted, no-op if already correct — on every site save AND every minute
(`lib/context-reconcile.js`, `queenzee/context-reconcile-loop.js`).

So the failover is now a **console edit**, not a host command:

1. In the console, open **Project Settings → Deploy sites**, find the `mardale-prod` site, and set
   its **endpoint** to `ssh://mnrevelo@ssh.omnibiz.express`. Save.
2. The queenzee re-points the `mardale-prod` context to SSH immediately (and heals it back to the
   tab's truth every minute).
3. **Recovery**: set the endpoint back to `tcp://10.2.0.16:2375` and save — prod returns to the
   LAN path.

> ⚠ **The one thing code cannot auto-heal:** the queenzee host still needs cloudflared + a
> Cloudflare Access login + the SSH key on the NAS ONCE, because the SSH transport itself lives in
> the host's `~/.ssh/config` and cloudflared. The reconcile re-points the context; it does not
> install the tunnel. If the SSH hop itself fails, a manual `docker --context mardale-prod-alt ps`
> on the queenzee host shows why.

## Failover: point `mardale-prod` at the SSH endpoint while the LAN is down

When the route to the NAS's LAN IP (`10.2.0.16`) is down but `ssh.omnibiz.express` is up, the
queenzee's `mardale-prod` context (the one OmniBiz's prod chips, ship path and seed path use)
can be re-pointed at the SSH endpoint **without a code change**. TCP stays the default, so the
flip is reversible and prod auto-recovers when the LAN returns.

> **Prefer the console edit above.** The manual commands below are the fallback when the queenzee
> is running code older than migration 109, or you want an immediate flip without touching the
> tab (which the reconcile will then heal back to, so also update the tab).

> **Which deployment shape?** The flip command depends on how the queenzee runs:
>
> - **Host process** (the live deployment today — `docker/zeehive/README.md` → "host process
>   (self-ship restart pattern)"): the queenzee reads the `~/.docker` context store directly, so
>   you flip the context itself with `docker context update` (step 2a below).
> - **Containerized queenzee** (the migration era — `Dockerfile.server` + `entrypoint-server.sh`):
>   the entrypoint creates the context from env at boot, so you flip the env override
>   (step 2b below).

1. **Prereq — the queenzee host must be able to reach SSH itself.** The queenzee image ships
   `openssh-client` but **not** `cloudflared`; the SSH context's `ProxyCommand cloudflared access
   ssh …` runs against the **host's** PATH, so the host needs cloudflared installed + logged in
   (steps 1–4 above) and the host's SSH key on the NAS (step 5). Verify the CLI path works on the
   queenzee host before relying on it:

   ```sh
   docker --context mardale-prod-alt ps
   ```

2a. **The flip — host-process queenzee** (live today):

   ```sh
   docker context update mardale-prod \
     --docker host=ssh://mnrevelo@ssh.omnibiz.express
   docker --context mardale-prod ps        # verify — the prod containers
   ```

2b. **The flip — containerized queenzee**:

   ```sh
   # docker/zeehive/.env  (gitignored)
   ZEEHIVE_CTX_MARDALE=ssh://mnrevelo@ssh.omnibiz.express

   docker compose -f docker/zeehive/docker-compose.prod.yml up -d server
   # the entrypoint re-creates/updates the mardale-prod context from the env override
   ```

3. **What the console will show after the flip:** the prod chips reflect real docker state again —
   `server/src/lib/docker.js` dials an SSH context's daemon through the docker CLI
   (`docker --context <ctx> ps`) rather than the HTTP API, so the health monitor reports
   `up`/`down` (and `unknown` only when the SSH daemon itself is unreachable). Ships, seeds and
   `docker --context mardale-prod …` operations work — they already shelled out to the CLI.

4. **Recovery** when the LAN is back:
   - host process: `docker context update mardale-prod --docker host=tcp://10.2.0.16:2375`
   - containerized: remove the `.env` override (or set it back to the IP) and `up -d server`
     again — `mardale-prod` returns to `tcp://10.2.0.16:2375` automatically.

## Troubleshooting

- **"Connection timed out during banner exchange"** → Access session expired or never
  established. Re-run step 4. This is the most common failure.
- `cloudflared` prints a `.../cdn-cgi/access/cli?aud=...` URL → it wants an interactive login;
  a service token was passed that isn't in this app's policy. The `db.omnibiz.express` service
  token is **not** valid for the SSH app.
- **"docker: command not found" over ssh** → remote docker isn't on the non-interactive PATH
  for `mnrevelo`.
- **Permission denied on the docker socket** → `mnrevelo` not in the docker group.
- **`docker context inspect mardale-prod-alt` inside a cxell fails** → expected: a cxell has no
  docker CLI and no `~/.docker` context store. The context is a host-machine fact.

## Do not

- Do not deploy, restart, or stop anything on prod as part of onboarding. Read-only verification only.
- Do not put the Cloudflare Access service token in `~/.ssh/config`. It is not accepted by the
  SSH application and would just sit there as a leaked secret.
- Do not remove the `mardale-prod` context or change its endpoint permanently — the Failover
  section above is the sanctioned temporary re-pointing while the LAN is down; TCP is the
  default and prod should return to it when the route is back.
