// Regression for the 2026-08-08 ghost-lock outage: force-removed server containers left
// postgres backends holding advisory lock 715533001, and docker's IP reuse meant the ghost
// shared the NEW server's own client_addr — so the fresh queenzee waited 90s and exited with
// "ANOTHER QUEENZEE holds the meta-DB lock" against a holder that could never release it.
//
// This exercises the detection SQL from server/src/index.js (the ghost sweep inside the
// single-queenzee lock wait) against a REAL postgres, two TCP connections sharing one
// client address — the outage topology exactly:
//   1. a holder whose backend_start is NEWER than our boot is untouched (0 rows), and the
//      lock stays held — a legitimately-racing queenzee is still refused;
//   2. a same-address holder that PREDATES our boot is pg_terminate_backend'd and the lock
//      becomes acquirable;
//   3. (reasoned, not constructible on loopback) a holder from a DIFFERENT address fails
//      `a.client_addr = inet_client_addr()`, and a unix-socket holder fails `IS NOT NULL` —
//      both excluded by the same WHERE clause cases 1–2 exercise.
//
// Run with a THROWAWAY db (zee db-sandbox): DATABASE_URL=... node test/ghost-lock-sweep.test.mjs
// It takes and releases an advisory lock and terminates only its OWN second connection.
import pg from 'pg';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.log('✗ FAIL set DATABASE_URL to a throwaway db (zee db-sandbox)'); process.exit(1); }
const KEY = 715533001;
const DETECT = `SELECT a.pid, pg_terminate_backend(a.pid) AS terminated
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory'
    AND l.classid = ($1::bigint >> 32)::int
    AND l.objid   = ($1::bigint & x'FFFFFFFF'::bigint)::int
    AND l.granted
    AND a.pid <> pg_backend_pid()
    AND a.client_addr IS NOT NULL
    AND a.client_addr = inet_client_addr()
    AND a.backend_start < to_timestamp($2::double precision / 1000)`;

let failed = false;
const ok = (cond, msg) => { console.log((cond ? '✓ ' : '✗ FAIL ') + msg); if (!cond) failed = true; };

const ghost = new pg.Client({ connectionString: DSN });
const me = new pg.Client({ connectionString: DSN });
try {
  await ghost.connect();
  ghost.on('error', () => {}); // we terminate it on purpose
  const got = await ghost.query('SELECT pg_try_advisory_lock($1) AS got', [KEY]);
  ok(got.rows[0].got, 'ghost connection takes the lock');
  await new Promise((r) => setTimeout(r, 1100)); // backend_start must clearly predate "our boot"
  const boot = Date.now(); // the new queenzee's START_TIME
  await me.connect();

  const none = await me.query(DETECT, [KEY, boot - 3600000]);
  ok(none.rows.length === 0, `holder newer than our boot: untouched (${none.rows.length} rows)`);
  const still = await me.query('SELECT pg_try_advisory_lock($1) AS got', [KEY]);
  ok(!still.rows[0].got, 'lock still held after the no-op sweep');

  const hit = await me.query(DETECT, [KEY, boot]);
  ok(hit.rows.length === 1 && hit.rows[0].terminated === true,
    `same-address older holder: terminated (pid ${(hit.rows[0] || {}).pid})`);
  let acquired = false;
  for (let i = 0; i < 20; i++) { // termination is asynchronous; poll briefly
    const r = await me.query('SELECT pg_try_advisory_lock($1) AS got', [KEY]);
    if (r.rows[0].got) { acquired = true; break; }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  ok(acquired, 'new queenzee acquires the lock after the sweep');
} finally {
  try { await me.query('SELECT pg_advisory_unlock_all()'); } catch { /* connection may be gone */ }
  try { await me.end(); } catch { /* ditto */ }
  try { await ghost.end(); } catch { /* terminated above */ }
}
process.exit(failed ? 1 : 0);
