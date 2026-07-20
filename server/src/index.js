// ZEEHIVE server: HTTP API + queenzee loops (poller now; pool/maintenance added in later steps).
import express from 'express';
import { config } from './config.js';
import { router } from './api/routes.js';
import { startPoller } from './queenzee/poller.js';
import { startPool } from './queenzee/pool.js';
import { startMaintenance } from './queenzee/maintenance.js';
import { startMonitor } from './queenzee/monitor.js';
import { startContainerMonitor } from './queenzee/containers.js';
import { startProdDiff } from './queenzee/proddiff.js';
import { startDbCloneWatch } from './queenzee/dbclone.js';
import { recoverOrphanBuilds } from './lib/build.js';
import { runMigrations } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startShipReaper, recoverOrphanShips } from './queenzee/shipgate.js';
import { recoverOrphanTeardowns } from './queenzee/reaper.js';
import { attachTerminalBridge } from './lib/terminal-bridge.js';
import { startLandReaper } from './queenzee/landgate.js';
import { startLandingPad } from './queenzee/landingpad.js';
import { startImageJanitor } from './lib/images.js';
import { logline } from './lib/logbus.js';

// LAST-RESORT BACKSTOP. The queenzee is the thing that keeps every xell honest: if it dies, the
// pool stops reconciling, stale claims never get reclaimed and nothing reaps anything — silently,
// because the dashboard just says "connecting…". That is exactly what happened on 2026-07-15: one
// ETIMEDOUT to the NAS meta-DB inside an async route became an unhandled rejection and took the
// whole orchestrator down for ~25 minutes.
//
// A local orchestrator that stays up degraded beats one that exits: every loop already catches its
// own errors and retries on the next tick, so surviving a blip costs nothing and dying costs the
// fleet. Log LOUDLY (this must never become a silent swallow) and keep going.
process.on('unhandledRejection', (err) => {
  const msg = err?.message || String(err);
  console.error('[zeehive] UNHANDLED REJECTION (staying up):', msg);
  try { logline('api', `unhandled rejection (queenzee stayed up): ${msg}`); } catch { /* logbus itself failed */ }
});
process.on('uncaughtException', (err) => {
  console.error('[zeehive] UNCAUGHT EXCEPTION (staying up):', err?.stack || err?.message || err);
  try { logline('api', `uncaught exception (queenzee stayed up): ${err?.message || err}`); } catch { /* ignore */ }
});

const app = express();
// 2mb was fine for hooks + control bodies, but the dashboard's "+" dispatch can carry pasted
// screenshots inline (base64 in the task body). A single screenshot is a few MB and base64 inflates
// it ~33%, so the old cap rejected the compose-with-image path outright. 30mb covers a handful.
app.use(express.json({ limit: '30mb' }));

// permissive CORS for the local Vite dev app + localhost hooks
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'zeehive', ts: Date.now() }));
app.use('/api', router);

// SINGLE-QUEENZEE LOCK. Two queenzees ticking loops against one meta-DB reconcile against each
// other — different code, different verdicts, provision/retire ping-pong, and reaps of xells the
// other one just cut (the hazard the prod compose file documents). On 2026-07-19 THREE were
// alive at once: self-ship's helper only kills whatever owns the API port at that moment, so a
// queenzee that had already lost its port (an earlier restart's survivor) kept its loops running
// for a DAY. The lock lives in the meta-DB itself — a session advisory lock on a dedicated
// connection held for the process lifetime — so it guards exactly the resource that's in danger
// and dies with the process (kill → connection drops → lock frees; the self-ship's 3s grace fits
// well inside the 90s wait). A second instance waits, then exits LOUDLY instead of double-driving.
{
  const LOCK_KEY = 715533001; // arbitrary constant: "the queenzee of this meta-DB"
  const client = await pool.connect(); // deliberately never released
  const deadline = Date.now() + 90000;
  for (;;) {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
    if (r.rows[0].got) break;
    if (Date.now() > deadline) {
      console.error('[zeehive] ANOTHER QUEENZEE holds the meta-DB lock — refusing to double-drive the fleet. Exiting.');
      process.exit(1);
    }
    console.log('[zeehive] waiting for the previous queenzee to release the meta-DB lock…');
    await new Promise((res) => setTimeout(res, 2000));
  }
}

// Schema first, serve second (spec §6.3): a self-ship replaces the process, so the restart is
// the deploy — the new code must bring its own meta-DB schema up before anything queries it.
// A failed migration is loud but NOT fatal: files are per-transaction (earlier ones stick), and
// a queenzee that stays up degraded beats one that exits (see the backstop note above).
try {
  await runMigrations();
} catch (e) {
  console.error('[zeehive] BOOT MIGRATIONS FAILED (staying up on the schema we have):', e.message);
  try { logline('api', `boot migrations FAILED: ${e.message}`); } catch { /* logbus needs the db too */ }
}

const server = app.listen(config.port, () => {
  console.log(`[zeehive] API on http://localhost:${config.port}  (db: ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')})`);
  startPoller();
  console.log(`[queenzee] poller started (${config.pollerIntervalMs}ms)`);
  logline('api', `queenzee online — API on :${config.port}, DB connected`);
  // BEFORE the monitors: a build in flight when we died left its container pinned at 'building',
  // which the health monitor skips by design — so nothing would ever un-stick it. Same for a
  // ship stranded at 'shipping' — including the SELF-ship that deliberately restarted us, which
  // this call is what marks 'shipped' (spec §6.3).
  recoverOrphanBuilds().catch((e) => console.error('[build] orphan recovery failed:', e.message));
  recoverOrphanShips().catch((e) => console.error('[ship] orphan recovery failed:', e.message));
  // Same principle for teardowns: a xell stranded at 'tearing-down' by a mid-reap death renders
  // on the dashboard forever (only 'retired' is filtered out) and nothing else revisits it.
  recoverOrphanTeardowns().catch((e) => console.error('[reaper] teardown recovery failed:', e.message));
  startPool();
  startMonitor();
  startContainerMonitor();
  startMaintenance();
  startShipReaper();
  startLandReaper();
  startLandingPad();
  startImageJanitor();
  startProdDiff();
  startDbCloneWatch();
});
// Browser terminal into caged zees: ws ↔ SSH-PTY on the SAME http server, so it rides the
// existing /api proxy (vite dev + the prod nginx bundle) with no extra port to expose.
attachTerminalBridge(server);
export { app };
