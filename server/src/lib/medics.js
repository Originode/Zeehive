// MEDIC ROWS — the meta-plane medic's row model (docs/medic-meta-plane-plan.md, DR-7; provision-proof
// kit stage 4). A medic is an agent with NO environment: a `medic` row anchors it, a zee row (245:
// zee.medic_id) carries its running turn, and queenzee/medic-spawn.js drives the loop. This module
// is the row half: create / status / retire / list / detail, the gateway identity token, the audit
// ledger writer, and the dispatch brief + system prompt the driver composes from.
//
// Every write here runs on the OWNER pool — deliberately. These are the DRIVER'S facts about a
// medic (status, audit, token hash); the medic's own role (medic-role.js) holds no grant on any of
// these tables, so the loop cannot reach back and edit its own record.
import { randomBytes } from 'node:crypto';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { broadcast } from './events.js';
import { hashToken } from './xell-token.js';

export const MEDIC_STATUSES = ['diagnosing', 'acting', 'awaiting-human', 'worker-dispatched',
  'converged', 'retired', 'errored'];

// ── identity ─────────────────────────────────────────────────────────────────────────────────────
// Same hash-only discipline as xell.self_token_hash (lib/xell-token.js): the plaintext exists only
// in the driver's memory for the duration of the loop; the gateway resolves the hash.
export async function mintMedicToken(medicId) {
  const token = randomBytes(32).toString('hex');
  await one(`UPDATE medic SET token_hash=$2 WHERE id=$1 RETURNING id`, [medicId, hashToken(token)]);
  return token;
}

export async function medicForToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return one(`SELECT * FROM medic WHERE token_hash=$1`, [hashToken(t)]);
}

// The gateway/ledger SUBJECT for a medic — the xell-shaped object gatewayProxy and recordRequest
// pass around. id stays null (llm_gateway_request.xell_id is an FK to xell); medic_id is what
// recordRequest resolves the live zee + open turn from.
export function medicSubject(medic) {
  if (!medic) return null;
  return { id: null, medic_id: medic.id, project_id: medic.target_project_id,
           slug: `medic:${String(medic.id).slice(0, 8)}` };
}

// ── lifecycle ────────────────────────────────────────────────────────────────────────────────────
export async function createMedic({ targetProjectId, conditionId = null, brief }) {
  const row = await one(
    `INSERT INTO medic (target_project_id, condition_id, brief) VALUES ($1,$2,$3) RETURNING *`,
    [targetProjectId, conditionId, String(brief || '').trim()]);
  broadcast('medic', row);
  logline('medic', `medic ${String(row.id).slice(0, 8)} attending project ${targetProjectId}`);
  return row;
}

export async function updateMedicStatus(medicId, status, { needsHumanReason = null } = {}) {
  if (!MEDIC_STATUSES.includes(status)) throw new Error(`unknown medic status "${status}"`);
  const row = await one(
    `UPDATE medic SET status=$2,
            needs_human_reason = CASE WHEN $2 = 'awaiting-human' THEN $3 ELSE NULL END,
            retired_at = CASE WHEN $2 = 'retired' THEN now() ELSE retired_at END
      WHERE id=$1 RETURNING *`, [medicId, status, needsHumanReason]);
  if (row) broadcast('medic', row);
  return row;
}

// Retire keeps the row — the medic_action ledger must outlive the loop (the Bay is the receipt).
export async function retireMedic(medicId, { by = 'human@console' } = {}) {
  const row = await updateMedicStatus(medicId, 'retired');
  if (row) logline('medic', `medic ${String(medicId).slice(0, 8)} retired by ${by}`);
  return row;
}

// ── the read model (the Medic Bay's feed) ────────────────────────────────────────────────────────
export async function listMedics({ includeRetired = false } = {}) {
  return q(
    `SELECT m.*, p.name AS target_project_name,
            z.id AS zee_id, z.status AS zee_status, z.cost_usd, z.last_stop_reason
       FROM medic m
       JOIN project p ON p.id = m.target_project_id
       LEFT JOIN LATERAL (SELECT * FROM zee WHERE medic_id = m.id
                           ORDER BY created_at DESC LIMIT 1) z ON true
      ${includeRetired ? '' : `WHERE m.status <> 'retired'`}
      ORDER BY m.created_at DESC`);
}

