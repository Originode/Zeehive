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
ok(/accounts=\{accounts\}/.test(addBtn) && /p\.dispatch/.test(addBtn),
   'the one manager button still lets a human pick WHICH connected AI account runs it');
// Dialog helpers it still calls must still be imported (the app-dialog-imports bug class).
const dialogExports = new Set([...read('web/src/Dialog.jsx').matchAll(/export\s+function\s+(show[A-Za-z]+)/g)].map((m) => m[1]));
const mgrImports = new Set((mgr.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/Dialog\.jsx['"]/)?.[1] || '')
  .split(',').map((s) => s.trim()));
for (const c of new Set([...mgr.matchAll(/\b(show[A-Za-z]+)\s*\(/g)].map((m) => m[1]))) {
  if (dialogExports.has(c)) ok(mgrImports.has(c), `Manager.jsx imports the ${c} it calls`);
}

// ── 2. App.jsx hands it what the composer needs ──
ok(/<AddManagerButton[\s\S]{0,200}providers=\{providers\}/.test(app),
   'App.jsx passes the connected providers to AddManagerButton (the account picker)');

// ── 3. the composer's manager variant ──
ok(/manager = false/.test(disp), 'Dispatch takes a `manager` variant flag (default false — the worker composer is unchanged)');
ok(/getHarnesses\(manager \? 'manager' : 'worker'\)/.test(disp),
   'it offers MANAGER harnesses for a manager and worker harnesses otherwise (054 refuses a mismatch)');
ok(/!task && !manager/.test(disp),
   'a blank brief is allowed for a manager (the server then applies DEFAULT_MANAGER_BRIEF) and refused for a worker');
ok(/\.\.\.\(task \? \{ task \} : \{\}\)/.test(disp),
   'a blank manager brief sends NO task key rather than an empty one');
ok(/data-testid="manager-proddb-note"/.test(disp) && !/manager[\s\S]{0,80}dispatch-proddb-on/.test(disp),
   'a manager gets the read-only-production FACT, not a prod-DB toggle that would be a lie either way');
ok(/\{!manager && prodDb &&/.test(disp), 'the LIVE-PROD warning banner can never render in the manager composer');
ok(/!manager && \(\s*<button className=\{`disp-seg \$\{harness === '' \? 'on' : ''\}`\}/.test(disp)
   || /\{!manager && \(/.test(disp.slice(disp.indexOf('dispatch-harness-default'))),
   'a manager is never offered "core only" — its manual IS the manager harness');
ok(/provider: activeProvider/.test(disp) && /activeTokenId \? \{ provider_token_id: activeTokenId \}/.test(disp),
   'the payload carries the ACCOUNT actually chosen in the composer');
ok(/data-testid=\{manager \? 'manager-submit' : 'dispatch-submit'\}/.test(disp),
   'the submit button names the act it performs (Add manager zee / Dispatch)');

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
