// SCHEMA DRIFT IS NOT A DATA CHECK — TKT-22-4F0E ("any restore on a dev db from latest prod dump
// always has a big diff from prod db … and im afraid the data might not be fully backed up").
//
// The ticket asks two questions and the console answered them with ONE number. This test pins the
// separation, because the separation is the fix:
//
//   1. WHY A FRESH RESTORE DRIFTS. The ruler is LIVE prod; a restore is the dump's instant. Every
//      object prod migrates after the dump reads as `missing` — real drift, dangerous direction,
//      correctly reported. Evidence from the live fleet on 2026-07-29: three Zeehive pool dbs, same
//      code, same prod, read 0 / 12 / 21 — and the 12 and 21 were exactly one and two migrations'
//      worth of objects (public.project_doc, then land_request.holding_since & friends). So the
//      payload now carries `prod_count`/`mine_count`, and one-directional drift is nameable as AGE.
//   2. WHAT THE NUMBER COVERS. proddiff reads catalogs. It counts no rows and opens no dump, so it
//      can neither confirm nor deny a backup. Every payload declares that (`scope`, `covers`,
//      `data_compared:false`) and every surface that renders it must SAY it — asserted here against
//      the real Container.jsx text and the real Backups.jsx row, not against a promise in a commit.
//   3. EMPTY IS NOT DRIFTED. A db with none of prod's tables was never restored. Scoring that as
//      "12,802 differences" is what made a never-used dev clone (omnibiz_db_prod_dev_local_mardale_prod)
//      look like a data-loss event. `empty_db` says the true thing instead.
//
// diffPayload is pure, so 1–3 run against real Sets with no docker and no prod. The console half
// renders the REAL component with react-dom/server (the project-docs-console.test.mjs precedent).
process.env.PRODDIFF_ENABLED = 'false';

import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const { diffPayload, DIFF_COVERS } = await import('../server/src/queenzee/proddiff.js');

// A fingerprint is { table:Set, column:Set, trigger:Set } — exactly what fingerprint() builds.
const fp = (tables, columns = [], triggers = []) =>
  ({ table: new Set(tables), column: new Set(columns), trigger: new Set(triggers) });

// ── 1. the payload declares its SCOPE, and that data was not compared ───────────────────────────
console.log('\n── every verdict states what it measured ──');
const prod = fp(['public.xell', 'public.project_doc'],
                ['public.xell.id:uuid', 'public.project_doc.body:text'],
                ['public.xell.trg_a']);
const behind = fp(['public.xell'], ['public.xell.id:uuid'], ['public.xell.trg_a']);

const drifted = diffPayload(prod, behind);
ok(drifted.scope === 'schema', 'payload.scope says "schema"');
ok(Array.isArray(drifted.covers) && drifted.covers.join(',') === 'table,column,trigger',
   `payload.covers names the kinds it compared (${DIFF_COVERS.join(', ')})`);
ok(drifted.data_compared === false, 'payload.data_compared is FALSE — no rows were read');
ok(/row data/i.test(drifted.not_covered || ''), 'and payload.not_covered names row data explicitly');
ok(drifted.total === 2, 'the total still counts every catalog difference (1 table + 1 column; the trigger matches)');

// ── 2. AGE is visible: prod has N, this db has M ────────────────────────────────────────────────
console.log('\n── a restore that is merely OLDER than prod is readable as such ──');
ok(drifted.kinds.table.ref_count === 2 && drifted.kinds.table.mine_count === 1,
   'per-kind ref_count/mine_count are carried (reference 2 tables / here 1) — not just "2 differences"');
ok(drifted.kinds.table.missing[0] === 'public.project_doc' && drifted.kinds.table.extra_count === 0,
   'the missing object is named, and nothing is EXTRA — the one-directional signature of a stale copy');
ok(drifted.empty_db === false, 'a db that is one migration behind is NOT flagged empty');

// A db AHEAD of prod (a xell that applied its own migration) is the mirror image, and must not be
// mistaken for the same thing: something is extra, so it is not "behind".
const ahead = diffPayload(prod, fp(['public.xell', 'public.project_doc', 'public.mine'],
  ['public.xell.id:uuid', 'public.project_doc.body:text'], ['public.xell.trg_a']));
ok(ahead.kinds.table.extra_count === 1 && ahead.kinds.table.missing_count === 0,
   'unshipped local work shows as EXTRA, never as missing');

// ── 3. EMPTY is not DRIFTED ─────────────────────────────────────────────────────────────────────
console.log('\n── a database with none of prod\'s tables was never restored ──');
const emptyDb = diffPayload(prod, fp([], [], []));
ok(emptyDb.empty_db === true, 'no application tables at all → empty_db: true');
ok(emptyDb.kinds.table.ref_count === 2 && emptyDb.kinds.table.mine_count === 0,
   'and it reports the reference has 2 and this db has 0 — the fact, not a difference count');
// The ruler itself being empty is NOT a claim about the measured db (a prod probe that read nothing
// would otherwise flag every db in the fleet as empty).
ok(diffPayload(fp([]), fp([])).empty_db === false,
   'when PROD reports no tables either, nothing is called empty (never blame the measured db for an unreadable ruler)');

