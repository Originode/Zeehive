// Builds the git-timeline payload the web app renders on the left rail, plus each xell's
// anchor commit (its worktree base) so the frontend can draw a connector to the card.
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { gitLog, diffStat, worktreeDiff, worktreeHead } from './git.js';
import { defaultProject } from './fleet.js';

// Per-xell divergence vs its tracked xource (ahead/behind + shortstat).
//
// Measured from the WORKTREE, not from the stored head_commit. head_commit is the commit the xell
// was provisioned at — the same value for every xell cut from one tip — so diffing it against main
// made every card show an identical number and hid the zee's actual work entirely (a zee could
// commit, or have a dirty tree, and the card never moved). Falls back to the old base-vs-source
// comparison only when there is no worktree on disk (simulate mode).
export async function getDiffs(projectId) {
  const project = projectId ? await one(`SELECT * FROM project WHERE id=$1`, [projectId]) : await defaultProject();
  if (!project) return {};
  const branch = project.main_branch || 'main';
  const xells = await q(
    `SELECT id, head_commit, worktree_path, is_production FROM xell
       WHERE project_id=$1 AND status<>'retired'`,
    [project.id]);

  // Production is a xell, so it gets a diff too — it was excluded here, which is precisely why it
  // could drift unwatched. Its CONTENT is whatever the last successful ship deployed, and its
  // xource is origin, so its diff answers "has what is live drifted from the backup?".
  //
  // NULL until a ship actually lands: prod's current code predates the ship gate and was deployed
  // by hand, so nothing recorded what it is. A blank beats a guess about production.
  const shipped = await one(
    `SELECT commit FROM ship_request WHERE project_id=$1 AND status='shipped'
       ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [project.id]);

  const out = {};
  for (const x of xells) {
    if (x.is_production) {
      out[x.id] = shipped?.commit
        ? diffStat(project.repo_root, shipped.commit, `origin/${branch}`)
        : null;
      continue;
    }
    out[x.id] = x.worktree_path && existsSync(x.worktree_path)
      ? await worktreeDiff(x.worktree_path, branch)
      : (x.head_commit ? diffStat(project.repo_root, x.head_commit, branch) : null);
  }
  return out;
}

// stable, distinct connector colors per xell
const COLORS = ['#e0a53b', '#e26fae', '#9ccf3f', '#5b8cff', '#35c46b', '#9b8cff', '#e5554e', '#3bc6c0'];

export async function getTimeline(projectId, n = 30) {
  const project = projectId ? await one(`SELECT * FROM project WHERE id=$1`, [projectId]) : await defaultProject();
  if (!project) return null;
  const branch = project.main_branch || 'main';
  const commits = gitLog(project.repo_root, branch, n);
  const known = new Set(commits.map((c) => c.hash));

  const xells = await q(
    `SELECT id, slug, branch, head_commit, status, worktree_path
       FROM xell WHERE project_id=$1 AND status<>'retired' AND NOT is_production
       ORDER BY created_at`, [project.id]);

  const anchored = xells.map((x, i) => {
    // Anchor to where the xell ACTUALLY sits now — its live worktree HEAD — not the frozen
    // head_commit (the provisioning base). Once its work lands, HEAD is a real commit on the branch
    // (in `known`), so the connector snaps to the tip instead of dangling at the old fork point and
    // making a level xell look "behind". Fall back to the stored base, then the tip.
    const live = x.worktree_path && existsSync(x.worktree_path) ? worktreeHead(x.worktree_path) : null;
    const base = live && known.has(live) ? live
      : x.head_commit && known.has(x.head_commit) ? x.head_commit
      : commits[0]?.hash;
    return {
      id: x.id, slug: x.slug, branch: x.branch, status: x.status,
      worktree_path: x.worktree_path, base_commit: base, head: live, color: COLORS[i % COLORS.length],
    };
  });

  return { branch, repo_root: project.repo_root, commits, xells: anchored };
}
