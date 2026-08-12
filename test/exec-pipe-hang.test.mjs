// A BACKUP MUST NOT HANG WHEN THE DESTINATION DIES FIRST — the "stuck at dumping database to
// remote host" failure.
//
// THE BUG. execPipe streams the source's stdout into the destination's stdin with a plain
// `src.stdout.pipe(dst.stdin)`. Node's pipe UNPIPES the source the moment the destination's stdin
// errors (EPIPE — the destination process died). An unpiped source's stdout stops being read, the
// OS pipe buffer fills, and the source process (pg_dump / cat) blocks on write forever. The old
// promise waited for BOTH children to close, so a destination that died early — a failed `docker
// run` on the backup context (image not pullable, volume unmountable), a pg_restore that rejected
// the archive — left the source orphaned and the backup stuck at "Dumping database to remote host…"
// until the 30-minute timeout finally killed it. Every retry re-hung for the full 30 minutes, so a
// dead destination looked like a permanently stuck backup.
//
// WHY THIS TEST IS SHAPED LIKE THIS. execPipe's contract is "resolves with both statuses, never
// rejects" — the hang is that it does not resolve. So the test runs real child processes (no docker,
// no database needed) and asserts the promise settles FAST when one side dies, and still transfers
// the data in the normal case. The orphan is reproduced with a source that writes forever (like a
// big pg_dump) and a destination that exits 1 immediately (like a failed docker run).
import { execPipe } from '../server/src/queenzee/maintenance.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

// Resolve when a promise settles, tagging which won the race.
const race = (p, ms, label) => Promise.race([
  p.then((v) => ({ winner: label, value: v })),
  new Promise((r) => setTimeout(() => r({ winner: 'timeout', value: null }), ms)),
]);

try {
  console.log('\n── the hang: destination dies before the source is done ──');
  // A source that produces output forever (an open-ended pg_dump), a destination that fails on
  // startup (a docker run that cannot pull the image). Before the fix this stayed pending until the
  // 30-minute timeout; the test gives it 5 seconds and demands the pipe settles on its own.
  const hang = await race(execPipe(
    { cmd: 'sh', args: ['-c', 'i=0; while true; do echo "data line $i — padding padding padding padding"; i=$((i+1)); done'] },
    { cmd: 'sh', args: ['-c', 'echo "destination cannot start" >&2; exit 1'] },
    { timeout: 30000 },
  ), 5000, 'execPipe');
  ok(hang.winner === 'execPipe', `execPipe resolves promptly when the destination dies first (got ${hang.winner} after 5s)`);
  if (hang.winner === 'execPipe') {
    ok(hang.value.dstStatus !== 0, `the destination's failure status surfaces (dstStatus=${hang.value.dstStatus})`);
    ok(hang.value.srcStatus !== 0, `the orphaned source was torn down, not left running (srcStatus=${hang.value.srcStatus})`);
  }

  console.log('\n── the source dying first must release the destination ──');
  // A source that produces nothing and exits 1 (a pg_dump that failed before writing), a destination
  // that waits on stdin and reports how much it received. The EOF the pipe would have sent never
  // arrives, so the destination must be released by the src-close handler.
  const srcFirst = await race(execPipe(
    { cmd: 'sh', args: ['-c', 'echo "pg_dump: could not connect" >&2; exit 1'] },
    { cmd: 'sh', args: ['-c', 'cat > /tmp/exec-pipe-dst-$$.txt; echo "received $(wc -c < /tmp/exec-pipe-dst-$$.txt) bytes"'] },
    { timeout: 10000 },
  ), 5000, 'execPipe');
  ok(srcFirst.winner === 'execPipe', `execPipe resolves when the source dies before the destination is done (got ${srcFirst.winner})`);
  if (srcFirst.winner === 'execPipe') {
    ok(srcFirst.value.srcStatus === 1, `the source's failure status surfaces (srcStatus=${srcFirst.value.srcStatus})`);
    ok(srcFirst.value.dstStatus === 0, `the destination flushed and exited cleanly (dstStatus=${srcFirst.value.dstStatus})`);
    ok(srcFirst.value.dstStdout.includes('received 0 bytes'), `the destination saw the EOF and wrote the partial (dstStdout=${JSON.stringify(srcFirst.value.dstStdout.trim())})`);
  }

  console.log('\n── the normal case is untouched ──');
  // Both sides finish: the source writes a known payload and exits 0, the destination consumes it
  // and prints the count. The fix must not interrupt a healthy stream.
  const normal = await race(execPipe(
    { cmd: 'sh', args: ['-c', 'for i in $(seq 1 100); do echo "line $i"; done'] },
    { cmd: 'sh', args: ['-c', 'wc -c'] },
    { timeout: 10000 },
  ), 5000, 'execPipe');
  ok(normal.winner === 'execPipe', `execPipe resolves on a healthy stream (got ${normal.winner})`);
  if (normal.winner === 'execPipe') {
    ok(normal.value.srcStatus === 0 && normal.value.dstStatus === 0,
      `both sides exit 0 on success (srcStatus=${normal.value.srcStatus}, dstStatus=${normal.value.dstStatus})`);
    ok(String(normal.value.dstStdout).trim() === '792', `all 100 lines reached the destination (dstStdout=${JSON.stringify(normal.value.dstStdout.trim())})`);
  }
} finally {
  // the source-first test leaves a file in /tmp; clean it up
  try {
    const { readdirSync, rmSync } = await import('node:fs');
    for (const f of readdirSync('/tmp')) if (f.startsWith('exec-pipe-dst-')) rmSync(`/tmp/${f}`, { force: true });
  } catch { /* best effort */ }
}
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
