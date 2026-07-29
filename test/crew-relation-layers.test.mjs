// THE CREW RELATION IN EVERY LAYER THAT DRAWS IT — ticket #25, the follow-up to #24.
//
// #24 made the honeycomb HEXES mark a manager's live crew. But the hive is drawn in three layers over
// one fleet: the hexes (hive/HiveCanvas.jsx), the wire overlay (Connectors.jsx) and the git graph's
// commit dots (GraphPane.jsx). With only the hexes marked, hovering a manager left its group holding
// its cells and losing its traces — the view contradicting itself in the one interaction the feature
// exists for. This carries the same relation into the other two.
//
// TWO THINGS THIS FILE IS REALLY ABOUT:
//
//  1. ONE grouping, not three. #24 landed by DELETING a hand-rolled `if (x.manager_xell_id)` pass that
//     had drifted from the read model and counted reaped workers as crew. Two more layers is two more
//     chances to write that bug, so the rule lives in hive/crew.js and every view imports it. The test
//     asserts the FUNCTION IDENTITY across the three importers — not that each spells it the same, but
//     that there is only one of it.
//  2. ONE visual idea, not three. Dashed means "related to the focus" in all three layers: the
//     hexagon's tie-ring, the wire's stroke and the dot's anchor ring all use hive/crew.js REL_DASH.
//     Solid-and-bright stays the focus's own. So a related thing can never read as the chosen one, and
//     the signal is not a colour — the house rule, since a hue-only highlight fails anyone who cannot
//     separate those hues.
//
// HOW IT IS EXERCISED: the pure decisions (wireStyle, anchorRing) as data, then the REAL elements
// RENDERED — react-dom/server on the actual <Wire> and the actual <GraphPane> — and the emitted markup
// asserted. That is the SVG counterpart of #24 painting into a recording 2D context: what a human would
// see, read back off the thing that draws it, rather than grepped for in the source.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── build the three real modules (JSX → ESM) and import them ─────────────────
const SRC = {
  crew: 'web/src/hive/crew.js',
  canvas: 'web/src/hive/HiveCanvas.jsx',
  wires: 'web/src/Connectors.jsx',
  graph: 'web/src/GraphPane.jsx',
  app: 'web/src/App.jsx',
};
const src = Object.fromEntries(Object.entries(SRC).map(([k, f]) => [k, readFileSync(f, 'utf8')]));
const built = [];
const build = (file, tag) => {
  const out = file.replace(/\/([^/]+)$/, `/.${tag}.test-build.mjs`);
  writeFileSync(out, transformSync(readFileSync(file, 'utf8'), { loader: 'jsx', format: 'esm' }).code);
  built.push(out);
  return '../' + out;
};
let crew, canvas, wires, graph, React, renderToStaticMarkup;
try {
  // crew.js is plain JS — imported DIRECTLY, not through a transformed copy, so the identity checks
  // below compare the same module instance the three views load. (A second copy of it would make
  // `canvas.crewLinks === crew.crewLinks` false for the most boring possible reason.)
  // Connectors/GraphPane import './hive/crew.js' relative to web/src, so their temp builds must sit in
  // their own directories — hence one temp file per module rather than one shared scratch file.
  crew = await import('../' + SRC.crew);
  canvas = await import(build(SRC.canvas, 'canvas'));
  wires = await import(build(SRC.wires, 'wires'));
  graph = await import(build(SRC.graph, 'graph'));
  React = (await import('react')).default;
  renderToStaticMarkup = (await import('react-dom/server')).renderToStaticMarkup;
} finally {
  for (const f of built) rmSync(f, { force: true });
}
const { crewLinks, relatedTo, focusIdOf, hexDim, REL_DASH, REL_DASH_ATTR } = crew;
const { wireStyle, Wire } = wires;
const { anchorRing } = graph;

// ── the fleet: a manager, two live crew, one REAPED crew member, and a loner ──
const mgr = { id: 'M', slug: 'wise-cove', zee_type: 'manager', status: 'working' };
const w1 = { id: 'w1', slug: 'alpha', zee_type: 'worker', manager_xell_id: 'M', status: 'working' };
const w2 = { id: 'w2', slug: 'beta', zee_type: 'worker', manager_xell_id: 'M', status: 'idle' };
const dead = { id: 'w3', slug: 'gamma', zee_type: 'worker', manager_xell_id: 'M', status: 'husk' };
const loner = { id: 'L', slug: 'solo', zee_type: 'worker', status: 'working' };
const fleet = [mgr, w1, w2, dead, loner];

