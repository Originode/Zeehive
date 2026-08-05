// QUEENZEE_INPROC=false — an API-only queenzee starts without the single-queenzee advisory lock.
//
// server/src/index.js takes postgres advisory lock 715533001 ("the queenzee of this meta-DB") for
// the process lifetime, and a second instance waits 90s and exits. That lock is about DRIVING a
// fleet, not serving HTTP — but because the two live in one process, a spinoff server on a SHARED
// dev meta-DB (db-shared-dev, where the live queenzee already holds it) can NEVER start: it waits
// 90s and restart-loops while `zee build server --wait` may still report UP. That already cost two
// workers their verification of a shipped security fix (TKT-136-FE32 / TKT-137-F266).
//
// This boots the REAL server/src/index.js as a child against the REAL DATABASE_URL (run this with
// `DATABASE_URL="$(zee db-sandbox --migrate | …)"` — it must be a db whose lock state the test
// controls, because the DEFAULT case below needs the lock FREE, which a db the live queenzee sits
// on can never be) and proves:
//
//   1. QUEENZEE_INPROC=false + the lock ALREADY HELD by a second client → the API answers /health
//      AND a read route (/api/projects), the boot log says loops are DISABLED (it never waited on
//      the lock and started none of the loops), AND a fleet-driving route (reap) REFUSES with 503
//      — the honest refusal for an instance that holds no lock;
//   2. DEFAULT (QUEENZEE_INPROC unset) → the instance takes the lock and starts the loops as today:
//      the boot log shows the poller started, and the lock row in pg_locks names the child. A
//      second default instance while it holds the lock would wait 90s and exit — the pre-flag
//      behavior, unchanged.
//
// Everything it spawns is killed and the lock client released in a finally.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'server/src/index.js');
const LOCK_KEY = 715533001; // copied from server/src/index.js — "the queenzee of this meta-DB"

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required — use a throwaway db (zee db-sandbox --migrate)'); process.exit(2); }

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
});

const { pool } = await import('../server/src/db/pool.js');

// Boot the real index.js as a child. stdout is captured so the boot log can be asserted.
function boot(extraEnv) {
  const env = { ...process.env };
  delete env.QUEENZEE_INPROC; // the DEFAULT case must be the real default, whatever the runner holds
  Object.assign(env, extraEnv);
  const p = spawn(process.execPath, [INDEX], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  return { proc: p, out: () => out };
}

// Poll the child's /health until it answers (the child runs migrations + self-onboard before
// listening, so the first answer can take a few seconds). A timeout is a FAILURE here — it is
// exactly what the flag removes in case 1 and what the lock imposes on a second queenzee.
async function waitHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error(`server on :${port} did not answer /health within ${timeoutMs}ms (${lastErr || 'no response'})`);
}

const kids = [];
const kill = async (kid) => {
  // boot() returns a { proc, out } wrapper; unwrap so the guard below sees the REAL ChildProcess
  // (whose live exitCode is null), not the wrapper (whose exitCode is undefined — and undefined
  // !== null, which would make the guard return early and orphan the child).
  const proc = kid && kid.proc ? kid.proc : kid;
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
};

try {
  // ── 1. API-ONLY: the lock is HELD by us, yet the API still serves ──────────────────────────
  console.log('\n── QUEENZEE_INPROC=false with the single-queenzee lock already held ──');
  const lockClient = await pool.connect();
  try {
    const locked = await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
    ok(locked.rows[0].got === true, 'the test holds advisory lock 715533001 (simulating THE queenzee)');

    const port1 = await freePort();
    const apiOnly = boot({ PORT: String(port1), QUEENZEE_INPROC: 'false' });
    kids.push(apiOnly);
    const health1 = await waitHealth(port1);
    ok(health1?.ok === true, `QUEENZEE_INPROC=false answers /health on :${port1} (ok:true) while the lock is held`);

    const proj = await fetch(`http://127.0.0.1:${port1}/api/projects`, { signal: AbortSignal.timeout(5000) });
    const projData = await proj.json();
    ok(proj.status === 200 && Array.isArray(projData),
       `and a read route (/api/projects) answers ${proj.status} with an array (${projData.length} project(s))`);

    // A route that DRIVES the fleet (reap is the pool's teardown) must REFUSE, loudly — an API-only
    // instance holds no lock and must not act like the fleet driver.
    const reap = await fetch(`http://127.0.0.1:${port1}/api/xells/00000000-0000-4000-8000-000000000000/reap`,
      { method: 'POST', signal: AbortSignal.timeout(5000) });
    const reapData = await reap.json();
    ok(reap.status === 503 && reapData?.ok === false && /does not drive the fleet/.test(reapData.error || ''),
       `and a fleet-driving route (reap) REFUSES with 503 + a clear error ("${reapData?.error?.slice(0, 50)}…")`);

    // It must NEVER have taken the lock or started a loop. The log is the receipt.
    await sleep(500); // let a few boot lines land
    const out1 = apiOnly.out();
    ok(/loops DISABLED/.test(out1), 'the boot log says loops are DISABLED (QUEENZEE_INPROC=false)');
    ok(!/poller started/.test(out1), 'and it did NOT start the poller (no loop ran)');

    await kill(apiOnly);
    kids.pop();

    // The lock is still held by our client — prove the API-only instance did not consume it.
    const still = await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
    ok(still.rows[0].got === true, 'the lock is STILL ours after the API-only boot — it never took it');
  } finally {
    // ALWAYS free the lock and hand the client back, or pool.end() in the outer finally would hang
    // waiting on a checked-out client and orphan the children (pg_advisory_unlock on a lock this
    // client never took is a harmless no-op that returns false). pg's release() returns undefined,
    // so this must be try/catch, not .catch().
    try { await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* already gone */ }
    try { await lockClient.release(); } catch { /* already released */ }
  }

  // ── 2. DEFAULT: the lock is free, so the queenzee takes it and starts the loops ─────────────
  console.log('\n── DEFAULT (QUEENZEE_INPROC unset) — today\'s behavior, unchanged ──');
  const port2 = await freePort();
  const def = boot({ PORT: String(port2) });
  kids.push(def);
  const health2 = await waitHealth(port2);
  ok(health2?.ok === true, `default answers /health on :${port2} (ok:true)`);

  await sleep(800); // let the poller + lock acquisition land
  const out2 = def.out();
  ok(/poller started/.test(out2), 'the boot log shows the poller started — loops ARE running as today');

  // The lock row in pg_locks names the child — proof it acquired the single-queenzee lock (our
  // client released it above, so any holder of objid 715533001 is the child).
  const locks = await pool.query(
    `SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1`, [LOCK_KEY]);
  ok(locks.rows.length >= 1,
     `the child holds the advisory lock in pg_locks (pid ${locks.rows.map((r) => r.pid).join(', ')})`);

  await kill(def);
  kids.pop();
} finally {
  for (const k of kids) await kill(k).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
