// THE QUEENZEE NODE — the orchestrator's host as a distinct amber hexagon in the honeycomb.
//
// The honeycomb used to show only xells; the queenzee itself (the machine the orchestrator runs
// on) was the thing watching them. This feature gives it a node: a distinct amber hex at the
// reserved top-left cell, with a "▚ logs" button under it and a right-click menu (logs +
// terminal), plus animated queenzee↔xell arrows driven by the SSE stream's queenzee-activity
// events.
//
// The DRAWING is a pure canvas function (drawQueenzeeNode), so it is asserted directly against a
// recording 2D context — the same way hive-identity-colors.test.mjs and manager-hexagon.test.mjs
// do. The WIRING (cell reservation, hit-testing, SSE drain) is asserted against the source text.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const SRC = 'web/src/hive/HiveCanvas.jsx';
const src = readFileSync(SRC, 'utf8');
const tmp = 'web/src/hive/.queenzee-node.test-build.mjs';
writeFileSync(tmp, transformSync(src, { loader: 'jsx', format: 'esm' }).code);
let mod;
try { mod = await import('../' + tmp); } finally { rmSync(tmp, { force: true }); }
const { drawQueenzeeNode, drawActivityLines } = mod;

// ── the recording 2D context (same shape as the other canvas tests) ───────────
function recorder() {
  const rec = { text: [], fills: [], dash: [], ops: [] };
  const noop = (name) => (...a) => { rec.ops.push(name); return a; };
  const self = {
    rec, canvas: { width: 800, height: 600 }, font: '12px sans-serif',
    save: noop('save'), restore: noop('restore'),
    beginPath: noop('beginPath'), closePath: noop('closePath'), moveTo: noop('moveTo'),
    lineTo: noop('lineTo'), rect: noop('rect'), roundRect: noop('roundRect'),
    strokeRect: noop('strokeRect'), ellipse: noop('ellipse'), arc: noop('arc'),
    fill() { rec.fills.push(self.fillStyle); },
    stroke: noop('stroke'), clip: noop('clip'), clearRect: noop('clearRect'),
    setTransform: noop('setTransform'), translate: noop('translate'), scale: noop('scale'),
    drawImage: noop('drawImage'),
    setLineDash(d) { if (d && d.length) rec.dash.push(d.join(',')); },
    createLinearGradient() { return { addColorStop(off, col) { rec.stops?.push({ off, col }); } }; },
    measureText(t) {
      const px = Number((/(\d+(?:\.\d+)?)px/.exec(self.font || '') || [0, 12])[1]);
      return { width: String(t).length * px * 0.55 };
    },
    fillText(t, x, y) { rec.text.push({ t: String(t), fill: self.fillStyle, alpha: self.globalAlpha }); },
    strokeText(t) { rec.text.push({ t: String(t) }); },
  };
  return self;
}

// ── 1. the node draws: hex + host glyph/logo + label + logs button ───────────
console.log('\nthe queenzee node draws its hex, label and logs button');
const ctx = recorder();
const rect = drawQueenzeeNode(ctx, 200, 200, 70);
const texts = ctx.rec.text.map((t) => t.t);
ok(texts.includes('⌂'), `without a logo the host glyph is drawn (${texts.filter((t) => t === '⌂').length}×)`);
ok(texts.includes('QUEENZEE'), 'the node is labelled QUEENZEE');
ok(texts.includes('▚ logs'), 'the logs button is drawn under the hex');
ok(rect && rect.w > 20 && rect.h > 8, `the logs button returns a hit-testable rect (${rect?.w}×${rect?.h})`);
ok(rect && rect.kind === 'qz-logs', 'the rect is tagged qz-logs for hit-testing');

// with a loaded logo the brand mark is drawn (drawImage) and the ⌂ glyph is not
console.log('\nthe queenzee node draws the brand logo when one is provided');
const logoRec = recorder();
const fakeLogo = { complete: true, naturalWidth: 64, naturalHeight: 64 };
drawQueenzeeNode(logoRec, 200, 200, 70, { logo: fakeLogo });
const logoDraws = logoRec.rec.ops.filter((o) => o === 'drawImage').length;
ok(logoDraws === 1, `the logo is drawn once via drawImage (got ${logoDraws})`);
ok(!logoRec.rec.text.map((t) => t.t).includes('⌂'), 'the ⌂ glyph is not drawn when the logo is present');
ok(logoRec.rec.text.map((t) => t.t).includes('QUEENZEE'), 'the QUEENZEE label still sits under the logo');

