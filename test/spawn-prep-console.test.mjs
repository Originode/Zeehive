// THE CONSOLE IS WHERE THE SPAWN TEMPLATE IS EDITED — so the editor has to emit something the
// queenzee will accept, and show the state a human is deciding from.
//
// The risk this covers is specific and has bitten before elsewhere in this repo: a console that
// builds its own idea of the shape (a second copy of "what a step is") and drifts from the server's
// normalizer. So this renders the REAL component (esbuild + react-dom/server, the trick
// harness-authoring-ui uses) and then feeds everything it emits THROUGH the real
// normalizeSpawnPrep — if the editor could ever produce a template the API would refuse, that is a
// failure here rather than a 400 in front of a human.
//
// What it cannot cover: the browser (a click, a blur). Those handlers are asserted at source level,
// named, so a rename shows up here instead of silently doing nothing.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const P = await import('../server/src/lib/spawn-prep.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ProjectSetup.jsx imports the rest of the console (Dialog, api, …), so it is BUNDLED rather than
// transformed — the same trick app-dialog-jsx.test.mjs uses for Dialog.jsx.
const tmp = mkdtempSync(join(tmpdir(), 'prepeditor-'));
const bundle = async () => {
  const out = join(tmp, 'prep.cjs');
  await esbuild.build({
    stdin: {
      contents: `
        const React = require('react');
        const { renderToStaticMarkup } = require('react-dom/server');
        const { PrepEditor } = require('./ProjectSetup.jsx');
        module.exports = { React, renderToStaticMarkup, PrepEditor };`,
      resolveDir: join(ROOT, 'web/src'), loader: 'js',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
  });
  return createRequire(out)(out);
};

try {
  const { React, renderToStaticMarkup, PrepEditor } = await bundle();
  const PS = { PrepEditor };
  // Exactly what the API serves (lib/projects.js getPoolConfig): the EFFECTIVE template, whether it
  // has been customized, and the server-defined presets.
  const pcDefault = {
    spawn_prep: P.normalizeSpawnPrep(null),
    spawn_prep_custom: false,
    spawn_prep_presets: P.STEP_PRESETS,
  };
  const withPsql = {
    spawn_prep: P.normalizeSpawnPrep({
      steps: [...P.DEFAULT_STEPS, { key: 'psql', kind: 'apt', packages: ['postgresql-client'], label: 'psql' }],
      cache: { npm: 'container', npm_prefer_offline: false },
      when: 'provision',
    }),
    spawn_prep_custom: true,
    spawn_prep_presets: P.STEP_PRESETS,
  };
  const render = (pc, save = () => {}) => renderToStaticMarkup(React.createElement(PS.PrepEditor, { pc, save }));

  console.log('\n── the default template is SHOWN, and says it is the default ──');
  const html = render(pcDefault);
  ok(/Dependencies/.test(html), 'the section is there');
  ok(/currently the built-in default/.test(html), 'an unedited project says so, instead of looking like a choice somebody made');
  ok(/data-testid="prep-step-npm-deps"/.test(html) && /data-testid="prep-step-web-build"/.test(html),
     'both default steps are listed, by key');
  ok(/prep-toggle-npm-deps/.test(html), 'each one can be switched off without being deleted');
  ok(/prep-remove-web-build/.test(html), '…or removed outright');
  ok(!/prep-reset/.test(html), 'and there is no "reset to default" on a project that IS the default');

  console.log('\n── every knob in the model has a control ──');
  for (const [id, what] of [['prep-npm-cache', 'the npm cache mode (the big one: shared or cold)'],
                            ['prep-apt-cache', 'the apt archive cache'],
                            ['prep-prefer-offline', 'npm --prefer-offline'],
                            ['prep-omit-dev', 'npm --omit=dev']]) {
    ok(new RegExp(`data-testid="${id}"`).test(html), what);
  }
  ok(/data-testid="prep-add"/.test(html), 'and a menu to ADD a step');
  // WHEN the prep runs is the knob that decides whether provisioning or the waiting human pays for
  // it, so it is the first thing in the section and it must offer all three rungs.
  ok(/data-testid="prep-when"/.test(html), 'the "prep runs" control (dispatch / image / provision)');
  ok(P.PREP_WHEN.every((w) => new RegExp(`value="${w}"`).test(html)), 'with every rung of the ladder offered');
  const src = read('web/src/ProjectSetup.jsx');
  const comp = src.slice(src.indexOf('export function PrepEditor'));
  for (const key of Object.keys(P.DEFAULT_CACHE)) {
    ok(new RegExp(`cache, ${key}:|cache\\.${key}`).test(comp), `cache.${key} is wired to a control (no knob is display-only)`);
  }

  console.log('\n── a customized project shows what it was customized TO ──');
  const custom = render(withPsql);
  ok(/data-testid="prep-step-psql"/.test(custom), 'the added apt step is listed');
  ok(/postgresql-client/.test(custom), 'with its packages, editable in place');
  ok(/data-testid="prep-reset"/.test(custom), 'and NOW there is a reset-to-default');
  ok(/data-testid="prep-when-note"/.test(custom) && /one live container per pooled xell/.test(custom),
     'and choosing "at provision" states its cost on the spot — a knob whose price is invisible gets turned on by accident');
  ok(!/currently the built-in default/.test(custom), 'and it no longer claims to be the default');

  console.log('\n── every preset the menu offers is a template the server ACCEPTS ──');
  ok(P.STEP_PRESETS.every((x) => new RegExp(`value="${x.key}"`).test(html)), 'every preset is in the add menu');
  for (const preset of P.STEP_PRESETS) {
    let err = null;
    const { hint, ...step } = preset;
    try {
      const tpl = P.normalizeSpawnPrep({ steps: [...P.DEFAULT_STEPS, { ...step, key: `${step.key}-x`, enabled: true }] });
      // …and the script generator must be able to turn it into something, root or user side
      const generated = `${P.prepUserScript(tpl)}${P.prepRootScript(tpl) || ''}`;
      if (!generated.includes('WARM_OK')) err = 'produced no script';
    } catch (e) { err = e.message; }
    ok(!err, `preset "${preset.key}" normalizes and generates${err ? ` — ${err}` : ''}`);
  }

  console.log('\n── what the editor SAVES is what the API takes ──');
  // The payload is built by ONE function in the component (`put`), so it is asserted at source and
  // then PROVEN by running the exact object the editor holds through the server's normalizer. (The
  // component itself cannot be called outside a render — it uses hooks — and SSR does not click, so
  // this is the honest boundary between what is executed here and what is read.)
  ok(/save\(\{ spawn_prep: \{\s*\n?\s*steps:/.test(comp) && /when: next\.when/.test(comp),
     'a save always sends the WHOLE template — steps AND cache AND when. The API normalizes what it '
     + 'is given rather than merging, so a partial save would silently reset the fields it omitted');
  ok(/save\(\{ spawn_prep: null \}\)/.test(comp), 'and reset sends null, which is what the API reads as "the built-in default"');
  let refused = null;
  try { P.normalizeSpawnPrep({ steps: withPsql.spawn_prep.steps, cache: withPsql.spawn_prep.cache }); }
  catch (e) { refused = e.message; }
  ok(!refused, `the exact object the editor round-trips is accepted by the server${refused ? ` — ${refused}` : ''}`);
  ok(/while \(steps.some\(\(s\) => s.key === k\)\)/.test(comp),
     'adding the same preset twice gets a fresh key — two steps under one name is a timing report nobody can read');
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
