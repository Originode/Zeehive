// LANDING GATE — the decision behind the xource's `update` hook.
//
// Every push to a project's main_branch calls checkPush() BEFORE the ref moves. We answer one
// question: has a human already approved THIS EXACT sha? If yes, the push goes through and the
// request is spent. If no, we record/refresh a pending request, announce it, and decline.
//
// Deliberately dumb: no AI, no interpretation of the zee's intent, no "does this look safe".
// A human reads the commits in the console and decides. Same division of labour as the rest of
// the queenzee — the script enforces, the human judges.
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline, activity } from '../lib/logbus.js';
import { gitLog, diffStat, cleanGitEnv, headCommit, doorFromEmail } from '../lib/git.js';
import { spawnSync } from 'node:child_process';
import { notifyLandRequest } from '../lib/notify.js';
import { nudgeXellAfterLand, nudgeXellForStaleLanding, nudgeXellForClearedRunway,
         nudgeXellForLostClearance, tendForSilentClearance } from './nudge.js';
import { shouldProcessNow, processPad, RECEIPT_MIN } from './landingpad.js';
import { recordXourceHead } from '../lib/projects.js';

// Same switch every other real-side-effect module reads (intake, pool, xell-db, machines, harness,
// reaper, images, the .zeehive.env reconcile): 'real' touches machines, anything else models.
//
// IT HAS TO BE READ HERE because a LANDING is the most irreversible machine effect the queenzee has:
// it fast-forwards a branch inside project.repo_root — the XOURCE. A xell's database is a CLONE of
// the meta-DB, so the land_request rows a NESTED queenzee walks (every zee that boots the server
// inside its own xell — zeehive.yml gives it PROVISION_MODE=simulate) are the REAL fleet's rows,
// approvals and all. tick() below runs every 10s and needs no human, no click and no push: booting
// the server was enough to inherit somebody else's approval and push it into the real main. See
// landApproved() and the approved branch of checkPush() for the two doors that was reached through.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// Approvals this process has already REPORTED it will not spend. The report is the whole point (a
// silent skip and "nothing to land" must not read alike) — but tick() re-reads the same inherited
// rows every 10 seconds forever, and a report repeated 8,640 times a day is not louder, it is the
// thing that buries the line a human needed to read. So: once per approval, per process.
const reportedDryLandings = new Set();

// LANDING IS THE MOST COMMON WAY THE XOURCE HEAD MOVES — far more often than a pull. So the
// moment a landing advances the ref we must re-record xource.head_commit, or the rollback
// baseline (populated at onboarding / on pull) goes stale the instant anyone lands: the
// ancestry tripwire would then fire FALSE positives against an old commit. A land is always a
// fast-forward, so the new head contains the old one and recordXourceHead() naturally does NOT
// warn. Advisory only: it must never break a landing, so it is wrapped and any failure is a
// no-op. `ref` here is the plain branch name (what the xource row keys on), not `refs/heads/*`.
async function recordLandedHead(project, head) {
  if (!project || !head) return;
  try {
    await recordXourceHead(project, project.main_branch, head);
  } catch (e) {
    logline('landgate', `note: could not record xource head after land: ${e.message}`);
  }
}

const ZERO = /^0+$/;

// AFTER A LANDING LANDS, bring the xell's STORED git position in line with what actually happened.
// The land_request row flips to 'landed', but the xell row still carries the sha it was PROVISIONED
// at (head_commit) and last synced from (last_synced_commit) — the fork point it left long ago. So
// the card the human just watched land keeps rendering the pre-land diff: its stored head points at
// the old base, so a xell now level with main reads as still-ahead until something re-reads the
// worktree. pushToXource already fixes this for the immediate-approve path (it updates both columns
// on a successful push); the paths that move the ref WITHOUT a push from the worktree — a human
// approval (update-ref), an already-landed reconcile, an auto-approved gate, a PR merged from the
// inside — never did. Point both columns at the landed sha (the tip the xell's work is now part of)
// so the xell's data matches its current diff (level, 0/0) and status, then broadcast the refreshed
// row. Best-effort and keyed on the land_request itself, so EVERY way a landing lands ends the same.
export async function syncXellAfterLand(xellId, landedSha) {
  if (!xellId || !landedSha) { if (xellId) broadcast('xell', { id: xellId }); return null; }
  const row = await one(
    `UPDATE xell SET head_commit=$2, last_synced_commit=$2 WHERE id=$1 RETURNING *`,
    [xellId, landedSha]).catch(() => null);
  broadcast('xell', row || { id: xellId });
  return row;
}

// The commits a push would ADD to main (old..new), newest first — what the human actually reviews.
// Safe to read from the xource: xell worktrees SHARE its object store, so the zee's commits are
// already there; the push only moves the ref. (Nothing is quarantined for a same-repo push.)
//
// TKT-159-3139 (diff provenance): each entry now carries the COMMITTER + door as well as the
// author, so a human reviewing a landing can see WHO wrote it (author = the zee slug) and WHICH
// DOOR applied it (committer = xell door for in-cage commits, console door for console-terminal
// input, queenzee door for queenzee merges). `door` is derived from the committer email; the
// land_request.commits jsonb is free-form, so older rows with just {short,subject,author} keep
// rendering.
export function pushedCommits(repoRoot, oldSha, newSha, limit = 50) {
  const range = !oldSha || ZERO.test(oldSha) ? newSha : `${oldSha}..${newSha}`;
  const SEP = '\x1f';
  const r = spawnSync('git', ['-C', repoRoot, 'log',
    `--pretty=format:%h${SEP}%s${SEP}%an${SEP}%ae${SEP}%cn${SEP}%ce`,
    '-n', String(limit), range], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) return [];
  return (r.stdout || '').split('\n').filter(Boolean).map((line) => {
    const [short, subject, author, authorEmail, committer, committerEmail] = line.split(SEP);
    return { short, subject, author, author_email: authorEmail || null,
             committer: committer || null, committer_email: committerEmail || null,
             door: doorFromEmail(committerEmail) };
  });
}

// Which xell is pushing? The hook can't tell us (receive-pack runs in the xource, not the
// worktree), so match the sha to the xell whose branch contains it. Best-effort and purely
// informational — an unmatched push is still gated, it just shows as "unknown" in the console.
async function resolveXell(projectId, repoRoot, newSha) {
  const xells = await q(
    `SELECT id, slug, branch, zee_type FROM xell
       WHERE project_id = $1 AND status <> 'retired' AND is_production = false`, [projectId]);
  for (const x of xells) {
    const r = spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', newSha, x.branch],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, env: cleanGitEnv() });
    if (r.status === 0) return x;
  }
  return null;
}

