// All HTTP routes: hooks sink, read models, SSE stream, xell claim, task intake.
import { Router } from 'express';
import { q, one } from '../db/pool.js';
import { projectHook } from '../lib/status.js';
import { getFleet, listRuntimes } from '../lib/fleet.js';
import { getTimeline, getDiffs } from '../lib/timeline.js';
import { recentLogs } from '../lib/logbus.js';
import { bus, broadcast } from '../lib/events.js';
import { claimXell, dispatchXell, DISPATCH_MODES } from '../queenzee/intake.js';
import { markTaskDone, createTask } from '../queenzee/tasks.js';
import { backupProd, refreshStaleXellDbs, setBackupConfig, revealBackup, restoreBackup } from '../queenzee/maintenance.js';
import { monitorTick } from '../queenzee/monitor.js';
import { checkContainers } from '../queenzee/containers.js';
import { buildContainer, buildXell } from '../lib/build.js';
import { revealXellWorktree } from '../lib/reveal.js';
import { reapXell } from '../queenzee/reaper.js';
import { attachXellDb, DB_MODES } from '../lib/xell-db.js';
import { remoteAvailable } from '../lib/claude-cli.js';
import { acquireProdLock, releaseProdLock, prodLockStatus } from '../queenzee/deploylock.js';
import { proposeDone, xellStatus } from '../queenzee/tasks.js';
import { listProjects, createProject, deleteProject } from '../lib/projects.js';

export const router = Router();

// ── Channel A: harness hook sink (deterministic, model-independent) ──────────
router.post('/hooks', async (req, res) => {
  // Respond fast; hooks fire with async:true and don't need a body.
  res.status(202).json({ ok: true });
  try {
    await projectHook(req.body || {});
  } catch (err) {
    console.error('[hooks] projection error:', err.message);
  }
});

// ── read models ──────────────────────────────────────────────────────────────
router.get('/fleet', async (req, res) => {
  const fleet = await getFleet(req.query.project || null);
  if (!fleet) return res.status(404).json({ error: 'no project' });
  res.json(fleet);
});

router.get('/projects', async (_req, res) => res.json(await listProjects()));

