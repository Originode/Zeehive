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
//      (i.e. left behind by a teardown that failed before this existed), plus stale prepped cxell
//      images whose template hash no project needs any more.
import { spawnSync } from 'node:child_process';
import { q } from '../db/pool.js';
import { logline } from './logbus.js';
import { namingFor } from './manifest.js';
import { normalizeSpawnPrep, preppedImageTag } from './spawn-prep.js';

// Same switch every other real-side-effect module reads (intake, pool, xell-db, machines, harness,
// reaper, the .zeehive.env reconcile): 'real' touches machines, anything else models. The ORPHAN
// SWEEP below obeys it — it is a timer that deletes images by name, and the names come from fleet
// rows (a tag is a xell slug). A xell's database is a CLONE of the meta-DB taken at provision time,
// so a NESTED queenzee's "live xells" are a SNAPSHOT of the real fleet: every xell created after it
// looks retired, and its images look like orphans. Hence report-only there (see the janitor's own
// default below, which keeps IMAGE_JANITOR_DRY_RUN as the separate operator switch it always was).
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// Prepped cxell images are baked as zeehive/zee-agent-prep:<hash> (lib/spawn-prep.js). The base
// image name can be overridden (CXELL_IMAGE / a device project's cxell_image) but the prep repo
// itself is fixed — see preppedImageTag().
const PREP_REPO = 'zeehive/zee-agent-prep';
const DEFAULT_CXELL_IMAGE = process.env.CXELL_IMAGE || 'zeehive/zee-agent';