// Called by the hook on EVERY push to main. Returns { allow, request, reason }.
// allow=true only when a human approved this exact sha and it hasn't been spent yet.
export async function checkPush({ projectId, ref, oldSha, newSha }, { mode = PROVISION_MODE } = {}) {
  const project = await one(`SELECT * FROM project WHERE id = $1`, [projectId]);
  if (!project) return { allow: false, reason: 'unknown-project', request: null };

  // A ref DELETION of main is never something a zee should be doing. No approval path: refuse.
  if (!newSha || ZERO.test(newSha)) {
    logline('landgate', `DECLINED deletion of ${ref} on ${project.name}`);
    return { allow: false, reason: 'deletion-refused', request: null };
  }

  // A MANAGER zee has ZERO push access to the xource, and this is where that is made true rather
  // than asked for: the push is declined and NO land_request is raised, so there is no card, no
  // approval and no path a persuasive agent could talk a human down. A manager coordinates workers;
  // the workers land their own work. (Resolved from the pushed sha the same way the request below
  // resolves it — a push we cannot attribute is not treated as a manager's.)
  const pusher = await resolveXell(projectId, project.repo_root, newSha);
  if (pusher?.zee_type === 'manager') {
    logline('landgate',
      `DECLINED ${ref} → ${String(newSha).slice(0, 8)} on ${project.name} — ${pusher.slug} is a MANAGER xell `
      + '(zero push access to the xource; nothing was raised for a human to approve)');
    return { allow: false, reason: 'manager-no-push', request: null };
  }

  const approved = await one(
    `SELECT * FROM land_request
       WHERE project_id=$1 AND ref=$2 AND new_sha=$3 AND status='approved'`,
    [projectId, ref, newSha]);

  if (approved && mode !== 'real') {
    // A NESTED QUEENZEE MUST NOT AUTHORISE A REAL PUSH EITHER. This is the second door onto the same
    // ref: the hook reads its API from "${ZEEHIVE_API:-<baked-in>}" and the queenzee hands its OWN
    // environment to every git it spawns, so a nested instance can end up being the gate a REAL push
    // consults — and the approval it would find is the real fleet's, inherited in the db clone.
    // Answering allow:true there spends a human's approval and lets the ref move. Decline instead,
    // which is the direction this gate already fails in (the hook fails CLOSED by design), and say
    // why: a declined push loses nothing, the commits stay on the branch, and the REAL queenzee
    // still lands it when the real hook asks it.
    logline('landgate',
      `DECLINED ${ref} → ${String(newSha).slice(0, 8)} on ${project.name} — PROVISION_MODE=simulate: this `
      + 'queenzee models the fleet, it does not authorise pushes into a real xource. The approval is '
      + 'left UNSPENT; re-push against the real queenzee.');
    return { allow: false, reason: 'nested-queenzee', request: approved, dry_run: true };
  }

  if (approved) {
    // Spend the approval: it authorised this sha once. The ref is about to move (the hook exits
    // 0 on our answer), so mark it landed now — if the push then fails, the next attempt needs a
    // fresh decision. Conservative on purpose: an unspent approval is a standing invitation.
    const row = await one(
      `UPDATE land_request SET status='landed', landed_at=now() WHERE id=$1 RETURNING *`, [approved.id]);
    broadcast('land', row);
    // The push we are allowing moves the ref to newSha — record that as the xell's position now.
    await syncXellAfterLand(row.xell_id, newSha);
    logline('landgate', `ALLOWED ${ref} → ${newSha.slice(0, 8)} on ${project.name} (approved by ${approved.decided_by})`);
    // The receive path is about to move the ref to newSha — keep the rollback baseline fresh so a
    // land does not leave head_commit stale (and later trip a false BACKWARD on pull).
    await recordLandedHead(project, newSha);
    // The runway is free the moment this approval is spent — call whoever is holding for it.
    freeRunway(projectId, ref, `${newSha.slice(0, 8)} landed`);
    return { allow: true, reason: 'approved', request: row };
  }

  // Operator policy: when auto-approve is on, an unjudged push is let straight through. The push is
  // already in flight (the hook is waiting on this answer), so returning allow:true lets THIS push
  // move the ref — no update-ref, no re-entrancy. The row is recorded as landed-by-policy so the
  // audit trail shows exactly what went in without a human. (Prior rejections are handled below.)
  // Read BEFORE the upsert lookup because it decides whether the holding pattern exists at all: with
  // the policy on, every push lands on arrival, so the runway is never occupied and the queue must be
  // a no-op rather than a new place to wait.
  const auto = !!project.auto_approve_land;

  // No approval → this push is a REQUEST. Upsert so a retrying zee bumps attempts instead of
  // filling the console with duplicate cards for the same sha — and, since 067, so a zee re-pushing
  // while it HOLDS keeps its one place in line instead of taking a second.
  const existing = await one(
    `SELECT * FROM land_request
       WHERE project_id=$1 AND ref=$2 AND new_sha=$3
         AND (status IN ('pending','rejected')
              OR (NOT $4::bool AND status='holding' AND cleared_at IS NULL))
       ORDER BY requested_at DESC LIMIT 1`, [projectId, ref, newSha, auto]);

  if (existing && existing.status === 'rejected') {
    // A human said no to THIS sha. Auto-approve is a policy for UNJUDGED pushes; it must never
    // resurrect something a human explicitly refused.
    logline('landgate', `DECLINED ${ref} → ${newSha.slice(0, 8)} on ${project.name} (previously rejected)`);
    return { allow: false, reason: 'rejected', request: existing };
  }

  if (existing && existing.status === 'holding') {
    // Still in the pattern: same sha, same place in line. Bump attempts (the row records how many
    // times this zee has asked) and tell it where it stands — a zee that pushes again must not be
    // met with silence, and it must not be given a second slot for pushing twice.
    const row = await one(
      `UPDATE land_request SET attempts = attempts + 1 WHERE id=$1 RETURNING *`, [existing.id]);
    broadcast('land', row);
    const position = await holdingPosition(row);
    logline('landgate',
      `${newSha.slice(0, 8)} is HOLDING at position ${position} on ${ref.replace('refs/heads/', '')} `
      + `(${pusher?.slug || 'unknown'} re-pushed; the runway is still occupied)`);
    return { allow: false, reason: 'holding', request: row, position };
  }

  if (existing) {
    if (auto) {
      const row = await one(
        `UPDATE land_request SET status='landed', attempts=attempts+1,
            decided_at=now(), decided_by='auto-approve@policy', landed_at=now()
           WHERE id=$1 RETURNING *`, [existing.id]);
      broadcast('land', row);
      await syncXellAfterLand(row.xell_id, newSha);
      logline('landgate', `AUTO-APPROVED ${ref} → ${newSha.slice(0, 8)} on ${project.name} — auto-approve policy (no human review)`);
      await recordLandedHead(project, newSha);
      return { allow: true, reason: 'auto-approved', request: row };
    }
    const row = await one(
      `UPDATE land_request SET attempts = attempts + 1 WHERE id=$1 RETURNING *`, [existing.id]);
    broadcast('land', row);
    return { allow: false, reason: 'pending', request: row };
  }

  const commits = pushedCommits(project.repo_root, oldSha, newSha);
  const xell = pusher;   // resolved once, above (the manager check needed it first)

  // Store what a human reviewing a LANDING needs: how much lands, not divergence. diffStat's
  // ahead/behind are relative to a base and read backwards here (its `behind` is the count of
  // commits this push ADDS), so take only the size fields and label the count ourselves.
  const d = diffStat(project.repo_root, ZERO.test(oldSha || '') ? null : oldSha, newSha);
  const stat = d
    ? { commits: commits.length, files: d.files, insertions: d.insertions, deletions: d.deletions }
    : { commits: commits.length };

  if (auto) {
    const row = await one(
      `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, stat,
          status, decided_at, decided_by, landed_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'landed',now(),'auto-approve@policy',now()) RETURNING *`,
      [projectId, xell?.id || null, ref, oldSha || null, newSha,
        JSON.stringify(commits), stat ? JSON.stringify(stat) : null]);
    broadcast('land', row);
    await syncXellAfterLand(xell?.id, newSha);
    // the honeycomb's xell→queenzee line: this xell pushed a land request
    activity('x2q', xell?.id, 'land', projectId);
    logline('landgate',
      `AUTO-APPROVED ${ref} → ${newSha.slice(0, 8)} on ${project.name} — ${commits.length} commit(s) from `
      + `${xell?.slug || 'unknown'} (auto-approve policy, no human review)`);
    await recordLandedHead(project, newSha);
    return { allow: true, reason: 'auto-approved', request: row };
  }

  // ── IS THE RUNWAY FREE? ──────────────────────────────────────────────────────
  // One open landing per ref. If ANOTHER xell already has a landing open on this ref, this push does
  // not become a second card — it enters the HOLDING PATTERN with a position, and its zee is told so
  // and nudged when the runway clears. Two cards for one runway is the deadlock: a human approves
  // one, the ref moves, and the other can never fast-forward.
  //
  // Two deliberate exemptions:
  //   • the SAME xell pushing again — that is the "one open landing per zee" case, and the answer to
  //     it is `zee land --withdraw` (061), not a queue. Sequencing a zee behind itself would leave it
  //     waiting for a runway it is already standing on.
  //   • an UNATTRIBUTED push (no xell resolved on either side) — a human pushing by hand, or a sha we
  //     could not match. Hiding that in a queue would hide it from the human who made it, so it is
  //     held for review exactly as before. It is still declined; nothing lands unreviewed.
  const occupant = await runwayOccupant(projectId, ref);
  if (occupant && occupant.xell_id && xell?.id && occupant.xell_id !== xell.id) {
    const held = await one(
      `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, stat,
          status, holding_since, behind_request_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'holding',now(),$8) RETURNING *`,
      [projectId, xell.id, ref, oldSha || null, newSha,
        JSON.stringify(commits), stat ? JSON.stringify(stat) : null, occupant.id]);
    broadcast('land', held);
    activity('x2q', xell?.id, 'land', projectId);
    const position = await holdingPosition(held);
    logline('landgate',
      `HOLDING ${ref.replace('refs/heads/', '')} → ${newSha.slice(0, 8)} on ${project.name} — ${xell.slug} is `
      + `#${position} in the pattern behind ${occupant.xell_slug || 'another xell'}'s landing `
      + `(${String(occupant.new_sha).slice(0, 8)}). No second card was raised; its zee is nudged when the runway clears.`);
    return { allow: false, reason: 'holding', request: held, position, behind: occupant };
  }

  const row = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, stat)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *`,
    [projectId, xell?.id || null, ref, oldSha || null, newSha,
      JSON.stringify(commits), stat ? JSON.stringify(stat) : null]);

  broadcast('land', row);
  // the honeycomb's xell→queenzee line: this xell pushed a land request
  activity('x2q', xell?.id, 'land', projectId);
  logline('landgate',
    `HELD ${ref} → ${newSha.slice(0, 8)} on ${project.name} — ${commits.length} commit(s) from `
    + `${xell?.slug || 'unknown'} awaiting human verification`);
  notifyLandRequest({ project, xell, commits, request: row });
  return { allow: false, reason: 'pending', request: row };
}

// ── THE RUNWAY AND ITS HOLDING PATTERN ───────────────────────────────────────────────────────────
// One runway per (project, ref). It is OCCUPIED while a landing on that ref is open — pending (a
// human is deciding) or approved (the queenzee is landing it). Everything below is about who is on
// it, who is waiting, and what happens the moment it frees.
//
// Nothing here decides anything. Clearance is a NUDGE: the holder's zee syncs and pushes again, and
// THAT push raises a fresh request a human reads. The queue orders who asks first; the gate still
// grants. (The database refuses a holding→approved promotion outright — 067.)

// Who is on the runway right now: the OLDEST open landing on this ref. Oldest, not newest, because
// that is the one a human has been looking at longest and the one the FIFO landing pad will process
// first. `dismissed_at` is deliberately NOT filtered — dismissal hides a receipt, it does not free a
// runway, and an approved-but-hidden landing is still about to move the ref.
export async function runwayOccupant(projectId, ref) {
  return one(
    `SELECT lr.*, x.slug AS xell_slug FROM land_request lr LEFT JOIN xell x ON x.id = lr.xell_id
       WHERE lr.project_id=$1 AND lr.ref=$2 AND lr.kind='push' AND lr.status IN ('pending','approved')
       ORDER BY lr.requested_at ASC, lr.id ASC LIMIT 1`, [projectId, ref]);
}

// Everyone in the pattern for this runway, in the order the tower will call them.
export async function holdingQueue(projectId, ref) {
  return q(
    `SELECT lr.*, x.slug AS xell_slug, x.status AS xell_status FROM land_request lr
       LEFT JOIN xell x ON x.id = lr.xell_id
      WHERE lr.project_id=$1 AND lr.ref=$2 AND lr.kind='push'
        AND lr.status='holding' AND lr.cleared_at IS NULL
      ORDER BY lr.requested_at ASC, lr.id ASC`, [projectId, ref]);
}

// THE APPROACH QUEUE, for a HUMAN — every runway in this project that has somebody waiting, with
// each holder's position, slug and how much work is queued behind the decision on screen.
//
// The console could not show this before and that is the point of it: a human approving a landing
// was looking at ONE card with no way to know that three other zees were stacked behind it. The
// position is numbered here, in SQL, over the same (requested_at, id) order the tower calls them in
// — one ordering, so the number a zee is told and the number a human reads can never disagree.
export async function holdingByRef(projectId) {
  if (!projectId) return [];
  return q(
    `SELECT lr.id, lr.xell_id, lr.ref, lr.new_sha, lr.requested_at, lr.holding_since, lr.attempts,
            lr.behind_request_id, lr.stat, x.slug AS xell_slug,
            jsonb_array_length(lr.commits) AS commit_count,
            row_number() OVER (PARTITION BY lr.project_id, lr.ref
                               ORDER BY lr.requested_at, lr.id)::int AS position
       FROM land_request lr LEFT JOIN xell x ON x.id = lr.xell_id
      WHERE lr.project_id=$1 AND lr.kind='push' AND lr.status='holding' AND lr.cleared_at IS NULL
      ORDER BY lr.ref, lr.requested_at, lr.id`, [projectId]);
}

// This xell's live place(s) in the pattern — what `zee land --withdraw` may lower, and what the
// zee's own status reads. A cleared row is history: it is out of the queue and its zee has been told.
export async function holdingRequests(xellId) {
  if (!xellId) return [];
  return q(
    `SELECT * FROM land_request
       WHERE xell_id=$1 AND kind='push' AND status='holding' AND cleared_at IS NULL
       ORDER BY requested_at ASC`, [xellId]);
}

// 1-based position, COUNTED rather than stored. A stored number would have to be renumbered every
// time a holder leaves, and a queue that lies about position is worse than one that does not report
// it — "you are #3" while two ahead of you have withdrawn is how a zee decides to give up.
export async function holdingPosition(row) {
  if (!row || row.status !== 'holding' || row.cleared_at) return null;
  // Compared against the row AS THE DATABASE HOLDS IT, never against a timestamp round-tripped
  // through JS: postgres keeps timestamptz to the microsecond and a JS Date truncates to the
  // millisecond, so a row passed back in "<= itself" and counted ZERO. A position of null is exactly
  // the thing this whole feature exists to avoid telling a zee.
  const n = await one(
    `SELECT count(*)::int AS n FROM land_request lr,
            (SELECT project_id, ref, requested_at, id FROM land_request WHERE id=$1) me
       WHERE lr.project_id=me.project_id AND lr.ref=me.ref AND lr.kind='push'
         AND lr.status='holding' AND lr.cleared_at IS NULL
         AND (lr.requested_at, lr.id) <= (me.requested_at, me.id)`, [row.id]);
  return n?.n || null;
}

// RELEASE ONE HOLDER. The row stays 'holding' and gains a clearance receipt — it was never decided,
// so it must never be dressed as a decision — and its zee is resumed with the go-around: `zee sync`,
// then `zee land`. Returns whether the zee was actually reached, because the caller uses that to
// decide whether to call the NEXT one instead (a clearance nobody heard clears nobody).
async function clearHolder(row, { reason, by = 'queenzee@runway' } = {}) {
  const branch = (row.ref || '').replace('refs/heads/', '') || 'main';
  const short = String(row.new_sha || '').slice(0, 8);
  const cleared = await one(
    `UPDATE land_request SET cleared_at=now(), cleared_by=$2, clear_reason=$3
       WHERE id=$1 AND status='holding' AND cleared_at IS NULL RETURNING *`,
    [row.id, by, String(reason || 'the runway is clear').slice(0, 2000)]);
  if (!cleared) return { id: row.id, cleared: false };   // somebody else cleared it first
  broadcast('land', cleared);
  logline('landgate',
    `CLEARED ${row.xell_slug || 'a xell'} to land ${short} on ${branch} — ${reason}. `
    + 'Its sha is not approved and nothing has moved: the zee syncs and pushes again for a fresh decision.');

  const nudged = await nudgeXellForClearedRunway(row.xell_id,
    { sha: row.new_sha, ref: row.ref, reason, requestId: row.id })
    .catch((e) => ({ nudged: false, error: e.message }));
  const note = `runway clear (${reason}) — `
    + (nudged?.nudged ? 'the zee was nudged to `zee sync` and land again'
      : `nothing to nudge (${nudged?.reason || nudged?.error || 'no cxell zee'})`);
  // Same race as closeAsStale: the resume is fire-and-forget, so an undeliverable one may already
  // have written the truthful "could NOT be reached" receipt. Whoever knows delivery FAILED wins.
  const noted = await one(
    `UPDATE land_request SET note=$2 WHERE id=$1 AND note IS NULL RETURNING *`, [row.id, note])
    .catch(() => null);
  if (noted) broadcast('land', noted);
  return { id: row.id, cleared: true, nudged: !!nudged?.nudged, xell_id: row.xell_id };
}

// THE TOWER. Called after every transition that frees a runway (a landing, a rejection, a
// withdrawal, a stale close) and again on the land-reaper tick as the backstop. Idempotent by
// construction: it does nothing while the runway is still occupied, so it is safe to call from
// anywhere, and a missed call self-heals within a tick instead of stranding the queue.
//
// It clears until somebody actually HEARS it. A holder whose cxell is gone is tended (a human must
// know a zee is waiting on a runway it can no longer be told about) and the next in line is called —
// otherwise one dead zee at the head of the pattern would keep the runway empty forever.
export async function clearRunway(projectId, ref, { reason = 'the runway is clear' } = {}) {
  const occupant = await runwayOccupant(projectId, ref);
  if (occupant) return { cleared: [], busy: true, occupant: occupant.id };
  const queue = await holdingQueue(projectId, ref);
  if (!queue.length) return { cleared: [], empty: true };
  const cleared = [];
  for (const holder of queue) {
    const r = await clearHolder(holder, { reason }).catch((e) => {
      logline('landgate', `could not clear holder ${String(holder.id).slice(0, 8)}: ${e.message}`);
      return { id: holder.id, cleared: false };
    });
    cleared.push(r);
    if (r.nudged) break;               // it has the runway now; the rest keep their place in line
  }
  return { cleared };
}

// Fire-and-forget clearance for the transitions that free a runway. Never awaited by a landing path:
// a landing must not fail, slow down, or roll back because a holder's cxell is unreachable.
function freeRunway(projectId, ref, reason) {
  if (!projectId || !ref) return;
  setImmediate(() => clearRunway(projectId, ref, { reason }).catch((e) => {
    logline('landgate', `clearing the runway for ${String(ref).replace('refs/heads/', '')} failed: ${e.message}`);
  }));
}

// A REAPED XELL MUST NOT HOLD A PLACE IN LINE. Its zee is gone: it will never sync, never re-push,
// and clearing it would only tend a corpse — but left in the pattern it inflates every position
// behind it and, at the head, wastes a clearance on nobody. So it is swept out of the queue with an
// honest receipt (and no nudge: there is nothing to nudge).
export async function sweepHoldingPattern() {
  const rows = await q(
    `SELECT lr.id, lr.new_sha, lr.ref, x.slug, x.status AS xell_status FROM land_request lr
       LEFT JOIN xell x ON x.id = lr.xell_id
      WHERE lr.status='holding' AND lr.cleared_at IS NULL AND lr.kind='push'
        AND (lr.xell_id IS NULL OR x.id IS NULL OR x.status='retired') LIMIT 20`);
  let swept = 0;
  for (const row of rows) {
    const gone = await one(
      `UPDATE land_request SET cleared_at=now(), cleared_by='queenzee@sweep',
          clear_reason='the xell was retired while it held — swept out of the pattern so it does not '
                     || 'hold a place nobody will ever take'
        WHERE id=$1 AND status='holding' AND cleared_at IS NULL RETURNING *`, [row.id]).catch(() => null);
    if (!gone) continue;
    broadcast('land', gone);
    logline('landgate',
      `swept ${row.slug || 'a retired xell'}'s holding request ${String(row.new_sha).slice(0, 8)} out of the `
      + `${String(row.ref).replace('refs/heads/', '')} pattern — the xell is ${row.xell_status || 'gone'}`);
    swept++;
  }
  return { swept };
}

