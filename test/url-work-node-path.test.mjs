// THE CONSOLE'S URL IS A WORK-NODE PATH — /<project>/<child>/<child>, and /m/… for the mobile view.
//
// WHAT THIS COVERS: web/src/route.js, the one authority for that address scheme, exercised as the
// pure module it is (no browser, no bundle, no React) — slugging a title into a segment, formatting
// a level into a path, parsing a path back, and RESOLVING segments against a real work-item tree.
//
// WHY IT IS WORTH A TEST: the URL is the only part of the console a human can hand to another human.
// Three things about it are easy to get quietly wrong and impossible to notice in a screenshot:
//   • two siblings with the same title produce the same segment — one link, two possible nodes;
//   • a link into a node that has since been deleted resolves to NOTHING and lands on a blank level
//     instead of the nearest level that still exists;
//   • format(parse(x)) must be x, or the address the app writes back differs from the one the human
//     opened and the history entry churns.
// Each is asserted below. It also pins the LEGACY `?project=` reader, which must keep working for
// bookmarks made before this change (App.jsx and MobileChat.jsx both read it on load, once).
//
// It also greps the two screens for the old writer: nothing may write `?project=` into the URL
// again, or the two schemes would both be half-true.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  findProject, formatPath, legacyProjectParam, parsePath, pathSegments, resolveNodes, slugify, slugsFor,
} from '../web/src/route.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);

// ── slugs ────────────────────────────────────────────────────────────────────────────────────
eq(slugify('Ship the landing gate'), 'ship-the-landing-gate', 'a title becomes a readable segment');
eq(slugify('  ¡Hola! — Café/Bar  '), 'hola-cafe-bar', 'punctuation and accents fold away, no stray dashes');
eq(slugify(''), '', 'an empty title slugs to nothing (the caller falls back to the id)');
ok(slugify('x'.repeat(200)).length <= 48, 'a sentence-length title is capped, not pasted whole into the URL');
ok(!slugify(`${'ab '.repeat(30)}`).endsWith('-'), 'the cap never leaves a trailing dash');

// ── the tree the rest of the file uses ───────────────────────────────────────────────────────
// A real shape: one kind='project' root, activities under it, tasks under those — and deliberately
// TWO siblings titled the same, which is legal in the tracker and fatal to a naive slug.
const ROOTID = 'p0000000-0000-0000-0000-000000000000';
const items = [
  { id: ROOTID, parent_id: null, kind: 'project', title: 'Zeehive' },
  { id: 'a1111111-1111-1111-1111-111111111111', parent_id: ROOTID, kind: 'activity', title: 'The work tracker' },
  { id: 'a2222222-2222-2222-2222-222222222222', parent_id: ROOTID, kind: 'activity', title: 'Console URLs' },
  { id: 't3333333-3333-3333-3333-333333333333', parent_id: 'a2222222-2222-2222-2222-222222222222', kind: 'task', title: 'Path routing' },
  // the collision, twice over
  { id: 'c4444444-4444-4444-4444-444444444444', parent_id: 'a1111111-1111-1111-1111-111111111111', kind: 'task', title: 'Fix the board' },
  { id: 'c5555555-5555-5555-5555-555555555555', parent_id: 'a1111111-1111-1111-1111-111111111111', kind: 'task', title: 'fix the BOARD' },
];
const slugs = slugsFor(items);

eq(slugs.get('a2222222-2222-2222-2222-222222222222'), 'console-urls', 'an unambiguous sibling keeps its plain slug');
ok(slugs.get('c4444444-4444-4444-4444-444444444444') !== slugs.get('c5555555-5555-5555-5555-555555555555'),
   'two siblings with the same title get DIFFERENT segments (one link cannot mean two nodes)');
ok(slugs.get('c4444444-4444-4444-4444-444444444444').startsWith('fix-the-board~'),
   'the disambiguated segment is still readable — the title, then a short id');
ok(slugs.get('c5555555-5555-5555-5555-555555555555').startsWith('fix-the-board~'),
   'BOTH colliding siblings are suffixed, so a segment never changes meaning when a sibling is renamed');

// ── format / parse ───────────────────────────────────────────────────────────────────────────
eq(formatPath({ project: 'Zeehive', nodes: ['console-urls', 'path-routing'] }), '/Zeehive/console-urls/path-routing',
   'a level formats as /<project>/<child>/<child>');
eq(formatPath({ project: null }), '/', 'the projects level is the root path');
eq(formatPath({ mobile: true, project: 'Zeehive', nodes: ['console-urls'] }), '/m/Zeehive/console-urls',
   'the mobile view is the SAME address under /m');
eq(formatPath({ project: 'my project' }), '/my%20project', 'a name with a space is encoded');

eq(parsePath('/Zeehive/console-urls/path-routing'),
   { mobile: false, project: 'Zeehive', nodes: ['console-urls', 'path-routing'] }, 'a path parses back');
eq(parsePath('/'), { mobile: false, project: null, nodes: [] }, 'the root path is the projects level');
eq(parsePath('/m'), { mobile: true, project: null, nodes: [] }, 'a bare /m is mobile with no project');
eq(parsePath('/m/Zeehive/console-urls'),
   { mobile: true, project: 'Zeehive', nodes: ['console-urls'] }, '/m is a prefix, not a project');
