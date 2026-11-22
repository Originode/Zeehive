// MEDIC DISMISSALS — a HUMAN says NO to a ⛑ medic dispatch ask that has NO row to decline.
//
// The ⛑ needs-you panel asks a human to dispatch the medic for three kinds of emergency:
//   • CALLED  (medic_call rows — dismissed by DECLINING the call, see dismissMedicCall in
//              medic-calls.js);
//   • INFRA   (derived live in fleet.js from a failing db preflight / failing provision proof / an
//              INFRA-classed build failure — NO row behind them);
//   • CONDITION dispatch cards (a project_condition line the medic could be briefed with).
//
// The rowless two are recomputed from live evidence every fleet snapshot, so a dismissal cannot
// just hide a row — it must survive recomputation AND expire by itself when the fault stops being
// the same fault. This module persists that dismissal as a fingerprint of the EXACT text the human
// was shown: the same text stays hidden; a different fault on the same xell (or an edited condition
// body) no longer matches the fingerprint and raises again. No timers — the fingerprint IS the
// expiry.
//
// Routes (routes.js) carry the same partial worker wall as the dispatch seams: an identified worker
// cannot dismiss (workers do not dismiss); only the console / queenzee owner pool can. The medic
// role gets NO write here (medic-role.js MEDIC_NO_WRITE_TABLES) — this is a HUMAN's verb.
import { createHash } from 'node:crypto';
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';

// sha256 hex of the exact text the human was shown. Trimmed so a trailing newline (or a paste with
// one) does not silently expire a dismissal, but otherwise byte-exact: a single changed character
// in a fault message re-raises it.
export function fingerprintMedicText(text) {
  return createHash('sha256').update(String(text || '').trim()).digest('hex');
}

// Create (or refresh) a fingerprinted dismissal. The `text` is the exact shown string — the caller
// passes what the human actually saw (the infra row's `why`, the condition's body), never a
// re-derived current fact, so a fault that changes between the snapshot and the click does not
// dismiss a NEW fault the human never looked at. The project is derived from the target row, never
// taken from the caller, so one xell cannot dismiss another project's ask.
export async function createMedicDismissal({ targetKind = null, targetId = null, text = null,
                                             reason = null, by = 'human@console' } = {}) {
  const kind = String(targetKind || '').trim();
  if (!['xell', 'condition'].includes(kind)) {
    return { ok: false, refused: true, reason: 'target_kind must be "xell" or "condition"' };
  }
  if (!targetId) {
    return { ok: false, refused: true, reason: 'target_id is required — which xell / condition line is being dismissed?' };
  }
  const shown = String(text || '').trim();
  if (!shown) {
    return { ok: false, refused: true, reason: 'the shown text is required — the dismissal is fingerprinted on exactly what the human saw' };
  }
  // Derive the project from the target row (never trust a caller-supplied project_id for a write
  // that hides an emergency on the owner pool).
  const projectId = kind === 'xell'
    ? (await one(`SELECT project_id FROM xell WHERE id=$1`, [targetId]))?.project_id
    : (await one(`SELECT project_id FROM project_condition WHERE id=$1`, [targetId]))?.project_id;
  if (!projectId) {
    return { ok: false, refused: true, reason: `no ${kind} with id ${targetId}` };
  }
  const fingerprint = fingerprintMedicText(shown);
  const row = await one(
    `INSERT INTO medic_dismissal (project_id, target_kind, target_id, fingerprint, display, reason, dismissed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (project_id, target_kind, target_id, fingerprint)
     DO UPDATE SET reason=EXCLUDED.reason, dismissed_by=EXCLUDED.dismissed_by, dismissed_at=now()
     RETURNING *`,
    [projectId, kind, targetId, fingerprint, shown.slice(0, 500),
     String(reason || '').trim().slice(0, 1000) || null, by]);
  logline('medic-call', `human ${by} DISMISSED ${kind} ${String(targetId).slice(0, 8)} (fingerprint ${fingerprint.slice(0, 8)}…)`);
  return { ok: true, dismissed: row };
}

// UNDO: delete a dismissal row so the emergency it was hiding raises again. Scoped by the row's own
// project (the caller cannot name another project's id).
export async function undoMedicDismissal(id) {
  const row = await one(`DELETE FROM medic_dismissal WHERE id=$1 RETURNING *`, [id]);
  if (row) logline('medic-call', `human UNDID dismissal ${String(row.id).slice(0, 8)} (${row.target_kind} ${String(row.target_id).slice(0, 8)})`);
  return row || null;
}

// The project's dismissal rows, newest first — the console's "N dismissed · UNDO" feed. The fleet
// snapshot enriches each with whether it is ACTIVE (currently suppressing a would-be emergency) so
// the muted line does not list receipts that stopped meaning anything.
export async function listMedicDismissals(projectId) {
  if (!projectId) return [];
  return q(`SELECT * FROM medic_dismissal WHERE project_id=$1 ORDER BY dismissed_at DESC`, [projectId]);
}