// ── A CLEARANCE NOBODY ANSWERED ───────────────────────────────────────────────────────────────────
// clearHolder's nudge is fire-and-forget: `nudged: true` means the resume STARTED. Undeliverable is
// handled (nudge.js tends a human and the tower calls the next holder), but DELIVERED-THEN-DIED was
// not: the receipt says the zee was told, the row leaves the pattern (every queue read filters
// `cleared_at IS NULL`), and nothing ever returns to it. The zee waits forever for a clearance it
// already received and lost, with unlanded commits and no card anywhere. (#11, confirmed by #19.)
//
// The ruling: re-clear ONCE, then tend. Once because the cheap failure is a lost nudge; a tend rather
// than a retry loop because a zee that ignores two clearances is a human's problem, not a schedule's.
//
// THE PERIOD is the landing pad's RECEIPT_MIN (5 minutes) — the only minute-scale window the runway's
// own machinery already keeps, and the same idea: how long to wait before treating something as
// settled. It times both stages, so a silent holder is re-called at ~5 minutes and handed to a human at
// ~10. LAND_CLEARANCE_GRACE_MIN overrides it (the tests set 0 to exercise both stages deterministically
// rather than sleeping through them).
const CLEARANCE_GRACE_MIN = process.env.LAND_CLEARANCE_GRACE_MIN !== undefined
  ? Number(process.env.LAND_CLEARANCE_GRACE_MIN) : RECEIPT_MIN;

