// THE LAST TWO SURFACES THAT COULD NOT ANSWER "WHOSE CREW IS THIS?" — ticket #28.
//
// #24 marked the honeycomb hexes, #25 carried the same relation into the wires and the graph's commit
// dots. Two surfaces were left, and they are the two a human actually READS once the question has
// already occurred to them:
//
//   1. THE BLOOM'S CREW FACET — petal 5 of a manager's flower. It listed the crew as coloured dots and
//      led NOWHERE: the one place the relation was spelled out was the one place you could not follow
//      it. The dots are now rows — hovering one lights that worker's hexagon, its wire and its commit
//      dot (the machinery from #24/#25, reached from here), and clicking one opens its own bloom. The
//      dots were also a COLOUR-ONLY signal, so a hovered one now says the worker's NAME.
//   2. THE DOM CARD/CHIP ROWS — the fleet's only non-canvas view. A list is a different projection: it
//      has no focus, it is scanned, and "whose crew?" is asked of every row at once. So the cue there
//      is a PERSISTENT WORD (⬡ crew of wise-cove / ⬢ 3 crew), not a transient highlight — which also
//      means it can never be mistaken for the row being selected.
//
// Same rule as everywhere: hive/crew.js, live crew only, no new grouping. Exercised the way each
// surface is drawn — the canvas facet PAINTED into a recording 2D context, the chip RENDERED with
// react-dom/server and its markup read back.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const SRC = { canvas: 'web/src/hive/HiveCanvas.jsx', chip: 'web/src/CrewChip.jsx', app: 'web/src/App.jsx',
              css: 'web/src/styles.css' };
const src = Object.fromEntries(Object.entries(SRC).map(([k, f]) => [k, readFileSync(f, 'utf8')]));
const built = [];
const build = (file, tag) => {
  const out = file.replace(/\/([^/]+)$/, `/.${tag}.test-build.mjs`);
  writeFileSync(out, transformSync(readFileSync(file, 'utf8'), { loader: 'jsx', format: 'esm' }).code);
  built.push(out);
  return '../' + out;
};
let canvas, chip, crew, React, renderToStaticMarkup;
try {
  canvas = await import(build(SRC.canvas, 'facet'));
  chip = await import(build(SRC.chip, 'chip'));
  crew = await import('../web/src/hive/crew.js');
  React = (await import('react')).default;
  renderToStaticMarkup = (await import('react-dom/server')).renderToStaticMarkup;
} finally {
  for (const f of built) rmSync(f, { force: true });
}
const { crewDotLayout, flowerCrewRects, CREW_PETAL, managerFacets, drawFlower } = canvas;
const { crewLinks } = crew;
const CrewChip = chip.default;

// ── the fleet: a manager, two live crew, one REAPED, a loner ─────────────────
const mgr = { id: 'M', slug: 'wise-cove', zee_type: 'manager', status: 'working', hive_status: 'occ-working',
  db_coupling: 'db-prod-readonly', branch: 'spinoff/wise-cove', stack: [], created_at: new Date(Date.now() - 3600e3).toISOString() };
const w1 = { id: 'w1', slug: 'alpha', zee_type: 'worker', manager_xell_id: 'M', status: 'working',
  hive_status: 'occ-working', zee_status: 'working', cli_active: true };
const w2 = { id: 'w2', slug: 'beta', zee_type: 'worker', manager_xell_id: 'M', status: 'idle',
  hive_status: 'occ-landRequest', zee_status: 'idle' };
const dead = { id: 'w3', slug: 'gamma', zee_type: 'worker', manager_xell_id: 'M', status: 'husk', hive_status: 'vac-dirty' };
const loner = { id: 'L', slug: 'solo', zee_type: 'worker', status: 'working', hive_status: 'occ-working' };
const fleet = [mgr, w1, w2, dead, loner];
const links = crewLinks(fleet);

// ── 1. the dot row is GEOMETRY, shared by the drawing and the pointer ────────
console.log('\n── the crew dots: one layout, drawn and hit-tested from the same function ──');
const lay = crewDotLayout(200, 200, 60, 3);
ok(lay.dots.length === 3 && lay.shown === 3 && lay.hidden === 0, 'one dot per crew member');
ok(lay.dots[0].x < lay.dots[1].x && lay.dots[1].x < lay.dots[2].x
   && lay.dots.every((d) => d.y === lay.dots[0].y),
   'laid out in a row, in crew order');
ok(Math.abs((lay.dots[0].x + lay.dots[2].x) / 2 - 200) < 0.01, 'and centred in the petal');
const big = crewDotLayout(200, 200, 60, 30);
ok(big.shown === 12 && big.hidden === 18 && big.dots.length === 12,
   'a crew bigger than the row is CAPPED, and the remainder is counted (drawn as "+18"), not crammed in');
ok(crewDotLayout(200, 200, 60, 0).dots.length === 0, 'no crew, no dots, no throw');

