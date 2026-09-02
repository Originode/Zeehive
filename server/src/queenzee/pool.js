// Pool maintainer / reconciler — keeps the pool of pristine pooled xells: each sitting on the
// source tip (diff 0,0), claimable immediately. Pure script, no AI. Each tick, per project:
//   1. reconcile every pooled xell to the source — clean fast-forward (catch up), else
//      decommission it (dirty / diverged / too far behind / ff impossible).
//   2. INVARIANT: a xell is 'ready' only when its diff to source is (0 ahead, 0 behind).
//   3. fill  — provision fresh xells (which start at the source tip) up to target.
//   4. trim  — decommission the surplus (oldest first).
//
// TARGETS: machine-aware when machine rows exist (023) — each dev machine keeps
// `machine.pool_size` ready xells PER PROJECT, and `max_xells` caps the machine's total live
// dev xells across EVERY project (the host only has so much muscle). Filled in dev_priority
// order so the preferred machine warms first. With no machines, the legacy project-wide
// `pool_config.target_ready` applies unchanged on the one dev site.
//
// The FULL machine-aware path (per-machine placement) requires a placeable per-xell app tier:
// the server role must NOT be `runner: process`. Machine mode counts ready xells through their
// owned server container (JOIN on role='server' + docker_ctx), and a process server is stamped
// with docker_ctx=NULL (provision.js), so that count is zero by construction and fill would
// pile up pool_size per tick. That used to be gated on `project.compose_spinoff` — the wrong
// predicate. Compose projects stamp docker_ctx even when compose_spinoff is unset (the compose
// file is a build detail; build-container.sh defaults to docker-compose.spinoff.yml), so the
// old guard left mardale-prod's per-machine pool sizes as a dead letter on every compose
// project that had not refreshed tiers.spinoff.compose into the column. The guard is the
// process-runner check (serverRoleIsProcess) — but it no longer deadens EVERY per-machine
// knob: a process xell lives on the queenzee host by construction, so the QUEENZEE-HOST
// machine's pool_size is honored (counted project-wide, runaway-proof) and only REMOTE rows
// are skipped — recorded once per state change, informational (the matrix dims those knobs;
// tests: test/pool-machine-guard-silence.test.mjs, test/pool-process-local-machine.test.mjs;
// docs/process-machine-pooling-decision-record.md + pooling-dead-config-demotion record).
import { config } from '../config.js';
import { q, one } from '../db/pool.js';
import { provisionXell } from '../lib/provision.js';
import { poolMachines, implicitPoolMachine, liveXellCount, machinePoolSize, queenzeeHostCtx } from '../lib/machines.js';
import { reapXell } from './reaper.js';
import { reconcileXell } from './landing.js';
import { takeReadyXellForSweep, untakeSweptXell, explainSweepSkip, currentXells } from '../lib/xell-claim.js';
import { quarantineFromBlindAudit } from '../lib/xell-quarantine.js';
import { logline } from '../lib/logbus.js';
import { spawnPrepFor, bakesImage } from '../lib/spawn-prep.js';
import { ensurePreppedImage } from '../lib/cxell.js';
import { deviceConfig } from '../lib/devices.js';
import { serverRoleIsProcess } from '../lib/manifest.js';
// PROVISION PROOF — the burn-in queue (plan §4.4). The pool owns "work on the pool's clock" (the
// image-bake precedent), so it owns the proof queue too: enqueue after each real provision,
// backfill the unproven ready xells, one proof per machine at a time, and persist the machine×
// project verdict into build_readiness_record so one recorded fact serves all N xells on a pair.
import { proveXell, buildReadinessRecordFromProof } from '../lib/xell-proof.js';
import { upsertBuildReadinessRecord, buildReadinessForProject } from '../lib/build-readiness.js';
import { routeProofFailure, raiseInfraCard } from '../lib/proof-routing.js';
import { projectReadinessProof } from '../lib/proof-policy.js';

const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// ── THE PROOF QUEUE (plan §4.4) ────────────────────────────────────────────────
// A FIFO of xell ids waiting to be burned in, plus a per-machine single-flight set. Builds take
// MINUTES and are daemon-heavy, so ONE proof per machine at a time — the same single-flight
// discipline as the revive loop, and never two proofs on one xell (the FIFO is deduped by id).
const proofQueue = [];
const proofBusy = new Set();               // machine keys currently running a proof
const MACHINE_READINESS_RERECORD_MS = 60 * 60 * 1000;   // hourly (plan §4.4)
let lastMachineReadinessReRecord = 0;

// Enqueue a proof after each real provision — fire-and-forget like warmWorktree: a provision that
// failed because a proof was slow would be a worse bug than the one this fixes. The backfill scan
// in maybeRunProofs picks it up the same tick (a fresh xell is ready + unproven the moment
// provisionXell returns), so this is belt-and-braces on top of the scan.
export function enqueueProof(xellId) {
  if (!xellId || proofQueue.includes(xellId)) return;
  proofQueue.push(xellId);
}

