// ADDING A MANAGER ZEE — the console side, checked statically.
//
// The bug this guards: a manager's PROGRAMME (the standing brief an agent runs a whole crew from,
// the longest-lived prompt in the fleet) was typed into a one-line showPrompt() `<input>`. You
// could not see what you had written, could not paste a backlog or a screenshot, Enter fired it,
// and there was no choice of model, autonomy, harness or account — while a WORKER doing one job in
// one xell got the full composer. The fix is not a bigger input: it is the SAME composer, with the
// differences that are actually true of a manager (manager harnesses, no prod-DB toggle because the
// bind is unconditional and read-only, a blank brief that means DEFAULT_MANAGER_BRIEF).
//
// There is no browser and no linter in CI here, so the wiring is asserted by reading the source —
// the same technique as app-dialog-imports / prod-asks-console.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const mgr = read('web/src/Manager.jsx');
const disp = read('web/src/Dispatch.jsx');
const app = read('web/src/App.jsx');
const spawn = read('server/src/lib/manager-spawn.js');

// ── 1. the button opens the COMPOSER, not a one-line prompt ──
ok(/import\s+Dispatch\s+from\s+['"]\.\/Dispatch\.jsx['"]/.test(mgr),
   'Manager.jsx imports the Dispatch composer');
const addBtn = mgr.slice(mgr.indexOf('export function AddManagerButton'), mgr.indexOf('export function DoneSuggestionCard'));
ok(/<Dispatch\s+manager\b/.test(addBtn), 'AddManagerButton renders <Dispatch manager …> (the composer, in its manager variant)');
ok(!/showPrompt\s*\(/.test(addBtn), 'AddManagerButton no longer types the programme into a one-line showPrompt input');
ok(/onDispatch=\{add\}/.test(addBtn) && /addManagerZee\(payload\)/.test(addBtn),
   'the composed payload is POSTed to /api/managers unchanged (addManagerZee)');
// WHICH ACCOUNT runs it is still a choice a human makes — it just is not flattened out of the
// console's provider read-model and handed down any more. The composer reads the whole option set
// itself (GET /api/dispatch/options), because the answer depends on the manager PERSONA's model
// policy, which this component cannot know: the old list offered accounts the spawn would refuse.
ok(!/accounts=\{accounts\}/.test(addBtn),
   'the manager button no longer pre-flattens an account list the persona policy could contradict');
ok(/getDispatchOptions\(/.test(disp) && /data-testid=\{`dispatch-account-\$\{a\.id\}`\}/.test(disp),
   'the one manager button still lets a human pick WHICH connected AI account runs it — inside the composer, '
   + 'from the options the persona actually allows');
// Dialog helpers it still calls must still be imported (the app-dialog-imports bug class).
const dialogExports = new Set([...read('web/src/Dialog.jsx').matchAll(/export\s+function\s+(show[A-Za-z]+)/g)].map((m) => m[1]));
const mgrImports = new Set((mgr.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/Dialog\.jsx['"]/)?.[1] || '')
  .split(',').map((s) => s.trim()));
for (const c of new Set([...mgr.matchAll(/\b(show[A-Za-z]+)\s*\(/g)].map((m) => m[1]))) {
  if (dialogExports.has(c)) ok(mgrImports.has(c), `Manager.jsx imports the ${c} it calls`);
}

// ── 2. App.jsx hands it what the composer needs ──
// Only the project — the composer resolves providers, accounts and models from the PERSONA it is
// composing for (one call, server-side), so nothing about the credentials travels through here.
ok(/<AddManagerButton projectId=\{[^}]+\} projectName=\{[^}]+\}\s*\n\s*onAdded=\{refresh\} \/>/.test(app),
   'App.jsx opens the manager composer with the project alone (the options come from the persona, not from App)');

// ── 3. the composer's manager variant ──
ok(/manager = false/.test(disp), 'Dispatch takes a `manager` variant flag (default false — the worker composer is unchanged)');
// …and, since 084, scoped to the project it is composing for: the system-wide personas plus that
// project's own, never another project's (a xell may only wear one of those two, so anything else in
// this picker is a button that produces a refusal).
// A WORKER's persona is now the prompt BUTTON itself (App.jsx renders one per harness), so the only
// picker left in here is the manager's — one manager button serves the whole fleet. Both lists are
// still type-scoped (054 refuses a mismatch) and project-scoped (084: the system-wide personas plus
// this project's own, never another project's — anything else is a button that produces a refusal).
ok(/getHarnesses\('manager', projectId\)/.test(disp),
   'the composer offers MANAGER harnesses in its manager variant (054), scoped to this project (084)');
ok(/getHarnesses\('worker', pid\)/.test(app),
   "and App.jsx builds the worker prompt buttons from this project's worker harnesses");
ok(/!task && !manager/.test(disp),
   'a blank brief is allowed for a manager (the server then applies DEFAULT_MANAGER_BRIEF) and refused for a worker');
ok(/\.\.\.\(task \? \{ task \} : \{\}\)/.test(disp),
   'a blank manager brief sends NO task key rather than an empty one');
ok(/data-testid="manager-proddb-note"/.test(disp) && !/manager[\s\S]{0,80}dispatch-proddb-on/.test(disp),
   'a manager gets the read-only-production FACT, not a prod-DB toggle that would be a lie either way');
ok(/\{!manager && prodDb &&/.test(disp), 'the LIVE-PROD warning banner can never render in the manager composer');
// A manager is never offered "core only" — its manual IS the manager harness (the crew verbs, the
// read-only-prod and no-push law it must know). The persona picker in here is manager-only and
// carries no core-only segment; core-only is a WORKER prompt button in App.jsx.
ok(/\{manager && harnesses\.length > 0 && \(/.test(disp) && !/dispatch-harness-none/.test(disp),
   'a manager is never offered "core only" — its manual IS the manager harness');
ok(/data-testid="new-prompt-btn-core"|new-prompt-btn-\$\{b\.key \|\| 'core'\}/.test(app),
   'while a WORKER can still be dispatched with no persona at all — "core only" is its own prompt button');
ok(/provider: activeProvider/.test(disp) && /activeTokenId \? \{ provider_token_id: activeTokenId \}/.test(disp),
   'the payload carries the ACCOUNT actually chosen in the composer');
ok(/data-testid=\{manager \? 'manager-submit' : 'dispatch-submit'\}/.test(disp),
   'the submit button names the act it performs (Add manager zee / Dispatch)');

// ── 3b. the overlay ESCAPES the pane it is opened from ──
// The manager button lives in the toolbar inside `.content` (`position: relative; z-index: 1`),
// which is a stacking context — so a full-screen overlay rendered in place ranked at z 1 among the
// panels pane's contents, and the graph divider/grip (z 4/5/6 on `.hive-split`) plus the
// <Connectors> line overlay painted over the modal. No z-index value can fix that; the overlay has
// to leave the tree. Both variants portal onto <body>.
ok(/import \{ createPortal \} from 'react-dom'/.test(disp), 'Dispatch imports createPortal');
ok(/return createPortal\(\(/.test(disp) && /\), document\.body\);/.test(disp),
   'the overlay is portalled onto document.body — unconditionally, not just for the manager variant');
ok(!/\{manager \?[\s\S]{0,80}createPortal/.test(disp),
   'the portal is not conditional on the variant (the worker composer only escaped by luck of where App renders it)');
const css2 = read('web/src/styles.css');
ok(/composer 60\s+<\s+toasts 80\s+<\s+dialogs 90\s+<\s+diff viewer 95/.test(css2),
   'the overlay band is written down beside .disp-overlay (toasts/dialogs must stay above a composer)');
const zOf = (sel) => Number((css2.match(new RegExp(`\\${sel}[^}]*z-index:\\s*(\\d+)`, 's')) || [])[1]);
ok(zOf('.disp-overlay') < zOf('.toast-stack') && zOf('.toast-stack') < zOf('.dlg-overlay')
   && zOf('.dlg-overlay') < zOf('.dv-overlay'),
   `the band holds in the CSS: composer ${zOf('.disp-overlay')} < toasts ${zOf('.toast-stack')} < dialog ${zOf('.dlg-overlay')} < diff ${zOf('.dv-overlay')}`);

// ── 4. the server accepts everything the composer can now compose ──
ok(/headless, images,/.test(spawn) || /headless,\s*images/.test(spawn),
   'createManagerZee takes headless + images');
ok(/\{ headless: headless !== false \}/.test(spawn), 'the attended/headless choice reaches the dispatch');
ok(/Array\.isArray\(images\) && images\.length \? \{ images \}/.test(spawn),
   'a pasted screenshot reaches the dispatch (it used to be dropped silently)');
ok(/const brief = String\(task \|\| ''\)\.trim\(\) \|\| DEFAULT_MANAGER_BRIEF/.test(spawn),
   'a blank programme still means DEFAULT_MANAGER_BRIEF, not an empty task');

// ── 5. the styles the variant asks for exist ──
const css = read('web/src/styles.css');
ok(/\.disp\.disp-mgr\b/.test(css), 'the manager composer has its own (production-orange) styling');
ok(/\.disp-foot \.disp-hint/.test(css), 'the footer hint is laid out (it sits left of the buttons)');

console.log(fail === 0 ? '\nALL PASSED ✓' : `\n${fail} FAILURE(S) ✗`);
process.exit(fail ? 1 : 0);
