// THE SUITE RUNNER'S OWN TEST — it must measure a test by its EXIT CODE, never by a word.
//
// docs/test-suite-measurement-decision-record.md is the rule; scripts/run-tests.mjs is the gate
// that enforces it. This test exists because the gate's own failure mode would be invisible: a
// runner that greps its children's output for /fail/i reads a GREEN suite as a bloodbath (the
// suite's printed lines are full of DESCRIPTIONS — test/provision-proof.test.mjs:159 prints
// `app-build FAILS, classed INFRA` on every healthy run), and a runner that trusted a passing word
// would MISS a real failure whose counter never reached the exit code.
//
// So both directions are exercised against REAL child processes, with the fixtures generated into
// a tmpdir at runtime (house rule 1: no test data in the tree, cleaned up in a finally):
//   • green-says-fails  — prints the word FAILS (a section header) and exits 0  → PASS, no advisory
//   • red-exits-1       — prints the assertion marker / `N FAILED` and exits 1   → FAIL
//   • liar-exits-0      — prints the marker, a passing summary, and exits 0      → PASS + ADVISORY
// The exit code is the verdict and a marker can never overrule it: an instrument that overrides the
// state stops being the instrument that cannot be produced by the other case. The disagreement is
// RAISED as an advisory, and --strict is what makes it fatal. The pure verdict function is pinned on
// the shapes a word-based instrument gets wrong, including `0 FAILED` (a passing run that used it).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify, selectTests, ASSERTION_MARKER } from '../scripts/run-tests.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUNNER = join(REPO, 'scripts/run-tests.mjs');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// ── 1. the verdict function, on the shapes a word-based instrument gets wrong ────────────────
console.log('\n── 1. classify(): the exit code decides, the lesser instruments can only advise ──');
{
  // THE CARD'S OWN INSTANCE: this exact line is a section header in test/provision-proof.test.mjs
  // and prints on every run, green or not.
  const header = '── 2. proveXell: address-pool exhaustion → app-build FAILS, classed INFRA ──';
  const green = classify({ exitCode: 0, stdout: `${header}\n  ✓ ok\n\nall good\n` });
  ok(green.verdict === 'pass' && !green.advisory, `a section header containing FAILS on a green run is a PASS [${green.verdict}]`);
  ok(green.summary === 'all good', `the terminal summary rides along for the human [${green.summary}]`);

  const red = classify({ exitCode: 1, stdout: `${header}\n  ${ASSERTION_MARKER} broke\n\n2 FAILED\n` });
  ok(red.verdict === 'fail', `exit 1 is a FAIL however the output reads [${red.verdict}]`);
  ok(red.why === 'exit 1', `and the reason is the exit code [${red.why}]`);

  // THE CONVERSE — a real failure hidden behind a passing exit code. The exit code stays the
  // verdict; the disagreement is RAISED as an advisory (and --strict makes it fatal).
  const liar = classify({ exitCode: 0, stdout: `  ${ASSERTION_MARKER} a real assertion failed\n\nall good\n` });
  ok(liar.verdict === 'pass', `exit 0 is a PASS — a marker cannot override the exit code [${liar.verdict}]`);
  ok(liar.markers === 1, `the marker count is reported [${liar.markers}]`);
  ok(/marker/.test(liar.advisory || ''), `and the printed failure is RAISED as an advisory [${liar.advisory}]`);

  const liarSummary = classify({ exitCode: 0, stdout: '── done ──\n\n3 FAILURE(S)\n' });
  ok(liarSummary.verdict === 'pass' && /terminal line/.test(liarSummary.advisory || ''),
    `exit 0 whose TERMINAL line says 3 FAILURE(S) is a PASS + advisory [${liarSummary.advisory}]`);

  // `0 FAILED` is a passing run that used the word — a zero count must never be read as failure.
  const zero = classify({ exitCode: 0, stdout: 'checks: 5 passed, 0 FAILED\n' });
  ok(zero.verdict === 'pass' && !zero.advisory, `a terminal "0 FAILED" stays a clean PASS [${zero.advisory}]`);

  const killed = classify({ exitCode: null, signal: 'SIGKILL', timedOut: true, stdout: '' });
  ok(killed.verdict === 'timeout', `a test killed at the timeout is a FAIL, not a pass [${killed.verdict}]`);

  const crashed = classify({ exitCode: 2, stdout: 'DATABASE_URL required\n' });
  ok(crashed.verdict === 'fail', `a test that exits before its summary (exit 2) is a FAIL [${crashed.verdict}]`);
}

