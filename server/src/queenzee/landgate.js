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
export async function decideLandRequest(id, decision, by = 'human') {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE land_request SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending request (already decided?)');
  broadcast('land', row);
  logline('landgate', `${decision.toUpperCase()} ${row.new_sha.slice(0, 8)} by ${by}`);
  return row;
}
