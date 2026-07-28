// NUDGE A CXELLD ZEE AFTER ITS LANDING LANDS — the async-continuation half of the cxell-zee land
// loop. A headless cxell zee's turn ENDS the moment it calls `zee land`; the human then approves
// (maybe minutes or hours later), and nothing tells the zee. Before this, the zee simply stopped:
// its work sat landed on main and the ship/done steps never happened without a human re-invoking it.
//
// The PRIMARY fix is here: when a landing raised by a CXELLD zee lands (landgate's landApproved),
// the queenzee RESUMES that zee's claude session with a short prompt — "your landing is on main,
// continue: ship if appropriate, then propose done". `zee land --wait` is the backup signal; this
// nudge is what makes the workflow continue with NO human in the loop.
//
// Only CXELLD zees are nudged (entrypoint 'cxell-cli' with a live 'ssh-terminal' cxell). Best-effort
// and logged: a dead or torn-down cxell just logs and moves on — a landing must never fail because a
// cxell is unreachable.
import { one } from '../db/pool.js';
import { logline } from '../lib/logbus.js';
import { cxellName, nudgeCxellZee, sendKeysToCxellZee, writeFileIntoCxell } from '../lib/cxell.js';
import { adapterFor } from '../lib/cxell-runtimes.js';
import { tokenForSpawn } from '../lib/provider-tokens.js';

const CONTINUE_PROMPT =
  'Your landing was APPROVED and is now on main — the queenzee moved the ref, nothing is left for you '
  + 'to re-push. Continue the job from here:\n'
  + '  1. If this work should go to production, run `zee ship` (add `--targets server webapp` if only some '
  + 'tiers changed). It is refused unless landed — which it now is.\n'
  + '  2. If more work remains, keep going and `zee land` again when the next chunk is ready.\n'
  + '  3. When you are satisfied the whole job is complete, run `zee done --summary "…"`.\n'
  + 'Do NOT try to re-run `zee land` for the work that just landed; it is done. Pick the next step and act.';

// THE REFLECTION STAGE — what a worker does AFTER its work is live in production.
//
// A ship used to be the end of a zee's story: the containers swapped, the card went quiet, and
// everything the zee learned on the way — the workaround it had to leave in, the test it could not
// write, the bug it saw in passing — died with the cxell. The one moment a worker knows the most
// about a change is right after it ships, and nobody was asking.
//
// So the queenzee re-invokes the shipping zee with a REFLECTION prompt: review what actually shipped
// and report improvements and errors to its MANAGER (`zee report --kind reflection`), which lands in
// the manager's inbox and is delivered into its live session. A worker with no manager still writes
// the reflection — it is recorded for the humans in the console instead of being lost.
//
// It is a prompt, not a gate: it opens nothing, blocks nothing, and a dead cxell simply logs.
const REFLECT_PROMPT = (commit, managerSlug) => [
  `Your work SHIPPED to production${commit ? ` (${String(commit).slice(0, 8)})` : ''}. Before you stop, do the REFLECTION pass —`,
  'this is a required stage, and it is the most valuable thing you will write today, because right now',
  'you know more about this change than anyone else ever will.',
  '',
  'Review what actually shipped (your diff, what you had to work around, what you could not verify), then',
  'report — honestly, specifically, no reassurance:',
  '  1. IMPROVEMENTS — what should be done better next time, in this code or in how the job was set up.',
  '  2. ERRORS / RISKS — anything you know is wrong, fragile, or unverified in what just went live,',
  '     including things outside your task that you noticed on the way. Say it even if it is your own',
  '     mistake: an unreported flaw in production is far more expensive than an admitted one.',
  '  3. FOLLOW-UPS — the concrete next tasks you would cut, in priority order.',
  '',
  managerSlug
    ? `Send it with \`zee report --kind reflection --message "…"\` — it goes to your MANAGER (${managerSlug}),`
      + ' who decides what becomes the next task. Keep it under ~25 lines and lead with anything broken.'
    : 'Send it with `zee report --kind reflection --message "…"`. You have no manager zee, so it is recorded'
      + ' for the humans in the console. Keep it under ~25 lines and lead with anything broken.',
  '',
  'If you find something genuinely broken in production, ALSO raise it now: `zee tend --reason "…"`.',
  'Do not deploy, do not touch prod, and do not start fixing it in this xell without being asked —',
  'reflect, report, and let a human or your manager decide what happens next.',
].join('\n');

