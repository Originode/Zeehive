// Runtime helpers: resolve the agent backend + capture a session's viewer URL.
import { one } from '../db/pool.js';

export async function runtimeByKey(key) {
  return one(`SELECT * FROM agent_runtime WHERE key = $1`, [key]);
}
export async function runtimeById(id) {
  return id ? one(`SELECT * FROM agent_runtime WHERE id = $1`, [id]) : null;
}

// Build the deep-link used by the web app to OPEN a session in its provider's viewer.
// The exact per-vendor scheme is captured here at spawn time, never hard-coded blindly:
//  - web (claude.ai remote): use the runtime template if configured, else the URL the
//    remote API returned for that session (passed in as knownUrl).
//  - desktop-protocol (local): a claude:// deep link if the platform registers one.
export function viewerUrlFor(runtime, sessionId, knownUrl) {
  if (!runtime) return { url: knownUrl || null, kind: 'none' };
  if (knownUrl) return { url: knownUrl, kind: runtime.viewer_kind };
  if (runtime.viewer_url_template && sessionId) {
    return { url: runtime.viewer_url_template.replace('{session}', sessionId), kind: runtime.viewer_kind };
  }
  return { url: null, kind: runtime.viewer_kind };
}
