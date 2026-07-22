// DISCOVER & ADOPT — pick a deploy site, see what is actually RUNNING on its docker context,
// and adopt a chosen subset as that site's PRODUCTION xell inventory in one action.
//
// This generalises self-onboard.js `modelOwnStack()`, which does exactly this for ZEEHIVE's own
// stack, hardcoded to three compose services. Onboarding a project that already has a running
// production stack should not mean hand-typing every container into the inventory, one row at a
// time, guessing the role, with no way to see what is actually there.
//
// HARD RULES (mirrored from the task, enforced here):
//   • Discovery and adoption NEVER touch a container. Read-only `docker ps`/inspect via the
//     daemon HTTP API (lib/docker.js) only — no start/stop/rm/create/restart/up/down/pull.
//   • Never auto-adopt: a human always picks from the list. There is no background job here.
//   • Adopt must not make anything shippable: `build_script` stays NULL on every adopted row.
//     The shippable gate is a separate, deliberate human act.
//   • Role inference is a SUGGESTION with a reason, never silently applied — the caller shows it
//     and the human confirms/corrects it before adopt is called.
//   • Idempotent: `container` is unique on (project_id, name); re-running discovery shows
//     already-modeled containers as such, and adopting never duplicates or throws.
//
// The link self-onboard makes and plain createSharedContainer historically did NOT: the
// `xell_uses_container … 'owns'` row that puts a container in the PRODUCTION hexagon. Without it a
// fully-modeled prod stack shows empty hex slots (measured on the live instance: omnibiz had 11
// prod containers modeled, 0 linked). Adoption creates that link; createSharedContainer now does
// too for tier='prod' (see lib/inventory.js).
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { listContainersDetailed } from './docker.js';

// The roles the inventory understands (container_role also has 'device', which is never a
// deploy-site adoption target). Matches lib/inventory.js ROLES.
const ADOPTABLE_ROLES = ['db', 'server', 'webapp', 'infra'];

// SERVICE_ROLE generalised. self-onboard mapped the three exact Zeehive compose services
// (meta-db→db, server→server, web→webapp). A general project's services are named differently, so
// we infer — in priority order — from the zeehive.role label, the compose service name, the image,
// then the exposed ports. Every path returns a REASON, because a wrong 'db' guess onto the wrong
// container is how a backup job later points at the wrong database. The inference is a suggestion:
// the caller shows it, the human confirms it, and only then does adopt run.
const SERVICE_PATTERNS = [
  [/(^|[-_.])(db|database|postgres|postgresql|pg|mysql|mariadb|mongo|mongodb|redis)([-_.]|$)/i, 'db'],
  [/(^|[-_.])(server|api|backend|worker|queenzee)([-_.]|$)/i, 'server'],
  [/(^|[-_.])(web|webapp|frontend|www|ui|client|console|app)([-_.]|$)/i, 'webapp'],
  [/(^|[-_.])(proxy|nginx|traefik|caddy|tunnel|cloudflared?|gateway|ingress|haproxy|lb)([-_.]|$)/i, 'infra'],
];
const IMAGE_PATTERNS = [
  [/(postgres|postgis|mysql|mariadb|mongo|redis|timescale|pgvector)/i, 'db'],
  [/(nginx|traefik|caddy|cloudflare\/cloudflared|cloudflared|haproxy|envoyproxy|traefik)/i, 'infra'],
];
// A published/exposed port that all but names the role.
const PORT_ROLE = { 5432: 'db', 5433: 'db', 3306: 'db', 27017: 'db', 6379: 'db' };

// { role: <one of ADOPTABLE_ROLES>|null, reason: string }. role=null means "could not tell" —
// the human MUST choose before it can be adopted (adopt refuses a blank/invalid role).
export function inferRole(c) {
  if (c.zeehive_role && ADOPTABLE_ROLES.includes(c.zeehive_role)) {
    return { role: c.zeehive_role, reason: `zeehive.role label "${c.zeehive_role}"` };
  }
  if (c.compose_service) {
    for (const [re, role] of SERVICE_PATTERNS) {
      if (re.test(c.compose_service)) return { role, reason: `compose service "${c.compose_service}"` };
    }
  }
  if (c.image) {
    for (const [re, role] of IMAGE_PATTERNS) {
      if (re.test(c.image)) return { role, reason: `image "${c.image}"` };
    }
  }
  for (const p of [...(c.exposed_ports || [])].sort((a, b) => a - b)) {
    if (PORT_ROLE[p]) return { role: PORT_ROLE[p], reason: `port ${p}` };
  }
  return { role: null, reason: 'could not infer — please choose a role' };
}

