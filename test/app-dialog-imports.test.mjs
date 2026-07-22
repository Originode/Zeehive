// APP DIALOG-IMPORTS test — proves every dialog helper (showAlert/showConfirm/showPrompt)
// that App.jsx CALLS is also IMPORTED from Dialog.jsx.
//
// This guards a whole class of bug that has bitten the console twice:
//   • fe2f329 "App.jsx forgot to import showConfirm — every confirm-guarded button threw"
//   • the "Mark done opens a confirmation but does not seem to mark done" report — App.jsx
//     called showPrompt (the "type: done" hard-confirmation) without importing it, so the
//     typed-confirmation path (a live zee / unlanded work / a pending decision) threw
//     ReferenceError uncaught: the first confirm opened, then nothing happened.
//
// There is no linter in this repo, and vite build does NOT flag a use-before-import of a
// module-scope free identifier, so a static check is the only thing that catches it. No DB,
// no browser — just read the source and reconcile calls against the import.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(here, '../web/src/App.jsx'), 'utf8');
const dialogSrc = readFileSync(resolve(here, '../web/src/Dialog.jsx'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// The helpers Dialog.jsx actually exports (show*).
const exported = new Set(
  [...dialogSrc.matchAll(/export\s+function\s+(show[A-Za-z]+)/g)].map((m) => m[1]));
ok(exported.has('showAlert') && exported.has('showConfirm') && exported.has('showPrompt'),
   `Dialog.jsx exports showAlert/showConfirm/showPrompt (${[...exported].join(', ')})`);

// What App.jsx imports FROM Dialog.jsx (the single `from './Dialog.jsx'` import line).
const imp = appSrc.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/Dialog\.jsx['"]/);
ok(imp, 'App.jsx has an import from ./Dialog.jsx');
const imported = new Set((imp ? imp[1] : '').split(',').map((s) => s.trim()).filter(Boolean));

// Every show*(...) CALL in App.jsx.
const called = new Set([...appSrc.matchAll(/\b(show[A-Za-z]+)\s*\(/g)].map((m) => m[1]));

// Each called helper that Dialog.jsx exports must be imported.
for (const name of called) {
  if (!exported.has(name)) continue; // not a Dialog helper (defensive)
  ok(imported.has(name), `App.jsx imports ${name} before calling it`);
}
ok(called.has('showPrompt'), 'sanity: App.jsx does call showPrompt (the regression site)');

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
