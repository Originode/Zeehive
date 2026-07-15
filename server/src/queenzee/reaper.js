// Reaper — despawns a xell once a HUMAN marks its task done.
// Deterministic teardown: release resources → remove worktree/branch → retire rows.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { cleanGitEnv } from '../lib/git.js';
import { removeXellImages } from '../lib/images.js';
import { logline } from '../lib/logbus.js';

export async function reapXell(xellId, reason = 'task-done', { force = false } = {}) {
  const xell = await one(`SELECT * FROM xell WHERE id = $1`, [xellId]);
  if (!xell) return { ok: false, error: 'xell not found' };
  if (xell.is_production) return { ok: false, error: 'production is protected — cannot be decommissioned by a zee' };

  // An ACTIVE xell has a zee still working in it. Tearing it down kills the agent mid-task and
  // deletes its worktree + branch. Refuse unless the caller explicitly forces it — this lives on
  // the server, not just the UI, because a UI-only guard is bypassed by anyone (human OR AI)
  // calling the API directly. That is exactly how a working xell got destroyed.
  if (!force) {
    const live = await one(
      `SELECT id, status, cli_active FROM zee
        WHERE xell_id=$1 AND status IN ('spawning','online','working','idle') ORDER BY created_at DESC LIMIT 1`,
      [xellId]);
    const active = live && (live.cli_active === true || ['spawning', 'online', 'working'].includes(live.status));
    if (active) {
      return {
        ok: false, active: true, xell: xell.slug,
        error: `xell "${xell.slug}" is ACTIVE — its zee is still ${live.status}`
             + `${live.cli_active ? ' (monitor confirms it is really active)' : ''}.`
             + ' Tearing it down kills the agent mid-task and deletes its worktree + branch.'
             + ' Pass force:true to do it anyway.',
      };
    }
  }

  logline('reaper', `decommissioning ${xell.slug} (${reason}) — releasing resources, removing worktree + branch`);
  await one(`UPDATE xell SET status='tearing-down' WHERE id=$1 RETURNING *`, [xellId])
    .then((x) => x && broadcast('xell', x));

  // stop the zee
  const zee = await one(
    `UPDATE zee SET status='stopped', name=NULL, decommissioned_at=now()
       WHERE xell_id=$1 AND status IN ('spawning','online','working','idle') RETURNING *`, [xellId]);
  if (zee) broadcast('zee', zee);

  // deterministic despawn script (purge containers, remove worktree/branch).
  // Only run it when the worktree actually exists on disk — in simulate mode the
  // worktree was never created, so there is nothing to tear down.
  const script = resolve(config.repoRoot, 'scripts', 'despawn-xell.sh');
  let despawn = { skipped: true };
  if (existsSync(script) && xell.worktree_path && existsSync(xell.worktree_path)) {
    const r = spawnSync('bash', [script, xell.worktree_path], {
      cwd: config.omnibizRoot, encoding: 'utf8', timeout: 120000,
      env: cleanGitEnv({ SPINOFF_DOCKER_CONTEXT: config.dockerCtx }),
    });
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
    let verdict = null; try { verdict = JSON.parse(line); } catch { /* no JSON line */ }
    despawn = { code: r.status, ...(verdict || {}), stderr: (r.stderr || '').slice(-600) };
  }

  // --rm SEMANTICS: reclaim this xell's built images BEFORE dropping the container rows — those
  // rows are the only record of which image_tags were its. The despawn script above tries to purge
  // them too, but only via `spin-env.sh purge` run from INSIDE the worktree: if the worktree is
  // gone/broken (or the purge silently failed), ~2.6 GB per xell leaks with nobody watching. The
  // queenzee knows the exact tags, so it does not need the worktree to clean up after itself.
  await removeXellImages(xellId, xell.slug).catch((e) => logline('reaper', `image cleanup failed for ${xell.slug}: ${e.message}`));

  // drop this xell's per-xell containers from the meta DB
  await q(`DELETE FROM container WHERE owner_xell_id = $1`, [xellId]);

  const retired = await one(
    `UPDATE xell SET status='retired', retired_at=now(), is_pooled=false WHERE id=$1 RETURNING *`, [xellId]);
  broadcast('xell', retired);

  // The DB row is retired either way (the xell is gone as far as the fleet is concerned), but do
  // NOT report a clean teardown when the folder is still on disk — that is how orphaned worktrees
  // pile up unnoticed. Say it plainly instead.
  const orphaned = xell.worktree_path && existsSync(xell.worktree_path);
  if (orphaned) {
    logline('reaper', `retired ${xell.slug} BUT its worktree is still on disk: ${xell.worktree_path} — ${despawn.reason || 'despawn failed'}`);
  } else {
    logline('reaper', `retired ${xell.slug}: zee decommissioned, worktree + containers removed ✓`);
  }

  return { ok: true, reason, orphaned_worktree: orphaned ? xell.worktree_path : null, despawn, zee_id: zee?.id };
}