// The machine key a proof for this xell runs on: the server container's docker_ctx, or the
// queenzee-host ctx for a process-runner xell (its worktree/processes/cage all live there).
async function proofMachineKey(xellId) {
  const row = await one(
    `SELECT c.docker_ctx, x.project_id FROM container c JOIN xell x ON x.id = c.owner_xell_id
      WHERE c.owner_xell_id=$1 AND c.role='server'`, [xellId]).catch(() => null);
  return { key: row?.docker_ctx || queenzeeHostCtx(), projectId: row?.project_id || null };
}

// The machine row for a proof's key — the docker_ctx that hosts the xell's app tier.
async function machineForProof(key) {
  if (!key) return null;
  return one(`SELECT id FROM machine WHERE docker_ctx=$1 OR key=$1`, [key]).catch(() => null);
}

// ── PROOF-FAILED TEARDOWN BUDGET (§4.3/§4.6) ───────────────────────────────────────────────
// Never more than N proof-failed decommissions per (machine, project) per hour — a persistent
// fault must FLIP the record and STOP the fill (§4.6), not churn provision→fail→reap forever. In
// memory: the pool is a single process, and a restart resetting the budget is an hour of calm the
// fleet could use. Past the cap a pair goes on COOLDOWN for the rest of the hour: no more
// decommissions AND no more provisioning (fillTrim consults the cooldown), so the CODE-under-
// required case holds the gate (the pool neither reaps nor re-provisions a main that cannot
// build) instead of either churning or piling unclaimable xells up to max_xells.
const proofFailDecomms = new Map();           // `${machineKey}:${projectId}` → [timestamps of teardowns]
const proofFailCooldownUntil = new Map();     // `${machineKey}:${projectId}` → ms epoch when the pair may fill again
const PROOF_FAIL_DECOMM_CAP_PER_HOUR = Number(process.env.PROOF_FAIL_DECOMM_CAP_PER_HOUR) || 3;

export function proofFailPairKey(machineKey, projectId) { return `${machineKey}:${projectId}`; }

// The teardowns recorded for a pair in the last hour — pure over the map, exported for tests.
export function proofFailDecommsInHour(pairKey, now = Date.now()) {
  return (proofFailDecomms.get(pairKey) || []).filter((t) => now - t < 3600000);
}

// The pair's fill cooldown, if any (ms epoch until it lifts) — exported so fillTrim and tests
// consult the same fact.
export function proofFailCooldownFor(pairKey) {
  const until = proofFailCooldownUntil.get(pairKey) || 0;
  return until > Date.now() ? until : 0;
}

// Reset the budget — the pool's test seam (a fresh test wants a clean budget; a restart is the
// production equivalent).
export function resetProofFailBudget() {
  proofFailDecomms.clear();
  proofFailCooldownUntil.clear();
}

// ── PROVISION-TIME FAULT CARDING (§4.6 — the half the proof never sees) ──────────────────
// A proof burns in a xell that ALREADY exists; a provision failure never gets that far — the xell
// cannot be CREATED (an exhausted address pool, a daemon that accepts but cannot start containers,
// a compose up that dies, a missing shared dev db on the machine). fillTrim catches the throw,
// breaks, and retries next tick — which, for a fault that never clears, is a SILENT HALT: no
// record, no matrix badge, no card, no dispatch seam. So each failed tick is counted per
// (machine, project); past PROVISION_FAIL_THRESHOLD consecutive failures the pair is recorded
// 'missing' — the SAME record the proof path writes (the matrix badge flips, fillStopReasonFor
// stops the fill, one fact, N readers) — and the PROVISION-INFRA card is raised through
// proof-routing's dedup seam (one card per machine per fault episode). Recovery matches a
// proof-time 'missing': the hourly re-record probe (or a human's recheck click) rewrites the
// record when the fault actually clears.
const provisionFailCount = new Map();       // `${machineKey||'?'}:${projectId}` → consecutive failed ticks
const PROVISION_FAIL_THRESHOLD = Number(process.env.PROVISION_FAIL_THRESHOLD) || 3;
export function provisionFailurePairKey(machineKey, projectId) { return `${machineKey || '?'}:${projectId}`; }
export function resetProvisionFailCount() { provisionFailCount.clear(); }

// Decommission ONE proof-failed POOLED xell, capped per (machine, project) per hour (§4.3, under
// 'required' — a proof-failed xell is not stock, so the fill provisions a replacement). The cap is
// counted on an ACTUAL reap (a sweep the CAS skipped — the xell was claimed, or is no longer ready —
// consumed no slot and earns none). Past the cap the pair goes on cooldown (fillTrim stops
// provisioning it), and the caller says so once. Returns the outcome for the pool line.
export async function maybeDecommissionProofFailed(xell, machineKey, projectId, error,
                                                   { decom = sweepDecommission } = {}) {
  const pairKey = proofFailPairKey(machineKey, projectId);
  const now = Date.now();
  if (proofFailDecommsInHour(pairKey, now).length >= PROOF_FAIL_DECOMM_CAP_PER_HOUR) {
    proofFailCooldownUntil.set(pairKey, now + 3600000);
    return { decommissioned: false, cooledDown: true,
             reason: `teardown cap (${PROOF_FAIL_DECOMM_CAP_PER_HOUR}/h) reached for `
               + `(${machineKey}, project ${String(projectId).slice(0, 8)}) — pair on cooldown for an hour` };
  }
  const reason = `proof-failed: ${String(error || '').slice(0, 140)}`;
  const res = await decom(
    { id: xell.id, slug: xell.slug, worktree_path: xell.worktree_path },
    reason,
    { what: `decommissioning proof-failed pooled xell ${xell.slug} under 'required' (this xell is not stock)`,
      verdict: reason, failLabel: 'PROOF' });
  if (!res?.reaped) {
    return { decommissioned: false, cooledDown: false,
             reason: `sweep skipped for ${xell.slug}: ${res?.skipped || res?.error || '?'} — no slot consumed` };
  }
  const stamps = proofFailDecommsInHour(pairKey, now);
  stamps.push(now);
  proofFailDecomms.set(pairKey, stamps);
  return { decommissioned: true, cooledDown: false,
           reason: `${xell.slug} reaped (${stamps.length}/${PROOF_FAIL_DECOMM_CAP_PER_HOUR} this hour)` };
}

