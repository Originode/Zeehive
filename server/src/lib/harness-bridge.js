// HARNESS CONVERSATION BRIDGE (docs/harness-proposal.md §7) — connect a harnessed zee's
// conversation to the harness's own web UI (Hermes is the first target).
//
// MODE B (the chosen design): the zee stays in its cxell (full file access); the bridge is a
// ONE-WAY, OUTBOUND, transcript-only mirror. Zeehive already normalizes every provider's stream to
// one shape on the SSE `zee-output` bus — this relays those events into a Hermes thread keyed by
// X-Hermes-Session-Key = the xell SLUG (stable per xell, so memory threads correctly). Hermes gets a
// DISPLAY copy; it never receives the files and never writes back into the cxell.
//
// TWO-WAY (human replies from the Hermes web UI) is the OPT-IN `inbound` flag: an authenticated,
// xell-scoped endpoint (see routes.js) that hands the message to the EXISTING sendMessageToXell path
// (the 📨 button), which types it into the live cxell session. Off unless the harness enables it.
import { bus } from './events.js';
import { logline } from './logbus.js';

// xellId → { slug, zeeId, bridge, sessionKey, warned } for xells whose harness declares a mirror.
const registry = new Map();
// avoid stampeding a slow/down Hermes: at most one in-flight POST per xell, newest event wins.
const inFlight = new Set();

// Fill a viewer_url_template ({base_url}/{session_key}) → the Hermes web-UI thread for this xell.
export function hermesThreadUrl(bridge, sessionKey) {
  if (!bridge?.viewer_url_template) return null;
  return bridge.viewer_url_template
    .replaceAll('{base_url}', (bridge.base_url || '').replace(/\/$/, ''))
    .replaceAll('{session_key}', sessionKey);
}

// The X-Hermes-Session-Key for a xell — the slug by default (stable, threads long-term memory).
function sessionKeyFor(slug, bridge) {
  return (bridge?.session_key === 'slug' || !bridge?.session_key) ? slug : String(bridge.session_key);
}

// Register a live zee's outbound mirror. Called at spawn when the assigned harness has a mirror
// bridge. Best-effort discovery handshake (does this Hermes support runs/streaming?) is logged, never
// blocking — matching "surface drift, never guess". Returns the Hermes thread URL (for the UI).
export async function registerHarnessBridge({ xellId, zeeId, slug, harnessLabel, bridge }) {
  if (!bridge || bridge.mode !== 'mirror') return null;
  const sessionKey = sessionKeyFor(slug, bridge);
  registry.set(xellId, { slug, zeeId, bridge, sessionKey, warned: false });
  const thread = hermesThreadUrl(bridge, sessionKey);
  logline('bridge', `${slug}: ${harnessLabel} mirror → ${bridge.base_url || '(no base_url)'} (session-key=${sessionKey})${thread ? ` · thread ${thread}` : ''}`);
  // Discovery: confirm the instance is reachable + advertises the surface we need, without blocking.
  probeDiscovery(bridge, slug).catch(() => {});
  return thread;
}

export function unregisterHarnessBridge(xellId) {
  registry.delete(xellId);
  inFlight.delete(xellId);
}

// Is inbound (human→zee replies from the Hermes web UI) allowed for this xell? Requires the harness
// to opt in (bridge.inbound) AND a shared bridge secret to be configured (fail closed).
export function bridgeInboundConfig(xellId) {
  const r = registry.get(xellId);
  if (!r) return { allowed: false, reason: 'no bridge registered for this xell' };
  if (!r.bridge.inbound) return { allowed: false, reason: 'harness bridge.inbound is off (opt-in)' };
  if (!process.env.HARNESS_BRIDGE_TOKEN) return { allowed: false, reason: 'HARNESS_BRIDGE_TOKEN not configured (inbound fails closed)' };
  return { allowed: true, slug: r.slug };
}

// Look up a registered bridge by SLUG (the inbound route addresses xells by slug/session-key).
export function bridgeBySlug(slug) {
  for (const [xellId, r] of registry) if (r.slug === slug) return { xellId, ...r };
  return null;
}

async function probeDiscovery(bridge, slug) {
  if (!bridge.base_url || process.env.HARNESS_BRIDGE_DRYRUN === '1') return;
  try {
    const res = await fetch(`${bridge.base_url.replace(/\/$/, '')}/v1/discovery`, { method: 'GET', signal: AbortSignal.timeout(4000) });
    logline('bridge', `${slug}: Hermes discovery ${res.ok ? 'ok' : `HTTP ${res.status}`}`);
  } catch (e) {
    logline('bridge', `${slug}: Hermes discovery unreachable (${String(e.message).slice(0, 80)}) — mirror will retry per event`);
  }
}

// Relay ONE normalized event to Hermes for display. Fire-and-forget, at most one in-flight per xell.
// DRYRUN (HARNESS_BRIDGE_TOKEN unset test mode) or a missing base_url → log only, so the pipeline is
// verifiable without a live Hermes.
function relay(xellId, r, ev) {
  if (inFlight.has(xellId)) return;                 // drop-when-busy: display need not be lossless
  const { bridge, sessionKey, slug } = r;
  if (!bridge.base_url || process.env.HARNESS_BRIDGE_DRYRUN === '1') {
    if (!r.warned) { logline('bridge', `${slug}: (dry-run) would mirror ${ev?.type || 'event'} → Hermes thread ${sessionKey}`); r.warned = true; }
    return;
  }
  inFlight.add(xellId);
  const body = JSON.stringify({ session_key: sessionKey, source: 'zeehive', event: ev });
  fetch(`${bridge.base_url.replace(/\/$/, '')}${bridge.append_path || '/v1/runs'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Hermes-Session-Key': sessionKey },
    body, signal: AbortSignal.timeout(6000),
  }).then((res) => {
    if (!res.ok && !r.warned) { logline('bridge', `${slug}: Hermes mirror HTTP ${res.status} (will keep trying)`); r.warned = true; }
  }).catch((e) => {
    if (!r.warned) { logline('bridge', `${slug}: Hermes mirror failed (${String(e.message).slice(0, 80)}) — check base_url/instance`); r.warned = true; }
  }).finally(() => inFlight.delete(xellId));
}

// Subscribe once, at boot: every `zee-output` event for a registered (mirrored) xell is relayed.
let started = false;
export function startHarnessBridge() {
  if (started) return;
  started = true;
  bus.on('event', (e) => {
    if (e?.type !== 'zee-output') return;
    const p = e.payload;
    const r = p?.xell_id && registry.get(p.xell_id);
    if (r) relay(p.xell_id, r, p.event);
  });
  logline('bridge', 'harness conversation bridge started (mirrors registered harnessed zees → their web UI)');
}
