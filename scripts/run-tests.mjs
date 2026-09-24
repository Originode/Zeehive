#!/usr/bin/env node
// THE SUITE RUNNER — measure a test by its EXIT CODE, never by a word in its output.
//
// WHY THIS EXISTS. test/ is ~360 standalone node scripts and there was NO runner: the suite was
// run by hand and read by eye, so the instrument people reached for was `grep -i fail` over the
// output. That instrument is wrong here, and it fails quietly: the suite's printed lines are full
// of DESCRIPTIONS of healthy scenarios. test/provision-proof.test.mjs:159 prints
//   `── 2. proveXell: address-pool exhaustion → app-build FAILS, classed INFRA ──`
// on EVERY run, green or not — so a greped green run reads like a bloodbath (99 printed lines
// across test/ carry fail/failed/FAILS outside the assertion marker and the terminal summary; the
// sweep and the rule are in docs/test-suite-measurement-decision-record.md).
//
// THE INSTRUMENTS, in order of authority:
//   1. the process EXIT CODE — the verdict. A section header cannot produce it.
//   2. the TERMINAL SUMMARY — `all good` vs `N FAILED`; context for a human, never the verdict.
//   3. the ASSERTION MARKER — the literal `✗ FAIL`; used here ONLY as a disagreement ALARM, never
//      as a verdict, because it too can be produced by a healthy run (a test that echoes a child's
//      failing output). A disagreement is printed as a ⚠ ADVISORY and, with --strict, fails the run.
// A bare /fail/i over the output is never an instrument.
//
//   node scripts/run-tests.mjs                 # every test/*.test.mjs
//   node scripts/run-tests.mjs provision zee   # only files whose name contains ANY of the terms
//   node scripts/run-tests.mjs --list          # what would run, then exit
//   node scripts/run-tests.mjs --json          # machine-readable verdicts
//   node scripts/run-tests.mjs --timeout 0     # no per-test timeout (default 300s)
//   node scripts/run-tests.mjs --verbose       # echo each test's output, passing or not
//   node scripts/run-tests.mjs --strict        # an advisory (exit 0, printed a failure) is fatal
//   node scripts/run-tests.mjs --dir <path>    # sweep another directory (the runner's own test)
//
// Exit 0 = every selected test exited 0.
// Exit 1 = at least one did not (nonzero, killed, or timed out) — or, under --strict, printed a
//          failure that its exit code did not own.
// Exit 2 = nothing matched / usage error.
//
// Sequential on purpose: the integration tests share one DATABASE_URL and stand up real git repos,
// so running them at once would invent the interference it is meant to detect.
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));

// The literal the whole suite's ok() helpers print for a failed assertion (instrument 3). It is a
// MARKER, not the word: `✗ FAIL` cannot be produced by a section header.
export const ASSERTION_MARKER = '✗ FAIL';

// The suite's terminal failure summaries — `N FAILED`, `N FAILURE(S)`, `N check(s) failed`. The
// count is PARSED and only a NONZERO count contradicts exit 0: `0 FAILED` is a passing run that
// used the word, and must never be read as a failure.
const FAILED_SUMMARY = /\b(\d+)\s+(?:FAILED|FAILURES?|FAILURE\(S\)|check\(s\) failed)\b/i;

// The last non-empty line — the terminal summary (instrument 2), whatever this test's vocabulary
// is (`all good`, `ALL PASSED ✓`, `all checks passed`, `N FAILED`, TAP's `# fail 0`, …).
export function lastLine(text) {
  const lines = String(text).split('\n').filter((l) => l.trim() !== '');
  return lines.length ? lines[lines.length - 1].trim() : '';
}

export function countMarkers(text) {
  return String(text).split(ASSERTION_MARKER).length - 1;
}

// THE VERDICT FUNCTION — pure, and the whole point of the runner. `exitCode` decides, full stop:
// a proxy signal must never overrule the state, or the instrument that cannot be produced by the
// other case is no longer the instrument. The two lesser ones can only RAISE AN ADVISORY.
export function classify({ exitCode = null, signal = null, timedOut = false, stdout = '', stderr = '' }) {
  const out = `${stdout}\n${stderr}`;
  const markers = countMarkers(out);
  const summary = lastLine(out);
  const detail = { exitCode, signal, markers, summary, advisory: null };

  if (timedOut) return { verdict: 'timeout', why: 'killed at the timeout without exiting', ...detail };
  if (signal) return { verdict: 'fail', why: `killed by ${signal}`, ...detail };
  if (exitCode !== 0) return { verdict: 'fail', why: `exit ${exitCode}`, ...detail };

  // exit 0, but it PRINTED a failure it did not own — the shape a missing counter produces, and the
  // shape a real failure hides in. NOT a verdict: a test can legitimately echo a child's failing
  // output (the runner's own test does). Say it loudly; --strict makes it fatal.
  if (markers > 0) {
    return { verdict: 'pass', why: 'exit 0', ...detail,
      advisory: `printed ${markers} assertion-failure marker(s) and still exited 0` };
  }
  const m = summary.match(FAILED_SUMMARY);
  if (m && Number(m[1]) > 0) {
    return { verdict: 'pass', why: 'exit 0', ...detail,
      advisory: `its terminal line reports failures ("${summary}") and it still exited 0` };
  }
  return { verdict: 'pass', why: 'exit 0', ...detail };
}

