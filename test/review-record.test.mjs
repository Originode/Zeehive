// REVIEW-RECORD integration test — a landed diff that was READ is a first-class record (ticket #56).
//
// The gap this covers: a reviewer cast on a landed diff found a cross-project write hole and a
// mass-assignment path within an hour, and the system recorded NEITHER the review nor its findings.
// `land_request` knows who approved the PUSH, never whether anyone READ the diff. This test proves
// the record exists, lands on the landing/ship read models, and is NOT a gate.
//
// Runs against the REAL db pool (DATABASE_URL) with throwaway rows, and the real lib/queenzee
// functions — no mocks of the logic under test:
//   • `zee review` reaches a zee (CLI usage + case + self route + manual migration)
//   • work-status: `done -> review` is a legal transition ("landed, under review")
//   • selfReview records WHO read a sha, the verdict, findings count and report
//   • the review appears on listLandRequests (the landing card) and listShipRequests (the ship card)
//   • the refusals: missing commit, bad sha, bad verdict
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { q, one, pool } = await import('../server/src/db/pool.js');
const { selfReview } = await import('../server/src/queenzee/self.js');
const { listLandRequests } = await import('../server/src/queenzee/landgate.js');
const { listShipRequests } = await import('../server/src/queenzee/shipgate.js');
const { canTransition, nextStatuses } = await import('../server/src/lib/work-status.js');
// The REAL express router + the identity-token hash + the in-process event bus: the route half of
// this test does NOT reimplement the server — it mounts the actual routes.js router the same way
// server/src/index.js does (express.json + app.use('/api', router)), and the broadcast half asserts
// what the bus actually emits when selfReview runs.
import express from 'express';
const { router } = await import('../server/src/api/routes.js');
const { hashToken } = await import('../server/src/lib/xell-token.js');
const { bus } = await import('../server/src/lib/events.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const SHA = '3959f661f0c1d0e0f0a0b0c0d0e0f0a0b0c0d0e0'; // 40-hex, a stand-in for the landed tip

// ── 1. throwaway rows ─────────────────────────────────────────────────────────
await q(`DELETE FROM project WHERE name='reviewtest'`);
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch)
   VALUES ('reviewtest', '/tmp/reviewtest-repo', 'main') RETURNING *`, []);
const xource = await one(
  `INSERT INTO xource (project_id, ref) VALUES ($1, 'main') RETURNING *`, [project.id]);
const xell = await one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, self_token_hash, zee_type)
   VALUES ($1,$2,'reviewer-slug','spinoff/review','/tmp/reviewtest-wt','working','reviewhash','worker')
   RETURNING *`, [project.id, xource.id]);

