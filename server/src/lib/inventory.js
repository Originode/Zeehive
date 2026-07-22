// SHARED container inventory management — the onboarding surface's "production containers"
// editor (a project needs at least one shippable prod container before anything can ship).
// Scope is deliberately SHARED rows only: per-xell containers are provisioning's to create and
// the reaper's to destroy; hand-editing them desyncs the fleet from reality.
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { resolveSite } from './sites.js';
import { ensureProdLink } from './discovery.js';

const ROLES = ['db', 'server', 'webapp', 'infra'];
const TIERS = ['dev', 'prod'];

export async function listSharedContainers(projectId) {
  return q(
    `SELECT c.*, s.key AS site_key,
            (SELECT count(*) FROM xell_uses_container uc WHERE uc.container_id = c.id) AS linked_xells,
            (SELECT coalesce(json_agg(json_build_object(
                      'id', di.id, 'name', di.name, 'kind', di.kind,
                      'owner_xell_id', di.owner_xell_id, 'owner_slug', ox.slug,
                      'prod_diff', di.prod_diff, 'prod_diff_at', di.prod_diff_at,
                      'refreshed_at', di.refreshed_at)
                    ORDER BY CASE di.kind WHEN 'primary' THEN 0 WHEN 'template' THEN 1
                                          WHEN 'clone' THEN 2 ELSE 3 END, di.name), '[]'::json)
               FROM db_instance di LEFT JOIN xell ox ON ox.id = di.owner_xell_id
              WHERE di.container_id = c.id) AS instances
       FROM container c LEFT JOIN deploy_site s ON s.id = c.site_id
      WHERE c.project_id = $1 AND c.isolation = 'shared'
      ORDER BY c.tier, c.role, c.name`, [projectId]);
}

function validate(body, { partial = false } = {}) {
  const errs = [];
  if (!partial || body.name !== undefined) {
    if (!String(body.name || '').trim()) errs.push('container name is required');
  }
  if (!partial || body.role !== undefined) {
    if (!ROLES.includes(body.role)) errs.push(`role must be one of: ${ROLES.join(', ')}`);
  }
  if (!partial || body.tier !== undefined) {
    if (!TIERS.includes(body.tier)) errs.push(`tier must be one of: ${TIERS.join(', ')} (spinoff rows are provisioning's)`);
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// Create one shared container row. Site/ctx resolve from the tier's default site when not
// given, so the inventory lands on the right daemon without re-typing contexts.
export async function createSharedContainer(projectId, body = {}) {
  const project = await one(`SELECT id FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  validate(body);

  let siteId = body.site_id || null;
  let ctx = body.docker_ctx || null;
  let host = body.host || null;
  if (!siteId || !ctx) {
    const site = body.site_id
      ? await one(`SELECT * FROM deploy_site WHERE id=$1 AND project_id=$2`, [body.site_id, projectId])
      : await resolveSite(projectId, body.tier);
    if (body.site_id && !site) throw new Error('no such deploy site for this project');
    siteId = siteId || site?.id || null;
    ctx = ctx || site?.docker_ctx || null;
    host = host || site?.host || null;
  }

  const row = await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx, host,
                            host_port, internal_port, url, site_id, build_script, build_exec, health)
     VALUES ($1,$2,$3,'shared',$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,'bash'),'unknown')
     RETURNING *`,
    [projectId, body.role, body.tier, String(body.name).trim(), body.image_tag || null, ctx, host,
     body.host_port || null, body.internal_port || null, body.url || null, siteId,
     body.build_script || null, body.build_exec || null]);
  broadcast('container', row);

  // A tier='prod' row belongs to that site's PRODUCTION xell — link it ('owns'), the same shape
  // self-onboard and adoption use. Historically ONLY self-onboard made this link, so a hand-typed
  // prod row modeled a container the PRODUCTION hexagon never showed (measured on the live
  // instance: omnibiz had 11 prod rows, 0 links). Nothing keys off the link's ABSENCE — the
  // readiness/shippable gate goes by build_script, not by hex membership — so adding it is safe.
  // Best-effort: with no prod site/xell yet (a dev-first project) it is a silent no-op.
  if (row.tier === 'prod') {
    try { await ensureProdLink(row.id, { siteId: row.site_id, projectId }); }
    catch { /* the hex link is a projection, never a reason to fail the row insert */ }
  }
  return row;
}

const PATCHABLE = ['name', 'role', 'tier', 'image_tag', 'docker_ctx', 'host', 'host_port',
                   'internal_port', 'url', 'site_id', 'build_script', 'build_exec'];

export async function updateSharedContainer(id, body = {}) {
  const c = await one(`SELECT * FROM container WHERE id=$1`, [id]);
  if (!c) throw new Error('container not found');
  if (c.isolation !== 'shared') {
    throw new Error(`${c.name} is a per-xell container — provisioning owns it; it is not editable here`);
  }
  validate(body, { partial: true });

  const sets = [], vals = [id];
  for (const f of PATCHABLE) {
    if (body[f] === undefined) continue;
    const v = typeof body[f] === 'string' ? (body[f].trim() || null) : body[f];
    vals.push(v);
    sets.push(`${f} = $${vals.length}`);
  }
  if (!sets.length) return c;
  const row = await one(`UPDATE container SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
  broadcast('container', row);
  return row;
}

export async function deleteSharedContainer(id, force = false) {
  const c = await one(
    `SELECT c.*, (SELECT count(*) FROM xell_uses_container uc WHERE uc.container_id=c.id) AS linked
       FROM container c WHERE c.id=$1`, [id]);
  if (!c) throw new Error('container not found');
  if (c.isolation !== 'shared') {
    throw new Error(`${c.name} is a per-xell container — the reaper owns its teardown`);
  }
  if (Number(c.linked) > 0 && !force) {
    throw new Error(`${c.name} is linked to ${c.linked} xell(s) — removing it un-assigns their `
      + 'container (nothing live is touched). Force to proceed.');
  }
  await q(`DELETE FROM container WHERE id=$1`, [id]);
  broadcast('container', { id, project_id: c.project_id, deleted: true });
  return { ok: true, deleted: id, name: c.name };
}
