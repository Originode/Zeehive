// THE MANAGER HEXAGON — a manager reads as a PERSONA in the grid, not a work-cell.
//
// A manager zee has zero push/PR access to the xource (server/src/queenzee/xellgit.js refuses in
// ctx(), and the landgate declines its push without even raising a request). So the two things a
// worker's hexagon is built around — its head COMMIT and its DIFFSTAT — count work a manager can
// never land, and the buttons beside them can only ever return a refusal. The honeycomb therefore
// draws a manager in the HARNESS BADGE's language (dashed seat + the persona disc of the harness it
// wears) and spends that space on what a manager IS: its crew, and its read-only hold on production.
//
// The decisions behind that are pure functions, so this test runs the REAL module: HiveCanvas.jsx is
// transformed with esbuild (JSX → JS) and imported, rather than a copy of its logic being re-typed
// here. What can only be drawn is asserted against the source text.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const SRC = 'web/src/hive/HiveCanvas.jsx';
const src = readFileSync(SRC, 'utf8');
const tmp = 'web/src/hive/.manager-hexagon.test-build.mjs';
writeFileSync(tmp, transformSync(src, { loader: 'jsx', format: 'esm' }).code);
let mod;
try { mod = await import('../' + tmp); } finally { rmSync(tmp, { force: true }); }
const { isManagerXell, managerCard, managerFacets, petalVerbs, drawManagerHex } = mod;

// ── the fleet under test: one manager, three workers, one loner ───────────────
const mgr = {
  id: 'M', slug: 'wise-cove', zee_type: 'manager', branch: 'spinoff/wise-cove',
  db_coupling: 'db-prod-readonly', hive_status: 'occ-working', status: 'claimed',
  head_commit: 'deadbeefcafe0000', created_at: new Date(Date.now() - 3600e3).toISOString(),
  viewer_kind: 'ssh-terminal', viewer_url: 'ssh://x', task_id: 't1',
  // the manager's DIRECTIVE — the programme it was given (task_text on the fleet row). Its FIRST
  // line is what distinguishes one manager from another at a glance.
  task_text: '# Direct the crew\nShip the release, one well-briefed worker at a time.',
  stack: [{ role: 'db', name: 'db_m', health: 'up' }, { role: 'server', name: 'srv_m', health: 'up' }],
};
const crew = [
  { id: 'w1', slug: 'a', manager_xell_id: 'M', zee_type: 'worker', hive_status: 'occ-working', zee_status: 'working', cli_active: true },
  { id: 'w2', slug: 'b', manager_xell_id: 'M', zee_type: 'worker', hive_status: 'occ-landRequest', zee_status: 'idle' },
  { id: 'w3', slug: 'c', manager_xell_id: 'M', zee_type: 'worker', hive_status: 'occ-idle', zee_status: 'idle' },
];
const worker = { ...crew[0], zee_type: 'worker', branch: 'spinoff/a', head_commit: 'feedface0000', stack: mgr.stack,
  viewer_kind: 'ssh-terminal', viewer_url: 'ssh://w', status: 'claimed', task_id: 't2' };

// ── 1. the type test ─────────────────────────────────────────────────────────
ok(isManagerXell(mgr) && !isManagerXell(worker) && !isManagerXell(null),
   'isManagerXell keys on zee_type, and tolerates a missing xell');

// ── 2. the card: crew and prod, never a sha or a diffstat ────────────────────
const card = managerCard(mgr, crew);
ok(card.label === '⬢ wise-cove', `named as a manager on the seam (${card.label})`);
ok(card.count === 3 && card.busy === 1 && card.waiting === 1,
   `counts its crew, who is working, and who is waiting on a human (${card.count}/${card.busy}/${card.waiting})`);
ok(/3 crew/.test(card.crew) && /1 working/.test(card.activity) && /1 waiting/.test(card.activity),
   `the seam counts the crew and the line below says what they are doing (${card.crew} / ${card.activity})`);
ok(managerCard({ ...mgr }, [{ id: 'z', hive_status: 'occ-idle' }]).activity === null,
   'an idle crew claims no activity at all (no "0 working")');
ok(/read-only/.test(card.prod || ''), `a db-prod-readonly manager says so (${card.prod})`);
ok(managerCard({ ...mgr, db_coupling: 'db-isolated' }, []).prod === null,
   'a manager with no prod bind claims none');
ok(/no crew yet/.test(managerCard(mgr, []).crew), 'an empty crew is stated, not left blank');
ok(!JSON.stringify(card).includes('deadbeef'), 'the card carries NO head commit — a manager lands nothing');

// the DIRECTIVE — what tells one manager apart from another. First line only, markdown '#' stripped.
ok(card.directive === 'Direct the crew', `the card carries the manager's directive, first line (${card.directive})`);
ok(managerCard({ ...mgr, task_text: '  \n' }, crew).directive === null, 'a blank brief yields no directive line');
ok(managerCard({ ...mgr, task_text: null }, crew).directive === null, 'a manager with no brief yields none');

