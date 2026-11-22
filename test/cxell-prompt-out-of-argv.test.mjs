// CXELL PROMPT-ARGV test — a prompt must never ride in an argv element.
//
// omnibiz xell sunny-harbor-53e585 died twice with, verbatim: "cxell grok exited 126 with no result
// event: bash: line 1: /usr/local/bin/grok: Argument list too long". The cause is in grok's execCmd:
// `grok -p "$(cat)" …` splices the ENTIRE prompt into ONE argv element, and Linux caps a single
// argv/environ string at MAX_ARG_STRLEN (128 KiB). Past it execve returns E2BIG and the turn never
// starts — and a queenzee prompt (harness memory + manual + task + context) is comfortably over it.
//
// The fix moves the prompt onto stdin as a FILE (`--prompt-file /dev/stdin`), MEASURED on the pinned
// grok 0.2.118: headless grok does NOT read piped stdin into the prompt (its own diagnostics say so,
// and `-p -` really does send the literal "-"), but it DOES read /dev/stdin when that path is named
// as the prompt file, and 300 KiB drains through it with no read error.
//
// What is asserted, and why each half matters:
//   1. STATIC — the command grok actually spawns, built by the adapter itself, carries no `$(cat)`
//      splice and no prompt text at all; so no prompt length can overflow it. This half runs always.
//   2. LIVE — on the SAME >128 KiB prompt, the pre-fix shape really does die with "Argument list too
//      long" and the shipped shape really does get past execve. The bug is a LENGTH BOUNDARY, so a
//      short prompt would prove nothing; skipped where the grok CLI is not installed.
//
// The live half runs grok with an EMPTY HOME and no credential env, so it cannot reach the API: the
// question is whether execve succeeds, not what the model would answer. It deliberately does NOT
// assert that a grok turn works — this fleet has no usable Grok account (every one is paused), so a
// live turn is not something this cage can exercise and this test does not claim otherwise.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { adapterFor, HEADLESS_PROC_PATTERN } = await import('../server/src/lib/cxell-runtimes.js');

let failures = 0;
let skipped = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const skip = (msg) => { console.log(`  – SKIP ${msg}`); skipped++; };

// The pre-fix command, kept verbatim as the NEGATIVE CONTROL for the boundary below. It is not read
// from the adapter (which no longer emits it) — the point is to re-run the exact shape that killed
// sunny-harbor-53e585 and watch it die again, so a future "the prompt is fine in argv" is refuted.
const OLD_GROK_CMD = 'grok -p "$(cat)" -m grok-4.5 --output-format streaming-messages-json --always-approve';
const E2BIG_RE = /Argument list too long/;
const PROMPT_BYTES = 200000;            // 200 KB — over MAX_ARG_STRLEN (128 KiB) by a clear margin

const adapter = adapterFor('grok-cxell');
const fresh = adapter.execCmd({ model: '' });
const resumed = adapter.execCmd({ model: 'grok-4.5', resumeSid: '019fcf30-623d-7cf3-97b8-037cfc465042' });

// ── 1. the command carries no prompt, however long the prompt is ────────────────────────────────
console.log('\n── the grok command line holds no prompt text ──');
ok(!fresh.includes('$(cat)'),
   'the `$(cat)` splice is gone — that was the whole MAX_ARG_STRLEN overflow');
ok(!/(^| )-p( |$)/.test(fresh) && !/(^| )--single( |$)/.test(fresh),
   'and no `-p`/`--single` prompt ARGUMENT remains (its text would be the argv element that overflows)');
ok(fresh.includes('--prompt-file /dev/stdin') && resumed.includes('--prompt-file /dev/stdin'),
   'the prompt is delivered as `--prompt-file /dev/stdin` — the file IS this process\'s stdin');
ok(fresh.length < 200 && resumed.length < 300,
   `the command is fixed-size — nothing about it scales with the prompt (${fresh.length} / ${resumed.length} bytes)`);
ok(resumed.includes(' -r 019fcf30-623d-7cf3-97b8-037cfc465042 '),
   'a resumed turn still passes its session id FIRST, as grok requires');

// ── 2. the mid-turn probe still sees the real headless run ──────────────────────────────────────
console.log('\n── HEADLESS_PROC_PATTERN tracks the new shape ──');
const probe = new RegExp(HEADLESS_PROC_PATTERN);
ok(probe.test(fresh), 'the pattern matches the command the adapter actually builds');
ok(probe.test(resumed), '…including the resumed form (session id in front of the flag)');
ok(!probe.test('grok -r 019fcf30-623d-7cf3-97b8-037cfc465042 --always-approve'),
   'but not the grok session a human attaches to — that pane can hear you');
ok(!probe.test(HEADLESS_PROC_PATTERN),
   'and it cannot match its OWN text — the bracket on the first dash is what stops the self-match '
   + 'that once made every cxell look mid-turn forever');

// ── 3. LIVE: the boundary itself, with the real binary where it exists ──────────────────────────
console.log('\n── live boundary: >128 KiB through execve (the real grok CLI) ──');
const hasGrok = spawnSync('bash', ['-lc', 'command -v grok'], { encoding: 'utf8' }).status === 0;
if (!hasGrok) {
  skip('no grok CLI on this host — the static halves above still assert the shipped shape');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'cxell-argv-'));
  const emptyHome = join(dir, 'home');   // NOT $HOME: no ~/.grok/auth.json, so grok cannot reach the API
  const prompt = 'x'.repeat(PROMPT_BYTES);
  // env -i-equivalent: PATH (the grok trampoline needs node) and an empty HOME, nothing else.
  const bare = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: emptyHome };
  const run = (cmd) => spawnSync('bash', ['-lc', `cd ${dir} && ${cmd}`],
    { input: prompt, env: bare, encoding: 'utf8', timeout: 60000 });
  try {
    const before = run(OLD_GROK_CMD);
    ok(before.status === 126 && E2BIG_RE.test(before.stderr + before.stdout),
       `the PRE-FIX shape still dies on ${PROMPT_BYTES} bytes: exit ${before.status}, `
       + `"${(before.stderr + before.stdout).split('\n').find((l) => E2BIG_RE.test(l)) || ''}"`);

    const after = run(fresh);
    ok(!E2BIG_RE.test(after.stderr + after.stdout) && after.status !== 126,
       `the SHIPPED shape gets past execve on the same prompt: exit ${after.status}, no E2BIG`);
    ok((after.stderr + after.stdout).trim().length > 0 && after.status !== null,
       'and the CLI itself ran — it exits on its own diagnostics (no Grok account here), not on a '
       + 'bash exec failure');

    // The empty prompt is the one case a file-based door could regress into something worse than an
    // argv one: an empty PROMPT ARGUMENT is rejected, but an empty prompt FILE could be read as "no
    // prompt given" and drop the CLI into an interactive session that never returns. It does not —
    // grok refuses it, exactly as `-p ""` did, and it exits rather than hanging.
    const empty = spawnSync('bash', ['-lc', `cd ${dir} && ${fresh}`],
      { input: '', env: bare, encoding: 'utf8', timeout: 30000 });
    ok(empty.status !== null && empty.status !== 0 && !empty.signal,
       `an EMPTY prompt still fails fast and loudly (exit ${empty.status}, signal ${empty.signal}) `
       + '— it does not fall through to an interactive session that hangs the turn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} FAILED` : `\nALL PASSED ✓${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failures ? 1 : 0);