// Which files would run: every *.test.mjs in `dir` (top level — fixtures and helpers live in
// subdirectories), optionally filtered by name substrings.
export function selectTests(dir, terms = []) {
  let names;
  try { names = readdirSync(dir); } catch { return { files: [], error: `no such directory: ${dir}` }; }
  const files = names
    .filter((n) => n.endsWith('.test.mjs'))
    .filter((n) => { try { return statSync(join(dir, n)).isFile(); } catch { return false; } })
    .filter((n) => terms.length === 0 || terms.some((t) => n.includes(t)))
    .sort()
    .map((n) => join(dir, n));
  return { files };
}

// Spawn ONE test and classify it. Never inspects the output for a word; the child's stdout/stderr
// are captured only so a human (and the marker cross-check) can see what it said.
export function runTest(file, { timeout = 300 } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [file], { cwd: REPO, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return done({ file, ...classify({ exitCode: null, stderr: e.message }), ms: 0 });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = timeout > 0
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout * 1000)
      : null;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      done({ file, ...classify({ exitCode: null, stderr: `${stderr}\n${e.message}` }), stdout, stderr, ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      done({ file, ...classify({ exitCode: code, signal, timedOut, stdout, stderr }), stdout, stderr, ms: Date.now() - started });
    });
  });
}

export function parseArgs(argv) {
  const opts = { dir: join(REPO, 'test'), timeout: 300, json: false, list: false, verbose: false, strict: false, help: false, terms: [], error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dir') opts.dir = resolve(REPO, argv[++i] ?? '');
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a.startsWith('-')) opts.error = `unknown option ${a}`;
    else opts.terms.push(a);
  }
  if (Number.isNaN(opts.timeout) || opts.timeout < 0) opts.error = '--timeout must be a number of seconds (0 disables it)';
  return opts;
}

const USAGE = `usage: node scripts/run-tests.mjs [term ...] [--list] [--json] [--verbose] [--strict] [--timeout <sec>] [--dir <path>]`;

const relName = (file) => (file.startsWith(`${REPO}/`) ? file.slice(REPO.length + 1) : file);

// Echo a failed test's own output — the reason a human needs the log at all. Capped: a test that
// printed 20k lines is not made more readable by all of them.
const FAIL_TAIL_LINES = 200;
function indentTail(text, lines = FAIL_TAIL_LINES) {
  const all = String(text).split('\n');
  const tail = all.length > lines ? ['  … (earlier lines elided)', ...all.slice(-lines)] : all;
  return tail.map((l) => `      ${l}`).join('\n');
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error(`${opts.error}\n${USAGE}`); return 2; }
  if (opts.help) { console.log(USAGE); return 0; }

  const { files, error } = selectTests(opts.dir, opts.terms);
  if (error) { console.error(error); return 2; }
  if (opts.list) { for (const f of files) console.log(f); return files.length ? 0 : 2; }
  if (!files.length) {
    console.error(`no *.test.mjs matched${opts.terms.length ? ` [${opts.terms.join(', ')}]` : ''} in ${opts.dir}`);
    return 2;
  }

  const results = [];
  for (const file of files) {
    const r = await runTest(file, { timeout: opts.timeout });
    results.push(r);
    const name = relName(file);
    if (!opts.json) {
      const mark = r.verdict === 'pass' ? (r.advisory ? '⚠' : '✓') : '✗';
      console.log(`${mark} ${name} (${r.why} · "${r.summary.slice(0, 80)}")`);
      if (r.advisory) console.log(`      ⚠ ${r.advisory}`);
      if (opts.verbose && r.verdict === 'pass') console.log(indentTail(r.stdout));
      if (r.verdict !== 'pass') console.log(indentTail(`${r.stdout}\n${r.stderr}`));
    }
  }

  const failed = results.filter((r) => r.verdict !== 'pass');
  const advised = results.filter((r) => r.verdict === 'pass' && r.advisory);
  const counts = {
    selected: results.length,
    passed: results.length - failed.length,
    failed: failed.filter((r) => r.verdict === 'fail').length,
    timeouts: failed.filter((r) => r.verdict === 'timeout').length,
    advisories: advised.length,
  };
  // The exit code is the verdict; an advisory only fails the run when --strict asks it to.
  const red = failed.length + (opts.strict ? advised.length : 0);

  if (opts.json) {
    console.log(JSON.stringify({ ok: red === 0, strict: opts.strict, ...counts,
      results: results.map(({ stdout, stderr, ...keep }) => keep) }, null, 2));
  } else {
    console.log(`\n── ${counts.selected} selected · ${counts.passed} passed · ${failed.length} failed`
      + `${counts.timeouts ? ` (${counts.timeouts} timed out)` : ''}`
      + `${counts.advisories ? ` · ${counts.advisories} advisory (exit 0, printed a failure)` : ''} ──`);
    for (const r of failed) console.log(`   ✗ ${relName(r.file)} — ${r.why}`);
    for (const r of advised) console.log(`   ⚠ ${relName(r.file)} — ${r.advisory}${opts.strict ? ' (fatal: --strict)' : ''}`);
  }
  return red ? 1 : 0;
}

// Run only when INVOKED, never when imported — test/run-tests.test.mjs imports classify/selectTests
// and must not sweep the suite as a side effect of an import.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