// ── 2. selection: the top level of test/, never the helper/fixture subdirectories ─────────────
console.log('\n── 2. selectTests(): top-level *.test.mjs only ──');
{
  const { files } = selectTests(join(REPO, 'test'));
  const names = files.map((f) => f.slice(REPO.length + 1));
  ok(names.includes('test/provision-proof.test.mjs'), 'a real test file is selected');
  ok(!names.some((n) => n.includes('/_bin/') || n.includes('/fixtures/')), 'helpers and fixtures are never selected');
  ok(names.every((n) => n.endsWith('.test.mjs')), 'every selection is a .test.mjs');
  ok(names.length > 100, `the suite is swept in full [${names.length} files]`);
  const filtered = selectTests(join(REPO, 'test'), ['provision-proof.test']);
  ok(filtered.files.length === 1 && filtered.files[0].endsWith('provision-proof.test.mjs'),
    `a term filters by name [${filtered.files.length}]`);
}

// ── 3. end to end: the runner over REAL child processes ───────────────────────────────────────
console.log('\n── 3. the runner, over real child processes ──');
const dir = mkdtempSync(join(tmpdir(), 'run-tests-'));
try {
  mkdirSync(join(dir, 'nested'), { recursive: true });

  // A green run that prints the word — the shape that made a grep useless.
  writeFileSync(join(dir, 'green-says-fails.test.mjs'), [
    "console.log('\\n── 2. proveXell: address-pool exhaustion → app-build FAILS, classed INFRA ──');",
    "console.log('  ✓ a failing probe still yields an ordered plan');",
    "console.log('\\nall good');",
    'process.exit(0);',
  ].join('\n'));

  // A real failure — and the file says so in both lesser instruments.
  writeFileSync(join(dir, 'red-exits-1.test.mjs'), [
    `console.log('  ${ASSERTION_MARKER} this assertion is false');`,
    "console.log('\\n2 FAILED');",
    'process.exit(1);',
  ].join('\n'));

  // THE CONVERSE — a real failure hidden behind a passing exit code.
  writeFileSync(join(dir, 'liar-exits-0.test.mjs'), [
    `console.log('  ${ASSERTION_MARKER} a real assertion failed — and this file forgets to exit nonzero');`,
    "console.log('\\nall good');",
    'process.exit(0);',
  ].join('\n'));

  const runRunner = (args) => spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO, env: process.env, encoding: 'utf8', timeout: 120000,
  });
  const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  const all = runRunner(['--dir', dir, '--json']);
  const report = parse(all);
  ok(!!report, `the runner's --json output parses [${(all.stdout || all.stderr || '').slice(0, 120)}]`);
  ok(all.status === 1, `one red file makes the runner exit 1 [${all.status}]`);
  const resultOf = (n) => report?.results.find((r) => r.file.endsWith(n));
  ok(resultOf('green-says-fails.test.mjs')?.verdict === 'pass' && !resultOf('green-says-fails.test.mjs')?.advisory,
    `the file that only SAYS fail passes, with no advisory [${resultOf('green-says-fails.test.mjs')?.verdict}]`);
  ok(resultOf('red-exits-1.test.mjs')?.verdict === 'fail', `the file that exits 1 fails [${resultOf('red-exits-1.test.mjs')?.verdict}]`);
  ok(resultOf('liar-exits-0.test.mjs')?.verdict === 'pass' && /marker/.test(resultOf('liar-exits-0.test.mjs')?.advisory || ''),
    `the exit-0 file that printed a failure passes but is FLAGGED [${resultOf('liar-exits-0.test.mjs')?.advisory}]`);
  ok(report?.failed === 1 && report?.advisories === 1 && report?.passed === 2,
    `the counts keep the verdict and the advisory apart [${report?.passed}p/${report?.failed}f/${report?.advisories}a]`);

  // The green half alone is exit 0 — the instrument a word-based check cannot produce.
  const greenOnly = runRunner(['--dir', dir, 'green-says-fails', '--json']);
  const greenReport = parse(greenOnly);
  ok(greenOnly.status === 0, `a clean selection exits 0 [${greenOnly.status}]`);
  ok(greenReport?.passed === 1 && greenReport?.failed === 0, `and reports 1 passed / 0 failed [${greenReport?.passed}/${greenReport?.failed}]`);

  // --strict is how an advisory becomes fatal: same child, same exit code, a red run.
  const strict = runRunner(['--dir', dir, 'liar-exits-0', '--strict', '--json']);
  const strictReport = parse(strict);
  ok(strict.status === 1, `--strict turns the advisory into a failure [${strict.status}]`);
  ok(strictReport?.advisories === 1 && strictReport?.passed === 1,
    `and still reports what the child actually did [${strictReport?.passed}p/${strictReport?.advisories}a]`);

  // The runner over a REAL test of this suite: its exit code is the verdict, and a test that
  // needs DATABASE_URL exits nonzero rather than being read as green.
  const real = runRunner(['catchup-delta', '--json']);
  const realReport = parse(real);
  ok(real.status === 0 && realReport?.passed === 1, `a real suite test runs green through the runner [exit ${real.status}]`);

  // Nothing matched is a usage error, not a silent pass.
  const none = runRunner(['--dir', dir, 'no-such-test-name']);
  ok(none.status === 2, `an empty selection exits 2, never 0 [${none.status}]`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
