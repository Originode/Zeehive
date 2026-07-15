// Per-xell IMAGE lifecycle — the garbage nobody was collecting.
//
// A spinoff image is ~1.3 GB (server + webapp ≈ 2.6 GB per xell). Teardown was supposed to remove
// them, but it delegated to the project's `spin-env.sh purge` run FROM INSIDE THE WORKTREE — so
// the moment a worktree is missing, broken, or the purge fails, the images leak silently and
// nobody ever notices. As of 2026-07-15 the NAS held 140 GB of images, 131 GB reclaimable, with
// 12 orphaned spinoff images (~15 GB) whose xells had been retired long ago.
//
// The queenzee already knows each container's exact `image_tag`, so it can do this itself, by
// name, without the worktree existing. Two levels:
//   1. removeXellImages() — teardown's --rm: drop THIS xell's images when it is decommissioned.
//   2. sweepOrphanSpinImages() — the janitor: images whose tag is no longer any live xell's slug
//      (i.e. left behind by a teardown that failed before this existed).
import { spawnSync } from 'node:child_process';
import { q } from '../db/pool.js';
import { logline } from './logbus.js';

function docker(ctx, args, timeout = 120000) {
  const r = spawnSync('docker', ['--context', ctx, ...args],
    { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// Remove images by exact tag.
//
// NEVER `rmi -f`. Force UNTAGS an image that a container is still using: the container keeps
// running on the image id, but the tag is gone, so the next restart/recreate of that environment
// fails with "image not found". Plain `rmi` makes DOCKER the judge — it refuses when a container
// depends on the image, which is the only authority that actually knows. This matters more than
// it looks: this machine runs pre-ZEEHIVE /spin:spinoff worktrees whose images use the SAME
// naming, are invisible to the xell table, and are very much in use. A dry run flagged 12 such
// images as "orphans"; all 12 were backing running containers.
//
// A missing image is not an error worth shouting about (a previous purge may have got there
// first), but a real failure must be visible — a silently-skipped rmi is how 15 GB accumulated.
function rmi(ctx, tags) {
  const removed = [], failed = [], inUse = [];
  for (const tag of tags) {
    const r = docker(ctx, ['rmi', tag]);
    if (r.status === 0) removed.push(tag);
    else if (/No such image|reference does not exist/i.test(r.err)) { /* already gone — fine */ }
    else if (/being used by|is using its referenced image|container/i.test(r.err)) inUse.push(tag);
    else failed.push({ tag, err: (r.err || '').trim().split('\n').pop() });
  }
  return { removed, failed, inUse };
}

// Which images does ANY container on this context still depend on (running or not)? Docker's own
// answer, so it covers environments ZEEHIVE has never heard of.
function imagesInUse(ctx) {
  const r = docker(ctx, ['ps', '-a', '--format', '{{.Image}}'], 60000);
  if (r.status !== 0) return null;   // unknown → caller must not delete anything
  return new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean));
}

// TEARDOWN --rm: called by the reaper BEFORE it deletes the container rows (those rows are the
// only record of which images belong to this xell).
export async function removeXellImages(xellId, slug) {
  const cs = await q(
    `SELECT image_tag, docker_ctx FROM container
       WHERE owner_xell_id = $1 AND image_tag IS NOT NULL AND docker_ctx IS NOT NULL`, [xellId]);
  if (!cs.length) return { removed: [], failed: [] };

  const byCtx = new Map();
  for (const c of cs) {
    if (!byCtx.has(c.docker_ctx)) byCtx.set(c.docker_ctx, []);
    byCtx.get(c.docker_ctx).push(c.image_tag);
  }
  const all = { removed: [], failed: [] };
  for (const [ctx, tags] of byCtx) {
    const r = rmi(ctx, tags);
    all.removed.push(...r.removed); all.failed.push(...r.failed);
  }
  if (all.removed.length) {
    logline('reaper', `reclaimed ${all.removed.length} image(s) from ${slug} (~${(all.removed.length * 1.3).toFixed(1)} GB): ${all.removed.join(', ')}`);
  }
  for (const f of all.failed) logline('reaper', `image rmi FAILED for ${f.tag}: ${f.err} — it will be swept later`);
  return all;
}

// THE JANITOR: spinoff images whose tag is not a live xell's slug. Deliberately narrow — it only
// ever touches repositories that this project's OWN per-xell containers use (derived from the DB,
// never hardcoded), and only tags that match no live xell. It is not `docker image prune -a`:
// a blanket prune on a shared NAS would eat the dev stack, prod images and anyone else's work.
export async function sweepOrphanSpinImages({ dryRun = false } = {}) {
  // Which image repositories are per-xell ones, and on which context? Ask the data.
  const rows = await q(
    `SELECT DISTINCT split_part(image_tag, ':', 1) AS repo, docker_ctx
       FROM container
      WHERE owner_xell_id IS NOT NULL AND image_tag IS NOT NULL AND docker_ctx IS NOT NULL`);
  if (!rows.length) return { swept: 0, reason: 'no per-xell image repos known yet' };

  // q() returns the ROWS, not a pg result — `.rows` here silently yielded undefined and threw.
  const live = new Set((await q(`SELECT slug FROM xell WHERE status <> 'retired'`)).map((r) => r.slug));

  let swept = 0;
  const byCtx = new Map();
  for (const r of rows) {
    if (!byCtx.has(r.docker_ctx)) byCtx.set(r.docker_ctx, new Set());
    byCtx.get(r.docker_ctx).add(r.repo);
  }

  for (const [ctx, repos] of byCtx) {
    const ls = docker(ctx, ['images', '--format', '{{.Repository}}:{{.Tag}}'], 60000);
    if (ls.status !== 0) { logline('maint', `image sweep: cannot list images on ${ctx} — ${ls.err.trim().slice(0, 120)}`); continue; }

    // "Not a live xell" is NOT sufficient to delete. This host also runs pre-ZEEHIVE
    // /spin:spinoff environments that use the same image names and are invisible to the xell
    // table — every one of them looked like an orphan. Ask docker what is actually in use, and
    // if docker won't say, delete NOTHING.
    const used = imagesInUse(ctx);
    if (!used) { logline('maint', `image sweep: cannot read containers on ${ctx} — skipping (refusing to delete blind)`); continue; }

    const orphans = ls.out.split('\n').map((s) => s.trim()).filter(Boolean).filter((img) => {
      const [repo, tag] = [img.slice(0, img.lastIndexOf(':')), img.slice(img.lastIndexOf(':') + 1)];
      if (!repos.has(repo)) return false;         // not a per-xell repo → none of our business
      if (!tag || tag === 'latest') return false; // the base/shared tag is not a xell's
      if (live.has(tag)) return false;            // tag IS the slug; a live xell owns it
      if (used.has(img)) return false;            // SOMETHING still runs on it (maybe not ours)
      return true;
    });
    if (!orphans.length) continue;
    if (dryRun) { logline('maint', `image sweep (dry run): ${orphans.length} orphan(s) on ${ctx}: ${orphans.join(', ')}`); swept += orphans.length; continue; }
    const r = rmi(ctx, orphans);
    swept += r.removed.length;
    if (r.removed.length) {
      logline('maint', `image sweep: reclaimed ${r.removed.length} orphaned spinoff image(s) on ${ctx} `
        + `(~${(r.removed.length * 1.3).toFixed(1)} GB) — their xells are retired: ${r.removed.join(', ')}`);
    }
    // Belt and braces: docker refused because something depends on it after all. Not an error —
    // it is the guard doing its job (see rmi()).
    if (r.inUse.length) logline('maint', `image sweep: left ${r.inUse.length} image(s) alone — a container still uses them: ${r.inUse.join(', ')}`);
    for (const f of r.failed) logline('maint', `image sweep: rmi failed for ${f.tag}: ${f.err}`);
  }
  return { swept };
}

// Periodic janitor. OFF by default is wrong here — the leak is silent and unbounded — but it must
// be disableable, and it must never run more often than it can finish.
export function startImageJanitor() {
  if (process.env.IMAGE_JANITOR_ENABLED === 'false') {
    console.log('[queenzee] image janitor DISABLED (IMAGE_JANITOR_ENABLED=false)');
    return;
  }
  const interval = Number(process.env.IMAGE_JANITOR_MS) || 3600000; // hourly
  const dryRun = process.env.IMAGE_JANITOR_DRY_RUN === 'true';
  const tick = () => sweepOrphanSpinImages({ dryRun }).catch((e) => console.error('[images] sweep:', e.message));
  setTimeout(tick, 60000);          // not at boot — let the fleet settle first
  setInterval(tick, interval);
  console.log(`[queenzee] image janitor started (${interval}ms${dryRun ? ', DRY RUN' : ''})`);
}
