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
      contents: "export { Card, RowBand, RowTail, LeafBand, LeafPack, buildForest, buildIndex, leafLaneCounts, flattenBands } from './web/src/work/Board.jsx';\n"
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

  // ── the MATRIX: swimlane rows per parent, cards in lanes ─────────────────────────────────────
  // The board's new shape: a work_node WITH children renders as a collapsible ROW spanning every
  // lane (its own status becomes a dot in the row header); a node with NO children renders as a
  // CARD in its status lane under its nearest parent row. The pure builders (buildForest /
  // buildIndex / leafLaneCounts / flattenBands) are exercised on a real payload, and the band
  // components are RENDERED so a free identifier throws here, in node, the way it does in a
  // browser — exactly why this test renders Card instead of grepping for it.
  const mStatuses = [
    { key: 'queued', label: 'queued', order: 1 },
    { key: 'working', label: 'working', order: 2 },
  ];
  const mRoot = { id: 'r', title: 'The Root', kind: 'project', status: 'queued', sort_order: 0 };
  const mColumns = [
    { key: 'queued', label: 'queued', items: [
      { id: 'a', title: 'Activity A', kind: 'activity', status: 'queued', parent_id: 'r', sort_order: 1 },
      { id: 'l1', title: 'Leaf one', kind: 'task', status: 'queued', parent_id: 'a', sort_order: 1 },
    ]},
    { key: 'working', label: 'working', items: [
      { id: 'l2', title: 'Leaf two', kind: 'task', status: 'working', parent_id: 'a', sort_order: 2 },
    ]},
  ];

  const forest = mod.buildForest(mRoot, mColumns);
  ok(forest.length === 1 && forest[0].id === 'r', 'buildForest returns the root as the single top-level row');
  ok(forest[0].children.length === 1 && forest[0].children[0].id === 'a',
     '…with the container (a card that is somebody\'s parent) as its child');
  ok(forest[0].children[0].children.length === 2, '…and the container holding both leaves, sorted');

  const idx = mod.buildIndex(forest);
  ok(idx.rowOf.get('l1') === 'a' && idx.rowOf.get('l2') === 'a', 'a leaf belongs to its NEAREST parent row');
  ok(idx.rowOf.get('a') === 'a', 'a container is its own row');
  const aStacks = idx.laneStacks.get('a');
  ok(aStacks.get('queued').map((c) => c.id).join() === 'l1', 'the row\'s queued lane holds its queued leaf');
  ok(aStacks.get('working').map((c) => c.id).join() === 'l2', 'and its working lane holds the working leaf');

  const counts = mod.leafLaneCounts(forest[0].children[0]);
  ok(counts.get('queued') === 1 && counts.get('working') === 1, 'a collapsed row counts its leaves per lane');

  // a project root with NO children is still a ROW (it was never a card before the matrix).
  const emptyForest = mod.buildForest(mRoot, []);
  ok(emptyForest.length === 1 && emptyForest[0].isRoot === true, 'buildForest marks the root');
  ok(mod.flattenBands(emptyForest, new Set())[0].kind === 'row',
     'a childless root renders as a row, not as a card in a lane');

  // collapse/expand: the flat band list is the exact contract of what is visible. A row's DIRECT
  // leaves group into ONE leafpack band (packed per lane) instead of a full row per card.
  const flat = mod.flattenBands(forest, new Set());
  ok(flat.map((b) => `${b.kind}:${(b.node || b.card).id}`).join() === 'row:r,row:a,leafpack:a,tail:a,tail:r',
     'a fully-expanded board draws rows, then one leafpack per row, then each row\'s tail');
  const pack = flat.find((b) => b.kind === 'leafpack');
  ok(!!pack && pack.leaves.map((l) => l.id).join() === 'l1,l2',
     'the leafpack carries the row\'s direct leaves, in sort order');
  const flatCollapsed = mod.flattenBands(forest, new Set(['a']));
  ok(flatCollapsed.map((b) => `${b.kind}:${(b.node || b.card).id}`).join() === 'row:r,row:a,tail:r',
     'collapsing a row hides its leaves AND its tail (the drop zones under it)');

  // RENDER the bands — a free identifier throws here, exactly as it does in Chrome.
  let rowHtml = '';
  try {
    rowHtml = renderToStaticMarkup(React.createElement(mod.RowBand, {
      node: forest[0], depth: 0, collapsed: false, columns: mColumns, statuses: mStatuses,
      onToggle: () => {}, onOpen: () => {},
    }));
  } catch (e) { ok(false, `a container row renders without throwing — ${e.message}`); }
  ok(!!rowHtml && rowHtml.includes('The Root'), 'a container row renders and shows the parent title');
  ok(rowHtml.includes('▾'), 'and the caret says it is expanded');

  let collapsedHtml = '';
  try {
    collapsedHtml = renderToStaticMarkup(React.createElement(mod.RowBand, {
      node: forest[0].children[0], depth: 1, collapsed: true, columns: mColumns, statuses: mStatuses,
      onToggle: () => {}, onOpen: () => {},
    }));
  } catch (e) { ok(false, `a collapsed row renders without throwing — ${e.message}`); }
  ok(collapsedHtml.includes('Activity A') && collapsedHtml.includes('▸'),
     'a collapsed row shows its title and the caret closed');
  ok(/queued/.test(collapsedHtml) && /working/.test(collapsedHtml),
     '…and the per-lane counts it hides (queued / working)');

  let leafHtml = '';
  try {
    leafHtml = renderToStaticMarkup(React.createElement(mod.LeafBand, {
      card: { id: 'l1', title: 'Leaf one', kind: 'task', status: 'queued' }, depth: 2,
      columns: mColumns, statuses: mStatuses,
      onOpen: () => {}, onKey: () => {},
      onDragStart: () => {}, onDragEnd: () => {}, onDragOver: () => {}, onDrop: () => {},
    }));
  } catch (e) { ok(false, `a leaf band renders without throwing — ${e.message}`); }
  ok(leafHtml.includes('Leaf one') && /work-card/.test(leafHtml), 'a leaf renders as a card in its lane');

  // The LEAF PACK renders every leaf of the row's lanes in ONE row (the compact wrapped layout),
  // each card still carrying its own drag/keyboard wiring so the wrapped flow stays operable.
  let packHtml = '';
  try {
    packHtml = renderToStaticMarkup(React.createElement(mod.LeafPack, {
      node: forest[0].children[0], depth: 2, columns: mColumns, statuses: mStatuses,
      index: idx, dragId: null, dropAt: null,
      onOpen: () => {}, onCardKey: () => {},
      onDragStart: () => {}, onDragEnd: () => {}, allowCard: () => {}, allowPackLane: () => {},
      onDrop: () => {}, halfOf: () => 0, packIndex: () => 0,
    }));
  } catch (e) { ok(false, `a leaf pack renders without throwing — ${e.message}`); }
  ok(!!packHtml && packHtml.includes('Leaf one') && packHtml.includes('Leaf two'),
     'a leaf pack renders BOTH leaves in their lanes');
  ok(/work-card/.test(packHtml) && /work-leafpack/.test(packHtml),
     '…as compact cards inside one leafpack row');

  let tailHtml = '';
  try {
    tailHtml = renderToStaticMarkup(React.createElement(mod.RowTail, {
      node: forest[0].children[0], depth: 1, columns: mColumns, index: idx, dropAt: null,
      onDragOver: () => {}, onDrop: () => {},
    }));
  } catch (e) { ok(false, `a row tail renders without throwing — ${e.message}`); }
  ok(/work-tail/.test(tailHtml), 'an expanded row renders its tail (the per-lane append drop targets)');

  // ── per-status-column HIDE ───────────────────────────────────────────────────────────────────
  // A hidden column stops rendering that lane's work-node CARDS (leaf pack + leaf band) and its
  // drop targets (tail + pack lane), and every swimlane ROW band at every depth shows ONE summary
  // card in that column instead: the count of every leaf under that row with that status (the
  // recursive leafLaneCounts shape), opening the row's drawer on click.
  const hideWorking = new Set(['working']);

  let hiddenRowHtml = '';
  try {
    hiddenRowHtml = renderToStaticMarkup(React.createElement(mod.RowBand, {
      node: forest[0].children[0], depth: 1, collapsed: false, columns: mColumns, statuses: mStatuses,
      hiddenCols: hideWorking, onToggle: () => {}, onOpen: () => {},
    }));
  } catch (e) { ok(false, `a row band with a hidden column renders without throwing — ${e.message}`); }
  ok(hiddenRowHtml.includes('work-col-summary'), 'a hidden column shows ONE summary card in the row band');
  ok(hiddenRowHtml.includes('>1<') && hiddenRowHtml.includes('working'),
     '…carrying the recursive count of that row\'s leaves with the hidden status');

  let hiddenCollapsedHtml = '';
  try {
    hiddenCollapsedHtml = renderToStaticMarkup(React.createElement(mod.RowBand, {
      node: forest[0].children[0], depth: 1, collapsed: true, columns: mColumns, statuses: mStatuses,
      hiddenCols: hideWorking, onToggle: () => {}, onOpen: () => {},
    }));
  } catch (e) { ok(false, `a collapsed row with a hidden column renders without throwing — ${e.message}`); }
  ok(hiddenCollapsedHtml.includes('work-col-summary'),
     '…and the summary card is what a COLLAPSED row shows for the hidden column too');
  ok(hiddenCollapsedHtml.includes('queued'),
     '…while the shown column still renders its collapsed count text');

  let hiddenPackHtml = '';
  try {
    hiddenPackHtml = renderToStaticMarkup(React.createElement(mod.LeafPack, {
      node: forest[0].children[0], depth: 2, columns: mColumns, statuses: mStatuses,
      index: idx, dragId: null, dropAt: null, hiddenCols: hideWorking,
      onOpen: () => {}, onCardKey: () => {},
      onDragStart: () => {}, onDragEnd: () => {}, allowCard: () => {}, allowPackLane: () => {},
      onDrop: () => {}, halfOf: () => 0, packIndex: () => 0,
    }));
  } catch (e) { ok(false, `a leaf pack with a hidden column renders without throwing — ${e.message}`); }
  ok(hiddenPackHtml.includes('Leaf one') && !hiddenPackHtml.includes('Leaf two'),
     'a leaf pack stops rendering the cards of a hidden column');

  let hiddenLeafHtml = '';
  try {
    hiddenLeafHtml = renderToStaticMarkup(React.createElement(mod.LeafBand, {
      card: { id: 'l2', title: 'Leaf two', kind: 'task', status: 'working' }, depth: 2,
      columns: mColumns, statuses: mStatuses, hiddenCols: hideWorking,
      onOpen: () => {}, onKey: () => {},
      onDragStart: () => {}, onDragEnd: () => {}, onDragOver: () => {}, onDrop: () => {},
    }));
  } catch (e) { ok(false, `a leaf in a hidden column renders without throwing — ${e.message}`); }
  ok(!hiddenLeafHtml.includes('Leaf two') && !hiddenLeafHtml.includes('work-card'),
     'a leaf whose status column is hidden renders no card at all');

  // The tail's hidden lane is not a drop target: it neither advertises an empty lane (the "—"
  // marker) nor carries a drag/drop handler. A shown empty lane still advertises itself.
  const empties = (html) => (html.match(/work-row-empty/g) || []).length;
  const tailCols = [
    { key: 'queued', label: 'queued', items: [] },
    { key: 'working', label: 'working', items: [] },
    { key: 'review', label: 'review', items: [] },
  ];
  let shownTail3 = '', hiddenTail3 = '';
  try {
    shownTail3 = renderToStaticMarkup(React.createElement(mod.RowTail, {
      node: forest[0].children[0], depth: 1, columns: tailCols, index: idx, dropAt: null,
      onDragOver: () => {}, onDrop: () => {},
    }));
    hiddenTail3 = renderToStaticMarkup(React.createElement(mod.RowTail, {
      node: forest[0].children[0], depth: 1, columns: tailCols, index: idx, dropAt: null,
      hiddenCols: new Set(['review']), onDragOver: () => {}, onDrop: () => {},
    }));
  } catch (e) { ok(false, `a row tail with a hidden column renders without throwing — ${e.message}`); }
  ok(empties(shownTail3) === 1, 'a tail advertises an empty SHOWN lane with the empty marker');
  ok(empties(hiddenTail3) === 0 && hiddenTail3.includes('work-row-lane is-hidden'),
     '…and a hidden lane drops the marker and is marked is-hidden (no drop target)');

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
