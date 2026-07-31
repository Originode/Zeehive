# Is the data actually there? — a proposal, and what is already known

**Status: P1 and P2 are BUILT. P3 was deliberately not.** This file was written first as a proposal —
TKT-22-4F0E asked a question no surface could answer, and the diagnosis was worth more than a
half-finished audit tool — and the scope was then approved as "P1 and P2, not P3". §4 records what
each piece is and what shipped; §2 and §3 are the diagnosis they were built on, unchanged.

Raised from **TKT-22-4F0E** — *"any restore on a dev db from latest prod dump always has a big
diff from prod db … a db cloned or restored from prod should be identical to it. but check diff
says a massive gap. and im afraid the data might not be fully backed up."*

---

## 1. The two questions, and which one is answerable today

| the question | what answers it | verdict |
|---|---|---|
| why does a fresh restore show a big diff? | `queenzee/proddiff.js` | **answered** — see §2 |
| is production's data fully backed up? | `queenzee/datadiff.js` + `lib/row-counts.js` | **answerable now** — see §3, §4 |

For getting from a drift *number* to a *cause*, read [schema-drift-triage.md](schema-drift-triage.md)
— the direction reading, the by-schema rollup and the dev↔dev control experiment. This file is the
other half: what that number can never mean, and what would actually answer the data question.

`proddiff` compares CATALOG SHAPE: tables, columns, triggers. It counts no rows, reads no values
and never opens a dump. A green `0` is therefore not evidence that data is safe, and a red `12802`
is not evidence that any data was lost. That conflation is the defect the ticket actually found;
it is fixed at the *surfaces* (the chip tooltip, the Check-diff dialog, the terminal line, the
/ooney schema step, and the backups panel all now state what they cover), not by making `proddiff`
pretend to more than it measures.

## 2. Why a faithful restore still shows a gap (answered)

**The ruler is LIVE prod; a restore is the dump's instant.** Everything prod migrates after the
dump was taken reads as `missing`. That is real drift in the dangerous direction (prod has it, your
db does not — code may expect it) and reporting it is `proddiff` doing its job. It is *not* the
extension-owned-object noise that was fixed in `d6deb8a` (that class is excluded by the
`pg_depend deptype='e'` rule and covered by `test/proddiff-extension-noise.test.mjs`), and it is
*not* a stale number: every stored `prod_diff` observed while diagnosing this was minutes old, five
days after that fix.

Measured on the live Zeehive fleet on 2026-07-29 — one production database, one code path, six
databases, every reported object listed in full:

| database | `total` | every difference it reported |
|---|---|---|
| `…keen-atlas-66ddfe` | **1** | − `project_doc.targets` |
| `…wise-harbor-cdf20b` | **1** | − `project_doc.targets` |
| `…swift-ridge-1433ab` | **13** | − `public.project_doc` + its 8 columns … |
| `…sunny-harbor-813a0b` | **13** | … the same table and columns |
| `…keen-atlas-f905fb` | **4** | **+** `harness.project_id`, **+** 3 `harness_scope_guard` triggers |
| others | **0** | — |

Every entry is a named object from a real migration, and the direction is right in both cases: the
first four are one and two migrations BEHIND prod (`−` missing), while `keen-atlas-f905fb` is a xell
that applied its own not-yet-landed migration and is AHEAD (`+` extra). Nothing phantom, no
extension noise, nothing unexplained. The gap is the **age** of the copy and it grows with the
interval between the dump and now. The cures are a newer dump or a ledger catch-up (`zee db-catchup`,
`queenzee/catchup-delta.js`) — never a suppression.

Two corollaries that were mis-reading as data loss:

* **`omnibiz_db_prod_dev_local_mardale_prod` — 12,802 "differences".** Re-probed live: prod has **627**
  application tables and that database has **0**. It is the empty dev clone from regression 2 (the one
  the backup resolver now positively excludes by published port), registered precisely so it can never
  be dumped over prod's history again. Nothing was ever restored into it. `proddiff` now reports
  `empty_db` and the console says "EMPTY — never restored" instead of a catastrophic-looking count.
  Its sibling `omnibiz_db_prod_dev_local` reports **150** and holds **624** of prod's 627 tables — a
  real restore, three tables behind live prod. Same mechanism as the table above, two orders of
  magnitude more of it, because omnibiz has no migration ledger and takes DDL continuously.
* **One-directional drift is age, not authorship.** If every difference is `missing` and nothing is
  `extra`, the db is behind prod — so the /ooney gate now says "catch up first" instead of telling a
  zee to write a migration for objects prod already has.

