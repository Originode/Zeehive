// FAILURE ROUTING — a failed proof is routed by CLASS, once, at stamp time (§4.6).
// docs/provision-proof-plan.md §4.6 + docs/provision-proof-kit/stage-2-gates.md Build item 4.
//
// A verdict that is merely RECORDED lands where nobody looks. Routing decides where its OWNER
// looks, keyed on the CLASS the check already carries (migration 233), never on the verdict:
//
//   INFRA  (rec.status='missing' — the fault is the machine×project pair's, not the xell's:
//          address pools, daemon down/unreachable, context missing, port bind refused)
//          → the pair's build_readiness_record already carries it (the console machine-matrix
//            badge flips and stays flipped without a recent click), the pool fill CONSULTS the
//            record and stops filling the pair (§4.4), and a project-level card names machine +
//            check + the one bootstrap/medic action. The card is the auto-dispatch seam for the
//            INFRA-medic harness (§7): it carries a dispatch-medic button target (stage 3 wires
//            the button); NOTHING auto-spawns — a fault loop that auto-spawns agents is a new
//            failure class.
//   CODE-only (rec.status='ok' on a FAILED verdict — the machine CAN build, the code cannot) on a
//            pristine pooled xell at the source tip → a project-level "main does not build since
//            <sha>" fact (a current-conditions candidate AND a console card). Does NOT mark the
//            machine (the record stays 'ok') and does NOT stop the fill (the next land on main
//            may fix it; under advisory xells remain claimable, under required the gate holds).
//   unknown  (rec.status='unknown' — could not tell) → NOT routed here; the row and the zee's
//            briefing carry it. Routing a "we don't know" to a card would invent a class it does
//            not have.
//
// The routing writes are idempotent on STATE CHANGE (the pool's existing "say it when it CHANGES"
// discipline): an INFRA card is raised on the pair's transition into 'missing', never re-raised
// while the record stays 'missing'; the CODE fact is one rolling card per project, updated when
// the source tip moves, never appended per xell (25 pooled xells failing the same broken main must
// raise ONE fact, or the conditions list is a log again).
import { q } from '../db/pool.js';
import { addProjectCondition, updateProjectCondition, listProjectConditions } from './current-conditions.js';

// The one bootstrap/medic action that fixes an INFRA check — CONCRETE, because a card that says
// "troubleshoot" sends a human (or the stage-3 medic) looking, and a card that names the act does
// not. The check is the proof's own (app-build:<role>, app-serve:<role>, db-open, or a probe
// check name); the FIRST segment is the family.
export function infraMedicAction(check) {
  const family = String(check || '').split(':')[0];
  const byFamily = {
    'db-open': "repair the xell's database binding — the DSN it was handed does not open",
    'app-build': 'repair the docker prerequisite the build error names, then rebuild the role (zee build)',
    'app-serve': "restart the role's container and confirm its published port answers",
    'context-reachable': 'restart the docker daemon / repair the context on this machine',
    'compose-resolves': "fix the project's spinoff compose so it resolves on this machine",
    'requires-present': 'create the required network/volume on this machine',
    'shared-dev-db': "provision the project's shared dev db on this machine",
    'registry-for-handoff': 'configure a registry, or enable build on this machine',
  };
  return byFamily[family] || 'repair the named prerequisite on the machine, then re-run the proof';
}

// The INFRA card — machine + check + action, marked so the console and the routing dedup both
// recognize it ("PROVISION-INFRA" is the seam's marker; a human deleting the card acknowledges the
// fault, and the routing does not resurrect it until the pair re-enters 'missing').
export function infraCardBody({ machineKey, check, detail, action }) {
  return `PROVISION-INFRA: this project cannot build on machine '${machineKey}' — ${check}: ${detail}. `
    + `Medic action: ${action}. (This card is the infra-medic dispatch seam — a button target; `
    + `stage 3 wires it. Nothing auto-spawns; a human clicks.)`;
}

// The CODE fact — "main itself does not build on this machine". A current-conditions candidate
// (renderCurrentConditions puts it in every briefing) and a console card. Dated by the sha, not by
// the date the first xell happened to fail it.
export function codeCardBody({ sha, check, detail }) {
  return `main does not build since ${sha} — ${check}: ${detail}. CODE on a pristine pooled xell at `
    + `the source tip: the machine CAN build, the code cannot. The next land on main may fix it; `
    + `xells stay claimable (advisory) or the gate holds (required).`;
}

const INFRA_MARK = /^PROVISION-INFRA:/;
const CODE_MARK = /^main does not build since /;

// Is an INFRA card already up for this machine key? Fetched (≤ CONDITION_LIMIT rows) and matched
// in JS — the machine key is user data and a LIKE pattern is one metachar away from a wildcard.
function infraCardUp(rows, machineKey) {
  return rows.find((r) => INFRA_MARK.test(r.body) && r.body.includes(`machine '${machineKey}'`)) || null;
}