// ── project management (add / remove via the header project menu) ─────────────
router.post('/projects', async (req, res) => {
  try { res.json(await createProject(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/projects/:id', async (req, res) => {
  try { res.json(await deleteProject(req.params.id, req.query.force === '1')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
router.get('/xells', async (_req, res) => res.json(await q(`SELECT * FROM xell WHERE status <> 'retired' ORDER BY created_at`)));
router.get('/zees', async (_req, res) => res.json(await q(`SELECT * FROM zee ORDER BY created_at DESC`)));
router.get('/containers', async (_req, res) => res.json(await q(`SELECT * FROM container ORDER BY role, tier, name`)));
router.get('/runtimes', async (_req, res) => res.json(await listRuntimes()));

router.get('/git/timeline', async (req, res) => {
  const t = await getTimeline(req.query.project || null, Number(req.query.n) || 30);
  if (!t) return res.status(404).json({ error: 'no project' });
  res.json(t);
});
router.get('/xell/diffs', async (req, res) => res.json(await getDiffs(req.query.project || null)));

// queenzee activity log (the terminal modal)
router.get('/logs', async (req, res) => res.json(recentLogs(Number(req.query.n) || 200)));

router.get('/zees/:id/events', async (req, res) =>
  res.json(await q(`SELECT * FROM session_event WHERE zee_id = $1 ORDER BY ts DESC LIMIT 200`, [req.params.id])));

// ── /xell skill → claim a ready xell, but ONLY if the session is inside its worktree ──
router.post('/xell/claim', async (req, res) => {
  try {
    const binding = await claimXell(req.body || {});
    res.json(binding);
  } catch (err) {
    // Not standing in a worktree → 409 with actionable detail; no claim, so no work begins.
    if (err.code === 'NEEDS_WORKTREE') return res.status(409).json({ status: 'needs-worktree', ...err.detail });
    // The invoker's cwd is in no known project → refuse rather than guess one for it.
    if (err.code === 'UNKNOWN_PROJECT') return res.status(409).json({ ...err.detail, error: err.message });
    res.status(409).json({ status: 'error', error: err.message });
  }
});

// ── /xell dispatch → queenzee spawns a zee INTO a ready worktree (confirmed) ───
router.post('/xell/dispatch', async (req, res) => {
  try { res.json(await dispatchXell(req.body || {})); }
  catch (err) { res.status(400).json({ ...(err.detail || {}), error: err.message }); }
});
// Re-point a xell's database: { coupling: db-shared-dev|db-shared-prod|db-isolated,
// container: <name|id>, dump: <snapshot id|'latest'> }. db-shared-prod is LIVE production.
router.post('/xells/:id/db', async (req, res) => {
  try { res.json(await attachXellDb(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/xell/db-modes', (_req, res) =>
  res.json(Object.entries(DB_MODES).map(([key, label]) => ({ key, label }))));

// the autonomy scale a dispatch can pick from (1=recon … 5=bypass)
router.get('/xell/modes', (_req, res) =>
  res.json(Object.entries(DISPATCH_MODES).map(([n, m]) => ({ mode: Number(n), key: m.key, permission_mode: m.permissionMode, tools: m.tools || 'all', label: m.label }))));

// ── pool size: how many ready (pre-warmed) xells the queenzee keeps per project ─
router.post('/pool/config', async (req, res) => {
  const n = Number(req.body?.target_ready);
  if (!Number.isInteger(n) || n < 0 || n > 50) {
    return res.status(400).json({ error: 'target_ready must be an integer 0–50' });
  }
  const proj = req.body?.project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
  const row = await one(`UPDATE pool_config SET target_ready=$2 WHERE project_id=$1 RETURNING target_ready`, [proj, n]);
  if (!row) return res.status(404).json({ error: 'no pool_config for project' });
  broadcast('project', { id: proj, target_ready: row.target_ready });
  res.json({ ok: true, target_ready: row.target_ready });
});

// ── runtime toggle: set the pool's default runtime (what queenzee spawns next) ─
router.post('/pool/runtime', async (req, res) => {
  const key = req.body?.runtime;
  const rt = await one(`SELECT id, key, label FROM agent_runtime WHERE key=$1 AND enabled`, [key]);
  if (!rt) return res.status(400).json({ error: 'unknown/disabled runtime' });
  const proj = req.body?.project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
  await q(`UPDATE pool_config SET default_runtime_id=$2 WHERE project_id=$1`, [proj, rt.id]);
  res.json({ ok: true, default_runtime: rt.key });
});

// ── monitoring: is a session REALLY active (per the claude CLI)? ──────────────
router.post('/monitor/run', async (_req, res) => res.json(await monitorTick()));
router.get('/monitor/remote', async (_req, res) => res.json(remoteAvailable()));

// ── container health: is each container actually running (per `docker ps`)? ───
router.post('/containers/check', async (_req, res) => res.json(await checkContainers()));

// ── build: (re)build a per-xell server/webapp container (or a whole xell's stack) ──
router.post('/containers/:id/build', async (req, res) => {
  try { res.json(await buildContainer(req.params.id, { hot: !!req.body?.hot })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xells/:id/build', async (req, res) => {
  try {
    const role = req.body?.role && req.body.role !== 'all' ? req.body.role : null;
    res.json(await buildXell(req.params.id, { hot: !!req.body?.hot, role }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── decommission a xell directly (no task row required) ───────────────────────
// The "Mark done" path goes through the task, but a xell can exist WITHOUT one (a dispatched
// zee that reported done, a pooled xell gone bad). Without this those strand forever: no task
// means no button, and nothing ever reaps them. Production is refused by reapXell itself.
router.post('/xells/:id/reap', async (req, res) => {
  try { res.json(await reapXell(req.params.id, req.body?.reason || 'human-cleanup', { force: !!req.body?.force })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── reveal a xell's worktree folder in the host file manager (Explorer) ────────
router.post('/xells/:id/reveal', async (req, res) => {
  try { res.json(await revealXellWorktree(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── task intake + human "done" (triggers the reaper) ─────────────────────────
router.post('/tasks', async (req, res) => {
  try {
    res.json(await createTask(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.post('/tasks/:id/done', async (req, res) => {
  try {
    res.json(await markTaskDone(req.params.id, req.body?.done_by || 'human', { force: !!req.body?.force }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── AI-facing: report/propose the job is done, and query status ──────────────
router.post('/xell/report-done', async (req, res) => {
  try { res.json(await proposeDone(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/xell/status', async (req, res) => {
  const s = await xellStatus(req.query || {});
  if (!s) return res.status(404).json({ error: 'xell/session not found' });
  res.json(s);
});

// ── production deploy lock (padlock in the UI) ───────────────────────────────
router.post('/prod-lock/acquire', async (req, res) => {
  try { res.json(await acquireProdLock(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/prod-lock/release', async (req, res) => {
  try { res.json(await releaseProdLock(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/prod-lock', async (req, res) => {
  const proj = req.query.project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
  res.json((await prodLockStatus(proj)) || { held: false });
});

// ── maintenance (manual triggers; the scheduler runs these on a cadence too) ──
router.post('/maintenance/backup', async (req, res) => {
  const proj = req.body?.project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
  res.json(await backupProd(proj));
});
router.post('/maintenance/refresh', async (req, res) => {
  const proj = req.body?.project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
  res.json(await refreshStaleXellDbs(proj));
});

// ── prod DB backups (the backup panel: last-backup label, settings cog, all-backups modal) ──
router.get('/backups', async (req, res) => {
  const proj = req.query.project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
  const cfg = await one(
    `SELECT backup_dir, backup_interval_sec, max_backups FROM pool_config WHERE project_id=$1`, [proj]);
  const backups = await q(
    `SELECT id, dump_path, size_bytes, taken_at, source, status, error FROM db_snapshot
       WHERE project_id=$1 AND source='prod' ORDER BY taken_at DESC`, [proj]);
  // db containers a backup may be restored INTO (prod excluded — never restore over production);
  // busy_since/busy_op tell the modal which target is mid-restore.
  const targets = await q(
    `SELECT id, name, tier, busy_since, busy_op FROM container
       WHERE project_id=$1 AND role='db' AND tier <> 'prod' ORDER BY tier, name`, [proj]);
  res.json({ config: cfg, backups, targets });
});
router.post('/backups/config', async (req, res) => {
  try { res.json(await setBackupConfig(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/backups/run', async (req, res) => {
  const proj = req.body?.project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
  try { res.json(await backupProd(proj)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/backups/:id/reveal', async (req, res) => {
  try { res.json(await revealBackup(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// restore a backup INTO a db container (spins that container until done)
router.post('/backups/:id/restore', async (req, res) => {
  try { res.json(await restoreBackup({ snapshot: req.params.id, container: req.body?.container })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── live stream (SSE) ─────────────────────────────────────────────────────────
router.get('/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  // initial snapshot so a fresh client renders immediately
  const fleet = await getFleet(req.query.project || null);
  res.write(`event: snapshot\ndata: ${JSON.stringify(fleet)}\n\n`);

  const onEvent = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
});
