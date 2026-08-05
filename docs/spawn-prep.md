# The spawn template's dependencies and cache knobs

*Migration 121 · `pool_config.spawn_prep` · `server/src/lib/spawn-prep.js` · Project setup → Pool*

## What this replaces

"What is installed into a fresh xell before its zee starts" used to be **one hard-coded line in the
queenzee** (`lib/cxell.js: warmInstallScript`): `npm ci`, then `npm run build --workspace web`, for
every project of every fleet, forever. Two costs came out of that, and both were paid on **every
single spawn**:

1. **A project that needs anything else had no way to say so.** The standing example is `psql`: a
   zee's own binding hands it `psql "postgresql://…"` and the cage has no psql in it — so every zee
   that wants to look at its own database either works around it or spends part of its turn
   installing one. Same story for a native module that needs `build-essential`, or a project whose
   prebuild is not `--workspace web`.
2. **Nothing about *how* the install ran was tunable per project.** The shared npm cache (ticket #7)
   was a fleet-wide env var: one project could not opt out of it, and no project could opt into
   anything else.

## WHO PAYS: `when`

The prep first landed on the **dispatch** path, and that is where the cost sat: a cxell does not
exist until a zee is spawned, so apt and `npm ci` ran while a human waited for that zee. `when`
moves the work onto the pool's clock instead.

| `when` | the pool does | dispatch does | costs |
|---|---|---|---|
| `dispatch` *(default)* | nothing | apt + npm, in the cage | a human waits for both |
| `image` | bakes the apt packages into a per-recipe image | npm, in the cage | one image per package list |
| `provision` | bakes the image **and** creates + installs each pooled xell's cage | reuses it; installs **nothing** | one live container per pooled xell |

**`provision` in full.** When a pooled xell is provisioned, the queenzee creates its cage on the
prepped image, clones the branch in and runs the whole prep — hours before anyone claims it. It does
**not** mint the identity token, inject the harness, open the attend door or seal the firewall:
those are per-dispatch facts, and they are cheap. At dispatch the cage is **reused** (only if it is
running and on the image we want), the checkout is **updated in place** — `git fetch` + `reset
--hard` rather than `rm -rf` + clone, so the installed `node_modules` survives — and the prep
finds its marker still valid and skips.

**The marker** is `/work/.zeehive-prep.json`, deliberately outside the repo (inside it, it would
show up in the zee's `git status` as junk it did not write). It records the template hash and the
lockfile sha, and reuse requires **all three** of: the marker names this template, the lockfile is
byte-identical, and `node_modules` is still there. Any doubt reinstalls — a wasted `npm ci` costs
a minute; a wrongly skipped one hands the zee a tree that cannot build.

**Every part of it degrades to `dispatch`.** A missing image (dispatch never builds one — that
would put apt back on the critical path), a cage that is gone or on the wrong image, a marker that
does not match, a bake that failed: each falls back to installing in-cage, logged, and nothing about
the spawn breaks. The spawn log tells the two apart — a reused step reads `reused`, not `ok`.

## The shape

```jsonc
pool_config.spawn_prep = {
  "steps": [
    { "key": "npm-deps",  "kind": "npm",     "enabled": true },
    { "key": "web-build", "kind": "npm-run", "enabled": true,
      "script": "build --workspace web", "allow_failure": true },
    { "key": "psql",      "kind": "apt",     "enabled": true, "packages": ["postgresql-client"] },
    { "key": "seed",      "kind": "shell",   "enabled": false, "run": "./scripts/dev-seed.sh" }
  ],
  "when": "dispatch",           // dispatch | image | provision — see above
  "cache": {
    "npm": "shared",             // shared (the fleet volume) | container (cold every time)
    "npm_prefer_offline": false, // skip registry revalidation — measured as no faster off a warm cache
    "npm_omit_dev": false,       // faster, but a zee cannot run the tests
    "apt": "shared"              // a shared apt ARCHIVE volume, mounted only where a step needs it
  }
}
```

`NULL` means **the built-in default**, which is byte-for-byte the behaviour every project had before
121: npm deps + the web prebuild, shared npm cache. A fleet that never opens the editor sees no
change. The API serves the **effective** template (`GET /api/projects/:id/pool-config` →
`spawn_prep`, plus `spawn_prep_custom` and the server-defined `spawn_prep_presets` the console's
"add a step" menu is built from), so no second copy of "what the default is" exists in the console.

## Where each step runs

| kind | runs as | where | fails how |
|---|---|---|---|
| `apt` | **root**, own `docker exec -u 0`, **before** the user half | the cxell | best-effort; the step is named in the log |
| `npm` | `zee` | `/work/repo` | `npm ci`; a genuine failure stops the warm (and says whether it was lock drift) |
| `npm-run` | `zee` | `/work/repo` | `allow_failure` (default true) |
| `shell` | `zee`, or root if `root: true` | `/work/repo` | `allow_failure` (default true) |

Root and non-root are **different scripts** on purpose: apt needs uid 0, and npm must *not* have it
— anything npm writes into `/work/repo` as root is a file the zee cannot commit.

## The three rules the module keeps

1. **Best-effort, always.** A prep step that fails may never fail a dispatch or a provision. A zee
   that has to install something itself is slow; a dispatch that dies because a mirror was down is
   broken.
2. **`npm ci`, never `npm install`, on a tree that has a lockfile.** `install` rewrites
   `package-lock.json`; the pool reads that as a dirty worktree and reaps the xell (the live
   provision→build→reap loop of 2026-07-20), and in a cxell it hands the zee a dirty tree it did not
   dirty. The generated script keeps the marker contract — `WARM_OK`, `WARM_CI_FAILED`,
   `WARM_INSTALL_FAILED`, `WARM_LOCK_DIRTY` — that lets the queenzee tell lock drift from a network
   failure.
3. **Validation happens at the EDIT.** A template that cannot be turned into a script is refused by
   `PATCH /pool-config` in front of the human who wrote it, not at 3am inside a cage nobody is
   watching. An apt package name is validated as a package name, because it ends up in a **root**
   shell.

## Where the time goes (this is the tuning evidence)

Every step prints `PREP_STEP <key> <ok|failed> <seconds>`; the queenzee parses those back and logs
one line per spawn:

```
cxell_<slug>: prep — psql 6s, npm-deps 31s, web-build 12s (49s total)
```

Before this there was one number for the whole warm and "which step costs the minute" was a guess.
A step the template declared `allow_failure` reads as `(optional, skipped)` rather than `FAILED` —
the word FAILED in a spawn log means *go look*, and a prebuild with nothing to build is not that.

## Making a spawn faster — in the order that pays

Measured in a cxell (2026-08-03) against this repo's own `package-lock.json`, `npm ci` only.
Warm/prefer-offline were run ALTERNATING, three times each, against one primed cache; the cold runs
each got a fresh empty cache dir:

| | seconds |
|---|---|
| **cold cache** — what a per-container cache is, on every spawn | 32 · 49 · 22 |
| **warm shared cache** | 14 · 10 · 12 |
| warm shared cache + `--prefer-offline` | 18 · 12 · 12 |
| warm shared cache + `--prefer-offline --omit=dev` | 20 (once) |

One box, shared with whatever else the fleet was doing, so read the warm rows as *the same number*
and the cold row as *2–4× slower and far more variable* (it is network, and the variance is the
registry's mood). That is the whole ranking below: **the cache is the win; the flags are not.**

1. **Keep `cache.npm = shared`.** A per-container cache means every cxell of every project
   re-downloads the same tarballs — the 32s row. This is the only change worth three of the others.
2. **`npm_prefer_offline` is a knob, not a default.** It was written as the default here on the
   plausible story that it "turns a warm cache into a fast spawn"; the measurement did not support
   it (`npm ci` already resolves from the lockfile's pinned URLs and integrity hashes, so there is
   little to revalidate). Turn it on for a partially-warm cache on a slow registry — not on faith.
3. **Turn off steps this project does not need.** A project with no web workspace should not run a
   web prebuild every spawn; the timing line tells you what it costs.
4. **`npm_omit_dev` only if the zees really do not run tests.** It is the fastest install and the
   most likely to be a false economy.
5. **Add `apt` steps deliberately, and leave `cache.apt = shared`.** The first cxell downloads the
   packages; the volume means the next one unpacks them. The apt volume is mounted **only** for a
   template that installs packages, so a project that adds none is byte-for-byte unchanged.

## Known gaps (deliberate, not oversights)

* An apt step runs **per cxell**, every spawn. The archive cache removes the download, not the
  install. A project that installs a lot should get its own cxell image
  (`device.cxell_image` already does this for Android) — the template is the cheap path, not the
  cheapest possible one.
* The steps only run in a **cxell**. The host-side pooled-worktree warm honours the npm step and its
  flags (that is where a pooled xell's `npm ci` happens), but apt/shell steps are container-scoped by
  definition — there is no host to install into.
* Under `when: 'provision'`, a pooled xell holds a **live container** from the moment it is
  provisioned. That is the price of the setting, and it is why the default is not this. A fleet with
  a large pool should count containers before turning it on.
* A pre-warmed cage is prepped for the branch **as it was at provision time**. The pool
  fast-forwards pooled xells, and the dispatch clone reconciles that — but if the lockfile moved,
  the marker no longer matches and the install happens at dispatch after all. Pre-warming pays off
  in proportion to how stable a project's lockfile is.
* `spawn_prep` is **per project**, not per xell. A one-off need is still a zee installing something
  itself; the template is for what every xell of a project needs.
