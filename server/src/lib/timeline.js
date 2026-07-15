// Builds the git-timeline payload the web app renders on the left rail, plus each xell's
// anchor commit (its worktree base) so the frontend can draw a connector to the card.
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { gitLog, diffStat, worktreeDiff } from './git.js';
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
    `SELECT id, head_commit, worktree_path FROM xell
       WHERE project_id=$1 AND status<>'retired' AND NOT is_production`,
    [project.id]);
  const out = {};
  for (const x of xells) {
    out[x.id] = x.worktree_path && existsSync(x.worktree_path)
      ? worktreeDiff(x.worktree_path, branch)
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
    // anchor to the xell's base commit if it's in the window, else the tip (commits[0])
    const base = x.head_commit && known.has(x.head_commit) ? x.head_commit : commits[0]?.hash;
    return {
      id: x.id, slug: x.slug, branch: x.branch, status: x.status,
      worktree_path: x.worktree_path, base_commit: base, color: COLORS[i % COLORS.length],
    };
  });

  return { branch, repo_root: project.repo_root, commits, xells: anchored };
}
