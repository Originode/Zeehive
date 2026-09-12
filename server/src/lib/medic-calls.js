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
//     fleet.medic_emergency (source 'called') and a human dispatches. NOTHING auto-spawns a medic —
//     that is the DEFAULT, project-scoped, and unchanged.
//   • OPERATOR POLICY (255): a project may opt IN to auto_dispatch_medic, and then a RAISED call is
//     dispatched for it instead of parking for a human. The policy goes through the SAME seam a
//     human's ⛑ click uses (dispatchMedicCall below) so it can never reach further than the click:
//     same refusals, same no-live-medic re-dispatch rule, and it parks the call as OPEN on an
//     API-only instance where the click is refused with 503. The calling zee is TOLD a policy did it.
//   • ONE LIVE CALL PER XELL is the rate limit: a partial unique index keeps a single 'open'/
//     'attended' row per xell, and a second call UPDATES that row instead of inserting.
//   • THE PATIENT IS GONE when its xell retires: the call is WITHDRAWN with a stated reason
//     (withdrawMedicCallsForRetiredXell, driven by the reaper; migration 256 backfilled the rows that
//     predate it) rather than being filtered out of the ⛑ feed and lost without a receipt.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { broadcast } from './events.js';
import { config } from '../config.js';
// The INFRA card marker, imported from proof-routing.js — the ONE source of truth for what a
// provision fault card looks like. collectCallEvidence folds in ONLY cards carrying this marker;
// the project_conditions list on a live project also carries general impediments (grok auth, an
// a2a boundary, an address…), and those are NOT infra evidence a medic should be briefed with.
import { INFRA_MARK } from './proof-routing.js';

export const MEDIC_CALL_KINDS = ['db', 'build', 'provision', 'network', 'other'];
export const MEDIC_CALL_STATUSES = ['open', 'attended', 'resolved', 'declined', 'withdrawn'];
// The reason stamped on a call whose patient is gone (migration 256). ONE string, used by the
// reaper's automatic withdrawal AND quoted verbatim by the backfill migration — a receipt only means
// something if the two say the same thing. Kept here (not in the migration, which cannot import)
// because this is the code path a live retirement takes; the migration text must match.
export const RETIRED_PATIENT_WITHDRAWAL_REASON =
  'withdrawn automatically: the patient is gone — its xell retired, so no medic can attend this call. '
  + 'The fault, if it still exists, belongs to a fresh xell with a fresh call.';
// A medic that is ATTENDING a project — the attach target. Terminal medic statuses mean the project
// has no live medic, so a call must RAISE rather than attach to a corpse. Exported so the dispatch
// route and the tools read the SAME live-set: a call whose medic is no longer live is dispatchable
// again, never stranded behind an errored/retired medic (SHOULD-5).
export const MEDIC_LIVE_STATUSES = ['diagnosing', 'acting', 'awaiting-human', 'worker-dispatched'];

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
    [projectId, MEDIC_LIVE_STATUSES]);
}

