// A TEND CARRIES ITS REASON — end to end, checked without a browser or a DB.
//
// The bug this pins: `zee tend` is the ask whose ENTIRE content is its reason (no diff, no commit,
// no Approve button), and the reason was written into session_event.raw and read by nothing. The
// console could only say "this xell wants a human", and its own note told you to open the zee's
// session to find out what for. So the reason must now be REQUIRED when raising, BRIEF (it rides a
// chip and a card row), and CARRIED to every surface a human or a manager reads.
//
// Assertions are of two kinds, mirroring test/prod-asks-console.test.mjs: real calls into the pure
// server logic (briefReason / selfTend's refusal, which happens before any DB touch), and static
// reads of the wiring that only a browser could otherwise exercise.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. brief: one line, clamped ──
console.log('\n── the reason is BRIEF to LOOK at, and whole to READ ──');
const { briefReason, reasonPair, TEND_REASON_MAX, TEND_REASON_STORE_MAX } = await import('../server/src/lib/status.js');
ok(briefReason('  needs a human  ') === 'needs a human', 'trimmed');
ok(briefReason('two\nlines   here') === 'two lines here', 'newlines/runs collapse to one line');
ok(briefReason('') === null && briefReason(null) === null && briefReason('   ') === null,
   'empty/whitespace-only is null — "no reason" stays distinguishable from a reason that says nothing');
const long = briefReason('x'.repeat(TEND_REASON_MAX * 3));
ok(long.length === TEND_REASON_MAX && long.endsWith('…'), `the display line is clamped to ${TEND_REASON_MAX} chars, elided`);

// The regression this pins: v1 clamped the STORED text too, so a tend reporting a prod problem
// arrived as "…re-tasking a manager wi…" and the tail existed nowhere a human could reach.
const essay = 'the ship leaks a prod credential. ' + 'detail '.repeat(60);
const pair = reasonPair(essay);
ok(pair.brief.length === TEND_REASON_MAX && pair.brief.endsWith('…'), 'a long reason still yields a one-line head');
ok(pair.full.startsWith('the ship leaks a prod credential.') && pair.full.length > TEND_REASON_MAX
   && !pair.full.endsWith('…'), 'and the WHOLE text survives beside it — clipped for display, never edited');
ok(reasonPair('short one').full === null,
   'no "full" when the brief line already IS the whole reason (nothing renders "more" twice)');
ok(reasonPair('y'.repeat(TEND_REASON_STORE_MAX * 2)).full.length === TEND_REASON_STORE_MAX,
   `what a tend may CARRY is still bounded (${TEND_REASON_STORE_MAX} chars) — a bound, not an edit`);

