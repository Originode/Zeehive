// INFRA-MEDIC — the capability-gated `/api/xell/self/infra/*` verbs (provision-proof plan §7, stage 3).
//
// The infra-medic is a WORKER harness carrying the 'infra-troubleshoot' capability. It is the reader
// of the provisioning evidence (the readiness ladder, proof verdicts, bootstrap plans, the non-secret
// settings projection) and the raiser of the two HUMAN-GATED cards that mutate real infra or
// settings. The verb shape is the plan's §7.1 table:
//
//   readiness / proof / bootstrap-plan / settings   — NOT gated (read-only, or throwaway containers,
//                                                     the same class as `zee build`)
//   bootstrap / propose                             — HUMAN-GATED card → the QUEENZEE performs on
//                                                     approval; perform NOTHING before it
//
// The gate resolves the CALLING xell's effective harness chain and reads the capabilities COLUMN
// only (237: the bundle authoring surface — personality/skills/memory — cannot express a grant, and
// is never consulted here). A harness inheriting the medic counts; a DISABLED ancestor grants
// nothing (the same `AND enabled` walk effectiveHarness does).
//
// REFUSALS that are the design (§7.3 / DR-5):
//   • no write DSN to the meta-DB exists on any path — every mutation is a queenzee-mediated verb;
//   • bootstrap and propose perform NOTHING until a human approves the card (infra_request);
//   • a harness edit cannot self-grant a capability (the column is set only by migration/console);
//   • project creation stays a human console act (DR-6) — the medic drives convergence after it.

import { q, one } from '../db/pool.js';
import {
  buildReadinessForProject, recordedBuildReadinessForProject, recordBuildReadinessProbe,
} from './build-readiness.js';
import { performBuildBootstrap } from './build-bootstrap.js';
import { proveXell } from './xell-proof.js';
import { refreshProjectManifest } from './projects.js';
import { logline } from './logbus.js';
import { broadcast } from './events.js';

// The capability walk + gate live in harness-capabilities.js (import-light, so the dispatch and the
// seal-time firewall opening use the SAME answer without pulling in the whole medic surface). This
// module re-exports them so routes.js keeps importing one place.
export {
  INFRA_CAPABILITY, xellCapabilities, hasInfraTroubleshoot, requireInfra,
} from './harness-capabilities.js';

const projectOfXell = (xell) => {
  if (!xell?.project_id) throw new Error('the calling xell has no project — the medic acts on its own project and nothing else');
  return xell.project_id;
};

// ── readiness (NOT gated — read) ─────────────────────────────────────────────
// Run/read the machine×project readiness for the calling xell's project. `refresh` runs the probe
// now (and records it, exactly the console's behaviour); otherwise reads the recorded verdict.
export async function infraReadiness(xell, { refresh = false } = {}) {
  const projectId = projectOfXell(xell);
  if (refresh) {
    const rows = await buildReadinessForProject(projectId);
    await recordBuildReadinessProbe(projectId, rows);
    return { project_id: projectId, refreshed: true, probe: rows };
  }
  return { project_id: projectId, refreshed: false, recorded: await recordedBuildReadinessForProject(projectId) };
}

// ── proof (NOT gated — burn-in, throwaway containers) ────────────────────────
// Burn in a POOLED xell of the calling xell's project. `--xell <slug>` picks the pooled xell; the
// default picks the first ready pooled xell of the project. proveXell stamps the verdict on the
// xell row and on the machine's build_readiness_record. Same class as `zee build` — never gated.
export async function infraProof(xell, { xellSlug = null } = {}) {
  const projectId = projectOfXell(xell);
  let targetId = null;
  if (xellSlug) {
    const t = await one(`SELECT id, project_id FROM xell WHERE slug=$1`, [xellSlug]);
    if (!t) throw new Error(`no xell with slug '${xellSlug}'`);
    if (t.project_id !== projectId) {
      throw new Error(`xell '${xellSlug}' is not a xell of your project — the medic acts on its own project and nothing else`);
    }
    targetId = t.id;
  } else {
    const t = await one(`SELECT id FROM xell WHERE project_id=$1 AND status='ready'
                           ORDER BY proof_at ASC NULLS FIRST, id LIMIT 1`, [projectId]);
    if (!t) throw new Error('no pooled ready xell of this project to prove — provision/refill the pool first');
    targetId = t.id;
  }
  const verdict = await proveXell(targetId, {});
  return { xell_id: targetId, xell_slug: xellSlug, ...verdict };
}