// Run one proof and persist the machine×project verdict (plan §4.4 + §4.6). Fire-and-forget from
// maybeRunProofs (the machine stays busy until the whole thing — build + record + route + possibly
// decommission — finishes).
async function proveAndRecord(xellId, projectId, machineKey) {
  const verdict = await proveXell(xellId);
  const machine = await machineForProof(machineKey);
  let rec = null;
  let prevRec = null;
  if (machine && projectId) {
    prevRec = await one(
      `SELECT status FROM build_readiness_record WHERE machine_id=$1 AND project_id=$2`,
      [machine.id, projectId]).catch(() => null);
    rec = buildReadinessRecordFromProof(verdict);
    if (rec) await upsertBuildReadinessRecord(machine.id, projectId, rec).catch(() => null);
  }
  // ROUTE THE FAILURE BY CLASS (§4.6) — after the record is persisted, BEFORE any decommission:
  // the evidence must be recorded before the container disappears. A green proof routes nothing.
  if (!verdict.ok) {
    const xell = await one(
      `SELECT id, slug, is_pooled, status, worktree_path FROM xell WHERE id=$1`, [xellId]).catch(() => null);
    const routed = await routeProofFailure({ xell, verdict, rec, prevRec, machine, projectId });
    if (routed.class !== 'none') logline('proof', `routing for ${xell?.slug || xellId}: ${routed.class} — ${routed.reason}`);
    // The §4.3 accounting, under 'required': a proof-failed xell is not stock — decommission it so
    // the pool provisions a replacement — but capped per (machine, project) per hour.
    if (xell && xell.is_pooled && xell.status === 'ready'
        && (await projectReadinessProof(projectId)) === 'required') {
      const d = await maybeDecommissionProofFailed(xell, machineKey, projectId, verdict.error);
      logline('proof', `proof-failed teardown: ${d.decommissioned ? 'reaped' : d.cooledDown ? 'cooldown' : 'skipped'} — ${d.reason}`);
    }
  }
  return verdict;
}

// The pool tick's proof pass: backfill the unproven ready xells (oldest first), drain the
// enqueue-queue, all under the one-proof-per-machine cap; skip a pair whose recorded verdict is
// 'missing' (one recorded fact serves all — N xells do not each need to rediscover an exhausted
// address pool); and on a slow cycle re-record machine×project readiness via the live probe.
//
// `prove` is the seam test/provision-proof.test.mjs drives to assert the backfill + cap without
// standing up real builds: it defaults to proveAndRecord (proveXell + record the verdict).
// `rerecord` turns the hourly machine×project re-record cycle on (default true) — the test passes
// false so the slow cycle's real docker probe never runs under the stubbed harness.
export async function maybeRunProofs({ prove = proveAndRecord, rerecord = true } = {}) {
  if (MODE !== 'real') return;             // simulate: prove nothing, stamp nothing
  const unproven = await q(
    `SELECT id FROM xell
      WHERE status='ready' AND NOT is_production AND quarantined_at IS NULL AND proof_at IS NULL
      ORDER BY created_at ASC`).catch(() => []);
  // Merge the explicit queue and the backfill scan, oldest-first, deduped.
  const ids = [...new Set([...proofQueue, ...unproven.map((r) => r.id)])];
  proofQueue.length = 0;
  for (const id of ids) {
    const { key, projectId } = await proofMachineKey(id);
    if (!key || proofBusy.has(key)) continue;                     // one proof per machine
    if (projectId) {
      const machine = await machineForProof(key);
      if (machine) {
        const rec = await one(
          `SELECT status FROM build_readiness_record WHERE machine_id=$1 AND project_id=$2`,
          [machine.id, projectId]).catch(() => null);
        if (rec?.status === 'missing') continue;                  // skip the recorded-missing pair
      }
    }
    proofBusy.add(key);
    prove(id, projectId, key)
      .catch((e) => logline('proof', `prove ${id}: ${e.message}`))
      .finally(() => proofBusy.delete(key));
  }

  // Slow cycle: re-record machine×project readiness (plan §4.4) so the recorded verdict is never
  // staler than the last time anyone actually tried — the console matrix and the fill both read it.
  const now = Date.now();
  if (rerecord && now - lastMachineReadinessReRecord >= MACHINE_READINESS_RERECORD_MS) {
    lastMachineReadinessReRecord = now;
    const projects = await q(`SELECT id FROM project`).catch(() => []);
    for (const p of projects) {
      try {
        const rows = await buildReadinessForProject(p.id);
        for (const r of rows) {
          if (!r.machine_id || !r.status) continue;
          await upsertBuildReadinessRecord(r.machine_id, p.id, r).catch(() => null);
        }
      } catch { /* a probe failure must never fail the pool tick */ }
    }
    logline('proof', `re-recorded machine×project build-readiness for ${projects.length} project(s)`);
  }
}

