// WORK BOARD RENDER test — the board's card is actually RENDERED, in node, and must not throw.
//
// THE REPORT THIS COMES FROM: "I get this error when trying to view the work board —
// `ReferenceError: onKey is not defined`". A work card wired `onKeyDown={onKey}` to a name that was
// neither a prop of the card nor anything the board passed. It is legal JavaScript (a lookup on the
// global object), so vite built it and shipped it; React then threw on the FIRST card it rendered,
// unwound the tree, and the board was a blank screen. Nothing in this repo could have caught it:
// there is no linter, no CI browser, and the console's other tests read source rather than run it.
//
// So this one RUNS it. esbuild (already here) bundles the component the same way vite does, react's
// server renderer executes it, and the assertions are about what a human would see: the title, the
// status, the ticket number. A free identifier inside the component body throws during that render
// exactly as it does in Chrome — which is the whole point of rendering instead of grepping.
//
// WHY only the card and not the whole board: the board's data arrives in an effect (fetch), and a
// server render runs no effects — it would render "loading the board…" forever and prove nothing.
// The card, by contrast, is a pure function of its props, which is why Board.jsx exports it.
// bits.jsx (the shared leaf components + formatters every work screen renders) is exercised the same
// way, including `fmtWhen`, whose definition a refactor deleted while leaving the call behind.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// The bundle is written INSIDE the repo (node_modules must resolve from it) and removed after.
const out = mkdtempSync(join(ROOT, '.render-test-'));
let mod;
try {
  const file = join(out, 'bundle.mjs');
  // The entry is synthesised (stdin) rather than committed as a file: nothing in web/src should
  // exist only for a test to import.
  await build({
    stdin: {
      contents: "export { Card } from './web/src/work/Board.jsx';\n"
              + "export * as bits from './web/src/work/bits.jsx';\n",
      resolveDir: ROOT, sourcefile: 'render-entry.js', loader: 'js',
    },
    bundle: true, format: 'esm', outfile: file, jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  });
  mod = await import(pathToFileURL(file).href);
  ok(true, 'the board + shared bits bundle and load (the same transform vite does)');

  // ── a real card, rendered ────────────────────────────────────────────────────────────────────
  const statuses = [{ key: 'in_progress', label: 'in progress', order: 2 }];
  const card = {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'the card a human is looking at',
    kind: 'task', status: 'in_progress', priority: 1, due_on: '2026-08-01',
    breadcrumb: ['a project', 'an activity'],
    ticket: { number: 42, title: 'the ticket it came from' },
    zee: { slug: 'swift-grove-4d424d', hive_status: 'occ-working' },
    live_status: 'blocked',
  };
  let html = ''; let threw = null;
  try {
    html = renderToStaticMarkup(React.createElement(mod.Card, {
      card, statuses, dragging: false,
      onDragStart: () => {}, onDragEnd: () => {}, onDragOver: () => {}, onDrop: () => {},
      onKey: () => {}, onOpen: () => {},
    }));
  } catch (e) { threw = e; }
  ok(!threw, `a work card renders without throwing${threw ? ` — ${threw.message}` : ''}`);
  ok(/ReferenceError/.test(String(threw?.name)) === false, 'and specifically not a ReferenceError (the reported bug)');
  ok(html.includes('the card a human is looking at'), 'the card shows its title');
  ok(html.includes('#42'), 'and its ticket number');
  ok(/work-card/.test(html), 'and carries the card class the board styles');

  // A card the API answered thinly (no ticket, no zee, no dates) must still render — half the rows
  // on a real board look like this, and an optional field is not an excuse to take the board down.
  let bare = null;
  try {
    renderToStaticMarkup(React.createElement(mod.Card, { card: { id: 'x', title: 'bare' }, statuses }));
  } catch (e) { bare = e; }
  ok(!bare, `a card with only an id and a title renders too${bare ? ` — ${bare.message}` : ''}`);

  // ── the shared bits, including the formatter a refactor deleted ─────────────────────────────
  ok(typeof mod.bits.fmtWhen === 'function',
     'bits.jsx exports fmtWhen (the item drawer\'s history calls it — it threw when it did not exist)');
  ok(mod.bits.fmtWhen('') === '' && /\d/.test(mod.bits.fmtWhen('2026-07-29T10:50:43Z')),
     'fmtWhen formats a timestamp and stays quiet on an empty one');
  ok(mod.bits.fmtWhen('not a date') === 'not a date',
     'and an unparseable value renders as itself rather than vanishing');
  for (const [name, props] of [
    ['KindGlyph', { kind: 'task' }], ['StatusDot', { status: 'in_progress', statuses }],
    ['Pips', { priority: 1 }], ['Due', { date: '2026-08-01' }],
    ['ZeeChip', { zee: { slug: 's', hive_status: 'occ-working' } }],
    ['Breadcrumb', { parts: ['a', 'b'] }], ['ErrLine', { err: new Error('a refusal sentence') }],
  ]) {
    let e = null;
    try { renderToStaticMarkup(React.createElement(mod.bits[name], props)); } catch (err) { e = err; }
    ok(!e, `bits.${name} renders${e ? ` — ${e.message}` : ''}`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