// "It never came back" — no land_request from this xell on this ref was raised after the clearance.
// ANY status counts as coming back (pending, holding, landed, even stale): the zee acted, and what
// happened next is the gate's business, not this sweep's. Checked in SQL against the row as the
// database holds it, for the same reason holdingPosition is (µs vs ms round-tripping through JS).
export async function sweepSilentClearances({ graceMin = CLEARANCE_GRACE_MIN } = {}) {
  const rows = await q(
    `SELECT lr.*, x.slug AS xell_slug,
            round(EXTRACT(EPOCH FROM (now() - lr.cleared_at)) / 60)::int AS silent_min
       FROM land_request lr JOIN xell x ON x.id = lr.xell_id
      WHERE lr.kind='push' AND lr.status='holding'
        AND lr.cleared_at IS NOT NULL AND lr.silence_tended_at IS NULL
        AND x.status NOT IN ('retired','tearing-down')
        AND COALESCE(lr.recleared_at, lr.cleared_at) <= now() - ($1 || ' minutes')::interval
        AND NOT EXISTS (SELECT 1 FROM land_request nx
                         WHERE nx.xell_id = lr.xell_id AND nx.ref = lr.ref AND nx.kind='push'
                           AND nx.id <> lr.id AND nx.requested_at > lr.cleared_at)
      ORDER BY lr.cleared_at ASC LIMIT 20`, [String(graceMin)]);
  let recalled = 0, tended = 0;
  for (const row of rows) {
    const short = String(row.new_sha || '').slice(0, 8);
    const branch = String(row.ref || '').replace('refs/heads/', '') || 'main';
    if (!row.recleared_at) {
      // ONE re-call. The timestamp is written FIRST and guarded, so two ticks (or two queenzees)
      // cannot both decide they are the one re-call — the loser simply finds the row already stamped.
      const marked = await one(
        `UPDATE land_request SET recleared_at=now()
           WHERE id=$1 AND status='holding' AND cleared_at IS NOT NULL AND recleared_at IS NULL
           RETURNING *`, [row.id]).catch(() => null);
      if (!marked) continue;
      broadcast('land', marked);
      logline('landgate',
        `RE-CALLED ${row.xell_slug || 'a xell'} to land ${short} on ${branch} — it was cleared `
        + `~${row.silent_min}m ago and has not pushed since, so the first clearance was probably lost with `
        + 'its session. Nothing is approved and nothing has moved; it syncs and pushes for a fresh decision.');
      const nudged = await nudgeXellForLostClearance(row.xell_id,
        { sha: row.new_sha, ref: row.ref, minutes: row.silent_min, requestId: row.id })
        .catch((e) => ({ nudged: false, error: e.message }));
      // The note is OVERWRITTEN here (unlike clearHolder's write-once): the first clearance's receipt is
      // no longer the current state of this row, and a receipt that still says "the zee was nudged" is
      // the exact lie this whole path exists to correct. An undeliverable re-call has already written
      // its own truthful note (nudge.js), so leave that one alone.
      const note = `runway clear, then silence (~${row.silent_min}m) — re-called ONCE: `
        + (nudged?.nudged ? 'the zee was resumed again to `zee sync` and land'
          : `the zee could NOT be reached (${nudged?.reason || nudged?.error || 'no live cxell'})`);
      if (!nudged?.tended) {
        const noted = await one(`UPDATE land_request SET note=$2 WHERE id=$1 RETURNING *`, [row.id, note])
          .catch(() => null);
        if (noted) broadcast('land', noted);
      }
      recalled++;
      continue;
    }
    // Re-called and STILL silent: this is a human's now. Stamp first (same race guard), then raise it.
    const done = await one(
      `UPDATE land_request SET silence_tended_at=now()
         WHERE id=$1 AND recleared_at IS NOT NULL AND silence_tended_at IS NULL RETURNING *`, [row.id])
      .catch(() => null);
    if (!done) continue;
    broadcast('land', done);
    // NOT swallowed silently: the tend IS the outcome of this branch, so a failure to raise it must be
    // said out loud. Swallowing it would recreate the very shape of bug this sweep exists to close —
    // a row that records a human was told, and a human who was not.
    const raised = await tendForSilentClearance(row.xell_id,
      { sha: row.new_sha, ref: row.ref, minutes: row.silent_min, requestId: row.id })
      .catch((e) => ({ tended: false, error: e.message }));
    if (!raised?.tended) {
      logline('landgate',
        `could NOT raise a tend for ${row.xell_slug || 'a xell'}'s lost clearance `
        + `(${raised?.error || 'the xell is gone'}) — its row is stamped, so nothing will retry this`);
    }
    logline('landgate',
      `${row.xell_slug || 'a xell'} was cleared to land ${short} on ${branch} ~${row.silent_min}m ago and `
      + 'never pushed, through TWO clearances — handed to a human (tend). Nothing further is automatic.');
    tended++;
  }
  return { checked: rows.length, recalled, tended };
}

