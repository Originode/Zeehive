# Plan: let a zee catch its own DB schema up to production

Status: **design / plan** (2026-07-25). Scoped and grounded against the live code — every file and
function named below exists today. Nothing here is built yet; this is the "how".

---

## 1. The problem

A zee that works against its **own** database can be **behind prod's current schema**, and today it
has no sanctioned way to close that gap forward.

Where the lag comes from, per `db_coupling` (`server/src/lib/xell-db.js › DB_MODES`):

| coupling | how the DB is seeded | why it can lag prod |
|---|---|---|
| `db-isolated` | its own postgres, **restored from a `db_snapshot`** (a prod `pg_dump`) | the snapshot is a *point in time*; prod has shipped migrations since `taken_at` |
| `db-clone` | its own database inside the shared dev postgres, from the **`<db>_zeehive_tpl`** template | the template is rebuilt from the **live dev** db (≤ `CLONE_TPL_MAX_AGE_MS`, default 6 h), and dev itself can trail prod |
| `db-shared-dev` | the shared dev db (schema **frozen**) | can trail prod; a schema-work xell must clone off it anyway |
| `db-shared-prod` | **is** prod | not applicable — it is the ruler |

We already **measure** this gap: `server/src/queenzee/proddiff.js` fingerprints a db's catalog and
diffs it against prod, persisting `prod_diff = { missing, extra, … }` where **`missing` = "prod has
it, this db does not"** — precisely "I am behind prod". `diffXellDbAgainstProd()` does it on demand
for one xell (the `/ooney` schema gate uses it).

What is **missing is the fix**. The only forward-apply that exists,
`shipmigrate.js › applyMigrationsToXell()` (surfaced as `scripts/xell-db-migrate.mjs`), applies the
**zee's own branch** migration files, and it **baselines the ledger at `merge-base(main, HEAD)`** —
i.e. it *assumes everything main carried when the branch forked is already in the db*. That is true
for a fresh clone/restore, but **false for a stale one**: if the isolated db was restored from a
three-week-old prod dump, forward-apply will baseline away exactly the migrations that shipped in
those three weeks and never run them. So the pre-fork gap stays open, `prod_diff.missing` stays red,
and the `/ooney` green condition ("my catalog = prod + my pending migrations") is unreachable.

**Goal:** a first-class verb — **`zee db-catchup`** — that rolls a zee's own db **forward to prod's
current schema**, surgically and without discarding the zee's work, reusing the ledger machinery that
already ships migrations to prod.

> **Naming — deliberate.** "Catch up" is already taken for **git**: `zee sync` /
> `xellgit.js › catchUpToXource` bring the zee's *branch* up to the xource tip. To avoid confusing a
> schema roll-forward with a code merge, the DB verb is **`db-`-prefixed** (`zee db-catchup`,
> `POST …/db/catchup`, `xell-db-catchup.mjs`) — the exact parallel of the existing forward-apply
> (`zee`-less today, but `/db/migrate` + `xell-db-migrate.mjs`).

