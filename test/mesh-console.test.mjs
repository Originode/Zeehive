// THE MESH PANEL — the console half (TKT-189), checked statically AND by rendering.
//
// The ticket asks for a per-MACHINE mesh panel with three jobs: CONFIG (edit the meta-DB mesh config;
// secrets write-only with a stored hint; a Generate button for the datastore key; rotation paths for
// the api token and gateway setup key), STAND UP (the mesh-control-plane bootstrap step as a
// human-gated action with typed confirmation, like Ship/ProdData), and OBSERVE (management health,
// mesh_peer counts, the phase-5 route-source tally). It also asks that the bootstrap 🔧 button be
// widened to `readiness.bootstrappable`.
//
// There is no browser here and no linter. So:
//   1. the WIRING is asserted against source text (the "an import nothing renders" bug class, and the
//      "a Dialog helper called but not imported" bug class — see prod-asks-console.test.mjs);
//   2. the BODIES are pure functions of props, so they are rendered with react-dom/server and the
//      markup read back — including the one rule that matters most: a SECRET's value is NEVER rendered.
import { buildSync } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const require_ = createRequire(import.meta.url);
const read = (p) => readFileSync(p, 'utf8');
const src = {
  mesh: read('web/src/Mesh.jsx'),
  machines: read('web/src/Machines.jsx'),
  api: read('web/src/api.js'),
  routes: read('server/src/api/routes.js'),
};

// ── 1. wiring: the panel is mounted, the fetchers exist, the gate performs a SCOPED step ─────────
console.log('\n── wiring: MachineHead renders 🌐 mesh; api.js speaks the contract ──');
ok(/import MeshPanel from '\.\/Mesh\.jsx'/.test(src.machines), 'Machines.jsx imports the Mesh panel');
ok(/<MeshPanel\s+m=\{m\}[^>]*\/>/.test(src.machines), 'MachineHead RENDERS <MeshPanel> (an import nothing renders is worthless)');
for (const [path, what] of [['\\/api\\/machines\\/\\$\\{[^}]+\\}\\/mesh-config', 'mesh-config'],
                            ['\\/api\\/machines\\/\\$\\{[^}]+\\}\\/mesh-status', 'mesh-status']]) {
  ok(new RegExp(path).test(src.api), `api.js addresses the ${what} route`);
}
ok(/export const getMeshConfig/.test(src.api) && /export const putMeshConfig/.test(src.api)
   && /export const getMeshStatus/.test(src.api), 'api.js exposes get/putMeshConfig + getMeshStatus');
ok(/putMeshConfig = \(machineId, body\) =>/.test(src.api), 'putMeshConfig takes the plaintext body (PUT accepts secrets)');
// The stand-up must be SCOPED: standing up the mesh must not create the project's networks/dev-db.
ok(/performBuildBootstrap\(projectId, m\.id, [^,)]+, \['mesh-control-plane'\]\)/.test(src.mesh),
   'the panel performs ONLY the mesh-control-plane step (kinds-scoped)');