// The backstop half of the tower: every runway that has somebody waiting gets looked at once a tick,
// so a clearance missed by a crashed/restarted process (or by a transition path added later that
// forgets to call freeRunway) is never lost — it just happens a few seconds later.
async function driveRunways() {
  const runways = await q(
    `SELECT DISTINCT project_id, ref FROM land_request
       WHERE status='holding' AND cleared_at IS NULL AND kind='push'`);
  let cleared = 0;
  for (const r of runways) {
    const out = await clearRunway(r.project_id, r.ref, { reason: 'the runway is clear' })
      .catch(() => ({ cleared: [] }));
    cleared += (out.cleared || []).filter((c) => c.cleared).length;
  }
  return { runways: runways.length, cleared };
}

// What a WAITING zee polls (scripts/xell-land.mjs --wait). The gate tells a declined zee to
// "re-run the SAME push once a human approves it" and, until this existed, gave it no way to learn
// that had happened — so it either sat blind or re-pushed on a guess. The ship gate has had
// shipStatus() for exactly this since 010; landing never got its half.
export async function landStatus(xellId) {
  const row = await one(
    `SELECT lr.*, x.slug AS xell_slug FROM land_request lr JOIN xell x ON x.id = lr.xell_id
       WHERE lr.xell_id = $1 ORDER BY lr.requested_at DESC LIMIT 1`, [xellId]);
  if (!row || row.status !== 'holding') return row;
  // A state a zee can land in must be a state the zee is TOLD about — and for a holding request the
  // one thing it needs is WHERE IT STANDS. Both waiters read this row (`zee land --wait` via
  // self/status, `xell-land.mjs` via /api/land/status), so the position is attached here, once,
  // rather than computed twice and disagreeing.
  const ahead = row.cleared_at ? null : await runwayOccupant(row.project_id, row.ref);
  return {
    ...row,
    holding_position: await holdingPosition(row),
    holding_behind: ahead ? { id: ahead.id, xell_slug: ahead.xell_slug, new_sha: ahead.new_sha, status: ahead.status } : null,
    // Cleared = the runway freed and this zee was told to go around. It is out of the pattern; the
    // only way back is `zee sync` then `zee land`.
    cleared: !!row.cleared_at,
  };
}

// Every land request of this xell a human is still being asked about — pending (undecided) or
// approved (decided, not yet spent). This is what "don't spam the gate" is measured against: a zee
// that pushes a second sha while the first is still held leaves TWO cards for one job, and only it
// knows which one it still means.
export async function openLandRequests(xellId, { kind = 'push' } = {}) {
  if (!xellId) return [];
  // kind='push' is a LANDING (the gate on main). kind='pull' is a PR into a child xource — a
  // different ask, raised by a different verb, so `zee land --withdraw` must not sweep one up by
  // accident. Pass kind=null to read both (a human tidying up).
  return q(
    `SELECT * FROM land_request
       WHERE xell_id=$1 AND status IN ('pending','approved') AND dismissed_at IS NULL
         AND ($2::text IS NULL OR kind::text = $2)
       ORDER BY requested_at DESC`, [xellId, kind]);
}

