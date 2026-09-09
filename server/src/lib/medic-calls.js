// MEDIC CALLS — a blocked zee's voice to the ⛑ MEDIC (the patient-voice card). The row model and
// routing policy; the registry tools (medic-tools.js calls/call_answer), the self verb (self.js
// selfMedicCall) and the fleet emergency feed (fleet.js) all read/write through THIS module so the
// routing decision lives in exactly one place.
//
// DECIDED, NOT RE-OPENED here:
//   • `zee medic` is every zee's verb (worker AND manager), opens no gate, blocks nothing.
//   • a call is RECORDED with the xell's own infra evidence. No evidence is still recorded — never
//     refused — but the answer tells the zee plainly that a medic fixes ZEEHIVE config/infra, and a
//     fault in its own code/tests is `zee tend`, not a medic.
//   • ROUTING: if a LIVE medic is attending the project (status NOT retired/converged/errored) the
//     call ATTACHES — linked to that medic (status 'attended') and the medic is resumed with the
//     call verbatim + evidence in the background. If none is, the call RAISES: it becomes an entry in
//     fleet.medic_emergency (source 'called') and a human dispatches. NOTHING auto-spawns a medic.
//   • ONE LIVE CALL PER XELL is the rate limit: a partial unique index keeps a single 'open'/
//     'attended' row per xell, and a second call UPDATES that row instead of inserting.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { broadcast } from './events.js';
// The INFRA card marker, imported from proof-routing.js — the ONE source of truth for what a
// provision fault card looks like. collectCallEvidence folds in ONLY cards carrying this marker;
// the project_conditions list on a live project also carries general impediments (grok auth, an
// a2a boundary, an address…), and those are NOT infra evidence a medic should be briefed with.
import { INFRA_MARK } from './proof-routing.js';

export const MEDIC_CALL_KINDS = ['db', 'build', 'provision', 'network', 'other'];
export const MEDIC_CALL_STATUSES = ['open', 'attended', 'resolved', 'declined', 'withdrawn'];
// A medic that is ATTENDING a project — the attach target. Terminal medic statuses mean the project
// has no live medic, so a call must RAISE rather than attach to a corpse.
const LIVE_MEDIC_STATUSES = ['diagnosing', 'acting', 'awaiting-human', 'worker-dispatched'];

const liveZeeOf = (xellId) => one(
  `SELECT id, name FROM zee WHERE xell_id=$1
     AND status IN ('spawning','online','working','idle') ORDER BY created_at DESC LIMIT 1`, [xellId]);

// The xell's live zee id for the call row (nullable — a call from a moment with no live zee is
// still a call; the xell slug rides on the row and the zee_name is resolved at read time).
export async function liveZeeForCall(xellId) {
  const z = await liveZeeOf(xellId);
  return z?.id || null;
}