export async function medicDetail(medicId) {
  const medic = await one(
    `SELECT m.*, p.name AS target_project_name FROM medic m
       JOIN project p ON p.id = m.target_project_id WHERE m.id=$1`, [medicId]);
  if (!medic) return null;
  const actions = await q(
    `SELECT id, tool, statement, tables, rows_affected, result, created_at
       FROM medic_action WHERE medic_id=$1 ORDER BY created_at`, [medicId]);
  const transcript = await q(
    `SELECT seq, role, content, name, created_at FROM zee_conversation
      WHERE medic_id=$1 ORDER BY seq`, [medicId]);
  const cards = await q(
    `SELECT id, kind, status, reason, requested_at, decided_at, decided_by
       FROM infra_request WHERE project_id=$1 AND status IN ('pending','approved')
      ORDER BY requested_at DESC`, [medic.target_project_id]);
  // Workers this medic dispatched — each links to a REAL hexagon in the honeycomb.
  const workers = await q(
    `SELECT w.id, w.title, w.status, w.xell_id, x.slug AS xell_slug
       FROM work_item w LEFT JOIN xell x ON x.id = w.xell_id
      WHERE w.created_by = $1 ORDER BY w.created_at DESC`, [`medic:${String(medicId).slice(0, 8)}`]);
  return { medic, actions, transcript, cards, workers };
}

// ── the audit ledger (OWNER pool — see the header) ───────────────────────────────────────────────
// Written BEFORE the audited act runs (medic-tools.js), so a refused/failed write still leaves its
// row; the result lands in a follow-up UPDATE. Best-effort NEVER: an audit that cannot be written
// REFUSES the act — an unrecorded config write is the one thing this design must not produce.
export async function recordMedicAction(medicId, { tool, statement, tables = [] }) {
  const row = await one(
    `INSERT INTO medic_action (medic_id, tool, statement, tables) VALUES ($1,$2,$3,$4) RETURNING id`,
    [medicId, tool, String(statement).slice(0, 20000), tables]);
  return row.id;
}

export async function finishMedicAction(actionId, { rowsAffected = null, result = null } = {}) {
  await q(`UPDATE medic_action SET rows_affected=$2, result=$3::jsonb WHERE id=$1`,
    [actionId, rowsAffected, result == null ? null : JSON.stringify(result)]);
  broadcast('medic-action', { id: actionId });
}

// ── the brief + system prompt the driver composes ────────────────────────────────────────────────
// The brief is the TASK (turn 1's user message); the system prompt is the harness bundle — the
// row stays the authoring surface (house rule 10) even though nothing wears it in a cage. Only the
// infra-medic row's OWN memory entries are included: its ancestors' manuals (the manager law, the
// cxell manual) teach zee-CLI verbs a meta-plane loop does not have, and briefing an agent with
// verbs it cannot call is how it wastes its turn asking for them.
export function buildMedicPlaneBrief(cond) {
  const card = String(cond?.body || '').trim()
    || '(the card body was empty — start from the `readiness` tool on the target project)';
  const targetName = cond?.project_name || cond?.project_id || null;
  const targetLine = targetName
    ? `The card is about project '${targetName}'` + (cond?.project_name && cond?.project_id ? ` (id ${cond.project_id})` : '') + '.'
    : 'The card is about a project that cannot build.';
  return `A PROVISION-INFRA card is up: a project-level provisioning fault that stops xells from
building or provisioning. ${targetLine}

The card:

  ${card}

Diagnose it against the meta-DB and fix the TARGET project's CONFIG so the machine×project pair
proves green again — the fix must hold for the NEXT xell, not one. Your manual (your system
prompt) names your tools and their walls. Read the evidence first (readiness, settings,
meta_select on the exact rows the failing check names), fix by the narrowest meta_write, re-prove,
delete the condition line your fix made false, and report converged — or need_human with the
one-line ask when the lever is not yours.`;
}

export async function composeMedicSystemPrompt() {
  const { effectiveHarness } = await import('./harness.js');
  const row = await one(`SELECT * FROM harness WHERE key='infra-medic'`);
  if (!row) {
    // A database that never ran 238 still gets a working medic: the 246 runbook text is the law and
    // it lives in the migration; this fallback is only the identity line.
    return 'You are the Infra Medic — a META-PLANE resident agent loop. Your tools are your whole reach.';
  }
  const eff = await effectiveHarness(row);
  const ownMemory = (eff?.memory || []).filter((m) => m.from === 'infra-medic');
  const parts = [];
  if (eff?.personality) parts.push(eff.personality);
  for (const m of ownMemory) parts.push(m.text);
  const text = parts.join('\n\n---\n\n');
  return text.slice(0, 48000) || 'You are the Infra Medic — a META-PLANE resident agent loop.';
}
