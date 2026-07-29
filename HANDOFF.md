# ZEEHIVE — the rationale of record

> ## ⚠ This is NOT your orientation. [`CLAUDE.md`](CLAUDE.md) is.
>
> **If you are a zee: read [`CLAUDE.md`](CLAUDE.md) and [`README.md`](README.md) first, and your
> own manual at `.zeehive/harness/memory/cxell-zee-manual.md`.** Then come back here for *why*.
>
> This file is **history and reasoning, not instructions.** It was written as a paste-in handover
> for a **host** Claude Code session on one Windows machine, in an earlier era of this repo, and it
> is kept because code comments cite it and because the expensive mistakes recorded here are worth
> not repeating. It is **not maintained as a description of the current system**.
>
> Zees have repeatedly read it as their briefing and gone chasing things that do not exist for
> them — a design doc on somebody's `C:` drive, worktrees under `D:\Repos\…`, `docker --context`
> commands, `/xell` slash-commands, MCP tools that were retired. **A caged zee has none of that**;
> its whole toolset is the `zee` CLI. Treat any drive letter, machine name, docker context or
> container name below as a museum piece.
>
> **Read it for the WHY, take the WHAT from the code.** Where the two disagree, the code is right —
> fix the line here, do not work around it.

Sections are dated where the record is worth keeping. Claims marked **[stale]** are left in place,
struck through in prose, because they explain a decision that is still load-bearing.

## What it is (vocabulary)

