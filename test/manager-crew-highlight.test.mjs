// HIGHLIGHTING A MANAGER HIGHLIGHTS ITS CREW — ticket #24.
//
// seatXells already sits a manager's crew in the cells NEAREST to it, so the ONE real relationship in
// the honeycomb (every other adjacency is a coincidence of packing) was half-expressed by layout and
// not at all by interaction: hovering a manager told you nothing about which of the cells around it
// were actually its own. This is that interaction, and three rules shape it:
//
//   1. RELATED, not also-selected. The manager is the thing chosen; a crew member was chosen by
//      nobody. So the mark borrows none of selection's language (no lifted wash, no thickened status
//      stroke, no bloom) — it is a dashed tie-ring plus the WORD for the relation.
//   2. The WORD is the signal, colour reinforces. A highlight that is only a hue fails for a reader
//      who cannot separate those hues, so the mark carries 'crew' / 'manager' in words AND a dash
//      pattern, neither of which is a colour.
//   3. LIVE crew only — the same rule the work tracker resolves a live zee with (server/src/lib/
//      work-items.js LIVE_XELL_STATUSES: 'retired' is gone, 'husk'/'error' are vacant). A reaped
//      worker glowing as though it were still there draws a crew that does not exist.
//
// The honeycomb is a CANVAS: there is no DOM node per cell and no CSS to lean on, so the highlight is
// DRAWN. This test therefore runs the REAL module (HiveCanvas.jsx, esbuild-transformed then imported)
// — its pure decisions asserted as data, and its drawing EXECUTED against a recording 2D context, the
// same shape as test/manager-hexagon.test.mjs.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const SRC = 'web/src/hive/HiveCanvas.jsx';
const src = readFileSync(SRC, 'utf8');
const tmp = 'web/src/hive/.manager-crew-highlight.test-build.mjs';
writeFileSync(tmp, transformSync(src, { loader: 'jsx', format: 'esm' }).code);
let mod;
try { mod = await import('../' + tmp); } finally { rmSync(tmp, { force: true }); }
const { isLiveXell, crewLinks, relatedTo, hexDim, relationTag, drawRelationMark,
        drawManagerHex, drawCompactHex, managerCard } = mod;

// ── the fleet under test: one manager with three workers (one of them REAPED), a second manager
//    with no crew at all, and a loner nobody manages ──────────────────────────
const mgr = {
  id: 'M', slug: 'wise-cove', zee_type: 'manager', status: 'claimed', hive_status: 'occ-working',
  db_coupling: 'db-prod-readonly', branch: 'spinoff/wise-cove', stack: [],
  created_at: new Date(Date.now() - 3600e3).toISOString(),
};
const empty = { ...mgr, id: 'M2', slug: 'lone-boss' };
const w1 = { id: 'w1', slug: 'alpha', zee_type: 'worker', manager_xell_id: 'M', status: 'working',
  hive_status: 'occ-working', zee_status: 'working', cli_active: true, head_commit: 'feedface00', stack: [] };
const w2 = { id: 'w2', slug: 'beta', zee_type: 'worker', manager_xell_id: 'M', status: 'claimed',
  hive_status: 'occ-landRequest', zee_status: 'idle', head_commit: 'c0ffee0000', stack: [] };
const dead = { id: 'w3', slug: 'gamma', zee_type: 'worker', manager_xell_id: 'M', status: 'husk',
  hive_status: 'vac-dirty', stack: [] };
const loner = { id: 'L', slug: 'solo', zee_type: 'worker', status: 'working', hive_status: 'occ-working', stack: [] };
const fleet = [mgr, empty, w1, w2, dead, loner];

// ── 1. liveness: who may lend a highlight at all ─────────────────────────────
console.log('\n── only a LIVE crew member lends a highlight ──');
ok(isLiveXell(w1) && isLiveXell(mgr), 'a working xell and a claimed manager are live');
ok(!isLiveXell(dead) && !isLiveXell({ status: 'retired' }) && !isLiveXell({ status: 'error' }),
   'husk / retired / error are NOT — the three statuses no zee occupies (work-items.js)');
ok(!isLiveXell(null) && !isLiveXell(undefined), 'and nothing at all is not live either');

// ── 2. the links, both ways ──────────────────────────────────────────────────
console.log('\n── the relationship, read straight off the fleet payload (manager_xell_id) ──');
const links = crewLinks(fleet);
ok(links.crewOf.M.map((x) => x.id).join(',') === 'w1,w2',
   `a manager's crew is its LIVE workers only — the husk is dropped (${links.crewOf.M.map((x) => x.slug).join(',')})`);
