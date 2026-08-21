// ACTIVITY-FANOUT test — the per-connection bounds on the queenzee-activity SSE fan-out.
//
// The console's live stream (SSE /api/stream and WS /api/stream/ws) used to forward every
// queenzee-activity event to every connection: a project-A console received project-B's arrows
// (wasted fan-out and a privacy smell), and a fleet storm pushed N events to every connected
// console, uncapped — the client's 14-arrow / 32-buffered caps apply AFTER the wire. The
// server-side bounds live in activityFanout (events.js):
//
//   1. PROJECT SCOPING — a connection created for project A receives only events whose
//      project_id is A (a missing project_id is dropped too — the caller was supposed to stamp
//      it), while an unscoped (whole-fleet) connection still receives everything;
//   2. BURST CAP — same (xell_id, dir) events collapse to one frame, and the pending set is
//      capped at ACTIVITY_MAX_PENDING distinct arrows, so a 100-event burst reaches the client
//      as ≤ ACTIVITY_MAX_PENDING frames, and the overflow is evicted oldest-first;
//   3. PROMPTNESS — a lone event in a quiet system arrives on the very next flush
//      (≤ ACTIVITY_FLUSH_MS) and un-coalesced (exactly one frame).
//
// This is the unit of the shared helper; live-stream-ws.test.mjs proves the same bounds through
// the real websocket + fleet rows. No database is required here — the helper only touches the
// in-process bus.
import { bus, broadcast, activityFanout, ACTIVITY_MAX_PENDING, ACTIVITY_FLUSH_MS } from '../server/src/lib/events.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for the trailing-edge flush (and a little extra) so a wrongly-delivered frame has time to land.
const settle = () => sleep(ACTIVITY_FLUSH_MS * 4);

// Wire ONE connection against the real bus, exactly like the SSE/WS routes do, and return a
// handle whose `frames` are the queenzee-activity events that reached this connection.
function connection(projectId) {
  const frames = [];
  const { onEvent, close } = activityFanout(projectId, (e) => frames.push(e));
  bus.on('event', onEvent);
  return {
    frames,
    close() { close(); bus.off('event', onEvent); },
  };
}

try {
  console.log('\n── project scoping: a project-A connection never sees project-B ──');
  const a = connection('projA');
  broadcast('queenzee-activity', { dir: 'q2x', xell_id: 'x-a', kind: 'provision', ts: Date.now(), project_id: 'projA' });
  broadcast('queenzee-activity', { dir: 'q2x', xell_id: 'x-b', kind: 'provision', ts: Date.now(), project_id: 'projB' });
  broadcast('queenzee-activity', { dir: 'q2x', xell_id: 'x-orphan', kind: 'provision', ts: Date.now(), project_id: null });
  await settle();
  ok(a.frames.some((e) => e.payload?.xell_id === 'x-a'), 'the project-A arrow arrives');
  ok(!a.frames.some((e) => e.payload?.xell_id === 'x-b'), 'the project-B arrow is dropped at the source');
  ok(!a.frames.some((e) => e.payload?.xell_id === 'x-orphan'), 'an un-stamped (null project) arrow is dropped on a scoped connection');
  a.close();

  console.log('\n── an unscoped connection still sees every project ──');
  const all = connection(null);
  broadcast('queenzee-activity', { dir: 'q2x', xell_id: 'x-b2', kind: 'provision', ts: Date.now(), project_id: 'projB' });
  broadcast('queenzee-activity', { dir: 'q2x', xell_id: 'x-null', kind: 'provision', ts: Date.now(), project_id: null });
  await settle();
  ok(all.frames.some((e) => e.payload?.xell_id === 'x-b2'), 'a project-B arrow reaches an unscoped console');
  ok(all.frames.some((e) => e.payload?.xell_id === 'x-null'), 'an un-stamped arrow reaches an unscoped console');
  all.close();

  console.log('\n── non-activity events ride through unchanged ──');
  const passthru = connection('projA');
  broadcast('tick', { n: 1 });
  broadcast('xell', { id: 'x' });
  await sleep(5);
  ok(passthru.frames.some((e) => e.type === 'tick' && e.payload?.n === 1), 'a tick broadcast still arrives');
  ok(passthru.frames.some((e) => e.type === 'xell'), 'an xell broadcast still arrives');
  passthru.close();

  console.log('\n── same (xell_id, dir) events collapse to one frame ──');
  const one = connection('projA');
  for (const kind of ['provision', 'land', 'push']) {
    broadcast('queenzee-activity', { dir: 'x2q', xell_id: 'x-same', kind, ts: Date.now(), project_id: 'projA' });
  }
  await settle();
  ok(one.frames.length === 1, `a 3-event burst on one arrow collapses to 1 frame (got ${one.frames.length})`);
  ok(one.frames[0]?.payload?.kind === 'push', '…and the LATEST kind wins (the arrow shows the newest state)');
  one.close();

  console.log(`\n── a burst is capped at ACTIVITY_MAX_PENDING (${ACTIVITY_MAX_PENDING}) ──`);
  const burst = connection('projA');
  for (let i = 0; i < 100; i++) {
    broadcast('queenzee-activity', { dir: 'q2x', xell_id: `x-${i}`, kind: 'provision', ts: Date.now(), project_id: 'projA' });
  }
  await settle();
  ok(burst.frames.length > 0 && burst.frames.length <= ACTIVITY_MAX_PENDING,
     `a 100-distinct-xell burst reaches the client as ≤ ${ACTIVITY_MAX_PENDING} frames (got ${burst.frames.length})`);
  burst.close();

  console.log('\n── a lone event in a quiet system arrives promptly, un-coalesced ──');
  const lone = connection('projA');
  const t0 = Date.now();
  broadcast('queenzee-activity', { dir: 'q2x', xell_id: 'x-lone', kind: 'provision', ts: Date.now(), project_id: 'projA' });
  await sleep(ACTIVITY_FLUSH_MS * 2);
  ok(lone.frames.length === 1, `exactly one frame arrives (got ${lone.frames.length})`);
  ok(lone.frames[0]?.payload?.xell_id === 'x-lone' && lone.frames[0]?.payload?.kind === 'provision',
     'the frame carries the lone event');
  ok(Date.now() - t0 < 500, `…promptly (${Date.now() - t0}ms — the ${ACTIVITY_FLUSH_MS}ms flush, not a coalescing delay)`);
  lone.close();
} finally {
  // No timers left behind: close() clears each connection's flush timer.
  bus.removeAllListeners('event');
}

console.log(failures === 0 ? '\nALL PASSED ✓' : `\n${failures} FAILURE(S) ✗`);
process.exit(failures ? 1 : 0);