### 2a. A restore that loads everything can still report "completed with holes" — prod ROLES

A second, subtler cause of a "this dev db isn't fully copied" report is not in the catalog at all: it
is in the ACLs. A production dump records `GRANT` statements for the roles production actually has —
including per-xell **read-only manager roles** (`zee_ro_<slug>`, minted by `lib/prod-readonly.js`).
A dev database has none of those roles. `pg_restore` replays the GRANTs by default, and each one that
names a role the dev server does not have is an ignored error:

```
pg_restore: error: could not execute query: ERROR:  role "zee_ro_quiet_meadow_6174f7" does not exist
Command was: GRANT SELECT ON TABLE public.land_request TO zee_ro_quiet_meadow_6174f7;
…
pg_restore: warning: errors ignored on restore: 43
```

Because pg_restore **exits 1** when it ignored errors (TKT-30), a restore that loaded **every table,
every row** reported itself as failed-and-with-holes — and the data check graded `unverified` for the
tables whose source estimates were never analyzed, compounding the "not fully copied" reading. Measured
on the live Zeehive fleet 2026-07-31: `bold-grove` and `calm-summit`, two databases freshly restored
from the newest prod dump, both carried 39/39 tables and schema-drift `0` — yet both logged
`pg_restore completed but IGNORED 43 error(s)` whose only causes were the two `zee_ro_*` roles.

**The fix:** every DEV restore path (`runRestoreJob` streamed + docker-cp for non-prod targets,
`duplicateProdInto`, and `provision-xell-db.sh`) now passes `--no-privileges` to pg_restore, so
ACL/GRANT statements from prod are not replayed onto a copy that cannot satisfy them. Ownership was
already ignored (`--no-owner`); the privileges half was the missing piece. One deliberate exception:
a restore **over production** itself (the gated `confirmProd` flow) still replays ACLs, because
prod's roles exist there and the restore must not strip their grants. This makes a restore's tally
mean what a human reads it to mean — if it says `ignored 0`, the copy is complete; if it says
`ignored N`, those are objects that genuinely did not load.

## 3. What IS known about data completeness (and its limits)

Verified today, at backup time (`queenzee/maintenance.js`) — all of it about the **dump**, none of
it about **rows**:

* the file starts with `PGDMP` and is not truncation-tiny (`assertDumpMagic`);
* it has not collapsed in size against the last good FULL backup (`assertDumpSize`, 50% floor —
  calibrated on a real 1.2 GB → 7.6 KB wrong-database event);
* `pg_restore --list` of the **written** file parses, contains application tables (not only a
  migration ledger), and has lost no schema the previous good backup had (`assertDumpContent`);
* the archive's table list is recorded in `db_snapshot.toc_summary` and is now shown on the row.

Evidence from a real restore (this xell's own db-isolated clone of the latest Zeehive prod dump,
measured 2026-07-29):

* 35 public tables, 2,310 rows, 86 `schema_migrations` entries, 2 extensions;
* every busy table populated (`zee_message` 346, `db_refresh` 310, `land_request` 243,
  `session_event` 233, `ship_request` 201, `xell` 158);
* only 2 empty tables, both explainable — `deploy_lock` (empty unless a deploy is in flight) and
  `project_doc` (a table younger than its first row);
* **74 foreign-key constraints, all `convalidated`, with 0 dangling child rows.** A restore that had
  silently dropped a table's rows would either fail constraint creation or leave dangling
  references. It did neither.

**What that does and does not prove.** It proves a restore does not arrive structurally empty or
truncated, and that no referenced parent rows are missing. It does **not** prove row-for-row
completeness: a table nobody references could be short and every check above would still pass. The
fear was *not confirmed* — and it was not *refuted* either, because the refutation required a
comparison nobody had run. §4 is that comparison, now built: on this same database it reports 33 of
35 tables verified against the counts its source recorded, and names the other two as tables the
source itself never analyzed. Not "everything is fine" — exactly what was and was not checked.

## 4. What was built (P1 + P2), and what was not (P3)

The instinct "compare the restore's row counts against prod" repeats the exact trap of §2: prod is
LIVE, so an append-heavy table is always ahead by whatever arrived since the dump, and the check
would cry wolf forever. So a restore is compared against **its own source** instead.

### P1 — every backup records what the SOURCE held, per table

`db_snapshot.row_counts` / `row_total`, captured in `runBackupJob` from `pg_class.reltuples`.