// ── bootstrap-plan (NOT gated — performBuildBootstrap dryRun verbatim) ───────
export async function infraBootstrapPlan(xell, { machineId = null } = {}) {
  const projectId = projectOfXell(xell);
  if (!machineId) throw new Error('a machine is required — pass the machine id you saw in `zee infra settings` (or readiness)');
  const machine = await one(`SELECT id FROM machine WHERE id=$1`, [machineId]);
  if (!machine) throw new Error('no such machine');
  return performBuildBootstrap(projectId, machineId, { dryRun: true, actor: `medic@${xell.slug}` });
}

// ── settings (NOT gated — non-secret projection) ─────────────────────────────
// Explicit column lists only: no secret column (token, secret, password, dsn, *_hint, env value) is
// ever selected. The Verify test asserts THAT against the live sandbox schema, not a hardcoded list.
export async function infraSettings(xell) {
  const projectId = projectOfXell(xell);
  const project = await one(
    `SELECT id, name, repo_root, registry, manifest, manifest_hash, manifest_at
       FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  const pool_config = await one(`SELECT * FROM pool_config WHERE project_id=$1`, [projectId]);
  const machines = await q(
    `SELECT m.id, m.key, m.label, m.docker_ctx, m.host_ip, m.can_build, m.dev_priority,
            m.max_xells, m.enabled, mp.pool_size
       FROM machine m
       LEFT JOIN machine_pool mp ON mp.machine_id = m.id AND mp.project_id = $1
      WHERE m.enabled OR mp.project_id = $1
      ORDER BY m.dev_priority DESC, m.key`, [projectId]);
  const containers = await q(
    `SELECT id, role, tier, isolation, name, image_tag, docker_ctx, host_port, internal_port,
            url, compose_project, network, owner_xell_id, health, last_seen_at
       FROM container WHERE project_id=$1 ORDER BY role, name`, [projectId]);
  const deploy_sites = await q(
    `SELECT id, key, tier, docker_ctx, host, compose_file, env_file, ingress, reachable_at, is_default
       FROM deploy_site WHERE project_id=$1 ORDER BY tier, key`, [projectId]);
  return { project, pool_config, machines, containers, deploy_sites };
}

// ── the gated cards (bootstrap / propose) ────────────────────────────────────
// One open card per (project, kind): re-asking while one is open hands the same card back, exactly
// like the fleet's other ask tables. The card performs NOTHING; a human decides; the queenzee
// performs on approval and the row becomes the receipt.
async function fileInfraRequest({ projectId, xell, kind, payload, reason }) {
  const open = await one(
    `SELECT * FROM infra_request WHERE project_id=$1 AND kind=$2 AND status IN ('pending','approved')
       ORDER BY requested_at DESC LIMIT 1`, [projectId, kind]);
  if (open) {
    return { card: open, existing: true,
      message: `a ${kind} card for this project is already ${open.status} — nothing new filed` };
  }
  const row = await one(
    `INSERT INTO infra_request (project_id, xell_id, kind, payload, reason)
     VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
    [projectId, xell.id, kind, JSON.stringify(payload), reason || null]);
  logline('infra-medic', `${xell.slug} filed a ${kind} card for project ${projectId}`);
  broadcast('infra', { id: row.id, project_id: projectId, kind, status: row.status });
  return { card: row, existing: false,
    message: `${kind} card filed — a human must approve it before the queenzee performs anything` };
}

// bootstrap --perform → a HUMAN-GATED card (never an act). The queenzee performs with the console's
// exact contract on approval (performBuildBootstrap verbatim, guardDevOnly intact, every step
// recorded in build_bootstrap_action).
export async function infraBootstrap(xell, { machineId = null, reason = null } = {}) {
  const projectId = projectOfXell(xell);
  if (!machineId) throw new Error('a machine is required for a bootstrap card — pass the machine id you saw in settings');
  const machine = await one(`SELECT id, key FROM machine WHERE id=$1`, [machineId]);
  if (!machine) throw new Error('no such machine');
  return fileInfraRequest({ projectId, xell, kind: 'bootstrap', payload: { machine_id: machineId }, reason });
}

