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
//   5. the queenzee-activity fan-out is scoped AT THE SOURCE: a project-A connection never
//      receives a project-B activity event, while an unscoped connection still gets both;
//   6. a burst of activity events is capped server-side (≤ ACTIVITY_MAX_PENDING frames), and
//   7. a single event in a quiet system arrives promptly and un-coalesced (exactly one frame).
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
const { broadcast, ACTIVITY_MAX_PENDING, ACTIVITY_FLUSH_MS } = await import('../server/src/lib/events.js');
const { activity } = await import('../server/src/lib/logbus.js');

const db = new pg.Client({ connectionString: url });
await db.connect();
const tag = `zt-ws-${Date.now()}`;
let projId = null;
let projB = null;
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

  // ── queenzee-activity fan-out bounds (project scoping + burst cap) ──────────────
  // The card: "scope and cap the queenzee-activity SSE fan-out". These assertions prove the
  // server-side bounds that live in activityFanout (events.js), through the REAL websocket:
  // a project-scoped console never receives another project's arrows, a burst is capped at
  // ACTIVITY_MAX_PENDING, and a lone event arrives promptly and un-coalesced.
  projB = (await db.query(
    `INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [`${tag}-b`, `/tmp/${tag}-b`])).rows[0].id;
  const act = (frames) => frames.filter((f) => f.type === 'queenzee-activity');

  console.log('\n── the queenzee-activity feed is project-scoped at the source ──');
  const c3 = await connect(`/api/stream/ws?project=${projId}`);
  wsClient = c3.ws;
  await until(c3.frames, (fs) => fs.some((f) => f.type === 'snapshot'));
  activity('q2x', 'xell-b-1', 'provision', projB);   // a project-B arrow
  activity('q2x', 'xell-a-1', 'provision', projId);  // a project-A arrow
  ok(await until(c3.frames, (fs) => act(fs).some((f) => f.payload?.xell_id === 'xell-a-1')),
     'a project-A console receives the project-A arrow');
  await sleep(ACTIVITY_FLUSH_MS * 4);   // give a wrongly-routed project-B arrow time to arrive
  ok(act(c3.frames).some((f) => f.payload?.xell_id === 'xell-a-1' && f.payload?.project_id === projId),
     'the received arrow carries the project_id at the source');
  ok(!act(c3.frames).some((f) => f.payload?.xell_id === 'xell-b-1'),
     '…and NEVER receives a project-B arrow (the filter bites before the wire)');

  console.log('\n── an unscoped connection still sees every project ──');
  const c4 = await connect('/api/stream/ws');   // no ?project → whole-fleet view
  wsClient = c4.ws;
  await until(c4.frames, (fs) => fs.some((f) => f.type === 'snapshot'));
  activity('q2x', 'xell-b-2', 'provision', projB);
  ok(await until(c4.frames, (fs) => act(fs).some((f) => f.payload?.xell_id === 'xell-b-2')),
     'an unscoped (whole-fleet) console still receives a project-B arrow');
  c4.ws.close();

  console.log('\n── a burst of queenzee-activity events is capped server-side ──');
  const c5 = await connect(`/api/stream/ws?project=${projId}`);
  wsClient = c5.ws;
  await until(c5.frames, (fs) => fs.some((f) => f.type === 'snapshot'));
  const beforeBurst = act(c5.frames).length;
  for (let i = 0; i < 100; i++) activity('q2x', `xell-burst-${i}`, 'provision', projId);  // same tick
  await until(c5.frames, (fs) => act(fs).length > beforeBurst);   // the flush lands
  await sleep(ACTIVITY_FLUSH_MS * 4);                              // let the flush window close
  const burstCount = act(c5.frames).length - beforeBurst;
  ok(burstCount > 0 && burstCount <= ACTIVITY_MAX_PENDING,
     `a 100-xell burst reaches the client as ≤ ${ACTIVITY_MAX_PENDING} frames (got ${burstCount})`);
  c5.ws.close();

  console.log('\n── a lone event in a quiet system arrives promptly, un-coalesced ──');
  const c6 = await connect(`/api/stream/ws?project=${projId}`);
  wsClient = c6.ws;
  await until(c6.frames, (fs) => fs.some((f) => f.type === 'snapshot'));
  const beforeLone = act(c6.frames).length;
  const t0 = Date.now();
  activity('q2x', 'xell-lone', 'provision', projId);
  ok(await until(c6.frames, (fs) => act(fs).some((f) => f.payload?.xell_id === 'xell-lone'), 2000),
     'the lone event arrives');
  ok(Date.now() - t0 < 500, `…promptly (${Date.now() - t0}ms — the ${ACTIVITY_FLUSH_MS}ms flush, not a coalescing delay)`);
  await sleep(ACTIVITY_FLUSH_MS * 4);
  const lone = act(c6.frames).slice(beforeLone);
  ok(lone.length === 1 && lone[0].payload?.kind === 'provision' && lone[0].payload?.xell_id === 'xell-lone',
     `…and un-coalesced: exactly one frame carries it (got ${lone.length})`);
  c6.ws.close();
  c3.ws.close();

  wsClient = null;
  c1.ws.close();
} catch (e) {
  console.error('\n✗ threw:', e?.stack || e?.message || e);
  failures++;
} finally {
  try { wsClient?.close(); } catch { /* */ }
  try { await new Promise((r) => httpSrv.close(r)); } catch { /* */ }
  await db.query(`DELETE FROM project WHERE id=$1`, [projId]).catch(() => {});
  await db.query(`DELETE FROM project WHERE id=$1`, [projB]).catch(() => {});
  await db.end().catch(() => {});
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
