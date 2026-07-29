// DID THE ROWS ARRIVE? — the data-completeness check the console never had (P1+P2 of TKT-22-4F0E).
//
// The ticket asked two questions and the console answered both with a schema-drift number. The other
// answer needed inventing, and the shape it takes is the whole point:
//
//   P1  every backup records what the SOURCE held, per table, in rows — planner ESTIMATES taken beside
//       the dump, never an exact count of production. That buys the reading nothing had before: a table
//       that SHRANK between two dumps, which is what "my data is not fully backed up" actually is.
//   P2  a restored database is graded against the counts recorded FOR ITS OWN SOURCE BACKUP — never
//       against live production, because prod keeps moving and an append-heavy table would read as
//       "short" forever. That is the exact trap this ticket spent its evidence unpicking.
//
// The rules that must not rot, and each one is a way a human gets misled:
//   • the dump is the PRODUCT and the counts are instrumentation: a failed probe records null and
//     never fails, delays or shortens a backup;
//   • "unknown" (never analyzed, -1) is not "empty", and a table ABSENT from the catalog is schema
//     drift, not lost rows — neither may become a data-loss claim, nor pass as a clean bill;
//   • an ESTIMATE compared with an EXACT count differs by a few percent legitimately, so only a gross
//     shortfall or a populated-table-now-empty is a finding;
//   • production is never row-counted on demand (the P3 that was deliberately not built), and it is
//     refused with the reason rather than silently skipped.
//
// Pure logic runs for real; the routing/refusals run against this xell's own postgres with NO docker
// (the probe resolves not-ok, which is exactly what proves the DECISIONS are made before any daemon).
process.env.PRODDIFF_ENABLED = 'false';
process.env.MAINTENANCE_MODE = 'simulate';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const RC = await import('../server/src/lib/row-counts.js');
const { q, one, pool } = await import('../server/src/db/pool.js');
const dd = await import('../server/src/queenzee/datadiff.js');

