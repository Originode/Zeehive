// DIRECTIVES IN THE CONSOLE — a human can read the manager⇄worker conversation.
//
// A manager tells a worker what to do with `zee say` (kind='directive'); the worker answers with
// `zee report`. Until this feature the only reader was the worker's own `zee inbox` — a human
// watching the fleet could not see what a manager had directed a worker to do. This proves the
// console surface: the flower offers a 🧭 button on any xell that is part of a manager⇄worker
// conversation, clicking it opens a read-only panel, and the panel RENDERS the rows.
//
// The panel's body is a pure function of its props (DirectivesBody — the fetch lives in the parent,
// exactly the split Board.jsx makes for its card), so it is rendered with react-dom/server and the
// markup read back. The flower verb is asserted through the REAL petalVerbs (the same esbuild import
// trick the manager-hexagon test uses), and the wiring (state, handler, route) is asserted against
// the source text.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const require_ = createRequire(import.meta.url);

const SRC = { canvas: 'web/src/hive/HiveCanvas.jsx', directives: 'web/src/Directives.jsx', app: 'web/src/App.jsx', routes: 'server/src/api/routes.js', fleet: 'server/src/lib/fleet.js' };
const src = Object.fromEntries(Object.entries(SRC).map(([k, f]) => [k, readFileSync(f, 'utf8')]));

// ── 1. the flower verb: EVERY non-prod xell gets 🧭 (its own brief + any conversation) ──
// The panel leads with the xell's OWN directive (task_text); the manager⇄worker thread is secondary.
// Hiding 🧭 on unmanaged workers made the button look missing on most hexes — and the context menu
// reuses petalVerbs, so both surfaces must offer it.
let mod;
const tmp = 'web/src/hive/.directives.test-build.mjs';
try {
  writeFileSync(tmp, transformSync(src.canvas, { loader: 'jsx', format: 'esm' }).code);
  mod = await import('../' + tmp);
} finally { rmSync(tmp, { force: true }); }
const { petalVerbs, xellTooltipParts, xellContextMenuItems } = mod;

const base = { stack: [{ role: 'server', name: 's', health: 'up' }], viewer_kind: 'ssh-terminal', viewer_url: 'ssh://x' };
const managed = { ...base, slug: 'alpha', zee_type: 'worker', manager_slug: 'wise-cove' };
const unmanaged = { ...base, slug: 'solo', zee_type: 'worker', manager_slug: null };
const mgr = { ...base, slug: 'wise-cove', zee_type: 'manager' };

const kinds = (x) => Object.values(petalVerbs(x, null)).flat();
const menuKinds = (x) => xellContextMenuItems(x, null).map((it) => it.kind);
ok(kinds(managed).includes('directives'), `a worker with a manager is offered 🧭 directives (${kinds(managed).join(',')})`);
ok(kinds(mgr).includes('directives'), `a manager is offered 🧭 directives (${kinds(mgr).join(',')})`);
ok(kinds(unmanaged).includes('directives'),
   `an unmanaged worker is ALSO offered 🧭 — every xell has a brief (${kinds(unmanaged).join(',')})`);
ok(menuKinds(unmanaged).includes('directives') && menuKinds(managed).includes('directives')
   && menuKinds(mgr).includes('directives'),
   'and the right-click context menu carries 🧭 for the same xells (one source of truth)');
ok(!kinds({ ...base, is_production: true }).length, 'production still gets no flower buttons at all');

// the HOVER TOOLTIP every xell gets — directive + status, pure
const tt = xellTooltipParts({ ...managed, slug: 'alpha', task_text: '# Audit the queues\nThen fix them.',
  hive_status_label: 'working' });
ok(tt.head === 'alpha' && tt.role === 'worker' && tt.manager === false,
   'a worker tooltip names it and marks it a worker');
ok(tt.directive === 'Audit the queues', 'and carries the FIRST line of its directive (the brief it was given)');
ok(tt.status === 'working', 'and its hive status label');
const ttMgr = xellTooltipParts({ ...mgr, slug: 'wise-cove', task_text: 'Direct the crew', hive_status_label: 'awaiting a human' });
ok(ttMgr.role === '⬢ manager' && ttMgr.manager === true, 'a manager tooltip marks the manager');
ok(ttMgr.directive === 'Direct the crew' && ttMgr.status === 'awaiting a human',
   'and shows its directive and status too');
ok(xellTooltipParts({ ...base, slug: 'solo', task_text: null, hive_status_label: null, status: 'idle' }).directive === null
   && xellTooltipParts({ ...base, slug: 'solo', task_text: null, hive_status_label: null, status: 'idle' }).status === 'idle',
   'a xell with no brief yields no directive line, and the status falls back to the raw lifecycle');
