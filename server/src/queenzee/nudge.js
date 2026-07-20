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
import { cageName, nudgeCagedZee, sendKeysToCagedZee } from '../lib/cage.js';
import { tokenForSpawn } from '../lib/provider-tokens.js';

const CONTINUE_PROMPT =
  'Your landing was APPROVED and is now on main — the queenzee moved the ref, nothing is left for you '
  + 'to re-push. Continue the job from here:\n'
  + '  1. If this work should go to production, run `zee ship` (add `--targets server webapp` if only some '
  + 'tiers changed). It is refused unless landed — which it now is.\n'
  + '  2. If more work remains, keep going and `zee land` again when the next chunk is ready.\n'
  + '  3. When you are satisfied the whole job is complete, run `zee done --summary "…"`.\n'
  + 'Do NOT try to re-run `zee land` for the work that just landed; it is done. Pick the next step and act.';

// An OPERATOR-initiated nudge: poke the running zee for a status update, WITHOUT changing anything.
// The word the operator wants the agent to actually SEE, typed into the live session as-is.
const STATUS_KEYS = 'status?';

// Nudge THIS xell's live caged zee for a status update. It does NOT fork a second headless claude
// (that reply never reached anyone — the reason nudging "did not work"); it TYPES `status?` straight
// into the live interactive session over SSH, exactly as if the operator typed it in the dashboard
// terminal, so the agent's answer appears where the operator is looking. Returns the same
// { nudged, reason?/error? } shape so the route/UI can tell the operator whether there was a live zee
// to reach. NEVER throws.
export async function nudgeXellForStatus(xellId, { by = 'human' } = {}) {
  return nudgeCagedByKeys(xellId, { by, text: STATUS_KEYS, why: 'status update' });
}

// Re-invoke the caged zee that owns this xell, if one is live. NEVER throws.
export async function nudgeXellAfterLand(xellId, { by = 'human' } = {}) {
  return nudgeCaged(xellId, { by, prompt: CONTINUE_PROMPT,
    why: 'landing approved', log: (slug, sid) => `${slug}: landing approved by ${by} — resuming caged session ${sid} to continue` });
}

// STATUS delivery: resolve this xell's live caged zee and TYPE `text` into the interactive session
// it is running, over SSH (the same inbound door + fleet key the dashboard terminal uses). This is
// the literal "send the word to the AI" path — the agent receives the keystrokes in the session the
// operator watches, and its reply shows up there rather than in a headless log. Fire-and-forget
// (typing + the reply can take a beat), best-effort, NEVER throws.
async function nudgeCagedByKeys(xellId, { by = 'human', text, why = 'nudge' } = {}) {
  try {
    const zee = await one(
      `SELECT z.id, z.claude_session_id, z.viewer_kind, z.viewer_url, x.slug
         FROM zee z JOIN xell x ON x.id = z.xell_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'caged-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    if (!zee) return { nudged: false, reason: 'no caged zee for this xell (nothing to nudge)' };
    // A LIVE cage has an ssh-terminal viewer; a torn-down one does not.
    if (zee.viewer_kind !== 'ssh-terminal') return { nudged: false, reason: `zee is not in a live cage (viewer_kind=${zee.viewer_kind})` };
    let sshPort;
    try { sshPort = Number(new URL(zee.viewer_url).port); } catch { /* below */ }
    if (!sshPort) return { nudged: false, reason: 'cage has no SSH port to reach (viewer_url missing/invalid)' };

    logline('nudge', `${zee.slug}: ${why} by ${by} — typing ${JSON.stringify(text)} into the live cage session over SSH (:${sshPort})`);
    // Fire and forget: opening SSH, starting the TUI if needed, and typing can take several seconds;
    // do NOT block the caller (the flower's button) on it.
    sendKeysToCagedZee({ sshPort, slug: zee.slug, text, sessionId: zee.claude_session_id })
      .then(() => logline('nudge', `${zee.slug}: sent ${JSON.stringify(text)} to the live session`))
      .catch((e) => logline('nudge', `${zee.slug}: could not type into the cage (${String(e.message).slice(0, 160)}) — cage/session may be down; no retry`));

    return { nudged: true, zee_id: zee.id, session: zee.claude_session_id, sent: text, via: 'ssh-send-keys' };
  } catch (e) {
    logline('nudge', `status nudge for xell ${String(xellId).slice(0, 8)} failed: ${String(e.message).slice(0, 160)}`);
    return { nudged: false, error: e.message };
  }
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