// ── EVIDENCE — the SAME three fleet.js trusts, collected server-side at call time ────────────────
// The fleet snapshot decorates xell rows with a resolved `stack`; the raw xell row a token resolves
// to does not have one, so this reads the recorded facts directly: xell.preflight_error,
// xell.proof_error, containers the xell uses whose last_build_error_class='infra', plus any live
// provision-fault card on the project (the condition lines a medic would be briefed with).
export async function collectCallEvidence(xell) {
  const evidence = [];
  // The caller passes the resolved self row; re-read it so the evidence is ALWAYS the current
  // recorded facts even when the caller's object predates the poller's latest UPDATE (the fleet
  // snapshot decorates a fresh read too). Same trusts as fleet.js.
  const row = xell?.id
    ? await one(`SELECT * FROM xell WHERE id=$1`, [xell.id]).catch(() => null) : null;
  const projectId = row?.project_id || xell?.project_id || null;
  if (row?.preflight_error || xell?.preflight_error) {
    evidence.push({ trust: 'db-preflight', label: 'failing db preflight',
                    detail: String(row?.preflight_error || xell?.preflight_error).slice(0, 500) });
  }
  if (row?.proof_error || xell?.proof_error) {
    evidence.push({ trust: 'provision-proof', label: 'failing provision proof',
                    detail: String(row?.proof_error || xell?.proof_error).slice(0, 500) });
  }
  const infra = await q(
    `SELECT c.id, c.role, c.name, c.last_build_error, c.last_build_error_class
       FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id=$1 AND c.last_build_error_class = 'infra'`, [xell?.id || null]);
  for (const c of infra) {
    evidence.push({ trust: 'container-infra',
                    label: `build failed [infra] on ${c.role || c.name}`,
                    detail: String(c.last_build_error || '').split('\n').filter(Boolean).slice(-1)[0]
                             || c.name });
  }
  if (projectId) {
    // Fold in ONLY the FAULT cards — the project_conditions list on a live project is mostly
    // general impediments (grok auth, an a2a boundary, an address…), and those are not infra a
    // medic should be briefed with. proof-routing raises fault cards with INFRA_MARK; matched here
    // in JS (the same fetch-and-match discipline proof-routing uses, so the marker lives once) and
    // capped at the call-time briefing width of 5.
    const rows = await q(
      `SELECT id, body FROM project_condition
        WHERE project_id=$1
        ORDER BY created_at DESC LIMIT 25`, [projectId]);
    const faultCards = rows.filter((r) => INFRA_MARK.test(r.body)).slice(0, 5);
    for (const card of faultCards) {
      evidence.push({ trust: 'condition', label: 'provision fault card',
                      detail: String(card.body).slice(0, 500) });
    }
  }
  return evidence;
}

// ── the LIVE medic attending a project (the attach target), newest first ────────────────────────
export async function liveMedicForProject(projectId) {
  if (!projectId) return null;
  return one(
    `SELECT m.*, p.name AS target_project_name
       FROM medic m JOIN project p ON p.id = m.target_project_id
      WHERE m.target_project_id=$1 AND m.status = ANY($2::text[])
      ORDER BY m.created_at DESC LIMIT 1`,
    [projectId, LIVE_MEDIC_STATUSES]);
}

// ── the text the medic receives ─────────────────────────────────────────────────────────────────
// ATTACH: the medic is already warm (same medic, same project) — the message is the call verbatim
// plus the evidence, so it re-engages with the zee's actual words rather than the original card.
export function buildCallAttachMessage(call, xellSlug = null) {
  const lines = [`A BLOCKED ZEE CALLED FOR YOU on ${xellSlug || 'this project'} (${call.kind}):`,
                 '', String(call.reason || ''), '',
                 'Evidence stamped at call time:',
                 ...formatEvidence(call.evidence),
                 '',
                 'Attend this call, fix the config/infra fault if it is yours, and answer with the '
                 + 'call_answer tool (resolve or decline, with a note) — the note goes back to the '
                 + 'calling zee as a message.'];
  return lines.join('\n');
}

// DISPATCH (a human dispatches from a CALLED emergency — no live medic): the new medic's brief is
// built FROM THE CALL, not from a condition line.
export function buildCallDispatchBrief(call, xellSlug = null) {
  const lines = ['A BLOCKED ZEE CALLED FOR A MEDIC — attend the CALL (not a condition card).',
                 '',
                 `The zee on ${xellSlug || 'this project'} says (kind: ${call.kind}):`,
                 '',
                 `  ${String(call.reason || '').split('\n').join('\n  ')}`,
                 '',
                 'Evidence stamped at call time:',
                 ...formatEvidence(call.evidence),
                 '',
                 'Diagnose it against the meta-DB and fix the TARGET project\'s CONFIG so the fault '
                 + 'stops blocking xells — the fix must hold for the NEXT xell, not one. Read the '
                 + 'evidence first (readiness, settings, meta_select on the exact rows the failing '
                 + 'check names), fix by the narrowest meta_write, re-prove, and answer the call with '
                 + 'call_answer (resolve with your note) — the note goes back to the calling zee as a '
                 + 'message. A fault that is the ZEE\'S OWN code/tests is zee tend, not a medic: say '
                 + 'that plainly and decline the call pointing at `zee tend`.'];
  return lines.join('\n');
}