console.log('\n── …and the pick targets are those same dots ──');
const centers = Array.from({ length: 7 }, (_, i) => [100 + i * 50, 100 + i * 10]);
const rects = flowerCrewRects(centers, 60, links.crewOf.M);
ok(rects.length === 2 && rects.map((r) => r.id).join(',') === 'w1,w2',
   `one target per LIVE crew member, in order (${rects.map((r) => r.slug)}) — the husk has none`);
const petalLay = crewDotLayout(centers[CREW_PETAL][0], centers[CREW_PETAL][1], 60, 2);
ok(rects.every((r, i) => r.x === petalLay.dots[i].x && r.y === petalLay.dots[i].y),
   'each target sits exactly where its dot is drawn — the dot you point at is the worker you get');
ok(rects.every((r) => r.r >= 7 && r.r > petalLay.r),
   `the pick radius is padded past the drawn dot (${rects[0].r} > ${petalLay.r}) — a 3px disc is not a target`);
ok(flowerCrewRects(centers, 60, []) === null && flowerCrewRects(null, 60, links.crewOf.M) === null,
   'an empty crew (or a bloom that has not been laid out) records nothing to hit');
ok(CREW_PETAL === 5, 'the crew facet is petal 5 — the same index managerFacets fills (one constant)');
ok(managerFacets(mgr, [], links.crewOf.M)[CREW_PETAL].kind === 'crew',
   'and that IS the crew facet, so the geometry and the data cannot drift apart');

// ── 2. PAINT the bloom and read what the facet said ─────────────────────────
console.log('\n── the crew facet, painted ──');
function recorder() {
  const rec = { text: [], lines: [], arcs: [], dash: [] };
  const noop = () => {};
  const self = {
    rec, canvas: { width: 900, height: 700 },
    save: noop, restore: noop, beginPath: noop, closePath: noop, rect: noop, roundRect: noop,
    strokeRect: noop, ellipse: noop, bezierCurveTo: noop, fill: noop, clip: noop, clearRect: noop,
    setTransform: noop, translate: noop, scale: noop, drawImage: noop, stroke: noop,
    moveTo(x, y) { self._m = [x, y]; },
    lineTo(x, y) { self.rec.lines.push({ from: self._m, to: [x, y] }); },
    arc(cx, cy, r) { rec.arcs.push({ cx, cy, r, fill: self.fillStyle, stroke: self.strokeStyle }); },
    setLineDash(d) { if (d && d.length) rec.dash.push(d.join(',')); },
    createLinearGradient() { return { addColorStop() {} }; },
    measureText(t) {
      const px = Number((/(\d+(?:\.\d+)?)px/.exec(self.font || '') || [0, 12])[1]);
      return { width: String(t).length * px * 0.55 };
    },
    fillText(t, x, y) { rec.text.push({ t: String(t), x, y }); },
    strokeText(t) { rec.text.push({ t: String(t) }); },
  };
  self.globalAlpha = 1;
  return self;
}
const bloom = (hoverId = null, crewList = links.crewOf.M) => {
  const ctx = recorder();
  drawFlower(ctx, centers, 60, mgr, null, [], '#9b8cff', crewList, { hoverId });
  return ctx.rec;
};
const said = (rec) => rec.text.map((t) => t.t).join(' | ');
const idle = bloom(null);
ok(idle.text.some((t) => t.t === '⬡ ×2'), `the facet heads the row with the LIVE count (${said(idle)})`);
ok(idle.text.some((t) => /hover a dot/.test(t.t)),
   'and says what the dots are for, in words — a canvas has no cursor:pointer to discover');
ok(idle.lines.some((l) => Math.abs(l.from[1] - l.to[1]) < 0.01 && Math.abs(l.to[0] - l.from[0]) > 4),
   'with a hairline under the row: the same "this is a link" affordance the diff stats wear');
ok(idle.text.some((t) => /1 working|1 waiting/.test(t.t)),
   'the crew ACTIVITY is still there — the affordance was added beside the information, not over it');
ok(!idle.text.some((t) => /alpha|beta/.test(t.t)), 'and no worker is named while none is pointed at');

const onW1 = bloom('w1');
ok(onW1.text.some((t) => /^⬡ alpha/.test(t.t)),
   `hovering a dot NAMES that worker — the dots were colour-only until now (${said(onW1)})`);
ok(/click to open/.test(said(onW1)), 'and says what a click will do with it');
ok(!onW1.text.some((t) => /^⬡ beta/.test(t.t)), 'only the one under the cursor is named');
const ringOf = (rec, i) => {
  const l = crewDotLayout(centers[CREW_PETAL][0], centers[CREW_PETAL][1], 60, 2);
  return rec.arcs.filter((a) => Math.abs(a.cx - l.dots[i].x) < 0.01 && Math.abs(a.cy - l.dots[i].y) < 0.01);
};
ok(Math.max(...ringOf(onW1, 0).map((a) => a.r)) > Math.max(...ringOf(idle, 0).map((a) => a.r)),
   'the hovered dot grows, so the row you are on is unmistakable');
