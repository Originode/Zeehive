// THE MESH PANEL — the console half (TKT-189), checked statically AND by rendering.
//
// The ticket asks for a per-MACHINE mesh panel with three jobs: CONFIG (edit the meta-DB mesh config;
// secrets write-only with a stored hint; a Generate button for the datastore key; rotation paths for
// the api token and gateway setup key), STAND UP (the mesh-control-plane bootstrap step as a
// human-gated action with typed confirmation, like Ship/ProdData), and OBSERVE (management health,
// mesh_peer counts, the phase-5 route-source tally). It also asks that the bootstrap 🔧 button be
// widened to `readiness.bootstrappable`.
//
// The card ADDED before that one shipped: mesh status must be the MOST OBVIOUS thing in the console
// when the control plane is down — hence the always-visible status-line chip (MeshStatus.jsx), with
// the loud MESH DOWN pill, the quiet "not set up" chip, and a click-through to the machine's panel.
//
// There is no browser here and no linter. So:
//   1. the WIRING is asserted against source text (the "an import nothing renders" bug class, and the
//      "a Dialog helper called but not imported" bug class — see prod-asks-console.test.mjs);
//   2. the BODIES are pure functions of props, so they are rendered with react-dom/server and the
//      markup read back — including the one rule that matters most: a SECRET's value is NEVER rendered;
//   3. the STATES are a pure word function (mesh-status.js), pinned state by state in plain node —
//      above all that a FAILED read is muted and never a false MESH DOWN;
//   4. the JOIN is exercised over a real socket: the real api.js fetches a stub answering the
//      documented routes, and the real chip renders the answer. The server half lands separately
//      (bold-ember), so this is what turns that join into one sync instead of a rewrite.
import { buildSync } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const require_ = createRequire(import.meta.url);
const read = (p) => readFileSync(p, 'utf8');
const src = {
  mesh: read('web/src/Mesh.jsx'),
  machines: read('web/src/Machines.jsx'),
  status: read('web/src/MeshStatus.jsx'),
  statuslib: read('web/src/meshStatus.js'),
  app: read('web/src/App.jsx'),
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
// The WIZARD wiring (the compact inline form's replacement): the panel offers a full-size setup
// wizard — a launch button, the modal mounted when open, and the save handed the merged body.
ok(/data-testid="mesh-configure"/.test(src.mesh), 'the panel offers the wizard launch button');
ok(/<MeshWizard\s/.test(src.mesh) && /wizardOpen && \(/.test(src.mesh),
   'MeshSections MOUNTS <MeshWizard> when open (a wizard nothing renders is worthless)');
ok(/onSave=\{save\}/.test(src.mesh) && /putMeshConfig\(m\.id, body\)/.test(src.mesh),
   'the wizard save is the ONE write path to putMeshConfig');

// ── 1b. wiring: the ALWAYS-VISIBLE mesh indicator in the console chrome ───────────────────────
// The card ADDED after the panel: mesh status must be the most obvious thing in the console when
// the control plane is down. An indicator nobody mounted (or a click-through nobody plumbed) is the
// failure mode this asserts against.
console.log('\n── wiring: the status line shows the mesh chip and clicks through to the panel ──');
ok(/import MeshStatusChip from '\.\/MeshStatus\.jsx'/.test(src.app), 'App.jsx imports the mesh status chip');
ok(/<MeshStatusChip machines=\{fleet\.machines\}/.test(src.app),
   'App.jsx RENDERS it in the chrome, fed the machine list (it is always on screen, not behind a panel)');
ok(/mesh-status/.test(src.status) && /data-loud/.test(src.status),
   'the chip carries the state as ATTRIBUTES (mesh-status / data-kind / data-loud), not just colour');
ok(/role=\{word\.loud \? 'status'/.test(src.status), 'the loud state is announced (role=status), not only styled');
ok(/MESH_POLL_MS/.test(src.statuslib) && /setInterval\(read, MESH_POLL_MS\)/.test(src.status),
   'it polls gently on its own timer (getMeshConfig/getMeshStatus — the SAME reads the panel uses)');
ok(/getMeshConfig\(id\)/.test(src.status) && /getMeshStatus\(id\)/.test(src.status),
   'the chip reads the panel\'s two endpoints for the queenzee-host machine');
ok(/is_queenzee_host/.test(src.status), 'it resolves the machine from is_queenzee_host (the plane lives in the queenzee\'s compose)');
// The click-through: chip → App state → MachineMatrix → MachineHead → MeshPanel.
ok(/onOpenMesh=\{\(key\) => setMeshFocus/.test(src.app), 'the chip\'s click raises meshFocus in App');
ok(/meshFocus=\{meshFocus\}/.test(src.app), 'App passes meshFocus to the machine matrix');
ok(/meshFocus && meshFocus\.key === col\.m\.key \? meshFocus\.n : null/.test(src.machines),
   'Machines.jsx routes the nonce to the matching machine column only');
ok(/<MeshPanel m=\{m\}[^>]*focus=\{meshFocus\}/.test(src.machines), 'MachineHead passes focus to the Mesh panel');
ok(/setOpen\(true\)/.test(src.mesh) && /scrollIntoView/.test(src.mesh),
   'the panel OPENS and scrolls into view on focus (a click-through that lands nowhere is not one)');
ok(/\[focus\]/.test(src.mesh), 'the focus nonce is an effect dependency — a second click lands again');
// The style rule the whole point rests on: mesh DOWN is a pill, not a coloured word.
const css = read('web/src/styles.css');
ok(/\.mesh-status\.loud/.test(css) && /background: var\(--down\)/.test(css),
   'MESH DOWN is styled as a filled danger pill (a red word among grey ones gets scanned past)');

// ── 2. the pure bodies, rendered ──────────────────────────────────────────────────────────────
console.log('\n── the CONFIG wizard: hints shown, values never; Generate on the key only ──');
let React, renderToStaticMarkup;
const built = [];
let M, S, API;
try {
  // BUNDLE, not transform: Mesh.jsx imports ./Dialog.jsx (JSX), which node cannot load directly.
  // React stays external so the test and the bundle share one React instance (hooks + SSR).
  const out = 'web/src/.mesh.test-build.mjs';
  buildSync({ entryPoints: ['web/src/Mesh.jsx'], outfile: out, bundle: true, format: 'esm',
    platform: 'browser', jsx: 'automatic', external: ['react', 'react-dom'] });
  built.push(out);
  M = await import('../' + out);
  // …and the status chip, whose pure BODY is what the state assertions below render. Bundled the
  // same way: it imports api.js and Mesh.jsx, so this also proves the chip's imports resolve.
  const outStatus = 'web/src/.meshstatus.test-build.mjs';
  buildSync({ entryPoints: ['web/src/MeshStatus.jsx'], outfile: outStatus, bundle: true, format: 'esm',
    platform: 'browser', jsx: 'automatic', external: ['react', 'react-dom'] });
  built.push(outStatus);
  S = await import('../' + outStatus);
  // …and the REAL fetch layer, for the over-a-socket contract check in section 4. api.js reads the
  // Vite base off import.meta.env, which plain node does not have — define it to the identity so
  // the wrapper builds its documented relative URLs.
  const outApi = 'web/src/.meshapi.test-build.mjs';
  buildSync({ entryPoints: ['web/src/api.js'], outfile: outApi, bundle: true, format: 'esm',
    platform: 'browser', define: { 'import.meta.env.BASE_URL': '"/"' } });
  built.push(outApi);
  API = await import('../' + outApi);
  React = require_('react');
  renderToStaticMarkup = require_('react-dom/server').renderToStaticMarkup;
} finally { for (const f of built) rmSync(f, { force: true }); }

// The WIZARD pages are the config editor now. Same fixtures, same rules: a non-secret value
// renders, a secret VALUE never does — only its stored hint, in the field label.
const FIELDS_FIX = { management_url: 'https://mgmt.example:443', mesh_domain: 'netbird.selfhosted' };
const SECRETS_FIX = { api_token: { set: true, hint: 'abcd…wxyz' }, datastore_encryption_key: { set: false, hint: null } };
const stepByKey = (k) => M.MESH_WIZARD_STEPS.find((s) => s.key === k);
ok(Array.isArray(M.MESH_WIZARD_STEPS) && M.MESH_WIZARD_STEPS.length >= 4
   && stepByKey('management') && stepByKey('secrets') && stepByKey('review'),
   'the wizard has the management → … → secrets → review page plan');
const mgmtHtml = renderToStaticMarkup(React.createElement(M.MeshWizardStepBody,
  { step: stepByKey('management'), fields: FIELDS_FIX, secrets: SECRETS_FIX, draft: {} }));
ok(/https:\/\/mgmt\.example:443/.test(mgmtHtml), 'a non-secret field renders its stored value');
ok(/NETBIRD_API_URL/.test(mgmtHtml), 'the field hint is VISIBLE text on the page, not only a tooltip');
const html = renderToStaticMarkup(React.createElement(M.MeshWizardStepBody,
  { step: stepByKey('secrets'), fields: FIELDS_FIX, secrets: SECRETS_FIX, draft: {} }));
ok(/abcd…wxyz/.test(html), 'a stored secret renders its HINT (in the field label)');
ok(!/value="abcd…wxyz"/.test(html), 'the secret VALUE is never rendered — only the hint');
const tokInput = html.match(/<input[^>]*data-testid="mesh-secret-api_token"[^>]*>/)?.[0] || '';
ok(/value=""/.test(tokInput), 'the secret input starts EMPTY (an empty field on save means unchanged)');
ok(/stored \(abcd…wxyz\)/.test(html), 'and the stored hint is shown beside the field');
ok(/data-testid="mesh-generate-datastore_encryption_key"/.test(html), 'the datastore key has a Generate button');
ok(!/data-testid="mesh-generate-api_token"/.test(html), 'the api token has NO Generate button (it is pasted, not invented)');
// The REVIEW page: what will be saved, secrets as unchanged/set — never a value.
const revHtml = renderToStaticMarkup(React.createElement(M.MeshWizardReviewBody,
  { fields: FIELDS_FIX, secrets: SECRETS_FIX, draft: { api_token: 'SECRET-VALUE' } }));
ok(/https:\/\/mgmt\.example:443/.test(revHtml), 'the review lists the non-secret values as they will be saved');
ok(/will be REPLACED/.test(revHtml) && !/SECRET-VALUE/.test(revHtml),
   'a drafted secret reads "will be REPLACED" — its value never reaches the markup');
ok(/unchanged \(not set\)/.test(revHtml), 'an untouched unset secret reads unchanged (not set)');
// The panel's read-only SUMMARY: current values + hints at a glance, editing only via the wizard.
const sumHtml = renderToStaticMarkup(React.createElement(M.MeshConfigSummaryBody,
  { fields: FIELDS_FIX, secrets: SECRETS_FIX, onConfigure: () => {} }));
ok(/https:\/\/mgmt\.example:443/.test(sumHtml) && /stored \(abcd…wxyz\)/.test(sumHtml) && !/<input/.test(sumHtml),
   'the summary shows values and secret hints with NO inputs (editing lives in the wizard)');
ok(/data-testid="mesh-configure"/.test(sumHtml), 'and offers the configure button that opens the wizard');
const roHtml = renderToStaticMarkup(React.createElement(M.MeshConfigSummaryBody,
  { fields: FIELDS_FIX, secrets: SECRETS_FIX, editable: false, onConfigure: () => {} }));
ok(/disabled/.test(roHtml.match(/<button[^>]*data-testid="mesh-configure"[^>]*>/)?.[0] || ''),
   'a read-only host disables the configure button');

// ── 2b. the PROVISION block: stand the plane up on the queenzee's own compose, from the wizard ──
// The management page offers to PROVISION the control plane on the Zeehive host itself (the
// queenzee's own production compose project) when there is no server to point the URL at. Same
// seam as the panel's STAND UP — one perform path, one typed gate.
console.log('\n── the wizard PROVISION block: stand up on the queenzee\'s own compose, one perform path ──');
ok(/onProvision=\{\(\) => standUp\(plan\)\}/.test(src.mesh) && /onPlanProvision=\{loadPlan\}/.test(src.mesh),
   'the wizard\'s provision is the panel\'s OWN standUp/loadPlan — one perform path, one typed gate');
ok((src.mesh.match(/performBuildBootstrap\(/g) || []).length === 1,
   'there is exactly ONE performBuildBootstrap call site (the gate cannot fork)');
ok(/step\.key === 'management' && provision/.test(src.mesh) && /slots=\{provisionSlot\}/.test(src.mesh),
   'the provision block renders on the MANAGEMENT page only, slotted under its field');
// AUTO-CHECK: opening the management page runs the dry-run plan by itself (once), so the block
// offers install immediately — no manual "check this host" step in the happy path.
ok(/autoPlanned/.test(src.mesh) && /onPlanProvision\(\);/.test(src.mesh)
   && /provision\.planned \|\| provision\.busy \|\| autoPlanned\.current/.test(src.mesh),
   'the wizard AUTO-plans on the management page (once; skipped when already planned/busy)');
// THE RECEIPT IS READ. The first live use hit the old flow's blind spot: one generic "requested"
// alert whatever the perform did, so a failed stand-up looked like a good one and the URL "just
// did not fill". Now standUp branches on the step result and the wizard fills from its TYPED url.
ok(/\.find\(\(s\) => s\.kind === 'mesh-control-plane'\)/.test(src.mesh),
   'standUp READS THE RECEIPT: it finds the mesh-control-plane step result');
ok(/r\?\.status === 'refused'/.test(src.mesh)
   && /result\.status !== 'created' && result\.status !== 'already-present'/.test(src.mesh)
   && /did NOT complete/.test(src.mesh) && /variant: 'error'/.test(src.mesh),
   'a refused perform and a failed/cannot step are ERROR alerts carrying the receipt detail');
ok(/return \{ cfg: fresh, result \};/.test(src.mesh)
   && /r\.result\?\.management_url \|\| provisionedManagementUrl\(r\.cfg\)/.test(src.mesh),
   'a good receipt returns {cfg,result}; the wizard fills the URL from the typed management_url first');
const provPlanned = renderToStaticMarkup(React.createElement(M.MeshWizardProvisionBody, {
  step: { kind: 'mesh-control-plane', status: 'planned', why: 'not running',
          action: 'docker compose --profile mesh up -d netbird-management' },
  planned: true,
}));
ok(/data-testid="mesh-wizard-provision-go"/.test(provPlanned), 'a planned step offers the provision button');
ok(/docker compose --profile mesh up -d/.test(provPlanned), 'and shows the exact action from the plan');
ok(/production compose project/.test(provPlanned) && /Zeehive host itself/.test(provPlanned),
   'the blurb says WHERE this provisions: the queenzee\'s own production compose, on the Zeehive host itself');
const provRunning = renderToStaticMarkup(React.createElement(M.MeshWizardProvisionBody, {
  step: { kind: 'mesh-control-plane', status: 'already-present', detail: 'running' },
  planned: true, resolvedUrl: 'https://netbird-management:443',
}));
ok(!/data-testid="mesh-wizard-provision-go"/.test(provRunning), 'an already-running plane offers NO provision button');
ok(/data-testid="mesh-wizard-provision-use"/.test(provRunning) && /netbird-management:443/.test(provRunning),
   'it offers "use this plane" instead, naming the resolved address');
const provOffHost = renderToStaticMarkup(React.createElement(M.MeshWizardProvisionBody, { step: null, planned: true }));
ok(/data-testid="mesh-wizard-provision-nostep"/.test(provOffHost) && /queenzee-host machine only/.test(provOffHost),
   'a machine with no control-plane step says provisioning lives on the queenzee host only');
// The URL a provision fills in: the row's value first, the resolved (default-rung) address second.
ok(M.provisionedManagementUrl({ fields: { management_url: 'https://a' },
                                resolved: { values: { api_url: 'https://b' } } }) === 'https://a',
   'provisionedManagementUrl prefers the row\'s stored URL');
ok(M.provisionedManagementUrl({ fields: {}, resolved: { values: { api_url: 'https://netbird-management:443' } } })
     === 'https://netbird-management:443',
   'and falls back to the queenzee\'s RESOLVED address (the compose-internal default rung)');
ok(M.provisionedManagementUrl({ fields: {} }) === null, 'with neither it answers null, not an invented address');
ok(M.normalizeMeshConfig({ resolved: { values: { api_url: 'https://x' } } }).resolved.values.api_url === 'https://x',
   'normalizeMeshConfig carries the server\'s `resolved` through for the provision flow');
// PLACEMENT: the block hangs DIRECTLY UNDER the management URL field it fills (before mesh domain).
// SSR runs no effects, so the auto-plan cannot fire here and the markup is deterministic.
const wizHtml = renderToStaticMarkup(React.createElement(M.MeshWizard, {
  machineKey: 'mardale', initialFields: {}, secrets: {}, onSave: () => {}, onClose: () => {},
  provision: { step: { status: 'planned', why: 'not running', action: 'compose up' }, planned: true },
  onPlanProvision: () => {}, onProvision: () => {},
}));
const at = (m) => wizHtml.indexOf(m);
ok(at('data-testid="mesh-field-management_url"') !== -1
   && at('data-testid="mesh-field-management_url"') < at('data-testid="mesh-wizard-provision"')
   && at('data-testid="mesh-wizard-provision"') < at('data-testid="mesh-field-mesh_domain"'),
   'the install block sits between the management URL field and the mesh domain field');
const provChecking = renderToStaticMarkup(React.createElement(M.MeshWizardProvisionBody, { planned: false, busy: true }));
ok(/mesh-wizard-provision-checking/.test(provChecking) && !/mesh-wizard-provision-plan/.test(provChecking),
   'while the auto-check runs it says "checking this host…" instead of offering the button');

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
const obsList = renderToStaticMarkup(React.createElement(M.MeshObserveBody, { status: {
  management: { reachable: true },
  peers: { counts: { total: 1 }, list: [{ id: 'p1', hostname: 'wise-delta-a1b2', kind: 'xell', status: 'joined' }] },
} }));
ok(/wise-delta-a1b2 · xell · joined/.test(obsList), 'a peer list, when the server answers one, renders hostname · kind · status');
ok(/mesh 7 · legacy-port 2/.test(obs), 'the tally totals mesh vs legacy-port');
ok(/<td>2026-09-12<\/td><td>7<\/td><td>2<\/td>/.test(obs), 'the per-day row shows mesh and legacy side by side');
ok(/db: mesh 7 \/ legacy 2/.test(obs), 'the per-kind breakdown is shown');
const emptyObs = renderToStaticMarkup(React.createElement(M.MeshObserveBody, { status: null }));
ok(/reading/.test(emptyObs), 'no status yet reads as "reading…", not a broken panel');
const days = M.tallyDays({ days: [ { day: '2026-09-11', source: 'mesh', n: 1 },
  { day: '2026-09-12', source: 'mesh', n: 2 }, { day: '2026-09-12', source: 'legacy-port', n: 3 } ] });
ok(days.length === 2 && days[0].day === '2026-09-12' && days[0].mesh === 2 && days[0].legacy === 3,
   'tallyDays merges rows by day, newest first');


// ── 3. the ALWAYS-VISIBLE indicator: four states, and the honesty rule ────────────────────────
// The word is a pure function (meshStatus.js), so the states are pinned in plain node; the chip's
// BODY is rendered to check that the word actually reaches the screen with its loudness attached.
console.log('\n── the mesh status word: down is loud, not-set-up is quiet, unread is never DOWN ──');
const { meshStatusWord, meshConfigured, MESH_POLL_MS } = await import('../web/src/meshStatus.js');
const HOST = { key: 'mardale', id: 'm1', is_queenzee_host: true };
const CFG = { fields: { management_url: 'https://mesh.example:33073' }, secrets: { api_token: { set: true } } };
const word = (o) => meshStatusWord({ machineKey: 'mardale', ...o });

// `address` is what the chip passes from the CONFIG read — the status read need not repeat the URL.
const down = word({ configured: true, address: CFG.fields.management_url,
  status: { management: { reachable: false, error: 'connection refused' } } });
ok(down.kind === 'mesh_down' && down.loud === true, 'configured + management unreachable → mesh_down, LOUD');
ok(/MESH DOWN/.test(down.chip) && /mesh\.example:33073/.test(down.chip),
   'the down chip says MESH DOWN and names the address that does not answer');
ok(/connection refused/.test(down.why), 'and the reason rides the tooltip');

const okw = word({ configured: true, status: { management: { reachable: true } } });
ok(okw.kind === 'mesh_ok' && okw.loud === false, 'management reachable → mesh_ok, calm (not loud)');

const off = word({ configured: false, status: { management: { reachable: false, error: 'refused' } } });
ok(off.kind === 'mesh_not_set_up' && off.loud === false && off.chip === 'mesh: not set up',
   'deliberately unconfigured → a quiet "mesh: not set up", even if something answers / does not');
ok(/legacy-port/.test(off.why), 'and the tooltip explains legacy-port is the designed fallback, not a fault');

// THE HONESTY RULE: a read that FAILED is not a verdict. my own branch has no mesh-status route yet
// (bold-ember's server half lands separately) — a 404 must NOT be rendered as MESH DOWN.
const unread = word({ configured: true, error: 'read mesh status → 404' });
ok(unread.kind === 'mesh_unknown' && unread.loud === false,
   'a FAILED status read is muted/unknown — never the loud state (a 404 is not an outage)');
ok(/404/.test(unread.why) && /not a verdict|READ failure/.test(unread.why),
   'and it says the read failed rather than claiming anything about the plane');
ok(word({ configured: null, error: null }).loud === false, 'no verdict at all is never loud either');
ok(meshStatusWord({}).kind === 'mesh_unknown', 'the word always answers (no undefined state to render)');

console.log('\n── meshConfigured: the tri-state behind "deliberately not set up" ──');
ok(meshConfigured(CFG, null) === true, 'a management URL means configured');
ok(meshConfigured(null, { enabled: true }) === true, 'an explicit enabled from the status read wins');
ok(meshConfigured({ enabled: false, fields: { management_url: 'x' } }, null) === false,
   'an explicit false wins over inferred config (the fleet is OFF on purpose)');
ok(meshConfigured({ fields: {}, secrets: { api_token: { set: true } } }, null) === true,
   'a stored secret alone means configured (someone intends this fleet to mesh)');
ok(meshConfigured({ fields: {}, secrets: {} }, { management: { reachable: false } }) === false,
   'an empty config read cleanly → FALSE (deliberately not set up), not unknown');
ok(meshConfigured(null, { management: { reachable: false } }) === null,
   'an UNREADABLE config with nothing said → null (cannot claim "not set up")');
ok(word({ configured: null, status: { management: { reachable: false } } }).kind === 'mesh_down',
   '…but an ANSWERED status still reports the outage — the config read is not needed for that');
ok(typeof MESH_POLL_MS === 'number' && MESH_POLL_MS >= 30000, `the poll is GENTLE [${MESH_POLL_MS}ms]`);

console.log('\n── the rendered chip: every state on screen, at the right loudness ──');
const chip = (props) => renderToStaticMarkup(React.createElement(S.MeshStatusChipBody, props));
const downHtml = chip({ host: HOST, cfg: CFG, onOpenMesh: () => {},
  status: { management: { reachable: false, error: 'refused' } } });
ok(/data-testid="mesh-status"/.test(downHtml) && /data-kind="mesh_down"/.test(downHtml),
   'the down state renders with data-kind=mesh_down');
ok(/data-loud="1"/.test(downHtml) && /class="mesh-status mesh_down loud"/.test(downHtml),
   'and is marked loud — that is what the danger pill styles on');
ok(/MESH DOWN/.test(downHtml), 'the words MESH DOWN are on screen, not only in a tooltip');
const offHtml = chip({ host: HOST, cfg: { fields: {}, secrets: {} }, status: { management: { reachable: false } } });
ok(/mesh_not_set_up/.test(offHtml) && /mesh: not set up/.test(offHtml) && !/data-loud/.test(offHtml),
   'not-configured renders the quiet chip with NO loud marker');
const okHtml = chip({ host: HOST, cfg: CFG, status: { management: { reachable: true } } });
ok(/mesh_ok/.test(okHtml) && /mesh: up/.test(okHtml), 'up renders the calm green chip');
const unreadHtml = chip({ host: HOST, cfg: CFG, error: 'boom' });
ok(/mesh_unknown/.test(unreadHtml) && !/data-loud/.test(unreadHtml),
   'an unreadable status renders muted — no false alarm from a broken read');
ok(chip({ host: null, cfg: CFG, status: null }) === '', 'no queenzee-host machine → nothing to say (renders nothing)');
ok(/Click to open the Mesh panel on mardale/.test(downHtml), 'the chip says where a click takes you');
ok(/cursor:pointer/.test(downHtml), 'and it reads as clickable when a click-through is wired');
ok(chip({ host: HOST, cfg: CFG, status: { management: { reachable: false } }, onOpenMesh: null })
   .indexOf('cursor:pointer') === -1, 'with no click-through wired it does not pretend to be a button');
// The click-through actually fires with the machine key (the panel is per-machine).
let openedWith = null;
const chipAny = React.createElement(S.MeshStatusChipBody, { host: HOST, cfg: CFG,
  status: { management: { reachable: false } }, onOpenMesh: (k) => { openedWith = k; } });
// renderToStaticMarkup cannot dispatch events; assert the handler is reachable via the element props
// the same way (a wrapper that renders the element and calls its onClick).
const el = S.MeshStatusChipBody({ host: HOST, cfg: CFG, status: { management: { reachable: false } },
  onOpenMesh: (k) => { openedWith = k; } });
el.props.onClick();
ok(openedWith === 'mardale', 'clicking the chip opens the mardale machine\'s Mesh panel');
ok(!!chipAny, 'the chip is a plain element (no wrapper state to desync the click-through)');


// ── 4. the JOIN: real HTTP → the real api.js → the real chip ──────────────────────────────────
// The server half is built in parallel (bold-ember) and is NOT on this branch — today both routes
// answer 404. So the CONTRACT is pinned here instead: a stub answers the two documented routes, the
// REAL web/src/api.js fetches them over a real socket, and the REAL chip body renders the answer.
// When the server half lands, a shape mismatch fails THIS test rather than shipping a chip that
// reads "no verdict" forever — the join is meant to be one sync, and this is what makes it one.
console.log('\n── the join: real HTTP → api.js → the chip (the contract the server half must answer) ──');
let payload = null;
const stub = createServer((req, res) => {
  const send = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (!payload || !(req.url || '').startsWith(payload.route)) return send(404, { error: 'not found' });
  // a JSON body, or the raw HTML express actually answers an unknown route with
  if (payload.raw !== undefined) {
    return res.writeHead(payload.status || 200, { 'content-type': 'text/html' }).end(payload.raw);
  }
  send(payload.status || 200, payload.body);
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${stub.address().port}`;
const realFetch = globalThis.fetch;
// api.js fetches RELATIVE urls (a browser resolves them against the page origin); node has no page,
// so resolve them against the stub. Everything else about the path is the app's own code.
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? origin + u : u, o);
try {
  const HOSTM = { key: 'mardale', id: 'm1', is_queenzee_host: true };
  const CFG_BODY = { fields: { management_url: 'https://mesh.example:33073' },
                     secrets: { api_token: { set: true, hint: 'abcd…wxyz' },
                                datastore_encryption_key: { set: false } } };
  // One full pass exactly as the chip makes it: config read, status read, word, markup.
  const pass = async (cfgBody, statusCase) => {
    payload = { route: '/api/machines/m1/mesh-config', body: cfgBody };
    const cfg = M.normalizeMeshConfig(await API.getMeshConfig('m1'));
    payload = { route: '/api/machines/m1/mesh-status', ...statusCase };
    let status = null, error = null;
    try { status = await API.getMeshStatus('m1'); } catch (e) { error = e.message; }
    return { cfg, status, error,
      html: renderToStaticMarkup(React.createElement(S.MeshStatusChipBody,
        { host: HOSTM, cfg, status, error, onOpenMesh: () => {} })) };
  };

  const downJoin = await pass(CFG_BODY, { body: { management: { reachable: false, error: 'ECONNREFUSED' },
    peers: { counts: { machine: 2, total: 2 } } } });
  ok(/data-kind="mesh_down"/.test(downJoin.html) && /data-loud="1"/.test(downJoin.html),
     'the documented down payload, fetched over HTTP, renders the LOUD MESH DOWN chip');
  ok(/ECONNREFUSED/.test(downJoin.html), 'and the reason the server gave survives the trip');
  ok(/mesh\.example:33073/.test(downJoin.html), 'and the configured address is named in the chip');

  const upJoin = await pass(CFG_BODY, { body: { management: { reachable: true }, peers: { counts: { total: 2 } } } });
  ok(/data-kind="mesh_ok"/.test(upJoin.html) && !/data-loud/.test(upJoin.html),
     'the documented up payload renders the calm chip');

  const offJoin = await pass({ fields: {}, secrets: {} }, { body: { management: { reachable: false } } });
  ok(/data-kind="mesh_not_set_up"/.test(offJoin.html) && /mesh: not set up/.test(offJoin.html),
     'an EMPTY config payload (deliberately unconfigured) renders the quiet chip');

  const goneJoin = await pass(CFG_BODY, { status: 404, raw: '<!DOCTYPE html><html><body>Cannot GET</body></html>' });
  ok(/data-kind="mesh_unknown"/.test(goneJoin.html) && !/data-loud/.test(goneJoin.html),
     'a 404 status route (this branch today, answered as express HTML) renders MUTED — not an outage');
  ok(/404/.test(goneJoin.error || ''), `the read failure names the status [${goneJoin.error}]`);
  const refusedJoin = await pass(CFG_BODY, { status: 500, body: { error: 'mesh-status blew up' } });
  ok(/mesh-status blew up/.test(refusedJoin.html) && !/data-loud/.test(refusedJoin.html),
     'a server that DID answer with an error is still a read failure — muted, and the server\'s own words are shown');
  // The write-only rule survives the join too: whatever the server sends back, no secret VALUE —
  // there is none in the contract, and the chip must not render one if a server ever sent it.
  ok(!/value="/.test(downJoin.html) || !/abcd/.test(downJoin.html),
     'no secret material is rendered by the chip, even from a server that offered a hint');
} finally {
  globalThis.fetch = realFetch;
  await new Promise((r) => stub.close(r));
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
