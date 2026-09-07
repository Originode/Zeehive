// ZEEHIVE server: HTTP API + queenzee loops (poller now; pool/maintenance added in later steps).
import express from 'express';
import { config } from './config.js';
import { router, a2aRouter } from './api/routes.js';
import { startPoller } from './queenzee/poller.js';
import { startPool } from './queenzee/pool.js';
import { startMaintenance } from './queenzee/maintenance.js';
import { startMonitor } from './queenzee/monitor.js';
import { startContainerMonitor } from './queenzee/containers.js';
import { startContextReconcile } from './queenzee/context-reconcile-loop.js';
import { startProdDiff } from './queenzee/proddiff.js';
import { startDbCloneWatch } from './queenzee/dbclone.js';
import { startWorkSync } from './queenzee/worksync.js';
import { startHeldDoneReaper } from './queenzee/done-held.js';
import { recoverOrphanBuilds } from './lib/build.js';
import { reconcileXellEnvs } from './lib/provision.js';
import { refreshMedicRoleAtBoot } from './lib/medic-role.js';
import { runMigrations } from './db/migrate.js';
import { ensureSelfProject } from './lib/self-onboard.js';
import { logHarnessSummary } from './lib/harness.js';
import { startHarnessBridge } from './lib/harness-bridge.js';
import { pool, q } from './db/pool.js';
import { startShipReaper, recoverOrphanShips } from './queenzee/shipgate.js';
import { recoverOrphanTeardowns } from './queenzee/reaper.js';
import { attachTerminalBridge } from './lib/terminal-bridge.js';
import { startPreviewPorts } from './lib/preview-ports.js';
import { attachStreamWebSocket } from './lib/stream.js';
import { gatewayProxy, gatewayHello, gatewayHealth, GATEWAY_PORT, verifyGatewayReachable } from './lib/gateway.js';
import { refreshZeeLiveInLiveCxells, cxellName } from './lib/cxell.js';
import { startLandReaper } from './queenzee/landgate.js';
import { startLandingPad } from './queenzee/landingpad.js';
import { startRevive } from './queenzee/revive.js';
import { startCxellRecovery } from './queenzee/cxell-recover.js';
import { startSpinDetector } from './queenzee/spin.js';
import { startImageJanitor } from './lib/images.js';
import { startDockerJanitor } from './lib/docker-repair.js';
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
  // Authorization + PATCH/DELETE are here for the EXTERNAL ticketing API (/api/ext/v1, migration
  // 190): an integration that calls it from a browser sends a bearer key and PATCHes its ticket,
  // and a preflight that omits either fails the call with no server-side trace at all. It grants
  // nothing — every /ext/v1 route authenticates the key itself.
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Zeehive-Api-Key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'zeehive', ts: Date.now() }));
// The A2A read side (P2) — mounted at the ORIGIN ROOT (not under /api), because
// /.well-known/agent-card.json is RFC 8615 origin-root and the /a2a/v1 paths are the wire contract.
app.use(a2aRouter);
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
//
// QUEENZEE_INPROC=false (API-only) SKIPS this lock entirely: an API instance holds no lock and
// drives no fleet, so it is startable on a meta-DB where THE queenzee already holds it — the
// db-shared-dev spinoff case, where the 90s wait + restart loop is exactly what a verification
// server hits today (TKT-136-FE32 / TKT-137-F266). The lock stays a property of the loop-runner.
if (config.queenzeeInproc) {
  const LOCK_KEY = 715533001; // arbitrary constant: "the queenzee of this meta-DB"
  const client = await pool.connect(); // deliberately never released
  const START_TIME = Date.now(); // ≈ this boot; a lock holder older than this predates us
  const deadline = START_TIME + 90000;
  const ghostSweepAt = Date.now() + 10000; // give a live holder a moment before suspecting ghosts
  let ghostSwept = false;
  for (;;) {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
    if (r.rows[0].got) break;
    // GHOST HOLDERS (outage 2026-08-08): force-removed server containers leave postgres backends
    // behind that still hold this advisory lock — and docker reuses IPs, so the ghost can share
    // the NEW server's own address. A ghost is provably dead when it connects from OUR address
    // but predates OUR boot: the previous tenant of this IP. Terminate exactly those, loudly.
    // A holder from a DIFFERENT address is never touched — a legitimate second queenzee must
    // still be refused; that is this guard's whole point.
    if (!ghostSwept && Date.now() > ghostSweepAt) {
      ghostSwept = true;
      try {
        const g = await client.query(
          `SELECT a.pid, a.client_addr::text AS addr, a.backend_start,
                  pg_terminate_backend(a.pid) AS terminated
             FROM pg_locks l
             JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory'
              AND l.classid = ($1::bigint >> 32)::int
              AND l.objid   = ($1::bigint & x'FFFFFFFF'::bigint)::int
              AND l.granted
              AND a.pid <> pg_backend_pid()
              AND a.client_addr IS NOT NULL              -- unix-socket holders are NOT provable
              AND a.client_addr = inet_client_addr()     -- ghosts share OUR (reused) address
              AND a.backend_start < to_timestamp($2::double precision / 1000)`,
          [LOCK_KEY, START_TIME],
        );
        for (const row of g.rows) {
          console.error(`[zeehive] terminating ghost lock holder pid ${row.pid} — same address as us (${row.addr}), backend_start ${row.backend_start.toISOString?.() ?? row.backend_start} predates this boot`);
        }
        if (!g.rows.length) console.log('[zeehive] lock holder is not a provable ghost (different address or newer than this boot) — waiting it out');
      } catch (e) {
        console.error('[zeehive] ghost lock sweep failed (waiting the full 90s instead):', e.message);
      }
    }
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
  // Fresh run (zero projects) → ZEEHIVE onboards itself before anything else looks at the
  // fleet (self-onboard.js). Loud-but-never-fatal, like the migrations above.
  await ensureSelfProject();
  // A harness is entirely in the meta-DB now (080 text, 082 badge) — there is nothing to load, and no
  // repo to fail to find. What is still worth doing at boot: SAY what the rows actually carry, because
  // a harness that would brief a zee with a blank page is invisible otherwise.
  await logHarnessSummary();
} catch (e) {
  console.error('[zeehive] BOOT MIGRATIONS FAILED (staying up on the schema we have):', e.message);
  try { logline('api', `boot migrations FAILED: ${e.message}`); } catch { /* logbus needs the db too */ }
}

// Bind 0.0.0.0 explicitly: a process-role spinoff must answer on the queenzee's published
// interface (the hostname CXELL_API_BASE resolves to from a cage), not only on loopback.
// Default listen(port) is usually dual-stack, but an IPv6-only :: with ipv6only=1 was one of
// the ways TKT-136 defect #2 left the published host:port refusing while localhost answered.
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[zeehive] API on http://0.0.0.0:${config.port}  (db: ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')})`);
  if (!config.queenzeeInproc) {
    // API-ONLY (QUEENZEE_INPROC=false): no single-queenzee lock, no background loops, and NONE of
    // the boot reconciles that assume this process is THE queenzee (recoverOrphan*, the cxell
    // renderer sweep, reconcileXellEnvs) — those would fight the real lock-holder on a shared
    // meta-DB and double-drive the fleet. Serving routes is the whole job (TKT-136-FE32/TKT-137-F266).
    console.log('[queenzee] loops DISABLED (QUEENZEE_INPROC=false) — API-only: no advisory lock, no background loops, no boot reconciles');
    logline('api', `queenzee API-ONLY (QUEENZEE_INPROC=false) — routes on :${config.port}, no lock, no loops`);
    return;
  }
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
  // The attend path's renderer is BAKED into the zee-agent image, and only the spawn path replaced
  // it — so every cxell created before an attend-path ship kept the old one, and the terminal's
  // ✱/⚒ feed chips wrote a view file nothing in there was watching. Boot is also the moment after
  // a ship (we restart into the new code), so sweep the RUNNING cxells here. A live cxell is one
  // whose zee still has an ssh-terminal viewer; the sweep is best-effort per cage.
  refreshZeeLiveInLiveCxells(async () => (await q(
    `SELECT DISTINCT x.slug
       FROM zee z JOIN xell x ON x.id = z.xell_id
      WHERE z.viewer_kind = 'ssh-terminal'
        AND z.decommissioned_at IS NULL
        AND x.status NOT IN ('retired', 'tearing-down')`
  )).map((r) => ({ ctx: 'default', name: cxellName(r.slug) })))
    .catch((e) => console.error('[cxell] live-feed renderer sweep failed:', e.message));
  // Same shape, for the OTHER file the queenzee projects into a worktree: .zeehive.env is written
  // from the meta-DB at provision time and never re-emitted on its own, so a fix to the projection
  // RULE (ticket #15: a xell holding production read-only kept its dev vars and its own spinoff db)
  // left every xell provisioned before it wrong forever, with a human expected to remember. Boot is
  // exactly when a rule change arrives, so recompute every non-retired xell here and write only the
  // ones that are provably stale (lib/provision.reconcileXellEnvs).
  reconcileXellEnvs({ reason: 'boot' })
    .catch((e) => console.error('[env] .zeehive.env reconcile failed:', e.message));
  // The medic role's GRANTs move with the schema (a table created since the last mint is not
  // covered by an old blanket grant), and boot is exactly when a schema change arrives — so
  // re-mint here. Best-effort: a failed mint retries lazily on first medic use (medic-role.js),
  // and MEDICRW_MODE=simulate mints nothing (the nested-queenzee contract).
  refreshMedicRoleAtBoot();
  // AND THE RECONCILE FOR THE MACHINE ITSELF. The app tier restarts with the host; the CXELLS DO
  // NOT (intake runs them with no restart policy, deliberately — a cage dockerd brought back would
  // have no firewall and no ssh door, because both are runtime state inside its namespace). So the
  // queenzee restarts them here, in the only safe order — start, re-open sshd, RE-SEAL — and then
  // releases the turn lock the reboot left on every zee that was mid-turn, filing it as the
  // transient death it was so the existing revive ladder reconnects the session
  // (queenzee/cxell-recover.js). Also a slow loop, for the cage that stops later.
  startCxellRecovery();
  startPool();
  startMonitor();
  startContainerMonitor();
  startContextReconcile();
  startMaintenance();
  startShipReaper();
  startLandReaper();
  startLandingPad();
  // A turn the PROVIDER cut (429 / 529 / a connection closed mid-response) is resumed automatically
  // on a 5/15/45-minute ladder; a turn a dead CREDENTIAL cut is never resumed and raises a human
  // naming the account (queenzee/revive.js).
  startRevive();
  // A per-turn budget from the gateway ledger: end a turn that is burning tokens on a poll loop and
  // tell its manager (queenzee/spin.js — the interim alarm; the lease/await model is the cure).
  startSpinDetector();
  startImageJanitor();
  // What best-effort reap-time cleanup misses (a context down, a killed queenzee) becomes a
  // wedged daemon: retired xells' spin networks exhaust the address pools and husks squat host
  // ports (TKT-178 / TKT-85). This sweep auto-performs ONLY docker-repair's two provably-
  // throwaway step kinds; everything else stays a medic/human call (netbird-mesh-plan DR-2).
  startDockerJanitor();
  startProdDiff();
  startDbCloneWatch();
  // The work tracker's board follows the fleet: every item with a zee on it takes that zee's live
  // hive status (worksync.js). It only ever moves a card BETWEEN the in-flight statuses — finishing
  // is a human's decision, never a tick's.
  startWorkSync();
  // A done approval that landed mid-turn is HELD ('approved-held') and applied here the moment the
  // turn ends — without it a finished xell holds its slot (containers + db) until a human notices
  // (ticket #75). Small and independent: a bad tick never touches another loop.
  startHeldDoneReaper();
  startHarnessBridge();
});
// THE LLM GATEWAY — the transparent LiteLLM-style door every cxell CLI points its base URL at.
// A SEPARATE http listener (gateway.js), so /v1/messages + /v1/chat/completions can never shadow
// an API route and the gateway's port stays distinct from the API's. Mounted with express.json
// (the proxy reads req.body for the model name) and the gateway proxy for the two dialect paths.
// Bind 0.0.0.0 like the API so a process-role spinoff answers on the published interface.
if (config.gatewayPort !== config.port) {
  const gatewayApp = express();
  gatewayApp.use(express.json({ limit: '30mb' }));
  gatewayApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Zeehive-Provider');
    res.header('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // The CLI's connectivity probe + the two dialect POSTs. The probe and the calls carry the
  // /x/<xellToken>/<provider> prefix (measured: claude preserves the base-url path prefix), so
  // express mounts a wildcard; gatewayProxy parses the identity/provider from req.url.
  gatewayApp.get('/api/hello', gatewayHello);
  gatewayApp.head('/api/hello', gatewayHello);
  // The gateway's SIGNATURE route — the reachability probe's identification half. Tiny, no auth,
  // no provider path: it exists so the probe can tell "the port serves a server" apart from "the
  // port serves OUR gateway", without ever turning an answering address into a refusal.
  gatewayApp.get('/_gw/health', gatewayHealth);
  gatewayApp.all('/x/*', gatewayProxy);
  gatewayApp.use((_req, res) => res.status(404).json({ error: 'gateway: expected /x/<xell-token>/<provider>/v1/…' }));
  const gatewayServer = gatewayApp.listen(GATEWAY_PORT, '0.0.0.0', () => {
    console.log(`[zeehive] LLM gateway on http://0.0.0.0:${GATEWAY_PORT}  (cxells point their provider base-urls here)`);
    logline('api', `LLM gateway online — :${GATEWAY_PORT} (/v1/messages, /v1/chat/completions)`);
    // STARTUP PROBE (TKT-179): prove the gateway address a cage will actually be handed, once,
    // before any dispatch — the incident was a gateway that answered on 127.0.0.1:4701 inside the
    // container but whose port was NOT published, so every cage got host.docker.internal:4701 and
    // every provider failed with the vendor's words for 13h. Best-effort: logs the verdict loudly,
    // never crashes the boot (the dispatch path still refuses per-mint if the state persists).
    void verifyGatewayReachable();
  });
  gatewayServer.on('error', (e) => {
    console.error(`[zeehive] LLM gateway could not bind :${GATEWAY_PORT} — ${e.message}`);
    logline('api', `LLM gateway bind FAILED :${GATEWAY_PORT} — ${e.message}`);
  });
}
// Browser terminal into cxell zees: ws ↔ SSH-PTY on the SAME http server, so it rides the
// existing /api proxy (vite dev + the prod nginx bundle) with no extra port to expose.
attachTerminalBridge(server);
// Xell webapp preview: keep every xell webapp's port answering on this container's external
// interface (docker's published ranges carry it to the host) — lib/preview-ports.js. Websockets
// need no special handling: the direct port carries them natively.
startPreviewPorts();
// The dashboard's live stream over a websocket: /api/stream/ws on the same server, so the same
// ws-aware proxies carry it. The SSE /api/stream route stays for old clients; the console
// prefers this channel (docs/live-stream-websocket-decision-record.md).
attachStreamWebSocket(server);
export { app };
