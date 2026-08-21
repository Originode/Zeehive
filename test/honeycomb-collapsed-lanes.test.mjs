// THE HONEYCOMB COLLAPSED TRACE LANES — the wire overlay renders ONE lane per corridor, dashed with
// alternating trace colours, and the honeycomb stops sizing hexagons by trace count.
//
// The old wire overlay split shared corridors into PARALLEL channels (assignLanes + offsetPolyline)
// and HiveCanvas shrank hexes to make room for the N channels (count * WIRE_PITCH). This job
// collapses both: a shared corridor is drawn ONCE on the single centreline, and the traces sharing
// it are told apart by a DASH pattern that alternates their colours (N traces → dasharray
// [len,(N-1)*len], dashoffset i*len). Hex size is now fixed regardless of the fleet size.
//
// Exercised the way this repo does UI: the pure decision (maze.sharedLaneDashes) as data, the REAL
// <Wire> rendered with react-dom/server and read back, and source assertions on the three files so
// the gate is proven in the code that draws, not just in the test fixture.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── build the real modules (JSX → ESM) and import them ───────────────────────
const SRC = {
  maze: 'web/src/hive/maze.js',
  wires: 'web/src/Connectors.jsx',
  canvas: 'web/src/hive/HiveCanvas.jsx',
};
const src = Object.fromEntries(Object.entries(SRC).map(([k, f]) => [k, readFileSync(f, 'utf8')]));
const built = [];
const build = (file, tag) => {
  const out = file.replace(/\/([^/]+)$/, `/.${tag}.test-build.mjs`);
  writeFileSync(out, transformSync(readFileSync(file, 'utf8'), { loader: 'jsx', format: 'esm' }).code);
  built.push(out);
  return '../' + out;
};
let maze, wires, React, renderToStaticMarkup;
try {
  maze = await import('../' + SRC.maze);
  wires = await import(build(SRC.wires, 'wires'));
  React = (await import('react')).default;
  renderToStaticMarkup = (await import('react-dom/server')).renderToStaticMarkup;
} finally {
  for (const f of built) rmSync(f, { force: true });
}
const { sharedLaneDashes, edgeKey } = maze;
const { Wire } = wires;

const pt = (key, x, y) => ({ key, x, y });

// ── 1. the pure decision: shared corridors → alternating dashes, solo edges stay solid ──
console.log('\n── sharedLaneDashes: one dash per sharing trace, solid for solo ──');
const wA = { id: 'a', pts: [pt('E0', 0, 0), pt('N1', 10, 0), pt('A2', 20, 0)] };
const wB = { id: 'b', pts: [pt('E0', 0, 0), pt('N1', 10, 0), pt('B2', 20, 10)] };
const two = sharedLaneDashes([wA, wB], 8);
ok(two.get('a')[0].dash === '8 8' && two.get('a')[0].offset === 0,
   `two traces sharing a corridor: trace 0 owns the first dash slot (${two.get('a')[0].dash} @ ${two.get('a')[0].offset})`);
ok(two.get('b')[0].dash === '8 8' && two.get('b')[0].offset === 8,
   `and trace 1 the second slot (${two.get('b')[0].dash} @ ${two.get('b')[0].offset})`);
ok(edgeKey('N1', 'E0') === 'E0|N1', 'the edge key is canonical — direction does not matter');
ok(two.get('a')[1].dash === null && two.get('b')[1].dash === null,
   'the divergent solo edges stay solid (dash null)');

const wC = { id: 'c', pts: [pt('E0', 0, 0), pt('N1', 10, 0), pt('C2', 20, 20)] };
const three = sharedLaneDashes([wA, wB, wC], 8);
ok(three.get('a')[0].dash === '8 16' && three.get('a')[0].offset === 0
   && three.get('b')[0].offset === 8 && three.get('c')[0].offset === 16,
   'three traces: dasharray [8,16], offsets cycle 0, 8, 16');