// ── 3. the bloom: petals 5/6 are CREW and PROD·AGE, not the two git facets ───
const f = managerFacets(mgr, [], crew);
ok(f.length === 7, 'a manager still blooms into seven facets');
ok(f[5].title === 'crew' && f[5].kind === 'crew', `petal 5 is the CREW facet (${f[5].title})`);
ok(f[5].crew.length === 3 && f[5].crew.every((w) => w.color && w.slug),
   'the crew facet carries one status-coloured row per worker');
ok(f[5].crew[0].busy === true && f[5].crew[1].busy === false, 'and marks which of them is actively working');
ok(f[6].title === 'prod · age' && /read-only/.test(f[6].lines[0]) && /^age /.test(f[6].lines[1]),
   `petal 6 is PROD · AGE (${f[6].title}: ${f[6].lines.join(' / ')})`);
ok(!f.some((p) => p.kind === 'commitdiff' || p.kind === 'owndiff'),
   'NEITHER git facet survives on a manager (no commit head, no diffstat)');
ok(!JSON.stringify(f).includes('deadbeef'), 'no facet leaks the head sha');
ok(f[3].kind === 'stack' && f[4].title === 'machine' && f[2].title === 'session',
   'the facets a manager DOES own (session, containers, machine) are untouched');
ok(/dispatches workers/.test(f[1].lines[1] || ''), 'the branch facet says outright that it lands nothing');

// ── 4. the buttons: no pull/land/PR on a manager — ship stays ────────────────
const landable = { ahead: 2, behind: 0, files: 3, insertions: 9, deletions: 1, dirty: 0 };
const shippable = { ahead: 0, behind: 0, files: 0, insertions: 0, deletions: 0, dirty: 0 };
const kinds = (x, d) => Object.values(petalVerbs(x, d)).flat();

const wLand = kinds(worker, landable);
ok(wLand.includes('pull') && wLand.includes('land') && wLand.includes('pr'),
   `a WORKER keeps every git verb (${wLand.join(',')})`);
const mLand = kinds(mgr, landable);
ok(!['pull', 'land', 'pr'].some((k) => mLand.includes(k)),
   `a MANAGER is offered none of pull/land/PR — all three are refused server-side (${mLand.join(',')})`);
ok(['build', 'terminal', 'nudge', 'env', 'message', 'done'].every((k) => mLand.includes(k)),
   'but keeps every verb that DOES work on it: build, terminal, nudge, env, message, done');
ok(kinds(mgr, shippable).includes('ship'),
   'SHIP is not blocked for a manager — landed+clean still offers it');
ok(!kinds(mgr, landable).includes('ship'), 'and unlanded work still hides it, exactly as for a worker');
ok(kinds({ ...mgr, hive_status: 'occ-shipRequest' }, landable).includes('ship'),
   'a standing ship request surfaces the button before the diff has loaded');
const mv = petalVerbs(mgr, shippable);
ok(!mv[5] && (mv[6] || []).join() === 'ship',
   'the CREW petal carries no verb at all, and SHIP sits in the prod petal');
ok(Object.keys(petalVerbs({ ...mgr, is_production: true }, shippable)).length === 0,
   'production still gets no buttons');

