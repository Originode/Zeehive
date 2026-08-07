// BROKEN-PIPE tip on the git graph — when the xource (main checkout) has staged items.
//
// Staged work on main should never happen (landings refuse over a dirty tree; ships build from
// this checkout), but a ship projection / interrupted merge / hand edit can leave the index
// dirty. The graph tip then paints a broken-pipe icon; clicking it opens a proper-sized modal
// with the diff status (clickable → DiffViewer preview), the rogue files (click → preview),
// Clear / Stash / Commit.
//
// Exercised the way this repo does UI: the REAL <GraphPane> rendered with react-dom/server,
// plus source assertions on the modal, DiffViewer wiring, stash/commit routes.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const SRC = { graph: 'web/src/GraphPane.jsx', app: 'web/src/App.jsx', api: 'web/src/api.js',
  fleet: 'server/src/lib/fleet.js', routes: 'server/src/api/routes.js',
  clean: 'server/src/lib/xource-clean.js', diffview: 'server/src/lib/diffview.js',
  viewer: 'web/src/DiffViewer.jsx', css: 'web/src/styles.css' };
const src = Object.fromEntries(Object.entries(SRC).map(([k, f]) => [k, readFileSync(f, 'utf8')]));

const built = [];
const build = (file, tag) => {
  const out = file.replace(/\/([^/]+)$/, `/.${tag}.test-build.mjs`);
  writeFileSync(out, transformSync(readFileSync(file, 'utf8'), { loader: 'jsx', format: 'esm' }).code);
  built.push(out);
  return '../' + out;
};

let graph, React, renderToStaticMarkup;
try {
  graph = await import(build(SRC.graph, 'broken-pipe'));
  React = (await import('react')).default;
  renderToStaticMarkup = (await import('react-dom/server')).renderToStaticMarkup;
} finally {
  for (const f of built) rmSync(f, { force: true });
}

const commits = [
  { hash: 'c1aaaaaa', short: 'c1aaaaa', subject: 'one', parents: [] },
  { hash: 'c2bbbbbb', short: 'c2bbbbb', subject: 'two', parents: ['c1aaaaaa'] },
];
const timeline = { branch: 'master', commits, xells: [], harnesses: [] };
const baseProps = {
  timeline, xells: [], orientation: 'landscape', honeySide: 'a', hexPosRef: { current: {} },
  prodIds: [], expandedId: null, hoverRef: { current: { id: null, commit: null, harness: null } },
  setHover: () => {}, subscribeHover: null, onFlip: () => {},
  projectId: 'proj-1',
};

const render = (xource) => {
  const realErr = console.error;
  console.error = (...a) => { if (!/useLayoutEffect does nothing on the server/.test(String(a[0]))) realErr(...a); };
  try {
    return renderToStaticMarkup(React.createElement(graph.default, { ...baseProps, xource }));
  } finally { console.error = realErr; }
};

// ── 1. the tip icon only when has_staged ─────────────────────────────────────
console.log('\n── broken-pipe icon at the git-graph tip ──');
const cleanHtml = render({ ok: true, clean: true, has_staged: false, staged_count: 0, staged: [], files: [] });
ok(!cleanHtml.includes('data-testid="graph-broken-pipe"'),
   'no broken-pipe icon when the xource index is clean');

const dirtyHtml = render({
  ok: true, clean: false, blocked: true, has_staged: true, staged_count: 2,
  staged: [{ path: 'a.txt', kind: 'staged' }, { path: 'b.txt', kind: 'staged' }],
  files: [
    { path: 'a.txt', kind: 'staged', status: 'modified' },
    { path: 'b.txt', kind: 'staged', status: 'added' },
  ],
  diff: { staged: { files: 2, insertions: 4, deletions: 1, shortstat: '2 files changed' },
          unstaged: { files: 0, insertions: 0, deletions: 0, shortstat: 'no changes' } },
  summary: '2 staged path(s) · 2 uncommitted path(s) — landings/ships are BLOCKED until this is cleaned',
  branch: 'master', main_branch: 'master',
});
ok(dirtyHtml.includes('data-testid="graph-broken-pipe"'),
   'broken-pipe icon renders when has_staged is true');