// Ask the zee that just shipped to reflect. Called by the ship gate on a SUCCESSFUL ship only —
// there is nothing to reflect on when nothing went live (a failed ship is a build problem the human
// is already looking at). Best-effort, never throws: a ship must never fail because a cxell is gone.
export async function nudgeXellForReflection(xellId, { commit = null, by = 'queenzee' } = {}) {
  const mgr = await one(
    `SELECT m.slug FROM xell x JOIN xell m ON m.id = x.manager_xell_id WHERE x.id=$1`, [xellId])
    .catch(() => null);
  return nudgeCxell(xellId, {
    by, prompt: REFLECT_PROMPT(commit, mgr?.slug || null), why: 'post-ship reflection',
    log: (slug, sid) => `${slug}: shipped — resuming cxell session ${sid} for the REFLECTION pass`
      + `${mgr?.slug ? ` (reports to ${mgr.slug})` : ''}`,
  });
}

// An OPERATOR-initiated nudge: poke the running zee for a status update, WITHOUT changing anything.
// The word the operator wants the agent to actually SEE, typed into the live session as-is.
const STATUS_KEYS = 'status?';

// Nudge THIS xell's live cxell zee for a status update. It does NOT fork a second headless claude
// (that reply never reached anyone — the reason nudging "did not work"); it TYPES `status?` straight
// into the live interactive session over SSH, exactly as if the operator typed it in the dashboard
// terminal, so the agent's answer appears where the operator is looking. Returns the same
// { nudged, reason?/error? } shape so the route/UI can tell the operator whether there was a live zee
// to reach. NEVER throws.
export async function nudgeXellForStatus(xellId, { by = 'human' } = {}) {
  return nudgeCxellByKeys(xellId, { by, text: STATUS_KEYS, why: 'status update' });
}

// Re-invoke the cxell zee that owns this xell, if one is live. NEVER throws.
export async function nudgeXellAfterLand(xellId, { by = 'human' } = {}) {
  return nudgeCxell(xellId, { by, prompt: CONTINUE_PROMPT,
    why: 'landing approved', log: (slug, sid) => `${slug}: landing approved by ${by} — resuming cxell session ${sid} to continue` });
}

