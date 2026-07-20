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
docker --context desktop-linux compose -f docker/zeehive/docker-compose.prod.yml up -d --build web
```

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
   the `ugreen-nas`/`mardale-prod` TCP contexts from env; `DOCKER_HOST` points the `default`
   context at the mounted socket; volumes for the fleet SSH keypair (`zeehive_ssh`) and prod
   dumps (`zeehive_backups`); `REPOS_DIR=/repos` makes clones land on the repos volume;
   `ZEEHIVE_CAGE_SSH=network` makes the queenzee SSH to cages by container name over
   `zee-cage-net` (the human's `127.0.0.1:<port>` door is unchanged); cages get `ZEEHIVE_API`
   injected from `CAGE_API_BASE`. Container self-ship is `scripts/self-ship-container.sh`
   (sync → build → sibling `docker:cli` recreate) — selected per-site via the container row's
   `build_script`, so host and container eras coexist as data.
3. **Parallel run** — the container (compose profile `experimental`, :4701) against a THROWAWAY
   meta-DB: two queenzees reconciling one meta-DB reap each other's xells, so the env
   deliberately has no default `DATABASE_URL`. Pre-create the cage network once
   (`docker network create zee-cage-net`) — compose joins it as external; normally the first
   `ensureCage` creates it, but the server service now needs it at start. Then: New Project →
   Clone (Zeehive itself, into `/repos`), connect the claude token, dispatch a dummy caged zee
   end-to-end, self-ship on the throwaway instance.
4. **Zees stay caged** — the all-caged runtime is the endgame; credentials come from the
   meta-DB (`provider_token`), so NO `~/.claude` mount is needed for zees. Losses to design
   around: `claude://` deep links can't open Claude Desktop into a container, and host-session
   observability (sessions.js reads of `CLAUDE_HOME`) retires with host zees.
5. **Cutover** — after the zero-xell reset: host queenzee stops, container takes :4700 (drop the
   `experimental` profile, flip the port), projects re-created via the clone flow,
   `zeehive_server`'s row flips from process role (`docker_ctx` NULL, URL-probed) to a real
   container row on `desktop-linux`. Host-zee code paths (local SDK spawn, `claude remote`,
   their monitor passes, hooks/skill host surface) are disabled via `agent_runtime` first,
   deleted in a later cleanup ship.