// ── the text the medic receives ─────────────────────────────────────────────────────────────────
// ATTACH: the medic is already warm (same medic, same project) — the message is the call verbatim
// plus the evidence, so it re-engages with the zee's actual words rather than the original card.
export function buildCallAttachMessage(call, xellSlug = null) {
  const lines = [`A BLOCKED ZEE CALLED FOR YOU on ${xellSlug || 'this project'} (${call.kind}).`,
                 `Call id: ${call.id}`,
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
                 `Call id: ${call.id}`,
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

// ── THE DISPATCH SEAM — ONE path for a human's ⛑ click AND the auto_dispatch_medic policy ────────
// POST /medic-calls/:callId/dispatch (the console) and raiseMedicCall's policy branch both come
// through HERE, so the refusals are identical and the policy cannot reach further than a click.
// The caller maps a refusal's `status` onto its HTTP answer; the policy just leaves the call OPEN
// for a human. Callers pass the row read by readMedicCall (it carries medic_status + xell_slug);
// the policy branch (which holds the xell row, not a readMedicCall join) passes xellSlug instead,
// so the medic's brief names the calling xell either way.
export async function dispatchMedicCall(call, { by = 'human@console', xellSlug = null } = {}) {
  if (!call) return { ok: false, refused: true, status: 404, reason: 'no such medic call' };
  const medicLive = call.medic_status && MEDIC_LIVE_STATUSES.includes(call.medic_status);
  if (call.status === 'attended' && medicLive) {
    return { ok: false, refused: true, status: 400,
             reason: 'this call is already attended — the medic is in the Bay' };
  }
  if (!['open', 'attended'].includes(call.status)) {
    return { ok: false, refused: true, status: 400,
             reason: `this call is ${call.status} — only an OPEN call (or an attended call whose `
               + 'medic is no longer LIVE) can be dispatched' };
  }
  // An ATTENDED call whose medic is no longer LIVE is dispatchable again — a failed attach-resume
  // leaves the call 'attended' against an errored medic, and that must not strand the emergency
  // (SHOULD-5). The UPDATE below re-links the call to the fresh medic and keeps status 'attended'.
  const { dispatchMedic } = await import('../queenzee/medic-spawn.js');
  const task = buildCallDispatchBrief(call, xellSlug || call.xell_slug);
  const out = await dispatchMedic({ targetProjectId: call.project_id, task });
  const updated = await one(
    `UPDATE medic_call SET medic_id=$2, status='attended', updated_at=now() WHERE id=$1 RETURNING *`,
    [call.id, out.medic_id]);
  broadcast('medic-call', updated);
  return { ok: true, ...out, call_id: call.id, call: updated, dispatched_by: by };
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

  // The live medic attending THIS project, if any.
  const medic = await liveMedicForProject(xell.project_id);

  // ATTACH — a live medic is attending the project. ONE LIVE CALL PER XELL is the rate limit and it
  // is the partial unique index (xell_id WHERE status IN ('open','attended')), so the write is an
  // INSERT … ON CONFLICT DO UPDATE — idempotent against a concurrent raise that got there first
  // (SHOULD-3). There is deliberately no read-then-write race here: the index IS the lock.
  if (medic) {
    const call = await one(
      `INSERT INTO medic_call (project_id, xell_id, zee_id, kind, reason, evidence, status, medic_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'attended',$7)
       ON CONFLICT (xell_id) WHERE status IN ('open','attended')
       DO UPDATE SET kind=EXCLUDED.kind, reason=EXCLUDED.reason, evidence=EXCLUDED.evidence,
                     status='attended', medic_id=EXCLUDED.medic_id, zee_id=EXCLUDED.zee_id,
                     resolution=NULL, updated_at=now()
       RETURNING *`,
      [xell.project_id, xell.id, zid, k, why.slice(0, 20000), JSON.stringify(evidence), medic.id]);
    broadcast('medic-call', call);
    logline('medic-call', `${xell.slug}: medic call ${String(call.id).slice(0, 8)} ATTACHED to medic ${String(medic.id).slice(0, 8)}`);
    // Resume that medic with the call verbatim + evidence, in the background. The driver owns the
    // medic turn; an attach error lands on the medic row ('errored') like any resume failure. The
    // call is re-dispatchable if that happens — the dispatch route treats an attended call whose
    // medic is no longer LIVE as open again (SHOULD-5).
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

  // RAISE — no live medic. A stale 'attended' row whose medic is gone is re-raised (back to open,
  // medic cleared) by the same ON CONFLICT DO UPDATE; a concurrent raise on an already-open row
  // UPDATES it in place instead of racing the partial index.
  const call = await one(
    `INSERT INTO medic_call (project_id, xell_id, zee_id, kind, reason, evidence, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'open')
     ON CONFLICT (xell_id) WHERE status IN ('open','attended')
     DO UPDATE SET kind=EXCLUDED.kind, reason=EXCLUDED.reason, evidence=EXCLUDED.evidence,
                   status='open', medic_id=NULL, zee_id=EXCLUDED.zee_id,
                   resolution=NULL, updated_at=now()
     RETURNING *`,
    [xell.project_id, xell.id, zid, k, why.slice(0, 20000), JSON.stringify(evidence)]);
  broadcast('medic-call', call);
  logline('medic-call', `${xell.slug}: medic call ${String(call.id).slice(0, 8)} RAISED/RE-RAISED (open)`);

  // OPERATOR POLICY (255): the project opted IN to auto_dispatch_medic — dispatch the call through
  // the SAME seam a human's click uses, instead of parking it for a human. The config guard is the
  // lib-level mirror of the route's requireQueenzeeLoops: an API-only instance refuses the click, so
  // the policy must not drive a spawn there either — the call parks OPEN, exactly as it does today.
  const project = await one(`SELECT auto_dispatch_medic FROM project WHERE id=$1`, [xell.project_id]);
  if (project?.auto_dispatch_medic) {
    if (!config.queenzeeInproc) {
      logline('medic-call', `${xell.slug}: auto_dispatch_medic is ON but this is an API-only instance `
        + `(QUEENZEE_INPROC=false) — call ${String(call.id).slice(0, 8)} parks OPEN for a human`);
    } else {
      const out = await dispatchMedicCall(call, { by: 'auto-dispatch@policy', xellSlug: xell.slug });
      if (out.ok) {
        logline('medic-call', `${xell.slug}: medic call ${String(call.id).slice(0, 8)} AUTO-DISPATCHED `
          + `to medic ${String(out.medic_id).slice(0, 8)} — auto_dispatch_medic policy (no human click)`);
        return {
          ok: true, routed: 'auto-dispatched', call_id: call.id, medic_id: out.medic_id,
          evidence: evidence.length,
          message: 'Your medic call is on record, and this project\'s auto_dispatch_medic policy '
            + `dispatched a medic to it automatically (medic ${String(out.medic_id).slice(0, 8)}) — no `
            + 'human click was needed. Watch the Medic Bay; its answer will arrive in your inbox. '
            + adviceForEvidence(evidence),
        };
      }
      // The seam refused (e.g. a concurrent raise already attended it) — fall through to the honest
      // RAISED answer rather than claim a dispatch that did not happen.
      logline('medic-call', `${xell.slug}: auto_dispatch_medic dispatch refused for call `
        + `${String(call.id).slice(0, 8)} (${out.reason}) — parked OPEN for a human`);
    }
  }
  return {
    ok: true, routed: 'raised', call_id: call.id, evidence: evidence.length,
    message: 'Your medic call is on record. No live medic is attending this project, so it now shows '
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

// ── THE PATIENT IS GONE — a retired xell's live calls are WITHDRAWN, never silently dropped ──────
// The fleet's CALLED fold-in (fleet.js) and listProjectMedicCalls both EXCLUDE a retired xell: a dead
// xell cannot be blocked, so its row must stop nagging the ⛑ bar. That exclusion was also where a
// call VANISHED — a zee called, its xell was reaped, and the open row sat in the table out of every
// feed with no receipt and no resolution. This makes the disappearance EXPLICIT: at the moment the
// reaper retires a xell (reaper.js), every live call it raised is set 'withdrawn' with the reason
// above, so the history says WHY it stopped being an emergency. `medic_call` stays on the medic's
// NO-WRITE wall — this is the queenzee's own bookkeeping, not a medic action.
//
// Best-effort by contract: a failure here must never sink a reap. The caller logs and moves on; the
// migration backfills anything this path missed.
export async function withdrawMedicCallsForRetiredXell(xellId, {
  reason = RETIRED_PATIENT_WITHDRAWAL_REASON,
} = {}) {
  const rows = await q(
    `UPDATE medic_call SET status='withdrawn', resolution=$2, updated_at=now()
      WHERE xell_id=$1 AND status IN ('open','attended') RETURNING *`,
    [xellId, reason]);
  for (const row of rows) {
    broadcast('medic-call', row);
    logline('medic-call', `xell ${xellId}: medic call ${String(row.id).slice(0, 8)} WITHDRAWN — patient retired`);
  }
  return rows;
}

// List the calls the MEDIC BAY and fleet read: a project's OPEN calls (awaiting a human dispatch),
// plus ATTENDED calls whose medic is no longer live (the emergency stays visible). Resolved/declined/
// withdrawn calls are history and do not nag.
export async function listProjectMedicCalls(projectId, { liveOnly = true } = {}) {
  if (liveOnly) {
    // The live-only EMERGENCY feed: OPEN calls (awaiting a human dispatch) plus ATTENDED calls whose
    // medic is no longer LIVE (the emergency is real again). A retired/tearing-down/ready xell's stale
    // CALLED row is NOT an emergency (a dead xell cannot be blocked) — it is filtered here so it stops
    // nagging the ⛑ bar (SHOULD-4). The live-status set is bound from MEDIC_LIVE_STATUSES, the SAME
    // one source the dispatch route and the attach path read.
    return q(
      `SELECT mc.*, x.slug AS xell_slug, z.name AS zee_name, m.status AS medic_status
         FROM medic_call mc
         JOIN xell x ON x.id = mc.xell_id
         LEFT JOIN zee z ON z.id = mc.zee_id
         LEFT JOIN medic m ON m.id = mc.medic_id
        WHERE mc.project_id=$1
          AND x.status NOT IN ('ready','retired','tearing-down')
          AND (mc.status='open'
               OR (mc.status='attended' AND (mc.medic_id IS NULL OR m.status IS NULL
                                             OR NOT (m.status = ANY($2::text[])))))
        ORDER BY mc.created_at DESC`, [projectId, MEDIC_LIVE_STATUSES]);
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

  await deliverCallDecision(call, d, text, {
    fromSlug: `⛑medic:${String(medic.id).slice(0, 8)}`,
    by: `⛑medic:${String(medic.id).slice(0, 8)}`,
  });
  return { ok: true, call_id: call.id, status: d };
}

// ── the HUMAN declines a CALLED emergency (console Dismiss) ─────────────────────────────────────
// A third actor beside the medic's own answer and the zee's own retraction: the human who was asked
// to dispatch a medic says NO. It is a DECLINE, not a hide — a live zee is waiting on the answer, so
// the note is REQUIRED (it is what the calling zee receives, exactly the answerMedicCall contract)
// and is POSTED BACK to the calling zee as a zee_message. The row is final history like any decline;
// a still-blocked zee raises a FRESH call.
export async function dismissMedicCall({ callId = null, note = null, by = 'human@console' } = {}) {
  const text = String(note || '').trim();
  if (!text) {
    return { ok: false, refused: true,
             reason: 'a note is required — it is what the calling zee receives (and a declined call must say why)' };
  }
  const call = await one(
    `SELECT mc.*, x.slug AS xell_slug, m.status AS medic_status
       FROM medic_call mc
       JOIN xell x ON x.id = mc.xell_id
       LEFT JOIN medic m ON m.id = mc.medic_id
      WHERE mc.id=$1`, [callId]);
  if (!call) return { ok: false, refused: true, reason: 'no such medic call' };
  if (call.status === 'declined') return { ok: false, refused: true, reason: 'this call is already declined' };
  if (call.status === 'attended' && call.medic_status && MEDIC_LIVE_STATUSES.includes(call.medic_status)) {
    return { ok: false, refused: true,
             reason: 'this call is already being attended in the Medic Bay — it is not nagging the ⛑ bar' };
  }
  if (!['open', 'attended'].includes(call.status)) {
    return { ok: false, refused: true,
             reason: `this call is ${call.status} — only a live (open/attended) call can be dismissed` };
  }
  const row = await one(
    `UPDATE medic_call SET status='declined', resolution=$2, dismissed_at=now(), dismissed_by=$3, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [call.id, text, String(by).slice(0, 200)]);
  broadcast('medic-call', row);
  logline('medic-call', `human ${by} DECLINED call ${String(call.id).slice(0, 8)} (dismissed)`);

  await deliverCallDecision(call, 'declined', text, { fromSlug: '⛑human', by });
  return { ok: true, call_id: row.id, status: 'declined' };
}

// The note goes BACK to the calling zee as a zee_message (kind 'message' — neither the medic nor a
// human has an xell id, so from.id is null and the slug names the sender). Delivery is best-effort
// like every postMessage. Shared by answerMedicCall (the medic's resolve/decline) and
// dismissMedicCall (the human's decline) so the calling zee reads the SAME shape whoever decided.
async function deliverCallDecision(call, decision, text, { fromSlug = '⛑medic', by = fromSlug } = {}) {
  try {
    const { postMessage } = await import('./managers.js');
    const resolved = decision === 'resolved';
    const body = `${resolved ? '⛑ Your medic call was RESOLVED.' : '⛑ Your medic call was DECLINED.'}\n\n`
      + `${String(text || '').trim()}\n\n`
      + (resolved ? '' : '(A medic fixes ZEEHIVE config/infra. If the fault is in your own code or tests, that is `zee tend`, not a medic.)');
    await postMessage({
      from: { id: null, slug: fromSlug, project_id: call.project_id },
      to: { id: call.xell_id, slug: call.xell_slug, project_id: call.project_id },
      body, by,
    });
  } catch (e) {
    logline('medic-call', `resolution delivery to ${call.xell_slug} failed: ${String(e.message).slice(0, 200)}`);
  }
}
