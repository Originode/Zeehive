// WORK TRACKER — the CONSOLE side, checked statically.
//
// There is no linter, no browser and no CI runner in this repo, so the only thing standing between
// a wiring mistake and a blank overlay in production is a test that READS THE SOURCE. This one
// guards the five failures that would actually happen here:
//
//   1. A file that does not parse. Every screen under web/src/work/ is JSX; vite would fail the
//      build, but the build is run by a human and this test is run by anyone. Each file is
//      transformed with esbuild (the same parser vite uses) so a syntax error is caught here.
//   2. An import nothing renders. App.jsx importing WorkConsole but never mounting it is the exact
//      bug prod-asks-console.test.mjs was written for, one feature earlier.
//   3. A HARDCODED STATUS LIST. The board's columns must BE `/api/work-statuses`, in its order. A
//      copy of the vocabulary in the browser is a copy that drifts the day someone adds a status —
//      and the board would then silently stop showing that work. So: no status key may appear as a
//      string literal anywhere under web/src/work/, and the only place a key is written down (the
//      `.work-st-<key>` dot colours in styles.css) must be in LOCKSTEP with the server's list.
//   4. window.confirm / alert / prompt. They park the browser's event loop, which freezes the SSE
//      stream and the hive behind the overlay — Dialog.jsx exists precisely because of that, and a
//      "delete this subtree" confirmation is the most tempting place to reach for the native one.
//   5. A dialog helper called but not imported (the app-dialog-imports.test.mjs bug class: a free
//      identifier at module scope that vite happily builds and the browser throws on).
//
// Plus the two contract seams this part was cut along: the `work` SSE event type in api.js (live
// updates), and Gantt.jsx keeping its exported name and props so part 4 drops in without touching
// WorkConsole.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { transformSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const path = (p) => resolve(here, '..', p);
const read = (p) => readFileSync(path(p), 'utf8');
// The same source with its COMMENTS stripped. Two checks below hunt for text that must not appear
// in the CODE (a hardcoded status key, a native window.confirm) — and this repo's files carry long
// WHY headers that legitimately NAME both, because explaining the rule is half of keeping it.
// Judging prose as if it were code is how a header that documents a rule fails the test for it.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. the files exist and parse ──
const FILES = ['workApi.js', 'bits.jsx', 'WorkConsole.jsx', 'Board.jsx', 'WorkItemDrawer.jsx',
               'Tickets.jsx', 'Gantt.jsx'].map((f) => `web/src/work/${f}`);
for (const f of FILES) {
  const there = existsSync(path(f));
  ok(there, `${f} exists`);
  if (!there) continue;
  let parsed = true; let why = '';
  try { transformSync(read(f), { loader: f.endsWith('.jsx') ? 'jsx' : 'js', jsx: 'automatic' }); }
  catch (e) { parsed = false; why = ` — ${String(e.message).split('\n')[0]}`; }
  ok(parsed, `${f} parses${why}`);
}

// Every new file carries the repo's WHY header — a tracker nobody can explain is a tracker nobody
// can change.
for (const f of FILES) {
  if (!existsSync(path(f))) continue;
  const head = read(f).split('\n').slice(0, 40).join('\n');
  ok(/\/\/ [^\n]{40,}/.test(head), `${f} opens with a WHY comment`);
}

// ── 2. App.jsx wires it up (import AND render), plus the button ──
const app = read('web/src/App.jsx');
ok(/import\s+WorkConsole\s+from\s+['"]\.\/work\/WorkConsole\.jsx['"]/.test(app), 'App.jsx imports WorkConsole');
ok(/<WorkConsole[\s/>]/.test(app), 'App.jsx RENDERS <WorkConsole> (an import nothing renders is the old bug)');
ok(/data-testid="work-btn"/.test(app), 'App.jsx has the ▦ work button (data-testid="work-btn")');
ok(/projectId=\{[^}]*\}[\s\S]{0,120}projectName=/.test(app.slice(app.indexOf('<WorkConsole'))),
   'the console is given projectId + projectName');

// ── the SSE seam: `work` must be a type subscribe() listens for ──
const api = read('web/src/api.js');
const types = api.match(/for \(const type of \[([^\]]*)\]\)/);
ok(!!types && /'work'/.test(types[1]), "api.js subscribe() listens for the 'work' event type");
ok(/subscribe/.test(read('web/src/work/WorkConsole.jsx')), 'WorkConsole subscribes to the SSE stream');

// ── 3. the status vocabulary is the SERVER'S, not a copy ──
const board = read('web/src/work/Board.jsx');
ok(/getWorkStatuses/.test(board), 'Board.jsx reads its columns from /api/work-statuses (getWorkStatuses)');
ok(/\/api\/work-statuses/.test(read('web/src/work/workApi.js')), 'workApi.js calls /api/work-statuses');

