// THE APPROACH QUEUE ON SCREEN — proving a queued zee is VISIBLE to a human.
//
// The runway (067) is only half a protocol until the console renders it. Before this, a human
// approving a landing had no way to know that two more zees were stacked behind that one decision,
// and a holding zee's hexagon was indistinguishable from an idle one. A protocol whose human surface
// does not exist must not reach production — so this test exists to make the surface provable.
//
// It RENDERS THE REAL COMPONENT rather than grepping it (the manager-hexagon precedent): Landing.jsx
// is transformed with esbuild and rendered with react-dom/server, so what is asserted is the markup a
// human would actually read. The server half is exercised against the real read models.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. the hive vocabulary stays in lockstep (the two-file rule hive-status.js states) ──
console.log('\n── the holding hexagon exists in both halves ──');
const { HIVE_STATUS, hiveStatus, hiveLabel } = await import('../server/src/lib/hive-status.js');
ok(!!HIVE_STATUS['occ-landHolding'], 'the server vocabulary has occ-landHolding');
ok(hiveLabel('occ-landHolding') === 'holding',
   `and its label is a STATE, not a question (${hiveLabel('occ-landHolding')}) — nobody is being asked anything`);
const palette = read('web/src/hive/status.js');
for (const block of ['HIVE_COLORS', 'HIVE_HEAT', 'HIVE_LABELS']) {
  ok(new RegExp(`${block} = \\{[^}]*'occ-landHolding'`, 's').test(palette), `the web palette's ${block} carries it`);
}

// PRECEDENCE is the whole argument for this key: it must never outrank something a human must act
// on, and must outrank plain activity (a queued zee that reads as "idle" is the invisibility the
// protocol would otherwise introduce).
console.log('\n── where it ranks ──');
const xell = { status: 'working', zee_status: 'working' };
ok(hiveStatus(xell, { landHolding: true }) === 'occ-landHolding',
   'a holding zee reads `holding`, not `working` — it answers "why has this one gone quiet?"');
for (const sig of ['tendPending', 'landPending', 'shipPending', 'seedPending', 'prodBindPending',
                   'doneSuggested', 'landHint', 'shipHint']) {
  ok(hiveStatus(xell, { landHolding: true, [sig]: true }) !== 'occ-landHolding',
     `${sig} still wins over holding — an ask a human must answer outranks a queue`);
}
ok(hiveStatus({ status: 'awaiting-done' }, { landHolding: true }) === 'occ-doneRequest',
   'and so does the zee\'s own done proposal');

// ── 2. the read model: position, slug, commits — numbered the way the tower calls them ──
console.log('\n── the server hands the console a queue ──');
const lg = await import('../server/src/queenzee/landgate.js');
ok(typeof lg.holdingByRef === 'function', 'landgate exports holdingByRef (the console read model)');
const src = read('server/src/queenzee/landgate.js');
const fn = src.slice(src.indexOf('export async function holdingByRef'));
ok(/row_number\(\) OVER \(PARTITION BY lr\.project_id, lr\.ref/.test(fn),
   'position is numbered per RUNWAY (project, ref), not across the whole project');
ok(/ORDER BY lr\.requested_at, lr\.id/.test(fn),
   'in the same (requested_at, id) order the tower clears them — one ordering, so the number a zee is told cannot disagree with the number a human reads');
ok(/status='holding' AND lr\.cleared_at IS NULL/.test(fn), 'cleared holders are out of the queue');
ok(/lr\.kind='push'/.test(fn), 'and a PR is never in it');
ok(/holding,/.test(read('server/src/lib/fleet.js')), 'the fleet read model ships it to the console');
ok(!/status IN \('pending','approved','holding'\)/.test(read('server/src/lib/fleet.js')),
   'and does NOT smuggle holding into the open-landing list — that list is cards a human must answer');

// ── 3. RENDER IT. What does a human actually see? ──
console.log('\n── the rendered markup ──');
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const tmp = resolve(here, '..', 'web/src/.land-queue.test-build.mjs');
writeFileSync(tmp, transformSync(read('web/src/Landing.jsx'), { loader: 'jsx', format: 'esm' }).code
  // The component's siblings are irrelevant to what a human READS and drag in the whole app, so each
  // import is stubbed with just the names it brought (one blanket stub would redeclare them).
  .replace(/import[^\n]*\.\/(api|Dialog|DiffViewer)\.jsx?['"];?/g, (_m, mod) => ({
    api: 'const decideLanding=()=>{},withdrawLanding=()=>{};',
    Dialog: 'const showConfirm=()=>{};',
    DiffViewer: 'const showDiff=()=>{};',
  }[mod])));