// Say the machine-guard skip when it CHANGES, not every 15s tick — the same "say it when it
// CHANGES" rule monitor.js uses for the census and stale-claim lines. Keyed per project so a
// project that leaves process-runner (or gains machines) logs again the moment it becomes
// true, and a fleet with several affected projects hears each one once.
const lastMachineGuardSaid = new Map();

// DECOMMISSION A XELL THIS SWEEP SCANNED — the take, the reap and the hand-back, in ONE place, so
// both sweep sites (the reconcile pass and the trim below) obey the same rule.
//
// The rule: everything the caller decided was decided from the ROW IT SCANNED, and by the time we
// get here that row can be minutes old — each reconcile is git work and each reap is spawnSync-
// heavy. A dispatch may have CLAIMED and RENAMED this very xell in between, which is exactly how
// five dispatched tasks were destroyed in three minutes on 2026-08-05 (TKT-88-D6B4): the rename
// moved the worktree out from under the scan, `landOne` reported `no-worktree` against the path the
// scan was holding, and the reap then ran against the freshly named, freshly dispatched xell —
// naming the OLD slug in the pool line and the NEW one in the reaper line, one xell, two names.
//
// So the verdict is re-asked of the database ATOMICALLY before it is acted on: takeReadyXellForSweep
// is a conditional UPDATE that only moves a xell that is STILL 'ready', STILL this slug and STILL
// this worktree. A dispatch's claim is the same compare-and-set on the same row off the same value,
// so exactly one of the two can win — in either order, with no window between a read and a write for
// the other to slip through. Exported as the seam the regression test drives
// (test/dispatch-claim-vs-pool-sweep.test.mjs).
export async function sweepDecommission(scanned, reason, { what = null, verdict = null, failLabel = 'REAP' } = {}) {
  const taken = await takeReadyXellForSweep(scanned);
  if (!taken) {
    const now = (await currentXells([scanned.id])).get(scanned.id) || null;
    logline('pool', `NOT decommissioning ${scanned.slug}${verdict ? ` (${verdict})` : ''} — `
      + `${explainSweepSkip(scanned, now)}; this sweep's verdict is stale and was discarded`);
    return { reaped: false, skipped: explainSweepSkip(scanned, now) };
  }
  if (what) logline('pool', what);
  // A reap that FAILS must be loud: it leaves the xell exactly where it was, and a console.error
  // nobody reads is how a stuck xell survives for hours. The take above moved it to 'tearing-down',
  // so hand it back — every refusal reapXell can return happens before it changes anything.
  const r = await reapXell(scanned.id, reason).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) {
    await untakeSweptXell(scanned.id);
    logline('pool', `${failLabel} FAILED for ${scanned.slug}: ${r?.error || 'refused'} — it stays ready and will be retried next tick`);
    return { reaped: false, error: r?.error || 'refused' };
  }
  return { reaped: true };
}

