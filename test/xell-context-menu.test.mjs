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

// ── 2.5 HELD AT THE GATE — the send-'zee land'/'zee ship' rows ────────────────
console.log('\nthe held-gate rows appear only while the gate is holding');
const heldLand = { ...worker, hive_status: 'occ-landRequest' };
const heldShip = { ...worker, hive_status: 'occ-shipRequest' };
const kindsOf = (x, d) => kinds(xellContextMenuItems(x, d));
ok(kindsOf(heldLand, clean).includes('sendLand'),
   'a worker with a held landing (occ-landRequest) is offered “send zee land”');
ok(!kindsOf(heldLand, clean).includes('sendShip'),
   '…and not “send zee ship”');
ok(kindsOf(heldShip, clean).includes('sendShip'),
   'a worker with a held ship (occ-shipRequest) is offered “send zee ship”');
ok(!kindsOf(heldShip, clean).includes('sendLand'),
   '…and not “send zee land”');
ok(!kindsOf(worker, clean).includes('sendLand') && !kindsOf(worker, clean).includes('sendShip'),
   'a worker with nothing held gets neither');
ok(!kindsOf({ ...worker, hive_status: 'occ-landHint' }, clean).includes('sendLand')
   && !kindsOf({ ...worker, hive_status: 'occ-shipHint' }, clean).includes('sendShip'),
   'a HINT is not a held gate — no send row for landHint/shipHint');
ok(!kindsOf({ ...worker, hive_status: 'occ-landHolding' }, clean).includes('sendLand'),
   'a queued landing (occ-landHolding) is not a held gate — the zee must NOT re-push while queued');
ok(!kindsOf({ ...mgr, hive_status: 'occ-landRequest' }, landable).includes('sendLand'),
   'a MANAGER with a held landing gets no “send zee land”');
ok(!kindsOf({ ...worker, is_production: true, hive_status: 'occ-landRequest' }, clean).includes('sendLand'),
   'production gets no “send zee land” even with a held-landing status');
const heldLandMenu = xellContextMenuItems(heldLand, clean);
ok(heldLandMenu[0].kind === 'sendLand',
   'the held-gate row LEADS the menu — the most actionable thing on a held hex');
ok(heldLandMenu.find((it) => it.kind === 'sendLand')?.label === '⬆ Send “zee land” to zee',
   'the row names the exact command (“zee land”) and where it goes (to zee)');

// ── 3. a context menu needs WORDS, not the flower's icon-only labels ──────────
console.log('\nthe menu rows are human-readable');
ok(wm.find((it) => it.kind === 'terminal')?.label === '⌨ Terminal',
   'terminal reads as a word (the flower draws just ⌨)');
ok(wm.find((it) => it.kind === 'pause')?.label === '⏸ Pause', 'pause reads as a word');
ok(wm.find((it) => it.kind === 'nudge')?.label === '💬 Nudge', 'nudge reads as a word');
ok(wm.find((it) => it.kind === 'build')?.label === '🔨 Build',
   'build reads as a word (the flower draws just 🔨)');
ok(wm.find((it) => it.kind === 'env')?.label === '❖ Environment',
   'env reads as a word (the flower draws just ❖)');
ok(wm.find((it) => it.kind === 'message')?.label === '📨 Message',
   'message reads as a word (the flower draws just 📨)');
ok(wm.find((it) => it.kind === 'swap')?.label === '♻ Swap zee',
   'swap reads as a word (the flower draws just ♻)');
ok(wm.find((it) => it.kind === 'directives')?.label === '🧭 Directives',
   'directives is on the menu (and the flower) for every non-prod xell');
ok(wm.find((it) => it.kind === 'done')?.label === '✓ mark done',
   'done carries the stateful full-word label (confirm/mark/clean-up) — the flower draws just ✓/✕');
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

// ── 4.5 the wiring: a held-gate row types the verb through the message door ───
console.log('\nthe held-gate rows type the verb into the live session');
const app = readFileSync('web/src/App.jsx', 'utf8');
ok(/sendXellMessage,/.test(app), 'App imports sendXellMessage (the operator-message door)');
ok(/kind === 'sendLand' \|\| kind === 'sendShip'/.test(app),
   'App dispatches both held-gate kinds in handleFlowerAction');
ok(/text: `zee \$\{verb\}`/.test(app),
   'it sends the literal “zee <verb>” command as the message text');
ok(/r\?\.sent/.test(app), 'and reports the delivery result (sent / not delivered)');
ok(!/sendXellMessage/.test(src), 'HiveCanvas itself never calls the door — the menu only names the verb');

// ── 4.6 RESCUE — a quarantined xell gets the rescue arm (ticket #81) ──────────
console.log('\nthe quarantine decision: rescue vs reap, on the flower and the menu');
const qx = { ...worker, id: 'q', slug: 'q', quarantined_at: '2026-08-01T00:00:00Z', hive_status: 'occ-quarantined' };
const qv = petalVerbs(qx, clean);
const qm = xellContextMenuItems(qx, clean);
const qKinds = Object.values(qv).flat();
ok(qKinds.includes('rescue'), 'a quarantined xell is offered RESCUE on the flower');
ok(kinds(qm).includes('rescue'),
   '…and in the context menu (the menu inherits the flower\'s verb list)');
ok(!qKinds.includes('swap') && !kinds(qm).includes('swap'),
   'SWAP is NOT offered on a quarantined xell — the quarantine guard refuses to dispatch ANY new agent into the cage');
ok(qKinds.includes('done') && kinds(qm).includes('done'),
   'DONE stays — it is the reap arm of the same rescue-or-reap decision');
ok(qm.find((it) => it.kind === 'rescue')?.label === '🛟 Rescue',
   'the rescue row reads as a word (the flower draws just 🛟)');
ok(!kinds(xellContextMenuItems(worker, clean)).includes('rescue')
   && !kinds(xellContextMenuItems({ ...worker, quarantined_at: null }, clean)).includes('rescue'),
   'a clean xell is NOT offered rescue — there is nothing to clear');
ok(/kind === 'rescue'/.test(app) && /rescueXell\(x\.id\)/.test(app),
   'App dispatches kind rescue → rescueXell (the /xells/:id/unquarantine POST)');

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
