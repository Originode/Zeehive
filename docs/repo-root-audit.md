# `config.repoRoot` — is the two-meanings ambiguity still real? (ticket #4)

I raised #4 this morning, in the reflection after the harness fix shipped: `config.repoRoot` carries
two meanings that coincide in a checkout and diverge in a container — **where the server's own code
lives** (`/app` in the image) versus **where a project's files live** (`/repos/Zeehive` on the
volume). Harnesses meant the second and got the first, and that is how manager zees ran for weeks
with no manual.

This is the re-scope after migration 080. **Recommendation up front: close #4 without the rename.**
The reasoning is below, including the two things I would do instead, both small.

## Every current use, classified

29 uses across 13 files. **19 of them resolve a script or asset out of the server's own tree** —
`scripts/*.sh`, `scripts/*.mjs`, `scripts/zee`, `docker/zeehive/zee-live.mjs`,
`docker/zeehive/zee-attach.sh`, `db/migrations/`. For every one of those, "the tree the server is
running from" is *exactly* the right meaning, and `Dockerfile.server` copies each of those
directories into the image. They were correct before 080 and they are correct now.

The other 10 are the interesting ones, and **none of them is the old bug**:

| site | what it means | verdict |
|---|---|---|
| `self-onboard.js:57-61` | "the tree I am running from IS a project — onboard it" (the host era, and a nested queenzee inside a xell worktree) | **CORRECT, and deliberately both meanings at once.** Guarded by `isRepo()`; it is the third fallback, after an existing clone and `ZEEHIVE_SELF_REMOTE`. This is the one place where conflating them is the intent. |
| `db/seed.js:216,229` | seeds the `Zeehive` project row with `repo_root: config.repoRoot` | **CORRECT** — same intent as above, and seed-only (`npm run db:seed`, never a loop). |
| `projects.js:438` | the default *starting directory* of the console's "browse for a repo" dialog (`config.reposDir || config.repoRoot`) | **CORRECT** — a UI convenience, and `reposDir` already wins where it is set. |
| `self-onboard.js:141` | resolves the prod `build_script` for the modeled self-stack and **stores the absolute path in a container row** | **CORRECT but time-bound** — see below. |

**So: there is no current site where `config.repoRoot` is used to mean a project's files and gets the
server's tree instead.** The one that bit — `harness.dir` resolution — is gone: 080 moved every
harness into the meta-DB, `harnesses/` no longer exists in the repo, and house rule 10 forbids
reintroducing it. `lib/harness.js` reads no filesystem at all.

## Which of them fail SILENTLY, which fail loudly

This is the part worth keeping, because the harness bug was dangerous *for its silence*, not for its
wrongness. If a file stopped being copied into the image:

**LOUD — the operation fails and says so:**
- every `spawnSync`/`spawn` of a `scripts/*.sh|mjs` path: `ENOENT`, surfaced as the provision/build/
  land/ship failure it is (`machines.js` throws with the script's own stderr; `build.js` reports the
  failed step on the container row).
- `db/migrate.js` → `readdirSync(db/migrations)` throws at boot, and `index.js` catches it into
  `BOOT MIGRATIONS FAILED (staying up on the schema we have)`. Loud, though it deliberately keeps
  serving — which is the right trade and is stated where it happens.
- the cxell file installs (`scripts/zee`, `zee-live.mjs`, `zee-attach.sh`) — each checks
  `existsSync(src)` first and logs `!!! could not refresh …` naming the consequence ("the cxell keeps
  the CLI baked into its image, which may be OLDER than this queenzee"). Best-effort **with** a loud
  log is the correct stance for these: a stale-but-present CLI beats a failed spawn.

**THE ONE THAT IS QUIETER THAN IT SHOULD BE:**
- `reaper.js:256` — `if (destructive && existsSync(script) && …)`. A missing
  `scripts/despawn-xell.sh` silently drops out of the condition; the xell is retired anyway (its
  containers are still cleaned up best-effort) and the log at line 315 says only **"despawn failed"**,
  with no cause. It is not silent — but it does not name the missing script, so a human reading it
  would look for a docker problem. **This is the only place I would change**, and it is a one-line
  log improvement, not a rename.

**Time-bound rather than silent:** `self-onboard.js:141` bakes today's absolute
`<repoRoot>/scripts/self-ship-container.sh` into a `container.build_script` row. If the queenzee later
moves (host → container, or a different image layout), that stored path is stale — and the ship then
fails at spawn, loudly, on the row a human is looking at. Worth knowing; not a hazard.

## How big is the rename, really

- **29 call sites in 13 files**, plus `config.js` itself. Adding `config.appRoot` as the honest name
  for "the server's own tree" and leaving `repoRoot` as a deprecated alias would be a mechanical
  change to 19 of them.
- **None of it is behaviour.** Every one of the 19 resolves the same absolute path before and after.
- But it touches `provision.js`, `build.js`, `landing.js`, `reaper.js`, `machines.js`, `intake.js`,
  `cxell.js` — the provisioning, landing, shipping and teardown paths. A rename that cannot change
  behaviour still has to be *reviewed* as if it could, in the files where a mistake is most expensive,
  and it would conflict with anything else in flight in them.

## Recommendation

**Close #4 without the rename.** 080 removed the only case where the ambiguity actually bit, no
current site means "a project's files" and gets the server's tree, and the 19 script-resolution sites
are unambiguous in context (`resolve(config.repoRoot, 'scripts', …)` reads as what it is). A 13-file
rename across the provisioning and landing paths, to prevent a class whose one instance is now
structurally impossible, is not worth the review surface it costs.

Two things I would do instead, both cheap:

1. **Name the ambiguity where it lives** — a comment on `config.repoRoot` in `config.js` saying it is
   the SERVER'S OWN TREE, that a project's files are `project.repo_root` and never this, and citing
   the harness bug as the precedent. That is the durable half of the ticket: the next author reaching
   for it learns the distinction at the point of use. *(Done in the same change as this document.)*
2. **Make the reaper's missing-script case name itself** — one logline. Not done here: it is a
   behaviour-adjacent edit in the teardown path and this task is an audit.

If a human wants the rename anyway, the honest scope is: `config.appRoot` added, 19 sites moved,
`repoRoot` kept as an alias for one release, and a re-read of `self-onboard.js` (the deliberate
both-meanings site) to make sure the alias does not make its intent *less* clear than it is now.