// THE ZEE'S OWN RETRACTION — the counterpart to `zee tend --clear` / `zee done --clear`, and the
// exit the landing gate never had.
//
// A held landing is a question a zee asked a human. Until now the zee could not un-ask it: if it
// changed its mind (it found a bug in what it pushed, the work turned out to be half-finished, it
// was handed more scope) its only move was to commit more and push again — raising a SECOND card
// for the same job while the first one sat there, obsolete and indistinguishable. Withdrawing is
// therefore not a "cancel" convenience; it is what makes "one open landing per zee" achievable.
//
// PENDING ONLY, deliberately. An APPROVED request is a decision a human already made and the
// queenzee is acting on (the pad may be mid-merge); pulling it out from under them is not a zee's
// call — that is a `zee tend`. Decided/landed/stale rows are history and history is not editable.
// The row is never deleted: a withdrawn ask is a fact about what this zee did, and it keeps the
// commit list a human may have already read.
export async function withdrawLandRequest(id, by = 'zee', reason = null) {
  const row = await one(`SELECT * FROM land_request WHERE id=$1`, [id]);
  if (!row) throw new Error('no such land request');
  const what = row.kind === 'pull' ? 'PR' : 'landing';
  // HOLDING is withdrawable too, and for the same reason pending is: a zee that no longer means its
  // ask should be able to leave the pattern rather than be called for a runway it does not want. A
  // CLEARED holder has already left it (it was told to sync and re-push), so there is nothing open.
  const holding = row.status === 'holding' && !row.cleared_at;
  if (row.status !== 'pending' && !holding) {
    throw new Error(row.status === 'approved'
      ? `that ${what} is already APPROVED — a human has decided it and the queenzee is landing it; `
        + 'you cannot withdraw a decision (raise a `zee tend` if it must not land)'
      : row.status === 'holding'
        ? `that ${what} was already CLEARED out of the holding pattern — the runway freed and you were told `
          + 'to `zee sync` and `zee land` again. There is nothing left to un-ask'
        : `that ${what} is '${row.status}', not pending — there is nothing open to withdraw`);
  }
  const out = await one(
    `UPDATE land_request SET status='withdrawn', withdrawn_at=now(), withdrawn_by=$2, withdraw_reason=$3
       WHERE id=$1 AND status=$4::land_status AND (status <> 'holding' OR cleared_at IS NULL) RETURNING *`,
    [id, by, reason ? String(reason).slice(0, 2000) : null, row.status]);
  if (!out) throw new Error('no such pending request (already decided?)');
  broadcast('land', out);
  logline('landgate',
    `WITHDRAWN ${String(out.new_sha).slice(0, 8)} on ${out.ref.replace('refs/heads/', '')} by ${by}`
    + `${reason ? ` — ${String(reason).slice(0, 120)}` : ''} (the zee un-asked it; no human decision was made)`
    + `${holding ? ' — it was holding, so it simply leaves the pattern' : ''}`);
  // Withdrawing the OCCUPANT frees the runway; withdrawing a HOLDER just shortens the queue (and
  // clearRunway is a no-op while somebody is still on the runway, so this is safe either way).
  if (out.kind === 'push') freeRunway(out.project_id, out.ref, `${String(out.new_sha).slice(0, 8)} was withdrawn`);
  return out;
}

export async function listLandRequests(projectId, { open = true } = {}) {
  // Open view: undecided or still-working rows a human has NOT dismissed. A dismissed approval
  // keeps being retried by the reaper — it just stops being shown.
  const where = open ? `AND lr.status IN ('pending','approved') AND lr.dismissed_at IS NULL` : '';
  // The reviews (224) carried on this landing's sha — so a human approving a landing knows whether
  // anyone READ the diff, and who. A record, never a gate: nothing here waits on a review.
  return q(
    `SELECT lr.*, x.slug AS xell_slug,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'reviewer', rv.reviewer, 'verdict', rv.verdict::text,
                     'findings_count', rv.findings_count, 'report', rv.report,
                     'created_at', rv.created_at) ORDER BY rv.created_at DESC), '[]'::jsonb)
               FROM review rv WHERE rv.commit_sha = lr.new_sha) AS reviews
       FROM land_request lr LEFT JOIN xell x ON x.id = lr.xell_id
       WHERE lr.project_id = $1 ${where}
       ORDER BY lr.requested_at DESC LIMIT 50`, [projectId]);
}

// A HUMAN decides. `by` is recorded for the audit trail — the console sends the operator, and
// there is deliberately no API path for a zee to approve its own landing.
//
// APPROVING LANDS IT. Until now approving only *authorised* a push and then waited for the zee to
// re-run it — so a human clicked Approve and nothing happened, possibly for hours, because the zee
// had no way to learn the click had occurred. That is not a gate, it is a gate plus a guessing
// game: "approved — waiting for the zee to re-push" sat on the card while the zee sat blind, and
// the attempts counter ticked up as it re-pushed on hunches.
//
// The queenzee has everything it needs the moment you decide: the exact sha, the ref, and the
// approval. So it moves the ref itself — through the SAME update hook, which finds the row we just
// wrote and spends it. No bypass, no new sha, nothing unreviewed: the gate still decides, it just
// stops outsourcing the last step to an agent that cannot see. This is what acceptPullIn() already
// does for PRs; landing never got it.
export async function decideLandRequest(id, decision, by = 'human') {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE land_request SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending request (already decided?)');
  broadcast('land', row);
  logline('landgate', `${decision.toUpperCase()} ${row.new_sha.slice(0, 8)} by ${by}`);
  if (decision !== 'approved') {
    // A rejection frees the runway just as surely as a landing does — the ref did not move, so the
    // next holder's sha may well still be landable. Call it.
    freeRunway(row.project_id, row.ref, `${row.new_sha.slice(0, 8)} was rejected`);
    return row;
  }
  return landApproved(row, by);
}

// Spend an approval: move the ref to the sha a human signed off.
//
// Works even when the xell is RETIRED or its worktree is gone — we push a SHA out of the xource's
// own object store, not from a worktree. That is exactly the case that left nimble-atlas's
// approval dangling under "nothing will re-push it".
// Is this sha still landable on that ref, and is it even still worth trying?
//   'already'  — the ref already contains it. Pushing says "Everything up-to-date" and exits 0,
//                which naive code reads as success and then retries forever because the row never
//                flips (the hook never fires, so nothing marks it landed). Ask first.
//   'ff'       — clean fast-forward. Push it.
//   'diverged' — the ref moved past it. This approval is DEAD: the gate binds an approval to one
//                exact sha, and no amount of retrying makes a non-fast-forward land. Retrying it
//                is a git push every tick, forever, for nothing.
function ffState(repoRoot, ref, sha) {
  const git = (...a) => spawnSync('git', ['-C', repoRoot, ...a],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });
  if (git('merge-base', '--is-ancestor', sha, ref).status === 0) return { state: 'already' };
  const tip = git('rev-parse', ref);
  if (tip.status !== 0) return { state: 'no-ref' };
  const t = tip.stdout.trim();
  return git('merge-base', '--is-ancestor', t, sha).status === 0
    ? { state: 'ff', tip: t } : { state: 'diverged', tip: t };
}

// CLOSE A DEAD LANDING — and TELL THE ZEE. One place, because there are two ways a landing dies of
// staleness (an approval the ref moved past, and a held request the ref moved past while a human
// was still deciding) and both used to end the same way: an honest row, an honest log line, and a
// zee that never heard about it. A cxell zee's turn ENDS at `zee land`; the console is not
// something it can watch. So closing the row is only half the job — the other half is the nudge
// that tells it to `zee sync` and raise a fresh request, which is the only recovery that exists.
//
// The reason goes into the row's `note` too, so the console (and anyone reading the row later) can
// see why it died and whether the zee was actually reached, rather than inferring it from the log.
async function closeAsStale(row, { tip = null, from = 'approved' } = {}) {
  const branch = (row.ref || '').replace('refs/heads/', '') || 'main';
  const short = String(row.new_sha || '').slice(0, 8);
  // A row leaving 'pending' MUST carry a decider (the 009 check constraint `land_decided_has_decider`
  // — no status change without someone's name on it). Nobody decided this one: it died of staleness,
  // and the queenzee is what noticed. Say exactly that rather than borrow a human's name, and
  // COALESCE so an approval that goes stale keeps the human who actually approved it.
  const stale = await one(
    `UPDATE land_request
        SET status='stale', decided_at=COALESCE(decided_at, now()),
            decided_by=COALESCE(decided_by, 'queenzee@stale')
      WHERE id=$1 AND status=$2 RETURNING *`, [row.id, from]);
  if (!stale) return null;                       // someone else decided it first — leave it alone
  broadcast('land', stale);
  logline('landgate',
    `${from === 'pending' ? 'held request' : 'approval'} for ${short} is STALE — ${branch} has moved past it`
    + `${tip ? ` (now ${String(tip).slice(0, 8)})` : ''}, so it can never fast-forward. The gate binds an approval `
    + 'to one exact sha: this one needs a synced branch, a fresh sha and a fresh decision. Closed.');

  // The zee is the only one who can fix this, and it is the one party that could not see it happen.
  // requestId rides along so a delivery that fails AFTER we return can correct this row's receipt —
  // "the zee was nudged" must not outlive the nudge actually failing.
  const nudged = await nudgeXellForStaleLanding(row.xell_id,
    { sha: row.new_sha, ref: row.ref, tip, requestId: row.id })
    .catch((e) => ({ nudged: false, error: e.message }));
  const note = `stale: ${branch} moved past ${short}${tip ? ` (now ${String(tip).slice(0, 8)})` : ''} — `
    + (nudged?.nudged ? 'the zee was nudged to `zee sync` and land again'
      : `nothing to nudge (${nudged?.reason || nudged?.error || 'no cxell zee'})`);
  // `AND note IS NULL` because the nudge can fail ASYNCHRONOUSLY — the resume is fire-and-forget, so
  // an undeliverable one (docker gone, cxell torn down) writes the truthful "could NOT be reached"
  // receipt from its own catch, possibly before we get here. Whoever knows the delivery FAILED wins;
  // this optimistic line must never overwrite it. (Both orders converge on the same final note.)
  const noted = await one(
    `UPDATE land_request SET note=$2 WHERE id=$1 AND note IS NULL RETURNING *`, [row.id, note])
    .catch(() => null);
  if (noted) { broadcast('land', noted); logline('landgate', `${short}: ${note}`); }
  // A landing that died still frees the runway it was occupying — the next holder must not inherit
  // this one's fate by waiting behind a corpse.
  freeRunway(row.project_id, row.ref, `${short} went stale`);
  return noted || (await one(`SELECT * FROM land_request WHERE id=$1`, [row.id]).catch(() => stale)) || stale;
}

