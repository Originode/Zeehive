// THE AI PROVIDER IS THE BADGE; THE HARNESS IS WORN.
//
// A zee is two facts at once — WHOSE model is thinking, and WHAT job it was dressed for — and until
// this change only the second one had a picture. Every hexagon, manager disc and card drew the
// harness avatar, so a Claude builder and a Codex builder were the same drawing, and "which vendor
// is burning here?" was a word in a tooltip. The two swapped places: the provider is the coin, and
// the harness is equipment over it (a strap + a tool pip carrying the harness's glyph).
//
// Three things can break that and none of them shows up as an exception:
//   1. A NEW VENDOR WITH NO COIN. The runtime adapters (lib/cxell-runtimes.js) and the provider
//      registry (lib/provider-tokens.js) are where a vendor is added; a provider the art registry
//      has never heard of degrades silently to "no badge at all". So every dispatchable provider
//      and every cxell adapter is checked against web/src/providerArt.js — and its logo file is
//      checked to EXIST, because a 404 image draws nothing and throws nothing.
//   2. THE TWO DRAWINGS DRIFTING. The badge is drawn twice — canvas (drawZeeAvatar) and DOM
//      (<ZeeAvatar>) — so both are executed here, the canvas against a recording 2D context and the
//      DOM through react-dom/server, and both are asserted to carry the same three parts.
//   3. THE READ MODEL NOT CARRYING IT. The console can only resolve a vendor if the fleet row says
//      one (r.vendor) and can only draw the pip if the harness's glyph rides along.
// No database: everything here is a pure module, a source read, or a render.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const compile = (rel, tag) => {
  const tmp = join(ROOT, `${dirname(rel)}/.${tag}.test-build.mjs`);
  writeFileSync(tmp, transformSync(read(rel), { loader: 'jsx', format: 'esm' }).code);
  return tmp;
};

const ART = await import('../web/src/providerArt.js');
const { PROVIDER_ART, providerKeyOf, providerArtOf, harnessGear, avatarTitle,
        GEAR_ART, GEAR_EXTENT, GEAR_KEYS, gearKeyFor, toneColor, gearPathD } = ART;

// ── 1. every vendor the fleet can dispatch has a coin, and the coin has a file ──────────────
section('the registry: a provider a zee can run on is a provider that can be drawn');
const providerSrc = read('server/src/lib/provider-tokens.js');
// the PROVIDERS registry, entry by entry: key + whether a zee can be dispatched on it today
const dispatchable = [...providerSrc.matchAll(/key:\s*'([a-z0-9-]+)',\s*\n\s*label:[^\n]*\n\s*dispatch:\s*true/g)]
  .map((m) => m[1]);
ok(dispatchable.length >= 4, `read the dispatchable providers off the server registry (${dispatchable.join(', ')})`);
for (const p of dispatchable) ok(!!PROVIDER_ART[p], `provider "${p}" has art in web/src/providerArt.js`);
ok(!dispatchable.includes('github'), 'github is not an AI provider and is not expected to have one');

const RT = await import('../server/src/lib/cxell-runtimes.js');
const runtimeKeys = [...read('server/src/lib/cxell-runtimes.js').matchAll(/key:\s*'([a-z0-9-]+-cxell)'/g)]
  .map((m) => m[1]);
ok(runtimeKeys.length >= 4, `read the cxell runtime adapters (${runtimeKeys.join(', ')})`);
for (const k of runtimeKeys) {
  const adapter = RT.adapterFor(k);
  ok(providerKeyOf(k) === adapter.provider,
     `runtime "${k}" resolves to its adapter's own provider (${adapter.provider}) straight off the runtime key`);
  ok(!!providerArtOf({ runtime_key: k }), `…and a xell row carrying that runtime_key gets a coin`);
}