ok(ringOf(onW1, 1).every((a) => a.r === ringOf(idle, 1).map((x) => x.r)[0]),
   'and its neighbours do not move');
const bigBloom = (() => { const ctx = recorder();
  drawFlower(ctx, centers, 60, mgr, null, [], '#9b8cff',
    Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, slug: 's' + i })), { hoverId: null });
  return ctx.rec; })();
ok(bigBloom.text.some((t) => t.t === '+18'), 'a crew of 30 shows twelve dots and counts the rest');
const empty = bloom(null, []);
ok(empty.text.some((t) => t.t === '⬡ no crew') && /nothing dispatched/.test(said(empty)),
   'an empty crew is STATED, and offers no affordance for dots that are not there');
ok(!/hover a dot/.test(said(empty)), '…so it does not invite a hover that cannot land');

// ── 3. the wiring: the pointer really consults those targets ────────────────
console.log('\n── the honeycomb wires the dots up ──');
ok(/geomRef\.current\.crew = isManagerXell\(expanded\)\s*\?\s*flowerCrewRects\(centers, cellSize, crewOf\[expanded\.id\] \|\| \[\]\)/.test(src.canvas),
   'the bloom records its crew targets from crewOf — LIVE crew, the same grouping the hexes use');
ok(/const hitCrew = useCallback/.test(src.canvas)
   && /\(wx - d\.x\) \*\* 2 \+ \(wy - d\.y\) \*\* 2 <= d\.r \*\* 2/.test(src.canvas),
   'hitCrew tests DISTANCE, because a dot is a circle and a box around it would steal its neighbours');
ok(/const cw = hitCrew\(wx, wy\);[\s\S]{0,400}emitHover\(\{ id: cw\?\.id \|\| null/.test(src.canvas),
   'a hover over a dot emits THAT worker’s id — which is how the crew list leads back to its hexagons');
ok(/const cw = hitCrew\(wx, wy\);\n\s*if \(cw && cw\.id !== expandedId\) \{ setExpandedId\(cw\.id\); return; \}/.test(src.canvas),
   'and a click on one opens that worker’s own bloom');
ok(/cursor = cw \|\| b \|\|/.test(src.canvas), 'the cursor becomes a pointer over a dot, as it does over every other target');
ok(/\{ hoverId: H\.id \}/.test(src.canvas), 'and the facet is told which dot is hovered, so it can ring and name it');

// ── 4. the DOM chip: a list gets a WORD, not a highlight ────────────────────
console.log('\n── the card/chip rows: the relation as a persistent word ──');
const render = (x) => renderToStaticMarkup(React.createElement(CrewChip, { x, links }));
const cw1 = render(w1);
ok(/crew of wise-cove/.test(cw1), `a managed worker says whose crew it is (${cw1})`);
ok(/data-crew="crew"/.test(cw1) && /class="crewchip"/.test(cw1), 'as a chip the DOM can be asserted on');
const cm = render(mgr);
ok(/2 crew/.test(cm) && /data-crew="manager"/.test(cm),
   `a manager says how big its LIVE crew is — 2, not 3, with a husk in the fleet (${cm})`);
ok(/wise-cove/.test(cw1) && /Runs 2 live crew: alpha, beta/.test(cm),
   'and both name the other end of the relation in their tooltip');
ok(render(loner) === '', 'a xell nobody dispatched states nothing — no empty chip to read past');
ok(render(dead) === '',
   'and a REAPED crew member claims no crew membership: crewLinks never gave it a manager');
ok(render({ ...mgr, id: 'M2' }) !== '' && /no crew/.test(render({ ...mgr, id: 'M2' })),
   'a manager with no live crew says so rather than going blank — the same rule its hexagon follows');
ok(!/active/.test(cw1) && !/selected/.test(cw1),
   'the chip borrows nothing from the SELECTED state of the row it sits on');

console.log('\n── and it is one word, in one place ──');
ok(!/relationTag|isManagerXell/.test(src.app.split('function App()')[1] || src.app),
   'App does not re-word the relation — CrewChip owns the markup, hive/crew.js owns the words');
ok(/const crewOfFleet = crewLinks\(xells\)/.test(src.app),
   'App computes the grouping ONCE per render and hands it down (not once per row)');
ok(/links=\{crewOfFleet\}/.test(src.app), 'to the "waiting on you" chips');
ok(/<CrewChip x=\{x\} links=\{links\} \/>/.test(src.app) && /<CrewChip x=\{w\.x\} links=\{links\} \/>/.test(src.app),
   'and BOTH DOM surfaces render the same component');
ok(/\.crewchip \{/.test(src.css) && /border-left: 2px dashed/.test(src.css),
   'the chip is styled in the machine/env chips’ quiet language, with the relation dash on its edge');
ok(/\.crewchip\[data-crew="manager"\] \{ border-left-style: solid/.test(src.css),
   'and a MANAGER’s chip is solid — it HAS a crew, it is not "related to" one');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ both surfaces can answer "whose crew is this?"');
process.exit(fail ? 1 : 0);