// SEND A COMPOSED OPERATOR MESSAGE to this xell's live cxell zee — the "proper message" path behind
// the flower's 📨 button, for when the raw terminal is too clumsy for long text or images. Short,
// single-line text is TYPED straight into the live interactive session (exactly like a status nudge,
// so the zee's reply lands where the operator is looking). Anything richer — any image, or multi-line
// / long text — is written into the cxell as real files under `.zee-inbox/<ts>/` (images verbatim, the
// body as `message.md`), and a one-line pointer is typed in telling the zee to READ the body and VIEW
// the attached images by path (Claude opens image files from a path). Delivery is fire-and-forget and
// best-effort — this NEVER throws; it returns { sent, reason?/error? } so the route/UI can report.
export async function sendMessageToXell(xellId, { text = '', images = [], by = 'human' } = {}) {
  try {
    const body = String(text || '').trim();
    const imgs = (Array.isArray(images) ? images : []).filter((i) => i && i.data);
    if (!body && !imgs.length) return { sent: false, reason: 'empty message (no text or images)' };

    const zee = await one(
      `SELECT z.id, z.claude_session_id, z.viewer_kind, z.viewer_url, x.slug
         FROM zee z JOIN xell x ON x.id = z.xell_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'cxell-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    if (!zee) return { sent: false, reason: 'no cxell zee for this xell (nothing to message)' };
    if (zee.viewer_kind !== 'ssh-terminal') return { sent: false, reason: `zee is not in a live cxell (viewer_kind=${zee.viewer_kind})` };
    let sshPort;
    try { sshPort = Number(new URL(zee.viewer_url).port); } catch { /* handled below */ }
    if (!sshPort) return { sent: false, reason: 'cxell has no SSH port to reach (viewer_url missing/invalid)' };

    // Rich message → hand it over as files; plain short text → type it inline.
    const rich = imgs.length > 0 || body.includes('\n') || body.length > 300;
    let typed = body;
    const written = [];

    const failed = [];
    if (rich) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = `.zee-inbox/${ts}`;
      for (let i = 0; i < imgs.length; i++) {
        const b64 = String(imgs[i].data).replace(/^data:[^,]*,/, '');
        const rel = `${dir}/image-${i + 1}${msgImageExt(imgs[i].name, imgs[i].type)}`;
        try { written.push((await writeFileIntoCxell({ slug: zee.slug, relPath: rel, base64: b64 })).path); }
        catch (e) { failed.push(imgs[i].name || rel); logline('message', `${zee.slug}: could not write attachment ${rel} (${String(e.message).slice(0, 120)})`); }
      }
      // Every attachment failed to land — don't type a pointer to files that aren't there and don't
      // report a clean send. The operator needs to know the images did NOT reach the zee (this is the
      // "attach image fails silently" case: writes threw, yet the UI showed success).
      if (imgs.length && !written.length) {
        return { sent: false, reason: `could not deliver ${imgs.length} image attachment(s) into the cxell — ${failed.join(', ')}`, failed };
      }
      const md = ['# Operator message', `_sent ${new Date().toISOString()} by ${by}_`, '',
        body || '(no text — see attachments)', '',
        ...(written.length ? [`## Attachments (${written.length})`, ...written.map((p) => `- ${p}`)] : []),
        ...(failed.length ? ['', `> ⚠ ${failed.length} attachment(s) could not be delivered: ${failed.join(', ')}`] : [])].join('\n');
      let bodyPath = `${dir}/message.md`;
      try { bodyPath = (await writeFileIntoCxell({ slug: zee.slug, relPath: bodyPath, text: md })).path; }
      catch (e) { logline('message', `${zee.slug}: could not write message body (${String(e.message).slice(0, 120)})`); }
      typed = `📨 New operator message — please read ${bodyPath}`
        + (written.length ? ` and view the ${written.length} attached image(s): ${written.join(', ')}` : '')
        + (body ? `. Summary: ${body.replace(/\s+/g, ' ').slice(0, 160)}` : '');
    }

    logline('message', `${zee.slug}: operator message by ${by} — ${rich ? `${written.length} file(s) to .zee-inbox, ` : ''}typing into live cxell session over SSH (:${sshPort})`);
    // Fire and forget: opening SSH, resuming the TUI and typing can take several seconds.
    sendKeysToCxellZee({ sshPort, slug: zee.slug, text: typed, sessionId: zee.claude_session_id })
      .then(() => logline('message', `${zee.slug}: delivered operator message to the live session`))
      .catch((e) => logline('message', `${zee.slug}: could not type into the cxell (${String(e.message).slice(0, 160)}) — cxell/session may be down; no retry`));

    return { sent: true, zee_id: zee.id, session: zee.claude_session_id, rich, attachments: written, ...(failed.length ? { failed } : {}) };
  } catch (e) {
    logline('message', `message for xell ${String(xellId).slice(0, 8)} failed: ${String(e.message).slice(0, 160)}`);
    return { sent: false, error: e.message };
  }
}

// Pick a sane file extension for an attachment from its name, else its mime type, else default png.
function msgImageExt(name = '', type = '') {
  const m = String(name).match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return `.${m[1].toLowerCase()}`;
  const sub = String(type).split('/')[1];
  if (sub) return `.${sub.replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/[^a-z0-9]/gi, '')}`;
  return '.png';
}

