// Deploy sites — WHERE a project tier runs (docker context / host) and how it is reached
// (docs/deploy-topology-spec.md §5). CRUD for the console plus resolveSite(), the one lookup
// every docker-touching consumer goes through: site row → deprecated project columns → global
// env default. Editing a site changes where FUTURE containers go; it never migrates, restarts,
// or re-stamps live ones.
import { spawnSync } from 'node:child_process';
import { pool, q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';

const TIERS = ['dev', 'prod'];
const INGRESS_KINDS = ['lan', 'reverse-proxy', 'cloudflare-tunnel', 'wireguard'];

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

export async function createSite(projectId, body = {}) {
  const project = await one(`SELECT id FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  validate(body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [site] } = await client.query(
      `INSERT INTO deploy_site (project_id,key,tier,docker_ctx,host,compose_file,env_file,ingress,is_default)
       VALUES ($1,$2,$3,COALESCE(NULLIF($4,''),'default'),$5,$6,$7,COALESCE($8,'{}'::jsonb),$9)
       RETURNING *`,
      [projectId, body.key, body.tier, body.docker_ctx || null, body.host || null,
       body.compose_file || null, body.env_file || null,
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
        const slug = site.is_default ? 'production' : `production-${site.key}`;
        await client.query(
          `INSERT INTO xell (project_id,xource_id,slug,branch,db_coupling,status,is_pooled,is_production)
           VALUES ($1,$2,$3,$3,'db-shared-prod','working',false,true)
           ON CONFLICT (project_id,slug) DO UPDATE SET is_production=true`,
          [projectId, xo.id, slug]);
      }
    }
    await client.query('COMMIT');
    broadcast('site', site);
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

const PATCHABLE = ['key', 'tier', 'docker_ctx', 'host', 'compose_file', 'env_file', 'ingress', 'is_default'];

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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // unseat the old default FIRST — the partial unique index checks per-statement
    if (body.is_default) await setDefaultWithin(client, site.project_id, body.tier ?? site.tier, siteId);
    const { rows: [updated] } = await client.query(
      `UPDATE deploy_site SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    await client.query('COMMIT');
    broadcast('site', updated);
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
  await q(`DELETE FROM deploy_site WHERE id=$1`, [siteId]);
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
