import { statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logline } from './logbus.js';

// When is it SAFE to delete a git index.lock — the ONE rule, shared by every path that self-heals
// a stale lock (the collect step in cxell.js and the catch-up in xellgit.js). Two copies of this
// rule would drift, and the one that drifts is the one that deletes a LIVE git process's lock and
// corrupts somebody's work — so it lives here, once, and both paths import it.
//
// A git index.lock older than this is STALE — no live git op holds one this long (a lock lives for
// the duration of a single index-touching command: merge/stash/commit/…, seconds at most). A
// crashed or killed process leaves one behind forever, and every later index-touching command then
// dies with "Unable to create '.../index.lock': File exists". The 5-minute margin is generous
// enough that a genuinely live op is never mistaken for a stale lock.
export const STALE_INDEX_LOCK_MS = 5 * 60 * 1000;

// If a STALE index.lock exists in the worktree admin dir (for a linked worktree that is
// <repo>/.git/worktrees/<name>, which is exactly where every `git -C <worktree>` index-touching
// command looks for it), remove it and log the FULL path so `zee ops --alerts` finally names the
// file. Returns true when a lock was removed. A FRESH lock is NEVER deleted — a live git process
// may be holding it; the caller then fails exactly as today.
//
// `tag`/`reason` let each caller log under its own scope and say what the retry was FOR — the
// default preserves the original collect-path wording, so a caller with no opinion gets the same
// log line it always had.
export function clearStaleIndexLock(adminDir, slug, { tag = 'cxell', reason = 'the collect could retry' } = {}) {
  const lockPath = join(adminDir, 'index.lock');
  let st;
  try { st = statSync(lockPath); } catch { return false; }
  if (Date.now() - st.mtimeMs < STALE_INDEX_LOCK_MS) return false;
  try {
    rmSync(lockPath, { force: true });
    logline(tag, `${slug ? `${slug}: ` : ''}cleared a STALE index.lock at ${lockPath} `
      + `(${Math.round((Date.now() - st.mtimeMs) / 1000)}s old) so ${reason}`);
    return true;
  } catch {
    return false;
  }
}