ok(!links.crewOf.M2, 'a manager with no crew gets no crew list (not an empty one to iterate by accident)');
ok(links.managerOf.w1 === 'M' && links.managerOf.w2 === 'M', 'and each worker knows who it reports to');
ok(!links.managerOf.w3, 'a reaped worker reports to nobody');
ok(!links.managerOf.L, 'and an unmanaged xell has no manager to mark');
ok(crewLinks([{ id: 'x', manager_xell_id: 'GHOST', status: 'working' }]).managerOf.x === undefined,
   'a manager row that is not in the payload cannot be marked as one');
ok(!crewLinks([{ id: 'x', manager_xell_id: 'D', status: 'working' }, { id: 'D', status: 'husk' }]).managerOf.x,
   'nor can a HUSK manager — "who does this one report to" must not answer with a corpse');
ok(Object.keys(crewLinks().crewOf).length === 0, 'crewLinks tolerates no fleet at all');

// ── 3. who lights up: one hop, live, and never the whole neighbourhood ───────
console.log('\n── focus a manager → its crew; focus a worker → its manager ──');
const relM = relatedTo(fleet, 'M', links);
ok([...relM.keys()].sort().join(',') === 'w1,w2', `a manager marks exactly its live crew (${[...relM.keys()]})`);
ok([...relM.values()].every((v) => v === 'crew'), 'and marks them as CREW');
ok(!relM.has('w3'), 'the reaped crew member is NOT marked — it lends nothing');
ok(!relM.has('L') && !relM.has('M2') && !relM.has('M'), 'and nothing else in the fleet is touched');
ok(relatedTo(fleet, 'M2', links).size === 0, 'a manager with no crew marks nothing, and does not throw');
const relW = relatedTo(fleet, 'w1', links);
ok(relW.size === 1 && relW.get('M') === 'manager',
   'a worker marks its MANAGER — the same question asked backwards — and marks it as such');
ok(!relW.has('w2'), 'but NOT its siblings: they share a boss, they are not related to each other');
ok(relatedTo(fleet, 'w3', links).size === 0, 'a reaped worker marks nothing at all');
ok(relatedTo(fleet, 'L', links).size === 0 && relatedTo(fleet, null).size === 0
   && relatedTo(fleet, 'nope').size === 0,
   'a loner, no focus, and an unknown id all mark nothing');

// ── 4. related is never dimmed — that IS the highlight ───────────────────────
console.log('\n── the dim decision: the focus lights its group, the rest recedes ──');
ok(hexDim({ hexId: 'w1', hoverActive: true, hovered: false, related: null }) === true,
   'an unrelated hex dims while something else is hovered');
ok(hexDim({ hexId: 'w1', hoverActive: true, hovered: false, related: 'crew' }) === false,
   'a CREW hex does not dim while its manager is hovered');
ok(hexDim({ hexId: 'M', expandedId: 'w1', related: 'manager' }) === false,
   'nor does the manager while one of its workers is bloomed open');
ok(hexDim({ hexId: 'w1', expandedId: 'M', related: 'crew' }) === false
   && hexDim({ hexId: 'L', expandedId: 'M', related: null }) === true,
   'SELECTING a manager (its flower open) keeps its crew lit and dims everyone else');
ok(hexDim({ hexId: 'M', expandedId: 'M' }) === false && hexDim({ hexId: 'w1', hovered: true, hoverActive: true }) === false,
   'and the focused hex itself never dims');

// ── 5. the WORD, before any colour ───────────────────────────────────────────
console.log('\n── the word is the signal, colour is reinforcement ──');
ok(relationTag('crew', 'wise-cove').word === 'crew' && relationTag('crew').long === 'crew',
   'a crew mark says "crew"');
ok(relationTag('crew', 'wise-cove').long === 'crew of wise-cove',
   'and names the manager it belongs to when there is room for it');
ok(relationTag('manager', 'alpha').word === 'manager' && relationTag('manager', 'alpha').long === 'manager of alpha',
   'a manager mark says "manager", and whose');
ok(relationTag(null) === null && relationTag('selected') === null, 'and there is no third relation');