// ── 4. the SERVER says it in the log line an operator watches ───────────────────────────────────
console.log('\n── the terminal line carries the same caveat ──');
const src = read('server/src/queenzee/proddiff.js');
ok(/SCHEMA difference\(s\)/.test(src) && /nothing here is a statement about row data/.test(src),
   'the drift logline says SCHEMA and disclaims row data');
ok(/has NO application tables at all/.test(src), 'and an empty db is logged as empty, not as drift');
ok(/point-in-time/.test(src), 'and the log names the point-in-time cause of a fresh restore\'s gap');

// ── 5. the CONSOLE says it where the number is read ─────────────────────────────────────────────
console.log('\n── the chip a human hovers ──');
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const tmp = resolve(here, '..', 'web/src/.proddiff-scope.test-build.mjs');
writeFileSync(tmp, transformSync(read('web/src/Container.jsx'), { loader: 'jsx', format: 'esm' }).code
  .replace(/import[^\n]*\.\/(api|Dialog|nick)\.jsx?['"];?/g, (_m, mod) => ({
    api: 'const buildContainer=async()=>{},getDockerContexts=async()=>[],setContainerBuildCtx=async()=>{},'
       + 'decommissionContainer=async()=>{},checkContainerDiff=async()=>({}),duplicateProd=async()=>({});',
    Dialog: 'const showAlert=async()=>{},showConfirm=async()=>true;',
    nick: 'const nick=(n)=>String(n).slice(0,3);',
  }[mod] || '')));
let ContainerChip, driftText;
try {
  const mod = await import(`${tmp}?t=${process.pid}`);
  ContainerChip = mod.ContainerChip; driftText = mod.driftText;
} finally { rmSync(tmp, { force: true }); }
ok(typeof driftText === 'function', 'driftText is exported so its wording is testable, not just visible');

const chip = (prod_diff) => renderToStaticMarkup(React.createElement(ContainerChip, {
  c: { id: 'c1', name: 'zeehive_db_spin_x', role: 'db', tier: 'spinoff', health: 'up',
       prod_diff, prod_diff_at: '2026-07-29T21:59:29.561Z' },
}));

// The DRIFTED reading: scope + the age explanation, on the tooltip the operator actually hovers.
const html = chip(drifted);
ok(/SCHEMA drifted from prod/.test(html), 'a drifted chip says SCHEMA drifted (not just "DRIFTED")');
ok(/SCHEMA only/.test(html), 'the tooltip states the scope: schema only');
ok(/row data/.test(html) && /(backed up|fully backed up)/.test(html),
   'and says in so many words that it cannot confirm or deny that data is backed up');
// The WHICH-WAY sentence comes from drift.js (driftDirection), so the glance and the on-demand
// report cannot disagree about what "everything missing, nothing extra" means.
ok(/strict SUBSET of the reference/.test(html),
   'and explains why a faithful restore still shows missing objects — one-directional drift is a stale LOAD');
ok(/prod 2 \/ here 1/.test(html), 'the counts ride along, so "behind" is visible at a glance');

// The GREEN reading needs the caveat MOST: "✓ schema matches prod" with nothing after it is the
// sentence that gets quoted back as "the backup is fine".
const green = chip(diffPayload(prod, prod));
ok(/schema matches prod/.test(green) && /row data/.test(green),
   'a GREEN chip also states the limit — a 0 is not a data guarantee');

// EMPTY says empty.
const emptyHtml = chip(emptyDb);
ok(/EMPTY/.test(emptyHtml) && /never restored/.test(emptyHtml),
   'an empty db reads as "EMPTY … never restored", not as a huge drift number');
ok(!/difference\(s\)/.test(emptyHtml), 'and it does not report a difference COUNT at all');

// The other half of the same confusion: the on-demand "Check diff" report. Its words live in
// drift.js (shared with the picker this landed beside), so assert the REAL renderer, and assert that
// the caveat rides the GREEN outcome too — that is the one that gets quoted as reassurance.
const { diffReportText } = await import('../web/src/drift.js');
const ref = { name: 'omnibiz_db_prod', is_prod: true };
const greenReport = diffReportText('dev_db', { ok: true, total: 0, kinds: {}, reference: ref, persisted: true });
ok(/SCHEMA only/.test(greenReport) && /counts no rows/.test(greenReport),
   'the "Check diff" report states its scope on the GREEN outcome');
const red = diffReportText('dev_db', { ...drifted, reference: ref, persisted: true });
ok(/SCHEMA only/.test(red), 'and on the drifted one');
const emptyReport = diffReportText('dev_db', { ...emptyDb, reference: ref, persisted: true });
ok(/EMPTY/.test(emptyReport) && /never restored/.test(emptyReport) && /omnibiz_db_prod \(production\) has 2/.test(emptyReport),
   'and an empty database is reported as EMPTY, naming what the reference holds');
ok(!/difference\(s\)/.test(emptyReport), 'never as a difference COUNT');