async function reconcileProject(projectId, target) {
  const project = await one(`SELECT main_branch, compose_spinoff, manifest FROM project WHERE id=$1`, [projectId]);
  const src = project?.main_branch || 'main';
  // Process-runner server ⇒ docker_ctx NULL on the server row ⇒ machine-mode counts are zero.
  // Compose projects (no process runner) are placeable even when compose_spinoff is unset.
  const placeable = !serverRoleIsProcess(project?.manifest);

  // BAKE THE PREPPED CXELL IMAGE (spawn template `when: image|provision`) — here, because here is
  // the pool's clock. Every cage of this project then starts from an image that already carries the
  // template's packages, instead of running apt on the dispatch path while a human waits. It is a
  // no-op unless the project asked for it, a no-op when the image already exists, and never fatal:
  // a failed bake leaves dispatch installing the packages the way it always has.
  if (MODE === 'real') {
    const prep = await spawnPrepFor(projectId);
    if (bakesImage(prep)) {
      await ensurePreppedImage({ ctx: 'default', baseImage: deviceConfig(project).cxellImage || undefined,
                                prep, label: `project ${projectId.slice(0, 8)}` })
        .catch((e) => logline('pool', `prepped image: ${e.message}`));
    }
  }

  // 1+2. Reconcile pooled xells to the source. Only in real mode (simulate has no worktrees).
  if (MODE === 'real') {
    // Capped per tick: each reconcile is git work. Against a normal pool (≤ a handful) the cap
    // is invisible; against a runaway pile it keeps the tick bounded while trim drains it —
    // an unreconciled surplus xell is fine, it is on its way out anyway.
    const pooled = await q(
      `SELECT id, slug, head_commit, worktree_path FROM xell
         WHERE project_id=$1 AND status='ready' AND NOT is_production
           AND quarantined_at IS NULL
         ORDER BY ready_at DESC NULLS LAST, created_at DESC LIMIT 25`, [projectId]);
    for (const x of pooled) {
      // THE BLIND-DEATH AUDIT (ticket #81, part two). A cage that dies at SPAWN twice in a row is
      // released back to 'ready' and never reaches noteTurnDeath, so the CLASSIFIED streak cannot
      // move for it — and a quarantine that never fires is worse than none (a trusted guard that
      // silently does nothing). The pool owns the ready list, so the pool is where the ledger-only
      // half of the count is collected: sum the classified streak with the errored exits the
      // classifier never saw and stamp the quarantine when the union crosses the threshold. Already-
      // quarantined xells are excluded from this SELECT (quarantined_at IS NULL above); one that
      // quiesces between audit and stamp is handled by the conditional stamp inside.
      const audit = await quarantineFromBlindAudit(x.id).catch(() => null);
      if (audit?.quarantine) continue; // the quarantine card is up — this xell is a human's call now
      const { verdict, res } = await reconcileXell(x, src);
      if (verdict === 'decommission') {
        await sweepDecommission(x, `stale:${res?.reason || 'drift'}`,
          { what: `decommissioning ${x.slug} — ${res?.reason || 'unreconcilable'} (behind ${res?.behind ?? '?'}); will reprovision fresh`,
            verdict: res?.reason || 'unreconcilable' });
      }
    }
  }

  // 3+4. Fill or trim (all pooled xells now guaranteed at the source tip). Machine mode: each
  // machine keeps ITS OWN number of ready xells for THIS project (machine_pool, 025 — a
  // high-load project pools bigger than a quiet one on the same host); legacy project-wide
  // target otherwise.
  // Machine mode counts a project's ready xells THROUGH their owned server container
  // (fillTrim's join on role='server' + docker_ctx). A process-runner project (e.g. Zeehive
  // itself: bare worktree + process server/webapp) stamps docker_ctx=NULL on those rows, so
  // that count is ALWAYS ZERO no matter how many ready xells exist: fill would provision
  // pool_size more every tick, trim would never see a surplus. That is exactly how 167 ready
  // Zeehive xells piled up by 2026-07-19 — and the per-tick reconcile sweep over all of them
  // is what froze the API. But a process xell is not machine-LESS: it lives on the queenzee
  // host, always, by construction — so such projects honor the QUEENZEE-HOST machine's
  // pool_size (counted project-wide, no join) and only the REMOTE rows are a dead letter.
  //
  // compose_spinoff is NOT the predicate: a compose project with machines configured but an
  // empty compose_spinoff column still stamps docker_ctx at provision, and must take the
  // machine path — otherwise mardale-prod's pool_size is a dead letter until someone happens
  // to refresh tiers.spinoff.compose into the column (the "mardale-prod never gets pool xells"
  // defect under its second diagnosis).
  const machines = await poolMachines(projectId);
  if (!machines.length) {
    // MACHINE-AWARE BY DEFAULT (docs/default-machine-pooling-decision-record.md): no
    // machine_pool row for this project does not mean "no machine" — it means "the default
    // one". The project-wide target pools on the one machine that can actually host the
    // project (queenzee host for process projects; the machine holding its shared dev db for
    // compose projects), machine-aware count and max_xells cap included. Only a hive with no
    // machines — or none eligible — still takes the placeless legacy path.
    const cfg = await one(`SELECT default_db_coupling FROM pool_config WHERE project_id=$1`, [projectId]);
    const im = await implicitPoolMachine(projectId, {
      isProcess: !placeable, coupling: cfg?.default_db_coupling || null });
    if (im) {
      const said = `implicit:${im.key}:${!placeable}`;
      if (lastMachineGuardSaid.get(`${projectId}:implicit`) !== said) {
        lastMachineGuardSaid.set(`${projectId}:implicit`, said);
        logline('pool', `pooling for project ${String(projectId).slice(0, 8)} defaults to machine `
          + `'${im.key}' (no per-machine config; project-wide target applies there${!placeable ? ', project-wide count: process xells all live on the queenzee host' : ''})`);
      }
      return fillTrim(projectId, target, !placeable ? { ...im, processLocal: true } : im)
        .catch((e) => console.error(`[pool] ${im.key}:`, e.message));
    }
    return fillTrim(projectId, target, null);
  }
  if (!placeable) {
    // Process-runner project with machines configured. Every one of its xells lives on the
    // QUEENZEE HOST by construction (worktree on the host fs, server/webapp as local processes,
    // the cage on the queenzee's own daemon), so per-machine pooling is honored on the ONE
    // machine that is — the queenzee-host row — counted PROJECT-WIDE (fillTrim's process-local
    // mode: no docker_ctx join, so the zero-count runaway that piled up 167 xells cannot recur).
    // A REMOTE row stays a dead letter — recorded below once per state change (the same "say it
    // when it CHANGES" rule monitor.js uses; the pool ticks every 15s, and a verbatim repeat
    // would drown the lines that carry news), while the matrix shows the same fact dimmed at
    // the knobs. (docs/process-machine-pooling-decision-record.md)
    const host = machines.find((m) => m.docker_ctx === queenzeeHostCtx());
    const remote = machines.filter((m) => m.docker_ctx !== queenzeeHostCtx());
    if (remote.length) {
      // INFORMATIONAL, not an alert. This line used to carry the house `!!!` marker and a
      // console.error — earned when dead remote config was a TRAP (the pool silently fell back
      // to a different target). Since the default-pooling ship it is harmless: the queenzee-host
      // row (or the implicit default below) governs, the runaway is structurally impossible, and
      // the matrix shows the no-effect state dimmed at the knobs themselves. An alert that fires
      // forever over harmless config buries the ops digest lines that carry news
      // (docs/pooling-dead-config-demotion-decision-record.md). Ring-only, once per state change.
      const msg = `per-machine pooling has no effect on [${remote.map((m) => m.key).join(', ')}] `
        + `for project ${String(projectId).slice(0, 8)}: the spinoff server is runner:process — a `
        + `process xell's worktree, processes and cage all live on the queenzee host, so a remote `
        + `machine can never host one. `
        + (host
          ? `Pooling is governed by '${host.key}' (the queenzee-host machine).`
          : `The project-wide pool target applies on the queenzee host.`);
      if (lastMachineGuardSaid.get(projectId) !== msg) {
        lastMachineGuardSaid.set(projectId, msg);
        logline('pool', msg);
      }
    }
    if (host) {
      const size = await machinePoolSize(host.id, projectId);
      return fillTrim(projectId, size, { ...host, processLocal: true })
        .catch((e) => console.error(`[pool] ${host.key}:`, e.message));
    }
    // Only remote rows configured (all dead letters): the DEFAULT still applies — pool the
    // project-wide target on the queenzee-host machine row when one exists, legacy otherwise.
    const im = await implicitPoolMachine(projectId, { isProcess: true });
    if (im) {
      return fillTrim(projectId, target, { ...im, processLocal: true })
        .catch((e) => console.error(`[pool] ${im.key}:`, e.message));
    }
    return fillTrim(projectId, target, null);
  }
  for (const m of machines) {
    const size = await machinePoolSize(m.id, projectId);
    await fillTrim(projectId, size, m).catch((e) => console.error(`[pool] ${m.key}:`, e.message));
  }
}

