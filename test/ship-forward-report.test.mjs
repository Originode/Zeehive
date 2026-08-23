// SHIP-FORWARD-REPORT test — the pure text behind the failed-ship "📨 Forward build output to the
// zee" button (web/src/shipFailure.js). When the queenzee ships from main and the deploy FAILS, the
// operator should be able to hand the zee the exact build output in one click instead of copy-pasting
// logs into the message composer. This proves:
//   • shipHasFailureOutput only fires for a FAILED ship that actually has something to forward,
//   • shipFailureReport flattens the top-level error + each FAILED container's error and log,
//     leaving out the steps that SUCCEEDED (no noise), and fencing the log so it survives verbatim.
import { shipFailureReport, shipHasFailureOutput } from '../web/src/shipFailure.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// ── 1. gating: only a FAILED ship with real output offers a forward ──────────────
console.log('── shipHasFailureOutput ──');
ok(!shipHasFailureOutput({ status: 'shipped' }), 'a SHIPPED ship offers nothing to forward');
ok(!shipHasFailureOutput({ status: 'shipping' }), 'a ship still SHIPPING offers nothing to forward');
ok(!shipHasFailureOutput({ status: 'failed' }), 'a failed ship with no error/logs offers nothing');
ok(shipHasFailureOutput({ status: 'failed', error: 'lock timeout' }), 'a failed ship with a top-level error can forward');
ok(shipHasFailureOutput({ status: 'failed', containers: [{ ok: false, log: 'boom' }] }),
   'a failed ship with a failed container log can forward');
ok(!shipHasFailureOutput({ status: 'failed', containers: [{ ok: true, log: 'fine' }] }),
   'a failed ship whose only container SUCCEEDED (empty step log) offers nothing');

// ── 2. the report body: top error + failed steps only, logs fenced ───────────────
console.log('\n── shipFailureReport ──');
const req = {
  status: 'failed',
  commit: 'abcdef1234567890',
  site_key: 'eu',
  error: 'webapp build returned non-zero',
  failure_cause: 'npm-install',
  failure_line: 'npm ERR! No matching version found for react@19.0.0',
  containers: [
    { role: 'migrations', ok: true, applied: ['051_x.sql'] },
    { role: 'server', ok: true, method: 'build' },
    { role: 'webapp', ok: false, method: 'build', error: 'exit 1', log: '  npm ERR! boom  \n' },
  ],
};
const body = shipFailureReport(req);
ok(body.includes('Ship of abcdef12 to production @ eu FAILED.'), 'headline names the short sha + site');
ok(body.includes('Cause: npm-install — npm ERR! No matching version found for react@19.0.0'),
   'the classified cause leads the report (ticket #58) — the one-line diagnosis before the raw log');
ok(body.includes('Error: webapp build returned non-zero'), 'includes the top-level ship error');
ok(body.includes('── webapp (build) ──'), 'includes the FAILED container step header');
ok(body.includes('exit 1'), "includes the failed step's error");
ok(body.includes('```\nnpm ERR! boom\n```'), 'fences the build log, trimmed');
ok(!body.includes('migrations') && !body.includes('server'), 'omits the steps that SUCCEEDED (no noise)');
ok(/re-land and re-ship\.$/.test(body.trim()), 'ends with a clear next-step instruction for the zee');

// ── 3. degenerate input never throws ─────────────────────────────────────────────
console.log('\n── robustness ──');
ok(typeof shipFailureReport({}) === 'string', 'an empty ship still yields a string, does not throw');
ok(!shipHasFailureOutput(null) && !shipHasFailureOutput(undefined), 'null/undefined is safely "nothing to forward"');

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