const alone = sharedLaneDashes([wA], 8);
ok(alone.get('a').every((s) => s.dash === null),
   'a wire with no neighbour keeps every edge solid — nothing changes for a lone trace');

// ── 2. RENDER the real <Wire>: the SAME base path overlaid per colour with its dash slot ──
console.log('\n── the real <Wire>, shared corridor ──');
const sharedSeg = (color, dashOffset) => ({
  id: dashOffset === 0 ? 'a' : 'b', color,
  x1: 0, y1: 0, x2: 10, y2: 0, dim: false,
  segs: [{ d: 'M 0 0 L 10 0', dash: '8 8', dashOffset }],
});
const ma = renderToStaticMarkup(React.createElement(Wire, { p: sharedSeg('#35c46b', 0) }));
const mb = renderToStaticMarkup(React.createElement(Wire, { p: sharedSeg('#5b8cff', 8) }));
ok(/d="M 0 0 L 10 0"/.test(ma) && /d="M 0 0 L 10 0"/.test(mb),
   'both traces draw the SAME base path — the corridor is ONE line, not two parallel ones');
ok(ma.includes('stroke="#35c46b"') && ma.includes('stroke-dasharray="8 8"') && !ma.includes('stroke-dashoffset="8"'),
   'trace 0 shows only its slot (colour 0, dashoffset 0)');
ok(mb.includes('stroke="#5b8cff"') && mb.includes('stroke-dasharray="8 8"') && mb.includes('stroke-dashoffset="8"'),
   'trace 1 shows only its slot (colour 1, dashoffset 8) — overlaid they alternate blue/red');

// a solo segment inside a segmented wire stays solid (no dasharray)
const mixed = {
  id: 's', color: '#e0a53b', x1: 0, y1: 0, x2: 20, y2: 0, dim: false,
  segs: [
    { d: 'M 0 0 L 10 0', dash: '8 8', dashOffset: 0 },
    { d: 'M 10 0 L 20 0', dash: null, dashOffset: 0 },
  ],
};
const ms = renderToStaticMarkup(React.createElement(Wire, { p: mixed }));
const soloPath = (markup) => {
  const i = markup.indexOf('d="M 10 0 L 20 0"');
  return i < 0 ? '' : markup.slice(i, markup.indexOf('/>', i));
};
ok(soloPath(ms).length > 0 && !soloPath(ms).includes('stroke-dasharray'),
   `the shared part is dashed, the divergent solo part is solid (${soloPath(ms).slice(0, 60)}…)`);
ok(ma.includes('data-wire="a"') && mb.includes('data-wire="b"'),
   'each trace keeps its own data-wire, so hover/relation still work per trace');

// ── 3. source: the lane-split is gone, the collapse is wired in ──────────────
console.log('\n── the three files agree ──');
ok(!/assignLanes/.test(src.maze) && !/offsetPolyline/.test(src.maze),
   'maze.js no longer ships assignLanes/offsetPolyline — the lane-split is genuinely dead');
ok(/export function sharedLaneDashes/.test(src.maze), 'maze.js owns the shared-lane collapse (sharedLaneDashes)');
const wireImport = src.wires.split('\n').find((l) => l.includes("from './hive/maze.js'"));
ok(/sharedLaneDashes/.test(wireImport) && !/assignLanes/.test(wireImport) && !/offsetPolyline/.test(wireImport)
   && !/LANE_PITCH/.test(src.wires),
   'Connectors imports the collapse and no longer lane-splits');
ok(/const gap = WIRE_PITCH/.test(src.canvas) && !/count \* WIRE_PITCH/.test(src.canvas)
   && !/portrait \? lay\.cols/.test(src.canvas),
   'HiveCanvas uses a FIXED single-lane gap — hex size no longer scales with the trace count');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ one lane per corridor, alternating-colour dashes, hexes no longer shrink by trace count');
process.exit(fail ? 1 : 0);