// THE FILL CONSULTS THE RECORD (§4.4/§4.6) — why the pool is not filling a (machine, project) pair
// right now, or null when it should fill. Two stop-reasons, both keyed on the pair:
//   • build_readiness_record status 'missing' — a persistent INFRA fault (address pools, daemon
//     down, context missing, port bind refused) flipped the pair's recorded verdict, so the pool
//     stops provisioning onto a machine known to be unable to host this project's build. Flipped by
//     the proof path (§4.6) AND by the provision-time path (a xell that cannot be CREATED — see
//     noteProvisionFailure); recovery is the same either way. The console matrix badge is already
//     red from the SAME record — one fact, N readers.
//   • the proof-failed teardown cooldown (§4.3) — past the decommission cap the pair cools down:
//     no more reaps AND no more provisioning, so a main that cannot build holds the gate under
//     'required' instead of churning provision→fail→reap or piling unclaimable xells to max_xells.
// Exported for the stage-2 verify (the fill-stop on a recorded 'missing' drives the real SQL).
export async function fillStopReasonFor(projectId, m) {
  if (!m) return null;
  const rec = await one(
    `SELECT status FROM build_readiness_record WHERE machine_id=$1 AND project_id=$2`,
    [m.id, projectId]).catch(() => null);
  if (rec?.status === 'missing') {
    return `build_readiness_record for (${m.key}, this project) is 'missing' — the machine cannot `
      + 'host the project\'s build; the fault is a human\'s (the console card names the check and '
      + 'the one medic action)';
  }
  const cd = proofFailCooldownFor(proofFailPairKey(m.docker_ctx || m.key, projectId));
  if (cd) {
    return `proof-failed teardown cap reached — this (machine, project) pair is on cooldown until `
      + new Date(cd).toISOString();
  }
  return null;
}

