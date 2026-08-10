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
// (`iconFor(entity.kind_hint)`, a SELECT list, a JSON payload, optional chaining like
// `entity.kind_hint?.label`), and any mention of the word in a comment or string literal. A
// line is comment-stripped before it is judged, so the migration header that says "kind_hint
// is display-only" does not trip the lint.
//
// AND THE LINT TESTS ITSELF. server/src contains ZERO kind_hint today, so the scan alone is
// vacuously green — a refactor that neuters the matcher would sail through forever. The
// same proof cxell-cli-drift and migration-numbers demand of their matchers: a fixed table
// of sample lines is run through the SAME functions the real scan uses, and the verdicts are
// asserted. Positive samples must FLAG; negative samples (a view call, a SELECT list, a
// payload, a comment, a string literal, optional chaining) must NOT.
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

// ── the matchers, factored so the self-test runs the IDENTICAL code ─────────────
//
// A line "branches" on kind_hint iff, after removing comments, kind_hint is used in a
// control-flow position: a comparison, a ternary, a logical combination, or a bare truthiness
// test. Accessing the column to pass it to a view (`iconFor(en.kind_hint)`, a SELECT list) is
// NOT a branch and must not trip.
//
// The `\?(?!\.)` on the LEFT side is deliberate: `?` is the ternary operator when followed by
// a space (`kind_hint ? a : b`) but optional chaining when followed by `.` (`kind_hint?.foo`),
// which is a READ and must not flag. The right-side `\?` cannot be optional chaining — that
// form is always `cond ? kind_hint : y`.
const BRANCH = new RegExp(
  // kind_hint on the LEFT of an operator:  kind_hint === 'x'  |  kind_hint ? a : b  |  kind_hint && x
  'kind_hint\\s*(===|!==|==|!=|>=|<=|>|<|\\?(?!\\.)|&&|\\|\\|)'
  // kind_hint on the RIGHT of an operator:  'x' === kind_hint  |  a ? b : kind_hint  |  x || kind_hint
  + '|(===|!==|==|!=|>=|<=|>|<|\\?|&&|\\|\\|)\\s*kind_hint'
  // a bare truthiness test inside a control keyword:  if (kind_hint)  |  while (en.kind_hint)
  + '|(if|while|switch)\\s*\\([^)]*kind_hint'
);

const stripComments = (line) =>
  line.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/, '');

// One line of engine source → does it branch on kind_hint?
const judgeLine = (line) => {
  const stripped = stripComments(line).trim();
  if (!stripped.includes('kind_hint')) return false;
  return BRANCH.test(stripped);
};

// A whole file → every switch whose DISCRIMINANT mentions kind_hint. This is the branch the
// line matcher cannot see: `switch (` and `entity.kind_hint` sit on different lines, so the
// per-line regex never meets them. `[^)]*` crosses newlines (a negated class), so the
// discriminant is captured whole across the multi-line form.
const switchesOnKindHint = (text) => {
  const out = [];
  for (const m of text.matchAll(/switch\s*\(([^)]*)\)/g)) {
    if (stripComments(m[1].trim()).includes('kind_hint')) out.push(m[1].trim());
  }
  return out;
};

// ── SELF-TEST — the matchers must be PROVEN, not just present ───────────────────
console.log('\n── the matcher is proven against a fixed sample table ──');
const POSITIVE = [
  `kind_hint === 'human'`,
  `'human' === kind_hint`,
  `kind_hint !== 'human'`,
  `kind_hint ? 'human' : 'model'`,
  `kind_hint && opts.longPoll`,
  `if (en.kind_hint) {`,
  `while (en.kind_hint) {`,
  `switch (en.kind_hint) {`,
];
const NEGATIVE = [
  `const icon = iconFor(en.kind_hint);`,            // passed to a view — allowed
  `SELECT id, kind_hint, name FROM entity`,          // a SELECT list — allowed
  `{ kind_hint: en.kind_hint, name: en.name }`,      // a JSON payload — allowed
  `// kind_hint is display-only: the engine must never branch on it`, // comment — allowed
  `const hint = 'kind_hint';`,                       // string literal — allowed
  `en.kind_hint?.label ?? 'unknown'`,                // optional chaining — a READ, allowed
];
let selfTestOk = true;
for (const s of POSITIVE) {
  const verdict = judgeLine(s);
  ok(verdict, `POSITIVE flags: ${s.trim()}`); if (!verdict) selfTestOk = false;
}
for (const s of NEGATIVE) {
  const verdict = judgeLine(s);
  ok(!verdict, `NEGATIVE stays quiet: ${s.trim()}`); if (verdict) selfTestOk = false;
}
// the multi-line switch: `switch (` / `entity.kind_hint` / `) {` on separate lines — the
// line matcher cannot see it, so the file-level switch scan must
const MULTI_LINE_SWITCH = [
  'switch (',
  '  entity.kind_hint',
  ') {',
].join('\n');
ok(switchesOnKindHint(MULTI_LINE_SWITCH).length === 1,
   `POSITIVE flags: the multi-line switch discriminant`);
// and the single-line switch is caught by BOTH the line matcher and the switch scan
ok(judgeLine(POSITIVE[7]) && switchesOnKindHint(POSITIVE[7] + '\n').length === 1,
   `POSITIVE flags: a one-line switch by both the line matcher and the switch scan`);
ok(selfTestOk, `every sample above returned the expected verdict — the matcher is exercised, not decorative`);

// ── THE REAL SCAN ────────────────────────────────────────────────────────────────
console.log('\n── entity.kind_hint is DISPLAY-ONLY — the engine must never branch on it ──');
const engineFiles = walk(ENGINE);
ok(engineFiles.length > 0, `server/src has JS to scan (${engineFiles.length} files)`);

let hits = 0;
for (const file of engineFiles) {
  const rel = file.slice(ROOT.length + 1);
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (judgeLine(lines[i])) {
      hits++;
      ok(false, `${rel}:${i + 1}: branches on kind_hint: ${lines[i].trim()}`);
    }
  }
}
ok(hits === 0, `no engine branch on kind_hint${hits ? ` (${hits} found)` : ''}`);

// ── switch blocks ────────────────────────────────────────────────────────────────
// Every switch's discriminant — a kind_hint there is a branch the per-line matcher would
// miss across the multi-line form. The case labels are display values and are not enough on
// their own.
const badSwitches = [];
for (const file of engineFiles) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(ROOT.length + 1);
  for (const disc of switchesOnKindHint(text)) {
    badSwitches.push(`${rel}: switch (${disc})`);
  }
}
ok(badSwitches.length === 0,
   `no switch branches on kind_hint as its discriminant`
   + (badSwitches.length ? ` (${badSwitches.join('; ')})` : ''));

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
