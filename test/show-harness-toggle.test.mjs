// THE SHOW-HARNESS TOGGLE — the graph pane's view control for the harness hexagons.
//
// The honeycomb draws harnesses as their own hexagon cells and routes a consumer's wire THROUGH
// that cell (docs §5). The toggle sits above the flip button and turns that whole layer off: no
// badge cells are seated, no wire routes through one, and every trace runs straight from its git-
// graph commit dot to its xell. This is a VIEW preference only — it changes nothing about the
// payload, the fleet or the read model.
//
// Exercised the way this repo does UI: the REAL <GraphPane> rendered with react-dom/server (the
// same trick crew-relation-layers.test.mjs uses), plus source assertions on the two draw layers
// (HiveCanvas + Connectors) so the gate is proven in the code that draws, not just in the toggle.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const SRC = {
  canvas: 'web/src/hive/HiveCanvas.jsx',
  wires: 'web/src/Connectors.jsx',
  graph: 'web/src/GraphPane.jsx',
};
const src = Object.fromEntries(Object.entries(SRC).map(([k, f]) => [k, readFileSync(f, 'utf8')]));
const built = [];
const build = (file, tag) => {
  const out = file.replace(/\/([^/]+)$/, `/.${tag}.test-build.mjs`);
  writeFileSync(out, transformSync(readFileSync(file, 'utf8'), { loader: 'jsx', format: 'esm' }).code);
  built.push(out);
  return '../' + out;
};
let canvas, graph, React, renderToStaticMarkup;
try {
  canvas = await import(build(SRC.canvas, 'canvas'));
  graph = await import(build(SRC.graph, 'graph'));
  React = (await import('react')).default;
  renderToStaticMarkup = (await import('react-dom/server')).renderToStaticMarkup;
} finally {
  for (const f of built) rmSync(f, { force: true });
}

// ── 1. the toggle, rendered for real, above the flip button ────────────────────
console.log('\n── the toggle in the graph pane ──');
const commits = [
  { hash: 'c1aaaaaa', short: 'c1aaaaa', subject: 'one', parents: [] },
  { hash: 'c2bbbbbb', short: 'c2bbbbb', subject: 'two', parents: ['c1aaaaaa'] },
];
const timeline = { branch: 'master', commits, xells: [], harnesses: [] };
const renderGraph = (showHarness) => {
  const realErr = console.error;
  console.error = (...a) => { if (!/useLayoutEffect does nothing on the server/.test(String(a[0]))) realErr(...a); };
  try {
    return renderToStaticMarkup(React.createElement(graph.default, {
      timeline, xells: [], orientation: 'landscape', honeySide: 'a', hexPosRef: { current: {} },
      prodIds: [], expandedId: null, hoverRef: { current: { id: null, commit: null, harness: null } },
      setHover: () => {}, subscribeHover: null, onFlip: () => {},
      showHarness, onToggleHarness: () => {},
    }));
  } finally { console.error = realErr; }
};
const onHtml = renderGraph(true);
const offHtml = renderGraph(false);
ok(onHtml.includes('data-testid="harness-toggle"'), 'the toggle is rendered with a testable id');
ok(/show harness/.test(onHtml), 'it says "show harness"');
ok(/show harness ✓/.test(onHtml), 'and shows the tick when the harness hexagons ARE shown');
ok(!/show harness ✓/.test(offHtml), 'the tick is gone when they are hidden');
ok(/aria-pressed="true"/.test(onHtml) && /aria-pressed="false"/.test(offHtml),
   'aria-pressed reflects the state (an honest toggle)');
const togglePos = onHtml.indexOf('data-testid="harness-toggle"');
const flipPos = onHtml.indexOf('data-testid="flip-btn"');
ok(togglePos >= 0 && flipPos >= 0 && togglePos < flipPos,
   'the toggle is stacked ABOVE the flip button (it comes first in the pane markup)');
ok(/class="graph-harness-toggle on"/.test(onHtml) && /class="graph-harness-toggle"/.test(offHtml),
   'and its class carries the on/off state for styling');
const noToggleHtml = renderToStaticMarkup(React.createElement(graph.default, {
  timeline, xells: [], orientation: 'landscape', honeySide: 'a', hexPosRef: { current: {} },
  prodIds: [], expandedId: null, hoverRef: { current: {} }, setHover: () => {}, subscribeHover: null,
  onFlip: () => {},   // NO onToggleHarness
}));
ok(!noToggleHtml.includes('data-testid="harness-toggle"') && noToggleHtml.includes('data-testid="flip-btn"'),
   'without a toggle handler the pane keeps just the flip button — the control is opt-in');

// ── 2. the draw layers are gated on showHarness ────────────────────────────────
console.log('\n── the layers that draw the harnesses ──');
ok(/if \(showHarness && badged\.length\)/.test(src.canvas),
   'HiveCanvas seats + draws the harness badges only when showHarness is on');
ok(/if \(showHarness\) \{[\s\S]*consumerHarness\.set/.test(src.wires),
   'Connectors builds the harness routing map only when showHarness is on — hidden, every wire runs straight dot → xell');
ok(/badgedHarnesses/.test(src.canvas), 'badgedHarnesses still lives in the canvas (the pure filter is unchanged)');
ok(badgedHarnessesSafe(canvas), 'and the exported helper still returns only consumer-carrying harnesses');
function badgedHarnessesSafe(m) {
  const h = m.badgedHarnesses([{ consumer_ids: ['a'] }, { consumer_ids: [] }, {}]);
  return h.length === 1 && h[0].consumer_ids.join() === 'a'
    && m.badgedHarnesses().length === 0;
}
// the toggle state reaches both draw layers from the app
ok(/showHarness=\{showHarness\}/.test(readFileSync('web/src/App.jsx', 'utf8')),
   'App passes the toggle to the canvas');
ok(/<Connectors[\s\S]*showHarness=\{showHarness\}/.test(readFileSync('web/src/App.jsx', 'utf8')),
   'App passes the toggle to the wire overlay');
ok(/onToggleHarness=\{\(\) => setShowHarness\(\(s\) => !s\)\}/.test(readFileSync('web/src/App.jsx', 'utf8')),
   'and the graph pane owns the toggle flip');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ the show-harness toggle is there, above flip, and gates both draw layers');
process.exit(fail ? 1 : 0);
