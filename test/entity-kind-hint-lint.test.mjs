// ENTITY KIND_HINT LINT — entity.kind_hint is DISPLAY-ONLY (design §6).
//
// The entity collapse (docs/hierarchical-workflow-model.md §6) is "parameter values, not
// subtypes": a person, a model, a script, a service, a pool, an org unit and another plan
// all live in ONE `entity` table, and the differences between them are column values, not
// kinds. `kind_hint` exists so DASHBOARDS can show an icon. The moment ENGINE logic branches
// on it — "if this is a human, do X; if this is a model, do Y" — the abstraction has failed:
// every kind-specific special case is a re-introduction of the discriminated union the design
// exists to remove.
//
// So this lint fails the build if any ENGINE file (server/src) branches on kind_hint. It is
// the stage-5 weld from docs/hierarchical-workflow-adoption.md §3.4, written in the pattern
// of test/cxell-cli-drift.test.mjs: a static scan over the source tree, no database, no
// docker, no network. The WEB app (web/src) is deliberately NOT scanned — rendering an icon
// from kind_hint is exactly what the column is for; the dashboard may branch on it all it
// likes. The engine may not.
//
// What counts as "branching" (each is flagged):
//   • a comparison  — kind_hint ===/!==/==/!=/>/</>=/<= 'human'
//   • a ternary     — kind_hint ? a : b
//   • a logical     — kind_hint && …  /  … || kind_hint
//   • a switch      — switch (entity.kind_hint) { case 'human': … }
//   • a bare test   — if (kind_hint) / while (kind_hint)
//
// What does NOT count (allowed): reading the column to hand it to a view
// (`iconFor(entity.kind_hint)`, a SELECT list, a JSON payload), and any mention of the word
// in a comment or string literal. A line is comment-stripped before it is judged, so the
// migration header that says "kind_hint is display-only" does not trip the lint.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(ROOT, 'server', 'src');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

// A line "branches" on kind_hint iff, after removing comments, kind_hint is used in a
// control-flow position: a comparison, a ternary, a logical combination, or a bare truthiness
// test. Accessing the column to pass it to a view (`iconFor(en.kind_hint)`, a SELECT list) is
// NOT a branch and must not trip.
const BRANCH = new RegExp(
  // kind_hint on the LEFT of an operator:  kind_hint === 'x'  |  kind_hint ? a : b  |  kind_hint && x
  'kind_hint\\s*(===|!==|==|!=|>=|<=|>|<|\\?|&&|\\|\\|)'
  // kind_hint on the RIGHT of an operator:  'x' === kind_hint  |  a ? b : kind_hint  |  x || kind_hint
  + '|(===|!==|==|!=|>=|<=|>|<|\\?|&&|\\|\\|)\\s*kind_hint'
  // a bare truthiness test inside a control keyword:  if (kind_hint)  |  while (en.kind_hint)
  + '|(if|while|switch)\\s*\\([^)]*kind_hint'
);

const stripComments = (line) =>
  line.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/, '');

console.log('\n── entity.kind_hint is DISPLAY-ONLY — the engine must never branch on it ──');
const engineFiles = walk(ENGINE);
ok(engineFiles.length > 0, `server/src has JS to scan (${engineFiles.length} files)`);

let hits = 0;
for (const file of engineFiles) {
  const rel = file.slice(ROOT.length + 1);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComments(lines[i]).trim();
    if (!stripped.includes('kind_hint')) continue;
    if (BRANCH.test(stripped)) {
      hits++;
      ok(false, `${rel}:${i + 1}: branches on kind_hint: ${lines[i].trim()}`);
    }
  }
}
ok(hits === 0, `no engine branch on kind_hint${hits ? ` (${hits} found)` : ''}`);

// ── switch blocks ────────────────────────────────────────────────────────────────
// A `switch (x.kind_hint)` whose discriminant is on its own line from the `switch` keyword
// (rare, but the line regex above would miss it). Collect every switch block and judge its
// DISCRIMINANT (the text between `switch (` and the first `{`), which is where a kind_hint
// branch would live — the case labels are display values and are not enough on their own.
const switchDiscriminants = [];
for (const file of engineFiles) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/switch\s*\(([^)]*)\)/g)) {
    switchDiscriminants.push({ file: file.slice(ROOT.length + 1), disc: m[1].trim() });
  }
}
const badSwitches = switchDiscriminants.filter((s) => stripComments(s.disc).includes('kind_hint'));
ok(badSwitches.length === 0,
   `no switch branches on kind_hint as its discriminant`
   + (badSwitches.length ? ` (${badSwitches.map((s) => `${s.file}: switch (${s.disc})`).join('; ')})` : ''));

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
