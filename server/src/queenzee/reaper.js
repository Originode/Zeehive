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
import { resolveBash } from '../lib/bash.js';
import { resolveSite } from '../lib/sites.js';
import { dropCloneDb } from '../lib/xell-db.js';
import { removeCage } from '../lib/cage.js';
import { releaseXellShips } from './shipgate.js';

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

  // ── SHIPS AND THE PROD LOCK GO WITH THE XELL ────────────────────────────────
  // Open ship requests are withdrawn, a stranded 'shipping' row is completed from evidence, and
  // the xell's deploy lock is released — BEFORE teardown, or "done" leaves a card reading
  // "shipping now" forever with prod locked under it (2026-07-18, the whole night). The one case
  // that blocks instead: a ship this queenzee is actively deploying right now — force does not
  // override that either, because yanking prod's lock mid-build is worse than waiting.
  const ships = await releaseXellShips(xellId, `done:${reason}`);
  if (!ships.ok) return { ok: false, error: ships.error };

  // ── PRODUCTION IS DISCONNECTED, NEVER TORN DOWN ─────────────────────────────
  // A /xell-prod xell has the LIVE production db, server and webapp as its assigned containers.
  // Marking it done must release them, not reap them.
  //
  // Today nothing below could delete them anyway: every teardown path is scoped by ownership —
  // `DELETE FROM container WHERE owner_xell_id=$1`, removeXellImages' same filter, and
  // spin-env.sh purge's `omnibiz-spin-<slug>` project on the DEV context — and prod's containers
  // are shared, so owner_xell_id is NULL and they match none of it.
  //
  // That is ownership saving us, not intent. Nothing here SAYS "never delete prod". One change
  // from `owner_xell_id = $1` to a xell_uses_container join — an entirely reasonable-looking
  // refactor, since that junction is what the card renders from — and marking a data xell done
  // would delete production. So: state the rule, and unlink FIRST, before any teardown machinery
  // runs. After this point the xell has no prod containers to lose.
  const prodLinks = await q(
    `SELECT c.name, c.role FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1 AND c.tier = 'prod'`, [xellId]);
  if (prodLinks.length) {
    await q(
      `DELETE FROM xell_uses_container uc USING container c
        WHERE uc.container_id = c.id AND uc.xell_id = $1 AND c.tier = 'prod'`, [xellId]);
    // Drop the coupling too, so a half-torn-down row can never answer the prod guard with "yes".
    await q(`UPDATE xell SET db_coupling='db-shared-dev' WHERE id=$1 AND db_coupling='db-shared-prod'`, [xellId]);
    logline('reaper',
      `${xell.slug} was bound to PRODUCTION — DISCONNECTED ${prodLinks.map((c) => c.name).join(', ')} `
      + '(released, NOT deleted) before teardown. Production is untouched.');
  }

  logline('reaper', `decommissioning ${xell.slug} (${reason}) — releasing resources, removing worktree + branch`);
  await one(`UPDATE xell SET status='tearing-down' WHERE id=$1 RETURNING *`, [xellId])
    .then((x) => x && broadcast('xell', x));

  // A db-clone xell owns a DATABASE inside the shared dev postgres (its db_instance row) — drop
  // it, or every retired schema-work xell leaks a full copy of dev into the container. Best-
  // effort: a failed drop logs and the teardown continues, and the instance row it leaves behind
  // is exactly how the leak stays visible (discovery flags it as an orphan).
  {
    const dropped = await dropCloneDb(xell).catch((e) => ({ ok: false, error: e.message }));
    if (dropped?.ok === false) {
      logline('reaper', `could not drop ${xell.slug}'s clone database: ${dropped.error} — its `
        + 'db_instance row stays as the orphan record');
    }
  }

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
    // Despawn on the xell's OWN machine — its containers' stamped context, which since machines
    // (023) can differ per xell. The project dev site and the global env default are fallbacks
    // for rows that predate stamping; purging on the wrong daemon removes nothing and leaks.
    const project = await one(`SELECT repo_root FROM project WHERE id=$1`, [xell.project_id]);
    const ownCtx = (await one(
      `SELECT docker_ctx FROM container WHERE owner_xell_id=$1 AND role='server' AND docker_ctx IS NOT NULL LIMIT 1`,
      [xellId]))?.docker_ctx || null;
    const devSite = await resolveSite(xell.project_id, 'dev');
    const r = spawnSync(resolveBash(), [script, xell.worktree_path], {
      cwd: project?.repo_root || config.omnibizRoot, encoding: 'utf8', timeout: 120000,
      env: cleanGitEnv({ SPINOFF_DOCKER_CONTEXT: ownCtx || devSite?.docker_ctx || config.dockerCtx }),
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

  // the xell's zee CAGE, if a caged zee ever ran here (lib/cage.js) — it idles sealed on the
  // queenzee's local daemon after its turn so commits stay collectible; retirement is the point
  // of no return, so it goes too. Best-effort like the rest: a leak is visible in `docker ps`
  // by its zeehive.cage label.
  await removeCage({ ctx: 'default', slug: xell.slug }).catch((e) => logline('reaper', `cage cleanup failed for ${xell.slug}: ${e.message}`));

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