Non-goal: removing `extra` objects (things the zee's db has that prod lacks). That is the reverse
direction, it is not dangerous the way `missing` is, and the honest tool for a full reset is a
**re-restore** (§5), not a schema catch-up.

---

## 2. The key insight — the ledger is prod's forward history, and time attributes it

Prod's schema is **baseline + the ordered migration files recorded in its ledger**
`zeehive_migrations` (`shipmigrate.js`): `(filename, sha, applied_at, baseline)`, living **only in
prod** by design. Every file in that ledger is a file on **`main`** (prod builds from main), so the
queenzee can always read the SQL back with `git show <sha>:<file>` from the xource.

That gives a clean definition of "catch up":

> Apply, to my db, the migration files **prod has applied that my db does not yet reflect**, in
> filename order, each in its own transaction, ledgered — the *same* `runPending()` loop the prod
> ship and the per-xell forward-apply already use.

The only hard part is the **baseline**: *which of prod's ledger files does my db already reflect?*
Answer it wrong low → double-apply; wrong high → leave the gap open. The right signal differs by
coupling, and for the canonical case it is **time**:

- **`db-isolated`** was restored from a snapshot with a known **`db_snapshot.taken_at`**. Every prod
  migration with **`applied_at <= taken_at`** is *by construction* in the dump; every one with
  **`applied_at > taken_at`** shipped afterwards and is the delta. This is exact and needs **nothing
  from inside the dump** — it is robust even when the dump is *table-scoped* (`db_snapshot.tables`,
  migration 042) and the `zeehive_migrations` table itself was not captured.
  - Cross-check when the dump *did* carry the ledger: `prod_files \ my_ledger_files` should agree
    with the timestamp delta. Disagreement is logged, and the **union** is applied (idempotent DDL by
    contract makes an extra CREATE-IF-NOT-EXISTS a no-op).
- **`db-clone`** has no snapshot and no ledger (dev carries neither). Baseline it at
  **`merge-base(main, HEAD)`** exactly like `applyMigrationsToXell`, then apply prod-ledger files
  after that point. This is **best-effort** (the clone came from dev, not prod, so its real schema
  can differ from "main at fork" in both directions) — it closes the `missing` direction and leans
  on idempotent DDL; anything it can't close, the post-check (§6) reports and the human re-clones.

---

## 3. The verb and its wiring (mirrors the existing forward-apply)

Everything already has a twin to copy — `catchup` slots in beside `migrate` at each layer:

| layer | existing (`migrate`) | new (`catchup`) |
|---|---|---|
| engine | `shipmigrate.js › applyMigrationsToXell(xellId)` | `shipmigrate.js › catchUpXellToProd(xellId)` — reuses `runPending`, `ledgerFiles`, `prodDb` |
| host route | `POST /api/xells/:id/db/migrate` (`routes.js:586`) | `POST /api/xells/:id/db/catchup` |
| cxell self-verb | — | `POST /api/xell/self/catchup` → `self.js › selfCatchup(xell)` |
| host CLI | `scripts/xell-db-migrate.mjs` | `scripts/xell-db-catchup.mjs` |
| in-cxell CLI | (n/a) | `zee db-catchup` in `scripts/zee` (NOT `zee catchup` — that would read as git `sync`) |
| console | proddiff chip "Check diff" | proddiff chip **"Catch up to prod"** (shown when `missing_count > 0`) |

**Gating: NOT human-gated.** Same class as `zee build` and `applyMigrationsToXell`: it writes **only
the xell's own throwaway db** and it **reads prod read-only** — it never writes prod. So it acts
immediately (see `self.js › selfBuild` / the manual's "`zee build` is the one verb that acts
immediately"). No landgate/shipgate touched.

---

## 4. `catchUpXellToProd(xellId)` — the algorithm

Reuse as much of `shipmigrate.js` as possible; the new code is baseline selection + a read-only prod
ledger read.

1. **Resolve the target db (the zee's OWN).** Same as `applyMigrationsToXell`:
   - refuse `db-shared-prod` → *"your database IS live production; nothing to catch up, and
     migrations reach prod only through a ship."*
   - refuse `db-shared-dev` (and `db-clone` with no clone instance) → the frozen-schema message,
     "attach your own clone first."
   - else resolve the container via `resolveRealDbContainer()` and, for `db-clone`, the instance
     name via `cloneInstanceFor()`. **Never** target anything but the xell's own db.

2. **Read prod's ledger, read-only.** Reuse `prodDb(project)` to get the prod handle, then confirm
   identity with `assertProdDbTarget(db)` (the same guard `applyMigrations` uses before a prod
   write) so we can never read the wrong "prod" and import the wrong files. Then:
   `SELECT filename, sha, applied_at FROM zeehive_migrations WHERE baseline = false ORDER BY filename`.
   (Read-only. If prod has no ledger yet, there is nothing to catch up to → return clean.)

3. **Compute the delta** (pure — see §7, `catchupDelta()`):
   - `db-isolated`: `delta = files where applied_at > snapshot.taken_at`. The snapshot is the one the
     xell was restored from — recorded on the `db_snapshot` row picked at attach time; if the link
     was lost, fall back to reading the db's own `zeehive_migrations` if present, else to the
     clone-style fork baseline with a loud warning.
   - `db-clone`: baseline `done = ledgerFiles(project, db, merge-base(main, HEAD))`;
     `delta = prod_files \ done`.
   - In both cases keep **filename order** and de-dupe.

4. **Apply the delta with `runPending()`**, reading each file at its **prod-ledger `sha`** (the exact
   bytes prod ran), falling back to `main`-tip if that object is gone. `runPending` already: runs
   each file `--single-transaction`, stops at the first failure returning `{ ok, error, applied }`,
   and ledgers each success in the **target** db. Catch-up thereby *creates* a `zeehive_migrations`
   ledger in the zee's db as a side effect — which makes the **next** `zee db-catchup` / `zee db-migrate`
   cheaper and self-describing.

5. **Return** `{ ok, applied[], skipped_up_to, database, residual? }` and log one `catchup` line.

**Ordering with the zee's own work:** catch up to prod **first** (db = prod), **then**
`zee db-migrate` to forward-apply the branch's new migrations on top. `zee db-catchup` can optionally
chain the forward-apply at the end so one command yields the `/ooney` green state
("prod + my pending migrations"). Recommended output nudges the zee to do exactly that.

---

## 5. The heavy hammer — re-restore (guaranteed, `db-isolated` only)

Ledger roll-forward is surgical but can't fix `extra` drift or a dump that predates a
non-idempotent history. The exact, no-reasoning-required way back to prod is a **re-restore**, which
**already exists**: `attachXellDb(xellId, { coupling:'db-isolated', dump:'latest' })` picks the
newest finished prod `db_snapshot` and rebuilds the isolated db from it (schema **and** data).

- Expose it as **`zee db-catchup --restore`**: re-attach from the latest **existing** prod snapshot.
  Cheap and prod-safe — it reuses a backup already on disk, taking **no** new prod `pg_dump` (which
  would lock prod; that stays a human/maintenance decision).
- It **discards the zee's db work** (fresh restore), so it is opt-in and the CLI says so.
- Not offered for `db-clone` (no snapshot; the equivalent is dropping and re-attaching a clone, which
  rebuilds from the dev template — a separate `zee db --coupling db-clone` re-attach).

`catchUpXellToProd` **recommends** `--restore` automatically when roll-forward can't be trusted
(no snapshot link **and** no ledger, or a residual `missing` after §6).

---

## 6. Verify — the loop closes on proddiff

After applying, **re-measure**: call `diffXellDbAgainstProd(projectId, xellId)` (it already persists
onto the right `db_instance`/`container` row and broadcasts, so the chip repaints).

- `residual missing == 0` → **caught up**. Report green.
- `residual missing > 0` → roll-forward was insufficient (clone divergence, or a stale isolated db
  with non-idempotent history). Report the residual objects and recommend `zee db-catchup --restore`
  (isolated) or a fresh clone.

"Testing the migration on the clone IS testing the deploy" (HANDOFF) — catch-up inherits that: a
clean catch-up + a green proddiff is proof the zee is building on prod's real current schema.

---

## 7. The one piece of genuinely new, testable logic

Baseline selection is pure and unit-testable in the house style (`decideProdDbTarget`,
`pickDbContainer`, `diffPayload` are all pure + exported for tests). A prototype + passing test ship
with this plan at **`server/src/queenzee/catchup-delta.js`** and
**`test/catchup-delta.test.mjs`** (run: `node --test test/catchup-delta.test.mjs`):

```js
// prodLedger: [{ filename, sha, applied_at }]  (baseline=false rows, from prod's zeehive_migrations)
// opts.mode: 'isolated' | 'clone'
// opts.takenAt: db_snapshot.taken_at (isolated)     opts.baselineDone: Set<filename> (clone, fork point)
// → { delta: [{filename, sha}], skipped: [...] }  ordered by filename, de-duped
export function catchupDelta(prodLedger, opts) { … }
```

Everything else is existing, exercised code (`runPending`, `ledgerFiles`, `prodDb`,
`assertProdDbTarget`, `resolveRealDbContainer`, `diffXellDbAgainstProd`, `attachXellDb`), so the risk
lives almost entirely in this one function and the baseline choice — which is why it is the part with
a test.

---

## 8. Safety summary

- **Writes only the xell's own db** (clone/isolated), resolved by durable identity
  (`resolveRealDbContainer`) — never prod, never another xell, never the shared dev primary.
- **Reads prod read-only**, and only after `assertProdDbTarget` confirms the handle really is the
  registry's prod db (the same guard that stopped a ship migrating a 7.7 MB clone).
- **Refused** on `db-shared-prod` (that IS prod) and `db-shared-dev` (frozen — clone first).
- **Idempotent + transactional**: `runPending` runs each file in its own transaction and stops at the
  first failure, reporting what applied; DDL is idempotent by contract, so an over-broad baseline
  degrades to no-op re-applies, not corruption.
- **Not human-gated** — it only touches throwaway per-xell state, exactly like `zee build`. No
  landgate/shipgate involved; catching up a dev db is not deploying.
- **Never takes a new prod dump.** `--restore` reuses an existing snapshot; a fresh prod backup
  (which locks prod) stays a human/maintenance action.

---

## 9. Phasing

1. **Phase 1 — engine + verbs.** `catchupDelta()` (+ test, done here), `catchUpXellToProd()`,
   `POST /api/xells/:id/db/catchup`, `selfCatchup` + `POST /api/xell/self/catchup`, `zee db-catchup`,
   `scripts/xell-db-catchup.mjs`. Exact for `db-isolated`; best-effort schema for `db-clone`.
2. **Phase 2 — verify + fallback.** Post-run `diffXellDbAgainstProd`; `zee db-catchup --restore`; auto
   recommendation when residual `missing` remains; optional chained forward-apply of branch files.
3. **Phase 3 — surface + document.** proddiff chip "Catch up to prod" action; a line in
   `docs/cxell-zee-manual.md` and the dispatch binding so a schema-work zee is told to `zee db-catchup`
   before it starts writing migrations.

## 10. How to verify end-to-end (needs prod; not reachable from an isolated cxell)

1. Dispatch a `db-isolated` xell restored from an **old** prod snapshot (`--db isolated --dump <old
   snapshot id>`); confirm `proddiff.missing_count > 0`.
2. `zee db-catchup` → expect the post-snapshot migrations applied in filename order.
3. `diffXellDbAgainstProd` → `missing == 0`.
4. `zee db-migrate` → the branch's own migrations apply cleanly on top; `/ooney` reads green.
5. Negative: `zee db-catchup` on a `db-shared-prod` and a `db-shared-dev` xell → both refused with the
   documented messages.
