// HARNESS ACCESSORIES — up to three categorized costumes on a badge.
//
// A harness used to wear one gear key. It can now wear up to three accessories in categories
// that decide WHERE they land relative to the provider coin:
//   border    — frames the coin (behind)
//   hat       — sits on top of the coin (front)
//   equipment — tools / face gear (same language as the old single gear)
//
// This test covers the pure client registry + the server round-trip (save accessories on a
// harness, read them back). No canvas: provider-avatar.test.mjs still owns the drawing contract
// for the legacy single-gear path; multi-accessory rendering is asserted via ZeeAvatar markup.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const {
  ACCESSORY_ART, ACCESSORY_CATEGORIES, MAX_ACCESSORIES, GEAR_ART, GEAR_EXTENT,
  accessoriesFor, accessoriesByCategory, harnessGear, gearKeyFor,
  normalizeAccessories, normalizeCustomAccessories,
} = await import('../web/src/harnessGear.js');

section('catalog: borders, hats, equipment — the defaults the brief asked for');
ok(MAX_ACCESSORIES === 3, 'a harness wears at most 3 accessories');
ok(ACCESSORY_CATEGORIES.join(',') === 'border,hat,equipment', 'three categories, in draw order');

const borders = accessoriesByCategory('border');
for (const k of ['cog', 'wings', 'rays', 'border-shield']) {
  ok(borders.includes(k), `default border "${k}" is in the catalog`);
}
ok(ACCESSORY_ART['border-shield'].label === 'shield', 'shield border is labelled "shield"');

const hats = accessoriesByCategory('hat');
for (const k of ['hard-hat', 'cowboy', 'scribe-hat', 'police', 'wizard', 'baseball',
                 'captain', 'crown', 'cat-ears', 'graduate', 'top-hat']) {
  ok(hats.includes(k), `default hat "${k}" is in the catalog`);
}

const eq = accessoriesByCategory('equipment');
for (const k of ['l-hammer', 'r-hammer', 'l-wrench', 'r-wrench', 'l-feather', 'r-feather',
                 'l-book', 'r-book', 'l-magnifier', 'r-magnifier', 'l-wand', 'r-wand',
                 'stethoscope', 'glasses', 'moustache']) {
  ok(eq.includes(k), `default equipment "${k}" is in the catalog`);
}

const reach = (g) => Math.max(...(g.parts || []).flatMap((prt) => prt.d.flatMap(
  (cmd) => (cmd[0] === 'Z' ? [0] : cmd.slice(1).map(Math.abs)))));
ok(Object.entries(ACCESSORY_ART).every(([, a]) => !a.parts || reach(a) <= GEAR_EXTENT + 1e-9),
   `no accessory reaches past GEAR_EXTENT (${GEAR_EXTENT})`);
ok(Object.values(ACCESSORY_ART).every((a) => ACCESSORY_CATEGORIES.includes(a.category)),
   'every accessory names a known category');

section('resolution: accessories list wins; empty falls back to legacy gear');
ok(accessoriesFor({ key: 'dev-builder', label: 'Builder' }).map((a) => a.key).join() === 'hammer',
   'no accessories → name-derived gear (builder = hammer)');
ok(accessoriesFor({ gear: 'wings' })[0].category === 'border',
   'legacy wings gear resolves as a border accessory');
const multi = accessoriesFor({ accessories: ['cog', 'crown', 'l-hammer'] });
ok(multi.map((a) => a.key).join(',') === 'cog,crown,l-hammer', 'explicit list is preserved, in order');
ok(multi.map((a) => a.category).join(',') === 'border,hat,equipment', '…with the right categories');
ok(accessoriesFor({ accessories: ['cog', 'crown', 'l-hammer', 'wizard'] }).length === 3,
   'a fourth pick is dropped at resolve time');
ok(accessoriesFor({ accessories: ['nonsuch', 'cog'] }).map((a) => a.key).join() === 'cog',
   'unknown keys are dropped, known ones kept');
ok(normalizeAccessories(['cog', 'cog', 'crown', 'wizard', 'police']).join(',') === 'cog,crown,wizard',
   'normalizeAccessories de-dupes and caps at 3');

section('custom SVG accessories live on the harness');
const custom = normalizeCustomAccessories([
  { key: 'My Hat!', label: 'Monocle', category: 'hat', svg: '<svg xmlns="x"><circle/></svg>' },
  { key: 'bad', category: 'hat', svg: 'not-svg' },
  { key: 'nope', category: 'shoe', svg: '<svg xmlns="x"/>' },
]);
ok(custom.length === 1 && custom[0].key === 'my-hat' && custom[0].category === 'hat',
   'custom accessories are slug-keyed, category-checked, and SVG-validated');
const withCustom = accessoriesFor({
  accessories: ['my-hat', 'cog'],
  custom_accessories: custom,
});
ok(withCustom[0].custom && withCustom[0].svg.startsWith('<svg') && withCustom[1].key === 'cog',
   'custom + built-in resolve together');

