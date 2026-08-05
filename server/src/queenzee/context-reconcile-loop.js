// Periodic docker-context reconcile — heals the queenzee's own contexts back to the Deploy sites
// tab's truth every minute.
//
// The tab is the source of truth (lib/context-reconcile.js): each deploy_site declares the
// docker_endpoint its docker_ctx should dial. Site SAVE reconciles immediately; this loop catches
// drift from OUTSIDE the tab — e.g. a human's ad-hoc `docker context update mardale-prod --docker
// host=ssh://…` while the LAN route is down. Without it, the manual change would silently outlive
// the next save and the tab would lie about where prod is reachable.
import { reconcileAllContexts } from '../lib/context-reconcile.js';

export function startContextReconcile() {
  if (process.env.CONTEXT_RECONCILE_ENABLED === 'false') {
    console.log('[queenzee] context reconcile DISABLED (CONTEXT_RECONCILE_ENABLED=false)');
    return null;
  }
  const interval = Number(process.env.CONTEXT_RECONCILE_INTERVAL_MS) || 60000;
  console.log(`[queenzee] context reconcile started (${interval}ms — Deploy sites tab is the source of truth)`);
  const tick = () => reconcileAllContexts().catch((e) => console.error('[context-reconcile]', e.message));
  tick();
  return setInterval(tick, interval);
}