eq(parsePath('/Zeehive/'), { mobile: false, project: 'Zeehive', nodes: [] }, 'a trailing slash is not a node');
eq(parsePath('/my%20project'), { mobile: false, project: 'my project', nodes: [] }, 'segments are decoded');

for (const p of ['/', '/Zeehive', '/Zeehive/console-urls/path-routing', '/m/Zeehive/console-urls']) {
  eq(formatPath(parsePath(p)), p, `format(parse(${p})) is exactly ${p} — the app never rewrites the address it was given`);
}

// ── resolving segments against the plan ──────────────────────────────────────────────────────
{
  const r = resolveNodes(items, ['console-urls', 'path-routing']);
  eq(r.nodes.map((n) => n.title), ['Console URLs', 'Path routing'], 'segments resolve to the nodePath they name');
  ok(r.exact, 'a fully-resolved path reports exact');
}
{
  const r = resolveNodes(items, ['console-urls', 'a-node-that-was-deleted']);
  eq(r.nodes.map((n) => n.title), ['Console URLs'], 'a dead tail lands on the longest valid prefix, not on nothing');
  ok(!r.exact, '…and reports itself inexact, so the caller normalises the address to what it shows');
}
{
  const r = resolveNodes(items, ['path-routing']);
  eq(r.nodes, [], 'a real node in the WRONG place does not resolve — the path is hierarchical, not a search');
  ok(!r.exact, '…and is inexact');
}
{
  const r = resolveNodes(items, ['console-urls', 't3333333-3333-3333-3333-333333333333']);
  eq(r.nodes.map((n) => n.title), ['Console URLs', 'Path routing'], 'a raw id still resolves (an older or hand-made link)');
}
{
  const r = resolveNodes(items, ['console-urls', 't3333333']);
  eq(r.nodes.map((n) => n.title), ['Console URLs', 'Path routing'], 'so does a long-enough id prefix');
}
eq(resolveNodes(items, []).nodes, [], 'no segments = the project root level');
eq(resolveNodes([], ['console-urls']).nodes, [], 'an unloaded plan resolves nothing rather than throwing');

// the round trip a drill-then-refresh actually performs
{
  const nodePath = resolveNodes(items, ['the-work-tracker']).nodes;
  const segs = pathSegments(items, nodePath);
  eq(segs, ['the-work-tracker'], 'pathSegments turns a nodePath back into the segments it came from');
  eq(resolveNodes(items, segs).nodes.map((n) => n.id), nodePath.map((n) => n.id),
     'nodePath → URL → nodePath is stable (a refresh lands on the same level)');
}
{
  // the same round trip for the AMBIGUOUS pair — the case a plain slug loses
  const target = { id: 'c5555555-5555-5555-5555-555555555555', title: 'fix the BOARD' };
  const segs = pathSegments(items, [{ id: 'a1111111-1111-1111-1111-111111111111', title: 'The work tracker' }, target]);
  eq(resolveNodes(items, segs).nodes[1].id, target.id, 'a colliding title still round-trips to the RIGHT sibling');
}
// pathSegments must produce an address on the FIRST frame after a drill, before any refetch
eq(pathSegments([], [{ id: 'c4444444-4444-4444-4444-444444444444', title: 'Fix the board' }]), ['fix-the-board'],
   'a nodePath slugs from the title it already holds when the plan is not loaded');

// ── projects, and the legacy param ───────────────────────────────────────────────────────────
const projects = [{ id: 'aaa', name: 'Zeehive' }, { id: 'bbb', name: 'Other' }];
eq(findProject(projects, 'zeehive')?.id, 'aaa', 'a project resolves by name, case-insensitively');
eq(findProject(projects, 'bbb')?.id, 'bbb', '…or by id');
eq(findProject(projects, 'nope'), null, 'an unknown token resolves to nothing');
eq(findProject(projects, null), null, 'no token resolves to nothing');
eq(legacyProjectParam('?project=Zeehive'), 'Zeehive', 'the legacy ?project= bookmark is still READ');
eq(legacyProjectParam(''), null, 'no query, no legacy project');

// ── nothing WRITES the old param any more ────────────────────────────────────────────────────
for (const f of ['web/src/App.jsx', 'web/src/MobileChat.jsx']) {
  const src = readFileSync(resolve(ROOT, f), 'utf8');
  ok(!/searchParams\.set\(\s*(['"]project['"]|PROJECT_PARAM)/.test(src),
     `${f} never writes ?project= into the URL again (one scheme, not one and a half)`);
  ok(src.includes("from './route.js'"), `${f} gets its URL shape from route.js rather than rolling its own`);
}
{
  const src = readFileSync(resolve(ROOT, 'web/src/App.jsx'), 'utf8');
  ok(/history\.pushState/.test(src) && /popstate/.test(src),
     'App.jsx pushes history and listens for popstate — Back walks the levels you drilled through');
}

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ all good');
process.exit(failures ? 1 : 0);