// The production xell that owns a given prod SITE's stack. createSite mints 'production' for the
// default site and 'production-<key>' for the rest (spec §5.2); mirror that, with a fallback to
// the project's sole production xell (the seed shape, or a default-flag mismatch).
export async function prodXellForSite(site) {
  if (!site || site.tier !== 'prod') return null;
  const slug = site.is_default ? 'production' : `production-${site.key}`;
  let x = await one(
    `SELECT id, slug FROM xell WHERE project_id=$1 AND slug=$2 AND is_production`,
    [site.project_id, slug]);
  if (!x) {
    x = await one(
      `SELECT id, slug FROM xell WHERE project_id=$1 AND is_production
        ORDER BY (slug='production') DESC, created_at LIMIT 1`, [site.project_id]);
  }
  return x;
}

// Ensure a container is linked to its prod site's production xell as 'owns' (the PRODUCTION hex
// row). Idempotent (PK is (xell_id, container_id) → ON CONFLICT DO NOTHING). Resolves the site
// from an explicit row, a site id, or the project's default prod site — whichever the caller has.
// Returns { xellId, created }; a no-op (no prod xell yet) returns { xellId: null, created: false }.
export async function ensureProdLink(containerId, { site, siteId, projectId } = {}) {
  let s = site || null;
  if (!s && siteId) s = await one(`SELECT * FROM deploy_site WHERE id=$1`, [siteId]);
  if (!s && projectId) {
    s = await one(`SELECT * FROM deploy_site WHERE project_id=$1 AND tier='prod' AND is_default LIMIT 1`,
      [projectId]);
  }
  const xell = s ? await prodXellForSite(s) : null;
  if (!xell) return { xellId: null, created: false };
  const link = await one(
    `INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')
       ON CONFLICT DO NOTHING RETURNING container_id`, [xell.id, containerId]);
  return { xellId: xell.id, created: !!link };
}

