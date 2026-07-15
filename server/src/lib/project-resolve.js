// Which project is this /xell about?
//
// Both claim and dispatch used `project || (SELECT id FROM project ORDER BY created_at LIMIT 1)`
// — the OLDEST row, i.e. OmniBiz, no matter where the caller was standing. Run /xell from
// D:\Repos\Zeehive and the queenzee would happily hand you an OmniBiz worktree. The invoker
// knows which project it is in; it just never said so.
//
// Resolution order, most-explicit first. There is NO default: guessing wrong means a zee edits
// the wrong repo, so an unresolvable cwd refuses and says which projects exist.
import { q, one } from '../db/pool.js';

function norm(p) { return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }

// cwd is the root itself, or somewhere beneath it (a session in apps/web is still in the project).
function under(cwd, root) { return !!root && (cwd === root || cwd.startsWith(`${root}/`)); }

export class UnknownProject extends Error {
  constructor(detail) { super(detail.message); this.code = 'UNKNOWN_PROJECT'; this.detail = detail; }
}

export async function listProjects() {
  return q(`SELECT id, name, repo_root FROM project ORDER BY created_at`);
}

async function refuse(cwd, tried) {
  const projects = await listProjects();
  return new UnknownProject({
    status: 'unknown-project',
    your_cwd: cwd || null,
    projects: projects.map((p) => ({ id: p.id, name: p.name, repo_root: p.repo_root })),
    message: tried
      ? `no project named "${tried}" — known projects: ${projects.map((p) => p.name).join(', ')}`
      : `cannot tell which project "${cwd || '(no cwd)'}" belongs to — it is not inside any known `
        + `repo_root or xell worktree. Pass the project explicitly (--project <name>). `
        + `Known projects: ${projects.map((p) => `${p.name} (${p.repo_root})`).join(', ')}`,
  });
}

// { project?: uuid|name, cwd?: string, xell_id?: uuid } → project id. Throws UnknownProject.
export async function resolveProjectId({ project, cwd, xell_id } = {}) {
  // A named xell settles it outright — its project is a fact, not an inference.
  if (xell_id) {
    const x = await one(`SELECT project_id FROM xell WHERE id=$1`, [xell_id]);
    if (x) return x.project_id;
  }

  if (project) {
    const p = await one(`SELECT id FROM project WHERE id::text = $1 OR lower(name) = lower($1)`, [String(project)]);
    if (!p) throw await refuse(cwd, String(project));
    return p.id;
  }

  if (cwd) {
    const c = norm(cwd);
    let best = null;
    const take = (id, root) => {
      const r = norm(root);
      if (under(c, r) && (!best || r.length > best.len)) best = { id, len: r.length };
    };
    // Xell worktrees first: they can live outside their repo_root (legacy spinoffs do), and when
    // they don't, longest-prefix still picks the same project as the repo root would.
    for (const x of await q(`SELECT project_id, worktree_path FROM xell WHERE worktree_path IS NOT NULL`)) {
      take(x.project_id, x.worktree_path);
    }
    for (const p of await listProjects()) take(p.id, p.repo_root);
    if (best) return best.id;
  }

  throw await refuse(cwd, null);
}
