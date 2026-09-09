// THE PROJECT HEXAGON'S XELL LEGEND — one status-coloured dot per xell under the project.
//
// A project hexagon reads "5 xells · open ⬡" — a bare count that says nothing about WHO is inside.
// The polish: each xell in the SELECTED project is drawn as a coloured dot under that count, painted
// with the same statusColor its own hexagon would wear one level down, so the count and the dots
// read as the same fleet. The fleet only streams ONE project at a time, so App feeds project_xells
// to the selected project's cell alone; the other project hexagons keep the plain count.
//
// Pure decisions run on the REAL module (esbuild-transformed); the App wiring (project_xells rides
// only the selected project's cell) is asserted against the source text, exactly like
// hive-work-nodes.test.mjs asserts the level composition.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const hive = readFileSync('web/src/hive/HiveCanvas.jsx', 'utf8');
const app = readFileSync('web/src/App.jsx', 'utf8');

// ── 1. the wiring: the selected project's cell carries its fleet ─────────────
console.log('\nthe projects level feeds the xell legend');
ok(/project_xells: p\.id === projectId \? selFleet : null/.test(app),
   'App attaches the streamed fleet as project_xells — but ONLY to the selected project\x27s cell');
ok(/const selFleet = projectId \? gridXells : \[\]/.test(app),
   '…and the fleet used is the project-scoped grid (the selected project\x27s live xells)');

// ── 2. the drawing: a coloured dot per xell, coloured like its own hexagon ────
console.log('\nthe canvas draws one status-coloured dot per xell');
ok(/statusColor\(px\[i\]\)/.test(hive) && /project_xells/.test(hive),
   'drawProjectHex fills each legend dot with statusColor(xell) — the hexagon-fill vocabulary');

const tmp = 'web/src/hive/.project-hex-dots.test-build.mjs';
writeFileSync(tmp, transformSync(hive, { loader: 'jsx', format: 'esm' }).code);
let mod;
try { mod = await import('../' + tmp); } finally { rmSync(tmp, { force: true }); }

// a recording 2D context: every property set is stored, and every paint call is logged with the
// fillStyle in force at call time — so a fill() call whose fillStyle is a hex STRING (not the hex
// gradient object) is exactly one xell legend dot, in order.
const calls = [];
const store = {};
const ctxStub = new Proxy(store, {
  get: (t, k) => {
    if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
    if (k === 'createLinearGradient') return () => ({ addColorStop: () => {} });
    if (k in t) return t[k];
    if (typeof k !== 'string') return undefined;
    return (...a) => { calls.push({ k, a, fill: t.fillStyle }); };
  },
  set: (t, k, v) => { t[k] = v; return true; },
});
const dotFills = () => calls.filter((c) => c.k === 'fill' && typeof c.fill === 'string').map((c) => c.fill);
const fillTexts = () => calls.filter((c) => c.k === 'fillText').map((c) => String(c.a[0]));

// three xells of three very different statuses → three dots, each in ITS OWN hexagon colour
const fleet = [
  { id: 'x1', hive_status: 'occ-working' },                 // green — live work
  { id: 'x2', hive_status: 'vac-ready' },                   // blue — pooled
  { id: 'x3', hive_status: 'live-unprotected' },            // red — prod, shields down
];
const hx = { cx: 100, cy: 100, size: 80, x: { project: { name: 'demo', xell_count: '3' },
  project_xells: fleet } };
mod.drawProjectHex(ctxStub, hx, { hover: false, dim: false });
const fills = dotFills();
ok(fills.length === 3, 'a 3-xell project draws exactly 3 legend dots');
ok(fills[0] === mod.statusColor(fleet[0]) && fills[1] === mod.statusColor(fleet[1])
   && fills[2] === mod.statusColor(fleet[2]),
   'each dot is painted with the statusColor of ITS OWN xell (working→green, ready→blue, unprot→red)');
ok(fillTexts().some((t) => t.includes('3 xells · open ⬡')),
   'the count line still reads "3 xells · open ⬡" above the dots');

// identity xells keep their identity fill — a router dot stays the router white
const router = { id: 'x4', hive_status: 'occ-working', harness_key: 'router' };
calls.length = 0;
mod.drawProjectHex(ctxStub, { cx: 100, cy: 100, size: 80,
  x: { project: { name: 'r', xell_count: '1' }, project_xells: [router] } },
  { hover: false, dim: false });
ok(dotFills().length === 1 && dotFills()[0] === mod.statusColor(router),
   'a router xell\x27s dot is the router identity colour, not its transient hive_status');

// no xells loaded → plain count, no dots (the non-selected project hexagons)
calls.length = 0;
mod.drawProjectHex(ctxStub, { cx: 100, cy: 100, size: 80,
  x: { project: { name: 'other', xell_count: '2' }, project_xells: null } },
  { hover: false, dim: false });
ok(dotFills().length === 0 && fillTexts().some((t) => t.includes('2 xells · open ⬡')),
   'a hexagon without project_xells keeps the bare count and draws no dots');

// overflow: more xells than the bottom band can show → dots are capped and the rest counted in words
const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, hive_status: 'occ-working' }));
calls.length = 0;
mod.drawProjectHex(ctxStub, { cx: 100, cy: 100, size: 60, x: { project: { name: 'big', xell_count: '20' },
  project_xells: many } }, { hover: false, dim: false });
const cap = dotFills().length;
ok(cap > 0 && cap < 20, `a 20-xell project caps the dot row (drew ${cap}, not 20)`);
ok(fillTexts().some((t) => /^\+/.test(t)), 'the overflow is counted in words ("+N"), not crammed in');

// tiny hexagons degrade to a single dot and skip the legend (no room for the per-xell row)
calls.length = 0;
mod.drawProjectHex(ctxStub, { cx: 100, cy: 100, size: 20, x: { project: { name: 't', xell_count: '3' },
  project_xells: fleet } }, { hover: false, dim: false });
ok(dotFills().length === 1, 'a tiny project hexagon shows its single small dot (no per-xell legend)');

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ project-hex xell dots: all green');
process.exit(fail ? 1 : 0);
