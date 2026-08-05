// THE XELL RIGHT-CLICK CONTEXT MENU — the honeycomb's actions without opening the flower.
//
// A xell's actions live on its expanded bloom (the flower). This feature lets a human right-click a
// hexagon and get the SAME actions in a context menu, so the flower doesn't have to open every time.
//
// The critical design rule is that the two surfaces must not drift: the menu is built from the exact
// verb list the flower draws (petalVerbs), and dispatches through the same onAction handler. There is
// no linter here, so — like manager-hexagon.test.mjs — the decisions that are pure functions are run
// on the REAL module (esbuild-transformed), and the wiring is asserted against the source text.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const SRC = 'web/src/hive/HiveCanvas.jsx';
const src = readFileSync(SRC, 'utf8');
const css = readFileSync('web/src/styles.css', 'utf8');
const tmp = 'web/src/hive/.xell-context-menu.test-build.mjs';
writeFileSync(tmp, transformSync(src, { loader: 'jsx', format: 'esm' }).code);
let mod;
try { mod = await import('../' + tmp); } finally { rmSync(tmp, { force: true }); }
const { xellContextMenuItems, petalVerbs } = mod;

const clean = { ahead: 0, behind: 0, files: 0, insertions: 0, deletions: 0, dirty: 0 };
const landable = { ...clean, ahead: 2, files: 3, insertions: 9, deletions: 1 };
const shippable = { ...clean };
const worker = {
  id: 'w', slug: 'w', zee_type: 'worker', branch: 'spinoff/w', head_commit: 'feedface0000',
  hive_status: 'occ-working', status: 'claimed', task_id: 't2',
  viewer_kind: 'ssh-terminal', viewer_url: 'ssh://w',
  stack: [{ role: 'db', name: 'db_w', health: 'up' }, { role: 'server', name: 'srv_w', health: 'up' }],
};
const mgr = { ...worker, id: 'M', slug: 'wise-cove', zee_type: 'manager' };

// ── 1. the menu IS the flower's action list (one source of truth) ─────────────
console.log('\nthe context menu reuses the flower\'s verb list');
const kinds = (items) => items.map((it) => it.kind);
const wv = petalVerbs(worker, clean);
const wm = xellContextMenuItems(worker, clean);
for (const k of Object.values(wv).flat()) {
  ok(wm.some((it) => it.kind === k),
     `every flower verb appears in the menu (${k})`);
}
ok(wm.length > Object.values(wv).flat().length,
   'and the menu is strictly richer — it adds the diff-petal viewers');
ok(kinds(wm).includes('owndiff') && kinds(wm).includes('srcdiff'),
   `a worker is offered the two diff viewers first (${kinds(wm).slice(0, 2).join(', ')})`);

// ── 2. it does NOT re-type petalVerbs' rules — it calls it ────────────────────
console.log('\nthe menu inherits the flower\'s refusals');
const wl = xellContextMenuItems({ ...worker, is_production: true }, clean);
ok(wl.length === 1 && wl[0].kind === 'srcdiff',
   `production keeps ONLY the read-only source diff (${kinds(wl).join(',')}) — no dead action buttons`);
const ml = xellContextMenuItems(mgr, landable);
ok(!['pull', 'land', 'pr'].some((k) => kinds(ml).includes(k)),
   `a MANAGER gets no pull/land/PR, exactly like the flower (${kinds(ml).join(',')})`);
ok(!kinds(ml).includes('owndiff') && !kinds(ml).includes('srcdiff'),
   'and no diff viewers either — a manager\'s petals 5/6 are CREW and PROD·AGE, not diffs');
ok(kinds(ml).includes('build') && kinds(ml).includes('done'),
   `but keeps the verbs that DO work on a manager (${kinds(ml).join(',')})`);
ok(!kinds(ml).includes('ship'),
   'and unlanded work still hides ship, exactly as the flower does');
ok(kinds(xellContextMenuItems(mgr, shippable)).includes('ship'),
   'a landed+clean manager is offered ship — ship is deliberately NOT blocked for a manager');

// ── 3. a context menu needs WORDS, not the flower's icon-only labels ──────────
console.log('\nthe menu rows are human-readable');
ok(wm.find((it) => it.kind === 'terminal')?.label === '⌨ Terminal',
   'terminal reads as a word (the flower draws just ⌨)');
ok(wm.find((it) => it.kind === 'pause')?.label === '⏸ Pause', 'pause reads as a word');
ok(wm.find((it) => it.kind === 'nudge')?.label === '💬 Nudge', 'nudge reads as a word');
ok(wm.find((it) => it.kind === 'build')?.label === '🔨 build', 'build keeps its flower label');
ok(wm.find((it) => it.kind === 'done')?.label === '✓ mark done',
   'done carries the stateful label (confirm/mark/clean-up), the same string the flower draws');
ok(wm.find((it) => it.kind === 'done')?.tone === 'danger', 'done is marked destructive (red row)');
ok(wm.find((it) => it.kind === 'pause')?.tone === 'danger', 'pause is marked destructive too');

// ── 4. the canvas wiring: right-click a hex → menu, click a row → onAction ────
console.log('\nthe honeycomb opens and dispatches the menu');
ok(/const hx = hitHex\(wx, wy\);/.test(src) && /setCtxXell\(\{ x: e\.clientX, y: e\.clientY, id: hx\.id \}\)/.test(src),
   'a right-click on a hex opens the xell context menu at the cursor');
ok(/onContextMenu=\{onContextMenu\}/.test(src), 'the canvas owns the contextmenu event');
ok(/onAction\?\.\(it\.kind, x, diff\)/.test(src),
   'clicking a menu row dispatches through the SAME onAction the flower buttons use');
ok(/xellContextMenuItems\(x, diff\)/.test(src), 'the menu rows come from the shared item builder');
ok(/className="ctxmenu/.test(src) && /\.ctxmenu/.test(css),
   'the menu reuses the existing .ctxmenu styling (it reads as a context menu, not a new widget)');
ok(/ctxitem-danger/.test(css), 'and the destructive rows reuse the red item styling');

// ── 5. closing: one menu at a time, close on outside interaction ──────────────
console.log('\nthe menu closes like the container menu');
ok(/setCtxXell\(null\); +\/\/ one menu at a time/.test(src),
   'opening a container menu first closes the xell menu (never two menus stacked)');
ok(/document\.addEventListener\('click', close\)/.test(src) && /'Escape'/.test(src),
   'outside click and Escape both close it, like the container menu in App.jsx');
ok(/if \(ctxXell && e\.button === 0\) setCtxXell\(null\);/.test(src),
   'a left-press on the canvas closes it (but a right-press does NOT — that is what opened it)');
ok(/if \(e\.button !== 0\) return; +\/\/ a RIGHT release is the context menu's/.test(src),
   'and a right RELEASE is never a click — opening the menu must not also expand the hexagon');

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
