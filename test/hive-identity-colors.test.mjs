// THE ROUTER (WHITE) AND PRODUCTION (LIME GREEN) IDENTITY FILLS — ticket: console honeycomb color.
//
// A router xell (a manager-type zee wearing the `router` harness — server/src/lib/router.js, 139) and
// a PRODUCTION xell (is_production) are the two hexagons that do NOT take their colour from the
// status palette: each is an IDENTITY — "the front door" / "the live fleet" — so statusColor returns
// WHITE / LIME GREEN respectively, ABOVE the momentary hive_status. Every other hex keeps its
// status-based colour, and text on the two identity fills flips to DARK ink so the card stays legible
// on a painted-white/lime hexagon.
//
// The colour decision is a pure function (statusColor), so it is asserted directly; what can only be
// drawn is asserted against a recording 2D context, the same way manager-hexagon.test.mjs does.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const SRC = 'web/src/hive/HiveCanvas.jsx';
const src = readFileSync(SRC, 'utf8');
const tmp = 'web/src/hive/.identity-colors.test-build.mjs';
writeFileSync(tmp, transformSync(src, { loader: 'jsx', format: 'esm' }).code);
let mod, crew;
try {
  mod = await import('../' + tmp);
  crew = await import('../web/src/hive/crew.js');
} finally { rmSync(tmp, { force: true }); }
const { statusColor, drawCompactHex, drawManagerHex } = mod;
const { isRouterXell } = crew;

// ── the four kinds of xell under test ─────────────────────────────────────────
const router = {
  id: 'R', slug: 'router-4f31', zee_type: 'manager', harness_key: 'router',
  db_coupling: 'db-prod-readonly', hive_status: 'occ-working', hive_status_label: 'working',
  status: 'claimed', branch: 'spinoff/router-4f31', head_commit: 'ab7f00d1',
  created_at: new Date(Date.now() - 4 * 3600e3).toISOString(),
  stack: [{ role: 'db', name: 'db-r', health: 'up' }],
};
const prod = {
  id: 'P', slug: 'production', is_production: true, hive_status: 'live-protected',
  hive_status_label: 'protected', status: 'working', db_coupling: 'db-shared-prod',
  branch: 'main', head_commit: 'deadbeefcafe0000', deployed_commit: 'deadbeefcafe0000',
  created_at: new Date(Date.now() - 3600e3).toISOString(),
  stack: [{ role: 'server', name: 'srv-prod', health: 'up' }],
};
const worker = {
  id: 'W', slug: 'calm-ridge', zee_type: 'worker', harness_key: 'builder',
  hive_status: 'occ-working', hive_status_label: 'working', status: 'working',
  branch: 'spinoff/calm-ridge', head_commit: 'feedface0000',
  created_at: new Date(Date.now() - 3600e3).toISOString(),
  stack: [{ role: 'db', name: 'db-w', health: 'up' }],
};

// ── 1. the predicate ─────────────────────────────────────────────────────────
ok(isRouterXell(router) && !isRouterXell(prod) && !isRouterXell(worker) && !isRouterXell(null),
   'isRouterXell keys on the router harness key, and tolerates a missing xell');

// ── 2. the colour decision is identity-first, above hive_status ─────────────
ok(statusColor(router) === '#ffffff', `the ROUTER hexagon paints WHITE (${statusColor(router)})`);
ok(statusColor(prod) === '#9ccf3f', `a PRODUCTION hexagon paints LIME GREEN (${statusColor(prod)})`);
// every OTHER xell keeps its status-based colour, exactly as before:
ok(statusColor(worker) === '#35c46b', `a working worker keeps the status green (${statusColor(worker)})`);
ok(statusColor({ ...worker, hive_status: 'occ-idle', hive_status_label: 'idle' }) === '#e0a53b',
   'and an idle worker keeps the status amber');
ok(statusColor({ ...worker, hive_status: 'occ-tendRequest', hive_status_label: 'tend?' }) === '#f2c518',
   'and a tend? worker keeps the status yellow');
// production is lime even when its status says the shields are down — identity overrides activity:
ok(statusColor({ ...prod, hive_status: 'live-unprotected', hive_status_label: 'unprotected' }) === '#9ccf3f',
   'a production hexagon stays lime even while unprotected (the pill still says so)');
// a router with no status at all still paints white:
ok(statusColor({ ...router, hive_status: null }) === '#ffffff', 'a router is white whatever its hive status');
// the legacy fallback path (no hive_status) is unchanged for a non-identity xell:
ok(statusColor({ ...worker, hive_status: null, status: 'idle' }) === '#e0a53b',
   'the legacy lifecycle fallback still answers for a payload that predates hive_status');

