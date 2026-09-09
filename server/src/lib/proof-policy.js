// READINESS PROOF — the per-project knob and the binding-change re-preflight
// (stage 2, docs/provision-proof-kit/stage-2-gates.md §4.5).
//
// pool_config.readiness_proof is the human's per-project decision (plan DR-3): 'off' | 'advisory' |
// 'required'. Nothing here ever SETS it — a migration's NOT NULL DEFAULT 'advisory' and a future
// console write path own that. This module READS it (house rule 7: the knob is DATA, resolved live,
// never restated in a doc) and applies the one §4.5 rule it gates: after ANY db binding change, the
// pure preflight is re-run on the NEW DSN before the zee spawns, bounded by the existing
// PREFLIGHT_TIMEOUT_MS, and a failure under 'required' is a dispatch REFUSAL — not a fall-through
// into a xell whose database the zee will discover is dead in its first turn (the #47/TKT-181 class
// at the moment it actually occurs, not at provision time when the binding was different).
import { one } from '../db/pool.js';
import { runPreflight, PREFLIGHT_TIMEOUT_MS } from './preflight.js';
import { conditionDate } from './current-conditions.js';

// migration 236's NOT NULL DEFAULT — the fallback for a project with NO pool_config row.
export const READINESS_PROOF_DEFAULT = 'advisory';

// The project's knob, resolved live. A NULL row (never onboarded a policy — every raw test project)
// reads as the DEFAULT advisory, exactly as the migration's column default intends: only a row that
// SAYS 'required' changes behaviour, so a project that never opted in keeps today's semantics.
export async function projectReadinessProof(projectId) {
  if (!projectId) return READINESS_PROOF_DEFAULT;
  const row = await one(`SELECT readiness_proof FROM pool_config WHERE project_id=$1`, [projectId]);
  return row?.readiness_proof || READINESS_PROOF_DEFAULT;
}

// Re-run the readiness preflight after a db binding change (§4.5) and say whether the project's
// policy turns a failure into a dispatch refusal. NEVER THROWS — a preflight that can fail the
// caller would be a new way to fail dispatch, which is worse than the fault it exists to catch
// (the same contract preflight.js promises). The verdict is stamped on the row by notePreflight
// before this returns, so under 'advisory' the spawn proceeds and the zee's briefing carries it
// (proofConditionLine below).
//
//   policy × verdict              outcome
//   any        preflight ok      { refused:false, verdict }
//   advisory   preflight fail    { refused:false, verdict }  — spawn proceeds; the failure is surfaced
//   required   preflight fail    { refused:true,  reason }   — the §4.5 refusal shape: ok:false
//                                                              (verdict.ok), the NAMED check, and the
//                                                              DSN identity WITHOUT the secret — which
//                                                              is exactly what verdict.error already is
//                                                              (dsnIdentity strips the password).
// A caller that cannot refuse — the dbclone switch attaches to a CLAIMED xell mid-work, so there is
// no "next candidate" to retry — ignores `refused` and reads the verdict; the failure still lands on
// the row and marks the xell not-stock for the routing pass (§4.6).
export async function rePreflightAfterBindingChange(xellId) {
  const xell = await one(`SELECT id, slug, project_id FROM xell WHERE id=$1`, [xellId]).catch(() => null);
  if (!xell) return { refused: false, policy: READINESS_PROOF_DEFAULT,
                      verdict: { ok: false, error: 'no such xell', checks: [] } };
  const policy = await projectReadinessProof(xell.project_id);
  const verdict = await runPreflight(xellId, { timeout: PREFLIGHT_TIMEOUT_MS });
  if (!verdict.ok && policy === 'required') {
    return { refused: true, policy, verdict,
      reason: `xell ${xell.slug} failed its binding re-preflight under readiness_proof='required': `
        + `${verdict.error}. The database it was just handed does not open, so it is not stock (§4.5) `
        + '— the dispatch is refused and the pool routes it (§4.6).' };
  }
  return { refused: false, policy, verdict };
}

// A dated, conditions-style line for THIS xell's OWN proof/preflight state, or null when there is
// nothing to say (§4.5: under 'advisory' a FAILED re-preflight is what must be visible to the zee —
// a healthy xell gets a briefing byte-identical to before this feature existed). The render matches
// the project conditions block (a dated ⚠ line), so a zee reading one reads the other. Deliberately
// only FAILURES: "never proven yet" is the normal state of a freshly provisioned xell until the
// backfill proves it, so it is not an impediment worth a line. Pure, so the verify suite can drive
// it without a database.
export function proofConditionLine(row) {
  if (!row) return null;
  const bits = [];
  if (row.preflight_error) bits.push(`database preflight FAILING: ${row.preflight_error}`);
  if (row.proof_error) bits.push(`provision proof FAILED: ${row.proof_error}`);
  if (!bits.length) return null;
  const when = conditionDate(row.preflight_at || row.proof_at) || '?';
  return '## ⚠ Your own proof state (this xell — advisory)\n\n'
    + `- [${when}] ${bits.join(' · ')}. The pool still dispatched you (this project runs `
    + 'readiness_proof=advisory, which refuses nothing and only reports), but your db binding is not '
    + 'proven until the fault is fixed — treat what it tells you as untrusted.';
}