// HELD REQUESTS THE REF HAS ALREADY MOVED PAST. A pending landing is a question waiting on a human,
// and the answer can go bad while they are away: another xell lands, and now the sha on the card
// can never fast-forward. Approving it just walks it into closeAsStale a second later — so the
// human is being asked to decide something that has no outcome, and the zee is waiting on an answer
// that cannot help it either way.
//
// Sweep them: close each dead pending row and nudge its zee to sync and ask again with a landable
// sha. Conservative on purpose — ONLY 'diverged' (a proven non-fast-forward) is closed. A sha the
// ref already contains ('already') is a different animal and is left for a human to look at.
// LANDINGS ONLY (kind='push'). A kind='pull' row is a PR into a CHILD xource — a different ask,
// judged against a different repository — so measuring it against this project's repo_root would
// declare it stale on evidence from the wrong tree. `zee land --withdraw` draws the same line.
export async function sweepStalePending() {
  const rows = await q(
    `SELECT lr.*, p.repo_root FROM land_request lr JOIN project p ON p.id = lr.project_id
       WHERE lr.status='pending' AND lr.kind = 'push' ORDER BY lr.requested_at LIMIT 20`);
  let stale = 0;
  for (const row of rows) {
    if (!row.repo_root || !row.new_sha) continue;
    const { state, tip } = ffState(row.repo_root, row.ref, row.new_sha);
    if (state !== 'diverged') continue;
    const closed = await closeAsStale(row, { tip, from: 'pending' }).catch((e) => {
      logline('landgate', `could not close stale request ${String(row.id).slice(0, 8)}: ${e.message}`);
      return null;
    });
    if (closed) stale++;
  }
  return { checked: rows.length, stale };
}

export async function landApproved(row, by = 'human', { mode = PROVISION_MODE } = {}) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [row.project_id]);
  if (!project) return row;

  // A NESTED QUEENZEE MUST NOT MOVE A REF IN THE XOURCE. Everything below this line acts on
  // project.repo_root with git — a real path on a real machine, read out of a fleet row this
  // queenzee may only be MODELLING. Report what it would have landed and touch nothing: no ref, no
  // row (the approval stays approved, because it is the real fleet's to spend), no nudge into the
  // cage of the zee that raised it. In real mode nothing about the rest of this function changes.
  if (mode !== 'real') {
    const short = String(row.new_sha || '').slice(0, 8);
    const branch = String(row.ref || '').replace('refs/heads/', '') || 'main';
    if (!reportedDryLandings.has(row.id)) {
      reportedDryLandings.add(row.id);
      logline('landgate',
        `${short} NOT landed on ${branch} — PROVISION_MODE=simulate: this queenzee models the fleet, it `
        + `does not move refs in ${project.repo_root}. Would have fast-forwarded ${branch} → ${short} `
        + `(approved by ${row.decided_by || by}). The approval is left UNSPENT for the real queenzee; `
        + 'reported once, not once per tick.');
    }
    return { ...row, dry_run: true,
      would_land: { ref: row.ref, sha: row.new_sha, repo_root: project.repo_root } };
  }

  // THE LANDING PAD's FIFO gate. This approval is real, but the runway may be busy (a ship building,
  // another landing merging) or an EARLIER approval may be ahead in line. If so, leave the row
  // 'approved' and wait our turn — the pad driver (or a later tick) picks it up when it reaches the
  // head of the line. A lone approved item is always the head, so nothing changes for the common case.
  if ((await shouldProcessNow(row.project_id, 'landing', row.id)) === 'wait') {
    logline('landgate', `${row.new_sha.slice(0, 8)} QUEUED on the landing pad — waiting its turn (FIFO)`);
    return { ...row, queued: true };
  }

  const { state, tip } = ffState(project.repo_root, row.ref, row.new_sha);

  if (state === 'already') {
    // It is in. Something else landed it (the zee re-pushed, a human pushed by hand) and the row
    // never caught up. Reconcile rather than move: nothing to do to the ref, just record reality.
    const landed = await one(
      `UPDATE land_request SET status='landed', landed_at=COALESCE(landed_at, now())
         WHERE id=$1 RETURNING *`, [row.id]);
    broadcast('land', landed);
    // Its work is on the ref now — make the xell's stored position say so (level, not still-ahead).
    await syncXellAfterLand(row.xell_id, row.new_sha);
    logline('landgate', `${row.new_sha.slice(0, 8)} is already on ${row.ref.replace('refs/heads/', '')} — marking landed`);
    // The ref already contains this sha (landed by some other path) — reconcile the recorded head
    // to the ref's ACTUAL current tip so the rollback baseline stays truthful.
    await recordLandedHead(project, headCommit(project.repo_root, project.main_branch));
    // A cxell zee that raised this landing is waiting to continue — resume its session (best-effort).
    nudgeXellAfterLand(row.xell_id, { by }).catch(() => {});
    freeRunway(row.project_id, row.ref, `${row.new_sha.slice(0, 8)} is already on the ref`);
    return landed || row;
  }

  if (state === 'diverged' || state === 'no-ref') {
    // DEAD, and the ROW says so now. This used to live in an in-memory set — the log quieted down
    // but the row stayed 'approved', so its "waiting for the zee to re-push" receipt rendered
    // forever (and outlived every restart, which also emptied the set and re-ran the futile push).
    // A stale row leaves the open list, the tick's SELECT, and the console in one honest move.
    const stale = await closeAsStale(row, { tip, from: 'approved' });
    return { ...(stale || row), stale: true };
  }

  // THE MERGE MUTEX. Two approvals landing at once would each pass ffState against the same tip
  // and race the ref. Take the project's 'land' lock for exactly the duration of the ref move —
  // acquired here, released in the finally below, never held across a human decision or a build.
  // If someone else is mid-merge, return retryable: the tick (10s) takes it next round.
  const mutex = await one(
    `INSERT INTO deploy_lock (project_id, container, xell_id, phase, task)
       VALUES ($1,'land',$2,'merging',$3)
       ON CONFLICT (project_id, container) DO NOTHING RETURNING id`,
    [row.project_id, row.xell_id, `landing ${row.new_sha.slice(0, 8)}`]);
  if (!mutex) {
    logline('landgate', `${row.new_sha.slice(0, 8)} waiting — another landing holds the merge lock`);
    return { ...row, retry: true };
  }

  // MOVE THE REF WITH update-ref, NOT `git push`. A push re-invokes the xource's `update` hook,
  // which curls back into THIS server — but the server is single-threaded and, having initiated
  // the push, is blocked inside spawnSync waiting for it. The hook times out (curl rc=28), fails
  // closed, and the push is declined. That self-deadlock is the actual cause of "I approved and
  // nothing happened" — verified: /api/land/check answers in 57ms when the loop is free and times
  // out during a server-initiated push. update-ref moves the ref with NO receive-pack hooks, so
  // there is no re-entrancy; it still fires reference-transaction, whose non-ff guard is the
  // backstop, and we only reach here on a proven fast-forward anyway. The old-value arg makes it a
  // compare-and-swap: if the ref moved since ffState read it, this fails instead of clobbering.
  //
  // The hook now retries with backoff before that fail-closed, so a busy (not gone) queenzee
  // answers before the push is declined. update-ref remains the primary land path so the
  // server-initiated land never re-enters the hook at all.
  let u, now;
  try {
    u = spawnSync('git', ['-C', project.repo_root, 'update-ref', row.ref, row.new_sha, tip],
      { encoding: 'utf8', timeout: 30000, windowsHide: true, env: cleanGitEnv() });
    now = spawnSync('git', ['-C', project.repo_root, 'rev-parse', row.ref],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  } finally {
    // Released IMMEDIATELY — the lock covers the ref move, nothing else. A 'land' row that
    // outlives this function is a bug that blocks every future landing.
    await q(`DELETE FROM deploy_lock WHERE id=$1`, [mutex.id]);
  }
  const moved = u.status === 0 && (now.stdout || '').trim() === row.new_sha;

  if (moved) {
    const landed = await one(
      `UPDATE land_request SET status='landed', landed_at=now() WHERE id=$1 RETURNING *`, [row.id]);
    broadcast('land', landed);
    // The ref just moved to include this xell's work — sync its stored head/last-synced to the landed
    // sha so its diff reads level (0/0) instead of the frozen provisioning base it forked from.
    await syncXellAfterLand(row.xell_id, row.new_sha);
    logline('landgate', `LANDED ${row.new_sha.slice(0, 8)} → ${row.ref.replace('refs/heads/', '')} (approved by ${row.decided_by || by})`);
    // The xource ref just advanced — re-record its head so the rollback baseline tracks the land
    // (a ff, so this contains the old head and warns about nothing). Advisory: never blocks a land.
    await recordLandedHead(project, row.new_sha);
    // Primary async-continuation: if a CXELLD zee raised this, resume its session so it ships/does
    // done with no human re-invocation. Best-effort and logged (a dead cxell just logs).
    nudgeXellAfterLand(row.xell_id, { by }).catch(() => {});
    // The runway is free again — pull the next item onto the pad promptly rather than waiting for
    // the next tick. Best-effort: the tick is the backstop.
    setImmediate(() => processPad(row.project_id).catch(() => {}));
    // …and call whoever has been holding for THIS ref. (Different queues: the pad orders what the
    // queenzee ACTS on across both lanes; the runway orders which zee gets to ASK next.)
    freeRunway(row.project_id, row.ref, `${row.new_sha.slice(0, 8)} landed`);
    return landed || row;
  }

  // Left 'approved' on purpose: the approval is still valid for this exact sha, so a retry is
  // legitimate — tick() below will take it. Say why the ref did not move rather than let a green
  // tick lie about it.
  const out = `${u.stdout || ''}${u.stderr || ''}`.trim();
  logline('landgate',
    `approved ${row.new_sha.slice(0, 8)} but ${row.ref.replace('refs/heads/', '')} did NOT move: `
    + (out.split('\n').filter(Boolean).pop() || 'update-ref failed'));
  return { ...row, push_failed: out.slice(-800) };
}