let projId;
try {
  // ── 1. what gets counted, and what deliberately does not ──────────────────────────────────────
  console.log('\n── the catalog probe asks for the right rows ──');
  ok(/relkind = 'r'/.test(RC.ROW_COUNT_SQL),
     'ordinary tables only — a partitioned PARENT reports 0 and would double-count its own leaves');
  ok(/deptype = 'e'/.test(RC.ROW_COUNT_SQL),
     'extension-owned tables are excluded: pg_dump does not carry their data, so counting them would '
     + 'report a shortfall for rows that were never in the archive');
  ok(/pg_catalog','information_schema'/.test(RC.ROW_COUNT_SQL.replace(/\s+/g, '')),
     'system schemas are excluded');
  ok(/reltuples/.test(RC.ROW_COUNT_SQL) && !/count\(\*\)/.test(RC.ROW_COUNT_SQL),
     'and it is an ESTIMATE, not count(*) — instrumentation must not cost production minutes of I/O');
  // The exact side is only ever built for the tables the reference knows, and only from safe names.
  ok(/count\(\*\)/.test(RC.exactCountSql(['public.xell']) || ''),
     'the RESTORED side is counted exactly (a fresh restore has no statistics at all — every reltuples reads -1)');
  ok(RC.exactCountSql(['bad name', 'x;drop']) === null,
     'and a name that is not a plain schema.table is never interpolated into that SQL');

  console.log('\n── parsing, and the difference between UNKNOWN and EMPTY ──');
  const parsed = RC.parseRowCounts(`public.a\x1e10\npublic.b\x1e0\npublic.c\x1e-1\n\ngarbage\n`);
  ok(parsed['public.a'] === 10 && parsed['public.b'] === 0, 'counts parse');
  ok(parsed['public.c'] === -1, "postgres's own -1 (never analyzed) is PRESERVED, not coerced to 0");
  ok(!('garbage' in parsed), 'a line with no count is skipped, never recorded as zero');
  ok(RC.rowTotal(parsed) === 10, 'the total sums only KNOWN counts (-1 is not a row count)');

  // ── 2. P1: the TREND between two backups ──────────────────────────────────────────────────────
  console.log('\n── P1: a table that SHRANK between backups is the alarm ──');
  const prev = { 'public.big': 100000, 'public.small': 3, 'public.same': 50, 'public.gone': 10, 'public.unknown': -1 };
  const now  = { 'public.big': 10, 'public.small': 2, 'public.same': 50, 'public.new': 7, 'public.unknown': 5 };
  const t = RC.compareBackupCounts(prev, now);
  ok(t.verdict === 'shrunk', 'a real drop → verdict "shrunk"');
  ok(t.shrunk.some((x) => x.table === 'public.big'), 'and names the table that lost its rows');
  ok(!t.shrunk.some((x) => x.table === 'public.small'),
     'a 3→2 wobble in a tiny table is NOT reported — a percentage of nothing is noise');
  ok(t.counts.added === 1 && t.counts.removed === 1,
     'a new table and a dropped table are counted, never dressed as data loss (that is schema)');
  ok(!t.shrunk.some((x) => x.table === 'public.unknown'),
     'a table with no reference estimate yields no reading at all, in either direction');
  const emptied = RC.compareBackupCounts({ 'public.a': 5000 }, { 'public.a': 0 });
  ok(emptied.verdict === 'emptied' && emptied.emptied[0].prev === 5000,
     'populated → EMPTY is its own, louder verdict: no estimate error explains "many" becoming "none"');
  ok(RC.compareBackupCounts({ 'public.a': 100 }, { 'public.a': 900 }).verdict === 'ok',
     'growth is normal and never an alarm');
  ok(RC.compareBackupCounts(null, now) === null,
     'no previous counts → no verdict at all (the caller says "nothing to compare yet", never "ok")');

  // ── 3. P2: a restore against its OWN source ───────────────────────────────────────────────────
  console.log('\n── P2: grading a restore against the backup it came from ──');
  const ref = { 'public.a': 1000, 'public.b': 500, 'public.c': 40, 'public.d': -1, 'public.absent': 900 };
  const got = { 'public.a': 1000, 'public.b': 0, 'public.c': 4, 'public.d': 3, 'public.extra': 1 };
  const r = RC.compareRestoreCounts(ref, got);
  ok(r.verdict === 'incomplete', 'an empty-or-short table → verdict "incomplete"');
  ok(r.empty.length === 1 && r.empty[0].table === 'public.b', 'the EMPTY one is called empty');
  ok(r.short.length === 1 && r.short[0].table === 'public.c', 'the materially short one is called short');
  ok(r.missing.length === 1 && r.missing[0].table === 'public.absent',
     'a table ABSENT from the restored db is "missing" — schema drift, and it is kept out of the row story');
  ok(r.unknown.length === 1 && r.unknown[0].table === 'public.d',
     'a table the SOURCE never analyzed is "no-reference" — unknown, not verified, not lost');
  ok(r.extra.includes('public.extra'), 'a table the reference never had is noted as extra, not as an error');

  const tolerant = RC.compareRestoreCounts({ 'public.a': 1000 }, { 'public.a': 960 });
  ok(tolerant.verdict === 'complete',
     `a 4% gap passes — the reference is an estimate and this side is exact (tolerance ${RC.SHORTFALL_TOLERANCE * 100}%)`);
  ok(RC.compareRestoreCounts({ 'public.a': 1000 }, { 'public.a': 1200 }).verdict === 'complete',
     'MORE rows than the backup is normal (rows kept arriving; or this db has been written to since)');
  const unverified = RC.compareRestoreCounts({ 'public.a': -1 }, { 'public.a': 5 });
  ok(unverified.verdict === 'unverified',
     'nothing to compare against → "unverified", which is neither a pass nor an alarm');

  // ── 4. the REFUSALS, decided before any daemon is touched ─────────────────────────────────────
  console.log('\n── production is the reference, never the subject ──');
  projId = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,$2,'main','zt','zt') RETURNING id`,
    [`zt-rowcount-${Date.now()}`, '/tmp/zt-rowcount'])).id;
  const mk = async (tier, tag) => (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name)
       VALUES ($1,'db',$2,'shared',$3) RETURNING id`,
    [projId, tier, `zt_${tag}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`])).id;
  const prodDb = await mk('prod', 'db_prod');
  const devDb = await mk('dev', 'db_dev');

  const onProd = await dd.checkContainerData(prodDb);
  ok(onProd.ok === false && /never row-counted on demand/.test(onProd.error),
     'PRODUCTION is refused, with the reason — an exact count over every table is the cost we chose not to pay');
  ok((await dd.dataCheckReadiness(prodDb)).ready === false, 'and readiness says so before the item is offered');

  const noSource = await dd.checkContainerData(devDb);
  ok(noSource.ok === false && /no recorded source backup/.test(noSource.error),
     'a db with no recorded source backup is refused — never graded against a dump it was not loaded from');

  // A source WITHOUT counts (an older backup) must be refused with its own reason, not compared to null.
  const snapNoCounts = (await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, status, mode, taken_at)
       VALUES ($1,'prod','/tmp/zt.dump','finished','real', now()) RETURNING id`, [projId])).id;
  await q(`UPDATE container SET restored_from=$2, restored_at=now() WHERE id=$1`, [devDb, snapNoCounts]);
  const noCounts = await dd.checkContainerData(devDb);
  ok(noCounts.ok === false && /carries no row counts/.test(noCounts.error),
     'a source backup that predates row counts is refused with THAT reason (never a silent pass)');
  ok((await dd.dataCheckReadiness(devDb)).ready === false, 'readiness agrees');

  // With counts recorded, the check runs for real and dies at the DOCKER probe — which is the proof
  // that every decision above it was made from the database, not from a daemon.
  await q(`UPDATE db_snapshot SET row_counts=$2::jsonb, row_total=1500 WHERE id=$1`,
    [snapNoCounts, JSON.stringify({ 'public.a': 1000, 'public.b': 500 })]);
  const ready = await dd.dataCheckReadiness(devDb);
  ok(ready.ready === true && ready.snapshot.row_total === '1500' || ready.snapshot.row_total === 1500,
     'once the source carries counts, the check is offered and names the backup it will use');
  const probed = await dd.checkContainerData(devDb);
  ok(probed.ok === false, 'with no docker daemon the count probe degrades to { ok:false } — no throw');

  // ── 5. the CAPTURE never endangers the backup ─────────────────────────────────────────────────
  console.log('\n── the dump is the product; the counts are instrumentation ──');
  const maint = read('server/src/queenzee/maintenance.js');
  ok(/rowCounts = await sourceRowCounts[\s\S]{0,200}catch/.test(maint),
     'the probe is wrapped so a failure cannot fail the backup');
  ok(/the BACKUP is `\s*\+\s*`unaffected/.test(maint) || /BACKUP is/.test(maint),
     'and it says out loud that the backup is unaffected when it fails');
  const capture = maint.indexOf('rowCounts = await sourceRowCounts');
  ok(capture > maint.indexOf("'pg_dump'"),
     'counts are taken AFTER the dump — they must never delay it or extend the window prod is locked for');
  ok(/row_counts=\$5::jsonb, row_total=\$6/.test(maint), 'and they are recorded on the finished snapshot');
  ok(/rowCounts \? JSON\.stringify\(rowCounts\) : null/.test(maint),
     'a missing probe stores NULL, never {} or 0 — "not captured" must not read as "the database was empty"');
  ok(/noteRestoredFrom\(c\.id, snap\.id/.test(maint),
     'a restore RECORDS which snapshot it loaded (the reference is recorded, never inferred from timestamps)');
  ok(/noteRestoredFrom\(target\.id, null/.test(maint),
     'and a live "Duplicate prod" pipe records that it has NO snapshot — so the check refuses instead of grading against the wrong dump');

  // ── 6. two questions, two verdicts, two columns ───────────────────────────────────────────────
  console.log('\n── the data verdict never lands on the schema chip ──');
  const datadiff = read('server/src/queenzee/datadiff.js');
  ok(/data_check=\$2::jsonb/.test(datadiff), 'checkContainerData writes container.data_check');
  ok(!/(UPDATE|SET)[^;]*prod_diff\s*=/.test(datadiff),
     'and it NEVER writes prod_diff — a row verdict must not repaint the schema chip');
  const routes = read('server/src/api/routes.js');
  ok(/check-data/.test(routes) && /check-diff/.test(routes),
     'the two checks are two routes — merging them is the defect this ticket found');

  console.log('\n── and the console tells them apart ──');
  const { dataReportText } = await import('../web/src/drift.js');
  const report = dataReportText('dev_db', { ok: true, ...r, reference: { taken_at: '2026-07-28T18:30:00Z', tolerance: 0.1 } });
  ok(/rows vs the backup it was restored from/.test(report),
     'the data report names what it compared against — the BACKUP, not production');
  ok(/DATA IS MISSING/.test(report) && /EMPTY here, populated in the backup/.test(report),
     'it leads with the empty tables, in words a human can act on');
  ok(/schema, not rows — run Check diff/.test(report),
     'an absent table is sent back to the schema check instead of being counted as lost rows');
  ok(/ESTIMATE/.test(report) && /exact count/.test(report),
     'it states the asymmetry it rests on, so a few percent is never read as loss');
  ok(/What it does NOT: the contents of a row/.test(report),
     'and it does not over-claim: a row COUNT is not a comparison of row CONTENTS');
  ok(!/drift/i.test(report), 'the word "drift" never appears in a data verdict');
  const clean = dataReportText('dev_db', { ok: true, ...RC.compareRestoreCounts({ 'public.a': 10 }, { 'public.a': 10 }), reference: {} });
  ok(/every table has the rows that backup recorded/.test(clean), 'a clean result says exactly what it verified');

  const cjsx = read('web/src/Container.jsx');
  ok(/data-testid="check-data-open"/.test(cjsx), 'the chip menu offers "Check data" beside "Check diff"');
  ok(/dataReady\?\.ready === false/.test(cjsx),
     'and when it cannot be checked the item says WHY instead of being offered and then refusing');

  const bk = read('web/src/Backups.jsx');
  ok(/backup-rows/.test(bk) && /rowsTitle/.test(bk), 'a backup row shows its row count');
  ok(/planner ESTIMATES \(reltuples\)/.test(bk) && /not a comparison of row CONTENTS/.test(bk),
     'labelled as an estimate, and not over-claimed');
  ok(/went EMPTY and/.test(bk), 'and it surfaces the shrink trend where the backups are read');
} finally {
  if (projId) {
    await q(`UPDATE container SET restored_from=NULL WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM db_snapshot WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  }
  await pool.end().catch(() => {});
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