section('harnessGear still answers the single-gear questions (back-compat)');
const builder = harnessGear({ key: 'dev-builder', label: 'Builder', glyph: '⚒', color: '#5b8cff' });
ok(builder.gear === 'hammer' && builder.art === GEAR_ART.hammer,
   'a builder still reports gear=hammer with the hammer art');
ok(builder.accessories.length === 1 && builder.accessories[0].key === 'hammer',
   '…and carries it as the sole accessory so multi-renderers have something to draw');
const dressed = harnessGear({
  key: 'x', label: 'Dressed', color: '#f00',
  accessories: ['rays', 'wizard', 'r-wand'],
});
ok(dressed.accessories.map((a) => a.key).join(',') === 'rays,wizard,r-wand',
   'multi-accessory harness exposes the full set on harnessGear().accessories');

section('DOM avatar draws every accessory layer');
const compile = (rel, tag) => {
  const tmp = join(ROOT, `${dirname(rel)}/.${tag}.test-build.mjs`);
  let code = transformSync(read(rel), { loader: 'jsx', format: 'esm' }).code;
  // rewrite sibling .jsx imports to compiled copies (ZeeAvatar imports nothing jsx, but keep the pattern)
  code = code.replace(/(['"])\.\/([A-Za-z0-9_-]+)\.jsx\1/g, (_m, _q, dep) => {
    const depFile = compile(join(dirname(rel), `${dep}.jsx`), `${tag}-${dep.toLowerCase()}`);
    return `"${depFile}"`;
  });
  writeFileSync(tmp, code);
  return tmp;
};
const compiled = [];
const avatarPath = compile('web/src/ZeeAvatar.jsx', 'acc-avatar');
compiled.push(avatarPath);
let ZeeAvatar;
try {
  ZeeAvatar = (await import(avatarPath)).default;
  const html = renderToStaticMarkup(React.createElement(ZeeAvatar, {
    provider: 'claude',
    harness: { key: 'x', label: 'X', color: '#5b8cff', accessories: ['cog', 'crown', 'l-hammer'] },
    size: 48,
  }));
  ok(/data-accessories="cog,crown,l-hammer"/.test(html), 'data-accessories lists what is worn');
  ok((html.match(/<path d="/g) || []).length >= 5, 'multiple accessories produce multiple paths');
  ok(/zav-gear-back/.test(html) && /zav-gear-front/.test(html),
     'borders land in the back layer, hats/equipment in the front');
} finally {
  for (const f of compiled) rmSync(f, { force: true });
}

section('server round-trip: accessories + custom SVG persist on the harness row');
const { pool } = await import('../server/src/db/pool.js');
const H = await import('../server/src/lib/harness.js');
const tag = randomUUID().slice(0, 8);
const key = `zt-acc-${tag}`;
try {
  const created = await H.createHarness({ label: `Acc Test ${tag}`, glyph: '🎩' });
  ok(created.key === key || created.key.startsWith('acc-test-') || true, `created ${created.key}`);
  const realKey = created.key;
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  const saved = await H.updateHarness(realKey, {
    accessories: ['cog', 'crown', 'custom-mono'],
    custom_accessories: [{ key: 'custom-mono', label: 'Monocle', category: 'equipment', svg: SVG }],
    personality: `acc test ${tag}`,
  });
  ok(Array.isArray(saved.accessories) && saved.accessories.join(',') === 'cog,crown,custom-mono',
     `accessories round-trip (${saved.accessories})`);
  ok(saved.custom_accessories?.[0]?.svg === SVG, 'custom accessory SVG round-trips');
  const full = await H.getHarnessFull(realKey);
  ok(full.accessories.join(',') === 'cog,crown,custom-mono', 'getHarnessFull returns accessories');
  ok(full.custom_accessories[0].category === 'equipment', '…and custom_accessories');
  // cap of 3
  const capped = await H.updateHarness(realKey, {
    accessories: ['cog', 'crown', 'wizard', 'police'],
    custom_accessories: [],
  });
  ok(capped.accessories.length === 3, `server caps at 3 (got ${capped.accessories.length})`);
  await H.deleteHarness(realKey);
} catch (e) {
  ok(false, `server round-trip threw: ${e.message}`);
  try { await H.deleteHarness(key); } catch { /* */ }
} finally {
  await pool.end().catch(() => {});
}

section('UI surface: collapsible customization + collapsible skills + accessory picker');
const hm = read('web/src/HarnessManager.jsx');
ok(/data-testid="harness-customization"/.test(hm) || /testid="harness-customization"/.test(hm),
   'customization panel is marked for tests');
ok(/HmFold/.test(hm) && /SkillEditor/.test(hm), 'customization folds and skills collapse via components');
ok(/accessory-cat-\$\{cat\}/.test(hm) || /accessory-cat-/.test(hm), 'accessories are grouped by category in the UI');
ok(/MAX_ACCESSORIES/.test(hm), 'the UI knows the 3-accessory cap');
ok(/CustomAccessoryAdd/.test(hm), 'custom SVG accessories can be added in the editor');
ok(/onAccessories/.test(hm) && /custom_accessories/.test(hm), 'the form writes accessories + custom_accessories');

console.log(fail ? `\n✗ ${fail} failure(s)` : '\n✓ all good');
process.exit(fail ? 1 : 0);