ok(/Broken pipe/i.test(dirtyHtml) || dirtyHtml.includes('graph-broken-pipe'),
   'the control is labelled as a broken pipe');
ok(dirtyHtml.includes('>2<') || /graph-broken-pipe-n[^>]*>2</.test(dirtyHtml),
   'the staged count rides on the tip icon');
ok(/aria-expanded="false"/.test(dirtyHtml), 'modal starts closed (aria-expanded=false)');
ok(!dirtyHtml.includes('data-testid="xource-staged-overlay"'),
   'the modal is not mounted until the tip is clicked');

// ── 2. wiring: App + fleet + API ────────────────────────────────────────────
console.log('\n── App + fleet + API wiring ──');
ok(/xource=\{fleet\.xource/.test(src.app), 'App passes fleet.xource into GraphPane');
ok(/onXourceChanged=\{refresh\}/.test(src.app), 'and a refresh callback so actions re-read the tip');
ok(/xourceState\(project\.repo_root/.test(src.fleet), 'fleet snapshot includes live xourceState');
ok(/commitXourceStaged/.test(src.clean) && /stashXource/.test(src.clean),
   'lib/xource-clean exports commit + stash');
ok(/export async function xourcePatch/.test(src.diffview), 'diffview exports xourcePatch');
ok(/\/xource\/commit/.test(src.routes) && /\/xource\/stash/.test(src.routes),
   'POST commit and stash are routed');
ok(/\/xource\/diff/.test(src.routes), 'GET xource/diff is routed');
ok(/getXourcePatch/.test(src.api) && /stashXourceNow/.test(src.api) && /commitXourceStaged/.test(src.api),
   'web api.js exposes patch + stash + commit');
ok(/kind === 'xource'/.test(src.viewer) || /kind === \"xource\"/.test(src.viewer)
   || /target\.kind === 'xource'/.test(src.viewer),
   'DiffViewer loads kind:xource via getXourcePatch');
ok(/focusPath/.test(src.viewer), 'DiffViewer honours focusPath for per-file preview');

// ── 3. modal contents (source) ───────────────────────────────────────────────
console.log('\n── modal: size, diffs, stash, clear, commit ──');
ok(/createPortal/.test(src.graph), 'modal is portaled to body (escapes the graph stacking context)');
ok(/xource-modal-overlay/.test(src.graph) && /xource-modal-overlay/.test(src.css),
   'proper-sized overlay modal (not a tip popover)');
ok(/min\(920px/.test(src.css) || /920px/.test(src.css), 'modal is wide enough to work in (~920px)');
ok(/data-testid="xource-staged-pop"/.test(src.graph), 'modal has a testable id');
ok(/data-testid="xource-staged-diffs"/.test(src.graph), 'shows a Diff section');
ok(/data-testid="xource-diff-staged"/.test(src.graph)
   && /data-testid="xource-diff-unstaged"/.test(src.graph)
   && /data-testid="xource-diff-all"/.test(src.graph),
   'staged / unstaged / all diff chips are clickable');
ok(/showDiff/.test(src.graph) && /kind: 'xource'/.test(src.graph),
   'clicking a diff opens DiffViewer with kind:xource');
ok(/focusPath/.test(src.graph) && /xource-file-btn/.test(src.graph),
   'clicking a rogue file opens the preview focused on that path');
ok(/data-testid="xource-staged-clear"/.test(src.graph) && /Clear it/.test(src.graph),
   'has Clear it');
ok(/data-testid="xource-staged-stash"/.test(src.graph) && /Stash it/.test(src.graph),
   'has Stash it');
ok(/data-testid="xource-staged-commit"/.test(src.graph) && /Commit it/.test(src.graph),
   'has Commit it');
ok(/stashXourceNow/.test(src.graph) && /cleanXourceNow/.test(src.graph) && /commitXourceStaged/.test(src.graph),
   'Clear / Stash / Commit call the matching API verbs');

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ broken-pipe tip → proper modal with diff preview + stash');
process.exit(fail ? 1 : 0);