- **xource** — the source a xell branches from (the project's local `main_branch`). Read-only to xells.
- **xell** — an isolated env: a git worktree + its own `spinoff/<slug>` branch + assigned
  containers (db/server/webapp). The unit the orchestrator spawns, tracks and tears down.
- **zee** — an agent (a Claude Code session) bound to exactly one xell. The worker. *The product is
  named for the zee, not the xell — hence Zeehive.*
- **queenzee** — the orchestrator. **Pure script, NO AI.** Keeps a pool of ready xells, binds zees,
  monitors, maintains (prod backup), decommissions. Never reads a zee's context or interprets prompts.
- **production** is modeled as a xell too, flagged `is_production` and untouchable by zees.

Core thesis: **provisioning is 100% deterministic and belongs in a script; the AI only does the
actual work, starting from a proven-correct environment.**

## Projects

**[stale — deleted]** This section used to table the two live projects with their `repo_root`
paths, branches and pool targets. It was wrong within days, every time. Projects, paths, branches,
pool targets, container names and couplings are **DATA**: they live in the meta-DB and the API
resolves them live. Read them from the console or the API, never from prose. (The same lesson,
generalised, is house rule #7 in `CLAUDE.md`.)

What is worth keeping from it: **Zeehive orchestrates itself**, and `/xell` resolves the project
from the **invoker's cwd** — there is no default, and an unresolvable cwd refuses rather than
guessing. That guess used to silently hand a session standing in this repo a worktree belonging to
a different project.

## Layout

**Current layout: [`CLAUDE.md` §4](CLAUDE.md).** The copy that used to live here listed migrations
up to `049`, two skills and half of `lib/` — it drifted, as any hand-maintained tree does.

The rule that made it drift is the one to keep: **`db/migrations/` is forward-only and
filename-ordered, so the FOLDER is the truth** and the newest number is the tip. Never enumerate it
in a doc.

## Run it

**[stale]** The meta-DB was on the `ugreen-nas` Docker context when this was written; it was
migrated onto the local daemon on 2026-07-18, and later the whole stack became self-starting from
published images. **For how to run it today see [`README.md`](README.md) (self-start) and
[`docker/zeehive/README.md`](docker/zeehive/README.md) (what runs where in production); to run it
inside a xell see [`CLAUDE.md` §3](CLAUDE.md).**

One detail from here that still matters: `docker-compose.yml` pins `name: zeehive` deliberately —
compose otherwise derives the project name, and therefore the **volume prefix**, from the folder it
is run from, so renaming or moving the repo would make it look for a volume that doesn't exist and
quietly start an **empty meta database**. Do not remove that pin.

Flags: `PROVISION_MODE=real|simulate` · `PROVISION_APP_TIER` (false = worktree only, no NAS
containers) · `POOL_ENABLED` · `POLLER_ENABLED` · `BUILD_MODE=real|simulate` · `ZEE_MODEL`
(default `opus`) · `LAND_MAX_BEHIND` · `MAINTENANCE_MODE`/`MAINTENANCE_ENABLED` (real prod pg_dump).

## What's real vs simulate

- **Real**: provisioning (git worktrees), container health, docker builds, per-xell diffs, the git
  graph, prod backups, the db-attach flags, `claude://resume` deep-links on xell cards, the
  **landing gate** (live on OmniBiz `main` — a real `update` hook that really declines pushes).
- **The hooks STATUS channel is still not installed.** `POST /api/hooks` exists and returns 202, but
  nothing calls it; live session state comes from the **active-session monitor** instead.
  (`hooks/settings.hooks.json` is a template, not something that's running.)
- **But one hook IS installed now**: `PreToolUse → hooks/prod-guard.mjs`, registered in
  `~/.claude/settings.json` (see "Shipping"). Verified firing on a live session via a canary —
  no restart needed, the harness file-watches settings.json.
- **Provisioning is `simulate` by default in code** — Mark always runs `real`.

## House rules (learned the hard way — do not relearn them)

1. **No test data.** `seed_demo.js` exists; never run it. Mark: *"no more test data."*
2. **Never touch a xell you did not create.** Reap/tear down **only** dummies you spawned,
   targeted **by explicit slug or id** — never "the first card", never a `ready` xell (Mark
   commissions those too). A past session reaped his live DTR zee mid-task and lost real work.
3. **`origin` is off-limits to zees** — they land with `git push . HEAD:main`, never to origin.
   That push is now **HELD by a git hook on the xource** until a human approves it in the console
   (see "Landing gate"). A zee landing on main unannounced is what the gate exists to stop.
4. **A human marks a xell done**, not the zee. `/xell-done` typed by a human IS the confirmation.
5. **Builds go through the queenzee** (`build.*` in the binding), never ad-hoc `docker compose`.
6. **`db-shared-prod` is LIVE production data** — never a default, must be asked for.

## Landing gate (a push to main is a REQUEST)

Added 2026-07-15, after `mardale-dtr-payroll` put its work on OmniBiz `main` with nobody told.
"Land locally: `git push . HEAD:main`" was only ever an *instruction* in the zee's prompt — nothing
enforced it and nothing announced it. The queenzee can't police that from outside: by the time its
poller sees the new tip, main has already moved. So the gate lives in git itself.

- **`update` hook on the xource** (`hooks/land-gate-update.sh`, installed by
  `scripts/install-land-gate.sh`) fires on every push to `main_branch`, asks
  `POST /api/land/check`, and **declines unless a human already approved that exact sha**.
- **FAILS CLOSED** — queenzee unreachable = no landing. Deliberate: the server being down is
  exactly when a silent landing would go unnoticed. (Opposite stance to the sibling
  `reference-transaction` hook, which guards ordinary local work and must never wedge it.)
  That sibling hook (machine-local, OmniBiz `.git/hooks/reference-transaction`, NOT
  version-controlled anywhere) was amended 2026-07-16: `refs/heads/spinoff/*` is EXEMPT from its
  non-fast-forward guard, so a zee may `git rebase main` its own workspace branch when main has
  drifted too far to merge sanely. Everything else keeps the hard guard — verified both ways with
  dummy branches. If that hook is ever reinstalled from scratch, re-add the exemption or zees
  lose rebase.
- Fires **only on push**, and only for `main_branch`. Committing/merging on main directly (Mark
  working normally) is untouched, and a queenzee outage can never block a non-main push.
- Approval is bound to the **exact sha** a human read; it is **spent on use**. Amend/rebase → new
  sha → new decision. Approve → the zee re-runs the **same** push and it goes through.
- **A landing that main moved past is STALE, and the zee is TOLD** (added 2026-07-29,
  `landgate.js → closeAsStale` + `nudge.js → nudgeXellForStaleLanding`). Binding an approval to one
  sha means another xell landing first kills it: it can never fast-forward. That was already
  recorded honestly (row → `stale`, log line, pad receipt) and told **nobody** — a cxell zee's turn
  ends at `zee land`, so it sat waiting on a decision that had already become impossible. Now
  closing the row **resumes the zee's session** with the only recovery that works from inside a
  cage: `zee sync` (merge current main in — `git fetch`/`git rebase main` cannot work there) then
  `zee land` again for a fresh decision on a landable sha. No live cxell to reach → a **tend** is
  raised instead, so it reaches a human. The reason, and whether the zee was actually nudged, is
  written to `land_request.note` (shown on the pad receipt).
  - **Held** requests are swept too (`sweepStalePending`, on the 10s land-reaper tick): a pending
    card main has already moved past is a human being asked to approve something with no possible
    outcome. Only a **proven non-fast-forward** is closed; a sha the ref already contains is left
    alone for a human.
  - A row leaving `pending` needs a decider (009's `land_decided_has_decider` check), and nobody
    decided this one — it is recorded as `queenzee@stale`, never a human's name.
  - Both waiters (`scripts/zee`, `scripts/xell-land.mjs`) exit on `stale` with the same
    sync-then-land instruction. `xell-land.mjs` had **no** stale case and burned its full hour
    timeout on a dead landing.
  - Test: `node test/land-stale-nudge.test.mjs` (real git repos + throwaway postgres; the fake
    `docker` in `test/_bin` captures the resume prompt).
- Console: held landings render **above everything** (`web/src/Landing.jsx`) with the commit list
  + diffstat and Approve/Reject. A T-Keyboard ping fires too (`lib/notify.js`, `TKB_NOTIFY=0` to
  mute) — a held push blocks a zee, so it must reach you off-screen.
- **Zees checkpoint-commit freely** on their own branch — a commit only moves their branch ref and
  lands nothing, so the prompt now tells them to commit early and often rather than hoard
  uncommitted work while waiting on approval. Only the *push* is gated.
- **A zee can WITHDRAW its own held landing** (2026-07-29, 061–063). Every other ask a zee raises
  can be lowered by the zee that raised it (`zee tend --clear`, `zee hint-land --clear`, `zee done
  --clear`); a land request could not, so a zee that changed its mind pushed again and left a second
  card for the same job. `zee land --withdraw [--reason]` → `POST /api/xell/self/land/withdraw`:
  status `withdrawn` (terminal, with `withdrawn_at/by/reason` — never `decided_by`, because nobody
  decided anything), the row drops out of every open read model, main never moves and the commits
  stay on the branch. **Pending only**: an approved request is a human's decision the queenzee is
  acting on, and retracting it is not an agent's call (`zee tend` is). Scoped to `kind='push'`, so it
  never sweeps up a PR. The console has the same quiet exit beside Reject (Reject *burns* the sha;
  Withdraw decides nothing), and the pad keeps a brief "withdrawn by zee" receipt.
  - The DISCIPLINE that goes with it, taught in the manual (062) and the spawn briefing: **one open
    landing per zee** — withdraw the previous one *before* landing again. `zee land` now names the
    older open requests it just superseded, and `zee status` carries `landing.open`, so the zee sees
    its own stack instead of a human discovering it. Test: `node test/land-withdraw.test.mjs`.
- **ONE RUNWAY PER REF — the rest fly a HOLDING PATTERN** (2026-07-29, 067–068). One open landing per
  zee was only half the problem: two *different* zees finishing together both pushed, so a human got
  TWO cards for one ref. Approving either moved the ref, and the other could never fast-forward — it
  was swept `stale` and its zee sent back to `zee sync`. A human was asked to decide something that
  already had no outcome. Three zees made it three cards and two go-arounds.
  - A push that arrives while **another xell's** landing is open on that ref is no longer raised as a
    second card: it enters the pattern as `holding` — recorded, with a POSITION, never in front of a
    human. `checkPush → runwayOccupant()` is the whole decision.
  - When the runway frees (**landed, rejected, withdrawn or stale — all four**), `clearRunway()`
    calls the next holder: a session resume (`nudge.js → CLEARED_PROMPT`) naming `zee sync` then
    `zee land`. Clearance is a NUDGE, never an approval — the zee re-pushes and *that* raises the card.
  - **The human gate did not move**, and 068 is where that is made true rather than promised: a
    trigger refuses `holding → approved/landed` outright (any code path, any hand-run UPDATE), a
    holding row cannot carry a decider/`landed_at`, PRs cannot enter the pattern, and one live
    holding row per sha. 009's `land_decided_has_decider` is *widened* the way 062 did for
    `withdrawn`; its partial indexes on `status IN ('pending','approved')` are untouched — a holder
    sitting **outside** them is exactly what keeps it off `/api/land/requests`, the pad, and
    `land_pending`.
  - Position is **counted at read time**, never stored: a stored number goes stale the moment a
    holder leaves, and "you are #3" when two ahead have withdrawn is how a zee gives up.
  - **Never auto-lands, never merges, never rebases from the queenzee side.** `auto_approve_land`
    lands on arrival, so the runway is never occupied and the queue is a no-op in that mode.
  - Nobody home → a **tend** on that xell and the NEXT in line is cleared, so one dead zee cannot
    keep the runway empty. A reaped xell's holding row is swept (`sweepHoldingPattern`), and the land
    reaper tick re-drives every runway as the backstop for a missed clearance.
  - Both waiters print the position and **exit** — waiting would burn the full timeout on a card no
    human will ever see, which is exactly how `xell-land.mjs` used to fail on `stale`.
  - **The git hook needed its own branch** — found by pushing for real, not by reading it: with no
    `holding` case it fell through to "LANDING HELD — a human must verify this… tell your human the
    landing is waiting in the console", every word of which is false for a queued push. It now says
    HOLDING PATTERN, names the go-around, and the test asserts those bytes through a real push.
  - Test: `node test/land-queue.test.mjs` (two xells, one card; clearance on land/reject/withdraw/
    stale; the no-cxell go-around; the retired-xell sweep; auto-approve as a no-op).
  - **The human surface, one task later** (069–072): the console renders the APPROACH QUEUE under the
    card holding it up — slug, position, commits waiting — with no buttons, because only one thing on
    a runway is ever a question, and it survives the card being collapsed (which is when it matters
    most). A queued zee gets its own hexagon, `occ-landHolding` (`holding`, cool slate), ranked
    **below every ask** — a tend behind a queued landing is still the thing to act on — and **above
    plain activity**, because it is the only thing that answers "why has this zee gone quiet with
    commits it wants to land?". Holders whose runway has no card render in the orphan panel, loudly:
    that should be impossible, and if it happens those zees were about to be invisible again.
    - The manual is taught by MIGRATION (069/070, the 065 pattern), because the manual a zee reads
      lives in the meta-DB: holding is normal, nothing was rejected, no human has been asked, you
      will be resumed, and the recovery is `zee sync` → `zee land`. It also heads off the three
      wrong reactions (re-push, tend, withdraw-and-re-land) — a state a zee meets first in an
      unexpected answer is a state it will improvise around.
    - Test: `node test/land-queue-console.test.mjs` RENDERS the real component with
      `react-dom/server` rather than grepping it, so what is asserted is the markup a human reads.
  - **`tend-or-land.md` was seeded at last** (071/072, ticket #3). That hygiene note existed only
    because a human typed it into the harness manager — it was in NO migration, so on any database
    that has only ever seen migrations it was absent, three assertions in `land-withdraw` failed, and
    "is the suite green?" had no answer. Every cxell database is exactly that. 071 seeds it in full
    (the human's words verbatim) when absent; 072 appends the holding half to databases that already
    had it; both paths converge on identical text. Proved by migrating a virgin database and running
    the landgate suite against it — which is the only way this class of bug is ever actually fixed.
- The xell card therefore shows **two** diffs (`lib/git.js → worktreeDiff`):
  - **source diff** = worktree vs the source (`↑ahead ↓behind · files +ins/−del`, includes
    uncommitted) — everything the zee has produced; what would land.
  - **diff** = worktree vs its OWN HEAD (`own`) — work not yet checkpointed. Drops to 0 on every
    checkpoint while source diff persists. `●N` = dirty files incl. untracked.
- **Every one of those diffstats is CLICKABLE** (added 2026-07-28, `web/src/DiffViewer.jsx` +
  `server/src/lib/diffview.js`): the numbers open the **patch** they are counting. A landing was
  the case that mattered — you were asked to approve a push with only a commit list and a line
  count to go on, and the actual change lived in a terminal on the host that the console user does
  not have. Clickable in four places: the xell card's two stats, the hive flower's two diff petals
  (drawn underlined — a canvas has no cursor to discover), a held **landing**, and a **PR** card.
  - `GET /api/xells/:id/diff?kind=source|own` · `GET /api/land/requests/:id/diff` — read-only.
  - A landing/PR is read at exactly `old_sha..new_sha` in the xource (the range being approved).
    A live xell is read from the same place its STAT came from — the **cxell** for a cxelld zee
    (where the work is until it lands), else the worktree — so viewer and card cannot disagree.
  - **Untracked files are synthesised in**: `git diff` cannot see a file git was never told about,
    and "the zee just wrote five new files and hasn't committed" is exactly when this is opened.
  - Capped three ways (whole payload / per file / file count) and every cap is *reported* on the
    card, never silently applied. Test: `node test/diff-viewer.test.mjs`.
- **Installation is per machine, because `.git/hooks` is.** ~~Installed for OmniBiz only; Zeehive's
  own repo is NOT gated yet~~ — **[superseded]**: onboarding a project by CLONE now installs the
  gate itself (`lib/projects.js` runs `scripts/install-land-gate.sh` best-effort, and reports a
  warning rather than rolling back if it fails), and that includes ZEEHIVE's own self-onboard.
  Onboarding an existing FOLDER still leaves it manual. The underlying fact is unchanged and is why
  the installer exists: `.git/hooks` is machine-local and not version-controlled, so the gate does
  **not** travel with a clone — re-run the installer per machine, and after any `main_branch` change
  (the protected ref is baked in).
  - status: `bash scripts/install-land-gate.sh --status <repo path>`
  - override (human, on purpose): `git -c core.hooksPath=/dev/null push . HEAD:main`

## Shipping to production (the zee asks; the QUEENZEE ships)

Added 2026-07-15. Prod used to be zee-driven: the zee grabbed the lock (MCP
`zeehive_prod_lock_acquire`) and deployed by hand, ungated. That ships **band-aids** — live in
prod, absent from main, silently reverted by the next rebuild from main.

- **`scripts/xell-ship.mjs <xell_id> --reason "..." [--wait]`** is a zee's ONLY prod verb. It may
  only ASK. It never holds the lock, never runs a prod build, never releases anything.
- **A ship is REFUSED unless the work is already landed on main** (clean tree, 0 ahead). Prod
  builds from the **xource at main**, so unlanded work would not be in the ship. This is what makes
  band-aids impossible by construction rather than by rule.
- **Human approves** in the console → the **queenzee** takes the prod lock and runs each prod
  container's OWN build script. `--wait` (in the background) exits when it's shipped/failed → nudge.
- **Per-container build scripts are DB fields**, not hardcoded: `container.build_script` +
  `build_exec` (010). Contract: `<build_exec> <build_script> <source_path> <role> <ctx> <mode>` →
  one JSON line `{"ok":…,"head":…}` (same as build-container.sh, so one projector reads both).
  Seeded for prod server+webapp → `scripts/ship-prod.sh`. db/infra are deliberately NOT shippable
  (swapping the prod postgres image is a coordinated infra change, never a side effect of a ship).
- **`SHIP_MODE=simulate`** prints the docker commands and ships nothing — how the pipeline was
  verified end-to-end. **Default is now `real`.** `ship-prod.sh` runs
  `docker --context mardale-prod compose -f docker-compose.prodsrc.yml build/up -d <svc>`.
  ⚠ THE REAL COMMAND HAS NEVER RUN. Everything around it is verified; the deploy itself is
  modelled on build-container.sh + the prodsrc stack. Read it before the first real ship.
- **ENFORCED by a `PreToolUse` hook** (`hooks/prod-guard.mjs`, registered in
  `~/.claude/settings.json`). The prompt version of this rule FAILED in the wild: a zee ran
  `/spin:deploy-guard` and then `docker --context mardale-prod compose build webapp` by hand —
  and, because it built without `up -d`, left a fresh image that nothing ran while reporting
  success. Prod stayed on the old image. Prompts don't bind an already-running session, and
  `defaultMode: bypassPermissions` means nothing prompts. So:
  - Denies Bash that MUTATES prod (prod context / prodsrc / `*_prod` names + a mutating verb)
    **only when cwd is inside `.claude/worktrees/`** — i.e. zees. Mark's own sessions are untouched.
  - Read-only docker against prod (ps/logs/inspect/images) stays ALLOWED — a zee verifying a ship
    should be able to look.
  - Fails OPEN only on a malformed payload (it sees every Bash call on this machine; a crash must
    not wedge the tool). No network dependency, so there is no "gate unreachable" case.
  - Not adversary-proof: a determined zee could obfuscate the command. It stops instruction-
    following and accident, which is what actually happened.
  - Debug: `ZEEHIVE_HOOK_TRACE=<file>` logs every invocation. Verified live via a canary.
- **`/spin:deploy-guard` is a SECOND, file-based lock** (`.git/spin-deploy-locks`) that the
  queenzee cannot see — they disagreed in the wild (file lock "deploying", DB lock "free"). All
  three copies of that skill now refuse for xells and point at the ship flow. The two plugin copies
  (`~/.claude/plugins/{cache,marketplaces}/...`) can be clobbered by a plugin update — the hook is
  the real enforcement, the skill text is only a courtesy.
- **The old zee-driven lock path is retired**: MCP `zeehive_prod_lock_acquire/release` are gone
  (replaced by `zeehive_ship_request` / `zeehive_ship_status`), and `POST /api/prod-lock/{acquire,
  release}` now answer 409 pointing at the ship flow. Read-only `GET /api/prod-lock` still works.
- **The lock auto-releases after `SHIP_LOCK_RELEASE_SEC` (default 180s)** — silence must mean "let
  it go", or an unattended hold blocks every other xell. The console shows a countdown + **Hold**
  (stops the clock for a human who is verifying). A **padlock** sits on the holding xell's card:
  hover → 🔓, click → confirm → force release. Reaper tick: 5s; it also starts any approved ship
  that was waiting for prod to free up.

## Prod DATA asks: `zee seed` (new) and the prod-bind request that nobody could see

Added 2026-07-28. Code reaching prod has had a gate since the ship flow; **data** reaching prod had
half of one. Two concrete holes, one fix each:

- **`zee prod` was a dead end.** It wrote a `prod_bind_request` row (029) and logged a line — and
  **nothing in the console ever rendered it**: no hive status, no card, no panel, no ping. A zee
  could ask for production and simply never be answered. Now: `occ-prodRequest` (`prod?`) on the
  hexagon, the request on the asking xell's chip in the "waiting on you" bar with
  **Reject / Bind to PROD** (typed `BIND` confirmation — it hands a running agent the live db), a
  `ProdAsksPanel` for asks whose xell is gone, and a T-Keyboard ping. `fleet.prod_bind` carries it.
- **A shipment that needs ROWS in prod had only that sledgehammer.** `server/sql/ops/` rides the
  ship (014), but it is decided *before* the containers rebuild and only for files already in the
  approved commit; seeding that must happen *after* the new code is live, or that is only discovered
  once prod serves it, had no path except binding the whole database. So: **`zee seed`**.

**`zee seed --file server/sql/seeds/<name>.sql --reason "…"`** (`prod_seed_request`, migration 049;
`queenzee/seedgate.js`) is the ship gate's division of labour applied to data:

- zee **asks**, naming files that are **already on main**; human **approves**, with the exact SQL
  (read at the request's own sha) in view; **queenzee runs it** against the production database.
  The zee never touches prod and cannot approve its own ask. `POST /api/xell/self/seed-request`.
- **Only `server/sql/seeds/*.sql`** — the whitelist is what stops "approve" ever meaning "run any
  file in the repo on prod". `normalizeSeedPath` accepts shorthands (`x.sql`, `seeds/x.sql`) and
  refuses everything outside, including traversal.
- **Unlanded → refused**, because the queenzee reads the file with `git show <main-tip>:<file>`.
  Same anti-band-aid rule as a ship, and it makes "what ran on prod" always readable in the repo.
- **Not ledgered, deliberately** — a migration runs once, a seed is legitimately re-runnable. The
  contract is idempotent SQL, and the console surfaces **every prior run of the same file** so a
  repeat is a decision rather than a surprise (`priorRuns`).
- Before writing anything it re-proves the target with `assertProdDbTarget` (the same guard that
  stopped a ship migrating a 7.7 MB dev clone), and it **refuses while the prod lock is held** —
  a seed must not write data underneath a half-swapped container. Each file runs in its own
  transaction; the first failure stops the run and lands on the row as `failed` + reason.
- **`SEED_MODE=simulate`** runs nothing and records `mode: simulate` (mirrors `SHIP_MODE`) — how
  `test/prod-seed-gate.test.mjs` exercises the whole path against a throwaway project.
  ⚠ Like the first prod ship, **the real psql has never run against a live prod db** — everything
  around it is verified, and it reuses shipmigrate's `psql`/`prodDb`, but read it before the first
  real seed.
- Receipts **outlive the xell** (`xell_id ON DELETE SET NULL` + a stamped `xell_slug`): a record of
  something that touched production does not get reaped with a throwaway worktree.
- Hive: `occ-seedRequest` (`seed?`). Human API: `GET /api/prod-seed/requests`,
  `…/:id/sql`, `…/:id/(approve|reject)`, `…/:id/dismiss`, plus `POST /api/xells/:id/seed` for an
  operator filing one on a zee's behalf (still only a request).

Tests: `test/prod-seed-gate.test.mjs` (DB integration: refusals, approve→run, lock-held failure,
real-mode refusal, receipts, and the fleet read model) and `test/prod-asks-console.test.mjs`
(static: hive-status ↔ web palette lockstep, App renders the cards, NeedsYouBar counts the asks).

## MANAGER ZEES — the fleet's middle layer (052/053/054)

Added 2026-07-28. Every zee was a worker and every decision above a worker was a human's — fine for a
handful of xells, useless once "which of these twelve needs me?" is itself a job. A **manager zee** is
a xell (`xell.role='manager'`) whose zee runs a CREW. Full write-up: [docs/manager-zees.md](docs/manager-zees.md).

- **TYPE and HARNESS are two axes (054).** `xell.zee_type` (worker|manager) is what the queenzee
  lets a zee do; a HARNESS declares the type it is for (`harness.zee_type`, from `zee_type:` in
  HARNESS.yml) and a xell may only wear one of its own type — because a harness IS that type's
  manual. Enforced by triggers from both directions: no mismatched assign, no retyping a xell out
  from under its harness, no retyping a harness while it is worn, no cross-type inheritance (a
  manager harness parented on Zee Base would teach it `zee land`). `GET /api/harnesses?zee_type=…`
  is what every picker asks for; the harness manager has a **For zee type** selector.
  ⚠ 054 RENAMED `xell.role` → `xell.zee_type` (role already means db/server/webapp on container).
- **It gains fleet reach**: `zee dispatch` (every worker it spawns is stamped `manager_xell_id`),
  `zee zees` (the crew read model), `zee say` (typed into the worker's LIVE session, same SSH
  send-keys path as the console's 📨), `zee inbox`, `zee suggest-done`.
- **It loses repo reach — structurally, in three independent places.** `landgate.checkPush` declines a
  manager's push and raises **NO land_request** (nothing for a human to approve); `xellgit.ctx()` —
  the single door every git write verb passes through — throws; `zee land` refuses with the reason
  and the alternative. A manager writes no code: it dispatches a worker, and the worker lands.
- **Production is READ-ONLY**: its own `zee_ro_<slug>` role, `CONNECT`+`SELECT`,
  `default_transaction_read_only=on`, no CREATE, minted by `lib/prod-readonly.js` and dropped by the
  reaper. `db_coupling='db-prod-readonly'` (052). **Fails closed** — if the role can't be minted the
  bind fails; there is no fallback to the owner credential. `PRODRO_MODE=simulate` (inherits
  `SHIP_MODE`) mints nothing. ⚠ Like the first prod ship and the first seed, **the real CREATE ROLE
  has never run against a live prod db** — read it before the first real manager on prod.
- **Shipping is NOT blocked.** Holding prod data is no reason to withhold the ship gate; `zee ship` is
  unchanged (landed-only, human-approved, queenzee-run).
- **`zee prod` is refused for a manager** — escalating your own access is not an agent's ask.
- **Humans add managers, unlimited** (`POST /api/managers`, the "⬢ + manager zee" button). `zee
  dispatch` refuses `role=manager`, the manager harness on a worker, and any db choice at all.
- **Done suggestions**: `done_suggestion` (052) → `occ-doneSuggest` (`done?`) on the TARGET's hexagon,
  a card in "waiting on you", a typed **DONE** confirmation, then the same `markTaskDone`/reap the
  console's own button runs. No `/xell/self/` route decides one.
- **The REFLECTION stage**: on a successful ship, `shipgate` re-invokes the shipping zee
  (`nudge.nudgeXellForReflection`) to review what went live and report improvements/errors/follow-ups
  to its manager (`zee report --kind reflection`) — or to the console when it has no manager.
- **The loophole rule cuts both ways.** The manager manual forbids dispatching a worker with reach
  beyond its own xell; the WORKER manual (053) tells workers to REFUSE such an instruction and
  `zee tend` it. Neither side polices itself.
- **Honeycomb**: `seatXells()` (web/src/hive/HiveCanvas.jsx) seats a crew in the free cells nearest
  its manager, ring by ring. No managers → byte-for-byte the old layout.
- **A manager's harness takes NO cell of its own** (2026-07-29). The manager hexagon is already drawn
  in the harness badge's language (dashed seat + the same persona disc), so seating its harness beside
  it drew the same avatar twice. `getTimeline()` now emits two lists per harness: `wearer_ids`
  (everyone wearing it, managers included → persona art, `×N`, hover) and `consumer_ids` (wearers
  MINUS managers → the grid cell + the series wire). A harness worn by managers only is still in the
  payload — the manager hexagon reads its art from it — but `badgedHarnesses()` seats no cell for it
  and `Connectors` routes no wire. Workers are unchanged (in both lists).
  Test: `node test/harness-manager-cell.test.mjs`.
- **A file-backed harness lives in the ZEEHIVE PROJECT's repo, not in the server image**
  (2026-07-29, ticket #1 — "manager zee has no manual at all"). `harness.dir` ('harnesses/manager')
  is relative to `project.repo_root` (the clone self-onboard registers), NOT to `config.repoRoot`,
  which is only where the running server's code sits. On a checkout they are the same folder — which
  is why every test passed while the DEPLOYED queenzee shipped manager zees with an EMPTY harness:
  `Dockerfile.server` copies `server/ scripts/ db/ hooks/ skill/` and deliberately **not**
  `harnesses/` (one copy of the files, in the repo the DB row projects — same reasoning as the single
  copy of `scripts/zee`), so `/app` had no harness folders and `refreshHarnesses()` kept the empty
  seed bundle. `GET /api/harnesses/manager/full` returned `""` for persona, summary, glyph, and no
  skills or memory at all. Fixed in `lib/harness.js`: ONE resolution (`harnessRoots()` /
  `harnessBase()` — project repo roots first, self project first, `config.repoRoot` always last and
  never absent) shared by `loadHarnessDir()`, its hash re-read, `dirHeadCommit()`, the avatar
  (`harnessAvatarFile()`, which `GET /api/harnesses/:key/avatar` now calls) and the read models. A
  root only wins if the folder is actually there, so a stale `repo_root` falls through instead of
  blanking a harness. **Do NOT "fix" this by COPYing `harnesses/` into the image** — a second copy
  drifts from the repo the row claims to project.
  And it is no longer SILENT: an unreadable folder still keeps its last good bundle, but logs
  `FOLDER MISSING` (queenzee log + stdout) naming the key, the roots searched and how many live
  xells wear it, and `GET /api/harnesses` / `…/full` carry `files_missing` + `bundle_empty` so a
  harness that briefs a zee with nothing is visible instead of looking healthy.
  Test: `node test/harness-repo-root.test.mjs` (reproduces the container: a `config.repoRoot` with
  no `harnesses/` + a project `repo_root` that has them).
- **An unloaded harness is impossible to miss** (2026-07-29, the follow-up to the above). Two halves:
  (1) `refreshHarnesses()` ends with ONE summary line — `harnesses: 3 loaded, 1 EMPTY — <keys> · N
  live xell(s) are wearing an EMPTY harness` — logged always, `console.error` when any are empty
  (`logHarnessSummary()` is exported and callable on its own). The per-harness loglines were each
  true and each easy to miss; a boot is not clean if a zee's persona is a blank page.
  (2) The console SAYS it, in words: `web/src/harnessHealth.js` (`emptyWarning()`) is the one place
  `files_missing`/`bundle_empty` become `⚠ no files` / `⚠ empty`, used by the harness manager
  (`HarnessRow` + `HarnessEmptyBanner`, both exported so they can be RENDERED in a test), the
  dispatch picker (where a human chooses what a zee will wear), and the honeycomb —
  `harnessWarning()` in HiveCanvas writes the word under the badge in place of `×N`, and rings +
  labels a MANAGER hexagon, which IS its persona. `getTimeline()` carries the two fields for that.
  Colour is reinforcement; the WORD is the signal (same rule as the feed chips).
  Test: `node test/harness-empty-visible.test.mjs` — the boot line against real rows, plus the real
  components rendered (react-dom/server) and the real canvas functions DRAWN against a recording
  2D context, so a regex over the source can't fake it.
- **INJECTED artefacts are not source: nothing under `.zeehive/` is tracked** (2026-07-29, ticket #6).
  `.gitignore` has ignored `.zeehive/` since it was first swept into a commit, but ignore rules do
  not apply to a file already in the index — and `.zeehive/harness/memory/cxell-zee-manual.md` was.
  So every cxell's injected copy read as a modification to a tracked file: two zees wrote commits
  whose only purpose was undoing it (7c00642, cad07a8), one swept it in (28ff5c3), and one hit it as
  a merge CONFLICT mid-land. The version that had not happened yet is the bad one — a zee lands its
  injected copy and silently overwrites the repo's manual with a stale injection. `git rm --cached`
  now makes the ignore rule bite; the file stays on disk, injected per xell, and a fresh injection
  leaves `git status` clean. **Never re-add it, and never `git add -f` anything under `.zeehive/`
  or `.claude/`.**
  The manual's home is the META DB (harness `zee-base`, memory `cxell-zee-manual.md`, seeded by 047
  and amended by 050/053/056/063/065 — every edit is a migration). There is **no `docs/cxell-zee-manual.md`**
  and there must not be: a file copy drifts from the row the next migration lands, exactly as the
  duplicated `scripts/zee` did. The four references that still pointed at that dead path
  (`docs/harness-proposal.md`, `docs/schema-catchup-plan.md`, `harnesses/core/HARNESS.yml`,
  `lib/harness.js`) now say where it actually lives; 046's comment carries a SUPERSEDED-BY-047 note
  rather than being rewritten (an applied migration is a record, not a document).
- Test: `test/manager-zee.test.mjs` (55 assertions: guard trigger, the three push refusals, crew,
  messages, done suggestions incl. the human decision, the read-only SQL, the manual). Verified live
  over HTTP with the real `zee` CLI: crew listing, say/report/inbox, suggest-done → human approve →
  the target xell went `retired`.

## Hotfix / data-manipulation xells (prod DATA is not prod CODE)

**Read the MCP tools or the API.** Container names, bindings, couplings and status are DATA: they
live in the database and the API resolves them from live docker state on every call. Nothing here
restates them — a name written into a doc is stale the next rebuild, and the last one sent zees at
an exited husk for weeks.

A xell dispatched with **`--db shared-prod`** has `db_coupling='db-shared-prod'`: the live production
database IS its assigned container. Querying it is the job, not a violation — "use ONLY your
assigned containers" is *satisfied*, because a human deliberately gave it that one. A LIVE xell can
be re-pointed the same way after the fact (`lib/xell-prod.js`), and a zee can now **ask** for that
(`zee prod` → `prod_bind_request`) and actually be answered — see the section above. Before reaching
for a bind, check whether the job is really "rows into prod": that is `zee seed`, and it costs the
zee no prod access at all.

⚠ The flag value is **`shared-prod`**, not `prod`. Dispatch prefixes it with `db-`
(`xell-dispatch.mjs`), so `--db prod` → `db-prod`, which is not a mode. This doc and the prod
guard both said `--db prod` for a while, and `attachXellDb` silently fell back to **dev** on an
unknown coupling — so following the instructions attached the dev db, the guard then denied the
zee and repeated the same broken advice. Unrecognized couplings now throw.

- **The prod guard allows it for that xell only.** `hooks/prod-guard.mjs` asks
  `GET /api/xell/db-access?cwd=…`; the queenzee resolves the xell by worktree path and answers
  whether the prod DB is *its* database. Allowed: `exec`/`cp` against **its own** db container.
  Still denied for everyone: prod code deploys (compose build/up, prodsrc), exec into any other
  prod container, and `restart` of anything — including its own db (that's ops, not data work).
  Gate unreachable → fail closed.
- **Writes are prompt-gated only** (deliberate, for now): read freely; before any write/migration,
  state exactly what it will change and get a human to agree. Unlike landing/shipping there is no
  enforcement here — an UPDATE has no gate. If a zee abuses it, the next step is a data-change
  request approved in the console and executed by the queenzee (mirroring the ship gate).
- ⚠ A hook that CRASHES fails open **silently**. An early version called `decline()` (copied from
  the sibling shell hook, undefined in the .mjs) and threw a ReferenceError — which let a dev-db
  xell straight through to prod. Every branch must call `deny()`. Re-run the canary after editing.

## Schema-work xells: db-clone (the shared dev db's schema is FROZEN)

Added 2026-07-17. Every xell shared ONE dev database, and the /ooney **schema gate diffs the
xell's catalog against prod** — so two xells doing DDL each tripped the other's ship: A's unlanded
migration is not at main's tip, so B's gate read A's tables as unexplained drift. Shared catalog =
shared blame; no gate can attribute it. The fix is attribution by isolation:

- **`db-clone`** (`db_coupling` value, migration 018): the xell gets its **own DATABASE inside the
  shared dev postgres** — `CREATE DATABASE zee_<slug> TEMPLATE <db>_zeehive_tpl`, a file-level
  copy in seconds, zero extra containers.
- **Databases inside a container are FIRST-CLASS: `db_instance` (migration 019).** A db container
  CONTAINS instances — `primary` (the application db), `template`, a `clone` per schema-work xell,
  `other` for strays. One row per database, `UNIQUE (container_id, name)`; a clone carries
  `owner_xell_id` (ON DELETE **SET NULL**, so a drop-failed clone outlives its xell as a visible
  **orphan** instead of vanishing). Everything that used to read `xell.clone_db_name` /
  `container.clone_tpl_at` (both dropped in 019) resolves through `lib/db-instances.js` now.
  **Per-instance `prod_diff`** lives on the row; `container.prod_diff` = the PRIMARY's verdict
  (mirrored, so the chip and the instance can never disagree).
- **DISCOVERY**: the proddiff tick reconciles `db_instance` with `pg_database` per container —
  upserts what appeared, deletes what's gone, names orphaned clones out loud. `pg_database` is
  ground truth; the table follows it. Surfaced: the container chip tooltip lists its databases
  (kind, owning xell, drift), `GET /api/containers/:id/instances` for machines.
- **The template** (`<db>_zeehive_tpl`) is rebuilt from the live dev db via in-container
  `pg_dump|psql` when its instance row's `refreshed_at` is older than `CLONE_TPL_MAX_AGE_MS`
  (6 h default) — slow is fine, it's not on the clone path. Kept `datallowconn=false` so a
  template copy can never be blocked by a connection. (`CREATE DATABASE … TEMPLATE` refuses a
  source with live connections — that is WHY the template exists; the live dev db can never be
  cloned directly.)
- **AUTO-ATTACHED**: `queenzee/dbclone.js` (60 s tick, `DBCLONE_ENABLED=false` to stop) scans
  claimed `db-shared-dev` xells for migration files on their branch (`server/sql/migrations|ops`,
  committed or dirty) and re-points them to a clone, loudly. Also honors explicit
  `--db clone` at dispatch / `POST /api/xells/:id/db {"coupling":"db-clone"}`.
  ⚠ The app tier picks the new DATABASE_URL up only on its **next build** — nothing is restarted
  under the zee; the binding rules tell it to rebuild.
- **Forward-apply exists now**: `scripts/xell-db-migrate.mjs <xell_id>`
  (`POST /api/xells/:id/db/migrate`) applies the xell's pending migration files **at its branch
  HEAD** to **its own** db (clone/isolated only), same ledger + loop the prod ship uses
  (`shipmigrate.js`), baselined at the branch's **fork point** from main. Testing the migration on
  the clone IS testing the deploy. Refused on shared dev (frozen) and prod (ships only).
- **The schema gate measures the clone** (`proddiff.diffXellDbAgainstProd` fingerprints the
  xell's clone instance and persists onto ITS `db_instance` row — never the shared container's
  chip). Green condition per xell: *my catalog = prod + my pending migration files*.
- **Consequence: DDL on the shared dev database is a rule violation** (binding says so) and, now
  that schema xells are cloned off, drift on the shared dev chip means something again.
- Not built (deliberately, yet): a land-gate check for two in-flight migrations touching the same
  table — ordering is filename discipline (date-prefix) + idempotent DDL by contract.

## Image garbage (2.6 GB per xell, nobody collecting)

A spinoff image is ~1.3 GB; a xell builds two. Teardown was supposed to purge them, but it only
delegated to `spin-env.sh purge` run FROM INSIDE the worktree — so a missing/broken worktree, or a
purge that failed, leaked ~2.6 GB silently. The NAS was at **140 GB of images, 131 GB reclaimable
(93%)**, plus 8 GB of build cache.

- **Teardown `--rm`**: `removeXellImages()` runs in the reaper BEFORE the container rows are
  deleted (those rows are the only record of the `image_tag`s). It does not need the worktree.
- **Janitor**: `startImageJanitor()` sweeps hourly (`IMAGE_JANITOR_ENABLED=false` to stop,
  `IMAGE_JANITOR_DRY_RUN=true` to watch). It only ever touches image REPOS that this project's own
  per-xell containers use (derived from the DB, never hardcoded) — it is NOT `docker image prune -a`,
  which on a shared NAS would eat the dev stack and prod.
- ⚠ **"Not a live xell" does NOT mean unused.** This machine also runs **pre-ZEEHIVE
  `/spin:spinoff`** environments whose images use the SAME names and are invisible to the `xell`
  table. A first dry run flagged 12 images (~15 GB) as orphans — **all 12 were backing RUNNING
  containers** (`cashier-checks`, `elegant-payne-…`, `exciting-hawking-…`, …). So:
  - **NEVER `rmi -f`.** Force UNTAGS an image a container is still using: it keeps running, but the
    next restart fails with "image not found". Plain `rmi` makes docker the judge.
  - The sweep also skips anything in `docker ps -a`, and deletes NOTHING if it cannot read the
    container list.
  With the guard in place the sweep correctly finds 0 — the leak is real but its victims are all
  still in use. It will reclaim them as those environments are torn down.

## Builds: how a zee waits (and why it used to hang)

`xell-build.mjs` was fire-and-forget and said *"watch its health on the dashboard"* — which a zee
cannot do. With no completion signal, zees invent `curl | grep` loops against their own webapp and
hang for 45+ minutes on a condition that never matches, long after the build succeeded.

- **`--wait`** blocks until the build settles and reports whether the container is serving the
  worktree's **current HEAD** — from `container.last_build_commit`, which the queenzee records at
  build time. Exit 0 = built, 1 = failed/timeout (20 min cap). It answers from fact, not a guess.
- **`--watch`** = same report, but starts nothing. Read-only "is what's running actually my code?".
- **Run it in the background: its exit IS the nudge.** The harness re-invokes a session when a
  background task finishes, so the zee keeps working and gets told the moment the build lands.
  Nothing pushes into a session — the wait just has to *end*.
- `GET /api/xells/:id/build/status` is the underlying truth (`serving_head`, `never_built`).
- A **`--hot`** build re-used the old image, so `serving_head` is false for it *by design* — hot
  never picks up code changes.
- **Fixed: orphaned builds.** `buildContainer` finalizes health from an in-process promise, and the
  health monitor SKIPS `health='building'` so it can't clobber a live build's spinner. A server
  restart mid-build therefore stranded the container at `building` **forever** — the promise died
  and the one thing that could fix it refused to look. `recoverOrphanBuilds()` now runs at boot
  (every `building` row is by definition an orphan in a fresh process) and hands them back to the
  monitor. Verified: without it, a stuck row survives a full monitor tick.

## The "Claude binary won't launch" red herring (do NOT chase the binary)

If a dispatch dies with:

> *Claude Code native binary at …\claude.exe exists but failed to launch. This usually means the
> binary does not match this system's libc — e.g. spawning a musl-linked binary on a glibc Linux
> host…*

**the binary is almost certainly fine, and none of that text applies on Windows.** It is `sZ()` in
the SDK's `sdk.mjs`, printed for *ANY* spawn error, and it DISCARDS the real error code. Two
sessions lost an hour to it on 2026-07-15.

The real cause was **`cwd` did not exist**: the dispatch carried a stale `xell_id` from an earlier
turn, the reaper had since retired that xell and deleted its worktree, and Node raises `ENOENT`
when spawning into a missing cwd — which the SDK reports as a broken executable.

`spawnHeadless` now rejects a retired/tearing-down xell, and any xell whose `worktree_path` is not
on disk, with a message that says so. Before blaming the SDK, check:
`node -e "console.log(require('fs').existsSync('<worktree_path>'))"`.
The binary itself: `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe --version`
(prints `2.1.208`). The SDK's own resolution + a `sdk.query()` with the queenzee's exact options
were both verified working — it is not the install, and reinstalling is a waste of time.

## KNOWN ISSUES / NEXT STEPS

0. **ROADMAP — xells that spawn xells (the xource tree).** Deferred 2026-07-16, deliberately: the
   foundation is IN and live, the last mile is not. What already works:
   - `xource.xell_id` (012) lets a xource BE a xell, so a xell can track another xell's branch
     instead of main. Guards are on and tested: ref must equal the xell's branch, one xource per
     xell, and no cycles. The cycle check lives on the XOURCE trigger, not only `xell_guard` —
     `xell.xource_id` is immutable so a xell cannot be re-pointed into a loop, but re-pointing a
     xource at its own descendant makes `a→b→a` in one UPDATE that `xell_guard` never sees. That
     leaked in testing before it was caught; do not "simplify" it back onto xell alone.
   - The land gate protects ANY xource ref, from a machine-local list the queenzee rewrites
     (`lib/protected-refs.js`). The ref check stays ABOVE the curl in the hook on purpose: an
     unreachable queenzee must not fail closed on every push to every branch.
   - push / pull / PR (`queenzee/xellgit.js`) read the xell's xource ref — nothing hardcodes main,
     so they work at any depth the moment children exist.

   **What's missing: provisioning.** Nothing can create a xell that tracks another xell, so the
   tree has no children yet. `provision-xell.sh` already takes `source_ref`, so branching off
   `spinoff/<parent>` may work as-is; the work is in `lib/provision.js` — create/reuse a xource row
   backed by the parent xell, pass its branch as the source ref, and call `writeProtectedRefs()` so
   the gate starts guarding the new xource.

   **Also unverified: accepting a PR.** `acceptPullIn()` has never run — not the fast-forward
   check, not approve-then-push through the gate, not the merge-into-a-parent-worktree branch. It
   needs a xell with commits ahead of its xource. Use a DUMMY, targeted by explicit slug (House
   rule: never test on live xells).

1–2. **[closed — old-repo housekeeping, deleted.]** These were one machine's chores from the
   `Xeehive` → `Zeehive` rename: delete a leftover `D:\Repos\Xeehive` folder with a PowerShell
   script, and drop a stopped pre-migration meta-DB container kept as a rollback. Both are long
   gone — the meta-DB moved off that host on 2026-07-18, and the stack now self-starts from
   published images. **They are the reason this file got a warning banner**: a zee orienting on
   HANDOFF read them as live work and went looking for drives it cannot see. The durable lesson,
   and all that is worth keeping: *a rename leaves a leftover every single time* (Originode →
   Xeehive → Zeehive), so plan the cleanup as part of the rename, not after it.

3. **Dispatch is one-shot** (open decision, 2026-07-15 — **check before you trust**; the nudge/
   resume paths in `queenzee/nudge.js` have moved a long way since). A dispatched zee ran exactly
   one `query()` turn and then idled until a human prompted it — *"the zees are really slow, I have
   to keep prompting them back."* Either a continuation loop in `spawnHeadless`, or keep one-shot
   and size tasks to fit one turn. What DID land in this space: a background `--wait` exiting
   re-invokes the session, and the queenzee resumes a zee's session for a stale landing or a
   post-ship reflection — i.e. "something ended" is the nudge, rather than a polling loop.

4. **Pool targets are DATA** (`pool_config.target_ready`), per project — read them from the
   console, not from here. A target of 0 warms nothing and provisions on demand only.

5. **Duplicated copies of a thing an agent runs WILL drift** — the single most repeated failure in
   this repo. Recorded here as `skill/` in the repo vs the installed `~/.claude/skills/` (2026-07-15:
   33 lines vs 61 — the installed copy had the claim gate, the project-handover note and the build
   rules; the repo copy had none of them, and the installed copy is what actually ran). The same
   bug then recurred one layer down and stranded a manager zee in its cage, with a hand-synced
   duplicate of the cxell CLI baked into the agent image.
   **The fix, now enforced:** there is exactly ONE copy of `scripts/zee`, the image COPYs it, the
   queenzee installs it at spawn — and `test/cxell-cli-drift.test.mjs` fails if a duplicate is
   reintroduced or if the CLI, the routes, the briefing and the manual drift apart. Apply the same
   rule to anything else an agent reads: one source, asserted by a test. A comment saying "update
   both" is not a mechanism.

## How to talk to it as an agent

⚠ **This section is the HOST surface only.** A caged zee has none of it — no slash-commands, no
MCP, no `scripts/`. Its entire toolset is the `zee` CLI; see `CLAUDE.md` §2 and the manual delivered
into every xell at `.zeehive/harness/memory/cxell-zee-manual.md`.

- `/xell <task>` — claims a ready xell **only if your cwd IS its worktree**; otherwise it refuses
  and offers a confirmed dispatch (`scripts/xell-dispatch.mjs`, `--mode 1..5`, default 5=bypass;
  `--attended`; `--db`/`--dump`/`--db-container`).
- `/xell-done` — marks this xell done and tears it down.
- MCP (`mcp/server.js`): `zeehive_get_context`, `zeehive_status`, `zeehive_report_done`,
  `zeehive_build{,_status,_contexts}`, `zeehive_set_build_context`, `zeehive_ooney`,
  `zeehive_ship_{request,status}`, `zeehive_seed_request`, `zeehive_prod_lock_status` (read-only).
  ~~`zeehive_prod_lock_{acquire,release}`~~ are **gone** — the zee-driven lock path was retired with
  the ship gate (see "Shipping"), and this line contradicted that section for a while. Read the
  tool list from `mcp/server.js`, not from here.

The web app is **read-only** about the FLEET (no prompting there); the **▚_ terminal** button by
"Status" opens a live queenzee activity log. ⚠ That stance was never about the zee TERMINAL —
"when i said readonly i didnt mean the terminal was readonly". You can converse with any cxell zee
from its terminal, mid-turn included: see the TALK QUEUE below.

**Attending a cxell zee** (`⌨` on its card) opens the live terminal: while the headless turn runs
you get its transcript feed (`docker/zeehive/zee-live.mjs` — ✱ thinking, ● what it says, ⚒ tool
calls + ↳ results), then `claude --resume` takes the pane for the full interactive session. The
header's **✱ thinking / ⚒ moves** chips show/hide the two noisy halves of that feed: they write
`/tmp/zee-live-view.json` into the cxell over a SECOND ssh channel (never keystrokes — the pane
belongs to `claude` after the turn), and the renderer watches the file and REPAINTS, so hiding
also removes what already scrolled past. The queenzee installs its own zee-live.mjs into every
cxell at spawn, exactly as it does `scripts/zee`, or a stale image would leave the chips dead.
Tests: `test/zee-live-view.test.mjs`, `test/terminal-feed-filter.test.mjs`.

**The TALK QUEUE — conversing with a zee that is MID-TURN** (2026-07-29). That feed is read-only in
BOTH directions: it renders the transcript and reads nothing from the terminal. So while a zee
worked, every keystroke aimed at it vanished — a human's in the browser, and the queenzee's
`send-keys` behind the 📨 message button, the 💬 nudge and a manager's `zee say` — while the console
reported "typed into its live session". Worst for a **manager zee**, whose whole job is conversation,
in the one place a human goes to talk to it.

- **The queenzee decides, from the cage's real state.** `cxellTalkCommand` (`lib/cxell.js`, pure)
  attaches-or-creates the pane session, then TYPES when the interactive session owns it and QUEUES a
  file in `/tmp/zee-talk` when a headless turn (or its feed) does. `sendKeysToCxellZee` resolves
  `{ sent, delivery: 'typed' | 'queued' }` and every caller passes that word on — "delivered" and
  "will be delivered" are different promises.
- **The cage drains it.** `zee-attach.sh` starts `drain_talk` AFTER the feed hands over and before
  the vendor's resume takes the pane: oldest first, newlines collapsed (Enter SUBMITS in the TUI),
  each file removed BEFORE it is typed (a crash loses a message rather than repeating it), and the
  drainer is STOPPED before the pane falls back to a login shell — a queued message typed at a bash
  prompt is a COMMAND, not a message.
- **One pattern, two places.** `HEADLESS_PROC_PATTERN` (`lib/cxell-runtimes.js`) IS `live_run()` in
  `zee-attach.sh`; they disagreeing means a message queued that nothing drains. Its brackets are
  load-bearing: `pgrep -f` reads whole cmdlines and the pattern rides inside the command the
  queenzee execs, so unbracketed it matched its OWN wrapper and made every cxell look mid-turn
  forever (caught live). Same trick, same reason, as `zee-live[.]mjs`.
- **zee-attach.sh now joins the CLI/renderer refresh** (spawn + the boot sweep), or the drainer would
  exist only in cages built after the next image rebuild while the queue filled in every cxell alive.
- **The terminal grew 💬 talk** — the same composer 📨 opens (one delivery path, one set of rules for
  long text and images), highlighted while a feed owns the pane, printing a receipt into the pane
  that says *typed* or *queued*. The feed banner now says the pane is read-only and where the door is.
- Tests: `test/cxell-talk.test.mjs` (runs the REAL `drain_talk` against a REAL tmux pane, and the real
  `sendKeysToCxellZee` against a throwaway sshd) and `test/terminal-talk-button.test.mjs`.
