// Landing helpers — assess a pooled xell against the source and decide its fate. The git
// probe/fast-forward lives in scripts/land-xell.sh (queenzee runs it, like provision/despawn);
// these helpers just interpret its verdict. Used by the pool reconciler and by claim, so a zee
// only ever starts on a xell that is exactly at the source tip (diff 0,0).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { cleanGitEnv } from '../lib/git.js';

// How far behind the source a pooled xell may be before we decommission instead of catch up.
export const MAX_BEHIND = Number(process.env.LAND_MAX_BEHIND) || 200;

// Run the land script → { reason, head, ahead, behind }. reason ∈ current|landed (good) |
// dirty|diverged|too-far|ff-failed|no-worktree (decommission). null on hard failure.
export function landOne(worktree, source, maxBehind = MAX_BEHIND) {
  if (!worktree || !existsSync(worktree)) return { reason: 'no-worktree', head: null, ahead: 0, behind: 0 };
  const script = resolve(config.repoRoot, 'scripts', 'land-xell.sh');
  const r = spawnSync('bash', [script, worktree, source, String(maxBehind)], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, env: cleanGitEnv(),
  });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return null; }
}

// A xell is landable (→ stays/becomes ready) only when it ends up exactly at the source tip.
export function isAtSourceTip(res) {
  return !!res && (res.reason === 'current' || res.reason === 'landed') && res.ahead === 0 && res.behind === 0;
}

// Reconcile ONE pooled xell to the source. Returns 'ready' (caught up / already current) or
// 'decommission' (dirty, diverged, too far behind, or ff impossible). Updates head_commit and
// enforces the invariant: status='ready' ONLY when diff is (0,0).
export async function reconcileXell(xell, source, maxBehind = MAX_BEHIND) {
  const res = landOne(xell.worktree_path, source, maxBehind);
  if (isAtSourceTip(res)) {
    const row = await one(
      `UPDATE xell SET status='ready', is_pooled=true,
           head_commit=$2, last_synced_commit=$2,
           ready_at = CASE WHEN status='ready' THEN ready_at ELSE now() END
         WHERE id=$1 AND status IN ('ready','provisioning','husk') RETURNING *`,
      [xell.id, res.head || xell.head_commit]);
    if (row) broadcast('xell', row);
    return { verdict: 'ready', res };
  }
  return { verdict: 'decommission', res };
}