// ── 6. the BACKUPS panel — where "is my data backed up?" is actually asked ──────────────────────
console.log('\n── the backups row answers with what the archive contains ──');
const bk = read('web/src/Backups.jsx');
ok(/toc_tables\)\s*&&\s*b\.toc_tables\.length\s*>\s*0/.test(bk),
   'a finished backup row shows the table count read back out of the written archive');
ok(/tables in archive/.test(bk), 'labelled as what is IN the archive');
ok(/NOT VERIFIED: row counts/.test(bk),
   'and states the limit of that proof: tables are verified, rows are not counted');

// ── 7. BACKUP FRESHNESS — the reading that DOES speak to the data fear ──────────────────────────
// "Last backup: (27 hours ago)" cannot be graded without the interval, and a FAILED attempt in
// between left no mark at all — while backupDue() counts that failed row as the window's attempt, so
// one failure delays the next good dump by a full interval. Live evidence, from the meta-db this xell
// was cloned from: omnibiz backs up every 12h; its last GOOD dump was 2026-07-28 18:30 and the newest
// attempt (2026-07-29 19:32) FAILED — two windows missed, nothing on the panel saying so.
console.log('\n── an overdue or failed backup is visible where the human reads it ──');
const tmp2 = resolve(here, '..', 'web/src/.backups-fresh.test-build.mjs');
writeFileSync(tmp2, transformSync(read('web/src/Backups.jsx'), { loader: 'jsx', format: 'esm' }).code
  .replace(/import[^\n]*\.\/(api|Dialog)\.jsx?['"];?/g, (_m, mod) => ({
    api: 'const getBackups=async()=>({}),setBackupConfig=async()=>{},runBackup=async()=>{},'
       + 'revealBackup=async()=>{},restoreBackup=async()=>{},deleteBackup=async()=>{},cancelBackup=async()=>{},subscribe=()=>()=>{};',
    Dialog: 'const showConfirm=async()=>true,showPrompt=async()=>null,showAlert=async()=>{};',
  }[mod] || '')));
let BackupsPanel, backupFreshness;
try {
  const mod = await import(`${tmp2}?t=${process.pid}`);
  BackupsPanel = mod.default; backupFreshness = mod.backupFreshness;
} finally { rmSync(tmp2, { force: true }); }

const H = 3600 * 1000;
const twelveH = { config: { backup_interval_sec: 43200 } };
const onTime = backupFreshness({ ...twelveH,
  last: { taken_at: new Date(Date.now() - 2 * H).toISOString() },
  last_attempt: { taken_at: new Date(Date.now() - 2 * H).toISOString(), status: 'finished' } });
ok(onTime.state === 'ok' && onTime.failedSince === false, 'a backup inside its interval reads ok');

// The real omnibiz shape: last good dump 25h ago on a 12h policy, newest attempt failed since.
const omni = { ...twelveH,
  last: { taken_at: new Date(Date.now() - 25 * H).toISOString() },
  last_attempt: { taken_at: new Date(Date.now() - 2 * H).toISOString(), status: 'failed',
                  error: 'interrupted by server restart' } };
const f = backupFreshness(omni);
ok(f.state === 'overdue', 'a good dump older than its interval reads OVERDUE');
ok(f.missedWindows === 2, 'and says HOW MANY windows went by (2)');
ok(f.failedSince === true, 'and that the newest ATTEMPT failed after the last success');
ok(backupFreshness({ ...twelveH, last: null, last_attempt: null }).state === 'none',
   'no backup at all is its own state, never "ok"');
// A success AFTER the failure clears it — the panel must not cry about yesterday's failure forever.
ok(backupFreshness({ ...twelveH,
  last: { taken_at: new Date(Date.now() - 1 * H).toISOString() },
  last_attempt: { taken_at: new Date(Date.now() - 3 * H).toISOString(), status: 'failed' } }).failedSince === false,
   'a failure OLDER than the last success is not reported as outstanding');

const panel = renderToStaticMarkup(React.createElement(BackupsPanel, { backup: omni, projectId: 'p1' }));
ok(/overdue/.test(panel), 'the panel renders an "overdue" mark');
ok(/last attempt failed/.test(panel), 'and an "last attempt failed" mark — two facts, said separately');
ok(/interrupted by server restart/.test(panel), 'naming the failure reason the operator needs');
ok(/separate question/.test(panel),
   'and it keeps the split: backup AGE is not a statement about a dump\'s CONTENTS');
const clean = renderToStaticMarkup(React.createElement(BackupsPanel, {
  backup: { ...twelveH, last: { taken_at: new Date(Date.now() - 1 * H).toISOString() },
            last_attempt: { taken_at: new Date(Date.now() - 1 * H).toISOString(), status: 'finished' } },
  projectId: 'p1' }));
ok(!/overdue|last attempt failed/.test(clean), 'a healthy schedule shows neither mark (no crying wolf)');

// The server has to SEND last_attempt or the panel can never know (the seam, asserted once).
ok(/last_attempt: lastAttempt/.test(read('server/src/lib/fleet.js')),
   'fleet.js sends the newest ATTEMPT alongside the newest success');

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
