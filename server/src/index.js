// XEEHIVE server: HTTP API + queenzee loops (poller now; pool/maintenance added in later steps).
import express from 'express';
import { config } from './config.js';
import { router } from './api/routes.js';
import { startPoller } from './queenzee/poller.js';
import { startPool } from './queenzee/pool.js';
import { startMaintenance } from './queenzee/maintenance.js';
import { startMonitor } from './queenzee/monitor.js';
import { startContainerMonitor } from './queenzee/containers.js';
import { logline } from './lib/logbus.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// permissive CORS for the local Vite dev app + localhost hooks
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'xeehive', ts: Date.now() }));
app.use('/api', router);

app.listen(config.port, () => {
  console.log(`[xeehive] API on http://localhost:${config.port}  (db: ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')})`);
  startPoller();
  console.log(`[queenzee] poller started (${config.pollerIntervalMs}ms)`);
  logline('api', `queenzee online — API on :${config.port}, DB connected`);
  startPool();
  startMonitor();
  startContainerMonitor();
  startMaintenance();
});
export { app };
