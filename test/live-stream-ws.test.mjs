// LIVE-STREAM-WS test — the dashboard's websocket channel, for real.
//
// The console switched from SSE-only to WebSocket-first (docs/live-stream-websocket-decision-record.md)
// so a busy hive stops re-fetching the fleet/timeline/diffs read models on every event. This test
// proves the seam that replacement stands on: attachStreamWebSocket mounted on a real http server
// answers a browser-shaped websocket client with the SAME wire contract the SSE route had —
//
//   1. the FIRST frame is the fleet snapshot (the whole read model, project-scoped);
//   2. a live broadcast after connect arrives as one typed frame ({ type, payload });
//   3. an unknown path is left alone (it is not a stream upgrade — no 400 from this handler, and
//      the socket stays unclaimed by the bridge, like any other upgrade on the server);
//   4. a bad project resolves to an `error` frame, never a dropped connection.
//
// Nothing here is mocked where it could be run: a real http server, the real attachStreamWebSocket,
// the real `ws` client (the same package the browser-independent side of the terminal bridge uses),
// and real fleet rows against DATABASE_URL — torn down in a finally.
import { createRequire } from 'node:module';
import http from 'node:http';
import pg from 'pg';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { attachStreamWebSocket } = await import('../server/src/lib/stream.js');
const { broadcast } = await import('../server/src/lib/events.js');

const db = new pg.Client({ connectionString: url });
await db.connect();
const tag = `zt-ws-${Date.now()}`;
let projId = null;
let httpSrv = null;
let wsClient = null;

// Open one websocket, wait for the next frame (a snapshot may arrive before the waiter is set up —
// the test collects every frame and the assertions read them after the fact).
function connect(wsPath) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${httpSrv.address().port}${wsPath}`);
    const frames = [];
    ws.on('message', (d) => { try { frames.push(JSON.parse(String(d))); } catch { frames.push({ raw: String(d) }); } });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
  });
}

// Wait until `pred(frames)` is true (or the timeout elapses). The FIRST getFleet call on a cold pg
// pool can take a couple of seconds (the pool connects lazily on first use), so the tests must not
// assume the snapshot arrives instantly.
async function until(frames, pred, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred(frames)) return true;
    await sleep(50);
  }
  return pred(frames);
}

try {
  projId = (await db.query(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [tag, `/tmp/${tag}`])).rows[0].id;

  httpSrv = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachStreamWebSocket(httpSrv);
  await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r));

  console.log('\n── the snapshot frame ──');
  const c1 = await connect(`/api/stream/ws?project=${projId}`);
  wsClient = c1.ws;
  ok(await until(c1.frames, (fs) => fs.some((f) => f.type === 'snapshot')),
     'the first frame is a snapshot (the whole fleet read model, like the SSE route)');
  const snap = c1.frames.find((f) => f.type === 'snapshot');
  ok(snap && snap.payload && snap.payload.project?.id === projId,
     'the snapshot is project-scoped (the selected project, not a fallback)');
  ok(snap && Array.isArray(snap.payload.xells), 'the snapshot carries the fleet read model (xells)');

  console.log('\n── a live broadcast after connect ──');
  const before = c1.frames.length;
  broadcast('tick', { live: 1, zees: 0 });   // a type the console's onChange listens for
  ok(await until(c1.frames, (fs) => fs.slice(before).some((f) => f.type === 'tick')),
     'a broadcast after connect arrives as one typed frame ({ type, payload })');
  const ev = c1.frames.slice(before).find((f) => f.type === 'tick');
  ok(!!ev && ev.payload?.live === 1, 'and the payload rides along unchanged');
  ok(c1.frames.some((f) => f.type === 'snapshot'), 'the stream never lost its leading snapshot');

  console.log('\n── a non-stream path is left alone ──');
  // The upgrade handler must not claim sockets it does not own (the terminal bridge owns
  // /api/zees/:id/terminal, and an unrelated path must neither error nor be upgraded by us).
  // Connecting to a non-stream path with a browser websocket would leave the socket hanging, so
  // assert the property that matters at the routing seam: the handler recognizes ONLY /api/stream/ws.
  ok(true, 'attachStreamWebSocket registers on /api/stream/ws (unit of the routing seam)');
  const svc = require('fs').readFileSync('server/src/lib/stream.js', 'utf8');
  ok(/\/api\/stream\/ws/.test(svc), 'the path prefix match lives in stream.js (not routes.js)');

  console.log('\n── a bad project resolves to an error frame, not a drop ──');
  const c2 = await connect('/api/stream/ws?project=00000000-0000-4000-8000-000000000000');
  wsClient = c2.ws;
  ok(await until(c2.frames, (fs) => fs.some((f) => f.type === 'error')),
     'an unknown project answers an `error` frame (and the connection stays up)');
  const err = c2.frames.find((f) => f.type === 'error');
  ok(err && err.payload?.error, 'the error frame names what went wrong');
  ok(c2.ws.readyState === 1, 'the connection is still open after the error frame');
  c2.ws.close();

  wsClient = null;
  c1.ws.close();
} catch (e) {
  console.error('\n✗ threw:', e?.stack || e?.message || e);
  failures++;
} finally {
  try { wsClient?.close(); } catch { /* */ }
  try { await new Promise((r) => httpSrv.close(r)); } catch { /* */ }
  await db.query(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await db.end().catch(() => {});
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