// ── propose — the settings patch the queenzee may apply, and the validation ──
// The whitelist is the QUEENZEE-APPLIED surface: a field not listed here is refused, a machine key
// not on the estate is refused, and the patch is validated BOTH when filed and when applied.
const PROPOSE_WHITELIST = {
  project: { registry: 'string' },
  pool_config: {
    target_ready: 'int', readiness_proof: 'readiness_proof',
    default_db_coupling: 'db_coupling', default_build_ctx: 'string', backup_ctx: 'string',
    refresh_interval_sec: 'int',
  },
  machines: { dev_priority: 'int', can_build: 'boolean', max_xells: 'int' },
  machine_pool: { pool_size: 'int' },
};

function validateProposePatch(patch) {
  const topKeys = new Set(['project', 'pool_config', 'machines', 'machine_pool', 'manifest_refresh']);
  for (const top of Object.keys(patch)) {
    if (top === 'manifest_refresh') {
      if (patch.manifest_refresh !== true) throw new Error('manifest_refresh must be exactly true');
      continue;
    }
    if (!topKeys.has(top)) throw new Error(`propose: unknown settings section '${top}' — the whitelist is `
      + `${[...topKeys].join(', ')}`);
    const section = PROPOSE_WHITELIST[top];
    for (const [k, v] of Object.entries(patch[top] || {})) {
      const kind = section[k];
      if (!kind) throw new Error(`propose: '${top}.${k}' is not on the whitelist — the queenzee applies `
        + `only ${Object.keys(section).join(', ')}`);
      if (kind === 'int' && !Number.isInteger(v)) throw new Error(`propose: '${top}.${k}' must be an integer`);
      if (kind === 'boolean' && typeof v !== 'boolean') throw new Error(`propose: '${top}.${k}' must be a boolean`);
      if (kind === 'string' && typeof v !== 'string') throw new Error(`propose: '${top}.${k}' must be a string`);
      if (kind === 'db_coupling' && !/^db-[a-z-]+$/.test(v)) throw new Error(`propose: '${top}.${k}' must be a db_coupling like 'db-shared-dev'`);
      if (kind === 'readiness_proof' && !['off', 'advisory', 'required'].includes(v)) {
        throw new Error(`propose: '${top}.${k}' must be one of off|advisory|required`);
      }
    }
  }
}

