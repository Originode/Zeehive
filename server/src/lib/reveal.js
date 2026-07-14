// Open a location in the host's file manager. Paths come from our own DB (xell worktrees),
// never from arbitrary user input — same safety posture as the backup reveal.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { one } from '../db/pool.js';

function openDir(dir) {
  if (process.platform === 'win32') spawnSync('explorer.exe', [dir], { windowsHide: true });
  else if (process.platform === 'darwin') spawnSync('open', [dir]);
  else spawnSync('xdg-open', [dir], { windowsHide: true });
}

// Reveal a xell's worktree folder in Explorer/Finder (looked up by id).
export async function revealXellWorktree(xellId) {
  const x = await one(`SELECT worktree_path, slug FROM xell WHERE id=$1`, [xellId]);
  if (!x?.worktree_path) throw new Error('xell has no worktree');
  const dir = resolve(x.worktree_path);
  if (!existsSync(dir)) throw new Error('worktree not found on disk');
  openDir(dir);
  return { ok: true, path: dir, slug: x.slug };
}