// DISCOVER: what is actually running on a site's docker context. Read-only. Returns either
//   { ok:true,  ..., containers:[…] }  — possibly an EMPTY array on a reachable, empty daemon
//   { ok:false, ..., error:"context 'x' unreachable: …" }  — a dead/erroring endpoint
// The two are DELIBERATELY distinct: an empty list on an unreachable daemon would read as
// "nothing to adopt" and hide the fact that the endpoint is dead.
export async function discoverSite(siteId) {
  const site = await one(`SELECT * FROM deploy_site WHERE id=$1`, [siteId]);
  if (!site) throw new Error('deploy site not found');
  const ctx = site.docker_ctx || 'default';

  let running;
  try {
    running = await listContainersDetailed(ctx);
  } catch (e) {
    return { ok: false, site_id: site.id, site_key: site.key, tier: site.tier, docker_ctx: ctx,
             error: `context '${ctx}' unreachable: ${e.message}` };
  }

  // Already-modeled = a container row for THIS project with this exact name (the unique key).
  const modeled = await q(
    `SELECT name, role, tier FROM container WHERE project_id=$1`, [site.project_id]);
  const byName = new Map(modeled.map((m) => [m.name, m]));

  // Which of those are already linked to THIS site's production xell (in the hex already).
  const prodXell = await prodXellForSite(site);
  const linkedNames = new Set();
  if (prodXell) {
    const linked = await q(
      `SELECT c.name FROM container c
         JOIN xell_uses_container uc ON uc.container_id = c.id
        WHERE c.project_id=$1 AND uc.xell_id=$2 AND uc.relation='owns'`, [site.project_id, prodXell.id]);
    for (const r of linked) linkedNames.add(r.name);
  }

  const containers = running.map((c) => {
    const guess = inferRole(c);
    const m = byName.get(c.name) || null;
    return {
      name: c.name,
      image: c.image,
      state: c.state,
      status: c.status,
      ports: c.ports,
      compose_project: c.compose_project,
      compose_service: c.compose_service,
      labelled: c.labels_present,
      inferred_role: guess.role,
      role_reason: guess.reason,
      already_modeled: !!m,
      modeled_as: m ? { role: m.role, tier: m.tier } : null,
      linked_to_prod: linkedNames.has(c.name),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, site_id: site.id, site_key: site.key, tier: site.tier,
           docker_ctx: ctx, host: site.host, project_id: site.project_id,
           prod_xell_id: prodXell?.id || null, prod_xell_missing: !prodXell,
           count: containers.length, containers };
}

// ADOPT: model a chosen subset as the site's prod stack. `selections` is
//   [{ name, role, image_tag?, host_port?, internal_port?, compose_project? }, …]
// where role is the human-confirmed (possibly corrected) role. Read-only wrt docker: this only
// writes meta rows. Idempotent: an already-modeled row is LEFT AS-IS (never re-stamped — a human
// may have since given it a build_script, and adopt must neither make nor UNmake shippable), but
// its owns link is still (re)established, which is the whole point for a stack modeled but unlinked.
export async function adoptContainers(siteId, selections = []) {
  const site = await one(`SELECT * FROM deploy_site WHERE id=$1`, [siteId]);
  if (!site) throw new Error('deploy site not found');
  if (site.tier !== 'prod') {
    throw new Error(`site "${site.key}" is a ${site.tier} site — adoption models a project's `
      + 'PRODUCTION stack, so it targets prod sites only');
  }
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('no containers selected to adopt');
  }

  const prodXell = await prodXellForSite(site);
  const out = { ok: true, site_key: site.key, prod_xell_id: prodXell?.id || null,
                prod_xell_missing: !prodXell, adopted: [], linked: [], skipped: [] };

  for (const sel of selections) {
    const name = String(sel?.name || '').trim();
    if (!name) { out.skipped.push({ name: sel?.name ?? null, reason: 'no name' }); continue; }
    const role = String(sel?.role || '').trim();
    if (!ADOPTABLE_ROLES.includes(role)) {
      out.skipped.push({ name, reason: `role must be one of ${ADOPTABLE_ROLES.join(', ')} `
        + `(got "${sel?.role ?? ''}") — inference left it blank, choose one` });
      continue;
    }

    const existed = await one(`SELECT id FROM container WHERE project_id=$1 AND name=$2`,
      [site.project_id, name]);
    let row;
    if (existed) {
      // Keep its row untouched except to (back)fill the site link if it had none — never touch
      // role/tier/build_script on an existing row.
      row = await one(`UPDATE container SET site_id = COALESCE(site_id, $2) WHERE id=$1 RETURNING *`,
        [existed.id, site.id]);
    } else {
      row = await one(
        `INSERT INTO container (project_id, role, tier, isolation, name, image_tag, docker_ctx,
                                host, host_port, internal_port, compose_project, site_id,
                                build_script, build_exec, health)
         VALUES ($1,$2,'prod','shared',$3,$4,$5,$6,$7,$8,$9,$10,NULL,'bash','unknown')
         RETURNING *`,
        [site.project_id, role, name, sel.image_tag || null, site.docker_ctx || 'default',
         site.host || null, sel.host_port || null, sel.internal_port || null,
         sel.compose_project || null, site.id]);
      broadcast('container', row);
    }

    const link = prodXell ? await ensureProdLink(row.id, { site }) : { created: false };
    if (existed) out.skipped.push({ name, id: row.id, reason: 'already modeled — left as-is', linked: link.created });
    else out.adopted.push({ name, role, id: row.id });
    if (link.created) out.linked.push(name);
  }

  logline('discovery', `adopt on site '${site.key}': ${out.adopted.length} modeled, `
    + `${out.linked.length} linked to production${out.skipped.length ? `, ${out.skipped.length} already-modeled/skipped` : ''}`
    + `${prodXell ? '' : ' (NO production xell for this site — rows modeled but nothing to link)'}`);

  // Nudge the console's PRODUCTION hex / matrix to redraw with the newly-linked stack.
  if (prodXell && out.linked.length) {
    const x = await one(`SELECT * FROM xell WHERE id=$1`, [prodXell.id]);
    if (x) broadcast('xell', x);
  }
  return out;
}