// STATUS delivery: resolve this xell's live cxell zee and TYPE `text` into the interactive session
// it is running, over SSH (the same inbound door + fleet key the dashboard terminal uses). This is
// the literal "send the word to the AI" path — the agent receives the keystrokes in the session the
// operator watches, and its reply shows up there rather than in a headless log. Fire-and-forget
// (typing + the reply can take a beat), best-effort, NEVER throws.
async function nudgeCxellByKeys(xellId, { by = 'human', text, why = 'nudge' } = {}) {
  try {
    const zee = await one(
      `SELECT z.id, z.claude_session_id, z.viewer_kind, z.viewer_url, x.slug
         FROM zee z JOIN xell x ON x.id = z.xell_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'cxell-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    if (!zee) return { nudged: false, reason: 'no cxell zee for this xell (nothing to nudge)' };
    // A LIVE cxell has an ssh-terminal viewer; a torn-down one does not.
    if (zee.viewer_kind !== 'ssh-terminal') return { nudged: false, reason: `zee is not in a live cxell (viewer_kind=${zee.viewer_kind})` };
    let sshPort;
    try { sshPort = Number(new URL(zee.viewer_url).port); } catch { /* below */ }
    if (!sshPort) return { nudged: false, reason: 'cxell has no SSH port to reach (viewer_url missing/invalid)' };

    logline('nudge', `${zee.slug}: ${why} by ${by} — typing ${JSON.stringify(text)} into the live cxell session over SSH (:${sshPort})`);
    // Fire and forget: opening SSH, starting the TUI if needed, and typing can take several seconds;
    // do NOT block the caller (the flower's button) on it.
    sendKeysToCxellZee({ sshPort, slug: zee.slug, text, sessionId: zee.claude_session_id })
      .then(() => logline('nudge', `${zee.slug}: sent ${JSON.stringify(text)} to the live session`))
      .catch((e) => logline('nudge', `${zee.slug}: could not type into the cxell (${String(e.message).slice(0, 160)}) — cxell/session may be down; no retry`));

    return { nudged: true, zee_id: zee.id, session: zee.claude_session_id, sent: text, via: 'ssh-send-keys' };
  } catch (e) {
    logline('nudge', `status nudge for xell ${String(xellId).slice(0, 8)} failed: ${String(e.message).slice(0, 160)}`);
    return { nudged: false, error: e.message };
  }
}

// The shared delivery: resolve this xell's live cxell zee and resume its claude session with
// `prompt`. Fire-and-forget (the turn can run for minutes), best-effort, NEVER throws.
async function nudgeCxell(xellId, { by = 'human', prompt, why = 'nudge', log } = {}) {
  try {
    const zee = await one(
      `SELECT z.id, z.claude_session_id, z.viewer_kind, z.entrypoint, z.model, z.status,
              x.slug, x.project_id, rt.key AS runtime_key
         FROM zee z JOIN xell x ON x.id = z.xell_id
         LEFT JOIN agent_runtime rt ON rt.id = z.runtime_id
        WHERE z.xell_id = $1 AND z.entrypoint = 'cxell-cli'
        ORDER BY z.created_at DESC LIMIT 1`, [xellId]);
    if (!zee) return { nudged: false, reason: 'no cxell zee for this xell (nothing to nudge)' };
    // A LIVE cxell has an ssh-terminal viewer; a torn-down one does not.
    if (zee.viewer_kind !== 'ssh-terminal') return { nudged: false, reason: `zee is not in a live cxell (viewer_kind=${zee.viewer_kind})` };
    // The zee's own runtime dialect: claude/codex resume by session id, kimi by workdir
    // (--continue) — so only the id-keyed runtimes refuse when no session id was captured.
    const adapter = adapterFor(zee.runtime_key);
    if (!adapter.resumable) return { nudged: false, reason: `runtime ${adapter.key} cannot resume a headless session` };
    if (adapter.needsSid && !zee.claude_session_id) return { nudged: false, reason: 'cxell zee has no session id to resume' };

    // Fallback token only — nudgeCxellZee prefers the tokens already in the cxell's /etc/environment
    // so a running `zee … --wait` poll keeps its identity.
    const token = await tokenForSpawn(zee.project_id, adapter.provider).then((a) => a?.token).catch(() => null);

    const sid = String(zee.claude_session_id || 'latest').slice(0, 8);
    logline('nudge', log ? log(zee.slug, sid) : `${zee.slug}: ${why} by ${by} — resuming cxell session ${sid}`);
    // Fire and forget: the continuation turn can run for minutes; do NOT block the caller on it.
    nudgeCxellZee({
      ctx: 'default', name: cxellName(zee.slug), sessionId: zee.claude_session_id,
      prompt, model: zee.model, adapter, token,
    })
      .then((r) => logline('nudge', `${zee.slug}: nudge session exited (code ${r?.code ?? '?'})`))
      .catch((e) => logline('nudge', `${zee.slug}: nudge could not run (${String(e.message).slice(0, 160)}) — cxell may be down; no retry`));

    return { nudged: true, zee_id: zee.id, session: zee.claude_session_id, prompt };
  } catch (e) {
    logline('nudge', `nudge for xell ${String(xellId).slice(0, 8)} failed: ${String(e.message).slice(0, 160)}`);
    return { nudged: false, error: e.message };
  }
}
