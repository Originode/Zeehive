// Deploy sites — WHERE a project tier runs (docker context / host) and how it is reached
// (docs/deploy-topology-spec.md §5). CRUD for the console plus resolveSite(), the one lookup
// every docker-touching consumer goes through: site row → deprecated project columns → global
// env default. Editing a site changes where FUTURE containers go; it never migrates, restarts,
// or re-stamps live ones.
import { spawnSync } from 'node:child_process';
import { pool, q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { reconcileContext } from './context-reconcile.js';

const TIERS = ['dev', 'prod'];
const INGRESS_KINDS = ['lan', 'reverse-proxy', 'cloudflare-tunnel', 'wireguard'];

// The production xell slug a prod site owns (spec §5.2): 'production' for the default site,
// 'production-<key>' for the rest. Mirrors the minting in createSite() and the lookup in
// lib/discovery.js prodXellForSite() — a site and its xell are two halves of the same fact.
export function prodXellSlug(site) {
  return site.is_default ? 'production' : `production-${site.key}`;
}

export async function listSites(projectId) {
  return q(
    `SELECT s.*,
            (SELECT count(*) FROM container c WHERE c.site_id = s.id) AS container_count
       FROM deploy_site s WHERE s.project_id = $1 ORDER BY s.tier, s.created_at`, [projectId]);
}

function validate(body, { partial = false } = {}) {
  const errs = [];
  if (!partial || body.key !== undefined) {
    if (!body.key || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(body.key)) {
      errs.push('key is required: lowercase letters/digits/dashes (e.g. "dev", "mardale-prod", "vps")');
    }
  }
  if (!partial || body.tier !== undefined) {
    if (!TIERS.includes(body.tier)) errs.push(`tier must be one of: ${TIERS.join(', ')}`);
  }
  if (body.docker_ctx !== undefined && !String(body.docker_ctx || '').trim()) {
    errs.push(`docker_ctx cannot be empty — use 'default' for this machine's daemon`);
  }
  if (body.ingress !== undefined && body.ingress !== null) {
    if (typeof body.ingress !== 'object' || Array.isArray(body.ingress)) errs.push('ingress must be an object');
    else if (body.ingress.kind && !INGRESS_KINDS.includes(body.ingress.kind)) {
      errs.push(`ingress.kind must be one of: ${INGRESS_KINDS.join(', ')}`);
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// Making a site the default for its (project, tier) unseats the previous default — the partial
// unique index would otherwise reject the insert/update. Both writes share one transaction.
async function setDefaultWithin(client, projectId, tier, keepId) {
  await client.query(
    `UPDATE deploy_site SET is_default=false WHERE project_id=$1 AND tier=$2 AND id<>$3 AND is_default`,
    [projectId, tier, keepId]);
}

// Rename a project's production xell from one slug to another, keeping slug and branch in step
// (createSite sets branch = slug). The target slug may already be held by a DIFFERENT production
// xell — a stale orphan from a previous lifecycle bug (a site rename/delete that didn't move its
// xell). That holder is dropped only if it has NO container links; a linked xell is live and must
// never be deleted, so the rename is skipped and logged. Never throws: the caller's site write
// must not fail because a phantom hexagon couldn't be tidied.
async function renameProdXell(client, projectId, fromSlug, toSlug) {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return false;
  const xres = await client.query(
    `SELECT id FROM xell WHERE project_id=$1 AND slug=$2 AND is_production`, [projectId, fromSlug]);
  const x = xres.rows[0];
  if (!x) return false;
  const hres = await client.query(
    `SELECT x.id,
            (SELECT count(*) FROM xell_uses_container uc WHERE uc.xell_id = x.id)::int AS links
       FROM xell x WHERE x.project_id=$1 AND x.slug=$2 AND x.is_production AND x.id<>$3`,
    [projectId, toSlug, x.id]);
  const holder = hres.rows[0];
  if (holder) {
    if (holder.links > 0) {
      logline('sites', `prod xell rename ${fromSlug}→${toSlug} skipped: ${toSlug} is held by a linked xell`);
      return false;
    }
    await client.query(`DELETE FROM xell WHERE id=$1`, [holder.id]);
    logline('sites', `stale prod xell ${toSlug} removed to make way for ${fromSlug}`);
  }
  await client.query(`UPDATE xell SET slug=$1, branch=$1 WHERE id=$2`, [toSlug, x.id]);
  logline('sites', `prod xell ${fromSlug} → ${toSlug}`);
  return true;
}

// Reconcile a site's production xell after its key/default-ness changed (spec §5.2), inside the
// caller's transaction — the site row and its xell are ONE logical unit, so a failure rolls both
// back (renameProdXell never throws on the conflict it is designed to clean, so in practice the
// site save succeeds). When a non-default site becomes DEFAULT, the previous default's xell
// ('production') is moved to its keyed slug FIRST, freeing 'production' for the new default.
async function reconcileProdXell(client, oldSite, newSite, prevDefault) {
  const projectId = newSite.project_id;
  const oldSlug = prodXellSlug(oldSite);
  const newSlug = prodXellSlug(newSite);
  if (oldSlug === newSlug) return;
  if (!oldSite.is_default && newSite.is_default && prevDefault && prevDefault.id !== newSite.id) {
    // prevDefault was captured BEFORE setDefaultWithin unseated it, so its is_default is stale
    // (still true) — it must hand 'production' over, i.e. move to its KEYED slug.
    await renameProdXell(client, projectId, 'production', `production-${prevDefault.key}`);
  }
  await renameProdXell(client, projectId, oldSlug, newSlug);
}

export async function createSite(projectId, body = {}) {
  const project = await one(`SELECT id FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  validate(body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [site] } = await client.query(
      `INSERT INTO deploy_site (project_id,key,tier,docker_ctx,host,docker_endpoint,compose_file,env_file,ingress,is_default)
       VALUES ($1,$2,$3,COALESCE(NULLIF($4,''),'default'),$5,$6,$7,$8,COALESCE($9,'{}'::jsonb),$10)
       RETURNING *`,
      [projectId, body.key, body.tier, body.docker_ctx || null, body.host || null,
       body.docker_endpoint || null, body.compose_file || null, body.env_file || null,
       body.ingress ? JSON.stringify(body.ingress) : null, !!body.is_default]);
    if (site.is_default) await setDefaultWithin(client, projectId, body.tier, site.id);

    // One production xell PER prod site (spec §5.2) — untouchable, existing prod-xell mechanics
    // apply per site unchanged. The default site's is plain 'production' (the seed's shape);
    // others get 'production-<key>'. Its containers link up as that site's inventory is modeled.
    if (body.tier === 'prod') {
      const { rows: [xo] } = await client.query(
        `SELECT xo.id FROM xource xo JOIN project p ON p.id = xo.project_id AND xo.ref = p.main_branch
          WHERE xo.project_id = $1 LIMIT 1`, [projectId]);
      if (xo) {
        const slug = prodXellSlug(site);
        await client.query(
          `INSERT INTO xell (project_id,xource_id,slug,branch,db_coupling,status,is_pooled,is_production)
           VALUES ($1,$2,$3,$3,'db-shared-prod','working',false,true)
           ON CONFLICT (project_id,slug) DO UPDATE SET is_production=true`,
          [projectId, xo.id, slug]);
      }
    }
    await client.query('COMMIT');
    broadcast('site', site);
    // The site row is the source of truth for the docker context endpoint — make the real context
    // match it now (best-effort: a failing reconcile must never fail the save).
    reconcileContext(site).catch((e) => logline('sites', `context reconcile after create failed: ${e.message}`));
    return site;
  } catch (err) {
    await client.query('ROLLBACK');
    if (/deploy_site_project_id_key_key|duplicate key/.test(err.message)) {
      throw new Error(`a site keyed "${body.key}" already exists for this project`);
    }
    throw err;
  } finally {
    client.release();
  }
}

const PATCHABLE = ['key', 'tier', 'docker_ctx', 'host', 'docker_endpoint', 'compose_file', 'env_file', 'ingress', 'is_default'];

export async function updateSite(siteId, body = {}) {
  const site = await one(`SELECT * FROM deploy_site WHERE id=$1`, [siteId]);
  if (!site) throw new Error('site not found');
  validate(body, { partial: true });

  const sets = [], vals = [siteId];
  for (const f of PATCHABLE) {
    if (body[f] === undefined) continue;
    vals.push(f === 'ingress' && body[f] !== null ? JSON.stringify(body[f]) : body[f]);
    sets.push(`${f} = $${vals.length}`);
  }
  if (!sets.length) return site;

  // Capture the default prod site BEFORE the update unseats it: a make-default must move that
  // site's 'production' xell to its keyed slug so this site can take 'production'.
  const wasDefault = site.is_default;
  const prevDefault = (wasDefault || site.tier !== 'prod')
    ? null
    : await one(`SELECT * FROM deploy_site WHERE project_id=$1 AND tier='prod' AND is_default`, [site.project_id]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // unseat the old default FIRST — the partial unique index checks per-statement
    if (body.is_default) await setDefaultWithin(client, site.project_id, body.tier ?? site.tier, siteId);
    const { rows: [updated] } = await client.query(
      `UPDATE deploy_site SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    // A prod site's key/default-ness defines its production xell's slug (spec §5.2) — keep the
    // xell in step so a rename or make-default never leaves a stale 'PRODUCTION' hexagon behind
    // (the "2 production xells visible in both projects" bug). Same transaction: the site row and
    // its xell are one logical unit.
    if (site.tier === 'prod' && updated.tier === 'prod' && prodXellSlug(site) !== prodXellSlug(updated)) {
      await reconcileProdXell(client, site, updated, prevDefault);
    }
    await client.query('COMMIT');
    broadcast('site', updated);
    // Same source-of-truth reconcile as create: the saved row drives the real docker context.
    reconcileContext(updated).catch((e) => logline('sites', `context reconcile after update failed: ${e.message}`));
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteSite(siteId, force = false) {
  const site = await one(
    `SELECT s.*, (SELECT count(*) FROM container c WHERE c.site_id = s.id) AS container_count
       FROM deploy_site s WHERE s.id=$1`, [siteId]);
  if (!site) throw new Error('site not found');
  if (Number(site.container_count) > 0 && !force) {
    throw new Error(
      `site "${site.key}" is referenced by ${site.container_count} container(s) — `
      + 'reassign or force-remove (containers keep running; their rows just lose the site link)');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A prod site's production xell is minted when the site is created (spec §5.2) — removing
    // the site must remove its xell too, or a stale 'PRODUCTION' hexagon outlives the site (the
    // "2 production xells visible in both projects" bug). The xell_uses_container links cascade
    // with it (FK), and the shared containers themselves are untouched (owner_xell_id NULL).
    if (site.tier === 'prod') {
      await client.query(
        `DELETE FROM xell WHERE project_id=$1 AND slug=$2 AND is_production`,
        [site.project_id, prodXellSlug(site)]);
    }
    await client.query(`DELETE FROM deploy_site WHERE id=$1`, [siteId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  broadcast('site', { id: siteId, project_id: site.project_id, deleted: true });
  return { ok: true, deleted: siteId, key: site.key };
}

// The one resolution path for "which docker context / host does tier X of project Y use?".
// Order: default site row → deprecated project columns → global env default. Always returns a
// site-shaped object (synthetic:true when no row exists), so callers never branch.
export async function resolveSite(projectId, tier) {
  const site = await one(
    `SELECT * FROM deploy_site WHERE project_id=$1 AND tier=$2 AND is_default LIMIT 1`,
    [projectId, tier]);
  if (site) return site;
  const p = await one(
    `SELECT docker_ctx_dev, docker_ctx_prod, dev_host_ip, prod_host_ip, compose_prod FROM project WHERE id=$1`,
    [projectId]);
  if (!p) return null;
  if (tier === 'prod') {
    if (!p.docker_ctx_prod) return null; // no prod configured — never invent one
    return { synthetic: true, key: 'prod', tier, docker_ctx: p.docker_ctx_prod,
             host: p.prod_host_ip, compose_file: p.compose_prod, env_file: null, ingress: {}, is_default: true };
  }
  return { synthetic: true, key: 'dev', tier, docker_ctx: p.docker_ctx_dev || config.dockerCtx,
           host: p.dev_host_ip, compose_file: null, env_file: null, ingress: {}, is_default: true };
}

// The docker contexts this machine actually has — so the console offers a picker instead of
// free text (a typo'd context is otherwise "unreachable forever" with no hint why).
export function listDockerContexts() {
  const r = spawnSync('docker', ['context', 'ls', '--format', 'json'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (r.status !== 0) return { ok: false, error: (r.stderr || 'docker not available').slice(0, 300), contexts: [] };
  const contexts = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      contexts.push({ name: c.Name, description: c.Description || '', endpoint: c.DockerEndpoint || '', current: !!c.Current });
    } catch { /* not a JSON line */ }
  }
  return { ok: true, contexts };
}