ok(/const parts = xellTooltipParts\(xell\)/.test(src.canvas)
   && /showXellTooltip\(xellOf\(hx\.id\), e\)/.test(src.canvas),
   'the tooltip is built from the pure parts and shown on hex hover — the wiring is in the canvas');

// ── 2. the panel RENDERS the xell's OWN directive and the conversation ───────
let React, renderToStaticMarkup, DirectivesBody, DirectiveBlock;
const built = [];
try {
  const out = 'web/src/.directives.test-build.mjs';
  writeFileSync(out, transformSync(src.directives, { loader: 'jsx', format: 'esm' }).code);
  built.push(out);
  const d = await import('../' + out);
  DirectivesBody = d.DirectivesBody;
  DirectiveBlock = d.DirectiveBlock;
  React = require_('react');
  renderToStaticMarkup = require_('react-dom/server').renderToStaticMarkup;
} finally { for (const f of built) rmSync(f, { force: true }); }

// the thing that tells one manager apart from another: its directive, in FULL
const dirHtml = renderToStaticMarkup(React.createElement(DirectiveBlock,
  { directive: 'Manage the Omnibiz crew, one well-briefed worker at a time.\nShip the release.' }));
ok(/dir-directive/.test(dirHtml), 'the directive is rendered in its own block');
ok(/Manage the Omnibiz crew, one well-briefed worker at a time\./.test(dirHtml)
   && /Ship the release\./.test(dirHtml), 'and the FULL text is readable (both lines)');
ok(renderToStaticMarkup(React.createElement(DirectiveBlock, { directive: '  \n' })).includes('dir-none'),
   'a blank brief states that instead of an empty box');
ok(renderToStaticMarkup(React.createElement(DirectiveBlock, { directive: null })).includes('dir-none'),
   'a manager with no brief on record says so');

const msgs = [
  { id: 'm1', from_xell_id: 'M', from: 'wise-cove', to_xell_id: 'w1', to: 'alpha', kind: 'directive',
    body: 'scope it to the console only', at: '2026-07-29T10:00:00Z', delivered: true, read_at: '2026-07-29T10:05:00Z' },
  { id: 'm2', from_xell_id: 'w1', from: 'alpha', to_xell_id: 'M', to: 'wise-cove', kind: 'report',
    body: 'blocked on a decision', at: '2026-07-29T11:00:00Z', delivered: false, read_at: null },
];
let html = '';
let threw = null;
try {
  html = renderToStaticMarkup(React.createElement(DirectivesBody, { msgs, xellId: 'w1' }));
} catch (e) { threw = e; }
ok(!threw, `the directives body renders without throwing${threw ? ` — ${threw.message}` : ''}`);
ok(/dir-list/.test(html) && /dir-row/.test(html), 'renders a list of message rows');
ok(/🐝 directive/.test(html), 'a directive carries its kind badge');
ok(/scope it to the console only/.test(html), 'and the directive body is readable');
ok(/← wise-cove/.test(html), 'an incoming row shows the sender (the manager who directed it)');
ok(/→ wise-cove/.test(html), 'an outgoing row shows who the report went to');
ok(/✓ delivered/.test(html) && /stored/.test(html), 'delivered and stored are told apart');
ok(/read/.test(html), 'a read message says so');
ok(renderToStaticMarkup(React.createElement(DirectivesBody, { msgs: [], xellId: 'w1' })).includes('dir-empty'),
   'an empty conversation states that instead of a blank panel');

// ── 3. the wiring: state, handler, render, route ──────────────────────────────
ok(/import Directives from '\.\/Directives\.jsx'/.test(src.app), 'App imports the Directives panel');
ok(/const \[directivesXell, setDirectivesXell\] = useState/.test(src.app), 'App holds the panel state');
ok(/kind === 'directives'[\s\S]{0,80}setDirectivesXell/.test(src.app), 'the flower’s 🧭 verb opens the panel');
ok(/<Directives xell=\{directivesXell\}/.test(src.app), 'the panel is rendered when opened');
ok(/messagesForXell/.test(src.routes) && /xells\/:id\/messages/.test(src.routes),
   'the server exposes GET /api/xells/:id/messages for the panel to read');
ok(/AS task_text/.test(src.fleet), 'the fleet read model carries each xell\'s own directive (task_text)');
ok(/prompt_text FROM task/.test(src.fleet) && /task_text/.test(src.directives),
   'the panel reads the directive from the fleet row — one field, two ends');

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);