// ── 6. PAINT IT: the real renderer against a recording 2D context ────────────
// A data test cannot catch a mark that throws, one that paints its word outside the hexagon, or one
// that quietly turns a crew member into something that looks selected. So the drawing is EXECUTED.
function recorder() {
  const rec = { text: [], dash: [], arcs: [], ops: [], alphas: [] };
  const noop = (name) => (...a) => { rec.ops.push(name); return a; };
  const self = {
    rec,
    canvas: { width: 800, height: 600 },
    save: noop('save'), restore: noop('restore'),
    beginPath: noop('beginPath'), closePath: noop('closePath'), moveTo: noop('moveTo'),
    lineTo: noop('lineTo'), rect: noop('rect'), roundRect: noop('roundRect'),
    strokeRect: noop('strokeRect'), ellipse: noop('ellipse'), bezierCurveTo: noop('bezierCurveTo'),
    fill: noop('fill'), clip: noop('clip'), clearRect: noop('clearRect'),
    setTransform: noop('setTransform'), translate: noop('translate'), scale: noop('scale'),
    drawImage: noop('drawImage'),
    stroke() { rec.ops.push('stroke'); rec.strokes = (rec.strokes || 0) + 1; },
    arc(cx, cy, r) { rec.ops.push('arc'); rec.arcs.push({ cx, cy, r }); },
    setLineDash(d) { rec.ops.push('setLineDash'); if (d && d.length) rec.dash.push(d.join(',')); },
    createLinearGradient() { return { addColorStop() {} }; },
    measureText(t) {
      const px = Number((/(\d+(?:\.\d+)?)px/.exec(self.font || '') || [0, 12])[1]);
      return { width: String(t).length * px * 0.55 };
    },
    fillText(t, x, y) { rec.text.push({ t: String(t), x, y, fill: self.fillStyle, alpha: self.globalAlpha }); },
    strokeText(t) { rec.text.push({ t: String(t) }); },
  };
  self.globalAlpha = 1;
  return self;
}
const said = (rec) => rec.text.map((t) => t.t).join(' | ');
const paintWorker = (x, size, opts = {}) => {
  const ctx = recorder();
  drawCompactHex(ctx, { x, id: x.id, cx: 200, cy: 200, size, cell: size, color: '#5b8cff' },
    { hover: false, dim: false, diff: null, machines: [], ...opts });
  return ctx.rec;
};
const paintMgr = (x, size, opts = {}) => {
  const ctx = recorder();
  drawManagerHex(ctx, { x, id: x.id, cx: 200, cy: 200, size, cell: size, color: '#5b8cff' },
    { hover: false, dim: false, crew: [w1, w2], harness: { color: '#9b8cff', glyph: '🧭', label: 'Manager' }, ...opts });
  return ctx.rec;
};

console.log('\n── a CREW member, marked while its manager is the focus ──');
const plain = paintWorker(w1, 70);
const marked = paintWorker(w1, 70, { related: 'crew', relatedTo: 'wise-cove', relColor: '#9b8cff' });
ok(marked.text.some((t) => /\bcrew\b/.test(t.t)), `it says CREW, in words (${said(marked)})`);
ok(!plain.text.some((t) => /\bcrew\b/.test(t.t)), 'and an unmarked worker says no such thing');
ok(marked.dash.includes('2,4'), 'a DASHED tie-ring is stroked around it — a signal that is not a colour');
ok(!plain.dash.includes('2,4'), 'which the unmarked worker does not get');
ok(marked.text.some((t) => t.t === 'alpha') && marked.text.some((t) => /working/.test(t.t)),
   'the card it already had is still whole underneath — identity and status survive the overlay');
ok(marked.text.every((t) => Math.abs(t.y - 200) <= 70) && marked.text.every((t) => Math.abs(t.x - 200) <= 70),
   'and every word it paints stays inside the hexagon');
ok(marked.text.every((t) => t.alpha === 1), 'a marked crew member is painted at FULL opacity — it is not dimmed');
ok(paintWorker(w1, 70, { related: 'crew', dim: true }).text.every((t) => t.alpha === 1) === false,
   'the alpha in the recording really is the dim (a dimmed paint proves the assertion above bites)');

console.log('\n── related ≠ selected ──');
const hovered = paintWorker(w1, 70, { hover: true });
ok(!marked.text.some((t) => /select/i.test(t.t)), 'the mark never says "selected"');
ok(marked.strokes > plain.strokes, 'the mark ADDS a ring rather than restyling the hex it sits on');
ok(JSON.stringify(marked.text.map((t) => [t.t, t.x, t.y]).filter((r) => !/crew/.test(r[0])))
   === JSON.stringify(plain.text.map((t) => [t.t, t.x, t.y])),
   'and it moves nothing the card already said — the hexagon is not restated as a selection');