// Card a provision failure by CONSECUTIVE failed tick (§4.6 — the provision-time half of the
// routing; a fault that stops a xell being CREATED never reaches a proof, so the proof path can
// not route it). Called from fillTrim's catch. In-memory across ticks — a restart resets the count,
// the same "a restart is calm" rule as the proof-fail budget. Past the threshold the pair is
// recorded 'missing' (fillStopReasonFor then stops the fill, the matrix badge flips) and the
// PROVISION-INFRA card is raised (proof-routing's dedup). NEVER throws — a carding failure must not
// fail the fill tick. Returns { recorded, carded, reason } for the pool line.
export async function noteProvisionFailure(projectId, m, err) {
  const machineKey = m?.key || m?.docker_ctx || null;
  const pairKey = provisionFailurePairKey(machineKey, projectId);
  const n = (provisionFailCount.get(pairKey) || 0) + 1;
  provisionFailCount.set(pairKey, n);
  if (n < PROVISION_FAIL_THRESHOLD) {
    return { recorded: false, carded: false,
             reason: `provision failure ${n}/${PROVISION_FAIL_THRESHOLD} on ${machineKey || '?'} — retried next tick` };
  }
  provisionFailCount.delete(pairKey);          // the recorded 'missing' IS the state now
  if (!machineKey) {
    return { recorded: false, carded: false,
             reason: 'no machine row for the pair — nothing to record or card on (legacy project-wide fill)' };
  }
  const machine = await one(`SELECT id FROM machine WHERE key=$1 OR docker_ctx=$1`, [machineKey]).catch(() => null);
  if (!machine) {
    return { recorded: false, carded: false, reason: `no machine row '${machineKey}' — nothing to record or card on` };
  }
  const error = String((err && err.message) || err || 'provision failed');
  const rec = await upsertBuildReadinessRecord(machine.id, projectId,
    { status: 'missing', error, checks: [] }).catch(() => null);
  if (!rec) {
    return { recorded: false, carded: false,
             reason: `could not record 'missing' for (${machineKey}, project ${String(projectId).slice(0, 8)})` };
  }
  const card = await raiseInfraCard({ projectId, machineKey, check: 'provision', detail: error });
  return { recorded: true, carded: card.raised,
           reason: `pair (${machineKey}) recorded 'missing' after ${n} consecutive provision failures — ${card.reason}` };
}

// Fill to / trim past `target` ready xells — on one machine (m) or project-wide (m = null).
// m.processLocal marks the process-runner special case: the queenzee-host machine of a project
// whose xells ALL live there by construction. Its ready set is the project-wide query — the
// docker_ctx join would count zero forever (process server rows carry docker_ctx=NULL), which
// is the runaway this flag exists to avoid — while the machine's max_xells still caps the fill
// below (liveXellCount counts NULL-ctx rows into the queenzee host).
async function fillTrim(projectId, target, m) {
  // THE FILL-STOP (§4.4/§4.6): a recorded 'missing' (or a proof-failed cooldown) pair is NOT
  // provisioned. Said on state CHANGE only — the pool ticks every 15s and a verbatim repeat would
  // drown the lines that carry news; a stopped pair that is over target still trims below.
  const fillStop = await fillStopReasonFor(projectId, m);
  if (m) {
    const key = `fillstop:${m.id}:${projectId}`;
    if (fillStop) {
      if (lastMachineGuardSaid.get(key) !== fillStop) {
        lastMachineGuardSaid.set(key, fillStop);
        logline('pool', `fill STOPPED for project ${String(projectId).slice(0, 8)} on ${m.key}: ${fillStop}`);
      }
    } else if (lastMachineGuardSaid.has(key)) {
      lastMachineGuardSaid.delete(key);
      logline('pool', `fill RESUMED for project ${String(projectId).slice(0, 8)} on ${m.key} — the fault cleared`);
    }
  }

  // A QUARANTINED xell is excluded from the ready set on both arms — it must not count toward the
  // target (the pool should provision a fresh cage to take its place) and it must not land in the
  // TRIM surplus either. Reaping the cage is the human's explicit choice (the other arm of the
  // ticket #81 decision), never a pool-sweep accident; a quarantined row sits untouched until a
  // human clears it or reaps it.
  //
  // Under 'required', a PROOF-FAILED xell is not stock either (§4.3): it must not count toward
  // pool_size, so the fill provisions a replacement (and the failed one is decommissioned by the
  // routing pass, capped). Under 'advisory'/'off' it is still claimable and still counts.
  const excludeProofFailed = (await projectReadinessProof(projectId)) === 'required'
    ? ` AND (proof_at IS NULL OR proof_error IS NULL)` : '';
  const ready = m && !m.processLocal
    ? await q(
      `SELECT x.id, x.slug, x.worktree_path FROM xell x JOIN container c ON c.owner_xell_id = x.id AND c.role='server'
        WHERE x.project_id=$1 AND x.status='ready' AND NOT x.is_production AND x.quarantined_at IS NULL AND c.docker_ctx=$2${excludeProofFailed}
        ORDER BY x.ready_at DESC NULLS LAST, x.created_at DESC`, [projectId, m.docker_ctx])
    : await q(
      `SELECT id, slug, worktree_path FROM xell WHERE project_id=$1 AND status='ready' AND NOT is_production AND quarantined_at IS NULL${excludeProofFailed}
        ORDER BY ready_at DESC NULLS LAST, created_at DESC`, [projectId]);

  if (ready.length < target && !fillStop) {
    // max_xells is MACHINE-WIDE: every live dev xell on the host counts (all projects, claimed
    // and working too), so a busy machine fills less than pool_size rather than blowing past it.
    let room = target - ready.length;
    if (m) room = Math.min(room, Math.max(0, m.max_xells - await liveXellCount(m.docker_ctx)));
    for (let i = 0; i < room; i++) {
      try {
        const x = await provisionXell({ projectId, mode: MODE, machineCtx: m?.docker_ctx });
        // A provision that SUCCEEDS clears the pair's failure streak (a transient fault below the
        // carding threshold is over — the next persistent episode counts fresh).
        provisionFailCount.delete(provisionFailurePairKey(m?.key || m?.docker_ctx || null, projectId));
        logline('pool', `provisioned ready xell ${x.slug} (${MODE}${m ? ` on ${m.key}` : ''}) → server :${x.ports.serverPort} web :${x.ports.webPort}`);
        // ENQUEUE THE BURN-IN (plan §4.4): fire-and-forget like warmWorktree — a provision that
        // failed because a proof was slow would be a worse bug than the one this fixes. The proof
        // pass below picks it up the same tick (a fresh xell is ready + unproven).
        if (MODE === 'real') enqueueProof(x.id);
      } catch (err) {
        console.error(`[pool] provision failed${m ? ` on ${m.key}` : ''}:`, err.message);
        // CARD A PERSISTENT HALT (§4.6 — provision-time): count this failed tick for the pair; at
        // the threshold record 'missing' + raise the PROVISION-INFRA card so a project that can no
        // longer provision stops retrying SILENTLY forever (the record stops the fill next tick).
        // Never fatal — a carding failure only means the halt stays silent one more tick.
        const npf = await noteProvisionFailure(projectId, m, err)
          .catch((e) => ({ recorded: false, carded: false, reason: `carding error: ${e.message}` }));
        if (npf.recorded || npf.carded) logline('pool', `[provision fault] ${npf.reason}`);
        break; // stop hammering on persistent failure this tick
      }
    }
  } else if (ready.length > target) {
    // Batch the trim: a reap is spawnSync-heavy (worktree + branch removal), and a large
    // surplus (the 167-xell pile above) drained in one tick would freeze the API for minutes.
    // Five per tick keeps the queenzee responsive; the rest go next tick.
    const surplus = ready.slice(target); // freshest kept, oldest surplus reaped
    const batch = surplus.slice(0, 5);
    logline('pool', `trimming ${batch.length}/${surplus.length} surplus ready xell(s)${m ? ` on ${m.key}` : ''}: ${batch.map((s) => s.slug).join(', ')}`);
    // Same take, same reason as the reconcile sweep above: this list was SELECTed before the reaps
    // began, and a dispatch can claim any of it while the batch drains (a reap is spawnSync-heavy,
    // so the last of five is decided on a list that is seconds old).
    for (const s of batch) {
      await sweepDecommission(s, 'pool-surplus', { what: null, verdict: 'surplus', failLabel: 'TRIM' });
    }
  }
}