section('every coin names a logo that is really there');
for (const [key, art] of Object.entries(PROVIDER_ART)) {
  ok(art.logo.startsWith('/providers/'), `${key}: logo is served from the console's own origin (${art.logo})`);
  const file = join(ROOT, 'web/public', art.logo.replace(/^\//, ''));
  ok(existsSync(file), `${key}: ${art.logo} exists in web/public (vite copies public/ verbatim into dist)`);
  const head = existsSync(file) ? readFileSync(file).subarray(0, 8) : Buffer.alloc(0);
  ok(head.length === 8 && head[0] === 0x89 && head.toString('ascii', 1, 4) === 'PNG', `${key}: it is a real PNG`);
  ok(/^#[0-9a-f]{6}$/i.test(art.color) && /^#[0-9a-f]{6}$/i.test(art.coin),
     `${key}: carries a brand colour and the coin it reads on`);
}

// ── 2. resolution: three vocabularies, one coin ─────────────────────────────────────────────
section('one coin, whatever the caller happens to call the vendor');
ok(providerKeyOf('claude') === 'claude' && providerKeyOf('anthropic') === 'claude',
   'the provider key and the runtime VENDOR both mean claude');
ok(providerKeyOf({ runtime_vendor: 'moonshot' }) === 'kimi', "agent_runtime.vendor 'moonshot' is Kimi");
ok(providerKeyOf({ runtime_key: 'codex-cxell' }) === 'openai', "runtime 'codex-cxell' is the OpenAI coin");
ok(providerKeyOf({ runtime_key: 'claude-code-local' }) === 'claude'
   && providerKeyOf({ runtime_key: 'claude-code-remote' }) === 'claude',
   'the two NON-cxell claude runtimes resolve too — a badge is not only for caged zees');
ok(providerKeyOf({ provider: 'openai' }) === 'openai', 'a provider-token row resolves by its provider column');
ok(providerKeyOf({}) === null && providerKeyOf(null) === null && providerKeyOf('nonesuch') === null,
   'and something with no vendor in it resolves to NOTHING rather than a wrong coin');
ok(providerArtOf({ runtime_key: 'kimi-code-cxell' }).logo === PROVIDER_ART.kimi.logo,
   'providerArtOf hands back the registry entry itself (one source for canvas and DOM)');

section('the gear: a COSTUME per role, not a glyph in a pip');
const builder = harnessGear({ key: 'dev-builder', label: 'Builder', glyph: '⚒', color: '#5b8cff' });
ok(builder.gear === 'hammer' && builder.art === GEAR_ART.hammer,
   'a builder wears a HAMMER, resolved from its own name');
const byName = (k, l) => harnessGear({ key: k, label: l }).gear;
ok(byName('dev-scout', 'Scout') === 'wings', 'a scout wears wings');
ok(byName('manager', 'Manager') === 'necktie' && byName('dev-lead', 'Dev Lead') === 'necktie',
   'a manager (and a crew lead) wears a necktie');
ok(byName('dev-reviewer', 'Reviewer') === 'glasses', 'a reviewer wears glasses');
ok(byName('worker-bee', 'Worker') === 'shovel', 'a plain worker carries a shovel');
ok(byName('dev-shipwright', 'Shipwright') === 'anchor' && byName('dev-tester', 'Tester') === 'flask'
   && byName('dev-fixer', 'Fixer') === 'wrench' && byName('dev-scribe', 'Scribe') === 'quill'
   && byName('dev-architect', 'Architect') === 'setsquare',
   'the rest of the dev crew each get their own tool (anchor · flask · wrench · quill · set square)');
ok(byName('queenzee-minister', 'Minister') === 'gavel',
   'the minister gets a gavel, not the manager necktie — the specific rule wins over the general one');
ok(byName('zee-base', 'Zee Base') === 'ribbon',
   'a harness whose name says no job falls back to the RIBBON — a nameplate, not another identical pip');
ok(harnessGear({ key: 'dev-builder', label: 'Builder', gear: 'wings' }).gear === 'wings',
   'and an explicit bundle.gear OVERRIDES the derivation (the picker in the harness editor)');
ok(harnessGear({ key: 'x', label: 'X', gear: 'nonsuch' }).gear === 'ribbon',
   'a gear key nothing matches degrades to the ribbon rather than drawing nothing');

ok(Object.values(GEAR_ART).every((g) => g.parts.length && g.parts.every((prt) => prt.d?.length
   && (prt.fill || prt.stroke))), 'every costume in the set has parts, and every part is painted somehow');
const reach = (g) => Math.max(...g.parts.flatMap((prt) => prt.d.flatMap(
  (cmd) => (cmd[0] === 'Z' ? [0] : cmd.slice(1).map(Math.abs)))));
ok(Object.entries(GEAR_ART).every(([, g]) => reach(g) <= GEAR_EXTENT + 1e-9),
   `no costume reaches past GEAR_EXTENT (${GEAR_EXTENT}) — that bound is what every surface sizes its box by`);
// EVERY costume reaches onto the coin. This is the difference between a costume and an ornament:
// art that begins a full radius out reads as two objects near each other, and that is exactly what
// the first cut of these looked like.
const innerOf = (g) => Math.min(...g.parts.flatMap((prt) => {
  const out = [];
  for (const cmd of prt.d) {
    if (cmd[0] === 'Z') continue;
    for (let i = 1; i < cmd.length; i += 2) out.push(Math.hypot(cmd[i], cmd[i + 1]));
  }
  return out.length ? out : [99];
}));
const notWorn = Object.entries(GEAR_ART).filter(([, g]) => innerOf(g) > 1);
ok(!notWorn.length,
   `every costume reaches ONTO the coin (inner anchor within the logo)${notWorn.length ? ` — ${notWorn.map(([k]) => k).join(', ')} do not` : ''}`);
ok(GEAR_ART.wings.parts.some((prt) => prt.behind) && !GEAR_ART.necktie.parts.some((prt) => prt.behind),
   'wings tuck BEHIND the coin; a necktie hangs in front of it');
ok(GEAR_ART.glasses.parts.every((prt) => !prt.behind),
   '…and glasses sit ON the face, which is the whole point of them');

ok(builder.mark === '⚒' && builder.glyph === '⚒', "the harness's authored glyph is kept as its mark");
ok(harnessGear({ label: 'Scribe' }).mark === 'S' && harnessGear({ label: 'Scribe' }).glyph === null,
   'a harness that authored no glyph still gets a mark (its initial) for the ribbon to carry');
ok(harnessGear({ key: 'k', label: 'X', bundle_empty: true }).empty,
   'an EMPTY harness is flagged so every surface can paint the fault');
ok(harnessGear(null) === null, 'no harness → no gear (the coin is drawn alone)');
ok(harnessGear({ harness_key: 'dev-scout', harness_label: 'Scout', harness_glyph: '⌕' }).gear === 'wings',
   'a FLEET row (harness_key/harness_label/harness_gear) resolves exactly like a timeline harness');
ok(toneColor('#5b8cff', 'dark') !== '#5b8cff' && toneColor('#5b8cff', 'main') === '#5b8cff',
   'the costume is tones of the harness colour — one hue, depth from shading');
ok(avatarTitle(PROVIDER_ART.claude, builder) === 'Claude · wearing Builder',
   'the tooltip says who is thinking and what it is dressed as');

// ── 3. the CANVAS drawing, executed ─────────────────────────────────────────────────────────
section('drawZeeAvatar: a coin, a strap and a tool pip — painted, not described');
const hivePath = compile('web/src/hive/HiveCanvas.jsx', 'provider-avatar');
let hive;
try { hive = await import(hivePath); } finally { rmSync(hivePath, { force: true }); }
const { drawZeeAvatar, drawCompactHex, zeeBadge } = hive;

// A recording 2D context. It keeps arcs (the coin) AND polyline-flattened PATHS (the costume), plus
// the ORDER the two were painted in — "wings behind the coin" is a fact about order, and a test that
// cannot see order cannot tell a costume from a sticker.
function recorder() {
  const rec = { ops: [], arcs: [], strokes: [], fills: [], text: [], images: [], paths: [], order: [] };
  const st = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', globalAlpha: 1 };
  let cur = null;
  let pts = [];
  const endPath = (color) => { if (pts.length > 1) { rec.paths.push({ pts: pts.slice(), color }); rec.order.push('path'); } };
  const noop = (n) => (...a) => { rec.ops.push(n); return a; };
  const ctx = {
    rec, canvas: { width: 400, height: 400 },
    save: noop('save'), restore: noop('restore'),
    beginPath() { rec.ops.push('beginPath'); cur = null; pts = []; },
    closePath: noop('closePath'),
    moveTo(x, y) { rec.ops.push('moveTo'); pts.push([x, y]); },
    lineTo(x, y) { rec.ops.push('lineTo'); pts.push([x, y]); },
    quadraticCurveTo(_cx, _cy, x, y) { rec.ops.push('quadraticCurveTo'); pts.push([_cx, _cy], [x, y]); },
    rect: noop('rect'),
    roundRect: noop('roundRect'), ellipse: noop('ellipse'), bezierCurveTo: noop('bezierCurveTo'),
    clip: noop('clip'), clearRect: noop('clearRect'), setTransform: noop('setTransform'),
    translate: noop('translate'), scale: noop('scale'), setLineDash: noop('setLineDash'),
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (t) => ({ width: String(t).length * 6 }),
    arc(cx, cy, r, a0 = 0, a1 = Math.PI * 2) { rec.ops.push('arc'); cur = { cx, cy, r, a0, a1 }; rec.arcs.push(cur); },
    fill() {
      rec.ops.push('fill');
      if (cur) { rec.fills.push({ ...cur, color: st.fillStyle }); rec.order.push('coin'); }
      endPath(st.fillStyle);
    },
    stroke() {
      rec.ops.push('stroke');
      if (cur) rec.strokes.push({ ...cur, color: st.strokeStyle, lw: st.lineWidth });
      endPath(st.strokeStyle);
    },
    drawImage(img, x, y, w, h) { rec.ops.push('drawImage'); rec.images.push({ img, x, y, w, h }); },
    fillText(t, x, y) { rec.ops.push('fillText'); rec.text.push({ t: String(t), x, y, color: st.fillStyle }); },
  };
  for (const k of ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'globalAlpha', 'textAlign', 'textBaseline', 'lineCap'])
    Object.defineProperty(ctx, k, { get: () => st[k], set: (v) => { st[k] = v; } });
  return ctx;
}
const logo = { complete: true, naturalWidth: 128, src: '/providers/claude.png' };

// the recorder above logs arcs; a costume is PATHS, so it logs those too (see moveTo/lineTo/quad)
let c = recorder();
drawZeeAvatar(c, 100, 100, 20, { provider: PROVIDER_ART.claude, providerImg: logo, gear: builder });
ok(c.rec.images.length === 1 && c.rec.images[0].img === logo, 'the PROVIDER logo is what lands in the coin');
const img = c.rec.images[0];
ok(img.w === img.h && img.w < 40 && img.w > 24,
   `the logo is inset inside the round clip so a mark that fills its box is not corner-shaved (${img.w.toFixed(1)}px in a 40px coin)`);
ok(c.rec.fills.some((f) => f.color === PROVIDER_ART.claude.coin && f.r === 20), 'the coin is filled in the brand colour it reads on');
// the hammer: painted in the harness's colour, hung OUTSIDE the coin at 4 o'clock
const hammerInk = c.rec.paths.filter((p) => p.color === builder.color || p.color === toneColor(builder.color, 'dark'));
ok(hammerInk.length >= 2, 'the harness is drawn as PATHS in its own colour — a costume, not a lettermark');
const pts = hammerInk.flatMap((p) => p.pts);
ok(pts.some(([x, y]) => x > 100 && y > 100 && Math.hypot(x - 100, y - 100) > 20),
   'the hammer clears the coin at 4 o\'clock');
ok(pts.some(([x, y]) => Math.hypot(x - 100, y - 100) < 20),
   '…and its shaft STARTS on the logo — a costume is worn, not parked beside the thing wearing it');
ok(!pts.some(([x, y]) => Math.hypot(x - 100, y - 100) > 20 * GEAR_EXTENT + 0.01),
   `and nothing it paints escapes the ${GEAR_EXTENT}× box every surface reserves for it`);

// the SAME job on another vendor is the SAME costume, to the pixel
const openaiBuilder = recorder();
drawZeeAvatar(openaiBuilder, 100, 100, 20, { provider: PROVIDER_ART.openai, providerImg: logo, gear: builder });
const geom = (rec) => JSON.stringify(rec.paths.map((p) => p.pts.map((q) => q.map((n) => n.toFixed(2)))));
ok(geom(openaiBuilder.rec) === geom(c.rec),
   'the same harness on another vendor paints the IDENTICAL costume — only the coin under it changes');

// a different job is a different silhouette (the failure this whole change exists to fix)
const scout = recorder();
drawZeeAvatar(scout, 100, 100, 20, { provider: PROVIDER_ART.claude, providerImg: logo,
                                     gear: harnessGear({ key: 'dev-scout', label: 'Scout', color: '#3bc6c0' }) });
ok(geom(scout.rec) !== geom(c.rec), 'a scout and a builder are not the same drawing any more');
const wing = scout.rec.paths.filter((p) => p.color === '#3bc6c0').flatMap((p) => p.pts);
ok(wing.some(([x]) => x < 80) && wing.some(([x]) => x > 120),
   'wings reach out BOTH sides of the coin — the costume frames the badge, it does not sit in a corner of it');
ok(scout.rec.order.indexOf('path') < scout.rec.order.indexOf('coin'),
   '…and they are painted BEFORE the coin, so they tuck behind it instead of over the logo');

c = recorder();
drawZeeAvatar(c, 100, 100, 20, { provider: PROVIDER_ART.claude, providerImg: logo,
                                 gear: harnessGear({ key: 'e', label: 'Hollow', bundle_empty: true }) });
ok(c.rec.paths.some((p) => p.color === '#e5554e' || p.color === toneColor('#e5554e', 'dark')),
   'an EMPTY harness wears its costume in RED — the fault is visible wherever the harness is drawn');

c = recorder();
drawZeeAvatar(c, 100, 100, 20, { gear: builder, harnessImg: logo });
ok(c.rec.images.length === 1 && c.rec.paths.some((p) => p.color === builder.color),
   'with NO provider resolved the harness is the face, still wearing its own costume');
ok(!c.rec.text.some((t) => t.t === '⚒'),
   '…and its glyph is not painted on top: the costume is the mark (only the ribbon writes a glyph)');

c = recorder();
drawZeeAvatar(c, 100, 100, 20, { provider: PROVIDER_ART.kimi, providerImg: logo });
ok(!c.rec.paths.length, 'a zee wearing NO harness gets the bare coin — no empty frame standing for nothing');

c = recorder();
drawZeeAvatar(c, 100, 100, 20, { provider: PROVIDER_ART.gemini, providerImg: logo,
                                 gear: harnessGear({ key: 'zee-base', label: 'Zee Base', glyph: '🐝', color: '#8b97a8' }) });
ok(c.rec.text.some((t) => t.t === '🐝'),
   'the RIBBON is the one costume that writes the glyph — it is a nameplate, and that is what is on it');

section('the hexagon asks for it');
const row = { id: 'x1', slug: 'nimble-atlas', status: 'working', hive_status: 'occ-working',
              runtime_key: 'codex-cxell', head_commit: 'feedface00', stack: [], created_at: new Date().toISOString() };
ok(zeeBadge(row, null).provider.key === 'openai', 'zeeBadge resolves the coin from the xell row itself');
ok(zeeBadge({ id: 'n' }, null) === null, 'a row with neither provider nor harness earns no badge');
c = recorder();
drawCompactHex(c, { x: row, id: row.id, cx: 200, cy: 200, size: 90, cell: 90, color: '#e0a53b' },
  { hover: false, dim: false, diff: null, machines: [], harness: { key: 'dev-builder', label: 'Builder', glyph: '⚒', color: '#5b8cff' },
    providerImg: logo });
ok(c.rec.images.some((i) => i.img === logo), 'a worker hexagon draws the provider coin at its 10 o\'clock badge');
ok(c.rec.paths.some((pth) => pth.color === '#5b8cff' || pth.color === toneColor('#5b8cff', 'dark')),
   '…wearing the harness costume, in the harness colour');
const badgeImg = c.rec.images.find((i) => i.img === logo);
ok(badgeImg && Math.hypot(badgeImg.x + badgeImg.w / 2 - 200, badgeImg.y + badgeImg.h / 2 - 200) < 90,
   'and it stays inside the hexagon it belongs to');
ok(/providerImg:\s*getImg\(providerArtOf/.test(read('web/src/hive/HiveCanvas.jsx')),
   'the canvas preloads the logo through the SAME image cache as the harness art (one load, one redraw)');

// ── 4. the DOM twin ─────────────────────────────────────────────────────────────────────────
section('<ZeeAvatar>: the same three parts, in HTML');
const avatarPath = compile('web/src/ZeeAvatar.jsx', 'zee-avatar');
let ZeeAvatar;
try { ZeeAvatar = (await import(avatarPath)).default; } finally { rmSync(avatarPath, { force: true }); }
const html = renderToStaticMarkup(React.createElement(ZeeAvatar, {
  xell: { runtime_key: 'claude-code-cxell', harness_key: 'dev-builder', harness_label: 'Builder', harness_glyph: '⚒' },
  size: 26,
}));
ok(html.includes(PROVIDER_ART.claude.logo), 'the coin is the provider logo');
const grokHtml = renderToStaticMarkup(React.createElement(ZeeAvatar, { provider: 'grok', size: 26 }));
ok(grokHtml.includes(PROVIDER_ART.grok.logo)
   && grokHtml.includes(`background:${PROVIDER_ART.grok.coin}`)
   && grokHtml.includes('alt="Grok Build"'),
   'grok renders its own operator-supplied coin — logo, brand colour and label');
ok(/data-gear="hammer"/.test(html) && /<path d="M/.test(html),
   'the harness is drawn as its COSTUME — real paths, resolved to the hammer a builder wears');
ok(/zav-gear-back/.test(html) || /zav-gear-front/.test(html),
   '…in the same behind/in-front layers the canvas paints');
ok(/data-provider="claude"/.test(html) && /data-harness="dev-builder"/.test(html),
   'both facts are on the element, so a card can be read by a test as well as by an eye');
ok(/title="Claude · wearing Builder"/.test(html), 'and the tooltip spells the two out');
ok(html.includes('--zav-size:26px'), 'every part is sized off one custom property');
const worn = renderToStaticMarkup(React.createElement(ZeeAvatar, {
  harness: { key: 'dev-scout', label: 'Scout', glyph: '⌕', color: '#3bc6c0' }, size: 24,
}));
ok(!worn.includes('⌕'),
   'with NO provider the harness is the face — and its glyph is NOT painted: the costume is the mark');
ok(worn.includes('>S<') && /data-gear="wings"/.test(worn), '…the face is its initial, still in its wings');
const plate = renderToStaticMarkup(React.createElement(ZeeAvatar, {
  provider: 'claude', harness: { key: 'zee-base', label: 'Zee Base', glyph: '🐝', color: '#8b97a8' }, size: 24,
}));
ok(/data-gear="ribbon"/.test(plate) && plate.includes('🐝'),
   'the RIBBON is the one costume that writes the glyph, in both renderers — it is a nameplate');
const bare = renderToStaticMarkup(React.createElement(ZeeAvatar, { xell: { runtime_key: 'codex-cxell' } }));
ok(bare.includes(PROVIDER_ART.openai.logo) && !bare.includes('zav-gear'),
   'no harness → the coin alone, with no empty frame standing for nothing');
ok(renderToStaticMarkup(React.createElement(ZeeAvatar, { xell: { slug: 'ready-cell' } })) === '',
   'and nothing to draw renders NOTHING — an empty ring would read as "some zee"');

section('the console actually wears it');
const app = read('web/src/App.jsx');
ok(/<ZeeAvatar xell=\{x\} size=\{\d+\} \/>/.test(app), 'the xell card leads with the badge');
// The prompt buttons are PER PERSONA now (docs/harness-proposal.md §3.2d), so the vendor coin moved
// to where the vendor is actually chosen — the composer's provider and account pickers — and the
// button itself WEARS the persona it dispatches. Same rule, same registry, one step later.
ok(/<ZeeAvatar harness=\{\{ key: b\.key/.test(app), 'a prompt button wears the persona it dispatches');
const dispSrc = read('web/src/Dispatch.jsx');
ok(/<ZeeAvatar provider=\{p\.provider\} size=\{18\} \/>/.test(dispSrc),
   'and the composer carries the coin on the provider it will run on');
ok(/<ZeeAvatar provider=\{active\?\.provider\} size=\{18\} \/>/.test(dispSrc),
   '…and on each account of that provider');
ok(/WornPreview/.test(read('web/src/HarnessManager.jsx')),
   'the harness editor shows how its gear will be WORN — on more than one vendor');
const fleet = read('server/src/lib/fleet.js');
ok(/r\.vendor AS runtime_vendor/.test(fleet), 'the fleet read model carries the runtime VENDOR (house rule 7: names are data)');
ok(/bundle->>'glyph' AS harness_glyph/.test(fleet), "…and the harness's glyph (the ribbon's nameplate)");
ok(/bundle->>'gear' AS harness_gear/.test(fleet), '…and which COSTUME it wears, when it names one');
ok(/bundle->>'gear' AS gear/.test(read('server/src/lib/timeline.js')),
   'the honeycomb gets it too — the hexagons and the cards dress the same harness the same way');
ok(/if \('gear' in patch\)/.test(read('server/src/lib/harness.js')),
   'and a human can CHOOSE it: the harness row takes an explicit gear (empty = derive from the name)');
ok(/data-testid={`gear-\$\{k\}`}/.test(read('web/src/HarnessManager.jsx')),
   '…from a picker in the harness editor, beside the live preview of it worn');

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ all good');
process.exit(fail ? 1 : 0);