ok(hovered.dash.length === 0,
   'HOVER (selection’s own language) uses no dash at all, so the two can never be confused');

console.log('\n── the reverse: a MANAGER marked while one of its workers is the focus ──');
const mgrPlain = paintMgr(mgr, 70);
const mgrMarked = paintMgr(mgr, 70, { related: 'manager', relatedTo: 'alpha', relColor: '#e0a53b' });
ok(mgrMarked.text.some((t) => /\bmanager\b/.test(t.t) && /alpha|^⬢ manager/.test(t.t)),
   `the manager hexagon says what it is to the focused worker (${said(mgrMarked)})`);
ok(mgrMarked.dash.includes('2,4'), 'it gets the same dashed tie-ring');
ok(mgrMarked.dash.includes('5,3') && mgrPlain.dash.includes('5,3'),
   'and KEEPS its dashed persona seat + prod wall — the manager hexagon that landed today is untouched');
ok(mgrMarked.text.some((t) => t.t === '⬢ wise-cove') && mgrMarked.text.some((t) => /read-only/.test(t.t))
   && mgrMarked.text.some((t) => t.t === '🧭'),
   'identity, its read-only hold on prod and its persona glyph all still paint');
ok(mgrMarked.text.every((t) => Math.abs(t.y - 200) <= 70), 'and nothing it paints leaves the hexagon');

console.log('\n── every size branch, and the sane-by-default cases ──');
for (const size of [70, 40, 20]) {
  const w = paintWorker(w1, size, { related: 'crew', relatedTo: 'wise-cove' });
  const m = paintMgr(mgr, size, { related: 'manager', relatedTo: 'alpha' });
  ok(w.dash.includes('2,4') && m.dash.includes('2,4'),
     `size ${size}: both hexes still carry the tie-ring (a hex too small to read keeps the not-colour signal)`);
  const words = [...w.text, ...m.text].filter((t) => /\bcrew\b|\bmanager\b/.test(t.t));
  ok(size >= 30 ? words.length > 0 : words.length === 0,
     `size ${size}: the word is painted where it can be read, and not squeezed in where it cannot`);
}
ok(drawRelationMark(recorder(), 10, 10, 70, { kind: null }) === null,
   'no relation, no mark at all (the draw is a no-op, not a stray ring)');
ok(paintMgr(empty, 70, { crew: [] }).text.some((t) => /no crew yet/.test(t.t)),
   'a manager with NO crew still states it, and nothing about the highlight changed that');
ok(managerCard(mgr, crewLinks(fleet).crewOf.M).count === 2,
   'and the crew COUNT on the card is the live count — the husk is not counted either');

// ── 7. the wiring: the canvas actually consults all of this ──────────────────
console.log('\n── the honeycomb wires it up (what only the source can show) ──');
ok(/const \{ crewOf, managerOf \} = crewLinks\(list\)/.test(src),
   'the draw loop builds the links from the fleet list it already has — no per-hover request');
ok(/const focusId = H\.id \|\| expandedId \|\| null/.test(src),
   'the focus is the hovered hex, or the SELECTED one when nothing is hovered');
ok(/const related = relatedTo\(list, focusId, \{ crewOf, managerOf \}\)/.test(src),
   'and the marks come from relatedTo, not from a second copy of the rule');
ok(/const dim = hexDim\(\{ hexId: hx\.id, expandedId, hovered, hoverActive, related: rel \}\)/.test(src),
   'the dim decision goes through the tested hexDim');
ok(/drawManagerHex\(ctx, hx, \{[\s\S]{0,220}\.\.\.relArgs \}\)/.test(src)
   && /drawCompactHex\(ctx, hx, \{[\s\S]{0,160}\.\.\.relArgs \}\)/.test(src),
   'BOTH hexagons are handed the mark — a manager can be the related one too');
ok(/relColor = focusId \? \(tById\[focusId\]\?\.color \|\| null\)/.test(src),
   'the mark is tinted with the FOCUS’s own trace colour — the same line its wire is drawn in');
ok(!/for \(const x of list\) if \(x\.manager_xell_id\)/.test(src),
   'the draw loop no longer groups the crew by hand — that hand-rolled pass had no liveness rule at all');
const drawBody = src.slice(src.indexOf('const draw = useCallback'), src.indexOf('useLayoutEffect(() =>'));
ok(!/manager_xell_id/.test(drawBody),
   'and the draw loop names manager_xell_id nowhere — the relationship is read through crewLinks alone');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ a manager lights its crew, in words');
process.exit(fail ? 1 : 0);
