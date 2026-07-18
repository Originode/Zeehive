# Zeehive production on machine `local`

What runs containerized on this machine's daemon (docker context `desktop-linux`), what still
runs as a host process, and the sanctioned path to full containerization.

## Live today

| piece | form | why |
|---|---|---|
| `zeehive_web` (:5180) | **container** — built bundle behind nginx ([Dockerfile.web](Dockerfile.web)) | A dashboard is stateless and self-contained; nothing ties it to the host. `/api` (incl. SSE) proxies to the queenzee via `host.docker.internal`. |
| `zeehive_server` (:4700) | **host process** (self-ship restart pattern) | It cuts git worktrees for host agent sessions; a worktree's `.git` stores an absolute `gitdir:` that only resolves on the side that wrote it — a Linux queenzee would mint worktrees host sessions can't open, and the meta-DB carries `D:/` paths throughout. |
| `zeehive_db` (meta-DB) | container on `ugreen-nas` :5445 | Pinned; survives this PC's reboots. |

Deploy / redeploy the dashboard:

```sh
docker --context desktop-linux compose -f docker/zeehive/docker-compose.prod.yml up -d --build web
```

Ships through the gate use [`scripts/ship-zeehive-web.sh`](../../scripts/ship-zeehive-web.sh)
(the `zeehive_web` row's build_script): detached worktree at the approved sha → image build on
the target daemon → `compose up`. Never builds the live working tree.

## The migration to a fully containerized queenzee (agreed 2026-07-18)

Mark has sanctioned moving the **project folders to the Linux side** to dissolve the gitdir
boundary. Staged, each step reversible:

1. **Repos move** — clone OmniBiz + Zeehive onto Linux-native storage (the `zeehive_repos`
   volume, or a WSL distro's ext4). Windows keeps access via `\\wsl.localhost\...` and VS Code
   Remote; it becomes the visitor, not the owner. Bind-mounting `D:\` the other way is NOT the
   plan — 9P git performance and broken inotify are why.
2. **Meta-DB path migration** — worktree_path / repo_root / git_dir rows rewritten `D:/…` →
   `/repos/…` in one audited pass, with the old values kept aside until cutover proves out.
3. **Queenzee container goes live** ([Dockerfile.server](Dockerfile.server), compose profile
   `experimental` → real) — mounts: `zeehive_repos`, the docker socket (TCP contexts reach the
   other daemons as they do today), a logged-in `~/.claude` (or `ANTHROPIC_API_KEY`) for
   spawning zees. Runs against a THROWAWAY meta-DB first: two queenzees reconciling one meta-DB
   reap each other's xells, so the env deliberately has no default `DATABASE_URL`.
4. **Zees move in** — headless zees become in-container `claude` processes (supported: Claude
   Code runs on Linux; Anthropic publishes a devcontainer reference). Losses to design around:
   `claude://` deep links can't open Claude Desktop into a container (those sessions become
   remote/headless), and the session monitor must run where the sessions live.
5. **Cutover** — host queenzee stops, container takes :4700, `zeehive_server`'s row flips from
   process role (`docker_ctx` NULL, URL-probed) to a real container row on `desktop-linux`.