export async function ensureReady() {
  const projects = await q(
    `SELECT p.id, COALESCE(pc.target_ready,0) AS target
       FROM project p LEFT JOIN pool_config pc ON pc.project_id = p.id`);
  for (const p of projects) {
    await reconcileProject(p.id, p.target).catch((e) => console.error('[pool] reconcile', e.message));
  }
  // THE PROOF PASS runs on the pool's clock, after the reconcile/fill/trim — the same tick that
  // owns "work on the pool's clock". Backfills the unproven ready xells, drains the provision-time
  // queue, and re-records machine×project readiness hourly (plan §4.4).
  await maybeRunProofs().catch((e) => console.error('[pool] proof pass', e.message));
}

export function startPool() {
  if (process.env.POOL_ENABLED === 'false') {
    console.log('[queenzee] pool maintainer DISABLED (POOL_ENABLED=false)');
    return null;
  }
  console.log(`[queenzee] pool maintainer started (mode=${MODE}, ${config.poolIntervalMs}ms)`);
  // SAY THE QUIET HALF OUT LOUD. "mode=simulate" reads as "provisioning is fake", which sounds
  // harmless. The unadvertised half is that it also switches the RECONCILER off (see ensureReady:
  // the whole catch-up/decommission pass is inside `if (MODE === 'real')`), because a simulated
  // xell legitimately has no worktree and reconciling would bin the lot.
  //
  // Both halves are fine against a demo database and ruinous against a real one: the maintainer
  // backfills the pool with rows it never provisioned, and the one check that would notice is off.
  // On 2026-07-16 a restart dropped PROVISION_MODE=real and this ran for an hour — three xells sat
  // 'ready' with no worktree on disk, dispatch kept handing them out, and the only symptom was a
  // confusing spawn failure inside a zee. One line of startup noise is cheaper than that hour.
  if (MODE !== 'real') {
    console.log('[queenzee] ⚠ POOL IS IN SIMULATE — it will mark xells `ready` with NO worktree on '
      + 'disk, AND the reconciler that would decommission them is OFF. Do not point this at a real '
      + 'registry: run with PROVISION_MODE=real (see HANDOFF "Run it").');
  }
  // Re-entrancy guard: setInterval fires on schedule whether or not the last sweep finished,
  // so a sweep that outruns the interval (large pool, slow git) STACKS more sweeps on top —
  // each slower than the last. That compounding is what took the API from 47s to 90s+ on
  // 2026-07-19. One sweep at a time; a skipped tick just runs next interval.
  let sweeping = false;
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await ensureReady(); } catch (e) { console.error('[pool]', e.message); }
    finally { sweeping = false; }
  };
  tick();
  return setInterval(tick, config.poolIntervalMs);
}