function docker(ctx, args, timeout = 120000) {
  const r = spawnSync('docker', ['--context', ctx, ...args],
    { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// repo:tag → repo. Uses the LAST colon so a registry host:port prefix stays intact
// (`localhost:5000/omnibiz-spin-server:slug` → `localhost:5000/omnibiz-spin-server`).
// split_part(image_tag, ':', 1) is WRONG for that shape — it returned only `localhost`.
export function repoOf(imageTag) {
  if (!imageTag || typeof imageTag !== 'string') return null;
  const i = imageTag.lastIndexOf(':');
  if (i <= 0) return null;
  const repo = imageTag.slice(0, i).trim();
  const tag = imageTag.slice(i + 1).trim();
  if (!repo || !tag || repo === '<none>' || tag === '<none>') return null;
  return repo;
}

export function tagOf(imageTag) {
  if (!imageTag || typeof imageTag !== 'string') return null;
  const i = imageTag.lastIndexOf(':');
  if (i <= 0) return null;
  const tag = imageTag.slice(i + 1).trim();
  return tag && tag !== '<none>' ? tag : null;
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
// only record of which images belong to this xell). Also tries the project's naming templates as
// a fallback: a row that lost its image_tag (rename edge, partial provision) still has a
// deterministic tag of the form `{project}-spin-{role}:{slug}`, and leaving those behind is how
// the NAS filled up when teardown could not name what to delete.
export async function removeXellImages(xellId, slug) {
  // build_ctx too: a split build (compile-here / run-there) leaves the SAME image_tag on the build
  // host as well as the run host. Miss it and the beefy build host slowly fills the way the NAS did.
  const cs = await q(
    `SELECT c.image_tag, c.docker_ctx, c.build_ctx, c.role, p.name AS project_name, p.manifest
       FROM container c
       JOIN project p ON p.id = c.project_id
      WHERE c.owner_xell_id = $1 AND c.docker_ctx IS NOT NULL`, [xellId]);
  if (!cs.length) return { removed: [], failed: [] };

  const byCtx = new Map();
  const add = (ctx, tag) => {
    if (!ctx || !tag) return;
    if (!byCtx.has(ctx)) byCtx.set(ctx, new Set());
    byCtx.get(ctx).add(tag);
  };
  for (const c of cs) {
    const tags = new Set();
    if (c.image_tag) tags.add(c.image_tag);
    // Naming fallback for server/webapp only — db images are shared (postgres:…) and must never
    // be reaped as if they belonged to one xell.
    if (c.role === 'server' || c.role === 'webapp') {
      try {
        const nm = namingFor({ name: c.project_name, manifest: c.manifest }, c.role, slug);
        if (nm?.image) tags.add(nm.image);
      } catch { /* naming must not block teardown */ }
    }
    for (const tag of tags) {
      add(c.docker_ctx, tag);
      if (c.build_ctx && c.build_ctx !== c.docker_ctx) add(c.build_ctx, tag);
    }
  }
  if (![...byCtx.values()].some((s) => s.size)) return { removed: [], failed: [] };

  const all = { removed: [], failed: [], dangling: 0 };
  for (const [ctx, tagSet] of byCtx) {
    const r = rmi(ctx, [...tagSet]);
    all.removed.push(...r.removed); all.failed.push(...r.failed);
    // Untagging frees the previous build as dangling — reclaim it now, not on the next hourly tick.
    // Same narrow prune the janitor uses (dangling only, never -a).
    if (r.removed.length) {
      const d = pruneDanglingBuilds(ctx, { dryRun: false });
      all.dangling += d.pruned || 0;
    }
  }
  if (all.removed.length) {
    logline('reaper', `reclaimed ${all.removed.length} image(s) from ${slug} (~${(all.removed.length * 1.3).toFixed(1)} GB): ${all.removed.join(', ')}`);
  }
  for (const f of all.failed) logline('reaper', `image rmi FAILED for ${f.tag}: ${f.err} — it will be swept later`);
  return all;
}

// Per-xell image REPOSITORIES this fleet is allowed to reclaim. Two sources, both data:
//   1. image_tag on owned container rows (what is actually built today)
//   2. each project's naming templates (what WOULD be built — survives total retirement of a
//      project's xells, which is exactly when the old "only live rows" query went blind)
// Never a hardcoded list of project names: a new project onboards itself via its manifest.
export async function discoverPerXellRepos() {
  const repos = new Set();
  const tags = await q(
    `SELECT DISTINCT image_tag FROM container
      WHERE owner_xell_id IS NOT NULL AND image_tag IS NOT NULL`);
  for (const r of tags) {
    const repo = repoOf(r.image_tag);
    if (repo) repos.add(repo);
  }
  const projects = await q(`SELECT name, manifest FROM project`);
  for (const p of projects) {
    // Process-runner projects (Zeehive itself) still have naming defaults; their spinoff
    // server/webapp rows carry image_tag NULL on purpose. Deriving the repo is harmless — the
    // daemon simply has no such images — and a compose project that later switches runners is
    // covered without another code change.
    for (const role of ['server', 'webapp']) {
      try {
        const nm = namingFor(p, role, '_');
        const repo = repoOf(nm?.image);
        if (repo) repos.add(repo);
      } catch { /* skip a broken manifest row */ }
    }
  }
  return repos;
}

// Every docker context the janitor must walk. Live container rows alone are not enough: when the
// last xell on a machine is reaped its container rows go with it, and a scan scoped to "contexts
// that still have an owned image_tag" would permanently skip that machine's leftover images.
// Machines + every ctx ever stamped on a container + the implicit default covers the fleet.
export async function discoverDockerContexts() {
  const ctxs = new Set(['default']);
  const rows = await q(
    `SELECT DISTINCT ctx FROM (
        SELECT docker_ctx AS ctx FROM container WHERE docker_ctx IS NOT NULL
        UNION ALL
        SELECT build_ctx  AS ctx FROM container WHERE build_ctx  IS NOT NULL
        UNION ALL
        SELECT docker_ctx AS ctx FROM machine   WHERE docker_ctx IS NOT NULL AND enabled
     ) t WHERE ctx IS NOT NULL AND length(trim(ctx)) > 0`);
  for (const r of rows) ctxs.add(String(r.ctx).trim());
  return ctxs;
}

// Prepped cxell image tags any current spawn template still needs. Anything else under
// zeehive/zee-agent-prep: is residue from a package-list change (the tag is a content hash, so
// old tags are never reused and never cleaned by spinoff-slug logic).
export async function neededPrepImageTags() {
  const needed = new Set();
  // Honour a device project's cxell_image override when present on the manifest — the prep tag
  // is hash(base + packages), so a different base is a different tag.
  const rows = await q(
    `SELECT pc.spawn_prep, p.manifest
       FROM pool_config pc
       JOIN project p ON p.id = pc.project_id`);
  for (const r of rows) {
    const prep = normalizeSpawnPrep(r.spawn_prep ?? null);
    const base = r.manifest?.device?.cxell_image || DEFAULT_CXELL_IMAGE;
    const tag = preppedImageTag(base, prep);
    if (tag) needed.add(tag);
  }
  return needed;
}

// Classify one `repo:tag` line from `docker images` against the live-slug + in-use guards.
// Pure: the test pins the rules without a daemon.
export function isOrphanSpinImage(img, { repos, live, used }) {
  if (!img || img.includes('://')) return false;
  const i = img.lastIndexOf(':');
  if (i <= 0) return false;
  const repo = img.slice(0, i);
  const tag = img.slice(i + 1);
  if (!repos.has(repo)) return false;         // not a per-xell repo → none of our business
  if (!tag || tag === 'latest' || tag === '<none>') return false; // base/shared / dangling
  if (live.has(tag)) return false;            // tag IS the slug; a live xell owns it
  if (used && used.has(img)) return false;    // SOMETHING still runs on it (maybe not ours)
  return true;
}

export function isOrphanPrepImage(img, { needed, used }) {
  if (!img) return false;
  const i = img.lastIndexOf(':');
  if (i <= 0) return false;
  const repo = img.slice(0, i);
  const tag = img.slice(i + 1);
  if (repo !== PREP_REPO) return false;
  if (!tag || tag === 'latest' || tag === '<none>') return false;
  if (needed.has(img) || needed.has(`${PREP_REPO}:${tag}`)) return false;
  if (used && used.has(img)) return false;
  return true;
}

// OLD BUILD RESIDUE: every `compose build` / `docker build` that retags `repo:slug` leaves the
// previous image ID untagged (`<none>:<none>` / dangling). Those are not caught by the slug
// filter above — they have no tag — and they are the bulk of "reclaimable" space on a busy build
// host (the 131 GB figure on the NAS was mostly this, not live spinoff tags).
//
// `docker image prune -f` (NO -a) removes ONLY dangling images that no container references.
// That is the one prune that is safe on a shared NAS: it cannot touch postgres, prod, or anyone
// else's tagged work. `prune -a` is still forbidden here — it would eat every unused tagged image.
//
// We list first so a dry run can name what it would drop, and so a real run can say how many
// went away even when prune's own summary is terse or locale-dependent.
export function listDanglingImageIds(ctx) {
  // Prefer ID\tSize so the log can show bulk; fall back to bare IDs if the daemon is old.
  const r = docker(ctx, ['images', '-f', 'dangling=true', '--format', '{{.ID}}\t{{.Size}}'], 60000);
  if (r.status !== 0) return { ok: false, err: (r.err || '').trim().slice(0, 120), ids: [] };
  const ids = [];
  for (const line of r.out.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const id = line.split(/\s+|\t/)[0];
    if (id && id !== '<none>') ids.push(id);
  }
  return { ok: true, ids, raw: r.out };
}

// Parse `docker image prune -f` stdout for the reclaimed-space line. Best-effort — a missing
// summary must not look like failure (the delete still happened).
export function parsePruneReclaimed(out) {
  const m = String(out || '').match(/Total reclaimed space:\s*(\S+)/i);
  return m ? m[1] : null;
}

function pruneDanglingBuilds(ctx, { dryRun }) {
  const listed = listDanglingImageIds(ctx);
  if (!listed.ok) {
    logline('maint', `image sweep: cannot list dangling builds on ${ctx} — ${listed.err}`);
    return { pruned: 0, failed: true };
  }
  if (!listed.ids.length) return { pruned: 0 };

  const sample = listed.ids.slice(0, 8).join(', ')
    + (listed.ids.length > 8 ? ` …(+${listed.ids.length - 8})` : '');

  if (dryRun) {
    logline('maint', `image sweep (dry run${PROVISION_MODE !== 'real' ? ', PROVISION_MODE=simulate' : ''}): `
      + `${listed.ids.length} dangling old-build image(s) on ${ctx} would be pruned: ${sample}`);
    return { pruned: listed.ids.length, dryRun: true };
  }

  // NEVER `image prune -a`. Only dangling.
  const r = docker(ctx, ['image', 'prune', '-f'], 300000);
  if (r.status !== 0) {
    logline('maint', `image sweep: dangling prune FAILED on ${ctx}: ${(r.err || r.out || '').trim().slice(0, 160)}`);
    return { pruned: 0, failed: true };
  }
  const space = parsePruneReclaimed(r.out);
  logline('maint', `image sweep: pruned ${listed.ids.length} dangling old-build image(s) on ${ctx}`
    + (space ? ` (reclaimed ${space})` : '')
    + `: ${sample}`);
  return { pruned: listed.ids.length, space };
}

// THE JANITOR: three reclaim paths, all narrow:
//   1. spinoff images whose tag is not a live xell's slug
//   2. prepped cxell images whose content-hash no current spawn template needs
//   3. dangling old-build images left behind when a rebuild moved a tag (image prune -f, never -a)
// Repos for (1) come from the DB (live image_tags + project naming templates), never a hardcoded
// list. A blanket `docker image prune -a` on a shared NAS would eat the dev stack and prod.
export async function sweepOrphanSpinImages({ dryRun = PROVISION_MODE !== 'real' } = {}) {
  const repos = await discoverPerXellRepos();
  // Prep images (zeehive/zee-agent-prep:*) are always considered on every context — their repo
  // name is fixed by spawn-prep, independent of whether any spinoff repo is known yet.
  const contexts = await discoverDockerContexts();
  // q() returns the ROWS, not a pg result — `.rows` here silently yielded undefined and threw.
  const live = new Set((await q(`SELECT slug FROM xell WHERE status <> 'retired'`)).map((r) => r.slug));
  const neededPrep = await neededPrepImageTags();

  let swept = 0;
  let dangling = 0;
  for (const ctx of contexts) {
    const ls = docker(ctx, ['images', '--format', '{{.Repository}}:{{.Tag}}'], 60000);
    if (ls.status !== 0) {
      logline('maint', `image sweep: cannot list images on ${ctx} — ${ls.err.trim().slice(0, 120)}`);
      continue;
    }

    // "Not a live xell" is NOT sufficient to delete. This host also runs pre-ZEEHIVE
    // /spin:spinoff environments that use the same image names and are invisible to the xell
    // table — every one of them looked like an orphan. Ask docker what is actually in use, and
    // if docker won't say, delete NOTHING tagged. Dangling prune has its own container-ref
    // check inside the daemon, so it still runs below even when this list is empty.
    const used = imagesInUse(ctx);
    if (!used) {
      logline('maint', `image sweep: cannot read containers on ${ctx} — skipping tagged reclaim `
        + '(refusing to delete blind); will still attempt dangling old-build prune');
    }

    const lines = ls.out.split('\n').map((s) => s.trim()).filter(Boolean);
    const orphans = used
      ? lines.filter((img) => isOrphanSpinImage(img, { repos, live, used })
        || isOrphanPrepImage(img, { needed: neededPrep, used }))
      : [];

    if (orphans.length) {
      if (dryRun) {
        logline('maint', `image sweep (dry run${PROVISION_MODE !== 'real' ? ', PROVISION_MODE=simulate: this '
          + 'queenzee models the fleet — its xell list is a SNAPSHOT and would call live images orphans' : ''}): `
          + `${orphans.length} orphan(s) on ${ctx}: ${orphans.join(', ')}`);
        swept += orphans.length;
      } else {
        const r = rmi(ctx, orphans);
        swept += r.removed.length;
        if (r.removed.length) {
          logline('maint', `image sweep: reclaimed ${r.removed.length} orphaned image(s) on ${ctx} `
            + `(~${(r.removed.length * 1.3).toFixed(1)} GB) — retired xell spinoff tags and/or stale `
            + `cxell prep hashes: ${r.removed.join(', ')}`);
        }
        // Belt and braces: docker refused because something depends on it after all. Not an error —
        // it is the guard doing its job (see rmi()).
        if (r.inUse.length) {
          logline('maint', `image sweep: left ${r.inUse.length} image(s) alone — a container still uses them: ${r.inUse.join(', ')}`);
        }
        for (const f of r.failed) logline('maint', `image sweep: rmi failed for ${f.tag}: ${f.err}`);
      }
    }

    // Always attempt dangling prune — rebuilds of LIVE xells leave old layers too, and those are
    // invisible to the slug filter. Runs after tagged rmi so layers freed by the rmi are included.
    const d = pruneDanglingBuilds(ctx, { dryRun });
    dangling += d.pruned || 0;
  }
  return { swept, dangling, total: swept + dangling };
}

// Periodic janitor. OFF by default is wrong here — the leak is silent and unbounded — but it must
// be disableable, and it must never run more often than it can finish.
export function startImageJanitor() {
  if (process.env.IMAGE_JANITOR_ENABLED === 'false') {
    console.log('[queenzee] image janitor DISABLED (IMAGE_JANITOR_ENABLED=false)');
    return;
  }
  const interval = Number(process.env.IMAGE_JANITOR_MS) || 3600000; // hourly
  // Two independent reasons to only report: the operator asked for a dry run, or this queenzee is
  // not allowed to touch machines at all (PROVISION_MODE — see the top of this file).
  const dryRun = process.env.IMAGE_JANITOR_DRY_RUN === 'true' || PROVISION_MODE !== 'real';
  const tick = () => sweepOrphanSpinImages({ dryRun }).catch((e) => console.error('[images] sweep:', e.message));
  setTimeout(tick, 60000);          // not at boot — let the fleet settle first
  setInterval(tick, interval);
  console.log(`[queenzee] image janitor started (${interval}ms${dryRun ? ', DRY RUN' : ''})`);
}