// ── 3. PAINT it: the recording context catches what statusColor cannot ───────
// The two identity hexagons must read legibly — dark ink for the card text on a painted-white/lime
// fill — and the seat wash must be near-OPAQUE (a white wash over the dark pane would be grey).
function recorder() {
  const rec = { text: [], stops: [], fills: [] };
  const noop = (name) => (...a) => { rec.ops?.push(name); return a; };
  const self = {
    rec,
    canvas: { width: 800, height: 600 },
    save: noop('save'), restore: noop('restore'),
    beginPath: noop('beginPath'), closePath: noop('closePath'), moveTo: noop('moveTo'),
    lineTo: noop('lineTo'), rect: noop('rect'), roundRect: noop('roundRect'),
    strokeRect: noop('strokeRect'), ellipse: noop('ellipse'), bezierCurveTo: noop('bezierCurveTo'),
    quadraticCurveTo: noop('quadraticCurveTo'), arc: noop('arc'),
    fill() { rec.fills.push(self.fillStyle); },
    stroke: noop('stroke'), clip: noop('clip'), clearRect: noop('clearRect'),
    setTransform: noop('setTransform'), translate: noop('translate'), scale: noop('scale'),
    drawImage: noop('drawImage'),
    setLineDash(d) { if (d && d.length) rec.dash?.push(d.join(',')); },
    createLinearGradient() { return { addColorStop(off, col) { rec.stops.push({ off, col }); } }; },
    measureText(t) {
      const px = Number((/(\d+(?:\.\d+)?)px/.exec(self.font || '') || [0, 12])[1]);
      return { width: String(t).length * px * 0.55 };
    },
    fillText(t, x, y) { rec.text.push({ t: String(t), fill: self.fillStyle, alpha: self.globalAlpha }); },
    strokeText(t) { rec.text.push({ t: String(t) }); },
  };
  return self;
}
const paintCompact = (x, size = 70) => {
  const ctx = recorder();
  drawCompactHex(ctx, { x, id: x.id, cx: 200, cy: 200, size, cell: size, color: '#5b8cff' },
    { hover: false, dim: false, machines: [] });
  return ctx.rec;
};
const paintManager = (x, size = 70) => {
  const ctx = recorder();
  drawManagerHex(ctx, { x, id: x.id, cx: 200, cy: 200, size, cell: size, color: '#5b8cff' },
    { hover: false, dim: false, crew: [] });
  return ctx.rec;
};

// the ROUTER is a manager-type xell → drawManagerHex. Its identity label (⬢ slug) must be DARK.
const rRec = paintManager(router);
const rLabel = rRec.text.find((t) => t.t.includes('router-4f31'));
ok(rLabel && rLabel.fill === '#0d1017', `the router's identity label reads in DARK ink on its white fill (${rLabel?.fill})`);
// the seat wash is near-opaque white (not a faint wash):
ok(rRec.stops.some((s) => s.col.startsWith('rgba(255,255,255,0.9') || s.col === 'rgba(255,255,255,1'),
   `the router's seat wash is near-opaque white (${rRec.stops[0]?.col})`);

// a PRODUCTION xell is a worker card → drawCompactHex. Its label ('🛡 PRODUCTION') must be DARK.
const pRec = paintCompact(prod);
const pLabel = pRec.text.find((t) => t.t.includes('PRODUCTION'));
ok(pLabel && pLabel.fill === '#0d1017', `production's identity label reads in DARK ink on its lime fill (${pLabel?.fill})`);
ok(pRec.stops.some((s) => s.col.startsWith('rgba(156,207,63,0.9') || s.col.startsWith('rgba(156,207,63,1')),
   `production's seat wash is near-opaque lime (${pRec.stops[0]?.col})`);
const pSha = pRec.text.find((t) => t.t === 'deadbeef');
ok(pSha && pSha.fill === '#0d1017', `production's deployed sha reads in DARK ink on its lime fill (${pSha?.fill})`);

// a plain worker keeps the LIGHT ink — untouched:
const wRec = paintCompact(worker);
const wLabel = wRec.text.find((t) => t.t.includes('calm-ridge'));
ok(wLabel && wLabel.fill === '#e6ebf2', `a worker's label keeps the existing light ink (${wLabel?.fill})`);

console.log(fail ? `\n✗ ${fail} FAIL` : '\n✓ all passed');
process.exit(fail ? 1 : 0);
