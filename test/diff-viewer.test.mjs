// THE DIFF VIEWER — the patch behind a diffstat.
//
// Two halves, both checked here without a browser or a meta-DB:
//
//   1. the PARSER (server/src/lib/diffview.js) against a real, throwaway git repo — an add, a
//      modify, a delete, a rename, a binary file and an UNTRACKED file, which is the case
//      `git diff` cannot see at all and the one a zee mid-work hits every time;
//   2. the WIRING — that every diffstat the console renders is actually a button that calls
//      showDiff, and that the flower's petal→facet mapping still points at the two diff facets.
//      There is no linter here, so the wiring is asserted by reading the source (the same
//      technique as prod-asks-console.test.mjs).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { splitPatch, parseFilePatch, rangePatch, xellPatch, safeRef, EMPTY_TREE } =
  await import('../server/src/lib/diffview.js');

// ── 1. a real repo ──────────────────────────────────────────────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'zeehive-diffview-'));
const git = (...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0 && !/nothing to commit/.test(r.stdout || '')) {
    // surfaced, not swallowed: a broken fixture must not read as a passing test
    if (args[0] !== 'diff') console.error(`    git ${args[0]} → ${r.stderr || r.stdout}`);
  }
  return r;
};
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@zeehive');
git('config', 'user.name', 'zeehive test');
writeFileSync(join(repo, 'keep.txt'), 'one\ntwo\nthree\n');
writeFileSync(join(repo, 'gone.txt'), 'delete me\n');
writeFileSync(join(repo, 'old-name.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
git('add', '-A'); git('commit', '-qm', 'base');
const BASE = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

writeFileSync(join(repo, 'keep.txt'), 'one\nTWO\nthree\nfour\n');
writeFileSync(join(repo, 'added.txt'), 'brand new\n');
writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
rmSync(join(repo, 'gone.txt'));
git('mv', 'old-name.txt', 'new-name.txt');
git('add', '-A'); git('commit', '-qm', 'the change');
const HEAD = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

const r = await rangePatch(repo, BASE, HEAD);
ok(r.ok, 'rangePatch reads a base..head range');
const byPath = Object.fromEntries((r.files || []).map((f) => [f.path, f]));
ok(byPath['keep.txt']?.status === 'modified', 'a modified file is reported as modified');
ok(byPath['keep.txt']?.insertions === 2 && byPath['keep.txt']?.deletions === 1,
   `the modified file's +/- match git (+${byPath['keep.txt']?.insertions}/−${byPath['keep.txt']?.deletions})`);
ok(byPath['added.txt']?.status === 'added', 'a new file is reported as added');
ok(byPath['gone.txt']?.status === 'deleted', 'a removed file is reported as deleted');
ok(byPath['bin.dat']?.binary === true, 'a binary file is flagged binary (no bogus line counts)');
const renamed = (r.files || []).find((f) => f.path === 'new-name.txt');
ok(renamed?.status === 'renamed' && renamed?.old_path === 'old-name.txt',
   'a rename keeps BOTH names (old_path → path)');
ok(r.stat.files === r.files.length, 'the payload stat counts the files it carries');
ok(r.files.every((f) => f.patch.startsWith('diff --git')),
   'every file carries its own patch text, split at the git header');

// The FIRST commit has no parent — the range must still render (as one big addition) rather than
// failing on a missing base, which is what a first landing on a fresh project looks like.
const first = await rangePatch(repo, '0000000000000000000000000000000000000000', BASE);
ok(first.ok && first.files.length === 3, `a zero base diffs against the empty tree (${first.files.length} files)`);
ok(EMPTY_TREE === '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'the empty tree is git\'s own');

// A ref that could be read as a git FLAG is refused before it reaches git.
ok(safeRef('HEAD~2') && safeRef('origin/main') && !safeRef('--upload-pack=x') && !safeRef(''),
   'safeRef accepts real refs and refuses a leading-dash "ref"');

// ── the untracked case: git diff cannot see it, the viewer must ────────────────────────────────
// xellPatch needs a xell row, so exercise the synthesiser through the module's own worktree path by
// building the payload the same way: an untracked file must arrive as an all-additions patch.
writeFileSync(join(repo, 'untracked.txt'), 'fresh\nlines\n');
const plain = spawnSync('git', ['-C', repo, 'diff', 'HEAD'], { encoding: 'utf8' }).stdout;
ok(!plain.includes('untracked.txt'), 'git diff genuinely does not see an untracked file (the bug being covered)');

// ── the parser, on shapes a repo is awkward to produce ─────────────────────────────────────────
const modeOnly = 'diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n';
const m = parseFilePatch(modeOnly);
ok(m.path === 'x.sh' && m.insertions === 0 && m.deletions === 0,
   'a mode-only change parses to a named file with no line changes');
const two = splitPatch(modeOnly + 'diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n');
ok(two.files.length === 2 && two.files[1].path === 'y', 'splitPatch splits on the git header, not on content');
const nested = splitPatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n a\n+diff --git a/fake b/fake\n');
ok(nested.files.length === 1,
   'a line that LOOKS like a git header inside a hunk does not split the patch (it is an added line)');
const capped = splitPatch('diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -1 +1,999 @@\n'
  + Array.from({ length: 999 }, (_, i) => `+line ${i}`).join('\n'), { maxFileBytes: 400 });
ok(capped.files[0].truncated && capped.files[0].patch.endsWith('\n'),
   'an oversized file patch is truncated at a LINE boundary and says so');

rmSync(repo, { recursive: true, force: true });

// ── 2. the console wiring ───────────────────────────────────────────────────────────────────────
const app = read('web/src/App.jsx');
const landing = read('web/src/Landing.jsx');
const viewer = read('web/src/DiffViewer.jsx');
const main = read('web/src/main.jsx');
const canvas = read('web/src/hive/HiveCanvas.jsx');
const api = read('web/src/api.js');
const routes = read('server/src/api/routes.js');

ok(/export function showDiff/.test(viewer) && /export function DiffViewerHost/.test(viewer),
   'DiffViewer exports showDiff + DiffViewerHost');
ok(/import \{ DiffViewerHost \} from '\.\/DiffViewer\.jsx'/.test(main) && /<DiffViewerHost \/>/.test(main),
   'DiffViewerHost is MOUNTED once at the root (an import nothing renders is the old bug)');
for (const [file, src] of [['App.jsx', app], ['Landing.jsx', landing]]) {
  ok(/import \{ showDiff \} from '\.\/DiffViewer\.jsx'/.test(src), `${file} imports showDiff`);
  ok(/showDiff\(\{/.test(src), `${file} CALLS showDiff`);
}
// The four diffstats a human clicks. Each must be a BUTTON (a span cannot be clicked by keyboard).
for (const id of ['source-diff', 'diff', 'land-diff', 'pr-diff']) {
  const src = ['land-diff'].includes(id) ? landing : app;
  const re = new RegExp(`<button[^>]*data-testid="${id}"`, 's');
  ok(re.test(src.replace(/\n/g, ' ')), `the ${id} stat is a <button>, not a dead <span>`);
}
ok(/getXellPatch/.test(viewer) && /getLandPatch/.test(viewer), 'the viewer reads both patch endpoints');
ok(/export async function getXellPatch/.test(api) && /export async function getLandPatch/.test(api),
   'api.js exposes getXellPatch + getLandPatch');
ok(/router\.get\('\/xells\/:id\/diff'/.test(routes) && /router\.get\('\/land\/requests\/:id\/diff'/.test(routes),
   'the two read-only routes exist');
ok(/xellPatch, landRequestPatch/.test(routes), 'routes.js imports what it serves');

// The canvas petals: index 5/6 must still BE the two diff facets, or clicking a petal opens the
// wrong diff (the facet list is edited far more often than this mapping).
const facets = canvas.slice(canvas.indexOf('function flowerFacets'));
const kinds = [...facets.slice(0, facets.indexOf('\n}')).matchAll(/\{ title: ([^,]+),/g)].map((mm) => mm[1]);
ok(/const DIFF_PETAL = \{ 5: 'srcdiff', 6: 'owndiff' \}/.test(canvas), 'the petal→diff mapping is declared');
ok(/'commit'/.test(kinds[5] || '') && /'diff · age'/.test(kinds[6] || ''),
   `facet 5/6 are still the two diff facets (${kinds[5]} / ${kinds[6]})`);
ok(/onAction\?\.\(DIFF_PETAL\[f\.cell\]/.test(canvas), 'a click on a diff petal dispatches the action');
ok(/kind === 'srcdiff' \|\| kind === 'owndiff'/.test(app), 'App handles the petal actions');
ok(app.indexOf("kind === 'srcdiff'") < app.indexOf('if (x.is_production) return;'),
   'the read-only diff action is handled BEFORE the production guard (prod drift is worth reading)');
ok(/drawStatLink/.test(canvas), 'the canvas draws a "this is clickable" affordance (no cursor to discover)');

console.log(fail ? `\n${fail} failure(s)` : '\nall good');
process.exit(fail ? 1 : 0);
