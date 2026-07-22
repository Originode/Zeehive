// All HTTP routes: hooks sink, read models, SSE stream, xell claim, task intake.
import { Router } from 'express';
import { q, one } from '../db/pool.js';
import { projectHook } from '../lib/status.js';
import { getFleet, getFleetBurn, listRuntimes, streamXells } from '../lib/fleet.js';
import { getTimeline, getDiffs } from '../lib/timeline.js';
import { recentLogs } from '../lib/logbus.js';
import { bus, broadcast } from '../lib/events.js';
import { claimXell, dispatchXell, DISPATCH_MODES, PERMISSION_MODES, setZeeMode, listDispatchModels } from '../queenzee/intake.js';
import { markTaskDone, createTask } from '../queenzee/tasks.js';
import { backupProd, refreshStaleXellDbs, setBackupConfig, revealBackup, restoreBackup } from '../queenzee/maintenance.js';
import { monitorTick } from '../queenzee/monitor.js';
import { checkContainers, decommissionContainer } from '../queenzee/containers.js';
import { buildContainer, buildXell, getBuildStatus, setContainerBuildCtx, setXellBuildCtx } from '../lib/build.js';
import { listMachines, createMachine, updateMachine, deleteMachine, provisionDevDb, setMachinePool } from '../lib/machines.js';
import { attachDeviceXhip, detachDeviceXhip, registerPhysicalDevice, provisionAdbHost, listUsbDevices } from '../lib/devices.js';
import { emitXellEnv } from '../lib/provision.js';
import { revealXellWorktree } from '../lib/reveal.js';
import { reapXell, purgeDevXells } from '../queenzee/reaper.js';
import { attachXellDb, dbAccessForCwd, DB_MODES } from '../lib/xell-db.js';
import { attachProdStack, detachProdStack, prodStackStatus } from '../lib/xell-prod.js';
import { remoteAvailable } from '../lib/claude-cli.js';
import { prodLockStatus } from '../queenzee/deploylock.js';
import { proposeDone, xellStatus } from '../queenzee/tasks.js';
import { listProjects, createProject, updateProject, deleteProject,
         getProjectManifest, refreshProjectManifest, draftProjectManifest,
         probeRepo, listDirs, projectReadiness, getPoolConfig, updatePoolConfig,
         cloneProject, pullProject } from '../lib/projects.js';
import { probeRemote } from '../lib/remote-git.js';
import { listHostMounts, mountHostFolder } from '../lib/self-mount.js';
import { config } from '../config.js';
import { listSites, createSite, updateSite, deleteSite, listDockerContexts } from '../lib/sites.js';
import { listProviderTokens, setProviderToken, addProviderToken, deleteProviderToken,
         deleteProviderAccount } from '../lib/provider-tokens.js';
import { listSharedContainers, createSharedContainer, updateSharedContainer, deleteSharedContainer }
  from '../lib/inventory.js';
import { checkPush, listLandRequests, decideLandRequest, dismissLandRequest, landStatus } from '../queenzee/landgate.js';
import { buildLandingPad } from '../queenzee/landingpad.js';
import { pushToXource, pullFromXource, requestPullIn, acceptPullIn } from '../queenzee/xellgit.js';
import { nudgeXellForStatus } from '../queenzee/nudge.js';
import { ooneyCheck } from '../queenzee/ooney.js';
import { applyMigrationsToXell } from '../queenzee/shipmigrate.js';
import { requestShip, listShipRequests, decideShip, shipStatus, holdProdLock, forceReleaseProdLock,
  dismissShipRequest } from '../queenzee/shipgate.js';
import { xellForToken } from '../lib/xell-token.js';
import { selfStatus, selfLand, selfShip, selfProdRequest, selfDone, selfBuild, selfBuildStatus,
         selfTend, selfWorking, selfDevice, listProdBindRequests, decideProdBind } from '../queenzee/self.js';

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

// ── Channel B: the landing gate (the xource's `update` hook calls this synchronously) ────────
//
// This is the ONLY endpoint a blocked push waits on, so it must answer fast and it must never
// throw a bare 500 that the hook can't read. The hook fails closed on anything unexpected; we
// still return an explicit allow:false so the zee gets a useful reason instead of a timeout.
router.post('/land/check', async (req, res) => {
  const { project_id, ref, old, new: newSha } = req.body || {};
  if (!project_id || !ref || !newSha) return res.status(400).json({ allow: false, reason: 'bad-request' });
  try {
    res.json(await checkPush({ projectId: project_id, ref, oldSha: old, newSha }));
  } catch (err) {
    console.error('[landgate] check failed:', err.message);
    res.status(500).json({ allow: false, reason: 'gate-error', error: err.message });
  }
});