// APPROVALS NOBODY SPENT. decideLandRequest lands on the click, so in the normal case this finds
// nothing. It exists for the ones that slip through anyway, because the failure is silent and
// indistinguishable from working: an 'approved' row renders a green tick and a "waiting for the
// zee to re-push" that may wait forever.
//
// Real examples, both live when this was written: an approval granted before landing auto-landed
// (a human clicked, a zee never came back), and one whose xell was reaped afterwards so nothing
// existed to re-push it at all. A transient push failure lands here too.
export async function tick() {
  // Dead rows are 'stale' in the DB now, so this SELECT simply stops finding them — no in-memory
  // been-there set to leak, forget across restarts, or consult.
  const stuck = await q(
    `SELECT * FROM land_request WHERE status='approved' ORDER BY decided_at LIMIT 5`);
  let landed = 0, stale = 0, dryRun = 0;
  for (const row of stuck) {
    const r = await landApproved(row).catch((e) => { logline('landgate', `retry failed: ${e.message}`); return null; });
    // A landing this queenzee is not allowed to make is counted SEPARATELY, never as landed: the
    // tick's own answer is the first place a "did it land?" question gets asked.
    if (r && r.dry_run) dryRun++;
    if (r && r.status === 'landed' && !r.dry_run) landed++;
    if (r && r.stale) stale++;
  }
  // …and the HELD requests that died while a human was away (see sweepStalePending). Same tick, so
  // a zee learns its landing is dead within seconds of it becoming dead, not when someone clicks.
  const swept = await sweepStalePending().catch((e) => {
    logline('landgate', `stale sweep failed: ${e.message}`); return { checked: 0, stale: 0 };
  });
  // …and the HOLDING PATTERN: drop the holders whose xell has been reaped (they will never take the
  // runway), then call whoever is next on every runway that is standing free. Both are backstops —
  // each freeing transition already calls the tower — so in the normal case they find nothing.
  const gone = await sweepHoldingPattern().catch((e) => {
    logline('landgate', `holding sweep failed: ${e.message}`); return { swept: 0 };
  });
  const runways = await driveRunways().catch((e) => {
    logline('landgate', `runway drive failed: ${e.message}`); return { runways: 0, cleared: 0 };
  });
  // …and the holders that WERE cleared and then went quiet: re-call each one once, then hand it to a
  // human. This is the only path that ever looks at a cleared row again — every queue read has already
  // filtered it out — so without it a lost clearance is permanent.
  const silent = await sweepSilentClearances().catch((e) => {
    logline('landgate', `silent-clearance sweep failed: ${e.message}`); return { recalled: 0, tended: 0 };
  });
  return { checked: stuck.length, landed, dry_run: dryRun, stale: stale + swept.stale,
    pending_checked: swept.checked, holding_swept: gone.swept, runways: runways.runways,
    holders_cleared: runways.cleared, recalled: silent.recalled, silence_tended: silent.tended };
}

// "Seen it — stop showing me." A durable fact about VISIBILITY, never about status: a dismissed
// approval still lands or goes stale on its own schedule, just quietly. Pending is refused here
// for the same reason the card offers it no ✕: a held landing is a zee blocked on a human, and
// sweeping that off the screen is how it gets forgotten.
export async function dismissLandRequest(id, by = 'human@console') {
  const row = await one(
    `UPDATE land_request SET dismissed_at=now(), dismissed_by=$2
       WHERE id=$1 AND status <> 'pending' RETURNING *`, [id, by]);
  if (!row) throw new Error('no such request (or it is still pending — decide it, don\'t hide it)');
  broadcast('land', row);
  return row;
}

export function startLandReaper() {
  if (process.env.LAND_REAPER_ENABLED === 'false') {
    console.log('[queenzee] land reaper DISABLED');
    return null;
  }
  const interval = Number(process.env.LAND_TICK_MS) || 10000;
  setInterval(() => tick().catch((e) => console.error('[landgate] tick:', e.message)), interval);
  console.log(`[queenzee] land reaper started (${interval}ms) — spends approvals nobody acted on`);
  return true;
}
