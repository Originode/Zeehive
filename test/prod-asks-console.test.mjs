// PROD-DATA asks: the CONSOLE side, checked statically.
//
// The failure this guards is precisely the one that made `zee prod` useless for months: the server
// recorded the request perfectly and NOTHING rendered it, so a zee asked for production and was
// never answered. There is no linter and no browser in CI here, so the wiring is asserted by
// reading the source:
//   1. every hive status key the SERVER can emit has a colour, a heat and a fallback label in the
//      web palette (they are two files that must stay in lockstep — hive-status.js says so);
//   2. App.jsx imports AND renders the prod-data cards + panel;
//   3. NeedsYouBar — the one line that names who is waiting on you — counts prod-bind and seed asks;
//   4. ProdData.jsx imports every Dialog helper it calls (the app-dialog-imports bug class: a
//      free identifier at module scope that vite happily builds and the browser throws on).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. server vocabulary ⊆ web palette ──
const { HIVE_STATUS } = await import('../server/src/lib/hive-status.js');
const palette = read('web/src/hive/status.js');
const keysIn = (block) => new Set([...(palette.match(new RegExp(`export const ${block} = \\{[^}]*\\}`, 's'))?.[0] || '')
  .matchAll(/'([a-z]+-[A-Za-z]+)'\s*:/g)].map((m) => m[1]));
const colors = keysIn('HIVE_COLORS'); const heat = keysIn('HIVE_HEAT'); const labels = keysIn('HIVE_LABELS');
for (const k of Object.keys(HIVE_STATUS)) {
  ok(colors.has(k) && heat.has(k) && labels.has(k), `${k} has a colour, a heat and a label in the web palette`);
}
ok(HIVE_STATUS['occ-prodRequest']?.label === 'prod?' && HIVE_STATUS['occ-seedRequest']?.label === 'seed?',
   'the two prod-DATA asks are in the operator vocabulary (prod? / seed?)');

// ── 2 + 3. App.jsx wiring ──
const app = read('web/src/App.jsx');
const imp = app.match(/import\s+([^;]*?)\s+from\s+['"]\.\/ProdData\.jsx['"]/);
ok(!!imp, 'App.jsx imports from ./ProdData.jsx');
for (const name of ['ProdAsksPanel', 'ProdBindCard', 'SeedCard']) {
  ok((imp?.[1] || '').includes(name), `App.jsx imports ${name}`);
  ok(new RegExp(`<${name}[\\s/>]`).test(app), `App.jsx RENDERS <${name}> (an import nothing renders is the old bug)`);
}
ok(/fleet\.prod_bind/.test(app) && /fleet\.prod_seed/.test(app),
   'App.jsx reads prod_bind + prod_seed off the fleet payload');
const bar = app.slice(app.indexOf('function NeedsYouBar'));
ok(/prodBindByXell/.test(bar) && /seedByXell/.test(bar),
   'NeedsYouBar — the "waiting on you" line — counts prod-bind and seed asks');
ok(/n: held \+ prs \+ tend \+ bind \+ seed/.test(bar),
   'a xell with ONLY a prod-data ask still appears in the waiting-on-you line');

// ── 4. ProdData.jsx calls only dialog helpers it imports ──
const prod = read('web/src/ProdData.jsx');
const dialog = read('web/src/Dialog.jsx');
const exported = new Set([...dialog.matchAll(/export\s+function\s+(show[A-Za-z]+)/g)].map((m) => m[1]));
const imported = new Set((prod.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/Dialog\.jsx['"]/)?.[1] || '')
  .split(',').map((s) => s.trim()));
const called = [...prod.matchAll(/\b(show[A-Za-z]+)\s*\(/g)].map((m) => m[1]);
for (const c of new Set(called)) {
  if (!exported.has(c)) continue;
  ok(imported.has(c), `ProdData.jsx imports the ${c} it calls`);
}

// The seed card must show the SQL before it can be approved — approving prod data you have not read
// is the same mistake as approving a landing you have not read.
ok(/seedRequestSql/.test(prod), 'the seed card fetches the exact SQL a human is approving');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
