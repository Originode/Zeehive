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
import { startShipReaper, recoverOrphanShips } from './queenzee/shipgate.js';
import { startLandReaper } from './queenzee/landgate.js';
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

app.listen(config.port, () => {
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
  startPool();
  startMonitor();
  startContainerMonitor();
  startMaintenance();
  startShipReaper();
  startLandReaper();
  startImageJanitor();
  startProdDiff();
  startDbCloneWatch();
});
export { app };