* **Estimates, deliberately.** An exact `count(*)` over a 600-table, 1.3 GB production database is
  minutes of I/O for instrumentation. `reltuples` is a catalog read: no table locks, no heap.
* **It cannot cost the backup anything.** Taken AFTER `pg_dump` returns, so it neither delays the dump
  nor extends the window production is locked for; every failure path records `NULL` and logs a line
  saying the backup is unaffected. `NULL` means "not captured" and never "the database was empty".
* **What it buys:** the reading nothing had before — a table that **shrank** since the last good dump.
  Reported in the maintenance log and on the backup row (`~N rows`, amber when a table shrank or
  emptied), with an emptied table called out louder than a shrunken one, because no estimate error
  explains "many" becoming "none". Growth, a new table and a dropped table are counted and never
  dressed as loss.

### P2 — "Check data": a restore against the backup it came from

`queenzee/datadiff.js`, `POST /api/containers/:id/check-data`, and a menu item beside "Check diff".

* The reference is the snapshot the database was **recorded** as restored from
  (`container.restored_from`, written by the restore itself — a live "Duplicate prod" pipe records
  that it has *no* snapshot, so the check refuses instead of grading against the wrong dump).
* The restored side is counted **exactly**: a fresh restore has no statistics at all, so every
  `reltuples` in it reads `-1` and an estimate-vs-estimate comparison would compare nothing.
* That asymmetry is stated in every verdict, and it is why a sub-10% shortfall is not reported.
  Measured on this xell's own restore: ~2,369 estimated vs 2,386 exact across 35 tables — 0.7%.
* Per table: **empty** (populated in the backup, none here — the loud one), **short**, **missing**
  (absent from the catalog: schema drift, routed back to Check diff, never counted as lost rows),
  **no-reference** (the source never analyzed it: unknown, neither a pass nor an alarm), **ok**.
  The verdict lives in `container.data_check` — never `prod_diff`. Two questions, two columns.
* **Production is refused as a subject**, with the reason: it is the reference, not the patient.

### P3 — an exact-count verification pass on prod: NOT built

A human-triggered `count(*)` over every production table is a real cost for a marginal answer.
Revisit once P1 has a few days of trend, not before.

## 5. Not fixed here, and worth a ticket each

1. **A failed backup consumes its window.** `backupDue()` looks at the newest row of *any* status
   (deliberately — it prevents a retry storm), so one failure delays the next good dump by a full
   interval. omnibiz's 12-hourly schedule missed two windows this way on 2026-07-29 (the newest
   attempt failed with "interrupted by server restart"; the same happened on 07-27 with an
   unreachable prod context). The console now shows **⚠ overdue** and **⚠ last attempt failed**
   instead of nothing, but nothing yet *retries sooner* than the next window.
2. **Nothing alerts.** Backup freshness is a chip a human must look at. There is no notification.
3. ~~A restore's own ignored errors are unread~~ — **fixed (TKT-30)**, and it was worse than "unread":
   `pg_restore` EXITS 1 when it merely ignored errors (verified against a real restore), and both
   restore paths treated any non-zero exit as a throw. A restore that COMPLETED, with data on disk,
   was logged "restore FAILED", never recorded as having happened, and never graded — the omnibiz dev
   db missing `core.location` is exactly that shape. The decision now comes from pg_restore's own
   tally (`lib/restore-errors.js`): a tally means it ran to the end, which is a restore that completed
   *with holes* — recorded in `container.restore_report`, graded, and logged with the first cause
   named. Non-zero with no tally is still a genuine failure and still throws.
4. ~~Nobody runs "Check data" for you~~ — **fixed (TKT-30)**. A finished restore grades itself: that is
   the one instant when the source snapshot, the target database and the reason for both are all known
   at once. Fire-and-forget, after `busy` clears, every failure swallowed; production still refused as
   a subject; a table-scoped restore graded only over the tables it loaded. A clean result logs one
   quiet line and nothing else — the pool restores databases all day, and a green announcement on each
   is how the line that matters becomes invisible. It is still persisted, so the chip shows it without
   re-counting: quiet is not unrecorded.
5. **A restore over the metadata store rewinds its own fixture.** Not a defect, but worth knowing
   before debugging one: restoring ZEEHIVE's own meta-DB from a dump of itself reverts every row the
   test just set up, including the container's own tier — which is how a real end-to-end run ended with
   the automatic grade correctly *refusing* a now-prod-tier subject. The guard held; the fixture did not.