// What a waiting zee polls (xell-land.mjs --wait) — its exit is the zee's nudge. Mirrors
// /ship/status, which has existed since 010; landing had no equivalent, so an approved zee had no
// way to find out and sat blind.
router.get('/land/status', async (req, res) => {
  if (!req.query.xell) return res.status(400).json({ error: 'xell query param required' });
  const s = await landStatus(req.query.xell);
  if (!s) return res.status(404).json({ error: 'no land request for this xell' });
  res.json(s);
});

router.get('/land/requests', async (req, res) => {
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  res.json(await listLandRequests(req.query.project, { open: req.query.all !== '1' }));
});

// A HUMAN approves/rejects. There is deliberately no self-approval path for a zee: nothing in
// the skill, the MCP server or the dispatch prompt knows this route exists.
router.post('/land/requests/:id/:decision(approve|reject)', async (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approved' : 'rejected';
  try {
    res.json(await decideLandRequest(req.params.id, decision, req.body?.by || 'human@console'));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Dismiss a decided request's receipt — durable (a reload does not resurrect it). Visibility
// only: the reaper keeps landing/staling the row on its own schedule.
router.post('/land/requests/:id/dismiss', async (req, res) => {
  try { res.json(await dismissLandRequest(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// ── Channel C: shipping to production (the zee asks; the queenzee ships) ─────
//
// The zee's ONLY prod verb. It cannot take the lock and cannot run a deploy: approving is a human
// act, and the build is the queenzee's, from the xource at main.
router.post('/ship/request', async (req, res) => {
  const { xell_id, zee_id, reason } = req.body || {};
  if (!xell_id) return res.status(400).json({ error: 'xell_id required' });
  try { res.json(await requestShip({ xellId: xell_id, zeeId: zee_id || null, reason: reason || null,
                                     targets: req.body?.targets || null, site: req.body?.site || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/ship/requests', async (req, res) => {
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  res.json(await listShipRequests(req.query.project, { open: req.query.all !== '1' }));
});

// What a waiting zee polls (xell-ship.mjs --wait) — its exit is the zee's nudge.
router.get('/ship/status', async (req, res) => {
  if (!req.query.xell) return res.status(400).json({ error: 'xell required' });
  const s = await shipStatus(req.query.xell);
  if (!s) return res.status(404).json({ error: 'no ship request for this xell' });
  res.json(s);
});

router.post('/ship/requests/:id/:decision(approve|reject)', async (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approved' : 'rejected';
  try {
    res.json(await decideShip(req.params.id, decision, req.body?.by || 'human@console',
      { siteId: req.body?.site_id || undefined }));
  } catch (err) { res.status(409).json({ error: err.message }); }
});

// Dismiss a shipped/failed ship card's receipt (visibility only; the ship itself is unchanged).
router.post('/ship/requests/:id/dismiss', async (req, res) => {
  try { res.json(await dismissShipRequest(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// Lock lifecycle — both HUMAN-only. Hold stops the auto-release countdown; force release takes
// prod back from whoever has it.
router.post('/prod-lock/hold', async (req, res) => {
  if (!req.body?.project) return res.status(400).json({ error: 'project required' });
  try { res.json(await holdProdLock(req.body.project, req.body.by || 'human@console', req.body.site || null)); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

router.post('/prod-lock/force-release', async (req, res) => {
  if (!req.body?.project) return res.status(400).json({ error: 'project required' });
  try { res.json(await forceReleaseProdLock(req.body.project, req.body.by || 'human@console', req.body.site || null)); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// ── read models ──────────────────────────────────────────────────────────────
// The meta-DB is on the NAS, so a network blip makes this throw. Express 4 does NOT catch a
// rejected async handler: it became an unhandled rejection and KILLED the whole queenzee —
// pool, monitor and ship reaper with it — on 2026-07-15, from one ETIMEDOUT. The loops all
// catch their own errors; this route was the hole. A read model that fails must 503, not
// take the orchestrator down with it.
router.get('/fleet', async (req, res) => {
  try {
    const fleet = await getFleet(req.query.project || null);
    if (!fleet) return res.status(404).json({ error: 'no project' });
    res.json(fleet);
  } catch (err) {
    console.error('[api] /fleet failed:', err.message);
    res.status(503).json({ error: `fleet unavailable: ${err.message}` });
  }
});

// The LANDING PAD read model on its own: landings + shipments as one chronological FIFO queue,
// with the item currently on the pad flagged. Also rides the /fleet snapshot (fleet.landing_pad);
// this standalone endpoint is for a client that wants just the queue. 503-not-throw like /fleet.
router.get('/landing-pad', async (req, res) => {
  try {
    res.json(await buildLandingPad(req.query.project || null));
  } catch (err) {
    console.error('[api] /landing-pad failed:', err.message);
    res.status(503).json({ error: `landing pad unavailable: ${err.message}` });
  }
});

// Lazy/streaming xell list: NDJSON, one line per xell, flushed as each xell's container stack
// resolves — so the honeycomb can paint a hexagon the moment its data lands instead of blocking on
// the whole fleet. First line is {type:'meta', project}; then {type:'xell', xell} per xell; a final
// {type:'end', count} closes it. Same rows + decoration as /fleet, just incremental. Never throws
// out (a read model must not take the queenzee down): an error becomes a JSON tail line.
router.get('/fleet/xells-stream', async (req, res) => {
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // belt-and-braces: never let a proxy buffer the stream
  });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  let count = 0;
  try {
    const project = await streamXells(req.query.project || null, async (x) => {
      send({ type: 'xell', xell: x });
      count += 1;
    });
    if (!project) { send({ type: 'error', error: 'no project' }); return res.end(); }
    // meta rides at the END (project already known) so the client gets xells as early as possible;
    // it carries the project id so a late client can confirm which project it streamed.
    send({ type: 'end', count, project: { id: project.id, name: project.name } });
  } catch (err) {
    console.error('[api] /fleet/xells-stream failed:', err.message);
    send({ type: 'error', error: err.message });
  }
  res.end();
});

// Fleet burn: per-xell token + $ consumption and a project-cumulative total, summed across every
// zee. Same 503-not-throw contract as /fleet (a read model must never take the queenzee down).
// NB: FLEET-OWN consumption only — Anthropic's account-wide %/limits are NOT surfaced here.
router.get('/fleet/burn', async (req, res) => {
  try {
    const burn = await getFleetBurn(req.query.project || null);
    if (!burn) return res.status(404).json({ error: 'no project' });
    res.json(burn);
  } catch (err) {
    console.error('[api] /fleet/burn failed:', err.message);
    res.status(503).json({ error: `fleet burn unavailable: ${err.message}` });
  }
});

router.get('/projects', async (_req, res) => res.json(await listProjects()));

// ── project management (add / remove via the header project menu) ─────────────
router.post('/projects', async (req, res) => {
  try { res.json(await createProject(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/projects/:id', async (req, res) => {
  try { res.json(await updateProject(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/projects/:id', async (req, res) => {
  try { res.json(await deleteProject(req.params.id, req.query.force === '1')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// ── GitHub inbound (migration 032): clone in, pull in — NEVER push ────────────
// Probe a REMOTE URL (before anything exists locally): reachable? default branch? private?
router.post('/projects/probe-remote', async (req, res) => {
  const probe = await probeRemote(req.body?.url, { token: req.body?.token });
  // the create form prefills the destination when the server has a repos home configured
  res.json({ ...probe, repos_dir: config.reposDir });
});
// Where the queenzee's own filesystem keeps repos. The onboard form's Folder / Clone-into hints
// speak THIS world: paths resolve on the server's filesystem, so a containerized queenzee sees
// /repos (its volume), never the operator's D:\ — the form must not suggest otherwise.
router.get('/projects/repos-home', (_req, res) => res.json({ repos_dir: config.reposDir }));
// The onboard form's folder picker: browse directories on the queenzee's own filesystem
// (listing only — names + git-repo marker; see lib/projects.js listDirs).
router.get('/fs/dirs', (req, res) => res.json(listDirs(req.query.path || null)));
// UI-driven host-folder mounts (containerized era): register the bind, then self-recreate via
// a sibling docker:cli helper so the folder appears under /repos (lib/self-mount.js).
router.get('/projects/host-mounts', (_req, res) => res.json(listHostMounts()));
router.post('/projects/mount-host', (req, res) => {
  try { res.json(mountHostFolder(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// New Project by clone: probe → git clone → the normal createProject seeding. Long request —
// the probe fails fast and both dev-proxy and prod nginx carry long reads.
router.post('/projects/clone', async (req, res) => {
  try { res.json(await cloneProject(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Human-triggered pull: fetch + ff-only merge of the recorded remote into the xource checkout.
// Refusals are {pulled:false, reason} with HTTP 200 — the console shows the reason.
router.post('/projects/:id/pull', async (req, res) => {
  try { res.json(await pullProject(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── deploy sites: where each tier runs + how it's reached (spec §5) ───────────
// The contexts list feeds the console's picker, so a typo'd context can't be entered at all.
router.get('/docker/contexts', (_req, res) => res.json(listDockerContexts()));
router.get('/projects/:id/sites', async (req, res) => res.json(await listSites(req.params.id)));
router.post('/projects/:id/sites', async (req, res) => {
  try { res.json(await createSite(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/sites/:id', async (req, res) => {
  try { res.json(await updateSite(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/sites/:id', async (req, res) => {
  try { res.json(await deleteSite(req.params.id, req.query.force === '1')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// ── provider accounts: per-project AI credentials for cxell zees ──────────────
// The read model is MASKED (hint + dates only); the full token never leaves the server —
// only the spawn path reads it, via tokenForSpawn(). A project can hold SEVERAL accounts of
// one provider type (036): POST adds one, DELETE …/account/:accountId removes one; the PUT
// keeps its legacy replace-in-place semantics for single-account types (github, scripts).
router.get('/projects/:id/tokens', async (req, res) => {
  try { res.json(await listProviderTokens(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/projects/:id/tokens', async (req, res) => {
  try { res.json(await addProviderToken(req.params.id, req.body?.provider, req.body?.token, req.body?.label)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/projects/:id/tokens/account/:accountId', async (req, res) => {
  try { res.json(await deleteProviderAccount(req.params.id, req.params.accountId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.put('/projects/:id/tokens/:provider', async (req, res) => {
  try { res.json(await setProviderToken(req.params.id, req.params.provider, req.body?.token)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/projects/:id/tokens/:provider', async (req, res) => {
  try { res.json(await deleteProviderToken(req.params.id, req.params.provider)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Regenerate a xell's .zeehive.env projection (spec §3.4) — e.g. after a site edit or a rename.
router.post('/xells/:id/env', async (req, res) => {
  try { res.json(await emitXellEnv(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── project manifest: the repo's zeehive.yml vs the stored cache (spec §3.1) ─
router.get('/projects/:id/manifest', async (req, res) => {
  try { res.json(await getProjectManifest(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
router.post('/projects/:id/manifest/refresh', async (req, res) => {
  try { res.json(await refreshProjectManifest(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Draft generation; {write:true} writes zeehive.yml into the repo root (refused if one exists) —
// the human reviews and commits it. The ONE artifact ZEEHIVE may write into a project repo.
router.post('/projects/:id/manifest/draft', async (req, res) => {
  try { res.json(await draftProjectManifest(req.params.id, { write: req.body?.write === true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── onboarding surface (Project Setup panel) ──────────────────────────────────
// Probe a FOLDER (works before the project exists): git state, manifest, compose files, env.
router.post('/projects/probe', (req, res) => res.json(probeRepo(req.body?.repo_root)));
// The readiness checklist: which gates pass, can it provision, can it SHIP.
router.get('/projects/:id/readiness', async (req, res) => {
  try { res.json(await projectReadiness(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
// The dev spawn template: what a new xell gets by default (couplings, runtime, pool size).
router.get('/projects/:id/pool-config', async (req, res) => res.json(await getPoolConfig(req.params.id)));
router.patch('/projects/:id/pool-config', async (req, res) => {
  try { res.json(await updatePoolConfig(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Shared-container inventory (prod containers included — a ship needs at least one shippable).
router.get('/projects/:id/containers', async (req, res) => res.json(await listSharedContainers(req.params.id)));
router.post('/projects/:id/containers', async (req, res) => {
  try { res.json(await createSharedContainer(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/containers/:id', async (req, res) => {
  try { res.json(await updateSharedContainer(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/containers/:id', async (req, res) => {
  try { res.json(await deleteSharedContainer(req.params.id, req.query.force === '1')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
router.get('/xells', async (_req, res) => res.json(await q(`SELECT * FROM xell WHERE status <> 'retired' ORDER BY created_at`)));
router.get('/zees', async (_req, res) => res.json(await q(`SELECT * FROM zee ORDER BY created_at DESC`)));
router.get('/containers', async (_req, res) => res.json(await q(`SELECT * FROM container ORDER BY role, tier, name`)));
// The databases INSIDE one db container (db_instance): primary, clone template, per-xell clones.
router.get('/containers/:id/instances', async (req, res) => res.json(await q(
  `SELECT di.*, x.slug AS owner_slug FROM db_instance di
     LEFT JOIN xell x ON x.id = di.owner_xell_id
    WHERE di.container_id = $1
    ORDER BY CASE di.kind WHEN 'primary' THEN 0 WHEN 'template' THEN 1 WHEN 'clone' THEN 2 ELSE 3 END, di.name`,
  [req.params.id])));
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
// Re-point a xell's database: { coupling: db-shared-dev|db-clone|db-shared-prod|db-isolated,
// container: <name|id>, dump: <snapshot id|'latest'> }. db-shared-prod is LIVE production;
// db-clone cuts the xell its own database inside the shared dev postgres (seconds, template copy).
router.post('/xells/:id/db', async (req, res) => {
  try { res.json(await attachXellDb(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Apply the xell's pending server/sql/migrations + ops files (at ITS branch head) to ITS OWN
// database (clone/isolated only — shared dev is schema-frozen, prod only ships). This is how a
// zee TESTS a migration before landing it; the same files ride the ship to prod.
router.post('/xells/:id/db/migrate', async (req, res) => {
  try { res.json(await applyMigrationsToXell(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Asked by the prod-guard hook (hooks/prod-guard.mjs) when a command in a xell worktree touches
// prod: is the prod DB THIS xell's assigned database? A hotfix/data xell dispatched with
// `--db shared-prod` is entitled to its own database; a feature xell is not. The hook cannot know this
// from a cwd + a command string, so it asks. Must be fast and must not throw — a blocked zee is
// waiting on it.
router.get('/xell/db-access', async (req, res) => {
  try { res.json(await dbAccessForCwd(req.query.cwd || '')); }
  catch (err) { res.status(500).json({ allowed: false, reason: `db-access check failed: ${err.message}` }); }
});

router.get('/xell/db-modes', (_req, res) =>
  res.json(Object.entries(DB_MODES).map(([key, label]) => ({ key, label }))));

// the autonomy scale a dispatch can pick from (1=recon … 5=bypass)
router.get('/xell/modes', (_req, res) =>
  res.json(Object.entries(DISPATCH_MODES).map(([n, m]) => ({ mode: Number(n), key: m.key, permission_mode: m.permissionMode, tools: m.tools || 'all', label: m.label }))));

// the models a dispatch can run — per PROVIDER (?provider=claude|openai|kimi), since each vendor's
// CLI takes its own model ids; `default` marks the entry a bare dispatch would run
router.get('/xell/models', (req, res) => res.json(listDispatchModels(req.query.provider)));

// Change a zee's permission mode from the console (the mode chip on a xell card). Live-applies
// to a headless zee we hold the handle for; otherwise recorded, with a note saying so.
router.post('/zees/:id/mode', async (req, res) => {
  const wanted = req.body?.permission_mode;
  if (!PERMISSION_MODES.includes(wanted)) {
    return res.status(400).json({ error: `permission_mode must be one of: ${PERMISSION_MODES.join(', ')}` });
  }
  try { res.json(await setZeeMode(req.params.id, wanted)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

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
  // project is REQUIRED — the old "fall back to the oldest project" default meant a runtime toggle
  // on ANY dashboard silently rewrote the FIRST project's (OmniBiz's) default instead of the one on
  // screen. A default this load-bearing (it decides whether a zee is cxell) must never be guessed.
  const proj = req.body?.project;
  if (!proj) return res.status(400).json({ error: 'project required' });
  const row = await one(`UPDATE pool_config SET default_runtime_id=$2 WHERE project_id=$1 RETURNING project_id`, [proj, rt.id]);
  if (!row) return res.status(404).json({ error: 'no pool_config for project' });
  res.json({ ok: true, default_runtime: rt.key });
});

// ── monitoring: is a session REALLY active (per the claude CLI)? ──────────────
router.post('/monitor/run', async (_req, res) => res.json(await monitorTick()));
router.get('/monitor/remote', async (_req, res) => res.json(await remoteAvailable()));

// ── container health: is each container actually running (per `docker ps`)? ───
router.post('/containers/check', async (_req, res) => res.json(await checkContainers()));

// ── decommission ONE container (the container context-menu action) ────────────
// Stops + removes the actual container, reclaims its image, drops its meta row. PRODUCTION is
// refused by decommissionContainer itself (tier='prod' or a production xell) — server-side, so a
// direct API call can't get around the UI guard.
router.post('/containers/:id/decommission', async (req, res) => {
  try { res.json(await decommissionContainer(req.params.id, { force: !!req.body?.force })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── machines: the hive's docker hosts as data (023) — placement, caps, build policy ──
router.get('/machines', async (_req, res) => res.json(await listMachines()));
router.post('/machines', async (req, res) => {
  try { res.json(await createMachine(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/machines/:id', async (req, res) => {
  try { res.json(await updateMachine(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/machines/:id', async (req, res) => {
  try { res.json(await deleteMachine(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Per-project pool size on a machine (machine_pool) — the matrix pool knob writes here.
router.put('/machines/:id/pool', async (req, res) => {
  try {
    const projectId = req.body?.project_id || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
    res.json(await setMachinePool(req.params.id, projectId, req.body?.pool_size));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Stand up this project's shared dev db ON a machine (latest prod backup by default) — the
// prerequisite for the machine hosting dev xells. Background; watch the queenzee log.
router.post('/machines/:id/dev-db', async (req, res) => {
  try {
    const projectId = req.body?.project_id || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
    res.json(await provisionDevDb(projectId, req.params.id, { snapshotId: req.body?.snapshot_id || null }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── devices: the HUMAN side of mobile device xhips (035) ─────────────────────
// The zee attaches its own device over the token'd /xell/self/device; these are for a human/the
// dashboard: register a physical phone, and attach/detach a device to a named xell by id.
router.get('/devices', async (req, res) => {
  // Registered SHARED devices (physical) for a project — the pool a xell can link from.
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  res.json(await q(
    `SELECT c.id, c.name, c.docker_ctx, host(c.host) AS host, c.host_port, c.url AS label, c.health,
            (SELECT x.slug FROM xell_uses_container uc JOIN xell x ON x.id = uc.xell_id
              WHERE uc.container_id = c.id AND x.status <> 'retired' LIMIT 1) AS in_use_by
       FROM container c
      WHERE c.project_id = $1 AND c.role='device' AND c.isolation='shared'
      ORDER BY c.created_at`, [req.query.project]));
});
// Register a physical phone as a shared device on a can_device machine — network-adb (transport:'net',
// give adb_port) or USB-shared (transport:'usb', give serial; adb_port defaults to the 5037 server).
router.post('/devices', async (req, res) => {
  const { project, machine_id, adb_port, serial, transport, name, label, host } = req.body || {};
  if (!project || !machine_id) return res.status(400).json({ error: 'project and machine_id required' });
  try { res.json(await registerPhysicalDevice({ projectId: project, machineId: machine_id,
    adbPort: adb_port || null, serial: serial || null, transport: transport || 'net',
    name: name || null, label: label || null, host: host || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Stand up the shared adb host on a machine (shares its USB-plugged phones over TCP). Background-ish
// docker run; FIREWALL the port to the LAN (an open adb server is unauthenticated).
router.post('/machines/:id/adb-host', async (req, res) => {
  try { res.json(await provisionAdbHost(req.params.id, { port: req.body?.port || undefined })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// List the phones plugged into a machine's shared adb host (`adb devices` in the adb-host container).
router.get('/machines/:id/usb-devices', async (req, res) => {
  try { res.json(await listUsbDevices(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Attach (or ?action=detach) a device to a xell by id — the dashboard's "attach device" button.
router.post('/xells/:id/device', async (req, res) => {
  const action = req.body?.action || 'attach';
  try {
    if (action === 'detach') return res.json(await detachDeviceXhip(req.params.id));
    res.json(await attachDeviceXhip(req.params.id, { kind: req.body?.kind || null }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── build: (re)build a per-xell server/webapp container (or a whole xell's stack) ──
// Optional build_ctx in the body sets the build host first ("build on X now"); omit to keep the
// stored one. build_ctx:null (or '') resets to build-where-you-run.
router.post('/containers/:id/build', async (req, res) => {
  const buildCtx = Object.prototype.hasOwnProperty.call(req.body || {}, 'build_ctx') ? req.body.build_ctx : undefined;
  try { res.json(await buildContainer(req.params.id, { hot: !!req.body?.hot, buildCtx })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── build context knob: WHERE a xell's images compile (compile-here / run-there) ──
// The NAS that runs the fleet is not a build box; point the compile at a beefier context to cut
// build time. Persisted per container; a foreign context is refused unless a registry is set.
router.patch('/xells/:id/build-ctx', async (req, res) => {
  const buildCtx = Object.prototype.hasOwnProperty.call(req.body || {}, 'build_ctx') ? req.body.build_ctx : null;
  try { res.json(await setXellBuildCtx(req.params.id, buildCtx)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/containers/:id/build-ctx', async (req, res) => {
  const buildCtx = Object.prototype.hasOwnProperty.call(req.body || {}, 'build_ctx') ? req.body.build_ctx : null;
  try { res.json(await setContainerBuildCtx(req.params.id, buildCtx)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Is the xell's stack built from its worktree's current HEAD? This is what `xell-build --wait`
// polls, so a zee never has to invent a curl-grep loop against its own app to find out.
router.get('/xells/:id/build/status', async (req, res) => {
  try { res.json(await getBuildStatus(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.post('/xells/:id/build', async (req, res) => {
  try {
    const role = req.body?.role && req.body.role !== 'all' ? req.body.role : null;
    const buildCtx = Object.prototype.hasOwnProperty.call(req.body || {}, 'build_ctx') ? req.body.build_ctx : undefined;
    res.json(await buildXell(req.params.id, { hot: !!req.body?.hot, role, buildCtx }));
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

// DANGER ZONE — purge ALL non-production xells in a project, mid-work and all (project setup →
// Danger tab, behind a typed confirmation). Prod is never a candidate (reaper excludes+refuses it).
router.post('/projects/:id/purge-dev', async (req, res) => {
  try { res.json(await purgeDevXells(req.params.id, { reason: req.body?.reason || 'danger-purge' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── reveal a xell's worktree folder in the host file manager (Explorer) ────────
router.post('/xells/:id/reveal', async (req, res) => {
  try { res.json(await revealXellWorktree(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── bind a xell to the PRODUCTION stack (prod db + prod app tier) ────────────
// A human typing the skill IS the gate — there is no approval flow here, deliberately: this grants
// prod DATA, which HANDOFF already treats as a human's call to make (`--db shared-prod` at
// dispatch does the same thing). It does NOT grant prod CODE; see lib/xell-prod.js.
router.get('/xells/:id/prod-stack', async (req, res) => {
  try { res.json(await prodStackStatus(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/xells/:id/prod-stack', async (req, res) => {
  try { res.json(await attachProdStack(req.params.id, { by: req.body?.by || 'human@console' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/xells/:id/prod-stack', async (req, res) => {
  try { res.json(await detachProdStack(req.params.id, { by: req.body?.by || 'human@console' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── /ooney: the ship-to-production gate cascade ──────────────────────────────
// One endpoint, called repeatedly. Re-measures every gate live and answers with the verdict plus
// the exact next step — the PROCEDURE IS THE RESPONSE, so it can never drift from what the
// queenzee enforces the way a hardcoded skill .md would. Idempotent: safe to poll.
router.post('/ooney/check', async (req, res) => {
  try {
    res.json(await ooneyCheck({
      xellId: req.body?.xell_id, targets: req.body?.targets || null,
      reason: req.body?.reason || null, zeeId: req.body?.zee_id || null,
      dbOk: req.body?.db_ok || null, skipDb: !!req.body?.skip_db,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── a xell and its xource: push / pull / PR ──────────────────────────────────
// A HUMAN drives these from the console. Note none of them is an override: push runs the same
// gated `git push . HEAD:<ref>` a zee runs, and accepting a PR fast-forwards to a sha a human
// read. There is deliberately no zee-facing path to accept — same rule as the landing gate.
router.post('/xells/:id/push', async (req, res) => {
  try { res.json(await pushToXource(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/xells/:id/pull', async (req, res) => {
  try { res.json(await pullFromXource(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/xells/:id/pr', async (req, res) => {
  try { res.json(await requestPullIn(req.params.id, { by: req.body?.by || 'human@console', note: req.body?.note || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Nudge the xell's live cxell zee for a STATUS UPDATE — the flower's "nudge" button. Best-effort:
// returns { nudged:false, reason } (200) when there is no live zee to reach, so the UI can say so.
router.post('/xells/:id/nudge', async (req, res) => {
  try { res.json(await nudgeXellForStatus(req.params.id, { by: req.body?.by || 'human@console' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Accepting happens on the XOURCE's card — the side being asked to take the code.
router.post('/land/requests/:id/accept', async (req, res) => {
  try { res.json(await acceptPullIn(req.params.id, req.body?.by || 'human@console')); }
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

// ── the CXELLD zee's WORKFLOW PROTOCOL: /api/xell/self/* ───────────────────────
//
// A cxell zee has no docker, no host fs, no skills — this authenticated surface is its ONLY door out
// of the cxell. Every verb requires `Authorization: Bearer <ZEEHIVE_XELL_TOKEN>` (minted at cxell
// spawn, injected into the cxell env), resolves the CALLING xell from the token hash, and maps to an
// existing human-gated action. An unknown/absent token is refused — a verb can only ever act on the
// xell that presented its own token, so there is no way to reach across to another xell.
async function resolveSelf(req, res) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const token = m ? m[1].trim() : (req.get('x-zeehive-xell-token') || '').trim();
  if (!token) { res.status(401).json({ error: 'missing bearer token — set ZEEHIVE_XELL_TOKEN (the cxell injects it)' }); return null; }
  const xell = await xellForToken(token);
  if (!xell) { res.status(401).json({ error: 'unknown xell token — it identifies no xell' }); return null; }
  if (xell.status === 'retired') { res.status(409).json({ error: `${xell.slug} is retired — its worktree is gone` }); return null; }
  return xell;
}

router.get('/xell/self/status', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfStatus(x)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
// Collect this cxell's commits and run the gated push — HELD for a human (landgate). Never moves main.
router.post('/xell/self/land', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfLand(x)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// File a ship request (shipgate) — the zee asks, a human approves, the queenzee deploys from main.
router.post('/xell/self/ship', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfShip(x, { targets: req.body?.targets || null, reason: req.body?.reason || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// ASK to bind this xell to the prod stack — recorded only; a human confirms, then the queenzee binds.
router.post('/xell/self/prod-request', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfProdRequest(x, { reason: req.body?.reason || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Propose done — flags the xell for a human's "Mark done"; the zee never despawns itself.
router.post('/xell/self/done', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfDone(x, { summary: req.body?.summary || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Raise (or --clear) a tend: "I need a human in the console". Opens no gate, blocks nothing — it
// just flags the xell as needing attention (occ-tendRequest) for a human to see.
router.post('/xell/self/tend', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfTend(x, { reason: req.body?.reason || null, clear: !!req.body?.clear })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Ping "I am actively working" — asserts live activity the passive poller can't see for a cxell, and
// clears any open tend. The hive shows occ-working.
router.post('/xell/self/working', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfWorking(x, { note: req.body?.note || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// (Re)build this cxell's OWN app tier so a cxell zee can run e2e tests against its change. NOT
// human-gated (building your own throwaway containers is the point of a xell) — it collects the
// cxell's commits onto the worktree, then runs the same queenzee build a host zee does.
router.post('/xell/self/build', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const role = req.body?.role && req.body.role !== 'all' ? req.body.role : null;
    res.json(await selfBuild(x, { role, hot: !!req.body?.hot })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Read-only: is the cxell's stack serving its current HEAD? What `zee build --wait/--watch` polls.
router.get('/xell/self/build/status', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfBuildStatus(x)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
// Attach / detach / status a mobile DEVICE xhip (Android). NOT human-gated — same class as build:
// a throwaway device to run your own app. `zee device` maps here.
router.post('/xell/self/device', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfDevice(x, { action: req.body?.action || 'attach', kind: req.body?.kind || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// HUMAN side of the prod-bind request (the dashboard) — list + confirm/reject. There is deliberately
// NO zee path to confirm: binding prod is a human's decision, exactly like a landing or a ship.
router.get('/prod-bind/requests', async (req, res) => {
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  res.json(await listProdBindRequests(req.query.project, { open: req.query.all !== '1' }));
});
router.post('/prod-bind/requests/:id/:decision(confirm|reject)', async (req, res) => {
  const decision = req.params.decision === 'confirm' ? 'confirmed' : 'rejected';
  try { res.json(await decideProdBind(req.params.id, decision, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
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
//
// RETIRED: a zee may no longer take or drop prod itself. The lock is the queenzee's to assign
// (after a human approves a ship) and to take back (on the auto-release countdown). Leaving these
// live would leave the old back door open — a zee could hold prod and deploy by hand, which is
// exactly the band-aid path the ship gate exists to close. They answer 409 with the way in.
const RETIRED_LOCK = {
  error: 'retired: a zee cannot take or release the production lock',
  use_instead: 'POST /api/ship/request (or scripts/xell-ship.mjs) — a human approves, then the '
    + 'queenzee assigns the lock, deploys from main, and releases it automatically.',
};
router.post('/prod-lock/acquire', (_req, res) => res.status(409).json(RETIRED_LOCK));
router.post('/prod-lock/release', (_req, res) => res.status(409).json(RETIRED_LOCK));
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
    `SELECT id, dump_path, size_bytes, taken_at, source, status, error, mode FROM db_snapshot
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

  // initial snapshot so a fresh client renders immediately. Same trap as /fleet: this is an
  // async handler, and the dashboard holds this connection open — a NAS blip here used to throw
  // an unhandled rejection and kill the queenzee. Degrade to a live stream with no snapshot.
  try {
    const fleet = await getFleet(req.query.project || null);
    res.write(`event: snapshot\ndata: ${JSON.stringify(fleet)}\n\n`);
  } catch (err) {
    console.error('[api] /stream snapshot failed:', err.message);
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  }

  const onEvent = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
});
