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
ok(drifted.kinds.table.prod_count === 2 && drifted.kinds.table.mine_count === 1,
   'per-kind prod_count/mine_count are carried (prod 2 tables / here 1) — not just "3 differences"');
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
ok(emptyDb.kinds.table.prod_count === 2 && emptyDb.kinds.table.mine_count === 0,
   'and it reports prod has 2, this db has 0 — the fact, not a difference count');
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
ok(/point-in-time/.test(html), 'and explains why a faithful restore still shows missing objects');
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

// The other half of the same confusion: the on-demand "Check diff" dialog.
const cjsx = read('web/src/Container.jsx');
const diag = cjsx.slice(cjsx.indexOf('const runCheckDiff'), cjsx.indexOf('const runDuplicateProd'));
ok(/compares SCHEMA only/.test(diag) && /counts no rows/.test(diag),
   'the "Check diff" result dialog states its scope on every outcome');
ok(/empty_db/.test(diag), 'and reports an empty database as empty rather than as drift');

// ── 6. the BACKUPS panel — where "is my data backed up?" is actually asked ──────────────────────
console.log('\n── the backups row answers with what the archive contains ──');
const bk = read('web/src/Backups.jsx');
ok(/toc_tables\)\s*&&\s*b\.toc_tables\.length\s*>\s*0/.test(bk),
   'a finished backup row shows the table count read back out of the written archive');
ok(/tables in archive/.test(bk), 'labelled as what is IN the archive');
ok(/NOT VERIFIED: row counts/.test(bk),
   'and states the limit of that proof: tables are verified, rows are not counted');

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
