// Reaper — despawns a xell once a HUMAN marks its task done.
// Deterministic teardown: release resources → remove worktree/branch → retire rows.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { cleanGitEnv } from '../lib/git.js';
import { logline } from '../lib/logbus.js';

export async function reapXell(xellId, reason = 'task-done') {
  const xell = await one(`SELECT * FROM xell WHERE id = $1`, [xellId]);
  if (!xell) return { ok: false, error: 'xell not found' };
  if (xell.is_production) return { ok: false, error: 'production is protected — cannot be decommissioned by a zee' };

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
    despawn = { code: r.status, stdout: (r.stdout || '').slice(-2000), stderr: (r.stderr || '').slice(-1000) };
  }

  // drop this xell's per-xell containers from the meta DB
  await q(`DELETE FROM container WHERE owner_xell_id = $1`, [xellId]);

  const retired = await one(
    `UPDATE xell SET status='retired', retired_at=now(), is_pooled=false WHERE id=$1 RETURNING *`, [xellId]);
  broadcast('xell', retired);
  logline('reaper', `retired ${xell.slug}: zee decommissioned, per-xell containers dropped ✓`);

  return { ok: true, reason, despawn, zee_id: zee?.id };
}