// ── 1. ONE grouping: the three views share the code, not just the intent ─────
console.log('\n── one rule, imported by every layer that draws it ──');
ok(canvas.crewLinks === crew.crewLinks && canvas.relatedTo === crew.relatedTo
   && canvas.hexDim === crew.hexDim && canvas.isManagerXell === crew.isManagerXell,
   'the honeycomb re-exports hive/crew.js — the SAME function objects, so #24 callers cannot drift');
ok(/from '\.\/hive\/crew\.js'/.test(src.wires) && /from '\.\/hive\/crew\.js'/.test(src.graph),
   'the wire overlay and the graph import the relation from hive/crew.js');
for (const [name, text] of [['Connectors', src.wires], ['GraphPane', src.graph]])
  ok(!/manager_xell_id/.test(text),
     `${name} never names manager_xell_id — it asks crewLinks instead of grouping the fleet again`);
ok((src.canvas.match(/manager_xell_id/g) || []).length === 1
   && /const crew = list\.filter\(\(w\) => w\.manager_xell_id === m\.id/.test(src.canvas),
   'and the ONE place it survives in the canvas is seatXells, which seats a cell for the dead too');
ok(/xells=\{xells\}/.test(src.app.split('<GraphPane')[1].split('/>')[0])
   && /xells=\{xells\}/.test(src.app.split('<Connectors')[1].split('/>')[0]),
   'App hands both of them the same fleet list the honeycomb draws from');
ok(/expandedId=\{expandedId\}/.test(src.app.split('<GraphPane')[1].split('/>')[0]),
   'and the graph is told what is SELECTED, so a bloom marks the crew there too');

// ── 2. ONE visual idea: the dash is shared, and it is not a colour ───────────
console.log('\n── one dash, three layers ──');
ok(Array.isArray(REL_DASH) && REL_DASH.length === 2 && REL_DASH_ATTR === REL_DASH.join(' '),
   `the relation dash is defined once, in both the canvas and the SVG form (${REL_DASH} / "${REL_DASH_ATTR}")`);
ok(canvas.REL_DASH === REL_DASH, 'the canvas hexagon marks with that same dash object');
ok(/ctx\.setLineDash\(REL_DASH\)/.test(src.canvas), 'the hexagon tie-ring strokes it (drawRelationMark)');
ok(wireStyle({ related: 'crew' }).dash === REL_DASH_ATTR, 'a related WIRE strokes it');
ok(anchorRing({ related: 'crew' }).dash === REL_DASH_ATTR, 'a related commit DOT rings with it');
ok(!wireStyle({ hovered: true }).dash && !anchorRing({ hovered: true }).dash && !wireStyle({}).dash,
   'and nothing else in either layer is dashed — the focus is solid, a stranger is solid');

// ── 3. the wire ladder ───────────────────────────────────────────────────────
console.log('\n── how a wire reads: related stays VISIBLE, and is not the focus ──');
const plainW = wireStyle({});
const relW = wireStyle({ related: 'crew' });
const focusW = wireStyle({ hovered: true });
const goneW = wireStyle({ dim: true });
ok(relW.opacity > goneW.opacity * 5 && relW.opacity >= 0.8,
   `a related trace stays visible (${relW.opacity}) instead of receding to ${goneW.opacity} — the group keeps its traces`);
ok(relW.opacity < focusW.opacity && relW.width < focusW.width && !!relW.dash && !focusW.dash,
   'and is distinguishable from the FOCUS’s own wire three ways: dimmer, thinner, dashed');
ok(wireStyle({ related: 'crew', dim: true, bloomDim: true }).opacity === relW.opacity,
   'related survives an open bloom — that is exactly when a human asks "which of these are yours?"');
ok(plainW.opacity === 0.92 && goneW.opacity === 0.1
   && wireStyle({ bloomDim: true }).opacity === 0.12 && focusW.opacity === 1 && focusW.width === 3.2,
   'and every OTHER rung of the ladder is the one that was there before (0.92 / 0.1 / 0.12 / 1)');
ok(wireStyle({ hovered: true, bloomDim: true }).opacity === 0.12,
   'including the bloom outranking a stray hover, which is how an open flower keeps the pane');

// ── 4. RENDER the real wire and read what it emitted ─────────────────────────
console.log('\n── the real <Wire>, rendered ──');
const p = (id) => ({ id, d: 'M 0 0 L 10 10', color: '#5b8cff', x1: 0, y1: 0, x2: 10, y2: 10, dim: false });
const paint = (props) => renderToStaticMarkup(React.createElement(Wire, { p: p('w1'), ...props }));
const relSvg = paint({ related: 'crew' });
const focusSvg = paint({ hovered: true });
const goneSvg = paint({ dim: true });
ok(relSvg.includes(`stroke-dasharray="${REL_DASH_ATTR}"`), `a related wire really emits the dash (${relSvg.slice(0, 90)}…)`);
ok(relSvg.includes('opacity="0.85"') && relSvg.includes('data-rel="crew"'),
   'stays visible, and says in the markup which relation it is');
ok(!focusSvg.includes('stroke-dasharray') && focusSvg.includes('stroke-width="3.2"'),
   'the focus’s own wire is solid and thick — nothing about it says "related"');
ok(goneSvg.includes('opacity="0.1"') && !goneSvg.includes('stroke-dasharray'),
   'and a stranger’s wire recedes, undashed');
ok(paint({}).includes('stroke="#5b8cff"') && relSvg.includes('stroke="#5b8cff"'),
   'every wire keeps its own trace colour — the relation adds a dash, it does not repaint the fleet');

// ── 5. the dot's anchor ring ─────────────────────────────────────────────────
console.log('\n── how a commit dot reads ──');
ok(anchorRing({ ring: '#e0a53b' }).show && anchorRing({ ring: '#e0a53b' }).stroke === '#e0a53b',
   'a dot with a xell anchored at it keeps its plain ring, in that xell’s colour');
ok(!anchorRing({}).show, 'a dot with nothing anchored has no ring at all');
ok(anchorRing({ related: 'crew' }).show && anchorRing({ ring: null, related: 'crew' }).show,
   'a RELATED dot is ringed even when nothing was anchored there to ring it');
const ringFocus = anchorRing({ ring: '#e0a53b', hovered: true });
const ringRel = anchorRing({ ring: '#e0a53b', related: 'crew' });
ok(ringFocus.width > ringRel.width && !ringFocus.dash && !!ringRel.dash,
   'and the focus’s ring is thicker and solid where the related one is dashed');
ok(anchorRing({ hovered: true, related: 'crew' }).dash === null,
   'a dot that is BOTH (the focus sits on the same commit) reads as the focus, not as related');

// ── 6. RENDER the real GraphPane over a real fleet ───────────────────────────
// GraphPane is a pure render given a timeline (its effects are layout-only), so the whole component can
// be rendered to markup and its dots read back — the same "run the real thing" rule as #24's canvas.
console.log('\n── the real <GraphPane>, rendered with a manager hovered ──');
const commits = [
  { hash: 'c1aaaaaa', short: 'c1aaaaa', subject: 'one', parents: [] },
  { hash: 'c2bbbbbb', short: 'c2bbbbb', subject: 'two', parents: ['c1aaaaaa'] },
  { hash: 'c3cccccc', short: 'c3ccccc', subject: 'three', parents: ['c2bbbbbb'] },
  { hash: 'c4dddddd', short: 'c4ddddd', subject: 'four', parents: ['c3cccccc'] },
];
const timeline = {
  branch: 'master', commits,
  xells: [
    { id: 'M', slug: 'wise-cove', base_commit: 'c1aaaaaa', color: '#9b8cff', zee_type: 'manager' },
    { id: 'w1', slug: 'alpha', base_commit: 'c2bbbbbb', color: '#35c46b', zee_type: 'worker' },
    { id: 'w2', slug: 'beta', base_commit: 'c3cccccc', color: '#5b8cff', zee_type: 'worker' },
    { id: 'w3', slug: 'gamma', base_commit: 'c4dddddd', color: '#e5554e', zee_type: 'worker' },
  ],
  harnesses: [],
};
// GraphPane keeps its spine glued to the prod hexagon with useLayoutEffect, which react-dom/server
// (rightly) warns about — the effect is layout-only and the markup below is exactly what it renders
// without it. Swallow THAT warning and only that one, so a real error still reaches the log.
const renderGraph = (hover, expandedId = null) => {
  const realErr = console.error;
  console.error = (...a) => { if (!/useLayoutEffect does nothing on the server/.test(String(a[0]))) realErr(...a); };
  try {
    return renderToStaticMarkup(React.createElement(graph.default, {
      timeline, xells: fleet, orientation: 'landscape', honeySide: 'a', hexPosRef: { current: {} },
      prodIds: [], expandedId, hoverRef: { current: hover }, setHover: () => {}, subscribeHover: null,
    }));
  } finally { console.error = realErr; }
};
// the <g> for each commit dot, keyed by the commit whose dot it draws
const dotOf = (markup, hash) => {
  const i = markup.indexOf(`data-commit="${hash}"`);
  if (i < 0) return null;
  const start = markup.lastIndexOf('<g', i);
  return markup.slice(start, markup.indexOf('</g>', i) + 4);
};
const hoverM = renderGraph({ id: 'M', commit: null, harness: null });
ok(dotOf(hoverM, 'c1aaaaaa') && dotOf(hoverM, 'c2bbbbbb'), 'the pane renders a dot per commit (sanity)');
ok(dotOf(hoverM, 'c2bbbbbb').includes(`stroke-dasharray="${REL_DASH_ATTR}"`)
   && dotOf(hoverM, 'c3cccccc').includes(`stroke-dasharray="${REL_DASH_ATTR}"`),
   'hovering the manager marks both LIVE crew members’ commit dots as related');
ok(dotOf(hoverM, 'c2bbbbbb').includes('data-rel="crew"'), 'and says so in the markup');
ok(!dotOf(hoverM, 'c4dddddd').includes('stroke-dasharray'),
   'the REAPED crew member’s dot stays dark — a husk lends nothing to the graph either');
ok(!dotOf(hoverM, 'c1aaaaaa').includes('stroke-dasharray'),
   'and the manager’s own dot is not "related" to itself — it is the focus');
ok(dotOf(hoverM, 'c1aaaaaa').includes('stroke="var(--text)"') && dotOf(hoverM, 'c1aaaaaa').includes('stroke-width="2.5"'),
   'the focus keeps the solid bright ring it always had');
const hoverW = renderGraph({ id: 'w1', commit: null, harness: null });
ok(dotOf(hoverW, 'c1aaaaaa').includes(`stroke-dasharray="${REL_DASH_ATTR}"`)
   && !dotOf(hoverW, 'c3cccccc').includes('stroke-dasharray'),
   'hovering a WORKER marks the commit its manager sits on — and not its siblings’');
const bloomM = renderGraph({ id: null, commit: null, harness: null }, 'M');
ok(bloomM.includes(`stroke-dasharray="${REL_DASH_ATTR}"`),
   'SELECTING the manager (its flower open, nothing hovered) marks the crew here too');
const idle = renderGraph({ id: null, commit: null, harness: null });
ok(!idle.includes('stroke-dasharray'),
   'and with nothing focused at all, no dot claims a relation (no dash anywhere)');

// ── 7. the reaped crew member, all the way through ───────────────────────────
console.log('\n── a husk crew member lends nothing to ANY layer ──');
const links = crewLinks(fleet);
const rel = relatedTo(fleet, 'M', links);
ok(!rel.has('w3'), 'not to the relation itself');
ok(wireStyle({ related: rel.get('w3') || null, dim: true }).opacity === 0.1,
   'so its wire takes the stranger’s opacity, not the crew’s');
ok(hexDim({ hexId: 'w3', hoverActive: true, hovered: false, related: rel.get('w3') || null }) === true,
   'and its hexagon dims with everyone else, exactly as #24 landed it');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ one relation, one dash, three layers');
process.exit(fail ? 1 : 0);