try {
  // ── 2. the static half: does the verb reach a zee at all? ──────────────────
  console.log('\n── the verb reaches a zee (CLI · route · manual) ──');
  const cli = read('scripts/zee');
  ok(/--of <sha>/.test(cli) && /\/api\/xell\/self\/review/.test(cli),
     'scripts/zee implements `zee review --of <sha>` against the self route');
  const usage = cli.slice(cli.indexOf('function usage()'), cli.indexOf('switch (cmd)'));
  ok(/zee review --of/.test(usage), 'it is advertised in `zee help`');
  const routes = read('server/src/api/routes.js');
  ok(/xell\/self\/review/.test(routes) && /selfReview/.test(routes),
     'the route exists and maps to selfReview');
  ok(/NOT a gate|not a gate/i.test(usage), 'the usage says it is NOT a gate');

  // ── 3. the board: done -> review is legal ("landed, under review") ──────────
  console.log('\n── the board can say "landed, under review" ──');
  ok(canTransition('done', 'review'), '`done -> review` is now a legal transition');
  ok(nextStatuses('done').includes('review'), '`nextStatuses("done")` offers review');
  ok(!canTransition('cancelled', 'review'), '`cancelled -> review` stays ILLEGAL (only done reopens to review)');
  ok(canTransition('review', 'done'), 'a reviewed card can go back to done (the normal flow still works)');

  // ── 4. the record: selfReview inserts WHO read the sha and what they found ──
  console.log('\n── selfReview records a review ──');
  const badNoCommit = await selfReview(xell, {});
  ok(badNoCommit.ok === false && /--of <sha>/.test(badNoCommit.error || ''),
     `missing commit is refused (${badNoCommit.error})`);
  const badSha = await selfReview(xell, { commit: 'abc' });
  ok(badSha.ok === false && /40-char/.test(badSha.error || ''),
     `a short sha is refused (${badSha.error})`);
  const badVerdict = await selfReview(xell, { commit: SHA, verdict: 'meh' });
  ok(badVerdict.ok === false && /--verdict/.test(badVerdict.error || ''),
     `a bad verdict is refused (${badVerdict.error})`);

  const rev = await selfReview(xell, { commit: SHA, verdict: 'changes-required', findings_count: 3, report: 'cross-project write hole' });
  ok(rev.ok === true, 'a valid review is recorded');
  ok(rev.review?.verdict === 'changes_required', `the hyphen verdict is normalized to the enum (${rev.review?.verdict})`);
  ok(rev.review?.findings_count === 3, 'the findings count is stored');
  ok(rev.review?.reviewer === 'reviewer-slug', 'the reviewer is the calling xell\'s slug');
  ok(rev.review?.commit_sha === SHA, 'the reviewed sha is stored');
  ok(/not a gate/i.test(rev.message || ''), 'the receipt says it is not a gate');

  const row = await one(`SELECT * FROM review WHERE id=$1`, [rev.review.id]);
  ok(row && row.commit_sha === SHA && row.project_id === project.id,
     'the row is in the review table, tied to the project');

  // ── 5. the landing card carries the review ──────────────────────────────────
  console.log('\n── the landing card shows it ──');
  const land = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, status)
     VALUES ($1,$2,'refs/heads/main','0000000000000000000000000000000000000000',$3,'pending') RETURNING *`,
    [project.id, xell.id, SHA]);
  const lands = await listLandRequests(project.id, { open: true });
  const myLand = lands.find((l) => l.id === land.id);
  ok(Array.isArray(myLand?.reviews) && myLand.reviews.length === 1,
     `listLandRequests carries the review (${myLand?.reviews?.length})`);
  ok(myLand.reviews[0]?.reviewer === 'reviewer-slug' && myLand.reviews[0]?.verdict === 'changes_required',
     'and the review names the reviewer and the verdict');
  ok(myLand.reviews[0]?.findings_count === 3, 'and the findings count rides along');

  // ── 6. the ship card carries it too ─────────────────────────────────────────
  console.log('\n── the ship card shows it ──');
  const ship = await one(
    `INSERT INTO ship_request (project_id, xell_id, commit, status, reason)
     VALUES ($1,$2,$3,'pending','shipping the reviewed change') RETURNING *`,
    [project.id, xell.id, SHA]);
  const ships = await listShipRequests(project.id, { open: true });
  const myShip = ships.find((s) => s.id === ship.id);
  ok(Array.isArray(myShip?.reviews) && myShip.reviews.length === 1,
     `listShipRequests carries the review (${myShip?.reviews?.length})`);
  ok(myShip.reviews[0]?.reviewer === 'reviewer-slug' && myShip.reviews[0]?.verdict === 'changes_required',
     'and the review names the reviewer and the verdict');

  // ── 7. it is NOT a gate: an unreviewed landing still lists fine ─────────────
  console.log('\n── recording it never blocks the path ──');
  const sha2 = '1234567890abcdef1234567890abcdef12345678';
  const land2 = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, status)
     VALUES ($1,$2,'refs/heads/main', $3, $4, 'pending') RETURNING *`,
    [project.id, xell.id, SHA, sha2]);
  const lands2 = await listLandRequests(project.id, { open: true });
  const myLand2 = lands2.find((l) => l.id === land2.id);
  ok(Array.isArray(myLand2?.reviews) && myLand2.reviews.length === 0,
     'an unreviewed landing has an empty reviews array — nothing blocks it');

  // ── 8. the REAL route: /xell/self/review over HTTP, auth + body + errors ────
  // The db-sandbox half proves selfReview + the read models; THIS half proves the route wiring the
  // container would otherwise be the only one to exercise — a real bearer token resolved through
  // resolveSelf → xellForToken, express body parsing, and the route's own error envelope. It mounts
  // the ACTUAL routes.js router exactly as server/src/index.js does; only the queenzee loops are
  // absent (they are not part of the review path).
  console.log('\n── the route is real: HTTP + bearer auth + error paths ──');
  const TOKEN = 'review-test-route-token';
  await q(`UPDATE xell SET self_token_hash=$2 WHERE id=$1`, [xell.id, hashToken(TOKEN)]);

  const app = express();
  app.use(express.json({ limit: '30mb' }));
  app.use('/api', router);
  const srv = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
    s.unref?.();
  });
  const routeBase = `http://127.0.0.1:${srv.address().port}/api`;
  const viaRouteSha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  try {
    const noAuth = await fetch(`${routeBase}/xell/self/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    ok(noAuth.status === 401, `a missing bearer token is refused over HTTP (status ${noAuth.status})`);

    const badSha = await fetch(`${routeBase}/xell/self/review`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ commit: 'nope' }) });
    const badShaJson = await badSha.json();
    ok(badSha.status === 200 && badShaJson.ok === false && /40-char/.test(badShaJson.error || ''),
       'the route surfaces the selfReview refusal for a bad sha (no throw, ok:false envelope)');

    const viaRoute = await fetch(`${routeBase}/xell/self/review`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ commit: viaRouteSha, verdict: 'clean', findings_count: 0, report: 'read over HTTP' }) });
    const viaRouteJson = await viaRoute.json();
    ok(viaRouteJson.ok === true && viaRouteJson.review?.commit_sha === viaRouteSha
       && viaRouteJson.review?.reviewer === 'reviewer-slug',
       `a real HTTP POST records the review (${viaRouteJson.review?.commit_sha?.slice(0, 10)} — route, not direct call)`);
  } finally {
    await new Promise((r) => srv.close(r));
  }

  // ── 9. the broadcast path: selfReview emits review + xell events on the bus ──
  // The SSE/websocket fan-out to a BROWSER is container territory, but the server half of that path
  // is this in-process bus emission — the exact event frames /api/stream and /api/stream/ws relay.
  // A connected console hears the `review` row AND the `xell` touch (which is in the client's
  // STREAM_TYPES, so it re-reads the fleet and the landing/ship cards repaint with the new chip).
  console.log('\n── the broadcast path fires ──');
  const seenEvents = [];
  const onBusEvent = (e) => { seenEvents.push(e); };
  bus.on('event', onBusEvent);
  try {
    const revBcast = await selfReview(xell, { commit: viaRouteSha, verdict: 'clean', findings_count: 1, report: 'broadcast check' });
    ok(revBcast.ok === true, 'a second review is recorded for the broadcast check');
    const reviewEv = seenEvents.find((e) => e.type === 'review');
    const xellEv = seenEvents.find((e) => e.type === 'xell');
    ok(reviewEv && reviewEv.payload?.commit_sha === viaRouteSha && reviewEv.payload?.reviewer === 'reviewer-slug',
       'the review row is broadcast as a `review` event frame');
    ok(xellEv && xellEv.payload?.id === xell.id,
       'a `xell` touch is broadcast so a connected console re-reads the cards');
  } finally {
    bus.removeListener('event', onBusEvent);
  }
} finally {
  // Clean up only our rows (house rule 1: no test data left behind).
  await q(`DELETE FROM review WHERE project_id=$1`, [project.id]);
  await q(`DELETE FROM land_request WHERE project_id=$1`, [project.id]);
  await q(`DELETE FROM ship_request WHERE project_id=$1`, [project.id]);
  await q(`DELETE FROM xell WHERE id=$1`, [xell.id]);
  await q(`DELETE FROM xource WHERE project_id=$1`, [project.id]);
  await q(`DELETE FROM project WHERE id=$1`, [project.id]);
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
