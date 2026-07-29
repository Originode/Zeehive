# Is the data actually there? — a proposal, and what is already known

**Status: PROPOSAL. Nothing in "The proposal" below is built.** It is written down because
TKT-22-4F0E asked a question no existing surface can answer, and the diagnosis is worth more
today than a half-finished audit tool. The scope decision is a human's.

Raised from **TKT-22-4F0E** — *"any restore on a dev db from latest prod dump always has a big
diff from prod db … a db cloned or restored from prod should be identical to it. but check diff
says a massive gap. and im afraid the data might not be fully backed up."*

---

## 1. The two questions, and which one is answerable today

| the question | what answers it | verdict |
|---|---|---|
| why does a fresh restore show a big diff? | `queenzee/proddiff.js` | **answered** — see §2 |
| is production's data fully backed up? | *nothing* | **not answerable** — see §3 |

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
fear is *not confirmed* — and it is also *not refuted*, because the refutation requires a
comparison nobody has run.

## 4. The proposal (unbuilt — the cheap version first)

The instinct "compare the restore's row counts against prod" repeats the exact trap of §2: prod is
LIVE, so an append-heavy table is always ahead by whatever arrived since the dump, and the check
would cry wolf forever. Compare a restore against **its own source instead**.

**P1 — record per-table row counts at BACKUP time (small).** During the dump window, when prod is
already held in `ACCESS SHARE` and no other work may touch it, run one catalog query and store the
result in `db_snapshot` (`row_counts jsonb`, `row_total bigint`). Use `pg_class.reltuples` /
`pg_stat_user_tables.n_live_tup` — free, no seq scan, no extra load on a 1.3 GB production database
(an exact `count(*)` across omnibiz's 627 tables is not free and must never be the default). This
alone buys:

* a **backup-to-backup trend** — the real alarm for "my data is not fully backed up" is a table that
  SHRINKS between dumps, which today nothing would notice;
* the reference numbers every later restore can be graded against, without touching prod again.

**P2 — "Check data" on a restored db (small/medium).** The sibling of "Check diff": compare the
restored database's own counts against the counts recorded for the snapshot it was restored from
(`db_refresh` already records which snapshot that was). Same-instant comparison, so a difference is
a real loss, not a clock difference. Report per table: matched / short by N / extra. Wire it where
"Check diff" already lives, and off a finished restore — and keep the two verdicts VISIBLY separate
(that separation is this ticket).

**P3 — an exact-count verification pass (optional, human-triggered only).** `count(*)` per table on
prod, refused while `prodBusyReason()` is non-null, never on a timer. Only worth building if P1's
estimates prove too coarse to trust.

Cost, honestly: P1 is a migration + ~40 lines in the backup job + the panel showing a total. P2 is a
probe, a comparison, a menu item and a payload. P1 is where the value is, and P1 without P2 is still
useful. **Neither is started.**

## 5. Not fixed here, and worth a ticket each

1. **A failed backup consumes its window.** `backupDue()` looks at the newest row of *any* status
   (deliberately — it prevents a retry storm), so one failure delays the next good dump by a full
   interval. omnibiz's 12-hourly schedule missed two windows this way on 2026-07-29 (the newest
   attempt failed with "interrupted by server restart"; the same happened on 07-27 with an
   unreachable prod context). The console now shows **⚠ overdue** and **⚠ last attempt failed**
   instead of nothing, but nothing yet *retries sooner* than the next window.
2. **Nothing alerts.** Backup freshness is a chip a human must look at. There is no notification.
3. **The restore side is unverified.** `pg_restore` runs without `--exit-on-error`; ignored errors
   are counted by pg_restore, not by us. A restore that partially failed is far more likely than a
   dump that partially wrote — and P2 is what would catch it.
