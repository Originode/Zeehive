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
const FILES = ['workApi.js', 'order.js', 'bits.jsx', 'WorkConsole.jsx', 'Board.jsx', 'WorkItemDrawer.jsx',
               'Tickets.jsx', 'Gantt.jsx', 'DeployZee.jsx'].map((f) => `web/src/work/${f}`);
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
// The documented vocabulary, used ONLY while part 1 is still in flight. Once the module is on main
// it is imported for real (it is pure and dependency-free, exactly like hive-status.js — which is
// why prod-asks-console.test.mjs can import that one too) and this list stops being consulted.
const DOCUMENTED = ['queued', 'assigned', 'working', 'blocked', 'review', 'shipping', 'done', 'cancelled'];
let serverKeys = null;
if (existsSync(path(SERVER_FILE))) {
  const mod = await import('../server/src/lib/work-status.js');
  serverKeys = mod.WORK_STATUS_KEYS || Object.keys(mod.WORK_STATUS || {});
  ok(serverKeys.length > 0, `${SERVER_FILE} publishes a status vocabulary (${serverKeys.join(', ')})`);
  // The vocabulary is served, not retyped: GET /api/work-statuses is generated from that module.
  ok(/workStatusVocabulary\(\)/.test(read('server/src/api/routes.js')),
     '/api/work-statuses is generated from that module, so the console can trust it');
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

// ── the drag maths, exercised for real (no browser needed — that is why it is a pure module) ──
// A drag is the board's one genuinely algorithmic moment and the one a static read cannot judge.
const { placement } = await import('../web/src/work/order.js');
const col = [{ id: 'a', sort_order: 1 }, { id: 'b', sort_order: 2 }, { id: 'c', sort_order: 3 }];
ok(placement(col, 'z', 1).sortOrder === 1.5, 'a card dropped between two others takes the MIDPOINT (1.5)');
ok(placement(col, 'z', 0).sortOrder === 0, 'dropped at the top it goes one step BEFORE the head');
ok(placement(col, 'z', 3).sortOrder === 4, 'dropped at the end it goes one step PAST the tail');
ok(placement([], 'z', 0).sortOrder === 0, 'dropped into an empty column it is simply 0');
// Moving a card DOWN its own column: the gap was numbered with the card still in it.
ok(placement(col, 'a', 2).at === 1 && placement(col, 'a', 2).sortOrder === 2.5,
   'a card moved DOWN its own column lands between its new neighbours, not past them (the off-by-one)');
ok(placement(col, 'c', 0).at === 0 && placement(col, 'c', 0).sortOrder === 0,
   'a card moved UP its own column lands above the head');
ok(placement(col, 'z', 99).at === 3, 'an index past the end is clamped, never NaN');
// Missing sort_order (a server that has not filled it in) must not produce NaN.
ok(Number.isFinite(placement([{ id: 'x' }, { id: 'y' }], 'z', 1).sortOrder),
   'a column with no sort_order values still yields a finite number');
// And the board must USE it rather than keeping a second copy of the maths.
ok(/placement\(/.test(read('web/src/work/Board.jsx')) && !/\(a \+ b\) \/ 2/.test(read('web/src/work/Board.jsx')),
   'Board.jsx calls placement() — the maths lives in one place');

// ── the contract seams part 1 spelled out, checked where they are easy to get wrong again ──
const drawer = read('web/src/work/WorkItemDrawer.jsx');
ok(/next_statuses/.test(drawer),
   "the status picker offers the item's OWN next_statuses, not the whole vocabulary");
ok(/vocabOf/.test(read('web/src/work/workApi.js')) && /ticket_kinds/.test(read('web/src/work/workApi.js')),
   'the whole vocabulary (statuses + kinds) is read from /api/work-statuses, kinds included');
ok(/ticketKinds|kinds =/.test(read('web/src/work/Tickets.jsx')),
   'ticket kinds come from that vocabulary, not from a list typed into the console');
// A same-column drag must send sort_order ALONE. Sending parent_id with it was silently dropped by
// the server for a while; both shapes work now, but "the parent did not change" is the honest ask.
const boardMove = board.slice(board.indexOf('const move = useCallback'), board.indexOf('const onDragStart'));
ok(!/parent_id/.test(boardMove), 'a board drag patches status/sort_order only — never parent_id');
ok(/ref/.test(read('web/src/work/Tickets.jsx')),
   'the breakdown editor nests with the API\'s backwards-resolving `ref` handles (one atomic call)');

// ── two defects found by auditing the landed code, pinned so they cannot come back ──
ok(/halfOf/.test(board) && /onDragOver=\{\(e\) => allow\(e, col\.key, halfOf/.test(board),
   'a CARD is itself a drop target (upper half = before it) — not just the 6px gap between cards');
ok(/dlg-overlay/.test(read('web/src/work/WorkConsole.jsx')),
   'Escape while a Dialog is open answers the dialog only — it does not also close the console');
ok(/THE ZEE SEAM/.test(drawer), 'the drawer keeps a named seam for part 3\'s assign-a-zee control');

// ── a real RENDER pass: the cheapest thing that catches a free identifier ──────────────────────
// Static reading cannot see that a component references a name that is not in scope — and vite
// happily BUILDS one (I shipped exactly that bug into this file's filter select while fixing
// something else, and `npm run build` was green). So each screen is server-rendered once with
// react-dom/server over a stubbed fetch: no browser, no DOM library, ~1s. A ReferenceError, a bad
// hook call or a crash on first paint fails here instead of in front of a human.
const smoke = async () => {
  const esbuild = await import('esbuild');
  const { tmpdir } = await import('node:os');
  const { createRequire } = await import('node:module');
  const out = resolve(tmpdir(), 'work-console-smoke.cjs');
  await esbuild.build({
    stdin: {
      contents: `
        const React = require('react');
        const { renderToString } = require('react-dom/server');
        const Board = require('./Board.jsx').default;
        const Tickets = require('./Tickets.jsx').default;
        const Gantt = require('./Gantt.jsx').default;
        const Drawer = require('./WorkItemDrawer.jsx').default;
        const DeployZee = require('./DeployZee.jsx').default;
        module.exports = { React, renderToString, Board, Tickets, Gantt, Drawer, DeployZee };
      `,
      resolveDir: resolve(here, '..', 'web/src/work'),
      loader: 'js',
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: out, jsx: 'automatic',
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' },
  });
  const req = createRequire(out);
  const { React, renderToString, ...screens } = req(out);
  // Every screen renders its shell before any effect resolves, which is the frame a human sees
  // first — so that is the frame this asserts on.
  const statuses = [...server].map((key, i) => ({ key, label: key, order: i, terminal: false }));
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '[]' });
  const html = [
    renderToString(React.createElement(screens.Board, { projectId: 'p', rootId: null, statuses })),
    renderToString(React.createElement(screens.Tickets, { projectId: 'p', statuses, kinds: ['bug'] })),
    renderToString(React.createElement(screens.Gantt, { projectId: 'p', rootId: null })),
    renderToString(React.createElement(screens.Drawer, { itemId: 'i', projectId: 'p', statuses })),
    // The drawer's first frame has no data yet, so the zee seam is rendered directly — BOTH states,
    // because "nobody is on it" and "a zee is on it" are different code paths and the empty one is
    // the one a human meets first.
    renderToString(React.createElement(screens.DeployZee, {
      item: { id: 'i', title: 'an item', xell_id: null }, zee: null, events: [],
    })),
    renderToString(React.createElement(screens.DeployZee, {
      item: { id: 'i', title: 'an item', xell_id: 'x' },
      zee: { slug: 'lively-meadow', hive_status: 'occ-working', hive_status_label: 'working' },
      events: [{ kind: 'assigned', detail: { xell_slug: 'lively-meadow' } }],
    })),
  ].join('');
  return html;
};
try {
  const html = await smoke();
  ok(true, 'every screen renders without throwing (free identifiers, bad hooks, first-paint crashes)');
  // The board's FIRST frame is its loading shell (it has no columns until /api/board answers), so
  // that is what the markup carries — asserting on work-board here would be asserting that the
  // stubbed fetch had already resolved, which is not what a first paint is.
  ok(/loading the board/.test(html), 'the board renders its loading shell on the first frame');
  for (const id of ['work-tickets', 'work-gantt', 'work-drawer']) {
    ok(html.includes(id), `the rendered markup carries ${id}`);
  }
  ok(/deploy a worker/.test(html), 'an unassigned item offers "deploy a worker" on its first frame');
  ok(/lively-meadow/.test(html), 'an assigned item renders its zee chip');
} catch (e) {
  ok(false, `a screen threw while rendering — ${String(e.message).split('\n')[0]}`);
}

// ── the ASSIGN/DEPLOY seam (part 3's verbs, wired into the drawer) ────────────────────────────
// Deploying SPAWNS A REAL ZEE. Three properties are worth a test each, because getting any of them
// wrong costs either tokens or trust.
const deployz = read('web/src/work/DeployZee.jsx');
const dcode = code('web/src/work/DeployZee.jsx');
ok(/<DeployZee[\s/>]/.test(read('web/src/work/WorkItemDrawer.jsx')),
   'the drawer RENDERS the assign/deploy control in its zee field');
ok(/showConfirm/.test(dcode) && /showPrompt/.test(dcode),
   'deploying is confirmed through Dialog.jsx (never a native dialog — it would freeze the SSE stream)');
ok(/SPAWNS A REAL ZEE/.test(deployz),
   'the confirmation says in plain words that it starts a real agent');
ok(/getAssignCandidates/.test(dcode) && !/type="text"[^>]*xell/i.test(dcode),
   'the picker is the server\'s candidate list — never a free-text xell id box');
// The queenzee's tick projects the live hive status onto the card. A UI that ALSO wrote status on a
// timer would fight it, so nothing in the tracker may write status outside a human's own action.
for (const f of ['DeployZee.jsx', 'Board.jsx', 'WorkConsole.jsx']) {
  const src = code(`web/src/work/${f}`);
  ok(!/setInterval|setTimeout\([^)]*status/.test(src),
     `web/src/work/${f} never writes status on a timer (the queenzee tick owns that)`);
}
ok(/xell_id/.test(dcode) && /lastAssignedSlug/.test(dcode),
   'a reaped xell leaves provenance (was: <slug>) instead of a ghost chip');

// ── the board is operable WITHOUT a mouse ─────────────────────────────────────────────────────
// HTML5 drag has no keyboard equivalent, so a board with only a drag is readable and not operable
// for anyone who does not use one. Alt+arrows must produce the SAME move() a drop does — one
// implementation, one set of refusals.
ok(/altKey/.test(board) && /ArrowUp|ArrowDown/.test(board),
   'a card can be moved with the keyboard (Alt + arrows), not only dragged');
ok(/aria-label=/.test(board), 'a card says what it is and how to move it (aria-label)');
// The index mapping that path uses, checked against the same pure maths the drag uses: one slot per
// press, in both directions, with the lifted-card shift already accounted for.
const kcol = [{ id: 'a', sort_order: 1 }, { id: 'b', sort_order: 2 }, { id: 'c', sort_order: 3 }];
ok(placement(kcol, 'a', 0 + 2).at === 1, 'Alt+Down moves a card exactly one slot down (gap = index + 2)');
ok(placement(kcol, 'c', 2 - 1).at === 1, 'Alt+Up moves a card exactly one slot up (gap = index − 1)');
ok(placement(kcol, 'a', 0 + 2).sortOrder === 2.5 && placement(kcol, 'c', 2 - 1).sortOrder === 1.5,
   'and both write a midpoint, exactly as the equivalent drag would');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