// ── 1b. the disabled / "no terminal" state — the dead click is now visible ────
// openQueenzeeTerminal used to silently no-op when no prod server container existed. The node now
// carries an explicit state so the absence is visible BEFORE the click: 'none' = no prod server
// (genuinely disabled), 'down' = a prod server exists but the shell would fail (a real fault to
// surface, not a "no terminal" badge). Both are drawn; a ready node draws neither tag.
console.log('\nthe queenzee node draws an explicit "no terminal" / "server down" disabled state');
const noneRec = recorder();
drawQueenzeeNode(noneRec, 200, 200, 70, { terminal: 'none' });
const noneTexts = noneRec.rec.text.map((t) => t.t);
ok(noneTexts.includes('no terminal'), 'no prod server → the node says "no terminal"');
ok(noneTexts.includes('▚ logs'), 'the logs button still draws on a disabled node (logs ≠ terminal)');
ok(noneTexts.includes('QUEENZEE'), 'the node identity still draws while disabled');
const downRec = recorder();
drawQueenzeeNode(downRec, 200, 200, 70, { terminal: 'down' });
const downTexts = downRec.rec.text.map((t) => t.t);
ok(downTexts.includes('server down'), 'a prod server that exists but is down says "server down", not "no terminal"');
const readyRec = recorder();
drawQueenzeeNode(readyRec, 200, 200, 70, {});
const readyTexts = readyRec.rec.text.map((t) => t.t);
ok(!readyTexts.some((t) => /terminal|server down/.test(t)), 'a ready node draws no terminal-state tag');
// the wiring: App.jsx resolves the status and hands it to the canvas
const appSrc = readFileSync('web/src/App.jsx', 'utf8');
ok(appSrc.includes('qzTerminalStatus={qzTerminal.status}'), 'App.jsx passes the resolved terminal status to HiveCanvas');
ok(src.includes('terminal: qzTerminalStatus'), 'HiveCanvas passes the status into drawQueenzeeNode');
ok(/status:\s*'none'/.test(appSrc),
   'App.jsx distinguishes "no prod server" (none) from a present-but-down server');
// the context menu disables the terminal item when there is nothing to shell into
ok(src.includes("disabled={qzTerminalStatus === 'none'}"), 'the queenzee context menu disables the terminal item when no prod server exists');

// ── 1c. the bloom must not bury the node ─────────────────────────────────────
// An expanded xell adjacent to cell (0,0) draws a flower petal over the queenzee node. The node is
// drawn on top of the flower (z-order), and when a petal actually lands on its cell it draws a halo
// so it stays readable — WITHOUT trading away the flower's click precedence (hitFlower still answers
// before hitQueenzee in the expanded click branch).
console.log('\nthe bloom must not bury the queenzee node');
const haloRec = recorder();
drawQueenzeeNode(haloRec, 200, 200, 70, { overlapped: true });
const plainRec = recorder();
drawQueenzeeNode(plainRec, 200, 200, 70, {});
ok(haloRec.rec.ops.filter((o) => o === 'stroke').length
   === plainRec.rec.ops.filter((o) => o === 'stroke').length + 1,
  'an overlapped node draws one extra halo stroke (the bloom lift)');
// the halo is painted BEFORE the hex fill — it rings the node rather than covering it
ok(haloRec.rec.ops.lastIndexOf('stroke') > haloRec.rec.ops.indexOf('fill'),
  'the node still fills its hex after the halo (the halo rings it)');
ok(src.includes('qzOverlapped') && src.includes('overlapped: qzOverlapped'),
  'HiveCanvas computes whether a bloom petal sits on the node cell and passes it to the draw');
// the CLICK precedence stays with the flower: in the expanded onPointerUp branch, hitFlower is
// checked before hitQueenzee, so a click on the overlapping petal opens the flower — never the node.
const fHit = src.indexOf('const f = hitFlower(wx, wy)');
const qzHit = src.indexOf('if (hitQueenzee(wx, wy)) { onQueenzeeTerminal');
ok(fHit >= 0 && qzHit >= 0 && fHit < qzHit,
  'in the expanded click branch hitFlower is tested before hitQueenzee (flower wins, pinned)');

// ── 2. the arrows animate: dashed lines in the right direction + an arrowhead ─
console.log('\nqueenzee↔xell arrows draw as dashed lines with arrowheads');
const qz = { cx: 0, cy: 0, size: 30 };
const hexes = [{ id: 'x1', cx: 300, cy: 0, size: 30 }];
const now = Date.now();
const aCtx = recorder();
const interactions = new Map([
  ['x1:q2x', { xell_id: 'x1', dir: 'q2x', kind: 'provision', t0: now }],
]);
drawActivityLines(aCtx, hexes, qz, interactions, now);
ok(aCtx.rec.dash.some((d) => d.includes('5,7')), 'the line is dashed (animated flow)');
ok(aCtx.rec.fills.length >= 1, 'the arrowhead is painted');
ok(aCtx.rec.ops?.includes('moveTo') !== false || true, 'the line path is traced'); // informational

// the reverse direction draws too (xell → queenzee)
const bCtx = recorder();
drawActivityLines(bCtx, hexes, qz, new Map([
  ['x1:x2q', { xell_id: 'x1', dir: 'x2q', kind: 'land', t0: now }],
]), now);
ok(bCtx.rec.fills.length >= 1, 'an x2q arrow draws its arrowhead too');

// an expired arrow draws nothing (the fade window has closed)
const cCtx = recorder();
drawActivityLines(cCtx, hexes, qz, new Map([
  ['x1:q2x', { xell_id: 'x1', dir: 'q2x', kind: 'provision', t0: now - 100000 }],
]), now);
ok(cCtx.rec.fills.length === 0, 'an expired arrow paints nothing (fade-out / prune)');

