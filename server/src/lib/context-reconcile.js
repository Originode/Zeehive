// Context reconcile — the queenzee's own docker contexts follow the Deploy sites tab.
//
// deploy_site is the source of truth for WHERE a tier runs (docs/deploy-topology-spec.md §5):
// each row names a docker_ctx (the context NAME) and, since migration 109, a docker_endpoint
// (the full `host=` string the context should dial — tcp://10.2.0.16:2375,
// ssh://mnrevelo@ssh.omnibiz.express, …). Before this, a site's endpoint was inert: the context
// lived only in the queenzee host's ~/.docker, was created by the entrypoint from env at boot,
// and a human had to `docker context update` by hand whenever it drifted (e.g. re-pointing
// mardale-prod at the SSH endpoint while the LAN route to the NAS is down).
//
// This module closes that loop: reconcileContext() makes the real docker context match the site's
// declared endpoint (create if missing, update if drifted, no-op if already correct), and
// reconcileAllContexts() walks every declared site. It is called on site SAVE (so editing the tab
// IS the fix) and on a periodic tick (so an external ad-hoc change is healed back within a minute).
//
// SAFETY — the same rule the rest of the fleet machinery follows (machines.js, provision.js):
//   • 'real' mode runs the docker commands; anything else (simulate, the cxell default) only
//     models them and logs what WOULD have happened. A nested queenzee never creates/updates
//     contexts on the real host.
//   • 'default' is the local daemon and is NEVER reconciled — there is nothing to dial.
//   • a site with no docker_endpoint is never touched (its reachability is managed elsewhere).
//   • failures are best-effort and LOUD IN THE LOG, never thrown to the caller — a site save must
//     not fail because the reconcile could not reach the CLI.
import { spawnSync } from 'node:child_process';
import { q } from '../db/pool.js';
import { logline } from './logbus.js';
import { listDockerContexts } from './sites.js';

// Read at CALL time, not module load, so a test can flip PROVISION_MODE without re-importing —
// and so a queenzee that changes mode in-process sees it. Same switch machines.js reads.
const realMode = () => process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// The endpoint a site declares for its docker_ctx (NULL → no reconcile).
export function endpointForSite(site) {
  return site?.docker_endpoint || null;
}

// Whether a site should be reconciled at all: a real endpoint, and not the local daemon.
export function shouldReconcile(site) {
  return !!endpointForSite(site) && site?.docker_ctx && site.docker_ctx !== 'default';
}

// The current docker contexts on this host, as name → endpoint. Reuses sites.js's listDockerContexts
// (the same `docker context ls --format json` the console picker uses), so the reconcile and the
// picker always see the same world.
async function currentContexts() {
  const r = listDockerContexts();
  if (!r.ok) throw new Error(r.error);
  return new Map(r.contexts.map((c) => [c.name, c.endpoint || '']));
}

function runDocker(args, timeout = 15000) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// Bring ONE site's docker context in line with its declared endpoint. Returns a verdict; never
// throws (best-effort by contract — a failing reconcile must not fail a site save).
export async function reconcileContext(site) {
  if (!shouldReconcile(site)) {
    return { action: 'skipped', ctx: site?.docker_ctx || null,
             reason: !endpointForSite(site) ? 'no docker_endpoint declared' : "docker_ctx is 'default'" };
  }
  const ctx = site.docker_ctx;
  const endpoint = site.docker_endpoint;

  if (realMode() !== 'real') {
    logline('reconcile', `[simulate] would reconcile context '${ctx}' → ${endpoint} for site '${site.key}'`);
    return { action: 'simulate', ctx, endpoint, site: site.key };
  }

  let current;
  try { current = await currentContexts(); }
  catch (e) {
    logline('reconcile', `context reconcile FAILED to list contexts for '${ctx}' (site '${site.key}'): ${e.message}`);
    return { action: 'error', ctx, endpoint, error: e.message, site: site.key };
  }

  const have = current.get(ctx);
  if (have === endpoint) {
    return { action: 'ok', ctx, endpoint, site: site.key };            // already correct — no-op
  }

  const args = have === undefined
    ? ['context', 'create', ctx, '--description', `site ${site.key}`, '--docker', `host=${endpoint}`]
    : ['context', 'update', ctx, '--docker', `host=${endpoint}`];
  const r = runDocker(args);
  if (r.status !== 0) {
    const msg = (r.err || '').trim().slice(0, 300);
    logline('reconcile', `context reconcile ${have === undefined ? 'create' : 'update'} FAILED for '${ctx}' → ${endpoint}: ${msg}`);
    return { action: 'error', ctx, endpoint, error: msg, site: site.key };
  }
  logline('reconcile', `context '${ctx}' ${have === undefined ? 'created' : 'updated'} → ${endpoint} (site '${site.key}')`
    + (have === undefined ? '' : `; was ${have}`));
  return { action: have === undefined ? 'created' : 'updated', ctx, endpoint, site: site.key };
}

// Reconcile EVERY deploy_site row that declares an endpoint. Used by the periodic tick so an
// external ad-hoc `docker context update` is healed back to the tab's truth within the cadence.
// Accepts an optional sites array for tests (the real path queries the DB).
export async function reconcileAllContexts(sites = null) {
  const rows = sites || await q(
    `SELECT id, project_id, key, tier, docker_ctx, docker_endpoint FROM deploy_site`);
  const out = [];
  for (const s of rows) {
    const r = await reconcileContext(s);
    if (r.action !== 'ok' && r.action !== 'skipped') out.push(r);   // say only when something happened
  }
  return out;
}