// ── 2. raising REQUIRES it (server-side, not just the CLI) ──
console.log('\n── raising without a reason is refused ──');
const { selfTend } = await import('../server/src/queenzee/self.js');
const xell = { id: '00000000-0000-0000-0000-000000000000', slug: 'test-xell' };
const bare = await selfTend(xell, {});                      // no reason at all
const blank = await selfTend(xell, { reason: '   \n ' });   // whitespace pretending to be one
ok(bare.ok === false && /brief reason/i.test(bare.error), 'a tend with no reason is refused, and says why');
ok(blank.ok === false, 'whitespace is not a reason');
ok(/zee tend --reason/.test(bare.error), 'the refusal shows the zee the exact call to make');
// The door must not clip on the way in. selfTend validates with the BRIEF form and stores the RAW
// one; passing the brief form to setTend is the bug that shipped, and no read-side fix can undo it.
const selfSrc = read('server/src/queenzee/self.js');
ok(/setTend\(xell\.id, !clear, \{ reason, zeeId/.test(selfSrc),
   'selfTend stores the RAW reason (the brief form is for validating, logging and answering only)');
const cleared = await selfTend.toString().includes('if (!clear && !why)');
ok(cleared, '--clear still needs no reason (lowering an open tend is not an ask)');

// ── 3. the server carries it to the console + to a manager ──
console.log('\n── the reason travels ──');
const fleet = read('server/src/lib/fleet.js');
ok(/tnd\.reason AS tend_reason/.test(fleet), 'fleet reads the latest tend event\'s reason');
ok(/x\.tend = x\.tend_pending === true/.test(fleet) && /reason: why\.brief, full: why\.full/.test(fleet),
   'fleet exposes x.tend = { open, reason, full, at } (null when no tend is open) — the one-line form '
   + 'for a card row, the whole text for whoever opens it');
ok(/delete x\.tend_reason/.test(fleet), 'the raw columns do not leak onto the payload');
const self = read('server/src/queenzee/self.js');
ok(/tend: \{ open: tend\.open, reason: tend\.reason, reason_full: tend\.full/.test(self),
   '`zee status` echoes both forms back, so a zee can see its own ask as a human sees it');
const mgr = read('server/src/lib/managers.js');
ok(/it raised a TEND \(needs a human\)\$\{why\.brief/.test(mgr),
   'a manager reading its crew is told WHAT the tend is about, not just that there is one');
ok(/tend: r\.tend_pending \? \{ open: true, reason: why\.brief, full: why\.full \}/.test(mgr),
   'and gets the full text on the crew row — it has no console to hover and no terminal to open');

// ── 4. the console shows it (the surface that was missing entirely) ──
//
// Rendered for real: App.jsx's own NeedsYouBar and XellCard, bundled with esbuild and rendered to
// static markup, so this asserts what a human would SEE — not that a string appears in a source
// file. (App.jsx exports neither, so the entry is App.jsx verbatim + an export line.)
console.log('\n── the console renders it ──');
const { build } = await import('esbuild');
const { createElement: h } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { writeFileSync, rmSync } = await import('node:fs');

const WEB = resolve(here, '..', 'web/src');
const entry = `${WEB}/.tend-reason.test-entry.jsx`;
const outfile = `${WEB}/.tend-reason.test-bundle.mjs`;
writeFileSync(entry, read('web/src/App.jsx') + '\nexport { NeedsYouBar, XellCard };\n');
let ui;
try {
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    loader: { '.jsx': 'jsx' }, external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'error' });
  ui = await import(`file://${outfile}`);
} finally {
  // the bundle emits a .css sibling (App.jsx imports the stylesheet) — take that with it
  for (const f of [entry, outfile, outfile.replace(/\.mjs$/, '.css')]) rmSync(f, { force: true });
}

const WHY = 'the landing gate declined twice — need a human to look at the update hook';
const WHY_FULL = `${WHY}. the update hook declines every push whose committer is not on the allowlist, `
  + 'and the two attempts are recorded in the land_request rows — this line is deliberately long enough '
  + 'that the one-line form cannot hold it, which is exactly the case that used to lose its own tail.';
const tending = {
  id: 'x1', slug: 'bright-vale-12647c', status: 'claimed', hive_status: 'occ-tendRequest',
  hive_status_label: 'tend?', head_commit: 'abc123def456', branch: 'spinoff/bright-vale',
  tend: { open: true, reason: WHY, full: WHY_FULL, at: new Date().toISOString() }, stack: [], burn: { tokens: 0, cost: 0 },
};
const quiet = { ...tending, hive_status: 'occ-working', hive_status_label: 'working', tend: null };
const barOf = (x, expandedId) => renderToStaticMarkup(h(ui.NeedsYouBar, {
  xells: [x], landingByXell: {}, prsFor: () => [], visible: (a) => a || [],
  onJump: () => {}, expandedId, onDecided: () => {}, onDismiss: () => {} }));
const cardOf = (x) => renderToStaticMarkup(h(ui.XellCard, { x, diff: null, onDone: () => {}, onMenu: () => {},
  prodLock: null, projectId: 'p1', landing: [], prs: [], ship: null, onDismiss: () => {}, machines: [] }));

const bar = barOf(tending, 'x1');
ok(bar.includes(WHY), 'the "waiting on you" note says WHAT the zee needs a human for');
ok(bar.includes(WHY_FULL), 'and says ALL of it — the opened ask is not clipped (the v1 regression)');
ok(/ny-n">🖐 tend: the landing gate declined twice/.test(bar), 'the chip carries the reason inline, clipped');
ok(/title="tend \(needs a human\): the landing gate/.test(bar), 'the full reason is on the chip title');
ok(!/Open its session to see why/.test(bar),
   'the old "open its session to see why" instruction is gone — the console answers that itself');

const card = cardOf(tending);
ok(card.includes('data-testid="tend-reason"'), 'the xell card grows a tend row');
ok(/🖐 the landing gate declined twice[^<]*…/.test(card), 'clipped to one line on the card');
ok(card.includes(`title="${WHY_FULL}`), 'with the FULL reason (and what a tend is) in its title');

ok(barOf(quiet, null) === '' && !cardOf(quiet).includes('tend-reason'),
   'a xell with no open tend renders neither — the row exists only while a human is actually wanted');

const css = read('web/src/styles.css');
ok(/\.tendwhy\s*\{/.test(css) && /\.ny-why\s*\{/.test(css), 'both surfaces are styled (no unstyled class)');

// ── 5. the CLI asks for it before spending a round-trip ──
console.log('\n── the CLI ──');
const cli = read('scripts/zee');
const tendCase = cli.slice(cli.indexOf("case 'tend':"), cli.indexOf("case 'ship':"));
ok(/BRIEF reason/.test(tendCase), 'the CLI refuses a reasonless tend locally, and says it must be brief');
ok(/rest\.find\(\(a\) => !a\.startsWith\('--'\)\)/.test(tendCase),
   '`zee tend "why"` (bare) is accepted as the same ask — a missing flag is not worth a refusal');

// ── 6. the manual says so (it is the zee's only instruction) ──
console.log('\n── the manual ──');
const mig = read('db/migrations/056_manual_tend_reason.sql') + read('db/migrations/057_manual_tend_reason_full.sql');
ok(/The reason is REQUIRED/.test(mig), 'the manual patch teaches that the reason is required');
ok(/the console keeps/.test(mig) && /whole text for when they open the ask/.test(mig),
   'and that the clamp is about LAYOUT — the whole text is kept for the human who opens the ask');
ok((mig.match(/THEN RETURN; END IF;/g) || []).length === 2,
   'both patches are guarded — re-running them, or running them over a human-edited manual, changes nothing');

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);
