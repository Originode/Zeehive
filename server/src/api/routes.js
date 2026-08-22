// All HTTP routes: hooks sink, read models, SSE stream, xell claim, task intake.
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { projectHook } from '../lib/status.js';
import { getFleet, getFleetBurn, listRuntimes, streamXells } from '../lib/fleet.js';
import { getTimeline, getDiffs } from '../lib/timeline.js';
import { deliveryTelemetry } from '../lib/delivery-telemetry.js';
import { xellPatch, landRequestPatch, xourcePatch } from '../lib/diffview.js';
import { recentLogs } from '../lib/logbus.js';
import { listCxellDir, readCxellFile } from '../lib/cxell-fs.js';
import { listContainerDir, readContainerFile } from '../lib/container-fs.js';
import { bus, broadcast, activityFanout } from '../lib/events.js';
import { claimXell, dispatchXell, DISPATCH_MODES, PERMISSION_MODES, setZeeMode, listDispatchModels, reinjectHarnessIntoXell } from '../queenzee/intake.js';
import { listHarnesses, assignHarness, getBridge, setBridge, probeBridge,
         createHarness, updateHarness, deleteHarness, getHarnessFull,
         harnessAvatarSvg } from '../lib/harness.js';
import { modelSpecs, updateModelSpec } from '../lib/model-policy.js';
import { dispatchOptions } from '../lib/dispatch-options.js';
import { bridgeBySlug, bridgeInboundConfig } from '../lib/harness-bridge.js';
import { listProjectDocs, createProjectDoc, updateProjectDoc, deleteProjectDoc,
         previewProjectDoc } from '../lib/project-docs.js';
import { listProjectConditions, addProjectCondition, updateProjectConditionScoped,
         removeProjectConditionScoped } from '../lib/current-conditions.js';
import { targetCatalogue } from '../lib/agent-docs.js';
import { markTaskDone, createTask } from '../queenzee/tasks.js';
import { backupProd, refreshStaleXellDbs, setBackupConfig, setBackupPaused, revealBackup, restoreBackup, deleteBackup, cancelBackup, duplicateProdInto } from '../queenzee/maintenance.js';
import { monitorTick } from '../queenzee/monitor.js';
import { diffOneContainerAgainstProd, diffCandidates } from '../queenzee/proddiff.js';
import { checkContainers, decommissionContainer } from '../queenzee/containers.js';
import { buildContainer, buildXell, getBuildStatus, setContainerBuildCtx, setXellBuildCtx } from '../lib/build.js';
import { listMachines, createMachine, updateMachine, deleteMachine, provisionDevDb, setMachinePool,
         setMachinePriority, checkMachineConnection } from '../lib/machines.js';
import { buildReadinessForProject } from '../lib/build-readiness.js';
import { performBuildBootstrap } from '../lib/build-bootstrap.js';
import { attachDeviceXhip, detachDeviceXhip, registerPhysicalDevice, provisionAdbHost, listUsbDevices, discoverUsbDevices, listAdbDevices } from '../lib/devices.js';
import { emitXellEnv } from '../lib/provision.js';
import { revealXellWorktree } from '../lib/reveal.js';
import { reapXell, purgeDevXells } from '../queenzee/reaper.js';
import { clearXellQuarantine } from '../lib/xell-quarantine.js';
import { attachXellDb, dbAccessForCwd, DB_MODES } from '../lib/xell-db.js';
import { attachProdStack, detachProdStack, prodStackStatus } from '../lib/xell-prod.js';
import { remoteAvailable } from '../lib/claude-cli.js';
import { prodLockStatus } from '../queenzee/deploylock.js';
import { proposeDone, xellStatus } from '../queenzee/tasks.js';
import { listProjects, createProject, updateProject, deleteProject,
         getProjectManifest, refreshProjectManifest, generateProjectCompose, draftProjectManifest,
         buildManifestDraft, writeProjectManifest,
         getComposeOnboardingPlan, applyComposeOnboarding,
         probeRepo, listDirs, projectReadiness, getPoolConfig, updatePoolConfig,
         cloneProject, pullProject, githubAccess, pushProject, pullRequestProject } from '../lib/projects.js';
import { probeRemote } from '../lib/remote-git.js';
import { listHostMounts, mountHostFolder } from '../lib/self-mount.js';
import { config } from '../config.js';
import { listSites, createSite, updateSite, deleteSite, listDockerContexts } from '../lib/sites.js';
import { resolveProjectId } from '../lib/project-resolve.js';
import { listProviderTokens, providerLimits, setProviderToken, addProviderToken, deleteProviderToken,
         deleteProviderAccount, setProviderAccountPaused, setProviderAlertAmount } from '../lib/provider-tokens.js';
import { listEnvironments, createEnvironment, updateEnvironment, deleteEnvironment,
         listVars, setVar, deleteVar, importEnv, exportEnv, lintEnv, diffEnvironments,
         resolvedEnvView, setXellEnvironment, extractXellEnv } from '../lib/environments.js';
import { listSharedContainers, createSharedContainer, updateSharedContainer, deleteSharedContainer }
  from '../lib/inventory.js';
import { discoverSite, adoptContainers } from '../lib/discovery.js';
import { checkPush, listLandRequests, decideLandRequest, dismissLandRequest, landStatus,
         withdrawLandRequest } from '../queenzee/landgate.js';
import { buildLandingPad } from '../queenzee/landingpad.js';
import { pushToXource, pullFromXource, requestPullIn, acceptPullIn } from '../queenzee/xellgit.js';
import { nudgeXellForStatus, sendMessageToXell } from '../queenzee/nudge.js';
import { restartXellCxell, probeXellCxell } from '../queenzee/cxell-recover.js';
import { pauseFleet, resumeFleet, pauseProject, resumeProject,
         pauseXell, resumeXell } from '../queenzee/pause.js';
import { pauseState, projectPauseState } from '../lib/fleet-pause.js';
import { ooneyCheck } from '../queenzee/ooney.js';
import { checkContainerData, dataCheckReadiness } from '../queenzee/datadiff.js';
import { compareBackupCounts } from '../lib/row-counts.js';
import { applyMigrationsToXell, catchUpXellToProd } from '../queenzee/shipmigrate.js';
import { requestShip, listShipRequests, decideShip, shipStatus, holdProdLock, forceReleaseProdLock,
  dismissShipRequest, deferShip, resumeShip, unlockAndShip, bundleDeferredShips } from '../queenzee/shipgate.js';
import { xellForToken } from '../lib/xell-token.js';
import { selfStatus, selfLand, selfWithdrawLand, selfSync, selfShip, selfWithdrawShip, selfProdRequest, selfDone, selfBuild, selfBuildStatus,
         selfTend, selfHint, selfWorking, selfTurn, selfDevice, selfCatchup, selfMigrationNumber,
         selfHandover, selfAwait,
         listProdBindRequests, decideProdBind,
         selfSeedRequest, selfSeedStatus, selfVerifyWebapp, setVisualVerify, dismissVisualVerifyOffer,
         selfUploadConversation, selfConversations,
         selfCrew, selfDispatch, selfSwap, swapXellZeeAsHuman,
         selfSay, selfReport, selfInbox, selfReview, selfA2ASend,
         selfMeetCreate, selfMeetAttend, selfMeetSay, selfMeet,
         selfSuggestDone, selfXourceClean, selfMintManager, selfHarnessList, selfHarnessGet, selfHarnessCreate, selfHarnessUpdate,
         selfHarnessDelete, selfOps, selfTicketCreate, selfTicketList,
         selfProviderEnv } from '../queenzee/self.js';
import { listDoneSuggestions, decideDoneSuggestion, dismissDoneSuggestion, suggestDone,
         crewFor, messagesForXell } from '../lib/managers.js';
import { buildFleetCard, a2aVersionError } from '../lib/a2a.js';
import { A2AError, cardVisibleXellIds, taskVisibleXellIds, loadTask, externalCaller,
         dispatchA2A, agentCardFor, directoryFor } from '../lib/a2a-read.js';
import { createManagerZee } from '../lib/manager-spawn.js';
import { workStatusVocabulary } from '../lib/work-status.js';
import { workStatusModelVocabulary } from '../lib/model-status.js';
import { listWorkItems, getWorkItem, createWorkItem, updateWorkItem, deleteWorkItem,
         addDep, removeDep, boardModel, ganttModel, assertId, httpStatusOf } from '../lib/work-items.js';
import { listTickets, getTicket, createTicket, updateTicket, deleteTicket, addComment,
         breakdownTicket, ticketManagers, notifyManagerOfTicket } from '../lib/tickets.js';
import { listReflections, fileReflectionAsTicket } from '../lib/reflections.js';
// EXTERNAL TICKETING API (190) — a deployed project files/monitors/updates its own tickets with a
// per-project key, and attaches the evidence (images, logs). docs/ticketing-api.md.
import { listProjectApiKeys, createProjectApiKey, revokeProjectApiKey, deleteProjectApiKey,
         authenticateApiKey } from '../lib/project-api-keys.js';
import { listAttachments, getAttachment, addAttachment, deleteAttachment,
         attachmentLimits } from '../lib/ticket-attachments.js';
import { externalCreateTicket, externalListTickets, externalGetTicket, externalUpdateTicket,
         externalComment, externalAttach, externalAttachments, externalMeta } from '../lib/ticket-intake.js';
import { listProdSeedRequests, decideProdSeed, seedRequestSql, dismissSeedRequest,
         requestProdSeed } from '../queenzee/seedgate.js';
import { xourceState, cleanXourceNow, commitXourceStaged, commitXourceDirty, stashXource, listXourceCleanRequests,
         decideXourceClean, dismissXourceClean } from '../lib/xource-clean.js';
import { listManagerMintRequests, decideManagerMint, dismissManagerMint } from '../lib/manager-mint.js';
import { listCredentialInjectRequests, decideCredentialInject, dismissCredentialInject,
         raiseRotationRequest } from '../lib/credential-inject.js';
// WORK TRACKER — putting a zee ON a work item (lib/work-assign.js) and the cxell verbs for it.
import { assignWorkItem, unassignWorkItem, deployWorkItem, candidatesFor, getWorkItemOverlap } from '../lib/work-assign.js';
import { selfWork, selfWorkNew, selfWorkBreakdown, selfWorkUnassign, selfWorkDep, selfWorkAssign,
         selfWorkItem, selfConditions, selfStandingOrders } from '../queenzee/self.js';
import { webappRedirect } from '../lib/webapp-proxy.js';
import { wireguardStatus, mintPeerConfig, ensureWireguardServer, markPeerDownloaded } from '../lib/wireguard.js';

export const router = Router();

// QUEENZEE_INPROC=false starts an API-ONLY instance (pre-phase-1 gateway slice): it holds NO
// single-queenzee advisory lock, so the routes below whose handlers DRIVE the fleet — provision,
// reap, build, and the manual loop-tick routes — must refuse there rather than act without the
// lock (two drivers on one meta-DB is exactly what the lock exists to prevent). The refusal is
// loud: an API-only instance is not a silent passthrough for loop-owned work.
const requireQueenzeeLoops = (req, res, next) => {
  if (config.queenzeeInproc) return next();
  res.status(503).json({
    ok: false,
    error: 'QUEENZEE_INPROC=false (API-only): this instance does not drive the fleet. '
      + 'Point this request at THE queenzee (the process holding the single-queenzee lock).',
  });
};

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

// WITHDRAW a pending request on the zee's behalf (an operator clearing a card whose zee is gone, or
// tidying up after one that stacked them). NOT a rejection: nothing is refused and no sha is burned,
// so the same work can be pushed and asked again. Pending rows only — an approved one is a decision.
router.post('/land/requests/:id/withdraw', async (req, res) => {
  try { res.json(await withdrawLandRequest(req.params.id, req.body?.by || 'human@console', req.body?.reason || null)); }
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
    // allow_stale_cxell_image: the human's explicit "ship anyway with a stale cxell image" — a
    // per-ship release valve for the fatal cxell-image guard, recorded on the request (055).
    res.json(await decideShip(req.params.id, decision, req.body?.by || 'human@console',
      { siteId: req.body?.site_id || undefined,
        allowStaleCxellImage: !!req.body?.allow_stale_cxell_image }));
  } catch (err) { res.status(409).json({ error: err.message }); }
});

// Force-release the prod lock for this ship's site, then approve+ship it — the "prod is locked, but
// send this one now" decision, done as one atomic step so nothing queues into the freed lock first.
router.post('/ship/requests/:id/unlock-and-ship', async (req, res) => {
  try {
    res.json(await unlockAndShip(req.params.id,
      { siteId: req.body?.site_id || null, by: req.body?.by || 'human@console',
        allowStaleCxellImage: !!req.body?.allow_stale_cxell_image }));
  } catch (err) { res.status(409).json({ error: err.message }); }
});