ok(/r\?\.refused \|\| r\?\.status === 'refused'/.test(src.mesh) && /setPlanErr\(r\.refused/.test(src.mesh),
   'a refused plan surfaces its reason, not the misleading "not the queenzee host" note');
ok(/kinds/.test(src.api.slice(src.api.indexOf('performBuildBootstrap'))) && /kinds/.test(src.routes),
   'the kinds scope is passed through api.js to the server route');
// The typed-word gate, not a bare click (the Ship/ProdData house pattern).
ok(/showPrompt\(/.test(src.mesh) && /placeholder: 'STAND UP'/.test(src.mesh) && /variant: 'danger'/.test(src.mesh),
   "the stand-up is gated by a typed-word showPrompt ('STAND UP', danger variant)");
// Dialog helpers called must be imported (the free-identifier-in-module-scope bug class).
const dialog = read('web/src/Dialog.jsx');
const dlgExported = new Set([...dialog.matchAll(/export\s+function\s+(show[A-Za-z]+)/g)].map((m) => m[1]));
const dlgImported = new Set((src.mesh.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/Dialog\.jsx['"]/)?.[1] || '')
  .split(',').map((s) => s.trim()));
for (const c of new Set([...src.mesh.matchAll(/\b(show[A-Za-z]+)\s*\(/g)].map((m) => m[1]))) {
  if (dlgExported.has(c)) ok(dlgImported.has(c), `Mesh.jsx imports the ${c} it calls`);
}
// The write-only rule is stated in the source, and no code path reads a secret back into a value.
ok(/an empty field on save means unchanged|empty secret = unchanged|Empty secret = unchanged/i.test(src.mesh),
   'the source states the write-only rule: empty = unchanged');
ok(/value=\{draft\[k\]/.test(src.mesh) && !/value=\{secrets\[k\]/.test(src.mesh),
   'a secret input is bound to the DRAFT only — the stored value is never bound back into it');

// ── 2. the pure bodies, rendered ──────────────────────────────────────────────────────────────
console.log('\n── the CONFIG body: hints shown, values never; Generate on the key only ──');
let React, renderToStaticMarkup;
const built = [];
let M;
try {
  // BUNDLE, not transform: Mesh.jsx imports ./Dialog.jsx (JSX), which node cannot load directly.
  // React stays external so the test and the bundle share one React instance (hooks + SSR).
  const out = 'web/src/.mesh.test-build.mjs';
  buildSync({ entryPoints: ['web/src/Mesh.jsx'], outfile: out, bundle: true, format: 'esm',
    platform: 'browser', jsx: 'automatic', external: ['react', 'react-dom'] });
  built.push(out);
  M = await import('../' + out);
  React = require_('react');
  renderToStaticMarkup = require_('react-dom/server').renderToStaticMarkup;
} finally { for (const f of built) rmSync(f, { force: true }); }

const html = renderToStaticMarkup(React.createElement(M.MeshConfigBody, {
  fields: { management_url: 'https://mgmt.example:443', mesh_domain: 'netbird.selfhosted' },
  secrets: { api_token: { set: true, hint: 'abcd…wxyz' }, datastore_encryption_key: { set: false, hint: null } },
  draft: {},
}));
ok(/https:\/\/mgmt\.example:443/.test(html), 'a non-secret field renders its stored value');
ok(/abcd…wxyz/.test(html), 'a stored secret renders its HINT (in the placeholder)');
ok(!/value="abcd…wxyz"/.test(html), 'the secret VALUE is never rendered — only the hint');
const tokInput = html.match(/<input[^>]*data-testid="mesh-secret-api_token"[^>]*>/)?.[0] || '';
ok(/value=""/.test(tokInput), 'the secret input starts EMPTY (an empty field on save means unchanged)');
ok(/placeholder="stored \(abcd…wxyz\)"/.test(tokInput), 'and its placeholder is the stored hint');
ok(/data-testid="mesh-generate-datastore_encryption_key"/.test(html), 'the datastore key has a Generate button');
ok(!/data-testid="mesh-generate-api_token"/.test(html), 'the api token has NO Generate button (it is pasted, not invented)');

console.log('\n── the pure helpers ──');
ok(M.secretHint({ set: true, hint: 'x' }) === 'stored (x)' && M.secretHint({ set: false }) === 'not set'
   && M.secretHint(null) === 'not set', 'secretHint: stored(hint) / not set');
const norm = M.normalizeMeshConfig({ config: { management_url: 'u' }, secret_hints: { api_token: 'last4' } });
ok(norm.fields.management_url === 'u', 'normalizeMeshConfig tolerates `config` for fields');
ok(norm.secrets.api_token.set === true && norm.secrets.api_token.hint === 'last4',
   'normalizeMeshConfig tolerates a bare hint string');
ok(norm.secrets.gateway_setup_key.set === false, 'and fills an absent secret as not set');
const k1 = M.generateDatastoreKey();
const k2 = M.generateDatastoreKey();
ok(typeof k1 === 'string' && Buffer.from(k1, 'base64').length === 32,
   `generateDatastoreKey is 32 bytes of base64 [${Buffer.from(k1, 'base64').length}]`);
ok(k1 !== k2, 'two generated keys differ (real key material, not a constant)');

console.log('\n── the STAND UP body: only a planned step offers the action ──');
const plannedStep = { kind: 'mesh-control-plane', target: 'default', status: 'planned',
  why: 'not running', detail: 'not running', action: 'docker compose --profile mesh up -d netbird-management' };
const upHtml = renderToStaticMarkup(React.createElement(M.MeshStandUpBody, { step: plannedStep, planned: true }));
ok(/data-testid="mesh-standup-go"/.test(upHtml), 'a planned step offers the stand-up button');
ok(/docker compose --profile mesh up -d/.test(upHtml), 'and shows the exact action in the plan');
const runningHtml = renderToStaticMarkup(React.createElement(M.MeshStandUpBody,
  { step: { ...plannedStep, status: 'already-present', detail: 'running' }, planned: true }));
ok(!/data-testid="mesh-standup-go"/.test(runningHtml), 'an already-present plane offers NO action');
const offHostHtml = renderToStaticMarkup(React.createElement(M.MeshStandUpBody, { step: null, planned: true }));
ok(/data-testid="mesh-nostep"/.test(offHostHtml) && /queenzee-host machine only/.test(offHostHtml),
   'a machine with no control-plane step says so (the queenzee host is where it lives)');

console.log('\n── the OBSERVE body: health, peer counts, the tally per day ──');
const obs = renderToStaticMarkup(React.createElement(M.MeshObserveBody, { status: {
  management: { reachable: false, error: 'connection refused' },
  peers: { counts: { machine: 3, xell: 12, gateway: 1, total: 16 } },
  tally: { window_days: 14, by_source: { mesh: 7, 'legacy-port': 2 },
           by_kind: { db: { mesh: 7, 'legacy-port': 2 } },
           days: [{ day: '2026-09-12', target_kind: 'db', source: 'mesh', n: 7 },
                  { day: '2026-09-12', target_kind: 'db', source: 'legacy-port', n: 2 }] },
} }));
ok(/management: unreachable/.test(obs) && /connection refused/.test(obs), 'the management health is shown with its reason');
ok(/machine 3/.test(obs) && /xell 12/.test(obs), 'the peer counts are listed');
ok(/mesh 7 · legacy-port 2/.test(obs), 'the tally totals mesh vs legacy-port');
ok(/<td>2026-09-12<\/td><td>7<\/td><td>2<\/td>/.test(obs), 'the per-day row shows mesh and legacy side by side');
ok(/db: mesh 7 \/ legacy 2/.test(obs), 'the per-kind breakdown is shown');
const emptyObs = renderToStaticMarkup(React.createElement(M.MeshObserveBody, { status: null }));
ok(/reading/.test(emptyObs), 'no status yet reads as "reading…", not a broken panel');
const days = M.tallyDays({ days: [ { day: '2026-09-11', source: 'mesh', n: 1 },
  { day: '2026-09-12', source: 'mesh', n: 2 }, { day: '2026-09-12', source: 'legacy-port', n: 3 } ] });
ok(days.length === 2 && days[0].day === '2026-09-12' && days[0].mesh === 2 && days[0].legacy === 3,
   'tallyDays merges rows by day, newest first');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