// ── 5. what only the canvas can show ─────────────────────────────────────────
const body = (name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${SRC}`);
  let i = src.indexOf('{', src.indexOf(')', start));
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`could not bracket-match ${name}`);
};
const mgrHex = body('drawManagerHex');
ok(/isManagerXell\(hx\.x\)[\s\S]{0,200}drawManagerHex\(/.test(src),
   'the honeycomb routes a manager to drawManagerHex instead of the two-half work-cell card');
ok(!/\bdiff\b/.test(mgrHex) && !/\bsha\b/.test(mgrHex),
   'the manager hexagon draws neither a diffstat nor a commit head');
// One implementation, one level up since the provider became the badge: both a manager hexagon and
// a harness cell go through drawZeeAvatar (coin + strap + tool pip), which is what calls the disc.
ok(/drawZeeAvatar\(/.test(mgrHex) && /drawZeeAvatar\(/.test(body('drawHarnessBadge')),
   'it wears its persona through the SAME badge the harness cell draws (one implementation)');
ok(/setLineDash\(\[5, 3\]\)/.test(mgrHex), 'and sits on a DASHED seat — the harness badge’s "not a work-cell" tell');
ok(/hiveStatusLabel\(x\)/.test(mgrHex), 'it still carries the status pill every hexagon carries');
ok(/const diffPetal = \(x, cell\) => \(isManagerXell\(x\) \? null/.test(src),
   'a click on a manager’s petal 5/6 can never open the diff viewer');
ok(/if \(x && diffPetal\(x, f\.cell\)\) onAction\?\.\(DIFF_PETAL\[f\.cell\]/.test(src)
   && /diffPetal\(expanded, f\.cell\)/.test(src),
   'both the click and the cursor go through diffPetal, not the bare lookup');

// ── 6. PAINT IT: run the real renderer against a recording 2D context ────────
// A data test cannot catch a hexagon that throws halfway through, or one whose text runs off the
// bottom of the card. So the drawing code is actually EXECUTED here, at every size branch, against a
// stub 2D context that records what was painted — and the record is asserted.
function recorder() {
  const rec = { text: [], dash: [], arcs: [], ops: [], fills: [] };
  const noop = (name) => (...a) => { rec.ops.push(name); return a; };
  const self = {
    rec,
    canvas: { width: 800, height: 600 },
    save: noop('save'), restore: noop('restore'),
    beginPath: noop('beginPath'), closePath: noop('closePath'), moveTo: noop('moveTo'),
    lineTo: noop('lineTo'), rect: noop('rect'), roundRect: noop('roundRect'),
    strokeRect: noop('strokeRect'), ellipse: noop('ellipse'), bezierCurveTo: noop('bezierCurveTo'),
    // the harness COSTUME (a necktie, wings, a hammer — hive/harnessGear.js) is drawn as paths, in
    // the harness's own colour, so the fill colour is now part of what this record has to hold
    quadraticCurveTo: noop('quadraticCurveTo'),
    fill() { rec.ops.push('fill'); rec.fills.push(self.fillStyle); },
    stroke: noop('stroke'), clip: noop('clip'), clearRect: noop('clearRect'),
    setTransform: noop('setTransform'), translate: noop('translate'), scale: noop('scale'),
    drawImage: noop('drawImage'),
    arc(cx, cy, r) { rec.ops.push('arc'); rec.arcs.push({ cx, cy, r }); },
    setLineDash(d) { rec.ops.push('setLineDash'); if (d && d.length) rec.dash.push(d.join(',')); },
    createLinearGradient() { return { addColorStop() {} }; },
    measureText(t) {
      const px = Number((/(\d+(?:\.\d+)?)px/.exec(self.font || '') || [0, 12])[1]);
      return { width: String(t).length * px * 0.55 };
    },
    fillText(t, x, y) { rec.text.push({ t: String(t), x, y }); },
    strokeText(t) { rec.text.push({ t: String(t) }); },
  };
  return self;
}
const paint = (x, size, opts = {}) => {
  const ctx = recorder();
  drawManagerHex(ctx, { x, id: x.id, cx: 200, cy: 200, size, cell: size, color: '#5b8cff' },
    { hover: false, dim: false, crew, harness: { color: '#9b8cff', glyph: '🧭', label: 'Manager' }, ...opts });
  return ctx.rec;
};

const big = paint(mgr, 70);
const said = big.text.map((t) => t.t).join(' | ');
ok(big.text.some((t) => t.t === '⬢ wise-cove'), `the full card names the manager (${said})`);
ok(big.text.some((t) => /3 crew/.test(t.t)) && big.text.some((t) => /1 working · ⚑ 1 waiting/.test(t.t)),
   'and paints the crew count and the WHOLE activity line — it shrinks to fit, it does not clip');
ok(big.text.some((t) => /📜 Direct th/.test(t.t)), 'the seam leads with the directive — what this manager is FOR');
ok(big.text.some((t) => /⬡ 3 crew/.test(t.t)), 'the crew count survives beside it');
ok(!big.text.some((t) => /^manager ·/.test(t.t)), 'the redundant word "manager" is replaced by the directive');
ok(big.text.some((t) => t.t === 'working'), 'and the hive status pill');
ok(big.text.some((t) => /read-only/.test(t.t)), 'and its read-only hold on production');
// It used to paint the harness's GLYPH on the disc. It now paints the harness's COSTUME around the
// coin — a Manager wears a necktie — in the harness's own colour. Same fact, better drawing.
ok(big.fills.includes('#9b8cff'), 'and the costume of the harness it wears, in that harness colour');
ok(!big.text.some((t) => /^[0-9a-f]{7,}$/i.test(t.t)), 'and NOTHING that looks like a commit sha');
ok(!big.text.some((t) => /[+−]\d/.test(t.t)), 'and no diffstat');
ok(big.dash.includes('5,3'), 'the seat is stroked dashed — a persona cell, not a work-cell');
ok(big.text.every((t) => Math.abs(t.y - 200) <= 70), 'every line it paints stays inside the hexagon');
// 0.20, not the old 0.24: the disc gave up a sliver so the COSTUME it wears (which reaches
// GEAR_EXTENT × the coin — a necktie hangs below it) has room inside the seat without sitting on
// the identity line.
ok(big.arcs.some((a) => Math.abs(a.r - 70 * 0.20) < 0.01), 'the persona disc is drawn at the badge radius');

const mid = paint(mgr, 40);
ok(mid.text.some((t) => t.t === '⬢ wise-cove') && mid.text.some((t) => /×3/.test(t.t)),
   'a mid-size manager degrades to identity + crew count + status without crashing');
const tiny = paint(mgr, 20);
ok(tiny.text.length === 0 && tiny.arcs.length > 0, 'a tiny one is just the persona dot');
const bare = paint({ ...mgr, db_coupling: 'db-isolated' }, 70, { harness: null, crew: [] });
ok(bare.text.some((t) => t.t === '⬢') && !bare.text.some((t) => /prod/.test(t.t)),
   'a manager wearing no harness still gets a persona disc (the ⬢ fallback), and claims no prod');

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
