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
import { logline } from '../lib/logbus.js';
import { gitLog, diffStat, cleanGitEnv } from '../lib/git.js';
import { spawnSync } from 'node:child_process';
import { notifyLandRequest } from '../lib/notify.js';

const ZERO = /^0+$/;

// The commits a push would ADD to main (old..new), newest first — what the human actually reviews.
// Safe to read from the xource: xell worktrees SHARE its object store, so the zee's commits are
// already there; the push only moves the ref. (Nothing is quarantined for a same-repo push.)
function pushedCommits(repoRoot, oldSha, newSha, limit = 50) {
  const range = !oldSha || ZERO.test(oldSha) ? newSha : `${oldSha}..${newSha}`;
  const SEP = '\x1f';
  const r = spawnSync('git', ['-C', repoRoot, 'log', `--pretty=format:%h${SEP}%s${SEP}%an`,
    '-n', String(limit), range], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) return [];
  return (r.stdout || '').split('\n').filter(Boolean).map((line) => {
    const [short, subject, author] = line.split(SEP);
    return { short, subject, author };
  });
}

// Which xell is pushing? The hook can't tell us (receive-pack runs in the xource, not the
// worktree), so match the sha to the xell whose branch contains it. Best-effort and purely
// informational — an unmatched push is still gated, it just shows as "unknown" in the console.
async function resolveXell(projectId, repoRoot, newSha) {
  const xells = await q(
    `SELECT id, slug, branch FROM xell
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
export async function checkPush({ projectId, ref, oldSha, newSha }) {
  const project = await one(`SELECT * FROM project WHERE id = $1`, [projectId]);
  if (!project) return { allow: false, reason: 'unknown-project', request: null };

  // A ref DELETION of main is never something a zee should be doing. No approval path: refuse.
  if (!newSha || ZERO.test(newSha)) {
    logline('landgate', `DECLINED deletion of ${ref} on ${project.name}`);
    return { allow: false, reason: 'deletion-refused', request: null };
  }

  const approved = await one(
    `SELECT * FROM land_request
       WHERE project_id=$1 AND ref=$2 AND new_sha=$3 AND status='approved'`,
    [projectId, ref, newSha]);

  if (approved) {
    // Spend the approval: it authorised this sha once. The ref is about to move (the hook exits
    // 0 on our answer), so mark it landed now — if the push then fails, the next attempt needs a
    // fresh decision. Conservative on purpose: an unspent approval is a standing invitation.
    const row = await one(
      `UPDATE land_request SET status='landed', landed_at=now() WHERE id=$1 RETURNING *`, [approved.id]);
    broadcast('land', row);
    logline('landgate', `ALLOWED ${ref} → ${newSha.slice(0, 8)} on ${project.name} (approved by ${approved.decided_by})`);
    return { allow: true, reason: 'approved', request: row };
  }

  // No approval → this push is a REQUEST. Upsert so a retrying zee bumps attempts instead of
  // filling the console with duplicate cards for the same sha.
  const existing = await one(
    `SELECT * FROM land_request
       WHERE project_id=$1 AND ref=$2 AND new_sha=$3 AND status IN ('pending','rejected')
       ORDER BY requested_at DESC LIMIT 1`, [projectId, ref, newSha]);

  if (existing && existing.status === 'rejected') {
    logline('landgate', `DECLINED ${ref} → ${newSha.slice(0, 8)} on ${project.name} (previously rejected)`);
    return { allow: false, reason: 'rejected', request: existing };
  }

  if (existing) {
    const row = await one(
      `UPDATE land_request SET attempts = attempts + 1 WHERE id=$1 RETURNING *`, [existing.id]);
    broadcast('land', row);
    return { allow: false, reason: 'pending', request: row };
  }

  const commits = pushedCommits(project.repo_root, oldSha, newSha);
  const xell = await resolveXell(projectId, project.repo_root, newSha);

  // Store what a human reviewing a LANDING needs: how much lands, not divergence. diffStat's
  // ahead/behind are relative to a base and read backwards here (its `behind` is the count of
  // commits this push ADDS), so take only the size fields and label the count ourselves.
  const d = diffStat(project.repo_root, ZERO.test(oldSha || '') ? null : oldSha, newSha);
  const stat = d
    ? { commits: commits.length, files: d.files, insertions: d.insertions, deletions: d.deletions }
    : { commits: commits.length };

  const row = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, stat)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *`,
    [projectId, xell?.id || null, ref, oldSha || null, newSha,
      JSON.stringify(commits), stat ? JSON.stringify(stat) : null]);

  broadcast('land', row);
  logline('landgate',
    `HELD ${ref} → ${newSha.slice(0, 8)} on ${project.name} — ${commits.length} commit(s) from `
    + `${xell?.slug || 'unknown'} awaiting human verification`);
  notifyLandRequest({ project, xell, commits, request: row });
  return { allow: false, reason: 'pending', request: row };
}