let LandCard, LandingPanel;
try {
  const mod = await import(`${tmp}?t=${process.pid}`);
  LandCard = mod.LandCard; LandingPanel = mod.default;
} finally { rmSync(tmp, { force: true }); }

const req = {
  id: 'r1', xell_slug: 'first-zee', ref: 'refs/heads/main', status: 'pending',
  old_sha: 'a'.repeat(40), new_sha: 'b'.repeat(40), requested_at: new Date().toISOString(),
  commits: [{ short: 'abc1234', subject: 'the work', author: 'zee' }], stat: { files: 2, insertions: 9, deletions: 1 },
};
const queue = [
  { id: 'h1', xell_slug: 'second-zee', position: 1, new_sha: 'c'.repeat(40), commit_count: 3, holding_since: new Date().toISOString() },
  { id: 'h2', xell_slug: 'third-zee', position: 2, new_sha: 'd'.repeat(40), commit_count: 1, holding_since: new Date().toISOString() },
];
const html = renderToStaticMarkup(React.createElement(LandCard, { req, queue }));
ok(/2 zees are holding for this runway/.test(html), 'the card says HOW MANY zees are waiting on this decision');
ok(/second-zee/.test(html) && /third-zee/.test(html), 'it names them');
ok(/#1/.test(html) && /#2/.test(html), 'with their positions, in order');
ok(html.indexOf('second-zee') < html.indexOf('third-zee'), 'and #1 is rendered before #2');
ok(/3 commits waiting/.test(html) && /1 commit waiting/.test(html),
   'and how much work is queued behind the decision (singular/plural both right)');
ok(!/<button[^>]*>[^<]*(Approve|Reject|Withdraw)[^<]*<\/button>[\s\S]*land-queue/.test(html.split('land-queue')[1] || ''),
   'the queue carries NO buttons — only one thing on a runway is ever a question');
ok(/deciding this one clears the next/.test(html),
   'and it says what approving above actually does — the consequence is the point');

// A landing with nothing behind it must look exactly as it did before.
const plain = renderToStaticMarkup(React.createElement(LandCard, { req, queue: [] }));
ok(!/holding for this runway/.test(plain), 'an empty queue renders nothing at all (no empty box)');

// APPROVED + collapsed: the queue must survive, because that is when it matters most.
const mini = renderToStaticMarkup(React.createElement(LandCard, {
  req: { ...req, status: 'approved', decided_by: 'human@test' }, queue }));
ok(/holding for this runway/.test(mini), 'a collapsed, approved card still shows who is waiting on it');

// The orphan panel: holders whose runway has no card must still land on a screen.
const orphan = renderToStaticMarkup(React.createElement(LandingPanel, {
  landing: [], orphanQueues: [{ ref: 'refs/heads/main', queue }] }));
ok(/holding for/.test(orphan) && /second-zee/.test(orphan),
   'zees holding for a runway with no card are rendered, not lost');
ok(/nothing is on that runway/.test(orphan), 'and the panel says plainly that this is a fault, not a normal state');

// ── 4. the wiring App.jsx has to do (a free identifier here is a runtime throw, not a build error) ──
console.log('\n── App.jsx wiring ──');
const app = read('web/src/App.jsx');
ok(/fleet\.holding/.test(app), 'App reads fleet.holding');
ok(app.indexOf('const holdingByRef') < app.indexOf('withQueue(r)'),
   'and defines the queue map BEFORE routing landings through it (a const used above its declaration throws)');
ok(/orphanQueues=\{orphanQueues\}|orphanQueues={orphanQueues}/.test(app), 'the orphan queues are passed to the panel');
ok(/queue = req\.queue/.test(read('web/src/Landing.jsx')),
   'LandCard defaults its queue from the row, so every one of its three render sites gets it');

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);