export async function infraPropose(xell, { change = null, reason = null } = {}) {
  const projectId = projectOfXell(xell);
  let patch;
  if (typeof change === 'string') {
    try { patch = JSON.parse(change); } catch (e) { throw new Error(`--change must be a JSON object — could not parse: ${e.message}`); }
  } else {
    patch = change;
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('--change must be a JSON object');
  validateProposePatch(patch);
  return fileInfraRequest({ projectId, xell, kind: 'propose', payload: { change: patch }, reason });
}

// Apply a validated propose patch — the QUEENZEE half of the card. Only whitelisted fields, every
// change recorded (before → after, who approved). Returns the receipt.
export async function applySettingsPatch(projectId, patch, actor) {
  if (!patch || typeof patch !== 'object') throw new Error('a propose patch must be a JSON object');
  validateProposePatch(patch);
  const changes = [];
  const rec = (field, before, after) => changes.push({ field, before: before ?? null, after, by: actor });

  if (patch.manifest_refresh === true) {
    const before = (await one(`SELECT manifest_hash FROM project WHERE id=$1`, [projectId]))?.manifest_hash || null;
    const after = await refreshProjectManifest(projectId);
    rec('project.manifest', before, after.manifest_hash);
  }
  if (patch.project?.registry !== undefined) {
    const before = (await one(`SELECT registry FROM project WHERE id=$1`, [projectId]))?.registry || null;
    await q(`UPDATE project SET registry=$2 WHERE id=$1`, [projectId, patch.project.registry]);
    rec('project.registry', before, patch.project.registry);
  }
  if (patch.pool_config) {
    const beforeRow = await one(`SELECT * FROM pool_config WHERE project_id=$1`, [projectId]);
    const sets = [];
    const vals = [projectId];
    for (const [k, v] of Object.entries(patch.pool_config)) {
      sets.push(`${k} = $${vals.length + 1}`);
      vals.push(v);
      rec(`pool_config.${k}`, beforeRow?.[k], v);
    }
    if (sets.length) await q(`UPDATE pool_config SET ${sets.join(', ')} WHERE project_id=$1`, vals);
  }
  if (patch.machines) {
    for (const [key, mf] of Object.entries(patch.machines)) {
      const m = await one(`SELECT id FROM machine WHERE key=$1`, [key]);
      if (!m) throw new Error(`no machine '${key}' on the estate — the patch names a machine that does not exist`);
      const beforeRow = await one(`SELECT * FROM machine WHERE id=$1`, [m.id]);
      const sets = [];
      const vals = [m.id];
      for (const [k, v] of Object.entries(mf)) {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(v);
        rec(`machine.${key}.${k}`, beforeRow?.[k], v);
      }
      await q(`UPDATE machine SET ${sets.join(', ')} WHERE id=$1`, vals);
    }
  }
  if (patch.machine_pool) {
    for (const [key, mf] of Object.entries(patch.machine_pool)) {
      const m = await one(`SELECT id FROM machine WHERE key=$1`, [key]);
      if (!m) throw new Error(`no machine '${key}' on the estate`);
      const beforeRow = await one(
        `SELECT * FROM machine_pool WHERE machine_id=$1 AND project_id=$2`, [m.id, projectId]);
      const sets = [];
      const vals = [m.id, projectId];
      for (const [k, v] of Object.entries(mf)) {
        sets.push(`${k} = $${vals.length + 2}`);
        vals.push(v);
        rec(`machine_pool.${key}.${k}`, beforeRow?.[k], v);
      }
      await q(`UPDATE machine_pool SET ${sets.join(', ')} WHERE machine_id=$1 AND project_id=$2`, vals);
    }
  }
  broadcast('project', { id: projectId });
  logline('infra-medic', `applied settings patch on project ${projectId} by ${actor}: ${changes.length} change(s)`);
  return { applied: changes, count: changes.length };
}

// ── the human decision → queenzee performs ───────────────────────────────────
// ONLY a human approves (the console route). On approve, the QUEENZEE performs the kind and records
// the receipt on the row; the row becomes the audit of who asked, what changed, what came back.
export async function decideInfraRequest(requestId, decision, by) {
  const row = await one(`SELECT * FROM infra_request WHERE id=$1`, [requestId]);
  if (!row) throw new Error('no such infra request');
  if (row.status !== 'pending') throw new Error(`infra request is already ${row.status} — only a pending card can be decided`);
  if (decision === 'reject') {
    await q(`UPDATE infra_request SET status='rejected', decided_at=now(), decided_by=$2 WHERE id=$1`,
      [requestId, by]);
    logline('infra-medic', `infra request ${requestId} REJECTED by ${by}`);
    return { id: requestId, status: 'rejected', decided_by: by };
  }
  if (decision !== 'approve') throw new Error(`unknown decision '${decision}' (approve|reject)`);
  await q(`UPDATE infra_request SET status='approved', decided_at=now(), decided_by=$2 WHERE id=$1`,
    [requestId, by]);
  const result = await performInfraRequest(row, by);
  const status = result.ok ? 'completed' : 'failed';
  await q(`UPDATE infra_request SET status=$2, result=$3::jsonb, finished_at=now() WHERE id=$1`,
    [requestId, status, JSON.stringify(result)]);
  broadcast('infra', { id: requestId, project_id: row.project_id, kind: row.kind, status });
  return { id: requestId, kind: row.kind, status, decided_by: by, result };
}

async function performInfraRequest(row, by) {
  try {
    if (row.kind === 'bootstrap') {
      const machineId = row.payload?.machine_id;
      if (!machineId) return { ok: false, error: 'the bootstrap card carries no machine_id' };
      const r = await performBuildBootstrap(row.project_id, machineId, { dryRun: false, actor: by });
      return { ok: r.status !== 'refused' && r.status !== 'failed', ...r };
    }
    if (row.kind === 'propose') {
      const patch = row.payload?.change;
      if (!patch) return { ok: false, error: 'the propose card carries no change' };
      const r = await applySettingsPatch(row.project_id, patch, by);
      return { ok: true, ...r };
    }
    return { ok: false, error: `no performer for infra request kind '${row.kind}'` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
