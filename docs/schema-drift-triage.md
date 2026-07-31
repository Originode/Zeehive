# Triaging schema drift — "this db is drifted from prod even after a fresh restore"

A db chip's drift mark is one number: how many catalog objects differ between that database and
**live production** (`server/src/queenzee/proddiff.js`). The number tells you *that* something is
wrong and nothing about *what*. This is how to get from the number to a cause.

Read [the proddiff header](../server/src/queenzee/proddiff.js) first — it defines what is measured
(tables, columns-with-type, triggers), what is deliberately **not** (extension-owned objects, engine
schemas, the ship's own migration ledger), and the direction convention:

- **missing** — production has it, this db does not. The dangerous direction: deployed code can
  reference an object that isn't there.
- **extra** — this db has it, production does not. Usually unshipped work; sometimes dead legacy.

## 1. Read the DIRECTION before anything else

Right-click the chip → **Check diff**. The report leads with which way the drift runs, because that
single fact splits the causes in half (`web/src/drift.js`, `driftDirection`):

| shape | meaning | where to look |
|---|---|---|
| only **missing** | a strict SUBSET of prod. Nothing was created here that prod lacks, so this is **not** local schema work — objects prod has never arrived. | what LOADED this db (§3) |
| only **extra** | a strict SUPERSET. `pg_restore --clean` drops only what the archive **contains**, so anything here that the dump does not have survives every "fresh restore", forever. | local DDL, and objects prod has since dropped |
| both | two stories in one number | the by-schema rollup usually separates them |

Then read the **by-schema rollup**: exact per-schema counts, even when the object lists are sampled.
One schema owning every difference is the normal shape of a real cause; drift spread evenly over
thirty schemas is the shape of "this database was never loaded at all".

## 2. Ask whether EVERY db is drifted the same way

**Check diff → Compare against…** measures this db against another db instead of prod (production
stays the default and the only reference that repaints the chip; everything else is a report).

This is the control experiment, and it is the fastest way to stop chasing a database that is fine:

- two freshly-loaded dev dbs that **match each other** but both differ from prod → the difference is
  in the load path or the comparison, not in either database;
- a dev db that **matches prod except for N objects** while its sibling is missing hundreds → the
  sibling was never loaded (or its `omnibiz`-named database inside the container is not the one that
  holds the data); nothing about prod is wrong.

## 3. When objects are MISSING, work down the load path

1. **Is the dump older than production?** A restore is faithful to a *snapshot*; the drift check
   compares against *live* prod. A project that ships migrations changes prod's schema on every
   ship, so on the day after a nightly dump, a perfectly restored db is already behind — by exactly
   the objects that shipped since. `db_snapshot.taken_at` vs the drift's timestamp answers this, and
   `db_snapshot.toc_summary.tables` lists what the archive actually contains: if a missing object is
   **not in the dump's TOC**, no restore of that dump could ever have produced it.
   → Use **Duplicate prod** instead when you want zero staleness: it pipes a live `pg_dump` straight
     into the target (`maintenance.js`, `duplicateProdInto`), so there is no snapshot in the middle.
2. **Was the dump or the restore table-SCOPED?** Both support a table selection
   (`pool_config.backup_tables`, and the per-restore pick). A scoped archive records
   `toc_summary.scoped = true` and only its own tables; everything else in the target keeps whatever
   it had. This produces enormous, permanent "missing" counts that look nothing like a bad restore.
3. **Did the restore skip an object and carry on?** `pg_restore` here runs
   `--clean --if-exists --no-owner --no-privileges` without `--exit-on-error`: it continues past a
   failed object and reports the count at the end. The usual reason one specific table fails while 600
   land is a TYPE the target cannot create — a PostGIS/extension build that differs between the
   production image and the dev image is the classic (a `USER-DEFINED` column type in the missing
   object's column list is the tell). The reason is only ever printed in the restore's log line, and
   the queenzee's log is an in-memory ring — so **read it while it is there**, or restore again and
   watch. (The `--no-privileges` half keeps prod's custom ROLEs — read-only managers' `zee_ro_*` and
   the like — from being replayed as GRANTs the dev server cannot satisfy; before it was added, a
   restore that loaded every table still reported itself "completed with holes" for a missing role.
   A restore over PROD itself is the exception and still replays ACLs, since prod's roles exist there.)
4. **Is this database the one that was restored at all?** The chip measures the database named by
   `project.db_name` inside that container. A container whose real payload lives under a different
   database name will faithfully report an empty one. `container.instances` (the chip tooltip) lists
   what postgres actually reports inside it.

## 4. When objects are EXTRA, the restore is not going to remove them

`pg_restore --clean` drops what the archive contains and nothing else. A dev db that has ever done
its own DDL — or that predates a table prod dropped — keeps those objects through every restore.
Rebuild it instead of restoring over it (decommission + re-attach, or **Duplicate prod** into a
freshly created database), or drop the objects deliberately.

## 5. What is deliberately NOT drift

Extension-owned objects (`pg_depend.deptype='e'`) on either side, the engine/noise schemas, and the
ship's own migration ledger. Those were all phantom drift once, on databases that were faithful
copies of prod — see `test/proddiff-extension-noise.test.mjs`. If you are looking at a difference
that no migration owns, check whether it belongs to an extension before treating it as real.

An **empty** database is also not a drifted one, and no longer reports as one: when a db holds none
of the reference's tables and nothing extra, the payload carries `empty_db` and every surface says
"EMPTY — never restored" instead of a difference count. That is §3.4 above, answered before you ask.

## 6. What this number CANNOT tell you — it is not a data check

`proddiff` reads catalogs. It counts no rows, reads no values and never opens a dump, so **a drift
number says nothing about whether data is present or backed up** — in either direction. A green 0 is
not reassurance and a red 12,802 is not evidence of loss (in the worked example below, the 12,802 db
held no data because it held no *tables*; production was untouched). Every payload declares this
(`scope`, `covers`, `data_compared: false`) and every surface repeats it, because the two questions
arrived merged in one ticket and one number cannot answer both — TKT-22-4F0E.

For what *is* verified about a backup, what is not, and the proposal for an actual row-level check,
see [data-completeness-check.md](data-completeness-check.md).

---

### A worked example (dated observation, 2026-07-29 — not a standing fact)

Two dev databases of one project, both nominally restored from prod backups:

- one reported **150** differences: 3 tables, and the 127 columns + 20 triggers that hang off those
  same 3 tables. **Zero extra.** Of the three, one was present in every recent dump's TOC (so its
  restore dropped it — and its column list contained a `USER-DEFINED` (PostGIS) type and its
  triggers were spatial), and two were in **no** dump at all (created in prod after the newest
  snapshot: prod's table count in the TOCs rose over the same window).
- the other reported **12802**: 627 tables, 11326 columns, 849 triggers missing, **zero extra** —
  i.e. essentially every object prod has. Zero extras is the signature of an *empty* database, not a
  drifted one.

Same colour on both chips, two completely different causes: one is dump-staleness plus a single
object that does not survive a restore; the other is a database that was never loaded. The
direction line, the by-schema rollup and a dev↔dev comparison each separate them in one click,
which is what §1–§3 above exist for.