// What a WAITING zee polls (scripts/xell-land.mjs --wait). The gate tells a declined zee to
// "re-run the SAME push once a human approves it" and, until this existed, gave it no way to learn
// that had happened — so it either sat blind or re-pushed on a guess. The ship gate has had
// shipStatus() for exactly this since 010; landing never got its half.
export async function landStatus(xellId) {
  return one(
    `SELECT lr.*, x.slug AS xell_slug FROM land_request lr JOIN xell x ON x.id = lr.xell_id
       WHERE lr.xell_id = $1 ORDER BY lr.requested_at DESC LIMIT 1`, [xellId]);
}

export async function listLandRequests(projectId, { open = true } = {}) {
  const where = open ? `AND lr.status IN ('pending','approved')` : '';
  return q(
    `SELECT lr.*, x.slug AS xell_slug
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
  if (decision !== 'approved') return row;
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

// Ids already reported as unlandable. Without this the tick re-reports every 10s and the log
// becomes the noise it is meant to cut through.
const staleReported = new Set();

async function landApproved(row, by = 'human') {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [row.project_id]);
  if (!project) return row;

  const { state, tip } = ffState(project.repo_root, row.ref, row.new_sha);

  if (state === 'already') {
    // It is in. Something else landed it (the zee re-pushed, a human pushed by hand) and the row
    // never caught up. Reconcile rather than move: nothing to do to the ref, just record reality.
    const landed = await one(
      `UPDATE land_request SET status='landed', landed_at=COALESCE(landed_at, now())
         WHERE id=$1 RETURNING *`, [row.id]);
    broadcast('land', landed);
    logline('landgate', `${row.new_sha.slice(0, 8)} is already on ${row.ref.replace('refs/heads/', '')} — marking landed`);
    return landed || row;
  }

  if (state === 'diverged' || state === 'no-ref') {
    if (!staleReported.has(row.id)) {
      staleReported.add(row.id);
      logline('landgate',
        `approval for ${row.new_sha.slice(0, 8)} is STALE — ${row.ref.replace('refs/heads/', '')} has `
        + 'moved past it, so it can never fast-forward. The gate binds an approval to one exact sha: '
        + 'this one needs a fresh commit and a fresh decision. Not retrying it.');
    }
    return { ...row, stale: true };
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
    broadcast('xell', { id: row.xell_id });
    logline('landgate', `LANDED ${row.new_sha.slice(0, 8)} → ${row.ref.replace('refs/heads/', '')} (approved by ${row.decided_by || by})`);
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
  const stuck = await q(
    `SELECT * FROM land_request WHERE status='approved' ORDER BY decided_at LIMIT 5`);
  let landed = 0, stale = 0;
  for (const row of stuck) {
    if (staleReported.has(row.id)) { stale++; continue; }   // known dead — do not push again
    const r = await landApproved(row).catch((e) => { logline('landgate', `retry failed: ${e.message}`); return null; });
    if (r && r.status === 'landed') landed++;
    if (r && r.stale) stale++;
  }
  return { checked: stuck.length, landed, stale };
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
