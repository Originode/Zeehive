// WebSocket live stream — the upgrade-path twin of the SSE /api/stream route.
//
// WHY A SECOND CHANNEL: the dashboard subscribes to /api/stream (SSE) and, on EVERY event,
// re-runs the fleet + timeline + diffs read models over plain HTTP. A busy hive emits a 'zee' or
// 'xell' broadcast every few seconds, so each open tab is continuously re-fetching three heavy
// read models it just fetched a moment ago — the "spamming timeline, diffs and fleet API requests"
// this channel exists to stop. See docs/live-stream-websocket-decision-record.md.
//
// Same contract as the SSE route, so the two can be swapped without touching a consumer:
//   • the FIRST frame is `{ type: 'snapshot', payload: <the fleet read model> }`;
//   • every frame after is `{ type: <event type>, payload: <event payload> }` for the same event
//     types the SSE route broadcasts;
//   • the connection is project-scoped via `?project=<id>`, exactly like /api/stream.
//
// The WebSocket is preferred over SSE because it is a single multiplexed connection: the client
// sends the current project once (as a query param), the server keeps ONE socket per tab, and a
// project switch re-connects with the new project id — there is no N-event-streams-per-tab
// proliferation the way there is with per-channel EventSources.
//
// Kept OUT of routes.js on purpose: this is a raw `upgrade` handler, not an HTTP route, and it
// must sit on the SAME http.Server the app tier binds (so the vite dev proxy and the prod nginx
// bundle — both already ws-aware for the cxell terminal — carry it with no extra port). It rides
// the server's 'upgrade' event next to attachTerminalBridge; both use the noServer pattern, and
// `ws` is already a dependency (the terminal bridge uses it).
import { WebSocketServer } from 'ws';
import { bus } from './events.js';
import { getFleet } from './fleet.js';

const DEFAULT_PING_MS = 20000;   // same cadence as the SSE route's comment frames
const PING_TEXT = JSON.stringify({ type: 'ping' });

export function attachStreamWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (!url.startsWith('/api/stream/ws')) return;   // not ours — leave it for other handlers
    wss.handleUpgrade(req, socket, head, (ws) => openStream(ws, url));
  });

  return wss;
}

async function openStream(ws, url) {
  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  // The leading fleet snapshot, so a fresh client renders immediately — the same promise the SSE
  // route makes. Deliberately best-effort: a NAS blip must not kill the stream (the lesson of the
  // async-route unhandled rejection that took the queenzee down), so a failed snapshot becomes an
  // `error` frame and the live channel still works.
  try {
    const project = new URL(url, 'http://localhost').searchParams.get('project');
    const fleet = await getFleet(project);
    if (fleet) send({ type: 'snapshot', payload: fleet });
    else send({ type: 'error', payload: { error: 'no project' } });
  } catch (err) {
    console.error('[stream] ws snapshot failed:', err.message);
    send({ type: 'error', payload: { error: err.message } });
  }

  // Every bus event rides out as one frame, exactly as the SSE route writes it.
  const onEvent = (e) => send({ type: e.type, payload: e.payload });
  bus.on('event', onEvent);
  // Keep the socket alive through idle proxies — mirrors the SSE route's :ping comment frames.
  const ping = setInterval(() => send(PING_TEXT), DEFAULT_PING_MS);
  ws.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
  ws.on('error', () => { clearInterval(ping); bus.off('event', onEvent); });
}
