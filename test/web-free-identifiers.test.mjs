// WEB FREE-IDENTIFIER test — every name the console USES must be DECLARED somewhere it can see.
//
// The bug this exists for is always the same shape, and it has now shipped four times:
//
//   • fe2f329 — App.jsx called showConfirm without importing it: every confirm-guarded button threw.
//   • the "Mark done does not seem to mark done" report — App.jsx called showPrompt, unimported.
//   • 36ecd57 — Board.jsx wired `onKeyDown={onKey}` on a work card, but `onKey` was neither a prop
//     of Card nor passed by the board. The FIRST card React rendered threw
//     `ReferenceError: onKey is not defined`, React unwound the tree, and the work board was a
//     blank screen for every human who opened it. That is the report this test was written from.
//   • b337b16 — a refactor lifted `legalNext` out of WorkItemDrawer.jsx and deleted `fmtWhen` with
//     it, leaving the call: the item drawer's history threw the same ReferenceError on open.
//
// WHY a test and not a linter: there is no linter, no CI runner and no browser in this repo, and
// `vite build` does NOT flag a free identifier — it is legal JavaScript (a lookup on the global
// object) right up until the browser evaluates it. So the build is green, the bundle ships, and the
// screen is blank. app-dialog-imports.test.mjs guards exactly one flavour of this (Dialog helpers in
// App.jsx); this one generalises it to EVERY name in EVERY file under web/src.
//
// HOW: @babel/parser (already here, via @vitejs/plugin-react) parses each file, and @babel/traverse's
// own scope analysis reports the Program scope's `globals` — the references it could not bind to any
// declaration, import, parameter or function in the file. Anything left that is not a real global
// (a JS builtin, a browser API) is a name that does not exist at runtime.
//
// A file may of course use `window`, `fetch`, `Math`… so the allow-list is Babel's own globals data
// plus the lowercase browser names it does not carry. If a legitimate global is missing, ADD IT
// HERE — do not delete the check. The list being explicit is the point: it is short, and every
// entry is a thing the browser really provides.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default || _traverse;
const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'web', 'src');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── what genuinely exists at runtime ─────────────────────────────────────────────────────────
// Babel ships the ECMAScript builtins and the capitalised browser constructors; the lowercase
// browser surface (window, fetch, timers, …) it does not, so it is written out here.
const babelGlobals = (p) => require_(`@babel/helper-globals/data/${p}`);
const BROWSER_LOWER = [
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'self', 'top', 'parent',
  'frames', 'localStorage', 'sessionStorage', 'console', 'fetch', 'crypto', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'queueMicrotask',
  'structuredClone', 'matchMedia', 'getComputedStyle', 'getSelection', 'scrollTo', 'scrollBy',
  'open', 'close', 'postMessage', 'atob', 'btoa', 'alert', 'confirm', 'prompt', 'globalThis',
];
const GLOBALS = new Set([
  ...babelGlobals('builtin-lower.json'), ...babelGlobals('builtin-upper.json'),
  ...babelGlobals('browser-upper.json'), ...BROWSER_LOWER,
]);
ok(GLOBALS.has('Math') && GLOBALS.has('window') && GLOBALS.has('ResizeObserver'),
   'the allow-list is loaded (builtins + browser globals)');
// It must NOT be a blanket pass: the names the regressions used have to be catchable.
ok(!GLOBALS.has('onKey') && !GLOBALS.has('fmtWhen') && !GLOBALS.has('showConfirm'),
   'and it does not accidentally allow the names that actually broke (onKey, fmtWhen, showConfirm)');

// ── every source file under web/src ──────────────────────────────────────────────────────────
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(e)) files.push(p);
  }
})(SRC);
ok(files.length > 20, `${files.length} source files under web/src to check`);

const freeNamesIn = (src) => {
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx'] });
  let names = [];
  traverse(ast, { Program(path) { names = Object.keys(path.scope.globals); path.stop(); } });
  return names.filter((n) => !GLOBALS.has(n));
};

// ── the check itself proves it can FAIL ──────────────────────────────────────────────────────
// A green test that cannot go red is decoration. These are the two regressions, verbatim.
ok(freeNamesIn('const C = ({ onOpen }) => <b onKeyDown={onKey} onClick={onOpen} />;').includes('onKey'),
   'a handler referenced but never declared/passed is caught (the Board.jsx onKey regression)');
ok(freeNamesIn("import { fmtDay } from './bits.jsx';\nexport const E = (ev) => fmtWhen(ev.ts);")
     .includes('fmtWhen'),
   'a helper whose definition was refactored away is caught (the WorkItemDrawer fmtWhen regression)');
ok(freeNamesIn('const a = 1; function f(b) { return a + b + Math.max(1, 2); }\nexport { f };').length === 0,
   'and ordinary code — locals, params, builtins — is not flagged');

console.log('\n── web/src ──');
for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  let free = null; let why = '';
  try { free = freeNamesIn(readFileSync(f, 'utf8')); }
  catch (e) { why = ` — did not parse: ${String(e.message).split('\n')[0]}`; }
  ok(free !== null && free.length === 0,
     free && free.length ? `${rel} uses undeclared: ${free.join(', ')}` : `${rel}${why}`);
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