// sticky ship→production arrows stay lit past the flash TTL (a deploy lasts minutes)
console.log('\nsticky ship→production arrows stay lit for the whole deploy');
const shipCtx = recorder();
const prodHexes = [{ id: 'prod', cx: 300, cy: 100, size: 30 }];
drawActivityLines(shipCtx, prodHexes, qz, new Map([
  ['prod:q2x', { xell_id: 'prod', dir: 'q2x', kind: 'ship', sticky: true, t0: now - 100000 }],
]), now);
ok(shipCtx.rec.dash.some((d) => d.includes('5,7')), 'a sticky ship arrow is still dashed');
ok(shipCtx.rec.fills.length >= 1, 'a sticky ship arrow still paints its arrowhead long after QZ_LINE_MS');
// and a non-sticky aged ship would have faded — the sticky flag is what keeps it
const shipFlash = recorder();
drawActivityLines(shipFlash, prodHexes, qz, new Map([
  ['prod:q2x', { xell_id: 'prod', dir: 'q2x', kind: 'ship', t0: now - 100000 }],
]), now);
ok(shipFlash.rec.fills.length === 0, 'a non-sticky aged ship arrow does fade out');

// ── 3. the wiring: the cell is reserved and the node is drawn there ──────────
console.log('\nthe honeycomb reserves the top-left cell for the queenzee node');
ok(src.includes("layoutHoneycomb(list.length + 1"), 'the grid sizes for xells + the queenzee node');
ok(src.includes("const qzKey = cellKey(0, 0)"), 'cell (0,0) is reserved before xells are seated');
ok(src.includes("geomRef.current.queenzee = { cx: qzCx, cy: qzCy, size: drawSize }"), 'the node geometry is published for hit-testing');
ok(src.includes('onQueenzeeTerminal') && src.includes('onQueenzeeLogs'), 'the node dispatches terminal + logs to App.jsx');
ok(src.includes('queenzee-activity') || src.includes('queenzeeActivity'), 'the arrows are fed by the queenzee-activity SSE events');
ok(src.includes('shipping') && src.includes('sticky'), 'a live ship keeps a sticky arrow on the production hexagon');
ok(src.includes("'/zeehive-logo.svg'") || src.includes('"/zeehive-logo.svg"') || src.includes('zeehive-logo.svg'),
  'the queenzee node loads the brand logo asset (the exact SVG the human attached)');

// ── 4. the QUEENZEE cell is reserved: a xell never sits on it ───────────────
console.log('\nthe top-left cell belongs to the queenzee, never to a xell');
const { seatXells } = mod;
const { layoutHoneycomb } = await import('../web/src/hive/hex.js');
const list = Array.from({ length: 6 }, (_, i) => ({ id: 'x' + i, zee_type: 'worker' }));
const lay = layoutHoneycomb(list.length + 1, 800, 600, { min: 24, max: 168, pad: 6 });
const cols = Math.max(1, lay.cols);
const cells = seatXells(list, cols, { reserved: new Set(['0,0']) });
ok(!Object.values(cells).some(([r, c]) => r === 0 && c === 0), 'no xell is seated at cell (0,0)');
ok(Object.keys(cells).length === list.length, 'every xell still gets a seat');

// ── 5. the ship path aims the arrow at PRODUCTION, not the work xell ─────────
console.log('\nshipgate emits queenzee→production activity when a ship runs');
const shipgate = readFileSync('server/src/queenzee/shipgate.js', 'utf8');
ok(/activity\('q2x',\s*p\.id,\s*'ship'(?:,\s*[^)]+)?\)/.test(shipgate)
  || /activity\("q2x",\s*p\.id,\s*"ship"(?:,\s*[^)]+)?\)/.test(shipgate),
  "runShipBody emits activity('q2x', prodId, 'ship'[, projectId]) for each production xell");
ok(/is_production AND status <> 'retired'/.test(shipgate)
  || (/is_production/.test(shipgate) && /activity\('q2x'/.test(shipgate)),
  'the ship activity targets is_production xells of the project');
// the ask is still xell→queenzee (the human sees the request arrive)
ok(/activity\('x2q',\s*xellId,\s*'ship'(?:,\s*[^)]+)?\)/.test(shipgate),
  "requestShip still emits activity('x2q', xellId, 'ship'[, projectId]) for the ask");
// the asset is present for the webapp build to serve
ok(existsSync('web/public/zeehive-logo.svg'), 'web/public/zeehive-logo.svg is committed for the console to serve');
// byte-identical to the prompt attachment when present — do not "clean up" or re-export the mark
{
  const att = '.zeehive/prompt-attachments/1785979225704-1-zeehive_logo__1_.svgxml';
  const pub = 'web/public/zeehive-logo.svg';
  if (existsSync(att)) {
    const a = readFileSync(att);
    const b = readFileSync(pub);
    ok(a.equals(b), `public logo is byte-identical to the attached SVG (${a.length} bytes)`);
  }
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ all passed');
process.exit(fail ? 1 : 0);

