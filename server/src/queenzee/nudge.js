// NUDGE A CAGED ZEE AFTER ITS LANDING LANDS — the async-continuation half of the caged-zee land
// loop. A headless caged zee's turn ENDS the moment it calls `zee land`; the human then approves
// (maybe minutes or hours later), and nothing tells the zee. Before this, the zee simply stopped:
// its work sat landed on main and the ship/done steps never happened without a human re-invoking it.
//
// The PRIMARY fix is here: when a landing raised by a CAGED zee lands (landgate's landApproved),
// the queenzee RESUMES that zee's claude session with a short prompt — "your landing is on main,
// continue: ship if appropriate, then propose done". `zee land --wait` is the backup signal; this
// nudge is what makes the workflow continue with NO human in the loop.
//
// Only CAGED zees are nudged (entrypoint 'caged-cli' with a live 'ssh-terminal' cage). Best-effort
// and logged: a dead or torn-down cage just logs and moves on — a landing must never fail because a
// cage is unreachable.
import { one } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { cageName, nudgeCagedZee } from '../lib/cage.js';
import { tokenForSpawn } from '../lib/provider-tokens.js';

const CONTINUE_PROMPT =
  'Your landing was APPROVED and is now on main — the queenzee moved the ref, nothing is left for you '
  + 'to re-push. Continue the job from here:\n'
  + '  1. If this work should go to production, run `zee ship` (add `--targets server webapp` if only some '
  + 'tiers changed). It is refused unless landed — which it now is.\n'
  + '  2. If more work remains, keep going and `zee land` again when the next chunk is ready.\n'
  + '  3. When you are satisfied the whole job is complete, run `zee done --summary "…"`.\n'
  + 'Do NOT try to re-run `zee land` for the work that just landed; it is done. Pick the next step and act.';

// An OPERATOR-initiated nudge: ask the running zee for a short status update on its work, WITHOUT
// changing anything. Same delivery path as the post-land nudge (resume the caged session with a
// one-shot prompt) — this is what the flower's "nudge" button fires.
const STATUS_PROMPT =
  'The operator is asking for a STATUS UPDATE — no code changes, just report. In a few sentences, say:\n'
  + '  1. what you have DONE so far,\n'
  + '  2. what you are working on RIGHT NOW,\n'
  + '  3. what is LEFT before the job is complete, and\n'
  + '  4. any BLOCKERS or decisions you are waiting on.\n'
  + 'Keep it concise. Do not run builds or edit files for this — then carry on with your work.';

// Nudge THIS xell's live caged zee for a status update. Mirrors nudgeXellAfterLand's delivery but
// with the status prompt. Returns the same { nudged, reason?/error? } shape so the route/UI can
// tell the operator whether there was a live zee to reach. NEVER throws.
export async function nudgeXellForStatus(xellId, { by = 'human' } = {}) {
  return nudgeCaged(xellId, { by, prompt: STATUS_PROMPT, why: 'status update' });
}

// Re-invoke the caged zee that owns this xell, if one is live. NEVER throws.
export async function nudgeXellAfterLand(xellId, { by = 'human' } = {}) {
  return nudgeCaged(xellId, { by, prompt: CONTINUE_PROMPT,
    why: 'landing approved', log: (slug, sid) => `${slug}: landing approved by ${by} — resuming caged session ${sid} to continue` });
}

// The shared delivery: resolve this xell's live caged zee and resume its claude session with
// `prompt`. Fire-and-forget (the turn can run for minutes), best-effort, NEVER throws.
async function nudgeCaged(xellId, { by = 'human', prompt, why = 'nudge', log } = {}) {
  try {
    const zee = await one(
      `SELECT z.id, z.claude_session_id, z.viewer_kind, z.entrypoint, z.model, z.status,
              x.slug, x.project_id
         FROM zee z JOIN xell x ON x.id = z.xell_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'caged-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    if (!zee) return { nudged: false, reason: 'no caged zee for this xell (nothing to nudge)' };
    // A LIVE cage has an ssh-terminal viewer; a torn-down one does not.
    if (zee.viewer_kind !== 'ssh-terminal') return { nudged: false, reason: `zee is not in a live cage (viewer_kind=${zee.viewer_kind})` };
    if (!zee.claude_session_id) return { nudged: false, reason: 'caged zee has no session id to resume' };

    // Fallback token only — nudgeCagedZee prefers the tokens already in the cage's /etc/environment
    // so a running `zee … --wait` poll keeps its identity.
    const token = await tokenForSpawn(zee.project_id, 'claude').catch(() => null);

    const sid = String(zee.claude_session_id).slice(0, 8);
    logline('nudge', log ? log(zee.slug, sid) : `${zee.slug}: ${why} by ${by} — resuming caged session ${sid}`);
    // Fire and forget: the continuation turn can run for minutes; do NOT block the caller on it.
    nudgeCagedZee({
      ctx: 'default', name: cageName(zee.slug), sessionId: zee.claude_session_id,
      prompt, model: zee.model, token,
    })
      .then((r) => logline('nudge', `${zee.slug}: nudge session exited (code ${r?.code ?? '?'})`))
      .catch((e) => logline('nudge', `${zee.slug}: nudge could not run (${String(e.message).slice(0, 160)}) — cage may be down; no retry`));

    return { nudged: true, zee_id: zee.id, session: zee.claude_session_id, prompt };
  } catch (e) {
    logline('nudge', `nudge for xell ${String(xellId).slice(0, 8)} failed: ${String(e.message).slice(0, 160)}`);
    return { nudged: false, error: e.message };
  }
}
