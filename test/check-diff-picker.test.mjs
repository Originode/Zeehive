// CHECK DIFF → PICK THE REFERENCE — the console half of "compare this db against a db I choose,
// production by default".
//
// Why it matters enough to test: the chip's drift colour is drift FROM PRODUCTION, and this menu is
// the only place a human can measure a database against something else. The two things that must
// not rot are (a) production stays the DEFAULT and one click, and (b) a comparison against any other
// db is reported as a REPORT — a human who compared dev↔dev must never be told, or shown, that the
// chip now means that number.
//
// Two halves, no browser:
//   1. diffReportText run for REAL (web/src/drift.js is deliberately React-free so it can be);
//   2. the WIRING, asserted by reading the source — the technique diff-viewer.test.mjs uses,
//      because there is no linter here and a menu item that calls nothing still builds.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { diffReportText, driftDirection } = await import('../web/src/drift.js');

// ── 0. WHICH WAY the drift runs — the reading that turns a total into a diagnosis ───────────────
// This is the line the OmniBiz "the dev dbs are always drifted even after a fresh restore from a
// prod backup" question turned on: every difference there was MISSING and not one was EXTRA, which
// rules out local schema work and points the investigation at what LOADED the database. The two
// counts are exact (never sampled), so the reading is sound.
console.log('\n── driftDirection: subset / superset / both ──');
const kindsOf = (missing, extra) => ({ kinds: { table: { missing_count: missing, extra_count: extra } } });
ok(driftDirection(kindsOf(150, 0)).kind === 'subset', 'only MISSING → a strict SUBSET of the reference');
ok(/SUBSET/.test(driftDirection(kindsOf(150, 0)).text) && /LOADED it/.test(driftDirection(kindsOf(150, 0)).text),
  'and it says to look at what loaded the db, not at the db');
ok(driftDirection(kindsOf(0, 12)).kind === 'superset', 'only EXTRA → a strict SUPERSET');
ok(/drops only what its archive contains/.test(driftDirection(kindsOf(0, 12)).text),
  'and it names the reason extras survive a "fresh restore" (pg_restore --clean drops what the dump HAS)');
ok(driftDirection(kindsOf(3, 4)).kind === 'both', 'both directions → two stories in one number');
ok(driftDirection(kindsOf(0, 0)) === null && driftDirection({}) === null, 'no drift (or no payload) → nothing said');

// ── 1. the report a human reads ─────────────────────────────────────────────────────────────────
console.log('\n── diffReportText: what the comparison SAYS ──');
const prodRef = { id: 'p', name: 'db_prod', tier: 'prod', is_prod: true };
const devRef = { id: 'd', name: 'db_dev', tier: 'dev', is_prod: false };
const kinds = { table: { missing_count: 2, extra_count: 1, missing: ['core.a', 'legacy.b'], extra: ['core.c'] } };

const vsProd = diffReportText('db_spin', {
  ok: true, total: 3, reference: prodRef, persisted: true, kinds,
  by_schema: [{ schema: 'core', missing: 1, extra: 1 }, { schema: 'legacy', missing: 1, extra: 0 }],
});
ok(vsProd.includes('db_spin') && vsProd.includes('db_prod (production)'),
  'it names BOTH databases — a report you cannot mis-attribute');
ok(/DRIFTED — 3 difference/.test(vsProd), 'the exact total is stated');
ok(vsProd.includes('by schema:') && vsProd.includes('legacy — 1 missing, 0 extra'),
  'the by_schema rollup is shown (one schema owning all the drift is the usual culprit)');
ok(vsProd.indexOf('− core.a') < vsProd.indexOf('+ core.c'),
  'MISSING objects come first — prod has them and this db does not, which is what breaks code');
ok(/drift mark now shows this verdict/.test(vsProd), 'a PROD comparison says the chip now shows it');

const vsDev = diffReportText('db_spin', { ok: true, total: 3, reference: devRef, persisted: false, kinds });
ok(/report only/.test(vsDev) && /unchanged/.test(vsDev),
  'a NON-prod comparison says it is a report and the chip is unchanged (the invariant, in words)');
ok(!/production\)/.test(vsDev.split('\n')[1] || ''), 'a non-prod reference is not labelled production');

const truncated = diffReportText('db_spin', {
  ok: true, total: 100, reference: prodRef, persisted: true,
  kinds: { table: { missing_count: 100, extra_count: 0, missing: ['core.a'], extra: [] } },
});
ok(/\+99 more missing/.test(truncated), 'a sampled list says how many names it is NOT showing');

ok(/nothing to diff/.test(diffReportText('db_x', { ok: true, same_db: true, total: 0, reference: prodRef })),
  'the same database on both sides → "nothing to diff", not a fake 0-drift verdict');
ok(/could not compare/.test(diffReportText('db_x', { ok: false, error: 'boom', reference: prodRef })),
  'a failed comparison is reported as a failure, never as "in sync"');
ok(/MATCHES/.test(diffReportText('db_x', { ok: true, total: 0, reference: prodRef, persisted: true, kinds: {} })),
  'zero differences reads as a match');

// ── 2. the wiring ───────────────────────────────────────────────────────────────────────────────
console.log('\n── the menu, the client and the route are actually connected ──');
const chip = read('web/src/Container.jsx');
const api = read('web/src/api.js');
const routes = read('server/src/api/routes.js');
const pd = read('server/src/queenzee/proddiff.js');

ok(/data-testid="check-diff-open"[\s\S]{0,200}runCheckDiff\(null\)/.test(chip),
  'the primary "Check diff" item still fires the DEFAULT (null = production) — one click');
ok(/data-testid="check-diff-pick"/.test(chip) && /data-testid="check-diff-picker"/.test(chip),
  'a "Compare against…" item opens a picker');
ok(/check-diff-against-\$\{d\.id\}[\s\S]{0,400}runCheckDiff\(d\.id\)/.test(chip),
  'each candidate row runs the comparison against THAT db');
ok(/<ContainerChip c=\{\{ \.\.\.d, url: null \}\} \/>/.test(chip),
  'a candidate is drawn as the REAL container chip (one rendering of a container, everywhere)');
ok(/\.ctxdbpick .cbox|\.ctxchip \{[^}]*pointer-events: none/.test(read('web/src/styles.css')),
  'the chips in the picker are click-through, so the row is what gets clicked');
ok(/getDiffCandidates/.test(chip) && /export async function getDiffCandidates/.test(api),
  'the candidate list is fetched from the server (which owns the prod-first order)');
ok(/checkContainerDiff\(c\.id, against\)/.test(chip)
   && /export async function checkContainerDiff\(containerId, against = null\)/.test(api),
  'the chosen reference is passed through the api client');
ok(/JSON\.stringify\(\{ against: against \|\| null \}\)/.test(api), 'it is sent as body.against');
ok(/diffOneContainerAgainstProd\(req\.params\.id, req\.body\?\.against \|\| null\)/.test(routes),
  'the check-diff route reads body.against (absent → production)');
ok(/diff-candidates/.test(routes) && /export async function diffCandidates/.test(pd),
  'the candidate route exists and is served by proddiff');
ok(/const persist = reference\.is_prod && c\.tier !== 'prod'/.test(pd),
  'the server persists a verdict ONLY for a prod reference on a non-prod db');
ok(/disabled=\{!!diffing\}/.test(chip), 'the items are disabled while a comparison is in flight');

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);
