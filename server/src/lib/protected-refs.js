// The landing gate's protected-ref list — the queenzee's half of hooks/land-gate-update.sh.
//
// The hook decides "is this ref gated?" from a LOCAL file rather than by asking this server, and
// that is deliberate: an unreachable queenzee must not fail closed on every push to every branch.
// See the note in the hook. The cost of that choice is this file — the list has to be kept in step
// with the xource table from out here, because the hook cannot ask.
//
// Rewritten whenever a xource appears or disappears. Cheap (a handful of lines), idempotent, and
// safe to call on every provision: writing the same content twice costs nothing.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { cleanGitEnv } from './git.js';
import { logline } from './logbus.js';

export function protectedRefsPath(repoRoot) {
  // --path-format=absolute for the same reason install-land-gate.sh needs it: the bare answer is
  // a RELATIVE '.git', which would resolve against this process's cwd and write the list into
  // whatever repo the server happens to be running from.
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) return null;
  return join(r.stdout.trim(), 'zeehive-protected-refs');
}

// Every xource ref of this project, as full refs. main is always among them (it is the root
// xource); a xell that is itself a xource contributes its spinoff/ branch.
export async function writeProtectedRefs(projectId) {
  const project = await one(`SELECT id, name, repo_root, main_branch FROM project WHERE id=$1`, [projectId]);
  if (!project) return null;
  const path = protectedRefsPath(project.repo_root);
  if (!path) return null;

  const rows = await q(`SELECT ref FROM xource WHERE project_id=$1 ORDER BY ref`, [projectId]);
  const refs = rows.map((r) => `refs/heads/${r.ref}`);

  // The root branch is protected whether or not a xource row says so. If a bad query or a partial
  // migration ever emptied this list, the failure mode would be silent: pushes to main stop being
  // gated and nobody finds out until something lands unreviewed. Belt and braces.
  const mainRef = `refs/heads/${project.main_branch || 'main'}`;
  if (!refs.includes(mainRef)) refs.push(mainRef);

  const body = `${refs.join('\n')}\n`;
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before === body) return { path, refs, changed: false };

  writeFileSync(path, body);
  logline('landgate', `protected refs updated (${refs.length}): ${refs.map((r) => r.replace('refs/heads/', '')).join(', ')}`);
  return { path, refs, changed: true };
}