// The server's list — the one authority. Part 1 owns it; until it lands, the CSS keys below are
// checked against the documented vocabulary instead, and this test says which it used.
const SERVER_FILE = 'server/src/lib/work-status.js';
const DOCUMENTED = ['queued', 'assigned', 'working', 'blocked', 'review', 'shipping', 'done', 'cancelled'];
let serverKeys = null;
if (existsSync(path(SERVER_FILE))) {
  const src = read(SERVER_FILE);
  serverKeys = [...new Set([...src.matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]))];
  if (!serverKeys.length) serverKeys = [...new Set([...src.matchAll(/'([a-z_]+)'\s*:/g)].map((m) => m[1]))];
  ok(serverKeys.length > 0, `${SERVER_FILE} publishes a status vocabulary (${serverKeys.join(', ')})`);
} else {
  console.log(`  · ${SERVER_FILE} not landed yet — checking against the documented vocabulary`);
  serverKeys = DOCUMENTED;
}
const server = new Set(serverKeys);

// 3a. the dot colours in styles.css are exactly the server's keys — no more, no fewer.
const css = read('web/src/styles.css');
const fenceAt = css.indexOf('══ WORK TRACKER');
ok(fenceAt > 0, 'styles.css carries the fenced WORK TRACKER section');
const fence = css.slice(fenceAt);
ok(!/\.work-/.test(css.slice(0, fenceAt)), 'every .work- selector lives inside that one fenced section');
const cssKeys = new Set([...fence.matchAll(/\.work-st-([a-z_]+)/g)].map((m) => m[1]));
for (const k of cssKeys) ok(server.has(k), `.work-st-${k} is a real server status key`);
for (const k of server) ok(cssKeys.has(k), `status "${k}" has a dot colour in styles.css`);

// 3b. NO status key is written down in the JS/JSX at all — they come from the API, always.
const workDir = 'web/src/work';
for (const f of readdirSync(path(workDir))) {
  const src = code(`${workDir}/${f}`);
  const literals = [...src.matchAll(/'([A-Za-z_]+)'|"([A-Za-z_]+)"/g)].map((m) => m[1] || m[2]);
  const leaked = [...new Set(literals.filter((s) => server.has(s)))];
  ok(!leaked.length, `${workDir}/${f} hardcodes no status key${leaked.length ? ` (found: ${leaked.join(', ')})` : ''}`);
}

// ── 4. no native dialogs anywhere in the tracker ──
for (const f of readdirSync(path(workDir))) {
  const src = code(`${workDir}/${f}`);
  const bad = /(^|[^.\w])(window\.)?(confirm|alert|prompt)\s*\(/m.exec(src.replace(/show(Confirm|Alert|Prompt)\s*\(/g, 'X('));
  ok(!bad, `${workDir}/${f} uses Dialog.jsx, not window.confirm/alert/prompt`);
}

// ── 5. every Dialog helper called is imported (the free-identifier bug class) ──
const dialogSrc = read('web/src/Dialog.jsx');
const exported = new Set([...dialogSrc.matchAll(/export\s+function\s+(show[A-Za-z]+)/g)].map((m) => m[1]));
for (const f of readdirSync(path(workDir))) {
  const src = read(`${workDir}/${f}`);
  const imported = new Set((src.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*Dialog\.jsx['"]/)?.[1] || '')
    .split(',').map((s) => s.trim()));
  for (const c of new Set([...src.matchAll(/\b(show[A-Za-z]+)\s*\(/g)].map((m) => m[1]))) {
    if (!exported.has(c)) continue;
    ok(imported.has(c), `${workDir}/${f} imports the ${c} it calls`);
  }
}
ok(/showConfirm/.test(read('web/src/work/WorkItemDrawer.jsx')),
   'deleting a subtree asks for confirmation (showConfirm), and says how many go with it');
ok(/descendant/i.test(read('web/src/work/WorkItemDrawer.jsx')), 'the delete confirmation counts the descendants');

// ── the part-4 seam: Gantt keeps its name and its props ──
const gantt = read('web/src/work/Gantt.jsx');
ok(/export default function Gantt\(\s*\{\s*projectId,\s*rootId\s*\}/.test(gantt),
   'Gantt.jsx exports `Gantt({ projectId, rootId })` — part 4 drops in without touching WorkConsole');
ok(/<Gantt\s+projectId=\{[^}]*\}\s+rootId=\{[^}]*\}/.test(read('web/src/work/WorkConsole.jsx')),
   'WorkConsole passes exactly those two props to the timeline tab');

// ── the refusal sentence is what the user sees ──
ok(/body\.error|body && body\.error/.test(read('web/src/work/workApi.js')),
   "workApi throws the server's sentence (body.error), not a bare status");
ok(/err\.message \|\| err|message \|\| err/.test(read('web/src/work/bits.jsx')),
   'the shared error line prints that sentence verbatim');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