function formatEvidence(evidence) {
  const arr = Array.isArray(evidence) ? evidence : [];
  if (!arr.length) return ['(no infra evidence recorded — the fault may be the zee\'s own code/tests)'];
  return arr.map((e, i) => `  ${i + 1}. [${e.trust}] ${e.label}: ${String(e.detail || '').slice(0, 300)}`);
}

// ── RAISE (or re-raise): the one routing decision ────────────────────────────────────────────────
export async function raiseMedicCall({ xell, reason = null, kind = 'other', zeeId = null } = {}) {
  if (!xell?.id || !xell?.project_id) throw new Error('a medic call needs a xell');
  const why = String(reason || '').trim();
  if (!why) {
    return { ok: false, error: 'a medic call needs a reason — say WHY you need the medic, in your '
      + 'own words (`zee medic --reason "…"`). The reason is what a human or a live medic reads '
      + 'first; without it the call summons help with no idea what for.' };
  }
  const k = MEDIC_CALL_KINDS.includes(kind) ? kind : 'other';
  const zid = zeeId || await liveZeeForCall(xell.id);
  const evidence = await collectCallEvidence(xell);

  // The live call lane for THIS xell (one per xell — the rate limit).
  const existing = await one(
    `SELECT * FROM medic_call WHERE xell_id=$1 AND status IN ('open','attended')`, [xell.id]);
  // The live medic attending THIS project, if any.
  const medic = await liveMedicForProject(xell.project_id);

  // ATTACH — a live medic is attending the project.
  if (medic) {
    const call = existing
      ? await one(
          `UPDATE medic_call SET kind=$2, reason=$3, evidence=$4::jsonb, status='attended',
                  medic_id=$5, zee_id=$6, resolution=NULL, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [existing.id, k, why.slice(0, 20000), JSON.stringify(evidence), medic.id, zid])
      : await one(
          `INSERT INTO medic_call (project_id, xell_id, zee_id, kind, reason, evidence, status, medic_id)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,'attended',$7) RETURNING *`,
          [xell.project_id, xell.id, zid, k, why.slice(0, 20000), JSON.stringify(evidence), medic.id]);
    broadcast('medic-call', call);
    logline('medic-call', `${xell.slug}: medic call ${String(call.id).slice(0, 8)} ATTACHED to medic ${String(medic.id).slice(0, 8)}`);
    // Resume that medic with the call verbatim + evidence, in the background. The driver owns the
    // medic turn; an attach error lands on the medic row ('errored') like any resume failure.
    const { resumeMedic } = await import('../queenzee/medic-spawn.js');
    const msg = buildCallAttachMessage(call, xell.slug);
    resumeMedic(medic.id, { message: msg }).catch((e) => {
      logline('medic-call', `attach resume failed for medic ${String(medic.id).slice(0, 8)}: ${String(e.message).slice(0, 200)}`);
    });
    return {
      ok: true, routed: 'attached', call_id: call.id, medic_id: medic.id,
      message: 'Your call reached a LIVE medic already attending this project — it was attached to '
        + `medic ${String(medic.id).slice(0, 8)} with your words + evidence, and that medic is now on `
        + 'it. Watch the Medic Bay; its answer will arrive in your inbox.',
    };
  }

  // RAISE — no live medic. A stale 'attended' row whose medic is gone is re-raised (back to open).
  if (existing) {
    const call = await one(
      `UPDATE medic_call SET kind=$2, reason=$3, evidence=$4::jsonb,
              status = CASE WHEN status = 'attended' THEN 'open' ELSE status END,
              medic_id = CASE WHEN status = 'attended' THEN NULL ELSE medic_id END,
              zee_id=$5, resolution=NULL, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [existing.id, k, why.slice(0, 20000), JSON.stringify(evidence), zid]);
    broadcast('medic-call', call);
    logline('medic-call', `${xell.slug}: medic call ${String(call.id).slice(0, 8)} RE-RAISED (open)`);
    return {
      ok: true, routed: 'raised', call_id: call.id, evidence: evidence.length,
      message: `Your medic call is on record (${call.status}). No live medic is attending this `
        + 'project, so it now shows as a CALLED emergency in the console ⛑ — a human dispatches; '
        + 'nothing auto-spawns. ' + adviceForEvidence(evidence),
    };
  }

  const call = await one(
    `INSERT INTO medic_call (project_id, xell_id, zee_id, kind, reason, evidence)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [xell.project_id, xell.id, zid, k, why.slice(0, 20000), JSON.stringify(evidence)]);
  broadcast('medic-call', call);
  logline('medic-call', `${xell.slug}: medic call ${String(call.id).slice(0, 8)} RAISED (${k})`);
  return {
    ok: true, routed: 'raised', call_id: call.id, evidence: evidence.length,
    message: 'Your medic call is recorded. No live medic is attending this project, so it now shows '
      + 'as a CALLED emergency in the console ⛑ naming your zee — a human dispatches a medic from '
      + 'the call; NOTHING auto-spawns. ' + adviceForEvidence(evidence),
  };
}

function adviceForEvidence(evidence) {
  if (Array.isArray(evidence) && evidence.length > 0) return 'Your call carried the infra evidence found on this xell.';
  return 'No infra evidence was found on this xell — a medic fixes ZEEHIVE config/infra; a fault in '
    + 'your OWN code or tests is `zee tend`, not a medic. The human dispatching from your call will '
    + 'see the same empty evidence line.';
}

// ── READ / WITHDRAW / ANSWER ────────────────────────────────────────────────────────────────────
export async function readMedicCallForXell(xellId) {
  return one(`SELECT mc.*, x.slug AS xell_slug, z.name AS zee_name, m.status AS medic_status
                FROM medic_call mc
                JOIN xell x ON x.id = mc.xell_id
                LEFT JOIN zee z ON z.id = mc.zee_id
                LEFT JOIN medic m ON m.id = mc.medic_id
               WHERE mc.xell_id=$1
               ORDER BY mc.created_at DESC LIMIT 1`, [xellId]);
}

export async function readMedicCall(id) {
  return one(`SELECT mc.*, x.slug AS xell_slug, z.name AS zee_name, m.status AS medic_status,
                     m.target_project_name
                FROM medic_call mc
                JOIN xell x ON x.id = mc.xell_id
                LEFT JOIN zee z ON z.id = mc.zee_id
                LEFT JOIN (SELECT medic.id, medic.status, p.name AS target_project_name
                             FROM medic JOIN project p ON p.id = medic.target_project_id) m
                  ON m.id = mc.medic_id
               WHERE mc.id=$1`, [id]);
}

export async function withdrawMedicCall(xellId, { by = null } = {}) {
  const row = await one(
    `UPDATE medic_call SET status='withdrawn', resolution=$2, updated_at=now()
      WHERE xell_id=$1 AND status IN ('open','attended') RETURNING *`,
    [xellId, by ? `withdrawn by ${by}` : null]);
  if (row) {
    broadcast('medic-call', row);
    logline('medic-call', `xell ${xellId}: medic call ${String(row.id).slice(0, 8)} WITHDRAWN`);
  }
  return row;
}

// List the calls the MEDIC BAY and fleet read: a project's OPEN calls (awaiting a human dispatch),
// plus ATTENDED calls whose medic is no longer live (the emergency stays visible). Resolved/declined/
// withdrawn calls are history and do not nag.
export async function listProjectMedicCalls(projectId, { liveOnly = true } = {}) {
  if (liveOnly) {
    return q(
      `SELECT mc.*, x.slug AS xell_slug, z.name AS zee_name, m.status AS medic_status
         FROM medic_call mc
         JOIN xell x ON x.id = mc.xell_id
         LEFT JOIN zee z ON z.id = mc.zee_id
         LEFT JOIN medic m ON m.id = mc.medic_id
        WHERE mc.project_id=$1
          AND (mc.status='open'
               OR (mc.status='attended' AND (mc.medic_id IS NULL OR m.status IS NULL
                                             OR m.status NOT IN ('diagnosing','acting','awaiting-human','worker-dispatched'))))
        ORDER BY mc.created_at DESC`, [projectId]);
  }
  return q(
    `SELECT mc.*, x.slug AS xell_slug, z.name AS zee_name, m.status AS medic_status
       FROM medic_call mc
       JOIN xell x ON x.id = mc.xell_id
       LEFT JOIN zee z ON z.id = mc.zee_id
       LEFT JOIN medic m ON m.id = mc.medic_id
      WHERE mc.project_id=$1
      ORDER BY mc.created_at DESC`, [projectId]);
}

// A medic's OWN attended calls — what the Bay's medic panel lists.
export async function listMedicAttendedCalls(medicId) {
  return q(
    `SELECT mc.*, x.slug AS xell_slug, z.name AS zee_name
       FROM medic_call mc
       JOIN xell x ON x.id = mc.xell_id
       LEFT JOIN zee z ON z.id = mc.zee_id
      WHERE mc.medic_id=$1 AND mc.status IN ('open','attended')
      ORDER BY mc.created_at DESC`, [medicId]);
}

// ── the medic ANSWERS a call it is attending (medic-tools call_answer) ──────────────────────────
// Scoped to the medic's OWN attended call; the resolution note is POSTED back to the calling xell as
// a zee_message — the same delivery managers.js uses for `zee say` — so the answer arrives in the
// calling zee's inbox (and its live session when it is up).
export async function answerMedicCall({ medic, callId, decision = 'resolved', note = null } = {}) {
  if (!medic?.id) throw new Error('a medic call answer needs the medic ROW');
  const d = String(decision || '').trim();
  if (!['resolved', 'declined'].includes(d)) {
    return { ok: false, refused: true, reason: 'call_answer decision must be "resolved" or "declined"' };
  }
  const text = String(note || '').trim();
  if (!text) {
    return { ok: false, refused: true, reason: 'a note is required — it is what the calling zee receives (and a declined call must say why)' };
  }
  const call = await one(
    `SELECT mc.*, x.slug AS xell_slug FROM medic_call mc JOIN xell x ON x.id = mc.xell_id
      WHERE mc.id=$1 AND mc.medic_id=$2 AND mc.status='attended'`, [callId, medic.id]);
  if (!call) {
    return { ok: false, refused: true,
             reason: 'no ATTENDED medic call with that id is yours to answer (call_answer is scoped to the calls this medic is attending)' };
  }
  const row = await one(
    `UPDATE medic_call SET status=$2, resolution=$3, updated_at=now() WHERE id=$1 RETURNING *`,
    [call.id, d, text]);
  broadcast('medic-call', row);
  logline('medic-call', `medic ${String(medic.id).slice(0, 8)} ${d} call ${String(call.id).slice(0, 8)}`);

  // The note goes BACK to the calling zee as a zee_message (kind 'message' — the medic has no xell
  // id, so from.id is null and the slug names it). Delivery is best-effort like every postMessage.
  try {
    const { postMessage } = await import('./managers.js');
    const note = `${d === 'resolved'
      ? `⛑ Your medic call was RESOLVED.`
      : `⛑ Your medic call was DECLINED.`}\n\n${text}\n\n`
      + (d === 'declined'
        ? '(A medic fixes ZEEHIVE config/infra. If the fault is in your own code or tests, that is `zee tend`, not a medic.)'
        : '');
    await postMessage({
      from: { id: null, slug: `⛑medic:${String(medic.id).slice(0, 8)}`, project_id: call.project_id },
      to: { id: call.xell_id, slug: call.xell_slug, project_id: call.project_id },
      body: note, by: `⛑medic:${String(medic.id).slice(0, 8)}`,
    });
  } catch (e) {
    logline('medic-call', `answer delivery to ${call.xell_slug} failed: ${String(e.message).slice(0, 200)}`);
  }
  return { ok: true, call_id: call.id, status: d };
}