// The one rolling CODE fact per project: find the existing card (if any), update it when the sha
// moved, leave it when current, add it when absent. Returns the condition id, or null when nothing
// was written (already current / condition limit refused).
async function upsertRollingCodeCard(projectId, body, shortSha) {
  const rows = await listProjectConditions(projectId).catch(() => []);
  const existing = rows.find((r) => CODE_MARK.test(r.body));
  if (existing) {
    if (existing.body.startsWith(`main does not build since ${shortSha}`)) return null;  // current
    const r = await updateProjectCondition(existing.id, body, { actor: null });
    return r.ok ? existing.id : null;
  }
  const r = await addProjectCondition(projectId, body, { actor: null });
  return r.ok ? r.condition?.id || null : null;
}

// Route ONE failed proof by class (§4.6). NEVER throws — a routing failure must not become a
// second way for a proof to fail (the same rule as noteProof): every write is caught, and a
// refusal (condition limit, bad row) is reported in `reason` for the pool line, never thrown.
//
// rec    — buildReadinessRecordFromProof(verdict) — the machine×project verdict that was (or would
//          be) persisted; the CLASS rides on it.
// prevRec — the pair's record BEFORE this proof (null = first ever) — the transition an INFRA
//          card keys on.
// xell   — the row the proof ran on (needs is_pooled + status for the pristine-pooled guard).
//
// Returns { class: 'infra'|'code'|'none', card: <condition id>|null, reason }.
export async function routeProofFailure({ xell, verdict, rec, prevRec, machine, projectId }) {
  try {
    if (!xell || !projectId || !verdict || !rec) {
      return { class: 'none', card: null, reason: 'missing inputs — nothing to route' };
    }
    if (verdict.ok) return { class: 'none', card: null, reason: 'green proof — nothing to route' };

    if (rec.status === 'missing') {
      // INFRA — the (machine, project) pair's fault. Card on the transition into 'missing' only:
      // while the record STAYS 'missing' the pool keeps stopping the fill and the matrix badge
      // stays red — it is the CONSOLE that holds the story, not a re-printed card each proof.
      if (prevRec?.status === 'missing') {
        return { class: 'infra', card: null, reason: 'pair already recorded missing — no new card' };
      }
      const key = machine?.key || machine?.docker_ctx || '?';
      const rows = await listProjectConditions(projectId).catch(() => []);
      if (infraCardUp(rows, key)) {
        return { class: 'infra', card: null, reason: `INFRA card already up for machine '${key}'` };
      }
      const failed = (verdict.checks || []).filter((c) => !c.ok && !c.skipped).find((c) => c.class === 'INFRA');
      const check = failed?.check || 'proof';
      const detail = failed?.detail || verdict.error || 'proof failed';
      const body = infraCardBody({ machineKey: key, check, detail, action: infraMedicAction(check) });
      const r = await addProjectCondition(projectId, body, { actor: null });
      return r.ok
        ? { class: 'infra', card: r.condition?.id || null, reason: `INFRA card raised for machine '${key}'` }
        : { class: 'infra', card: null, reason: `card refused by conditions list: ${r.error}` };
    }

    if (rec.status === 'ok') {
      // CODE-only — the machine CAN build; the source cannot. Only a PRISTINE POOLED xell at the
      // source tip proves "main is broken" (the pool keeps ready xells at tip by construction); a
      // code failure on a non-pooled xell is about that branch, and belongs on the row/briefing.
      if (!xell.is_pooled || xell.status !== 'ready') {
        return { class: 'none', card: null, reason: 'code failure on a non-pristine xell — no "main" fact' };
      }
      if (!verdict.commit) {
        return { class: 'none', card: null, reason: 'code failure with no commit to name — no "since <sha>" fact' };
      }
      const failed = (verdict.checks || []).filter((c) => !c.ok && !c.skipped).find((c) => c.class === 'CODE');
      const check = failed?.check || 'proof';
      const detail = failed?.detail || verdict.error || 'build failed';
      const short = String(verdict.commit).slice(0, 12);
      const body = codeCardBody({ sha: short, check, detail });
      const id = await upsertRollingCodeCard(projectId, body, short);
      return { class: 'code', card: id,
               reason: id ? `main-broken fact raised/updated @ ${short}` : 'main-broken fact already current' };
    }

    return { class: 'none', card: null, reason: `rec.status '${rec.status}' — unknown, not routed` };
  } catch (e) {
    // A routing write that fails (DB down, bad row) must never fail the proof that raised it.
    return { class: 'none', card: null, reason: `routing error: ${e.message}` };
  }
}