// Dismiss a shipped/failed ship card's receipt (visibility only; the ship itself is unchanged).
router.post('/ship/requests/:id/dismiss', async (req, res) => {
  try { res.json(await dismissShipRequest(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// Defer a pending ship: set it aside (not rejected) so landings can accumulate for a combined ship.
router.post('/ship/requests/:id/defer', async (req, res) => {
  try { res.json(await deferShip(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// Resume a deferred ship: re-aim it at the current main tip and make it a live pending request.
router.post('/ship/requests/:id/resume', async (req, res) => {
  try { res.json(await resumeShip(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// Bundle every DEFERRED ship into ONE combined deploy (per prod site) — the "ship all of these
// together" click. A carrier is re-aimed at the current main tip and approved; the rest ride it.
router.post('/ship/bundle-deferred', async (req, res) => {
  const projectId = req.body?.project || req.query.project;
  if (!projectId) return res.status(400).json({ error: 'project is required' });
  try { res.json(await bundleDeferredShips(projectId, { by: req.body?.by || 'human@console' })); }
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

// ── PAUSE / PLAY — the fleet-wide stop button ────────────────────────────────
// One switch, deliberately FLEET-WIDE and not per project: it interrupts every zee in every xell,
// managers included, and holds the queenzee's own turn-starting loops down until play. The state also
// rides the /fleet snapshot (fleet.pause) — this pair is for acting on it, and the GET for a client
// that wants just the flag.
//
// A HUMAN's verb only. There is no /api/xell/self/pause and there must never be one: a zee that can
// stop the fleet can stop the zee that would land its rival's work, and every gate in this system is
// built on a zee being able to ASK and never to ACT. (A zee that needs everything stopped has
// `zee tend`.)
router.get('/fleet/pause', async (_req, res) => {
  try { res.json(await pauseState()); }
  catch (err) { res.status(503).json({ error: `pause state unavailable: ${err.message}` }); }
});

// When a `project` parameter is provided, this acts on THAT project only (project-scoped pause).
// Without it, the original fleet-wide behaviour is preserved (backward-compatible).
router.post('/fleet/pause', async (req, res) => {
  try {
    const projectId = req.body?.project || req.query?.project || null;
    if (projectId) {
      const state = await projectPauseState(projectId);
      if (state.paused) return res.status(409).json({ error: 'this project is already paused', ...state });
      return res.json(await pauseProject(projectId, { by: req.body?.by || 'human@console', reason: req.body?.reason || null }));
    }
    const state = await pauseState();
    if (state.paused) return res.status(409).json({ error: 'the fleet is already paused', ...state });
    res.json(await pauseFleet({ by: req.body?.by || 'human@console', reason: req.body?.reason || null }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/fleet/resume', async (req, res) => {
  try {
    const projectId = req.body?.project || req.query?.project || null;
    if (projectId) {
      const state = await projectPauseState(projectId);
      if (!state.paused) return res.status(409).json({ error: 'this project is not paused', ...state });
      return res.json(await resumeProject(projectId, { by: req.body?.by || 'human@console' }));
    }
    const state = await pauseState();
    if (!state.paused) return res.status(409).json({ error: 'the fleet is not paused', ...state });
    res.json(await resumeFleet({ by: req.body?.by || 'human@console' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PER-XELL PAUSE / RESUME (migration 101) ────────────────────────────────────
// Pause one individual xell: marks it in session_event and interrupts its zee.
router.post('/xells/:id/pause', async (req, res) => {
  try {
    res.json(await pauseXell(req.params.id, { by: req.body?.by || 'human@console', reason: req.body?.reason || null }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resume one individual xell: marks it in session_event and nudges the zee back.
router.post('/xells/:id/resume', async (req, res) => {
  try {
    res.json(await resumeXell(req.params.id, { by: req.body?.by || 'human@console' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PER-XELL VISUAL VERIFICATION (human side) ──────────────────────────────────
// A human turns visual verification on/off for a xell ({visual_verify: true|false}) — the same flag
// the dispatch composer sets at dispatch time — and dismisses an offer ({dismiss: offerId}, or
// {dismiss: true} for the xell's open offers) once they have looked at the link. Per-xell config,
// nothing irreversible: the zee only ever OFFERS the link, and this route is the human's side of it.
router.post('/xells/:id/visual-verify', async (req, res) => {
  try {
    const b = req.body || {};
    const by = b.by || 'human@console';
    if (b.dismiss) {
      return res.json(await dismissVisualVerifyOffer(req.params.id,
        { offerId: b.dismiss === true ? null : b.dismiss, by }));
    }
    return res.json(await setVisualVerify(req.params.id, { visual_verify: !!b.visual_verify, by }));
  } catch (err) { res.status(400).json({ error: err.message }); }
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
// Fleet-own zee burn + gateway by_provider + current rate-limit headers (lib/fleet.js getFleetBurn).
// Account-wide Admin /usage still needs separate admin keys the fleet does not hold.
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

// DELIVERY TELEMETRY — the seven delivery numbers for ONE project over a window (lib/delivery-
// telemetry.js): cycle time, turn deaths, cost per landed xell, error rate, rework, gate waits and
// the xells that never raised a landing. Read-only, and deliberately NOT part of `zee ops`: that
// digest is fleet-wide and already too large to return as valid JSON (TKT-42).
//
// Same 503-not-throw contract as /fleet and /fleet/burn — a read model must never take the
// queenzee down. `project` is required (there is no sensible fleet-wide answer here: the whole
// question is about one project's delivery), and `days` is clamped by the read model itself.
router.get('/delivery-telemetry', async (req, res) => {
  try {
    if (!req.query.project) return res.status(400).json({ error: 'project is required' });
    res.json(await deliveryTelemetry({ projectId: req.query.project, days: req.query.days }));
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    console.error('[api] /delivery-telemetry failed:', err.message);
    res.status(503).json({ error: `delivery telemetry unavailable: ${err.message}` });
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
// ── GitHub OUTBOUND (opt-in, human-gated) — only when the PAT carries write access ────────────
// Does this project's stored GitHub token actually let us push / open PRs? The console asks this
// to decide whether to render the Push / PR buttons at all (read-only token → neither shows).
router.get('/projects/:id/github-access', async (req, res) => {
  try { res.json(await githubAccess(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Human-triggered push: local main → the remote's branch, fast-forward only. A diverged/read-only
// remote comes back {pushed:false, reason} with HTTP 200 — the console shows the reason.
router.post('/projects/:id/push', async (req, res) => {
  try { res.json(await pushProject(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Human-triggered PR: push a side branch off local main and open a pull request against default.
// With merge:true it ALSO merges the PR on GitHub (pull-request AND merge) — a refused merge still
// leaves the PR open (r.merge.reason). Refusals are {opened:false, reason} with HTTP 200.
router.post('/projects/:id/pr', async (req, res) => {
  try {
    res.json(await pullRequestProject(req.params.id,
      { headBranch: req.body?.headBranch || null, title: req.body?.title || null, base: req.body?.base || null,
        merge: !!req.body?.merge, mergeMethod: req.body?.mergeMethod || 'merge', squash: !!req.body?.squash },
      req.body?.by || 'human@console'));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── deploy sites: where each tier runs + how it's reached (spec §5) ───────────
// The contexts list feeds the console's picker, so a typo'd context can't be entered at all.
router.get('/docker/contexts', (_req, res) => res.json(listDockerContexts()));
// ── PROJECT ENTRY-POINT DOCS (the instructions a zee reads first) ────────────
// The CONTENTS are owned by the meta-DB and one file per AI provider is GENERATED into each xell when
// a zee is assigned (lib/project-docs.js). The console's Docs tab is the whole authoring surface; the
// injector refuses to write over a path the project has committed, so an operator cannot silently
// replace a repo's own instructions.
//
// The catalogue is served rather than duplicated in web/: the filenames are a moving vendor fact
// (lib/agent-docs.js), and a hard-coded copy in the console would be a second source of truth for
// them — stale the first time one is renamed.
router.get('/agent-doc-targets', (_req, res) => res.json(targetCatalogue()));
router.get('/projects/:id/docs', async (req, res) => {
  try { res.json(await listProjectDocs(await resolveProjectParam(req.params.id))); }
  catch (e) { res.status(projectErrorStatus(e)).json({ error: e.message }); }
});
router.post('/projects/:id/docs', async (req, res) => {
  try { res.json(await createProjectDoc(await resolveProjectParam(req.params.id), req.body || {})); }
  catch (e) { res.status(projectErrorStatus(e)).json({ error: e.message }); }
});
router.put('/project-docs/:docId', async (req, res) => {
  try { res.json(await updateProjectDoc(req.params.docId, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// The generated file itself, for the console's preview — the only place an operator sees the stamp,
// the sibling list and the xell stack they did not type. Read-only, and it runs the real generator.
router.get('/project-docs/:docId/preview', async (req, res) => {
  try { res.json(await previewProjectDoc(req.params.docId, { xellId: req.query.xell || null })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/project-docs/:docId', async (req, res) => {
  try { res.json(await deleteProjectDoc(req.params.docId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// ── CURRENT CONDITIONS — the short, dated, per-PROJECT list of live impediments injected into
// every briefing (ticket #67). The console is the HUMAN's authoring surface; a manager edits the
// same list through `zee conditions --add/--remove` (see the /xell/self/conditions routes). Each
// line is DATA (house rule 7): it lives here in the meta-DB, is resolved live at briefing time,
// and is trivially deletable — there is deliberately no archive, because a condition that stops
// being true should be GONE, not hidden. ──
//
// A WRITE to a condition reaches EVERY briefing in the project, so "who may write" is really "who
// may edit every other zee's instructions". The zee-facing wall is the /xell/self route (token →
// requireManager). THIS surface is the console: /api has NO router-level authentication at all
// (index.js mounts `app.use('/api', router)` bare), so a request that sends no token — or a token
// that does not resolve to a xell — is NOT refused here. refuseWorkerZeeToken below is therefore a
// PARTIAL wall: it refuses a worker zee that VOLUNTEERS its token, and nothing else. Closing the
// unauthenticated write path is an authentication decision about the whole /api surface — an open
// HUMAN card (492743d2), not this route's to settle. The honest contract is: this guard narrows the
// reach of an identified worker; it does not make the console route safe.
async function refuseWorkerZeeToken(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const token = m ? m[1].trim() : (req.get('x-zeehive-xell-token') || '').trim();
  // PARTIAL WALL — see the block comment above. /api has no auth, so a request with NO token, or
  // with a token that does not resolve, passes here. Card 492743d2 is the open human decision that
  // would actually close the unauthenticated path; this guard only refuses an IDENTIFIED worker.
  if (!token) return null;
  const xell = await xellForToken(token);
  if (!xell) return null;
  if (xell.zee_type !== 'manager') {
    return { ok: false, status: 'refused',
      error: 'writing a current condition is MANAGER-only (it reaches every briefing in the '
        + 'project). A zee edits the list with `zee conditions` — which enforces the same wall '
        + 'server-side — or a human edits it in the console.' };
  }
  return null;
}
router.get('/projects/:id/conditions', async (req, res) => {
  try { res.json(await listProjectConditions(await resolveProjectParam(req.params.id))); }
  catch (e) { res.status(projectErrorStatus(e)).json({ error: e.message }); }
});
router.post('/projects/:id/conditions', async (req, res) => {
  try {
    const g = await refuseWorkerZeeToken(req);
    if (g) return res.status(403).json(g);
    const r = await addProjectCondition(await resolveProjectParam(req.params.id),
      req.body?.body || null, { actor: req.body?.actor || 'human' });
    if (!r.ok) return res.status(400).json(r);
    res.status(201).json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/project-conditions/:condId', async (req, res) => {
  try {
    const g = await refuseWorkerZeeToken(req);
    if (g) return res.status(403).json(g);
    // The console route has no caller-scoped project (it is a human's dashboard), so the condition's
    // own project is the scope — updateProjectConditionScoped then refuses a mismatch BY NAME, the
    // same rule the scoped remove enforces (an id is not an authorisation).
    const cond = await one(`SELECT project_id FROM project_condition WHERE id=$1`, [req.params.condId]);
    if (!cond) return res.status(404).json({ error: `no condition ${req.params.condId}` });
    const r = await updateProjectConditionScoped(req.params.condId, cond.project_id,
      req.body?.body || null, { actor: req.body?.actor || 'human' });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/project-conditions/:condId', async (req, res) => {
  try {
    const g = await refuseWorkerZeeToken(req);
    if (g) return res.status(403).json(g);
    // Same scoping rule as PUT: the condition's own project is the scope, so the scoped remove
    // refuses a foreign row by name (an id is not an authorisation).
    const cond = await one(`SELECT project_id FROM project_condition WHERE id=$1`, [req.params.condId]);
    if (!cond) return res.status(404).json({ error: `no condition ${req.params.condId}` });
    const r = await removeProjectConditionScoped(req.params.condId, cond.project_id);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// ── STANDING ORDERS for a MANAGER xell (ticket #74) — the HUMAN's authoring surface. A manager
// sets its own with `zee standing-orders`; a human sets it here on a manager xell. Same data, same
// rules: a worker xell has no standing orders (it does not dispatch), the text is bounded (SHORT by
// design), and it never widens a worker — it is appended to the brief at dispatch time. These routes
// carry the same PARTIAL worker-token wall as the conditions routes (refuseWorkerZeeToken above): /api
// has no router-level auth, so this narrows an identified worker and nothing else (card 492743d2).
async function refuseWorkerZeeTokenForStandingOrders(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const token = m ? m[1].trim() : (req.get('x-zeehive-xell-token') || '').trim();
  if (!token) return null;
  const xell = await xellForToken(token);
  if (!xell) return null;
  if (xell.zee_type !== 'manager') {
    return { ok: false, status: 'refused',
      error: 'setting standing orders is MANAGER-only (they reach every brief a manager dispatches). '
        + 'A manager sets its own with `zee standing-orders`; a human sets them in the console.' };
  }
  return null;
}
// Read a xell's standing orders (any xell — a worker's is null, a manager's is its block).
router.get('/xells/:id/standing-orders', async (req, res) => {
  try {
    const x = await one(`SELECT id, zee_type, slug, standing_orders, standing_orders_updated_at, standing_orders_updated_by
                           FROM xell WHERE id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'no such xell' });
    res.json({ ok: true, xell: x.slug, zee_type: x.zee_type,
               standing_orders: x.standing_orders, length: x.standing_orders ? x.standing_orders.length : 0,
               updated_at: x.standing_orders_updated_at, updated_by: x.standing_orders_updated_by });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Set a manager xell's standing orders (human). A worker target is refused — only a manager
// dispatches, so only a manager's standing orders mean anything.
router.put('/xells/:id/standing-orders', async (req, res) => {
  try {
    const g = await refuseWorkerZeeTokenForStandingOrders(req);
    if (g) return res.status(403).json(g);
    const { STANDING_ORDERS_MAX } = await import('../lib/standing-orders.js');
    const x = await one(`SELECT id, slug, zee_type FROM xell WHERE id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'no such xell' });
    if (x.zee_type !== 'manager') {
      return res.status(400).json({ ok: false, error: `${x.slug} is a ${x.zee_type} xell — standing orders `
        + 'belong to a MANAGER (the xell that dispatches). A worker receives them appended to its brief; '
        + 'it does not author them.' });
    }
    const body = String(req.body?.text || '').trim();
    if (!body) {
      return res.status(400).json({ ok: false, error: 'standing orders text is required — to clear them, DELETE this route.' });
    }
    if (body.length > STANDING_ORDERS_MAX) {
      return res.status(400).json({ ok: false, error: `standing orders are limited to ${STANDING_ORDERS_MAX} characters — `
        + `${body.length} is a second manual, not a short block.` });
    }
    const r = await one(
      `UPDATE xell SET standing_orders=$2, standing_orders_updated_at=now(), standing_orders_updated_by=$3
        WHERE id=$1 RETURNING standing_orders, standing_orders_updated_at, standing_orders_updated_by`,
      [x.id, body, req.body?.actor || 'human@console']);
    broadcast('xell', { id: x.id });
    res.json({ ok: true, xell: x.slug, ...r, length: r.standing_orders.length,
               message: `Set — every brief ${x.slug} dispatches now carries this block verbatim.` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Clear a manager xell's standing orders (human) — trivial on purpose, like a condition delete.
router.delete('/xells/:id/standing-orders', async (req, res) => {
  try {
    const g = await refuseWorkerZeeTokenForStandingOrders(req);
    if (g) return res.status(403).json(g);
    const x = await one(`SELECT id, slug, zee_type FROM xell WHERE id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'no such xell' });
    if (x.zee_type !== 'manager') {
      return res.status(400).json({ ok: false, error: `${x.slug} is a ${x.zee_type} xell — only a manager has standing orders.` });
    }
    await one(`UPDATE xell SET standing_orders=NULL, standing_orders_updated_at=now(), standing_orders_updated_by=$2
                WHERE id=$1 RETURNING id`, [x.id, req.body?.actor || 'human@console']);
    broadcast('xell', { id: x.id });
    res.json({ ok: true, xell: x.slug, standing_orders: null,
               message: `Cleared — ${x.slug}'s dispatches are back to no standing-orders block.` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/projects/:id/sites', async (req, res) => {
  try { res.json(await listSites(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
// ── WireGuard mesh — the human's door onto the ZEEHIVE network ───────────────────────────────
// Decision 5.4 (docs/common-xell-network-plan.md): ZEEHIVE operates a WG server; a human (or
// another machine) downloads a ready .conf and joins the tunnel. These are HUMAN surface routes
// (no zee verb): the mesh identity and peer keys are minted server-side with Node's native x25519.
// Status is a read; mint returns a download; re-endpoint re-points the server's dial-in address.
router.get('/projects/:id/wireguard', async (req, res) => {
  try { res.json(await wireguardStatus(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Mint a peer config and return it AS A DOWNLOAD (Content-Disposition). The private key lives only
// in this response — the peer row stores the public key alone.
router.post('/projects/:id/wireguard/peer', async (req, res) => {
  try {
    const { config, peer } = await mintPeerConfig(req.params.id, { name: req.body?.name, dns: req.body?.dns });
    await markPeerDownloaded(peer.id);
    res.setHeader('Content-Type', 'application/x-wireguard-profile');
    res.setHeader('Content-Disposition', `attachment; filename="zeehive-${peer.name}.conf"`);
    res.send(config);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// (Re)point the mesh server's endpoint (e.g. after the fleet's reachable address changes). The
// server identity (keys) is unchanged — existing peer configs keep dialing their snapshot address.
router.patch('/projects/:id/wireguard/endpoint', async (req, res) => {
  try {
    const server = await ensureWireguardServer(req.params.id, { endpoint: req.body?.endpoint });
    res.json({ ok: true, endpoint: server.endpoint, public_key: server.public_key });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/projects/:id/sites', async (req, res) => {
  try { res.json(await createSite(await resolveProjectParam(req.params.id), req.body || {})); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
router.patch('/sites/:id', async (req, res) => {
  try { res.json(await updateSite(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/sites/:id', async (req, res) => {
  try { res.json(await deleteSite(req.params.id, req.query.force === '1')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});

// ── discover & adopt a site's running stack (generalised self-onboard) ────────
// READ-ONLY wrt docker: GET lists what is actually running on the site's context (docker ps/
// inspect only); POST models a human-chosen subset as that site's prod inventory and links each
// to the production xell ('owns'). An unreachable context is reported {ok:false, error} (200), not
// an empty list, so the console can tell "nothing to adopt" from "the daemon is dead".
router.get('/sites/:id/discover', async (req, res) => {
  try { res.json(await discoverSite(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
router.post('/sites/:id/adopt', async (req, res) => {
  try { res.json(await adoptContainers(req.params.id, req.body?.containers || [])); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── provider accounts: per-project AI credentials for cxell zees ──────────────
// The read model is MASKED (hint + dates only); the full token never leaves the server —
// only the spawn path reads it, via tokenForSpawn(). A project can hold SEVERAL accounts of
// one provider type (036): POST adds one, DELETE …/account/:accountId removes one; the PUT
// keeps its legacy replace-in-place semantics for single-account types (github, scripts).
router.get('/projects/:id/tokens', async (req, res) => {
  try { res.json(await listProviderTokens(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
// HOW MUCH OF EACH PROVIDER ACCOUNT'S USAGE LIMIT IS STILL AVAILABLE — project-scoped,
// account-grained, never per-xell. Same data as fleet.provider_limits; a dedicated route so
// Project setup can refresh without re-pulling the whole fleet snapshot.
router.get('/projects/:id/provider-limits', async (req, res) => {
  try { res.json({ ok: true, project_id: req.params.id, providers: await providerLimits(req.params.id) }); }
  catch (err) { res.status(503).json({ error: `provider limits unavailable: ${err.message}` }); }
});
router.post('/projects/:id/tokens', async (req, res) => {
  try {
    const projectId = await resolveProjectParam(req.params.id);
    const out = await addProviderToken(projectId, req.body?.provider, req.body?.token, req.body?.label);
    // A human connected an account → if live cages for this provider predate the new key, raise a
    // rotation request for a human to approve (the queenzee performs the injection on approval).
    await raiseRotationRequest({ projectId, provider: req.body?.provider })
      .catch(() => {});   // a failed trigger must never fail the token save
    res.json(out);
  } catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
router.delete('/projects/:id/tokens/account/:accountId', async (req, res) => {
  try { res.json(await deleteProviderAccount(await resolveProjectParam(req.params.id), req.params.accountId)); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
// SET one provider's spend-alert threshold (migration 206) — a customizable USD amount per
// provider, applied per xell by the fleet read model: when a xell's gateway-ledger spend on
// that provider exceeds the amount, its hexagon shows an over-budget indicator. Body: { amount }
// (number, or null/'' to clear).
router.put('/projects/:id/provider-alerts/:provider', async (req, res) => {
  try {
    res.json(await setProviderAlertAmount(req.params.id, req.params.provider, req.body?.amount));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PAUSE / RESUME a provider account (migration 104): disabling it for every dispatch surface
// without disconnecting the token. Pausing is reversible (resume), and a paused account can
// still be deleted. Same shape as the fleet/project/xell pause routes.
router.post('/projects/:id/tokens/account/:accountId/pause', async (req, res) => {
  try {
    res.json(await setProviderAccountPaused(await resolveProjectParam(req.params.id), req.params.accountId, true,
      { by: req.body?.by || 'human@console', reason: req.body?.reason || null }));
  } catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
router.post('/projects/:id/tokens/account/:accountId/resume', async (req, res) => {
  try {
    res.json(await setProviderAccountPaused(req.params.id, req.params.accountId, false,
      { by: req.body?.by || 'human@console' }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.put('/projects/:id/tokens/:provider', async (req, res) => {
  try {
    const out = await setProviderToken(req.params.id, req.params.provider, req.body?.token);
    // A human REPLACED an account's key in place → same trigger as add, on the same door.
    await raiseRotationRequest({ projectId: req.params.id, provider: req.params.provider })
      .catch(() => {});
    res.json(out);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/projects/:id/tokens/:provider', async (req, res) => {
  try { res.json(await deleteProviderToken(req.params.id, req.params.provider)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── project API keys: the credential a DEPLOYED project files tickets with (190) ─────────────
// Same masked-read-model shape as the provider accounts above: the plaintext key exists exactly
// once, in the answer to the POST that minted it, and no read can ever hand it back (only the
// sha256 hash is stored). A key that has filed tickets is REVOKED, not deleted — the board must
// keep being able to say where those tickets came from.
router.get('/projects/:id/api-keys', async (req, res) => {
  try { res.json(await listProjectApiKeys(req.params.id)); }
  catch (err) { workErr(res, err); }
});
router.post('/projects/:id/api-keys', async (req, res) => {
  try {
    res.status(201).json(await createProjectApiKey(req.params.id, {
      label: req.body?.label, scopes: req.body?.scopes ?? null,
      created_by: req.body?.by || 'human@console',
    }));
  } catch (err) { workErr(res, err); }
});
router.post('/projects/:id/api-keys/:keyId/revoke', async (req, res) => {
  try {
    const out = await revokeProjectApiKey(req.params.keyId, { by: req.body?.by || 'human@console' });
    if (!out) return res.status(404).json({ error: 'no such API key' });
    res.json(out);
  } catch (err) { workErr(res, err); }
});
router.delete('/projects/:id/api-keys/:keyId', async (req, res) => {
  try {
    const out = await deleteProjectApiKey(req.params.keyId);
    if (!out) return res.status(404).json({ error: 'no such API key' });
    res.json(out);
  } catch (err) { workErr(res, err); }
});

// Regenerate a xell's .zeehive.env projection (spec §3.4) — e.g. after a site edit or a rename.
router.post('/xells/:id/env', async (req, res) => {
  try { res.json(await emitXellEnv(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── environments: the meta-DB source of truth for the untracked .env (migration 043) ─────────
// Read models are MASKED (secret values never returned — only a hint); the full value leaves the
// server through emitXellEnv (into a xell's own .zeehive.env) and the human export below. Mirrors
// the provider-tokens + sites route shapes.
router.get('/projects/:id/environments', async (req, res) => {
  try { res.json(await listEnvironments(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
router.post('/projects/:id/environments', async (req, res) => {
  try { res.json(await createEnvironment(await resolveProjectParam(req.params.id), req.body || {})); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
router.get('/environments/diff', async (req, res) => {
  try { res.json(await diffEnvironments(req.query.a, req.query.b)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/environments/:id', async (req, res) => {
  try { res.json(await updateEnvironment(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/environments/:id', async (req, res) => {
  try { res.json(await deleteEnvironment(req.params.id, req.query.force === '1')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
router.get('/environments/:id/vars', async (req, res) => {
  try { res.json(await listVars(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
router.put('/environments/:id/vars/:name', async (req, res) => {
  try { res.json(await setVar(req.params.id, req.params.name, { value: req.body?.value, is_secret: req.body?.is_secret })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/environments/:id/vars/:name', async (req, res) => {
  try { res.json(await deleteVar(req.params.id, req.params.name)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Bulk import a pasted .env blob (the migration path off on-disk files).
router.post('/environments/:id/import', async (req, res) => {
  try { res.json(await importEnv(req.params.id, req.body?.text, { is_secret: req.body?.is_secret !== false })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Human reveal: the full .env text (the second full-value door).
router.get('/environments/:id/export', async (req, res) => {
  try { res.json(await exportEnv(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
// Coverage check against the repo's .env.example — surfaces missing/extra keys before a ship.
router.get('/environments/:id/lint', async (req, res) => {
  try { res.json(await lintEnv(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// Which environment a xell resolves to (masked var names, never values) + pin/unpin it.
router.get('/xells/:id/env/resolved', async (req, res) => {
  try {
    const xell = await one(`SELECT * FROM xell WHERE id=$1`, [req.params.id]);
    if (!xell) return res.status(404).json({ error: 'xell not found' });
    res.json(await resolvedEnvView(xell));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xells/:id/environment', async (req, res) => {
  try { res.json(await setXellEnvironment(req.params.id, req.body?.environment_id || null)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Extract a xell's CURRENT environment as full .env text (human reveal) — its own .zeehive.env if
// present, else the resolved meta-DB environment. This is the "pull out what this xell is running".
router.get('/xells/:id/env/export', async (req, res) => {
  try { res.json(await extractXellEnv(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// ── project manifest: the repo's zeehive.yml vs the stored cache (spec §3.1) ─
// The :id is a project UUID OR NAME — the same id-or-name resolution every other project entry
// point uses (lib/project-resolve.js, the router verbs precedent). A bare uuid lookup threw
// `invalid input syntax for type uuid` for a caller that named its project — the exact name-vs-uuid
// 400 the /api/router/* handlers used to ship — and the manifest verbs are addressed from the same
// places the rest of the API is (the console, scripts, a human's ad-hoc curl). An unknown project
// still refuses, naming the projects that do exist (UnknownProject).
async function resolveProjectParam(id) {
  return resolveProjectId({ project: id });
}
// A project NAME that matches nothing is a 404 — the caller addressed a project that does not
// exist, and UnknownProject's message names which projects do — not the route's ordinary 400 for
// a malformed body. The name-vs-uuid sweep routes use this so an unknown name is never a postgres
// `invalid input syntax for type uuid` (that is the defect the sweep removes) and never a 500.
function projectErrorStatus(err, fallback = 400) {
  return err?.code === 'UNKNOWN_PROJECT' ? 404 : fallback;
}
router.get('/projects/:id/manifest', async (req, res) => {
  try { res.json(await getProjectManifest(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
router.post('/projects/:id/manifest/refresh', async (req, res) => {
  try { res.json(await refreshProjectManifest(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Generate the spinoff compose PROJECTION from the manifest (compose-authorship): preview by
// default; { write: true } writes it into the repo — only ever over a ZEEHIVE-generated file
// (marker check in lib/compose-gen.js); a project-owned compose is refused, with the reason.
router.post('/projects/:id/compose/generate', async (req, res) => {
  try { res.json(await generateProjectCompose(await resolveProjectParam(req.params.id), { write: req.body?.write === true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Draft generation; {write:true} writes zeehive.yml into the repo root (refused if one exists) —
// the human reviews and commits it. The ONE artifact ZEEHIVE may write into a project repo.
router.post('/projects/:id/manifest/draft', async (req, res) => {
  try { res.json(await draftProjectManifest(await resolveProjectParam(req.params.id), { write: req.body?.write === true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// The "no manifest yet" wizard: build a zeehive.yml PREVIEW from console form values (knobs),
// without writing anything. The human reviews/edits the YAML, then POSTs it to …/manifest/write.
router.post('/projects/:id/manifest/build', async (req, res) => {
  try { res.json(await buildManifestDraft(await resolveProjectParam(req.params.id), req.body?.knobs || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Write the human-approved zeehive.yml into the repo root and apply it to the meta-DB row.
// Refused when a valid manifest already exists (the repo file is the truth); the human edits
// that file and ↻ Refreshes instead.
router.post('/projects/:id/manifest/write', async (req, res) => {
  try {
    res.json(await writeProjectManifest(await resolveProjectParam(req.params.id), {
      yaml: req.body?.yaml,
      apply_meta: req.body?.apply_meta !== false,
      overwrite: req.body?.overwrite === true,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Compose onboarding — detect docker-compose*.yml, propose meta-DB (+ optional yml) changes,
// apply only after the human approves. Production container rows are never written.
//   GET  …/manifest/compose-plan     → the plan (read-only)
//   POST …/manifest/compose-apply    → { approved: true, write_yml?, apply_meta? }
router.get('/projects/:id/manifest/compose-plan', async (req, res) => {
  try { res.json(await getComposeOnboardingPlan(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/projects/:id/manifest/compose-apply', async (req, res) => {
  try {
    res.json(await applyComposeOnboarding(await resolveProjectParam(req.params.id), {
      approved: req.body?.approved === true,
      write_yml: req.body?.write_yml !== false,   // default ON — yml is the truth
      apply_meta: req.body?.apply_meta !== false, // default ON — meta-DB is what the pool reads
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── onboarding surface (Project Setup panel) ──────────────────────────────────
// Probe a FOLDER (works before the project exists): git state, manifest, compose files, env.
router.post('/projects/probe', (req, res) => res.json(probeRepo(req.body?.repo_root)));
// The readiness checklist: which gates pass, can it provision, can it SHIP.
router.get('/projects/:id/readiness', async (req, res) => {
  try { res.json(await projectReadiness(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(projectErrorStatus(err, 404)).json({ error: err.message }); }
});
// Machine × project BUILD-READINESS (ticket #173): for every machine of this project, can a
// build actually work there? Read-only probe — same docker facts verifyRequires uses, plus the
// meta-DB facts a placement needs. Verdict per machine: ok | unknown | missing, with the
// failing check NAMED. Rendered in the container matrix where the pool knobs are set.
router.get('/projects/:id/build-readiness', async (req, res) => {
  try { res.json(await buildReadinessForProject(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Machine × project BUILD BOOTSTRAP (ticket #173 follow-on): the one-click action that turns the
// probe's "missing" answer into created DEV prerequisites. PLAN FIRST — dry_run (the default)
// returns the ordered plan and performs nothing, so the console can show it before a human
// commits; dry_run:false performs each step idempotently, re-runs the probe, and records the
// action (build_bootstrap_action). QUEENZEE-performed; the dev-only guard in
// lib/build-bootstrap.js refuses a prod tier/container/stack.
router.post('/projects/:id/machines/:machineId/build-bootstrap', async (req, res) => {
  try {
    const dryRun = req.body?.dry_run !== false;
    res.json(await performBuildBootstrap(req.params.id, req.params.machineId, {
      dryRun, actor: req.body?.by || 'human@console',
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// The dev spawn template: what a new xell gets by default (couplings, runtime, pool size).
router.get('/projects/:id/pool-config', async (req, res) => {
  try { res.json(await getPoolConfig(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
router.patch('/projects/:id/pool-config', async (req, res) => {
  try { res.json(await updatePoolConfig(await resolveProjectParam(req.params.id), req.body || {})); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
// Shared-container inventory (prod containers included — a ship needs at least one shippable).
router.get('/projects/:id/containers', async (req, res) => {
  try { res.json(await listSharedContainers(await resolveProjectParam(req.params.id))); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
});
router.post('/projects/:id/containers', async (req, res) => {
  try { res.json(await createSharedContainer(await resolveProjectParam(req.params.id), req.body || {})); }
  catch (err) { res.status(projectErrorStatus(err)).json({ error: err.message }); }
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

// ── the DIFF VIEWER: the patch behind a diffstat ──────────────────────────────
// /xell/diffs answers "how much" (the numbers on every card, hexagon and land card). These two
// answer "what": the actual lines, read from wherever that stat was measured (the cxell for a
// cxelld zee, else the worktree; the xource for a landing's old..new range). Read-only.
router.get('/xells/:id/diff', async (req, res) => {
  try { res.json(await xellPatch(req.params.id, { kind: req.query.kind === 'own' ? 'own' : 'source' })); }
  catch (err) { res.status(404).json({ ok: false, error: err.message }); }
});
// A landing AND a PR are both land_request rows, so one route serves both gate cards.
router.get('/land/requests/:id/diff', async (req, res) => {
  try { res.json(await landRequestPatch(req.params.id)); }
  catch (err) { res.status(404).json({ ok: false, error: err.message }); }
});
// The xource's live dirty patch — broken-pipe modal "show the diff" / per-file preview.
// scope=staged|unstaged|all (default all).
router.get('/projects/:id/xource/diff', async (req, res) => {
  try {
    const scope = ['staged', 'unstaged', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
    res.json(await xourcePatch(req.params.id, { scope }));
  } catch (err) { res.status(404).json({ ok: false, error: err.message }); }
});

// queenzee activity log (the terminal modal)
router.get('/logs', async (req, res) => res.json(recentLogs(Number(req.query.n) || 200)));

router.get('/zees/:id/events', async (req, res) =>
  res.json(await q(`SELECT * FROM session_event WHERE zee_id = $1 ORDER BY ts DESC LIMIT 200`, [req.params.id])));

// ── cxell file explorer (read-only) — the panel that rides alongside the zee terminal ──
// List a directory inside the cxell, and read a text file the zee "presented" in the terminal.
// Same ssh2 door as the terminal bridge; no write path (a watcher sees, it does not edit).
router.get('/zees/:id/fs', async (req, res) => {
  try { res.json(await listCxellDir(req.params.id, req.query.path)); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});
router.get('/zees/:id/file', async (req, res) => {
  try { res.json(await readCxellFile(req.params.id, req.query.path)); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// ── container file explorer (read-only) — the panel that rides alongside the container shell ──
// List a directory inside a fleet container, and read a text file — the same explorer the zee
// terminal has, backed by short-lived docker execs instead of ssh. No write path (a watcher sees,
// it does not edit).
router.get('/containers/:id/fs', async (req, res) => {
  try { res.json(await listContainerDir(req.params.id, req.query.path)); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});
router.get('/containers/:id/file', async (req, res) => {
  try { res.json(await readContainerFile(req.params.id, req.query.path)); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// ── /xell skill → claim a ready xell, but ONLY if the session is inside its worktree ──
router.post('/xell/claim', requireQueenzeeLoops, async (req, res) => {
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

// ── IS SOMEBODY ALREADY IN THIS WORK? (#33) ────────────────────────────────────
// A PREFLIGHT: read-only, no side effects, and it exists so the human sees the answer BEFORE they
// press dispatch rather than in the receipt afterwards. The console's dispatch dialog calls it as the
// prompt is written (debounced). Advisory — it cannot refuse anything, and a failure inside it answers
// "no warnings" rather than an error, because a coordination hint must never stand between a human and
// a dispatch.
router.post('/xell/dispatch/overlap', async (req, res) => {
  const { project, task } = req.body || {};
  try {
    const { overlapForBrief, overlapNote } = await import('../lib/work-overlap.js');
    const projectId = project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`))?.id || null;
    const overlap = await overlapForBrief({ projectId, brief: task || '' });
    res.json({ ...overlap, note: overlapNote(overlap) });
  } catch (err) {
    res.json({ warnings: [], note: null, degraded: [`overlap check unavailable: ${err.message}`] });
  }
});

// ── /xell dispatch → queenzee spawns a zee INTO a ready worktree (confirmed) ───
router.post('/xell/dispatch', requireQueenzeeLoops, async (req, res) => {
  try {
    const out = await dispatchXell(req.body || {});
    // …and the same facts in the receipt, for a caller that did not preflight (a script, or a human who
    // typed fast). After the fact is weaker than before it, which is why the preflight above exists.
    let overlap = null;
    try {
      const { overlapForBrief, overlapNote } = await import('../lib/work-overlap.js');
      const o = await overlapForBrief({ projectId: out.project_id || null, brief: req.body?.task || '',
        excludeXellId: out.xell_id || out.id || null });
      overlap = { ...o, note: overlapNote(o) };
    } catch { /* advisory: a dispatch that happened is not undone by a hint that did not */ }
    res.json({ ...out, ...(overlap?.warnings?.length ? { overlap } : {}) });
  } catch (err) { res.status(400).json({ ...(err.detail || {}), error: err.message }); }
});
// Re-point a xell's database: { coupling: db-shared-dev|db-clone|db-shared-prod|db-isolated,
// container: <name|id>, dump: <snapshot id|'latest'> }. db-shared-prod is LIVE production;
// db-clone cuts the xell its own database inside the shared dev postgres (seconds, template copy).
router.post('/xells/:id/db', requireQueenzeeLoops, async (req, res) => {
  try { res.json(await attachXellDb(req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Harnesses (system-wide config layers). List the enabled ones for the picker; assign/switch a
// xell's harness (a HUMAN action — a harness decides config, never a landing target, so it is
// mutable; { harness: <key|id|null> }, null clears back to core-only).
// `?zee_type=worker|manager` narrows the list to the harnesses a xell of that TYPE may wear (054) —
// what every picker should ask for, so an operator is never offered a choice the assign would refuse.
// `?project=<id>` narrows it on the SCOPE axis (084): the system-wide harnesses plus that project's
// own, never another project's — which is what every picker bound to a project should ask for.
// Unfiltered still returns everything (the harness manager edits them all), and every row SAYS its
// scope (`scope`, `project_id`, `project_name`).
router.get('/harnesses', async (req, res) => {
  try { res.json(await listHarnesses({ zeeType: req.query.zee_type || null, projectId: req.query.project || null })); }
  catch (err) { res.status(503).json({ error: err.message }); }
});
// Harness authoring (unlimited DB-owned personas — persona/skills/memory, created from the dashboard).
router.post('/harnesses', async (req, res) => {
  try { res.json(await createHarness(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/harnesses/:key/full', async (req, res) => {
  try { res.json(await getHarnessFull(req.params.key)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
router.put('/harnesses/:key', async (req, res) => {
  try { res.json(await updateHarness(req.params.key, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/harnesses/:key', async (req, res) => {
  try { res.json(await deleteHarness(req.params.key)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// The harness avatar badge — served from the META-DB (`bundle.avatar_svg`, migration 082). It used to
// be read off disk under the Zeehive project's repo, which 404'd the badge on any queenzee that could
// not reach that repo; an SVG is text, so the row carries it like the rest of the harness. 404 when a
// harness has no badge stored. harnessAvatarSvg() is what validates it is really an SVG.
router.get('/harnesses/:key/avatar', async (req, res) => {
  try {
    const h = await one(`SELECT bundle FROM harness WHERE key=$1`, [req.params.key]);
    const svg = h ? harnessAvatarSvg(h.bundle) : null;
    if (!svg) return res.status(404).end();
    res.type('image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(svg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/xells/:id/harness', async (req, res) => {
  try {
    const r = await assignHarness(req.params.id, req.body?.harness ?? req.body?.key ?? null);
    // inject the (new) harness's files into a live cxell zee so a switch takes effect without a rebuild
    const inj = await reinjectHarnessIntoXell(req.params.id);
    res.json({ ...r, injected: inj });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Harness BRIDGE setup surface (docs §7): read/edit the live connection to a harness's external web
// UI (Hermes), and TEST it (real discovery-endpoint probe). Config is applied live — no land/ship.
router.get('/harnesses/:key/bridge', async (req, res) => {
  try { res.json(await getBridge(req.params.key)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
router.put('/harnesses/:key/bridge', async (req, res) => {
  try { res.json(await setBridge(req.params.key, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/harnesses/:key/bridge/test', async (req, res) => {
  try { res.json(await probeBridge(req.params.key)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// INBOUND bridge (docs §7): a human replies to the zee FROM the harness's web UI (Hermes). Addressed
// by the session key = xell SLUG. Opt-in + authenticated + xell-scoped: refused unless the harness
// set bridge.inbound AND the caller presents the shared HARNESS_BRIDGE_TOKEN. It reuses the SAME
// sendMessageToXell path as the 📨 button — the zee stays in its cxell; nothing new reaches in.
router.post('/harness-bridge/:slug/message', async (req, res) => {
  try {
    const b = bridgeBySlug(req.params.slug);
    if (!b) return res.status(404).json({ sent: false, reason: 'no live bridged zee for that session key' });
    const gate = bridgeInboundConfig(b.xellId);
    if (!gate.allowed) return res.status(403).json({ sent: false, reason: gate.reason });
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (auth !== process.env.HARNESS_BRIDGE_TOKEN) return res.status(401).json({ sent: false, reason: 'bad bridge token' });
    res.json(await sendMessageToXell(b.xellId, { text: req.body?.text || '', attachments: req.body?.images || [], by: `hermes:${req.body?.by || 'web-ui'}` }));
  } catch (err) { res.status(500).json({ sent: false, error: err.message }); }
});
// Apply the xell's pending server/sql/migrations + ops files (at ITS branch head) to ITS OWN
// database (clone/isolated only — shared dev is schema-frozen, prod only ships). This is how a
// zee TESTS a migration before landing it; the same files ride the ship to prod.
router.post('/xells/:id/db/migrate', requireQueenzeeLoops, async (req, res) => {
  try { res.json(await applyMigrationsToXell(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Roll the xell's OWN database FORWARD to prod's current schema: apply the prod-ledger migrations it
// does not yet reflect (clone/isolated only). Closes the pre-fork gap `db/migrate` cannot — a stale
// prod-dump restore. Reads prod read-only; never writes prod. See docs/schema-catchup-plan.md.
router.post('/xells/:id/db/catchup', requireQueenzeeLoops, async (req, res) => {
  try { res.json(await catchUpXellToProd(req.params.id)); }
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

// WHAT THIS HARNESS MAY DISPATCH — the composer's whole read model in one call.
// The console's prompt buttons are PER HARNESS (the persona is the consequential choice, not the
// credential), so everything the composer offers below that button is derived from it: the
// providers whose accounts are connected AND allowed by the effective model policy, the models
// allowed on each, the model a bare dispatch would land on, and what the autonomy scale actually
// means on that provider's runtime (a cxell always bypasses — see lib/dispatch-options.js).
//   ?project=<id>  required · ?harness=<key>  omit = the default for the type, `?harness=` = core
//   only · ?zee_type=worker|manager
router.get('/dispatch/options', async (req, res) => {
  try {
    res.json(await dispatchOptions({
      projectId: req.query.project,
      // Absent and empty are DIFFERENT inputs: absent = "no choice made" (the project/type default),
      // empty = an explicit "core only". Express gives undefined vs '' and both must survive here.
      harness: 'harness' in req.query ? req.query.harness : undefined,
      zeeType: req.query.zee_type || 'worker',
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── THE ROUTER (migration 139) — the project's front door ──────────────────────────────────────
// One manager-type zee per project (harness `router`, wearer limit 1) that accepts RAW prompts,
// recomposes them and decides the dispatch under the operator's router policy. The composer:
//   • asks /router/status whether it may dispatch at all (no live router → Dispatch disabled,
//     "Deploy router" shown);
//   • /router/deploy takes NO prompt text — a router's brief is fixed; a human picks only the
//     provider/model it thinks with;
//   • /router/redeploy is "swap it with a better model": same xell row, new zee (falls back to a
//     fresh deploy when none is live);
//   • /router/route hands the RAW prompt + a policy snapshot to the live router as a
//     🧭 ROUTING REQUEST (kind 'directive', images ride along like any composer message). Its
//     optional `custom` = { provider, model, mode, harness } is the composer's CUSTOM DEPLOYMENT
//     panel — the human's explicit decision, not a hint — validated in lib/router.js against the
//     same /dispatch/options read model the pickers are built from, so an unknown
//     provider/model/harness is refused here (400) naming what IS available, instead of reaching
//     the router as a setting it cannot honour.
router.get('/router/status', async (req, res) => {
  try {
    const { routerStatus } = await import('../lib/router.js');
    res.json(await routerStatus(req.query.project));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/router/deploy', async (req, res) => {
  try {
    const { deployRouter } = await import('../lib/router.js');
    res.json(await deployRouter(req.body || {}));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/router/redeploy', async (req, res) => {
  try {
    const { redeployRouter } = await import('../lib/router.js');
    const out = await redeployRouter(req.body || {});
    if (out?.ok === false) return res.status(409).json(out);
    res.json(out);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/router/route', async (req, res) => {
  try {
    const { routeRawPrompt } = await import('../lib/router.js');
    res.json(await routeRawPrompt(req.body || {}));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── the AI MODEL SPEC REGISTRY (migration 110) — what the fleet can dispatch on, stored as data ──
// GET the registry (optionally ?provider=…). This is the meta-DB source for the model picker's
// labels/notes AND the parameters (context window, parameter count) that harness model policies
// restrict against — the console's harness manager reads it to offer the bounds editor.
router.get('/ai-models', async (req, res) => {
  try { res.json(await modelSpecs({ provider: req.query.provider || null })); }
  catch (err) { res.status(503).json({ error: err.message }); }
});
// PUT one spec row — record what a model IS (label/note/context/parameters) so policies can
// restrict against real numbers. The key is immutable; everything else is operator data.
router.put('/ai-models/:provider/:key', async (req, res) => {
  try { res.json(await updateModelSpec(req.params.provider, req.params.key, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

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
router.post('/monitor/run', requireQueenzeeLoops, async (_req, res) => res.json(await monitorTick()));
router.get('/monitor/remote', async (_req, res) => res.json(await remoteAvailable()));

// ── container health: is each container actually running (per `docker ps`)? ───
router.post('/containers/check', requireQueenzeeLoops, async (_req, res) => res.json(await checkContainers()));

// On-demand schema-drift check of ONE db container against a REFERENCE database (the "Check diff"
// context-menu item on a db chip). Same read-only catalog comparison the 10-min drift tick runs, but
// measured NOW and for just this container.
//
// body.against = another db container's id, or absent/null for PRODUCTION (the default). Only the
// PROD comparison is a prod_diff verdict: it persists and broadcasts the container, so the chip's
// drift mark + tooltip repaint live. Any other reference is measured and REPORTED only — comparing
// dev against dev is how you tell "this db is drifted" from "every db is drifted the same way", and
// that answer must not overwrite the fleet's drift-from-prod colours.
router.post('/containers/:id/check-diff', async (req, res) => {
  try { res.json(await diffOneContainerAgainstProd(req.params.id, req.body?.against || null)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// On-demand DATA check of ONE db container: does it hold the ROWS the backup it was restored from
// recorded? The sibling of check-diff, and deliberately a different route with a different verdict —
// one number that answered both "is my schema prod's?" and "is my data here?" is what TKT-22-4F0E was
// about. Read-only counts, and production is refused as a subject (it is the reference).
router.post('/containers/:id/check-data', async (req, res) => {
  try { res.json(await checkContainerData(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Can this db be data-checked at all, and against which backup? The console asks BEFORE offering the
// menu item, so a human is never invited to run a check that can only answer "no reference".
router.get('/containers/:id/data-check-readiness', async (req, res) => {
  try { res.json(await dataCheckReadiness(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// The db containers this one can be measured against (the "Check diff" submenu's list): every other
// db in the project, PRODUCTION first — it is the default and the only reference that writes the chip.
router.get('/containers/:id/diff-candidates', async (req, res) => {
  try { res.json(await diffCandidates(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── duplicate PRODUCTION into this dev db (the "Duplicate prod" context-menu action) ──
// A prod backup + restore FUSED: streams a fresh pg_dump of production straight into pg_restore on
// this db, so it becomes an exact copy of live prod in one go. duplicateProdInto enforces the guards
// server-side — a prod target is refused (that's the gated restore-over-prod flow) and prod must be
// free — so a direct API call can't get around them.
router.post('/containers/:id/duplicate-prod', async (req, res) => {
  try { res.json(await duplicateProdInto({ container: req.params.id })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

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
// Can the queenzee reach this machine's daemon with the settings on its row? Read-only probe for
// the Deploy tab's per-machine "check" — answers ok:false (200) for an unknown context or a
// down daemon, so the UI can show WHICH setting is wrong rather than a thrown route error.
router.get('/machines/:id/check', async (req, res) => {
  try { res.json(await checkMachineConnection(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Per-project pool size on a machine (machine_pool) — the matrix pool knob writes here.
router.put('/machines/:id/pool', async (req, res) => {
  try {
    const projectId = req.body?.project_id || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
    res.json(await setMachinePool(req.params.id, projectId, req.body?.pool_size));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Per-project dev spawn priority on a machine (machine_pool, 038) — the matrix prio knob writes
// here. Priority is a project's placement choice, not a machine-wide habit; only max_xells (PATCHed
// onto the machine row) is shared across projects.
router.put('/machines/:id/priority', async (req, res) => {
  try {
    const projectId = req.body?.project_id || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
    res.json(await setMachinePriority(req.params.id, projectId, req.body?.dev_priority));
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
    `SELECT c.id, c.name, c.docker_ctx, c.host AS host, c.host_port, c.url AS label, c.health,
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
// ?register=1&project=<id> AUTO-REGISTERS every ready serial as a shared USB device row (item #3).
router.get('/machines/:id/usb-devices', async (req, res) => {
  try {
    if (req.query.register === '1' || req.query.register === 'true') {
      if (!req.query.project) return res.status(400).json({ error: 'project required to auto-register discovered devices' });
      return res.json(await discoverUsbDevices(req.params.id, { projectId: req.query.project }));
    }
    res.json(await listUsbDevices(req.params.id));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// List the adb devices a machine can SEE (adb-host container's USB phones, else the host adb server's
// network-connected phones), each tagged net|usb and marked whether it's already registered for the
// project — the dashboard's "list adb devices" action with a Register button per device.
router.get('/machines/:id/adb-devices', async (req, res) => {
  try { res.json(await listAdbDevices(req.params.id, { projectId: req.query.project || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Attach (or ?action=detach) a device to a xell by id — the dashboard's "attach device" button.
router.post('/xells/:id/device', requireQueenzeeLoops, async (req, res) => {
  const action = req.body?.action || 'attach';
  try {
    if (action === 'detach') return res.json(await detachDeviceXhip(req.params.id));
    res.json(await attachDeviceXhip(req.params.id, { kind: req.body?.kind || null }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── build: (re)build a per-xell server/webapp container (or a whole xell's stack) ──
// Optional build_ctx in the body sets the build host first ("build on X now"); omit to keep the
// stored one. build_ctx:null (or '') resets to build-where-you-run.
router.post('/containers/:id/build', requireQueenzeeLoops, async (req, res) => {
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

router.post('/xells/:id/build', requireQueenzeeLoops, async (req, res) => {
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
router.post('/xells/:id/reap', requireQueenzeeLoops, async (req, res) => {
  try { res.json(await reapXell(req.params.id, req.body?.reason || 'human-cleanup', { force: !!req.body?.force })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── lift a quarantine (ticket #81: the RESCUE arm) ────────────────────────────
// A quarantined xell is refused every agent until a human decides between rescuing the branch
// and reaping the cage. Reap is the existing /xells/:id/reap above; THIS is the rescue — it
// clears the quarantine (consecutive_deaths, quarantined_at, quarantine_deaths,
// quarantine_reason) so a fresh agent may be dispatched into the same worktree. Deliberately
// does NOT need queenzee loops: the stamp is a plain row update, and a console can only reach
// here through the running API. Clearing is idempotent (clearing an un-quarantined xell is a
// no-op), so the route never 409s — a human re-clicking a stale button should not be punished.
router.post('/xells/:id/unquarantine', async (req, res) => {
  try { res.json(await clearXellQuarantine(req.params.id, { by: req.body?.by || 'human@console' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// DANGER ZONE — purge ALL non-production xells in a project, mid-work and all (project setup →
// Danger tab, behind a typed confirmation). Prod is never a candidate (reaper excludes+refuses it).
router.post('/projects/:id/purge-dev', requireQueenzeeLoops, async (req, res) => {
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

// ── RESTART THIS XELL'S CAGE, because a human said it is wedged ──────────────────────────────────
// The console's only cure for the failure the recovery loop cannot see: a cxell docker still calls
// running, with a dead terminal and a silent agent inside it. GET reports what the cage is doing
// right now (so the confirm dialog can be TRUE about whether a live turn is about to be killed);
// POST runs the queenzee's own restart sequence — stop (only with `force`) → start → sshd → SEAL →
// resume the session. Loop-owned work, so an API-only instance must refuse it rather than act
// without the single-queenzee lock. Both answer 200 with a verdict, including their refusals
// ('running', 'missing', 'unsealed', 'no-cxell'): each of those is something an operator needs to
// read, not a 500 to guess at.
router.get('/xells/:id/cxell', requireQueenzeeLoops, async (req, res) => {
  try { res.json(await probeXellCxell(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/xells/:id/cxell/restart', requireQueenzeeLoops, async (req, res) => {
  try {
    res.json(await restartXellCxell(req.params.id, {
      by: req.body?.by || 'human@console', force: !!req.body?.force }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Nudge the xell's live cxell zee for a STATUS UPDATE — the flower's "nudge" button. Best-effort:
// returns { nudged:false, reason } (200) when there is no live zee to reach, so the UI can say so.
router.post('/xells/:id/nudge', async (req, res) => {
  try { res.json(await nudgeXellForStatus(req.params.id, { by: req.body?.by || 'human@console' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Send a COMPOSED message — long text and/or FILE attachments — to this xell's live cxell zee, for
// when the raw terminal is too clumsy. Files and long/multi-line text are handed to the zee as real
// files under its .zee-inbox and a pointer is typed into the live session; short text is typed inline.
// Body: { text, images: [{ name, type, data }], by }. `images` is a legacy name — it carries any file
// attachment. Returns { sent, attachments?, reason?/error? }.
//
// The 📨 window and 💬 talk deliver into the zee's session but used to write NO durable record — the
// console's conversation view (GET /xells/:id/messages) reads zee_message, so a sent operator
// message vanished from the audit: the human saw "Sent" and then nothing anywhere as received. So
// record it here the same way a router's routing request is recorded (lib/router.js): one zee_message
// row, its id handed to sendMessageToXell so the existing delivery-correction machinery works, then
// stamp delivered from the actual verdict. The same guard as router.js/managers.js — a correction
// written by messageUndelivered (the resume died) is never clobbered by this later stamp.
router.post('/xells/:id/message', async (req, res) => {
  try {
    const xellId = req.params.id;
    const by = req.body?.by || 'human@console';
    const text = String(req.body?.text || '').trim();
    const attachments = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!text && !attachments.length) {
      return res.json({ sent: false, delivery: 'none', reason: 'empty message (no text or attachments)' });
    }
    const xell = await one(`SELECT slug, project_id FROM xell WHERE id=$1`, [xellId]);
    if (!xell) return res.status(404).json({ error: 'no such xell' });
    const [row] = await q(
      `INSERT INTO zee_message (project_id, from_xell_id, from_slug, to_xell_id, to_slug, kind, body, meta)
       VALUES ($1, NULL, $2, $3, $4, 'directive', $5, $6::jsonb) RETURNING *`,
      [xell.project_id, by, xellId, xell.slug,
       text || `(${attachments.length} file attachment${attachments.length === 1 ? '' : 's'})`,
       JSON.stringify({ by, operator: true, attachments: attachments.length })]);
    const delivery = await sendMessageToXell(xellId, { text, attachments, by, messageId: row.id });
    await q(
      `UPDATE zee_message SET delivered=$2, delivery=$3::jsonb
        WHERE id=$1 AND NOT COALESCE((delivery->>'undelivered')::boolean, false)`,
      [row.id, !!delivery.sent, JSON.stringify(delivery)]);
    res.json(delivery);
  } catch (err) { res.status(400).json({ error: err.message }); }
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
// UN-ASK a held landing: the zee lowers its OWN pending land request(s) (`zee land --withdraw`).
// Symmetric with `zee tend --clear` / `zee done --clear`, and the reason a zee never has to leave a
// stale card behind when it changes its mind — the discipline is withdraw-then-land, not push again
// and let a human guess which of three cards is current. Approved requests are left alone: a human's
// decision is not an agent's to retract.
router.post('/xell/self/land/withdraw', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfWithdrawLand(x, { reason: req.body?.reason || null, request: req.body?.request || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Reconcile with main ON THE ZEE'S OWN: deliver current main into the cxell, merge it (pure script),
// rebuild. NOT gated — it touches only this xell's cxell + throwaway containers. `zee sync` maps here.
router.post('/xell/self/sync', requireQueenzeeLoops, async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfSync(x, { rebuild: req.body?.rebuild !== false })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Catch this cxell's OWN db up to prod's current schema (clone/isolated). NOT gated — it writes only
// this xell's throwaway db and reads prod read-only, exactly the class of `zee build`. `--restore`
// (isolated only) rebuilds from the latest full prod snapshot instead of rolling forward.
router.post('/xell/self/catchup', requireQueenzeeLoops, async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfCatchup(x, { restore: !!req.body?.restore })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Hand out the next free db/migrations number, counting what is LANDED, what every live xell's
// worktree holds and what other zees have claimed — the one thing a caged zee cannot see for itself.
// NOT gated and advisory (it hands out a number, it does not gate a landing). `zee migration-number`.
router.post('/xell/self/migration-number', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfMigrationNumber(x, { name: req.body?.name || null, again: !!req.body?.again })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// File a ship request (shipgate) — the zee asks, a human approves, the queenzee deploys from main.
router.post('/xell/self/ship', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfShip(x, { targets: req.body?.targets || null, reason: req.body?.reason || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// UN-ASK a held ship (`zee ship --withdraw`): the zee lowers its OWN pending/approved ship request
// before the deploy starts. The symmetric verb to `zee land --withdraw` — nothing ships, nothing is
// rejected, nothing is reverted; the card leaves the human's screen and the row records the
// withdrawal in the ship ledger. REFUSED once the deploy has started (status='shipping').
router.post('/xell/self/ship/withdraw', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfWithdrawShip(x, { reason: req.body?.reason || null, request: req.body?.request || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// ASK to bind this xell to the prod stack — recorded only; a human confirms, then the queenzee binds.
router.post('/xell/self/prod-request', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfProdRequest(x, { reason: req.body?.reason || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// ASK the queenzee to SEED production: name landed .sql file(s) under server/sql/seeds/ and a human
// approves them in the console; the QUEENZEE then runs them against the prod db. The narrow version
// of a prod bind — a zee that only needs rows in prod never has to hold the production database.
router.post('/xell/self/seed-request', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    const files = b.files || (b.file ? [b.file] : []);
    res.json(await selfSeedRequest(x, { files, reason: b.reason || null, site: b.site || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Read-only: where did my seed request get to? (`zee seed --status`)
router.get('/xell/self/seed-request', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfSeedStatus(x)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// OFFER your built webapp to a human in the console (`zee verify-webapp`). A human turned on
// VISUAL VERIFICATION for this xell at dispatch time; this records an OPEN offer (the webapp
// container url + this xell's head commit) and broadcasts it so the console renders a card. The
// zee only OFFERS — a human opens the link or dismisses it; no gate, no prod, no land/ship.
router.post('/xell/self/verify-webapp', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfVerifyWebapp(x)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Archive THIS xell's conversation (`zee upload-conversation`). NOT gated — an archive is a fact
// about a throwaway xell, like `zee working`. The zee CLI reads its own transcript and POSTs the
// raw text; the server parses + stores it for a manager/human to review.
router.post('/xell/self/upload-conversation', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfUploadConversation(x, {
      content: req.body?.content ?? null, session_id: req.body?.session_id || null,
      title: req.body?.title || null, reason: req.body?.reason || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// A MANAGER reviews the conversation archives of its crew (`zee conversations`). Token-scoped like
// every crew verb: only xells the calling manager dispatched. `?xell=<slug>` narrows to one;
// `&full=1` returns the transcript.
router.get('/xell/self/conversations', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfConversations(x, { xell: req.query.xell || null, full: req.query.full === '1' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Propose done — flags the xell for a human's "Mark done"; the zee never despawns itself.
// {clear:true} WITHDRAWS a done proposal (`zee done --clear`) — symmetric with tend/hint clearing.
// A zee handed more work after proposing done had no way back, and the stale proposal kept asking a
// human to reap it. Retracting a proposal a human already CONFIRMED is refused (see retractDone).
router.post('/xell/self/done', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfDone(x, { summary: req.body?.summary || null, clear: !!req.body?.clear })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Raise (or --clear) a tend: "I need a human in the console". Opens no gate, blocks nothing — it
// just flags the xell as needing attention (occ-tendRequest) for a human to see.
router.post('/xell/self/tend', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfTend(x, { reason: req.body?.reason || null, clear: !!req.body?.clear })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Readiness HINT (or --clear): "this looks land/ship-ready — a human should decide". Opens no gate
// and pushes nothing; it lights the land? / ship? prompt so a human sees the button. The zee calls
// the REAL land/ship only when 100% certain the job is done; otherwise it hints and leaves the call.
router.post('/xell/self/hint-land', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfHint(x, 'land', { reason: req.body?.reason || null, clear: !!req.body?.clear })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xell/self/hint-ship', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfHint(x, 'ship', { reason: req.body?.reason || null, clear: !!req.body?.clear })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Ping "I am actively working" — asserts live activity the passive poller can't see for a cxell, and
// clears any open tend. The hive shows occ-working.
// The cage's OWN turn boundaries — the vendor CLI's turn hooks call `zee turn --start|--end` from
// inside the cxell, which is the only way an INTERACTIVE turn (a human or a manager typing into the
// pane) can be seen at all: the queenzee does not start that turn, so no loop of its own can observe
// it (queenzee/self.js selfTurn says what it does and does not cover). Token-scoped like every self
// verb, opens no gate, and never records a cost.
router.post('/xell/self/turn', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfTurn(x, { state: req.body?.state || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xell/self/working', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfWorking(x, { note: req.body?.note || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Store this xell's typed result on the PLANE-3 execution it is bound to (the observability-spine
// weld — docs/hierarchical-workflow-adoption.md §3.2). Interim storage on execution.outputs until
// the stage-2 data plane exists. The execution is resolved from xell.execution_id (never an
// agent-named id). Token-scoped like every self verb.
router.post('/xell/self/handover', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfHandover(x, { result: req.body?.result ?? null, override: req.body?.override === true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// END the current turn and put the execution this xell is on into 'waiting' under a held lease — the
// anti-spin primitive. Token-scoped; the execution is resolved from xell.execution_id.
router.post('/xell/self/await', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfAwait(x, { hours: req.body?.for ?? null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Which environment this xell is loaded with (masked — var NAMES only; the values live in the
// cxell's own .zeehive.env). Read-only, token-scoped. `zee env` maps here.
router.get('/xell/self/provider-env', async (req, res) => {
  // SERVER-COMPUTED runnable env for ONE provider this xell's project has connected — what a zee
  // needs to actually RUN that vendor's CLI (`zee creds --provider <key> --export`). Read-only,
  // token-scoped, opens no gate. The mapping lives in the runtime adapters (lib/cxell-runtimes.js)
  // and is computed through the SAME guarded credential door — never duplicated in the CLI.
  // The answer is the EXACT ACCOUNT THIS CAGE WAS GRANTED, read from the xell_provider_grant ledger
  // (see self.js) — never the project's current key after a rotation.
  try {
    const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfProviderEnv(x, { provider: req.query.provider || null }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/xell/self/env', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await resolvedEnvView(x)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
// Extract THIS xell's current environment as full .env text — `zee env --export`. Full values, but
// a zee only ever sees its OWN env (token-scoped), which it already holds in its .zeehive.env file.
router.get('/xell/self/env/export', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await extractXellEnv(x.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// (Re)build this cxell's OWN app tier so a cxell zee can run e2e tests against its change. NOT
// human-gated (building your own throwaway containers is the point of a xell) — it collects the
// cxell's commits onto the worktree, then runs the same queenzee build a host zee does.
router.post('/xell/self/build', requireQueenzeeLoops, async (req, res) => {
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
router.post('/xell/self/device', requireQueenzeeLoops, async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfDevice(x, { action: req.body?.action || 'attach', kind: req.body?.kind || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── MANAGER-ZEE verbs (crew): dispatch · monitor · converse · suggest-done ─────
// Same authentication and the same shape as every other self verb — the CALLER is resolved from its
// own token, so a manager can only ever reach ITS OWN crew and a worker only its own manager. The
// manager half is refused for a worker (with an explanation, not a 404); `report`/`inbox` are open to
// every zee, because talking to your manager is the one reach outside its xell a worker is meant to
// have.
router.get('/xell/self/zees', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfCrew(x)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/xell/self/dispatch', requireQueenzeeLoops, async (req, res) => {
  try {
    const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfDispatch(x, req.body || {}));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Replace the ZEE inside one of MY crew's xells, KEEPING the xell (`zee swap`). Not human-gated for
// the same reason `dispatch` is not: what comes out the other side is an ordinary caged worker whose
// every irreversible act still meets the same gates. The refusals (not my crew, a manager target, a
// manager harness, an open human gate on that xell) and the collect-before-recreate ordering that
// protects the outgoing zee's uncollected commits both live in selfSwap.
router.post('/xell/self/swap', requireQueenzeeLoops, async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfSwap(x, {
      to: req.body?.to, harness: req.body?.harness, task: req.body?.task || null,
      model: req.body?.model || null, mode: req.body?.mode || null,
      runtime: req.body?.runtime || null, title: req.body?.title || null,
      provider: req.body?.provider || null, provider_token_id: req.body?.provider_token_id || null,
    })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xell/self/say', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfSay(x, { to: req.body?.to, message: req.body?.message, kind: req.body?.kind || 'directive' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xell/self/report', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfReport(x, { message: req.body?.message, kind: req.body?.kind || 'report' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// `zee review --of <sha>` — RECORD a review of a landed diff (ticket #56): reviewer, verdict,
// findings count, report. A first-class record, NOT a gate — nothing on the land/ship path waits
// on it. The landing/ship cards surface it so an unreviewed change ships only as a knowing choice.
router.post('/xell/self/review', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfReview(x, {
      commit: req.body?.commit, verdict: req.body?.verdict,
      findings_count: req.body?.findings_count, report: req.body?.report })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// `zee a2a <card-url> --message "…"` — send an A2A SendMessage to an EXTERNAL agent card URL,
// queenzee-mediated and recorded (phase 4, plan §6). The sender is the calling xell, never a payload.
router.post('/xell/self/a2a', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfA2ASend(x, { card_url: req.body?.card_url, message: req.body?.message })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// `zee meet` — peer-to-peer GROUP CHAT rooms (docs/zee-meet-plan.md). The human directive: agents
// talk to each other in a group chat via a zee meet verb — create shows a code, another zee
// attends with it, and they talk. Token-scoped exactly like the other self verbs; any live zee may
// create/attend/post (DR-2), and the room's membership set is the visibility boundary.
router.post('/xell/self/meet/create', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfMeetCreate(x, { title: req.body?.title })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xell/self/meet/attend', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfMeetAttend(x, { code: req.body?.code })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xell/self/meet/say', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfMeetSay(x, { code: req.body?.code, message: req.body?.message })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/xell/self/meet', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfMeet(x, { code: req.query.code || null })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/xell/self/inbox', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfInbox(x, { all: req.query.all === '1' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/xell/self/suggest-done', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfSuggestDone(x, { to: req.body?.to, reason: req.body?.reason || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// MANAGER asks a HUMAN to clean up the project xource (`zee xource-clean --reason "…"`). The
// mangled-checkout case: a dirty/conflicted main checkout blocks every landing and ship, and only a
// human's approve resets it. Refused for a worker inside selfXourceClean.
router.post('/xell/self/xource-clean', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfXourceClean(x, { reason: req.body?.reason || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// A ROUTER asks a HUMAN for another MANAGER (`zee mint-manager --reason "…"`, 149). Records a
// REQUEST and nothing else: no agent may create a manager, and the queenzee mints it on approval
// through the same createManagerZee the console button calls. Refused for a worker (requireManager)
// and for a non-router manager (by harness chain) inside selfMintManager.
router.post('/xell/self/mint-manager', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfMintManager(x, {
      reason: req.body?.reason || null, task: req.body?.task || null,
      harness: req.body?.harness || null, title: req.body?.title || null,
      withdraw: req.body?.withdraw === true, status: req.body?.status === true,
    })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── MINISTER verbs: review the queenzee's operations, file tickets about them ──────────────────
// `zee ops` — the ops digest (logs/alerts/landings/ships/gates/burn/backups), read-only, MANAGER
// only (refused with an explanation in selfOps). `zee ticket` — the one write the critique gets:
// a ticket in the caller's OWN project (resolved from the token, never the body).
router.get('/xell/self/ops', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfOps(x, { hours: req.query.hours || 24, logs: req.query.logs || 300 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/xell/self/ticket', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    res.json(await selfTicketCreate(x, { title: b.title, body: b.body || null, kind: b.kind || null,
      priority: b.priority ?? null, labels: b.labels || null, notify: b.notify === true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/xell/self/tickets', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfTicketList(x, { status: req.query.status || null, q: req.query.q || null })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MANAGER-ZEE verbs (harnesses): a manager mints its own specialised WORKER personas ─────────
// Same authentication, same shape, same NOT-gated reasoning as `zee dispatch`: what a manager creates
// here is scoped to ITS OWN project (084) and can only ever be worn by a caged worker. The project is
// resolved from the token and never from the body, and everything that would grow the manager's own
// authority is refused in self.js with a sentence — a manager persona, any system-wide harness,
// another project's harness, a non-persona field, or a harness a live xell is wearing.
router.get('/xell/self/harnesses', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfHarnessList(x)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/xell/self/harness/:key', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfHarnessGet(x, req.params.key)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/xell/self/harness', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfHarnessCreate(x, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.put('/xell/self/harness/:key', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfHarnessUpdate(x, req.params.key, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/xell/self/harness/:key', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return; res.json(await selfHarnessDelete(x, req.params.key)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── HUMAN side of the manager layer ───────────────────────────────────────────
// Adding a manager zee is a HUMAN act (unlimited — add as many as you can afford to run): the
// queenzee provisions/claims a xell, stamps it role='manager', binds it to production READ-ONLY (its
// own SELECT-only postgres role) and cages a zee in it wearing the manager harness.
router.post('/managers', async (req, res) => {
  try { res.json(await createManagerZee(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message, detail: err.detail || null }); }
});
// A manager's crew, for the console.
router.get('/xells/:id/crew', async (req, res) => {
  try { res.json(await crewFor(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// A xell's message history — the manager⇄worker conversation (directives a manager sent, reports a
// worker sent back), for the console. Human-facing audit: READING marks NOTHING read — only the
// agent's own `zee inbox` clears its unread flags.
router.get('/xells/:id/messages', async (req, res) => {
  try {
    const x = await one(`SELECT id FROM xell WHERE id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'no such xell' });
    res.json(await messagesForXell(req.params.id));
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// A xell's CONVERSATION ARCHIVES (`zee upload-conversation` / "upload on done"), for the console.
// Human-facing audit, exactly like /xells/:id/messages: reading marks nothing read.
router.get('/xells/:id/conversations', async (req, res) => {
  try {
    const x = await one(`SELECT id FROM xell WHERE id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'no such xell' });
    const { conversationsForXell } = await import('../lib/conversations.js');
    res.json(await conversationsForXell(req.params.id, { full: req.query.full === '1' }));
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// THE XELL OBSERVABILITY VIEW — per-TURN usage + cost + play-by-play events, for the console's
// right-click "Observability" action. Read-only: turns are written by the turn ledger
// (lib/turn-ledger.js) at spawn/resume/interactive boundaries; this endpoint just reads them.
// Same 503-not-throw contract as /fleet — a read model must never take the queenzee down.
router.get('/xells/:id/observability', async (req, res) => {
  try {
    const x = await one(`SELECT id FROM xell WHERE id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'no such xell' });
    const { turnsForXell, workflowTreeForXell } = await import('../lib/turn-ledger.js');
    const turns = await turnsForXell(req.params.id, { zeeId: req.query.zee_id || null, limit: req.query.limit || 50 });
    // The WELD tree — the nested drill-down waterfall (work_node → execution → turns → gateway
    // calls) per work node, from the same read-only door. A turn with no execution lives in `turns`
    // and nowhere here; an execution with turns appears in both.
    const workflow = await workflowTreeForXell(req.params.id);
    // Per-turn event counts ride along so the UI can show "N events" without fetching them all.
    res.json({ ok: true, xell_id: req.params.id, turns, workflow });
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// The PLAY-BY-PLAY events for ONE turn (the `turn_id` side of the observability view).
router.get('/turns/:id/events', async (req, res) => {
  try {
    const t = await one(`SELECT id FROM zee_turn WHERE id=$1`, [req.params.id]);
    if (!t) return res.status(404).json({ error: 'no such turn' });
    const { eventsForTurn } = await import('../lib/turn-ledger.js');
    res.json({ ok: true, turn_id: req.params.id, events: await eventsForTurn(req.params.id) });
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// THE ZEE'S CAPTURED CONVERSATION — the actual text the zee's model produced during its turns,
// from the observability feed (assistant events classified at capture time by lib/turn-ledger.js
// into conversation vs thinking). The mobile chat's Chat tab renders this, so a zee's speech
// surfaces WITHOUT the zee calling any tool. Newest-first; `limit` caps the count (default 100).
// Read-only, same 503-not-throw contract as the other read models.
router.get('/xells/:id/conversation', async (req, res) => {
  try {
    const x = await one(`SELECT id FROM xell WHERE id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'no such xell' });
    const { conversationForXell } = await import('../lib/turn-ledger.js');
    const items = await conversationForXell(req.params.id, { limit: req.query.limit || 100 });
    res.json({ ok: true, xell_id: req.params.id, items });
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// THE LLM GATEWAY LEDGER for one xell — the transport-layer record of every AI call that crossed
// the queenzee gateway (lib/gateway.js → llm_gateway_request). Read-only; the gateway writes it.
// Same 503-not-throw contract as the other read models.
router.get('/xells/:id/gateway-requests', async (req, res) => {
  try {
    const x = await one(`SELECT id FROM xell WHERE id=$1`, [req.params.id]);
    if (!x) return res.status(404).json({ error: 'no such xell' });
    const { requestsForXell } = await import('../lib/gateway.js');
    res.json({ ok: true, xell_id: req.params.id, requests: await requestsForXell(req.params.id) });
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// THE BODIES of ONE gateway request (lib/gateway-bodies.js → llm_gateway_body, migration 162).
// The list endpoint ships NO body text (bodies are big and cold); a human expanding one call
// fetches exactly that call's request/response bodies here. Scoped to the xell so a request id
// from another xell is not readable.
router.get('/xells/:id/gateway-requests/:requestId/body', async (req, res) => {
  try {
    const reqRow = await one(
      `SELECT id FROM llm_gateway_request WHERE id=$1 AND xell_id=$2`,
      [req.params.requestId, req.params.id]);
    if (!reqRow) return res.status(404).json({ error: 'no such request for this xell' });
    const { bodiesForRequest } = await import('../lib/gateway-bodies.js');
    const body = await bodiesForRequest(req.params.requestId);
    if (!body) return res.status(404).json({ error: 'no bodies captured for this request (the project switch may be off, or it predates capture)' });
    res.json({ ok: true, xell_id: req.params.id, ...body });
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// THE PER-PROJECT BODY-CAPTURE SWITCH (pool_config.gateway_body_capture, migration 162) —
// default ON. Read returns the current value; POST flips it. A human turns capture off for a
// project whose bodies they do not want stored (privacy/size); the ledger row is written either way.
router.get('/gateway/body-capture', async (req, res) => {
  try {
    const proj = req.query.project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`)).id;
    const { gatewayBodyCaptureEnabled } = await import('../lib/gateway-bodies.js');
    res.json({ ok: true, project_id: proj, gateway_body_capture: await gatewayBodyCaptureEnabled(proj) });
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/gateway/body-capture', async (req, res) => {
  try {
    const proj = req.body?.project;
    if (!proj) return res.status(400).json({ error: 'project required' });
    const enabled = req.body?.gateway_body_capture !== false;
    const { setGatewayBodyCapture } = await import('../lib/gateway-bodies.js');
    const val = await setGatewayBodyCapture(proj, enabled);
    broadcast('project', { id: proj, gateway_body_capture: val });
    res.json({ ok: true, project_id: proj, gateway_body_capture: val });
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// DONE SUGGESTIONS — a manager proposed a xell is finished; a human decides. Approving MARKS THE
// TASK DONE and reaps the cxell (the console asks for a typed confirmation first), so this is the
// same class of irreversible act as a landing: no zee path to the decision, ever.
router.get('/done-suggestions', async (req, res) => {
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  try { res.json(await listDoneSuggestions(req.query.project, { open: req.query.all !== '1' })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/done-suggestions/:id/:decision(approve|reject)', async (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approved' : 'rejected';
  try {
    res.json(await decideDoneSuggestion(req.params.id, decision, req.body?.by || 'human@console',
      { force: req.body?.force === true }));
  } catch (err) { res.status(409).json({ error: err.message }); }
});
router.post('/done-suggestions/:id/dismiss', async (req, res) => {
  try { res.json(await dismissDoneSuggestion(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// SWAP THE ZEE WORKING A XELL — the console half of `zee swap` (self.js). A human picks a xell and a
// persona, and the xell comes back with a new zee on the SAME row: same branch, same commits, same
// containers, same database, same card. Only WHO is in it changes.
//
// It calls the SAME function the manager verb calls (swapZeeInXell), which is the whole point: the
// collect-before-recreate ordering that protects the outgoing zee's uncollected commits — and every
// refusal around it (an open human gate on that xell, a retired xell, a persona whose zee_type does
// not match the xell's) — exists once, not once per caller.
//
// No new gate, and no new authority: a human already dispatches into any xell in the project from
// this console. Unlike the manager verb it is not scoped to one crew (a human owns every xell), and
// when the xell DOES have a manager that manager is told, so it never finds a persona it did not ask
// for. A refusal answers 409 with the server's own sentence — the console shows that sentence.
router.post('/xells/:id/swap', async (req, res) => {
  try {
    const b = req.body || {};
    const out = await swapXellZeeAsHuman({
      xellId: req.params.id, harness: b.harness, task: b.task || null,
      model: b.model || null, mode: b.mode ?? null, runtime: b.runtime || null,
      title: b.title || null, by: b.by || 'human@console',
      provider: b.provider || null, provider_token_id: b.provider_token_id || null,
    });
    if (out?.ok) return res.json(out);
    // 404 a xell that does not exist · 409 a REFUSAL (a rule said no, and the answer says which) ·
    // 502 the swap was allowed and the queenzee could not finish it (the dispatch died; the answer
    // says what happened to the commits) · 400 bad input (no harness named). Distinct on purpose:
    // "you asked for something we refuse" and "we tried and could not" are different facts, and only
    // the second one is worth retrying unchanged.
    res.status(out?.status === 'not_found' ? 404
      : out?.status === 'refused' ? 409
      : out?.status === 'error' ? 502 : 400).json(out);
  } catch (err) { res.status(400).json({ error: err.message, detail: err.detail || null }); }
});

// An operator filing a done suggestion on a manager's behalf (still only a suggestion — it lands on
// the same human gate, which is the point: this cannot become a shortcut to marking things done).
router.post('/xells/:id/suggest-done', async (req, res) => {
  try {
    const target = await one(`SELECT * FROM xell WHERE id=$1`, [req.params.id]);
    if (!target) return res.status(404).json({ error: 'no such xell' });
    const manager = target.manager_xell_id
      ? await one(`SELECT * FROM xell WHERE id=$1`, [target.manager_xell_id]) : null;
    if (!manager) return res.status(409).json({ error: 'that xell has no manager to suggest on behalf of' });
    res.json(await suggestDone({ manager, target, reason: req.body?.reason || null }));
  } catch (err) { res.status(400).json({ error: err.message }); }
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

// HUMAN side of the prod SEED request (queenzee/seedgate.js) — list, read the exact SQL, approve
// (which RUNS it on production), reject, dismiss. Same shape as the ship gate and, like it, there is
// deliberately NO zee path to approve: a zee may only ask.
router.get('/prod-seed/requests', async (req, res) => {
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  res.json(await listProdSeedRequests(req.query.project, { open: req.query.all !== '1' }));
});
// The SQL a human is being asked to approve, read at the request's own sha — what is shown is
// byte-for-byte what will run.
router.get('/prod-seed/requests/:id/sql', async (req, res) => {
  try { res.json(await seedRequestSql(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
router.post('/prod-seed/requests/:id/:decision(approve|reject)', async (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approved' : 'rejected';
  try { res.json(await decideProdSeed(req.params.id, decision, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
router.post('/prod-seed/requests/:id/dismiss', async (req, res) => {
  try { res.json(await dismissSeedRequest(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
// A HUMAN filing a seed request on a zee's behalf (the operator's own "seed prod from this xell"),
// mirroring POST /api/xells/:id/ship. Still only a REQUEST — it lands in the same pending queue and
// someone still approves it, so nothing here is a shortcut to writing production.
router.post('/xells/:id/seed', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await requestProdSeed({ xellId: req.params.id, files: b.files || (b.file ? [b.file] : []),
      reason: b.reason || null, site: b.site || null }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── XOURCE CLEAN-UP — the project main checkout is mangled and landings/ships are blocked ──────
// Two doors onto the SAME engine (lib/xource-clean.js):
//   * Project setup → Xource: the human sees the state and clicks "Clean up xource" directly.
//   * A MANAGER filed a request (`zee xource-clean`); the human decides it here.
// Both reset the checkout to the main tip (aborting merges/rebase, preserving xell worktrees) —
// the queenzee performs it, never a zee, and never in a nested (simulate) queenzee.
router.get('/projects/:id/xource', async (req, res) => {
  try {
    const p = await one(`SELECT * FROM project WHERE id=$1`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'project not found' });
    res.json(xourceState(p.repo_root, p.main_branch || 'main'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/projects/:id/xource/clean', async (req, res) => {
  try {
    res.json(await cleanXourceNow(req.params.id, { by: req.body?.by || 'human@console', reason: req.body?.reason || null }));
  } catch (err) { res.status(409).json({ error: err.message }); }
});
// Commit STAGED work on the xource (the keep half of the broken-pipe modal on the git-graph
// tip). Clear is /xource/clean above; this is the other door. Message is required — it lands on
// main. Refused in simulate mode (nested queenzee) the same way clean is.
router.post('/projects/:id/xource/commit', async (req, res) => {
  try {
    res.json(await commitXourceStaged(req.params.id, {
      message: req.body?.message || null,
      by: req.body?.by || 'human@console',
    }));
  } catch (err) { res.status(409).json({ error: err.message }); }
});
// Stash dirty xource work (staged + unstaged + untracked). Third recovery door: park the dirt so
// the checkout is clean without discarding it. Refused in simulate mode like clean/commit.
router.post('/projects/:id/xource/stash', async (req, res) => {
  try {
    res.json(await stashXource(req.params.id, {
      message: req.body?.message || null,
      by: req.body?.by || 'human@console',
    }));
  } catch (err) { res.status(409).json({ error: err.message }); }
});
// Commit the xource's DIRTY work in ONE step (stage tracked changes, then commit) — the "commit
// locally" door. Unlike /xource/commit (staged-only), this needs no separate staging step, so a
// human can commit their local work and then push. Same guards (on main, PROVISION_MODE).
router.post('/projects/:id/xource/commit-dirty', async (req, res) => {
  try {
    res.json(await commitXourceDirty(req.params.id, {
      message: req.body?.message || null,
      by: req.body?.by || 'human@console',
    }));
  } catch (err) { res.status(409).json({ error: err.message }); }
});
router.get('/xource-clean/requests', async (req, res) => {
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  res.json(await listXourceCleanRequests(req.query.project, { open: req.query.all !== '1' }));
});
router.post('/xource-clean/requests/:id/:decision(approve|reject)', async (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approved' : 'rejected';
  try { res.json(await decideXourceClean(req.params.id, decision, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
router.post('/xource-clean/requests/:id/dismiss', async (req, res) => {
  try { res.json(await dismissXourceClean(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// ── MANAGER MINT — a router asked for a manager; a HUMAN decides here (149) ────────────────────
// Approve → the QUEENZEE mints the manager itself (lib/manager-mint.js → manager-spawn), which is
// the same call POST /api/managers makes for a human clicking "Add manager". Reject → the row
// closes and the router dispatches a worker instead. Nothing here lets an agent mint anything.
router.get('/manager-mints', async (req, res) => {
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  res.json(await listManagerMintRequests(req.query.project, { open: req.query.all !== '1' }));
});
router.post('/manager-mints/:id/:decision(approve|reject)', async (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approved' : 'rejected';
  try { res.json(await decideManagerMint(req.params.id, decision, req.body?.by || 'human@console',
                                         { note: req.body?.note || null })); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
router.post('/manager-mints/:id/dismiss', async (req, res) => {
  try { res.json(await dismissManagerMint(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// ── CREDENTIAL INJECTION — a rotated or repaired provider key reaches LIVE cages ───────────────
// A request the QUEENZEE raised (a human connected/replaced an account → 'rotation'; a zee's turn
// died on a 401 → 'auth-death'), decided by a HUMAN here. Approve → the queenzee recomputes the
// credential env from the meta-DB, rewrites ONLY the credential lines in each named cage's
// /etc/environment, re-runs the adapter's authSetupCmd, and records a per-xell receipt (masked hint
// only). There is deliberately NO zee path to approve: a zee never injects, asks for, or approves an
// injection — same division of labour as xource-clean and the prod gates.
router.get('/credential-inject/requests', async (req, res) => {
  if (!req.query.project) return res.status(400).json({ error: 'project required' });
  res.json(await listCredentialInjectRequests(req.query.project, { open: req.query.all !== '1' }));
});
router.post('/credential-inject/requests/:id/:decision(approve|reject)', async (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approved' : 'rejected';
  try { res.json(await decideCredentialInject(req.params.id, decision, req.body?.by || 'human@console')); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
router.post('/credential-inject/requests/:id/dismiss', async (req, res) => {
  try { res.json(await dismissCredentialInject(req.params.id, req.body?.by || 'human@console')); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// ── WORK TRACKER: tickets + the work-item hierarchy (058) ────────────────────
//
// The layer that records what the work IS, rather than which agents are running. Project-scoped by
// `?project=` exactly like every other read model here (a POST takes `project` in the body).
//
// The error contract, stated once and honoured by every handler below:
//   400 — bad input, with {error} saying what was wrong. A MALFORMED id is this, not a 404:
//         `"not-a-uuid" is not a valid work item id`. The two mistakes are different — a typo in
//         a URL and a link to something deleted — and each deserves its own answer.
//   404 — a well-formed id that names nothing
//   409 — a REFUSED move/delete/transition, with the reason as a sentence a human can read
//   never a bare 500: the database's own refusals (nesting rank, cross-project parent, cycle) are
//   raised as messages written for a person, and they arrive here as ordinary Errors.
//
// Which refusals are 409 rather than 400: a 400 says "you sent nonsense", a 409 says "what you
// asked for is coherent but conflicts with the state of the tree". A cycle, an activity under a
// task and a delete of the project root are all the second kind.
// The status is read from the ERROR, never matched out of its text. work-items.js tags every
// refusal it raises (bad/notFound/refuse) and translates a postgres trigger refusal by its CODE, so
// the wording of a sentence and the status of a response are independent facts.
//
// They were not always: this used to be a regex over the message, which made every refusal sentence
// load-bearing prose — reword one and its HTTP status flipped silently, with no test failing and no
// log line to notice. httpStatusOf() defaults to 400 for anything untagged, exactly as the old
// fallback did.
function workErr(res, err) {
  return res.status(httpStatusOf(err)).json({ error: String(err?.message || err || 'unknown error') });
}
const projectOf = (req) => req.query.project || req.body?.project || req.body?.project_id || null;

// The vocabulary itself — labels, column order, terminal flags and the legal transitions, straight
// from lib/work-status.js. It is an endpoint so the console never hardcodes a column list of its
// own; that duplication is exactly what let hive-status and the web palette drift before.
// REHAB 2/4 — the vocabulary now also carries the MODEL's run-plane → work_status mapping
// (lib/model-status.js, the ONE mapping every reader uses), so a client can learn "a 'waiting'
// execution renders as review" without importing a server module. It is additive: the columns and
// transitions are unchanged.
router.get('/work-statuses', (_req, res) => res.json({
  ...workStatusVocabulary(),
  model_lifecycle: workStatusModelVocabulary(),
}));

// ── tickets ──────────────────────────────────────────────────────────────────
router.get('/tickets', async (req, res) => {
  try {
    res.json(await listTickets({
      projectId: req.query.project || null, status: req.query.status || null,
      kind: req.query.kind || null, q: req.query.q || null,
    }));
  } catch (err) { workErr(res, err); }
});

router.post('/tickets', async (req, res) => {
  try {
    const project = projectOf(req);
    if (!project) return res.status(400).json({ error: 'project required' });
    res.status(201).json(await createTicket({ ...(req.body || {}), project_id: project }));
  } catch (err) { workErr(res, err); }
});

router.get('/tickets/:id', async (req, res) => {
  try {
    const t = await getTicket(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such ticket' });
    res.json(t);
  } catch (err) { workErr(res, err); }
});

router.patch('/tickets/:id', async (req, res) => {
  try {
    const t = await updateTicket(req.params.id, req.body || {}, { actor: req.body?.actor || null });
    if (!t) return res.status(404).json({ error: 'no such ticket' });
    res.json(t);
  } catch (err) { workErr(res, err); }
});

router.delete('/tickets/:id', async (req, res) => {
  try {
    const out = await deleteTicket(req.params.id);
    if (!out) return res.status(404).json({ error: 'no such ticket' });
    res.json(out);
  } catch (err) { workErr(res, err); }
});

router.post('/tickets/:id/comments', async (req, res) => {
  try {
    const c = await addComment(req.params.id, req.body || {});
    if (!c) return res.status(404).json({ error: 'no such ticket' });
    res.status(201).json(c);
  } catch (err) { workErr(res, err); }
});

// WHO could be told about this ticket — the manager zees of its project, resolved LIVE, each with
// whether it has a session a message can be typed into. The picker in the tickets window IS this
// list (same contract as /work-items/:id/candidates: the server decides who is offerable).
router.get('/tickets/:id/managers', async (req, res) => {
  try {
    const out = await ticketManagers(req.params.id);
    if (!out) return res.status(404).json({ error: 'no such ticket' });
    res.json(out);
  } catch (err) { workErr(res, err); }
});

// Tell one of them about it: { xell_id }. Reuses the EXISTING delivery path (managers.postMessage →
// sendMessageToXell, the 📨 button's door) — nothing new reaches into a cxell — and answers with the
// verdict, including when it could not be typed into a live session.
router.post('/tickets/:id/notify', async (req, res) => {
  try {
    const out = await notifyManagerOfTicket(req.params.id, {
      xellId: req.body?.xell_id || req.body?.manager || null,
      by: req.body?.by || 'human@console',
    });
    if (!out) return res.status(404).json({ error: 'no such ticket' });
    res.json(out);
  } catch (err) { workErr(res, err); }
});

// Serving an attachment's BYTES, for both doors (the console's and the external API's). Always as
// a download and never inline: these bytes were uploaded by somebody else's machine, so rendering
// one in this origin (an image/svg+xml is a script) is the one mistake an attachment feature makes.
// nosniff stops a browser second-guessing the declared type; the filename is already sanitised at
// upload (lib/ticket-attachments.js) and is quoted here as well.
function sendAttachment(res, a) {
  res.setHeader('Content-Type', a.content_type);
  res.setHeader('Content-Length', a.size_bytes);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${String(a.filename).replace(/"/g, '')}"`);
  res.setHeader('X-Attachment-Sha256', a.sha256);
  res.send(a.content);
}

// ── ticket attachments, console side (190) ───────────────────────────────────
// The evidence a ticket carries: images and text logs, stored as bytea in the meta-DB. The LIST is
// metadata only (a ticket read must never drag 50 MB of screenshots through a console render); the
// bytes come one at a time from the download route below. The same rows the external API writes —
// this is the human's door onto them.
router.get('/tickets/:id/attachments', async (req, res) => {
  try { res.json(await listAttachments(req.params.id)); }
  catch (err) { workErr(res, err); }
});

router.post('/tickets/:id/attachments', async (req, res) => {
  try {
    const a = await addAttachment(req.params.id, req.body || {},
      { uploadedBy: req.body?.uploaded_by || 'human@console', source: 'console' });
    if (!a) return res.status(404).json({ error: 'no such ticket' });
    res.status(201).json(a);
  } catch (err) { workErr(res, err); }
});

// DOWNLOAD — the raw bytes. Always as an ATTACHMENT and always nosniff: an attachment is content
// somebody else's machine uploaded, so it is never rendered in the console's own origin (an
// image/svg+xml served inline is a script running as the console).
router.get('/tickets/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const a = await getAttachment(req.params.attachmentId, { ticketId: req.params.id });
    if (!a) return res.status(404).json({ error: 'no such attachment' });
    sendAttachment(res, a);
  } catch (err) { workErr(res, err); }
});

router.delete('/tickets/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const out = await deleteAttachment(req.params.attachmentId, { ticketId: req.params.id });
    if (!out) return res.status(404).json({ error: 'no such attachment' });
    res.json(out);
  } catch (err) { workErr(res, err); }
});

// The hinge: a ticket becomes a plan. { items: [{title, kind?, parent_id?|ref-of-an-earlier-item, …}] }
router.post('/tickets/:id/breakdown', async (req, res) => {
  try {
    const out = await breakdownTicket(req.params.id, {
      items: req.body?.items || [], actor: req.body?.actor || null,
    });
    if (!out) return res.status(404).json({ error: 'no such ticket' });
    res.status(201).json(out);
  } catch (err) { workErr(res, err); }
});

// ── THE EXTERNAL TICKETING API: /api/ext/v1 (190) ────────────────────────────
//
// The door a DEPLOYED project comes in through. omnibiz — running on somebody else's server, with
// no xell, no token and no console — holds a per-project key and files, monitors and updates its
// own tickets here, with the images and logs attached. What lands is an ordinary `ticket` row on
// the project's own board, so a zee works on it with the verbs it already has.
//
// Why a SEPARATE path rather than a key on /api/tickets: /api is the console's surface and takes
// a project id from the caller. This one must not — the project comes from the KEY (see
// lib/ticket-intake.js rule 1), and putting the two authentication models on one path is how a
// missing check on one route silently becomes a cross-project read. Everything under /ext/v1 is
// key-authenticated, scoped to that key's project, and refuses a body that names a project at all.
//
// Versioned in the path because this is the ONE surface in this repo whose callers we do not
// deploy: an integrator's code cannot be updated in lockstep, so a breaking change gets /v2 and
// /v1 keeps answering.
const extErr = (res, err) => res.status(httpStatusOf(err)).json({
  ok: false, error: String(err?.message || err || 'unknown error'),
});

// The auth gate. Resolves the key, checks the scope, and hands the handler { key, project }.
// Answers 401 (no/unknown/revoked key) or 403 (a live key without the scope) with a sentence that
// says WHICH — an integrator debugging somebody else's server cannot read our logs.
async function extAuth(req, res, scope) {
  const m = /^Bearer\s+(.+)$/i.exec((req.get('authorization') || '').trim());
  const presented = m ? m[1].trim() : (req.get('x-zeehive-api-key') || '').trim();
  let out;
  try {
    out = await authenticateApiKey(presented, { scope, ip: req.ip || req.socket?.remoteAddress || null });
  } catch (err) {
    // The gate itself failed (the meta-DB is unreachable, say). That is OURS, not the caller's, and
    // it must be a 503 rather than a 401 — an integration told "unknown key" would revoke a
    // perfectly good credential and re-mint it. It must also never become an unhandled rejection.
    res.status(503).json({ ok: false,
      error: `the ticketing API could not check your key right now: ${String(err?.message || err)}. `
        + 'Your key is fine — retry.' });
    return null;
  }
  if (!out.ok) { res.status(out.status || 401).json({ ok: false, error: out.reason }); return null; }
  // A body that names a project is REFUSED rather than ignored: a caller that thinks it is
  // choosing a project is a caller that will one day be surprised, and silence would let it
  // believe the field did something.
  if (req.body && (req.body.project || req.body.project_id)) {
    res.status(400).json({ ok: false,
      error: 'do not send a project — an API key files into its OWN project, and naming one here '
        + `would be ignored. This key files into "${out.project.name}".` });
    return null;
  }
  return out;
}

// WHO AM I — the integrator's first call: which project this key files into, what the API accepts,
// and the attachment limits, generated from the same constants the server validates against.
router.get('/ext/v1/whoami', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:read');
  if (!auth) return;
  res.json(externalMeta(auth));
});

router.post('/ext/v1/tickets', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:write');
  if (!auth) return;
  try {
    const out = await externalCreateTicket(auth, req.body || {});
    // 200 for a DEDUPED repeat, 201 for a ticket that was actually created — the status alone tells
    // a retrying caller which of the two happened, without parsing the body.
    res.status(out.deduped ? 200 : 201).json(out);
  } catch (err) { extErr(res, err); }
});

router.get('/ext/v1/tickets', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:read');
  if (!auth) return;
  try {
    res.json(await externalListTickets(auth, {
      status: req.query.status || null, kind: req.query.kind || null,
      q: req.query.q || null, external_ref: req.query.external_ref || null,
    }));
  } catch (err) { extErr(res, err); }
});

// MONITOR one — status, the conversation, the evidence, and what the fleet is doing about it.
// :ref is an id, a code (TKT-52-2518), a ref (#52) or a bare number, resolved INSIDE this key's
// project (numbers are per project, so an unscoped number would name two tickets).
router.get('/ext/v1/tickets/:ref', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:read');
  if (!auth) return;
  try { res.json(await externalGetTicket(auth, req.params.ref)); }
  catch (err) { extErr(res, err); }
});

router.patch('/ext/v1/tickets/:ref', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:write');
  if (!auth) return;
  try { res.json(await externalUpdateTicket(auth, req.params.ref, req.body || {})); }
  catch (err) { extErr(res, err); }
});

router.post('/ext/v1/tickets/:ref/comments', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:write');
  if (!auth) return;
  try { res.status(201).json(await externalComment(auth, req.params.ref, req.body || {})); }
  catch (err) { extErr(res, err); }
});

router.get('/ext/v1/tickets/:ref/attachments', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:read');
  if (!auth) return;
  try { res.json(await externalAttachments(auth, req.params.ref)); }
  catch (err) { extErr(res, err); }
});

router.post('/ext/v1/tickets/:ref/attachments', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:write');
  if (!auth) return;
  try { res.status(201).json(await externalAttach(auth, req.params.ref, req.body || {})); }
  catch (err) { extErr(res, err); }
});

// Download evidence back out — the same bytes, byte for byte, with the sha256 the upload answered
// with. A caller's OWN attachment id, scoped to a ticket in its OWN project: an attachment that
// belongs to another project's ticket is a 404 here, never a read.
router.get('/ext/v1/tickets/:ref/attachments/:attachmentId', async (req, res) => {
  const auth = await extAuth(req, res, 'tickets:read');
  if (!auth) return;
  try {
    const t = await externalGetTicket(auth, req.params.ref);           // 404s outside the project
    const a = await getAttachment(req.params.attachmentId, { ticketId: t.id });
    if (!a) return res.status(404).json({ ok: false, error: 'no such attachment on that ticket' });
    sendAttachment(res, a);
  } catch (err) { extErr(res, err); }
});

// The attachment limits, without a key — the one thing an integrator needs BEFORE it has one, so a
// build script can check a file size without holding a credential. No project, no ticket, no data.
router.get('/ext/v1/limits', (_req, res) => res.json({ ok: true, attachments: attachmentLimits() }));

// ── reflections (the ledger) ─────────────────────────────────────────────────
//
// Every post-ship reflection this project's zees have written, newest first — the project-wide read
// the per-xell /xells/:id/messages view could never give, because a reflection addressed to a
// retired manager is in nobody's window at all. Human-facing audit, exactly like that one: READING
// MARKS NOTHING READ. `read_at` is the agent's own `zee inbox` receipt and this must not clear it.
router.get('/reflections', async (req, res) => {
  try {
    if (!req.query.project) return res.status(400).json({ error: 'project required' });
    res.json(await listReflections({
      projectId: req.query.project, limit: req.query.limit || undefined, since: req.query.since || null,
    }));
  } catch (err) { workErr(res, err); }
});

// FILE ONE AS A TICKET — through createTicket, the same path every other ticket takes, and the row
// then carries the ticket so the same finding is not filed twice (409 when it already is).
router.post('/reflections/:id/ticket', async (req, res) => {
  try {
    const out = await fileReflectionAsTicket(req.params.id, {
      kind: req.body?.kind || undefined,
      priority: req.body?.priority ?? null,
      by: req.body?.by || 'human@console',
    });
    if (!out) return res.status(404).json({ error: 'no such reflection' });
    res.status(201).json(out);
  } catch (err) { workErr(res, err); }
});

// ── work items ───────────────────────────────────────────────────────────────
router.get('/work-items', async (req, res) => {
  try {
    res.json(await listWorkItems({
      projectId: req.query.project || null, status: req.query.status || null,
      kind: req.query.kind || null, ticketId: req.query.ticket || null,
      rootId: req.query.root || null, tree: req.query.tree === '1' || req.query.tree === 'true',
    }));
  } catch (err) { workErr(res, err); }
});

router.post('/work-items', async (req, res) => {
  try {
    const body = req.body || {};
    res.status(201).json(await createWorkItem({ ...body, project_id: projectOf(req) || body.project_id }));
  } catch (err) { workErr(res, err); }
});

router.get('/work-items/:id', async (req, res) => {
  try {
    const item = await getWorkItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'no such work item' });
    res.json(item);
  } catch (err) { workErr(res, err); }
});

// A PATCH carrying parent_id is a MOVE (it rewrites the path of every descendant); a PATCH carrying
// status is a transition validated against work-status.js. Both are the same call for the caller.
router.patch('/work-items/:id', async (req, res) => {
  try {
    const item = await updateWorkItem(req.params.id, req.body || {}, { actor: req.body?.actor || null });
    if (!item) return res.status(404).json({ error: 'no such work item' });
    res.json(item);
  } catch (err) { workErr(res, err); }
});

router.delete('/work-items/:id', async (req, res) => {
  try {
    const out = await deleteWorkItem(req.params.id);
    if (!out) return res.status(404).json({ error: 'no such work item' });
    res.json(out);
  } catch (err) { workErr(res, err); }
});

router.post('/work-items/:id/deps', async (req, res) => {
  try {
    // assertId FIRST: a malformed id must read as 400 "not a valid work item id", and only a
    // well-formed id that names nothing is a 404. Without the check the existence probe below
    // hands postgres a bad uuid and the caller gets a cast error instead of either answer.
    assertId(req.params.id);
    // REHAB 2/4 — the existence probe is now the MODEL's: a work item exists when its work_node
    // does (stable_key = 'work_item:<id>'). The dual-write keeps the two in step.
    const item = await one(`SELECT id FROM work_node WHERE stable_key = 'work_item:' || $1::text`, [req.params.id]);
    if (!item) return res.status(404).json({ error: 'no such work item' });
    res.status(201).json(await addDep(req.params.id, req.body?.depends_on_id, { actor: req.body?.actor || null }));
  } catch (err) { workErr(res, err); }
});

router.delete('/work-items/:id/deps/:depId', async (req, res) => {
  try {
    const out = await removeDep(req.params.id, req.params.depId);
    if (!out) return res.status(404).json({ error: 'no such dependency' });
    res.json(out);
  } catch (err) { workErr(res, err); }
});

// ── the two views ────────────────────────────────────────────────────────────
router.get('/board', async (req, res) => {
  try {
    if (!req.query.project && !req.query.root) return res.status(400).json({ error: 'project or root required' });
    res.json(await boardModel({ projectId: req.query.project || null, rootId: req.query.root || null }));
  } catch (err) { workErr(res, err); }
});

router.get('/gantt', async (req, res) => {
  try {
    if (!req.query.project && !req.query.root) return res.status(400).json({ error: 'project or root required' });
    res.json(await ganttModel({ projectId: req.query.project || null, rootId: req.query.root || null }));
  } catch (err) { workErr(res, err); }
});

// STAGE 6 — THE WORKFLOW GANTT read model (lib/workflow-gantt.js): the hierarchical
// workflow model's plan/work_node/execution/lease plane re-pointed as the timeline.
// PLANNED from the CPM pass, ACTUAL from execution.started_at/finished_at, WAITING from
// held leases on waiting executions; deps are the leaf-level union_edge; each row carries
// its execution → turn → gateway waterfall for the drill-down. READ-ONLY — the CPM is the
// deterministic pass, and every execution/lease/turn row is a byproduct of a door.
router.get('/workflow/gantt', async (req, res) => {
  try {
    if (!req.query.project && !req.query.root) return res.status(400).json({ error: 'project or root required' });
    const { workflowGanttModel } = await import('../lib/workflow-gantt.js');
    res.json(await workflowGanttModel({ projectId: req.query.project || null, rootId: req.query.root || null }));
  } catch (err) { workErr(res, err); }
});


// ── WORK TRACKER: assignment + deployment ─────────────────────────────────────
// The verbs that turn a plan item into a running agent (lib/work-assign.js). Everything here is a
// HUMAN/console surface — the cxell entrances to the same verbs are the /xell/self/work* routes
// below, which resolve the caller from its own token instead of trusting a parameter.
//
// The error contract is the SAME one stated at the top of this section, and it is answered by the
// same workErr() — with one addition: work-assign.js tags its own refusals with an explicit
// `err.status` (400 you asked wrong · 404 it does not exist · 409 it exists and the answer is still
// no), because a refusal like "that xell is a manager zee" is a 409 no regex should have to guess at.
// Anything thrown out of work-items.js still falls through to workErr's sentence-matching.
const assignErr = (res, err) => (err && err.status
  ? res.status(err.status).json({ error: err.message })
  : workErr(res, err));

// Link an EXISTING xell to this item. Refused across projects, onto production, onto a manager zee,
// or onto a xell already carrying another open item.
router.post('/work-items/:id/assign', async (req, res) => {
  try {
    res.json(await assignWorkItem(req.params.id, {
      xell_id: req.body?.xell_id, actor: req.body?.actor || 'human@console' }));
  } catch (err) { assignErr(res, err); }
});
// Take the zee off it. The STATUS is deliberately left alone — work that happened, happened.
router.delete('/work-items/:id/assign', async (req, res) => {
  try {
    res.json(await unassignWorkItem(req.params.id, { actor: req.body?.actor || 'human@console' }));
  } catch (err) { assignErr(res, err); }
});
// DISPATCH a fresh worker for this item and assign it. The brief is built from the item (title, body,
// ancestor chain, linked ticket, dates) plus the caller's extra `task` text; the spawn itself goes
// through the existing dispatch path, never a second one.
router.post('/work-items/:id/deploy', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await deployWorkItem(req.params.id, {
      task: b.task || null, model: b.model || null, mode: b.mode || null, harness: b.harness || null,
      title: b.title || null, actor: b.actor || 'human@console',
      managerXellId: b.manager_xell_id || null }));
  } catch (err) { assignErr(res, err); }
});
// IS SOMEBODY ALREADY IN THIS WORK? — the board's DEPLOY preflight (the work-item mirror of
// /xell/dispatch/overlap). Read-only, no side effects, and it exists so a human sees the answer
// BEFORE they press "deploy a worker" rather than in the receipt afterwards. It builds the same
// brief the deploy would and keys it on the item itself (the landed-warning half reads the tracker
// link), and a failure inside it answers "no warnings" rather than an error — because a
// coordination hint must never stand between a human and a dispatch.
router.post('/work-items/:id/deploy/overlap', async (req, res) => {
  try {
    res.json(await getWorkItemOverlap(req.params.id, { task: req.body?.task || null }));
  } catch (err) {
    res.json({ warnings: [], note: null, checked: { xells: 0, paths: [], tickets: [], landings: 0 },
              degraded: [`overlap check unavailable: ${err.message}`] });
  }
});
// Which xells could take this item — so the console offers a picker instead of asking a human to
// paste a uuid (the ready pool + live workers with no open item, in this project only).
router.get('/work-items/:id/candidates', async (req, res) => {
  try { res.json(await candidatesFor(req.params.id)); }
  catch (err) { assignErr(res, err); }
});

// ── CURRENT CONDITIONS (`zee conditions`) — the short, dated, per-PROJECT list of live
// impediments injected into every briefing (ticket #67). READ is every zee's; WRITE (--add /
// --remove) is MANAGER-only, scoped to the caller's own project by its token — the same wall as
// `zee work --new`. A worker that tries to write is told what it is, not 404'd.
router.get('/xell/self/conditions', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfConditions(x, {})); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/xell/self/conditions', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    const r = await selfConditions(x, { action: b.action || null, body: b.body || null, id: b.id || null });
    if (r.ok === false && r.status === 'refused') return res.status(403).json(r);
    if (r.ok === false) return res.status(400).json(r);
    res.json(r); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
// ── STANDING ORDERS (`zee standing-orders`) — the manager's crew discipline, appended VERBATIM to
// every brief it dispatches (ticket #74). READ and WRITE are MANAGER-only (a worker RECEIVES them
// appended to its brief; it never sets them) — the same `requireManager` wall as `zee conditions`.
router.get('/xell/self/standing-orders', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfStandingOrders(x, { action: 'read' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/xell/self/standing-orders', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    const r = await selfStandingOrders(x, { action: b.action || null, text: b.text || null });
    if (r.ok === false && r.status === 'refused') return res.status(403).json(r);
    if (r.ok === false) return res.status(400).json(r);
    res.json(r); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
// ── WORK TRACKER: the cxell verbs (`zee work` · `zee assign` · `zee item`) ────
// Token-scoped, exactly like every other /xell/self/ verb: a MANAGER sees and moves its own project's
// plan, a WORKER sees and reports on the ONE item it is assigned to. The scope is resolved in the
// SERVER from the caller's token — never from a parameter the caller supplies.
router.get('/xell/self/work', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    res.json(await selfWork(x, { board: req.query.board === '1', item: req.query.item || null })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
// MANAGER only: CUT the plan — one item (`zee work --new`), a whole tree from a ticket
// (`zee breakdown`), or free a card from the xell on it (`zee unassign`). Plan rows only: none of
// these dispatches, lands, ships or touches a gate, and the project is the TOKEN's, never the body's.
router.post('/xell/self/work/new', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    res.json(await selfWorkNew(x, { title: b.title || null, body: b.body || null, kind: b.kind || null,
      parent: b.parent || null, after: b.after || null, ticket: b.ticket || null,
      priority: b.priority ?? null, status: b.status || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xell/self/work/breakdown', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    res.json(await selfWorkBreakdown(x, { ticket: b.ticket || null, items: b.items || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/xell/self/work/unassign', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    res.json(await selfWorkUnassign(x, { item: b.item || null, reason: b.reason || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// MANAGER only: CHAIN two cards — `item` waits for `on` (a dependency edge in the model).
// The console drawer has the same picker; this is the CLI half of "capture chains going
// forward" (nesting says part-of, a chain says after — the gantt's critical path runs along
// chains). --remove deletes the edge.
router.post('/xell/self/work/dep', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    res.json(await selfWorkDep(x, { item: b.item || null, on: b.on || null,
      remove: !!b.remove })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// MANAGER only: deploy a worker for one of MY project's work items (same dispatch path as `zee dispatch`).
router.post('/xell/self/work/assign', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    res.json(await selfWorkAssign(x, { item: b.item || null, task: b.task || null, model: b.model || null,
      mode: b.mode || null, harness: b.harness || null, title: b.title || null,
      visual_verify: b.visual_verify || false,
      provider: b.provider || null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Report an item's status/progress. A manager may report any item in its own project; a worker only
// its OWN. Setting `done` reports the WORK finished — it never touches the xell's done/land/ship.
router.post('/xell/self/work/item', async (req, res) => {
  try { const x = await resolveSelf(req, res); if (!x) return;
    const b = req.body || {};
    res.json(await selfWorkItem(x, { id: b.id || null, status: b.status || null,
      progress: b.progress ?? null, note: b.note || null,
      estimate_hours: b.estimate_hours ?? null, starts_on: b.starts_on ?? null,
      due_on: b.due_on ?? null })); }
  catch (err) { res.status(400).json({ error: err.message }); }
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
    `SELECT backup_dir, backup_ctx, backup_interval_sec, max_backups, backup_tables, backup_plugins, backup_paused FROM pool_config WHERE project_id=$1`, [proj]);
  // tables = this dump's scoped selection (null = full db). toc_summary->tables = every table the
  // archive contains, so the restore picker offers exactly what can be restored out of THIS backup.
  const rows = await q(
    `SELECT id, dump_path, dest_ctx, size_bytes, taken_at, source, status, error, mode, tables,
            row_total, row_counts,
            toc_summary->'tables' AS toc_tables
       FROM db_snapshot
       WHERE project_id=$1 AND source='prod' ORDER BY taken_at DESC`, [proj]);
  // THE TREND, computed here rather than in the browser: each FULL backup against the next older one
  // that carries counts. A table that SHRANK between two dumps is the reading that actually speaks to
  // "is my data fully backed up" (TKT-22-4F0E), and it is the one thing no surface could show before.
  // row_counts itself is NOT sent — 600+ tables × 14 backups is a payload nobody reads; the verdict,
  // the totals and the worst few are (compareBackupCounts caps that list).
  const fullWithCounts = rows.filter((b) => b.status === 'finished' && !b.tables && b.row_counts);
  const backups = rows.map((b) => {
    const { row_counts, ...rest } = b;
    if (!row_counts || b.tables) return rest;
    const older = fullWithCounts.find((o) => new Date(o.taken_at) < new Date(b.taken_at) && o.row_counts);
    const trend = compareBackupCounts(older?.row_counts ?? null, row_counts);
    return { ...rest, row_tables: Object.keys(row_counts).length,
             row_trend: trend ? { verdict: trend.verdict, counts: trend.counts, worst: trend.worst,
                                  total_prev: trend.total_prev, total_now: trend.total_now,
                                  compared_to: older?.taken_at ?? null } : null };
  });
  // db containers a backup may be restored INTO. Non-prod targets plus the SHARED prod db, flagged
  // is_prod so the modal marks it and demands typed confirmation. Ordered so prod sorts LAST — the
  // modal preselects targets[0], and prod must never be the default restore target. busy_since/
  // busy_op tell the modal which target is mid-restore.
  const targets = await q(
    `SELECT id, name, tier, busy_since, busy_op, (tier='prod') AS is_prod FROM container
       WHERE project_id=$1 AND role='db' AND (tier <> 'prod' OR isolation='shared')
       ORDER BY (tier='prod'), tier, name`, [proj]);
  res.json({ config: cfg, backups, targets });
});
router.post('/backups/config', async (req, res) => {
  try { res.json(await setBackupConfig(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// Pause/resume this project's backups — the stop-switch for a retry storm (a failed backup that
// keeps re-doing itself). While paused, the scheduler starts no new backup and a manual
// "Back up now" is refused; an in-flight one is not interrupted (Cancel does that).
router.post('/backups/pause', async (req, res) => {
  try { res.json(await setBackupPaused(req.body || {})); }
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
// delete ONE backup (file + row); refuses a still-running backup.
router.delete('/backups/:id', async (req, res) => {
  try { res.json(await deleteBackup(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// cancel a RUNNING backup: the in-flight dump is killed, the partial file removed, the container
// un-busied, and the row finalised 'cancelled'. Returns immediately; the job finishes the cleanup.
router.post('/backups/:id/cancel', async (req, res) => {
  try { res.json(await cancelBackup(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
// restore a backup INTO a db container (spins that container until done). confirm_prod gates a
// restore over the PRODUCTION database — the human typed the prod db name to set it.
router.post('/backups/:id/restore', async (req, res) => {
  try {
    res.json(await restoreBackup({
      snapshot: req.params.id, container: req.body?.container, confirmProd: !!req.body?.confirm_prod,
      tables: req.body?.tables ?? null,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
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

  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
  // Project-scope + cap the queenzee-activity fan-out per connection (activityFanout); every
  // other event type rides through unchanged.
  const { onEvent, close } = activityFanout(req.query.project || null, send);
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); close(); });
});

// ── XELL WEBAPP REVIEW — /xell-web/<slug>/* (compatibility redirect) ──────────────────────────
// Xell webapps are reached DIRECTLY on their own port now (docs/visual-verification-diagnosis.md
// §7): http://<console-hostname>:<host_port>/. This route survives only so old links — open
// visual-verify offers, bookmarks, the console nginx /xell-web block — 302 onto the direct port,
// path preserved. New URLs are minted as direct ports and never come here.
router.use('/xell-web/:slug', webappRedirect);

// ── A2A READ + WRITE SIDE (P2 + P3 + P4) — docs/a2a-protocol-plan.md §3, DR-2/DR-5/DR-6 ──
// The fleet speaks A2A v1.0 at ONE place — this router, mounted at the ORIGIN ROOT in index.js
// (NOT under /api), because the well-known card is RFC 8615 origin-root and the /a2a/v1 paths are
// the wire contract. P2 read + P3 write authenticate the INTERNAL caller from its xell token
// exactly like /api/xell/self/* (resolveSelf), and crew scoping is unchanged — a worker may
// address its manager, a manager its crew. P4 (external interop) adds the EXTERNAL caller: a
// project API key (`Bearer zhk_…`, or X-Zeehive-Api-Key for parity) with the `a2a` scope, which
// may see and address only the agents its project owns (plan §3.4, DR-6).
//
// The read/write-model half (task projection, cards, SendMessage/CancelTask) lives in
// lib/a2a-read.js; the pure shapes live in lib/a2a.js. This router is the HTTP surface only:
// auth, the A2A-Version gate, and the SSE transport for SubscribeToTask / SendStreamingMessage.
export const a2aRouter = Router();

function a2aBase(req) {
  // The base a card points at is wherever the caller reached us — a card must be usable by the
  // client that asked for it, not baked to a host the caller may not be able to see.
  return `${req.protocol}://${req.get('host')}`;
}

// The A2A auth gate — TWO credentials, exactly the two that already exist (DR-6, "A2A grants no
// new reach"). An INTERNAL caller (a zee through its verbs) presents the xell token and resolves
// like /api/xell/self/*; an EXTERNAL caller (a deployed project's server) presents a project API
// key with the `a2a` scope. A body naming a project is REFUSED rather than ignored — the project
// comes from the KEY, the same construction as the ticketing API's extAuth above, and silence
// would let a caller believe the field did something.
async function resolveA2ACaller(req, res) {
  const m = /^Bearer\s+(.+)$/i.exec((req.get('authorization') || '').trim());
  const bearer = m ? m[1].trim() : '';
  const keyHeader = (req.get('x-zeehive-api-key') || '').trim();
  if (bearer.startsWith('zhk_') || keyHeader) {
    const presented = bearer.startsWith('zhk_') ? bearer : keyHeader;
    let out;
    try {
      out = await authenticateApiKey(presented, { scope: 'a2a', ip: req.ip || req.socket?.remoteAddress || null });
    } catch (err) {
      // The gate itself failed (the meta-DB is unreachable, say). That is OURS, not the caller's,
      // and it must be a 503 rather than a 401 — an integration told "unknown key" would revoke a
      // perfectly good credential and re-mint it.
      res.status(503).json({ ok: false,
        error: `the A2A API could not check your key right now: ${String(err?.message || err)}. Your key is fine — retry.` });
      return null;
    }
    if (!out.ok) { res.status(out.status || 401).json({ ok: false, error: out.reason }); return null; }
    if (req.body && (req.body.project || req.body.project_id)) {
      res.status(400).json({ ok: false,
        error: 'do not send a project — an A2A key acts for its OWN project, and naming one here '
          + `would be ignored. This key acts for "${out.project.name}".` });
      return null;
    }
    return externalCaller(out);
  }
  // Internal xell token — resolveSelf writes its own 401/409 for a missing/unknown/retired token.
  return resolveSelf(req, res);
}

function rpcResult(res, id, result) {
  return res.json({ jsonrpc: '2.0', id: id ?? null, result });
}

// ── the fleet card — RFC 8615 origin root; ANONYMOUS (the A2A entry point) ──
// DR-6: "even the directory requires a credential", but the fleet card is the discovery door — a
// client has to be able to find that A2A is spoken at all before it can authenticate. It describes
// the service and points at the directory; it enumerates no agents.
a2aRouter.get('/.well-known/agent-card.json', async (req, res) => {
  try { res.json(buildFleetCard({ base: a2aBase(req) })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── the directory — live agents the caller's credential may see, each with its card URL ──
a2aRouter.get('/a2a/v1/agents', async (req, res) => {
  try {
    const caller = await resolveA2ACaller(req, res); if (!caller) return;
    res.json(await directoryFor(caller, a2aBase(req)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── the per-agent card — GENERATED per request from live rows (house rule 7) ──
// 404 for a slug the caller may not see or that names no live xell — never confirm existence.
a2aRouter.get('/a2a/v1/agents/:slug/card', async (req, res) => {
  try {
    const caller = await resolveA2ACaller(req, res); if (!caller) return;
    const visible = await cardVisibleXellIds(caller);
    const agent = await one(`SELECT * FROM xell WHERE slug=$1 AND status <> 'retired'`, [req.params.slug]);
    if (!agent || !visible.has(agent.id)) { res.status(404).json({ error: `no agent card for "${req.params.slug}"` }); return; }
    const card = await agentCardFor(agent, a2aBase(req));
    if (!card) { res.status(404).json({ error: `no agent card for "${req.params.slug}"` }); return; }
    res.json(card);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── the JSON-RPC endpoint — POST /a2a/v1/agents/:slug ──
// Content-Type: application/json (415 otherwise); A2A-Version: 1.0 (VersionNotSupportedError
// -32009 for wrong/missing — checked BEFORE method dispatch, per DR-5 "implemented from day one").
a2aRouter.post('/a2a/v1/agents/:slug', async (req, res) => {
  try {
    const caller = await resolveA2ACaller(req, res); if (!caller) return;
    // The :slug is the agent being ADDRESSED; the caller must be able to read its card. Task data
    // is scoped separately by the caller's own conversation visibility (taskVisibleXellIds).
    const cardVisible = await cardVisibleXellIds(caller);
    const agent = await one(`SELECT * FROM xell WHERE slug=$1 AND status <> 'retired'`, [req.params.slug]);
    if (!agent || !cardVisible.has(agent.id)) { res.status(404).json({ error: `no agent "${req.params.slug}"` }); return; }

    if (!/^application\/json\b/i.test(req.get('content-type') || '')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    const versionError = a2aVersionError(req.get('a2a-version'));
    if (versionError) {
      return res.json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: versionError });
    }
    const body = req.body || {};
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return res.json({ jsonrpc: '2.0', id: body.id ?? null,
        error: { code: -32600, message: 'InvalidRequest', data: { message: 'request must be JSON-RPC 2.0 with a method' } } });
    }

    const taskVisible = await taskVisibleXellIds(caller);
    const result = await dispatchA2A(caller, body.method, body.params || {}, { visible: taskVisible, agent });

    // SubscribeToTask and SendStreamingMessage swap the JSON result for an SSE stream (plan §3.2):
    // first event is the Task, then task_status_update events on the existing zee-message broadcast
    // bus. For SubscribeToTask the Task is the read snapshot; for SendStreamingMessage the send has
    // already happened and the first Task is the state right after the send.
    if (body.method === 'SubscribeToTask' || body.method === 'SendStreamingMessage') {
      let taskId = body.params.taskId;
      let task = result.task || null;
      if (body.method === 'SendStreamingMessage') {
        taskId = result.message?.taskId;
        task = taskId ? await loadTask(taskId, taskVisible).catch(() => null) : null;
      }
      if (!task) { return res.status(500).json({ error: 'no task for the requested stream' }); }
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`event: task\ndata: ${JSON.stringify(task)}\n\n`);
      let closed = false;
      const onEvent = (e) => {
        if (closed || e.type !== 'zee-message') return;
        void (async () => {
          try {
            const row = await one(`SELECT * FROM zee_message WHERE id=$1`, [e.payload?.id]).catch(() => null);
            const a2a = row?.meta?.a2a;
            if (!a2a || (a2a.taskId !== taskId && a2a.referencedTaskId !== taskId)) return;
            const fresh = await loadTask(taskId, taskVisible).catch(() => null);
            if (!fresh || closed) return;
            res.write(`event: task_status_update\ndata: ${JSON.stringify({
              taskId, status: fresh.status, timestamp: new Date().toISOString(), task: fresh })}\n\n`);
          } catch { /* client gone / db blip — drop the event */ }
        })();
      };
      bus.on('event', onEvent);
      const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 20000);
      req.on('close', () => { closed = true; clearInterval(ping); bus.off('event', onEvent); });
      return;
    }

    return rpcResult(res, body.id, result);
  } catch (err) {
    if (err instanceof A2AError) return res.json(err.toJSONRPC(req.body?.id ?? null));
    res.status(500).json({ error: err.message });
  }
});
