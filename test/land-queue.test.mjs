// LAND-QUEUE integration test — the RUNWAY and its HOLDING PATTERN, end to end.
//
// The deadlock this protocol ends: two zees finish together and both push to main. Both are held, so
// a human gets TWO cards for one runway; approving either moves the ref, and the other can never
// fast-forward again. It is swept 'stale', its zee is sent back to `zee sync`, and a human was asked
// to decide something that already had no outcome.
//
// So: one open landing per ref. A push that arrives while another xell's landing is open enters a
// holding pattern with a POSITION — recorded, never a card — and when the runway frees the queenzee
// CLEARS the next holder by resuming its session with `zee sync` → `zee land`.
//
// Everything below is the REAL code path against a throwaway postgres + REAL git repos + the REAL
// land-gate `update` hook. The only two seams are the ones a cxell genuinely provides and this box
// does not: `docker` (test/_bin, whose argv+stdin we ASSERT on for the clearance prompt) and the tiny
// HTTP server the git hook curls (which calls the SAME checkPush the route calls).
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_PORT = 47997;
const API = `http://127.0.0.1:${API_PORT}`;
process.env.ZEEHIVE_API = API;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { q, one, pool } = await import('../server/src/db/pool.js');
const { selfLand, selfWithdrawLand, selfStatus } = await import('../server/src/queenzee/self.js');
const { checkPush, decideLandRequest, listLandRequests, openLandRequests, runwayOccupant,
        holdingQueue, sweepHoldingPattern, sweepStalePending, clearRunway, tick } =
  await import('../server/src/queenzee/landgate.js');
const { tendOpen } = await import('../server/src/lib/status.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A REAL `git push . HEAD:main` through the REAL update hook, spawned ASYNC on purpose: the hook
// curls back into this same process, so a synchronous push would block the loop that has to answer
// it (the self-deadlock pushToXource documents). Returns everything the pusher sees.
const realPush = (wt) => new Promise((resolve) => {
  const p = spawn('git', ['-C', wt, 'push', '.', 'HEAD:refs/heads/main'], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('error', (e) => resolve(`${out}\n${e.message}`));
  p.on('close', () => resolve(out));
});

// The nudge is fire-and-forget; the fake docker records it. Reset before each clearance we assert on.
const DOCKER_LOG = join(mkdtempSync(join(tmpdir(), 'queue-log-')), 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
const readLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const resetLog = () => { try { rmSync(DOCKER_LOG); } catch { /* first run */ } };
// TWO waits, in this order, because they are two different kinds of fact.
//
// `awaitCleared` polls the ROW: clearing a holder is a database write the queenzee makes before it
// tries to reach anyone, so it is deterministic and quick. `awaitResume` polls the fake docker log
// for the resume itself, which is fire-and-forget — spawning it takes as long as it takes, and on a
// loaded box that is not 100ms. Asserting the delivery without first pinning the state change is
// what made this test flaky: one nudge that lost the race failed seven assertions downstream and
// read as a broken protocol rather than a slow spawn.
async function awaitCleared(id) {
  for (let i = 0; i < 60; i++) {
    const r = await one(`SELECT cleared_at FROM land_request WHERE id=$1`, [id]);
    if (r?.cleared_at) return true;
    await sleep(100);
  }
  return false;
}
const lastHolding = (xellId) => one(
  `SELECT id FROM land_request WHERE xell_id=$1 AND status='holding'
     ORDER BY requested_at DESC LIMIT 1`, [xellId]);
// TICKET #19 — why this waits for the WHOLE invocation and not just `--resume`.
//
// The fake docker writes its argv line the instant it starts, and the PROMPT only after it has
// finished READING STDIN. Those are two writes with a real gap between them, and everything the
// assertions actually care about — "runway is CLEAR", `zee sync` before `zee land`, "not an
// approval" — lives in the second one. Returning as soon as `--resume` appeared meant the caller
// asserted on a half-written log: green when the box was quiet, red about once in thirty when it
// was not, and reading as a broken clearance protocol rather than a slow spawn. (Case 9 had grown
// its own extra polling loop for exactly this; the other five call sites had not.)
//
// So: wait until the invocation that matches `want` is COMPLETE — a closed stdin block is the
// marker that it was fully recorded. Per INVOCATION, because one clearance step can produce TWO of
// them (case 9 nudges the stale occupant AND clears the holder behind it), and "some resume, fully
// written" would return on the first while the second was half-recorded — the same bug one layer up.
// Callers pass what they are about to assert on, so the wait and the assertion can never drift.
//
// Proof this is the WAIT and not the protocol: with the gap forced deterministically
// (DOCKER_FAKE_SLOW_STDIN_MS) the pre-fix test failed 7 assertions across 5 cases every run, while
// every ROW-level assertion — cleared_at, the tend, the go-around itself — still passed; and a timed
// probe put the argv line at 32ms and the prompt at 1,526ms of the SAME invocation. Late, not lost.
const invocations = (log) => log.split(/^=== docker /m).slice(1).map((r) => `=== docker ${r}`);
async function awaitResume(want = /--resume/) {
  const done = () => invocations(readLog())
    .some((rec) => want.test(rec) && /STDIN<<[\s\S]*>>STDIN/.test(rec));
  for (let i = 0; i < 160 && !done(); i++) await sleep(150);
  return readLog();
}

// ── 1. one xource, TWO xells that both work on it ─────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'land-queue-'));
const src = join(tmp, 'src');
const wtA = join(tmp, 'wt-a');
const wtB = join(tmp, 'wt-b');
git(tmp, ['init', '-q', '-b', 'main', 'src']);
const cfg = (k, v) => git(src, ['config', k, v]);
cfg('user.email', 'test@zeehive.local'); cfg('user.name', 'test');
cfg('receive.denyCurrentBranch', 'ignore');
writeFileSync(join(src, 'a.txt'), 'A\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'A (base)']);
const shaA = git(src, ['rev-parse', 'HEAD']);
git(src, ['worktree', 'add', '-q', '-b', 'spinoff/alpha', wtA, shaA]);
git(src, ['worktree', 'add', '-q', '-b', 'spinoff/bravo', wtB, shaA]);
for (const wt of [wtA, wtB]) { git(wt, ['config', 'user.email', 'zee@zeehive.local']); git(wt, ['config', 'user.name', 'zee']); }
const commit = (wt, file, text, msg) => {
  writeFileSync(join(wt, file), text); git(wt, ['add', '.']); git(wt, ['commit', '-qm', msg]);
  return git(wt, ['rev-parse', 'HEAD']);
};
commit(wtA, 'alpha.txt', 'alpha 1\n', 'A1 (alpha work)');
commit(wtB, 'bravo.txt', 'bravo 1\n', 'B1 (bravo work)');

// ── 2. throwaway rows: one project, two LIVE cxelld zees ──────────────────────
await q(`DELETE FROM project WHERE name='landqueuetest'`);
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch, auto_approve_land)
   VALUES ('landqueuetest', $1, 'main', false) RETURNING *`, [src]);
const xource = await one(
  `INSERT INTO xource (project_id, ref, xell_id) VALUES ($1,'main',NULL) RETURNING *`, [project.id]);
const mkXell = (slug, branch, wt) => one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, self_token_hash)
   VALUES ($1,$2,$3,$4,$5,$6,'working',$7) RETURNING *`,
  [project.id, xource.id, slug, branch, wt, shaA, `hash-${slug}`]);
const mkZee = (xellId, sid, port) => one(
  `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, viewer_kind, viewer_url,
                    claude_session_id, model, status)
   VALUES ($1,'headless-spawn','cxell-cli','headless','ssh-terminal',$3,$2,'opus','idle') RETURNING id`,
  [xellId, sid, `ssh://zee@127.0.0.1:${port}`]);
const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const alpha = await mkXell('queue-alpha', 'spinoff/alpha', wtA);
const bravo = await mkXell('queue-bravo', 'spinoff/bravo', wtB);
await mkZee(alpha.id, SID_A, 22101);
await mkZee(bravo.id, SID_B, 22102);

// ── 3. the REAL update hook, pointed at a checkPush server ────────────────────
const hook = read('hooks/land-gate-update.sh')
  .replaceAll('__API__', API)
  .replaceAll('__PROJECT_ID__', project.id)
  .replaceAll('__PROTECTED_REFS_FILE__', join(tmp, 'no-such-refs-file'))
  .replaceAll('__MAIN_BRANCH__', 'main');
writeFileSync(join(src, '.git', 'hooks', 'update'), hook); chmodSync(join(src, '.git', 'hooks', 'update'), 0o755);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/api/land/check')) { res.statusCode = 404; return res.end('{}'); }
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const { project_id, ref, old, new: newSha } = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(await checkPush({ projectId: project_id, ref, oldSha: old, newSha })));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ allow: false, reason: 'gate-error', error: e.message })); }
  });
});
await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r));

// ── 4. TWO XELLS PUSH → exactly ONE human card ────────────────────────────────
console.log('\n── two xells push to the same main → one card, one holder ──');
const landA = await selfLand(alpha);
ok(landA.status === 'held', `alpha is on the runway: HELD for a human (${landA.status})`);
const landB = await selfLand(bravo);
ok(landB.status === 'holding', `bravo is NOT a second card — it is HOLDING (${landB.status})`);
// THE GIT HOOK'S OWN WORDS. It is the first thing a pushing zee reads and the one surface the
// server cannot correct afterwards — so a queued push must not be told "a human must verify this"
// about a card nobody raised. Pushed for real (async: the hook curls back into this process, and a
// synchronous push would deadlock against its own gate — the reason pushToXource spawns async).
const hookOut = await realPush(wtB);
ok(/HOLDING PATTERN/.test(hookOut), 'the git hook says HOLDING PATTERN, not "LANDING HELD"');
ok(!/tell your human the landing is waiting/.test(hookOut),
   'and does NOT send the zee chasing a card that was never raised');
ok(/zee sync/.test(hookOut) && /zee land/.test(hookOut), 'it names the go-around, in order');
ok(/NOTHING was rejected/.test(hookOut), 'and says plainly that nothing was rejected');
ok(landB.position === 1, `and it is told its position: #${landB.position}`);
ok(landB.behind?.xell_slug === 'queue-alpha', `it is told WHO is on the runway (${landB.behind?.xell_slug})`);
ok(/HOLDING at position 1/.test(landB.message || ''), 'the message leads with the position, not with a refusal');
ok(/zee sync/.test(landB.message || '') && /RESUMES/.test(landB.message || ''),
   'and it says what happens next: it will be resumed, then sync + land');
ok(!/rejected/i.test(landB.message || '') || /NOT rejected/.test(landB.message || ''),
   'it is explicit that nothing was rejected');

const cards = await listLandRequests(project.id, { open: true });
ok(cards.length === 1, `GET /api/land/requests shows exactly ONE open landing (${cards.length})`);
ok(cards[0].xell_id === alpha.id, 'and it is alpha\'s — the one that got there first');
ok((await openLandRequests(bravo.id)).length === 0,
   'bravo has NO open request: a holding row is not a card in front of a human');
const rowB = await one(`SELECT * FROM land_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [bravo.id]);
ok(rowB.status === 'holding' && rowB.holding_since && !rowB.cleared_at, 'bravo\'s row is holding, with a holding_since');
ok(!rowB.decided_at && !rowB.decided_by, 'and carries NO decision — holding is not a judgement');
ok(rowB.behind_request_id === cards[0].id, 'the row records which landing it entered the pattern behind');
const stB = await selfStatus(bravo);
ok(stB.landing?.status === 'holding' && stB.landing?.holding === true && stB.landing?.position === 1,
   '`zee status` tells bravo it is holding at position 1');
ok(/HOLDING at position 1/.test(stB.landing?.note || ''), 'with a note a zee can act on');
ok(git(src, ['rev-parse', 'main']) === shaA, 'main has not moved — nothing landed on its own');

// A holding zee that pushes AGAIN keeps its one place in line (no second slot for pushing twice).
const landB2 = await selfLand(bravo);
ok(landB2.status === 'holding' && landB2.position === 1, `re-pushing while holding stays at #${landB2.position}`);
ok((await holdingQueue(project.id, 'refs/heads/main')).length === 1, 'and the queue still has exactly one holder');

// ── 5. THE DATABASE REFUSES A PROMOTION ───────────────────────────────────────
console.log('\n── a holding request can never be approved without a human ──');
let promoted = null;
await q(`UPDATE land_request SET status='approved', decided_at=now(), decided_by='someone' WHERE id=$1`, [rowB.id])
  .catch((e) => { promoted = e.message; });
ok(/cannot become/.test(promoted || ''), `the DB refuses holding → approved (${(promoted || 'NOT REFUSED').slice(0, 60)}…)`);
let landedDirect = null;
await q(`UPDATE land_request SET status='landed', landed_at=now(), decided_at=now(), decided_by='x' WHERE id=$1`, [rowB.id])
  .catch((e) => { landedDirect = e.message; });
ok(/cannot become/.test(landedDirect || ''), 'and holding → landed');
ok((await one(`SELECT status FROM land_request WHERE id=$1`, [rowB.id])).status === 'holding',
   'the row is still holding — no path promoted it');
let decidedHolding = null;
await q(`UPDATE land_request SET decided_by='human@test', decided_at=now() WHERE id=$1`, [rowB.id])
  .catch((e) => { decidedHolding = e.message; });
ok(/land_holding_never_decided/.test(decidedHolding || ''),
   'and a holding row cannot even be given a decider (the check constraint)');

// ── 6. THE FIRST LANDS → the holder is CLEARED with a real prompt ─────────────
console.log('\n── alpha lands → bravo is cleared, by a resume that names sync then land ──');
resetLog();
const decided = await decideLandRequest(cards[0].id, 'approved', 'human@test');
ok(decided?.status === 'landed', `alpha's landing landed (${decided?.status})`);
ok(await awaitCleared(rowB.id), 'bravo was cleared out of the pattern (the row says so before anyone is nudged)');
const log = await awaitResume(/runway is CLEAR/);
ok(/exec/.test(log) && /--resume/.test(log), 'the queenzee ran `docker exec … claude … --resume`');
ok(log.includes(SID_B), `the resume targeted BRAVO's cxell session (${SID_B.slice(0, 8)}…), the holder`);
ok(/runway is CLEAR/.test(log), 'the prompt tells it the runway is clear');
// Read the CLEARANCE prompt alone: the same land also resumed ALPHA with the after-land prompt, and
// that one names `zee land` too — measuring the order across both logs would prove nothing.
const clearance = (log.split('STDIN<<').find((s) => /runway is CLEAR/.test(s)) || '');
const zsync = clearance.indexOf('`zee sync`'), zland = clearance.indexOf('`zee land`');
ok(zsync > 0 && zland > zsync, 'and names `zee sync` BEFORE `zee land` — that is the only order that works');
ok(/NOT an approval/.test(clearance), 'it is explicit that clearance is not approval — a human still decides');
const clearedB = await one(`SELECT * FROM land_request WHERE id=$1`, [rowB.id]);
ok(clearedB.status === 'holding' && !!clearedB.cleared_at, 'bravo\'s row carries the clearance receipt');
ok(!clearedB.decided_at && !clearedB.decided_by, 'and STILL no decider — being called is not being decided');
ok(/runway clear/.test(String(clearedB.note || '')) && /nudged/.test(String(clearedB.note || '')),
   `the receipt says why and that the zee was told: "${String(clearedB.note || '').slice(0, 70)}…"`);
ok((await holdingQueue(project.id, 'refs/heads/main')).length === 0, 'the pattern is empty — nothing is stuck in it');
ok((await tendOpen(bravo.id)) === false, 'no tend: the zee itself was reached');
const stB2 = await selfStatus(bravo);
ok(stB2.landing?.cleared === true && /zee sync/.test(stB2.landing?.note || ''),
   '`zee status` shows bravo cleared, with the go-around instruction');

// bravo now does what it was told: sync (its worktree catches up) and land → ONE fresh card.
const landB3 = await selfLand(bravo);
ok(landB3.status === 'held', `bravo's fresh push is HELD for a human (${landB3.status}) — the runway was free`);
ok((await listLandRequests(project.id, { open: true })).length === 1, 'and there is exactly one card again');

// ── 7. REJECTED frees the runway too ──────────────────────────────────────────
console.log('\n── the occupant is REJECTED → the next holder is cleared ──');
commit(wtA, 'alpha.txt', 'alpha 2\n', 'A2 (alpha again)');
const landA2 = await selfLand(alpha);
ok(landA2.status === 'holding', `alpha now holds behind bravo's card (${landA2.status})`);
resetLog();
const bravoCard = (await listLandRequests(project.id, { open: true }))[0];
const alphaHold = await lastHolding(alpha.id);
await decideLandRequest(bravoCard.id, 'rejected', 'human@test');
ok(await awaitCleared(alphaHold.id), 'the rejection cleared alpha out of the pattern');
const log2 = await awaitResume(/runway is CLEAR/);
ok(log2.includes(SID_A) && /runway is CLEAR/.test(log2), 'a rejection clears the next holder — alpha was resumed');
ok((await runwayOccupant(project.id, 'refs/heads/main')) === null, 'and the runway is genuinely free (no occupant)');
ok((await holdingQueue(project.id, 'refs/heads/main')).length === 0, 'the queue emptied with nothing stuck');

// ── 8. WITHDRAWN frees it as well — and a holder may leave the pattern ────────
console.log('\n── withdrawal: the occupant leaves, and so may a holder ──');
const landA3 = await selfLand(alpha);                       // alpha takes the free runway
ok(landA3.status === 'held', `alpha takes the runway (${landA3.status})`);
commit(wtB, 'bravo.txt', 'bravo 3\n', 'B3');
const landB4 = await selfLand(bravo);
ok(landB4.status === 'holding', 'bravo holds behind it');
// a HOLDER can un-ask its own place in line
const wHold = await selfWithdrawLand(bravo, { reason: 'not ready after all' });
ok(wHold.ok && wHold.withdrawn.length === 1, `bravo withdrew its holding request (${wHold.withdrawn.length})`);
ok((await holdingQueue(project.id, 'refs/heads/main')).length === 0, 'and left the pattern');
ok((await one(`SELECT status, withdrawn_by FROM land_request WHERE id=$1`, [wHold.withdrawn[0].id])).status === 'withdrawn',
   'the row is withdrawn — the zee un-asked it, nobody decided anything');
// now bravo holds again, and the OCCUPANT withdraws
const landB5 = await selfLand(bravo);
ok(landB5.status === 'holding', 'bravo holds again');
resetLog();
const bravoHold = await lastHolding(bravo.id);
const wOcc = await selfWithdrawLand(alpha, { reason: 'found a bug' });
ok(wOcc.ok, 'alpha withdraws the landing that was on the runway');
ok(await awaitCleared(bravoHold.id), 'and that freed the runway for the holder');
const log3 = await awaitResume(/runway is CLEAR/);
ok(log3.includes(SID_B) && /runway is CLEAR/.test(log3), 'and the withdrawal cleared bravo — a withdrawn card frees the runway');

// ── 9. STALE frees it — the case the whole protocol exists to make rare ───────
console.log('\n── the occupant goes STALE → the runway still frees ──');
const landB6 = await selfLand(bravo);                        // bravo takes the runway
ok(landB6.status === 'held', `bravo is on the runway (${landB6.status})`);
commit(wtA, 'alpha.txt', 'alpha 4\n', 'A4');
const landA4 = await selfLand(alpha);
ok(landA4.status === 'holding', 'alpha holds behind it');
// somebody lands on main by hand: bravo's held sha can never fast-forward now.
// (reset --hard first: every landing so far moved main with `git update-ref`, which deliberately
// touches no working tree — so this repo's checkout is still sitting on the base commit.)
git(src, ['reset', '--hard', 'main']);
commit(src, 'hand.txt', 'landed by hand\n', 'H (a human landed by hand)');
resetLog();
const swept = await sweepStalePending();
ok(swept.stale >= 1, `the held card is swept stale (${swept.stale})`);
const log4 = await awaitResume(/went STALE/);
ok(/went STALE/.test(log4) && log4.includes(SID_B), 'bravo (the occupant) is told its landing went stale');
// TWO nudges come out of this one step — the stale notice to the occupant and the clearance to the
// holder behind it — so this waits for the SECOND on its own terms. (The ad-hoc polling loop that
// used to sit here was compensating for exactly that, in one place, silently.)
const log4b = await awaitResume(/runway is CLEAR/);
ok(/runway is CLEAR/.test(log4b) && log4b.includes(SID_A),
   'and alpha, the holder, is cleared onto the free runway in the same breath');

// ── 10. NOBODY HOME: the head holder cannot be reached → tend + next in line ──
console.log('\n── a holder with no live cxell → a tend, and the NEXT one is cleared ──');
// three xells: one on the runway, then a DEAD holder, then a live one behind it.
const wtC = join(tmp, 'wt-c');
git(src, ['worktree', 'add', '-q', '-b', 'spinoff/charlie', wtC, git(src, ['rev-parse', 'main'])]);
git(wtC, ['config', 'user.email', 'z@z']); git(wtC, ['config', 'user.name', 'z']);
const charlie = await mkXell('queue-charlie', 'spinoff/charlie', wtC);   // NO zee row → nothing to nudge
commit(wtC, 'charlie.txt', 'charlie\n', 'C1');
// clear the decks: whatever is open on the ref goes away first
for (const r of await listLandRequests(project.id, { open: true })) {
  await q(`UPDATE land_request SET status='withdrawn', withdrawn_at=now(), withdrawn_by='test' WHERE id=$1`, [r.id]);
}
commit(wtA, 'alpha.txt', 'alpha 5\n', 'A5');
const occA = await selfLand(alpha);
if (occA.status !== 'held') console.log('   DEBUG', JSON.stringify(occA).slice(0, 900));
ok(occA.status === 'held', `alpha holds the runway again (${occA.status})`);
const holdC = await selfLand(charlie);
ok(holdC.status === 'holding' && holdC.position === 1, `charlie (no cxell) is #${holdC.position} in the pattern`);
commit(wtB, 'bravo.txt', 'bravo 5\n', 'B5');
const holdB = await selfLand(bravo);
ok(holdB.status === 'holding' && holdB.position === 2, `bravo is #${holdB.position}, behind it`);
resetLog();
const alphaCard = (await listLandRequests(project.id, { open: true }))[0];
const bravoQueued = await lastHolding(bravo.id);
await decideLandRequest(alphaCard.id, 'approved', 'human@test');
ok(await awaitCleared(bravoQueued.id),
   'the unreachable holder was passed over and BRAVO was cleared — one dead zee cannot hold the runway shut');
const log5 = await awaitResume(/runway is CLEAR/);
ok(log5.includes(SID_B) && /runway is CLEAR/.test(log5),
   'the unreachable holder did not block the runway — the NEXT in line was cleared');
let tendedC = false;
for (let i = 0; i < 30 && !tendedC; i++) { await sleep(120); tendedC = await tendOpen(charlie.id); }
ok(tendedC === true, 'and a TEND was raised on the xell nobody could reach — it is not left silent');
const rowC = await one(`SELECT * FROM land_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [charlie.id]);
ok(!!rowC.cleared_at && /could NOT be nudged/.test(String(rowC.note || '')),
   'its receipt says the zee was NOT reached, rather than claiming it was');

// ── 11. a REAPED xell must not hold a place forever ───────────────────────────
console.log('\n── a retired xell is swept out of the pattern ──');
const occ2 = await selfLand(bravo);                     // bravo takes the free runway
ok(occ2.status === 'held', `bravo on the runway (${occ2.status})`);
commit(wtC, 'charlie.txt', 'charlie 2\n', 'C2');
await selfLand(charlie);
await q(`UPDATE xell SET status='retired' WHERE id=$1`, [charlie.id]);
const sweptHold = await sweepHoldingPattern();
ok(sweptHold.swept >= 1, `the retired xell's holding row was swept (${sweptHold.swept})`);
const rowC2 = await one(`SELECT * FROM land_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [charlie.id]);
ok(!!rowC2.cleared_at && /retired/.test(String(rowC2.clear_reason || '')),
   'with an honest reason on the row, and out of the queue');
ok((await holdingQueue(project.id, 'refs/heads/main')).length === 0, 'the pattern is empty again — nothing blocks the runway');
// and the tick drives all of it without any transition calling it
const ticked = await tick();
ok(typeof ticked.runways === 'number' && typeof ticked.holding_swept === 'number',
   'the land reaper tick sweeps and drives the runways too (the backstop for a missed clearance)');

// ── 12. AUTO-APPROVE: the queue must be a no-op, not a new hold ───────────────
console.log('\n── with auto_approve_land ON, nothing ever holds ──');
await q(`UPDATE project SET auto_approve_land=true WHERE id=$1`, [project.id]);
// clear the runway of the pending card first, then have both xells push
for (const r of await listLandRequests(project.id, { open: true })) {
  await q(`UPDATE land_request SET status='withdrawn', withdrawn_at=now(), withdrawn_by='test' WHERE id=$1`, [r.id]);
}
commit(wtA, 'alpha.txt', 'alpha auto\n', 'A-auto');
const autoA = await selfLand(alpha);
ok(autoA.status === 'landed', `alpha lands immediately under the policy (${autoA.status})`);
commit(wtB, 'bravo.txt', 'bravo auto\n', 'B-auto');
const autoB = await selfLand(bravo);
ok(autoB.status === 'landed', `and so does bravo — no holding pattern in auto mode (${autoB.status})`);
ok((await holdingQueue(project.id, 'refs/heads/main')).length === 0, 'nothing entered the queue');
await q(`UPDATE project SET auto_approve_land=false WHERE id=$1`, [project.id]);

// ── 13. a PR is NOT in the runway queue ───────────────────────────────────────
console.log('\n── kind=pull is a different ask ──');
const pr = await one(
  `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, kind)
     VALUES ($1,$2,'refs/heads/spinoff/other',$3,$4,'pull') RETURNING *`,
  [project.id, alpha.id, shaA, git(wtA, ['rev-parse', 'HEAD'])]);
ok((await runwayOccupant(project.id, 'refs/heads/spinoff/other')) === null,
   'an open PR does not occupy a landing runway');
let prHold = null;
await q(`UPDATE land_request SET status='holding', holding_since=now() WHERE id=$1`, [pr.id])
  .catch((e) => { prHold = e.message; });
ok(/land_holding_is_push/.test(prHold || ''), 'and the DB refuses to put a PR into the pattern at all');
await q(`DELETE FROM land_request WHERE id=$1`, [pr.id]);

// ── 14. the STATIC half: does the state reach a zee at all? ───────────────────
console.log('\n── both waiters understand `holding` (they must never burn the timeout) ──');
const cli = read('scripts/zee');
ok(/printHolding/.test(cli) && /status === 'holding'/.test(cli), 'scripts/zee has a holding branch');
ok(/HOLDING at position/.test(cli), 'and prints the POSITION, not just a state name');
ok(/process\.exit\(land\.cleared \? 1 : 0\)/.test(cli), 'it exits cleanly instead of polling on');
const waiter = read('scripts/xell-land.mjs');
ok(/'holding'/.test(waiter) && /HOLDING at position/.test(waiter), 'xell-land.mjs understands holding too');
ok(waiter.indexOf("s.status === 'holding'") < waiter.indexOf('TIMEOUT after'),
   'and it answers BEFORE the timeout branch — the way it used to fail on stale');
ok(/zee sync/.test(cli.slice(cli.indexOf('function printHolding'), cli.indexOf('async function pollLanding'))),
   'the cleared message names the recovery (`zee sync`)');

// ── 15. THE MANUAL. A state a zee can land in must be a state it was TOLD about ────────────────
// House rule: the manual, the briefing and the CLI move together. The manual zees actually read is
// the one in the meta DB (harness zee-base), edited by migration — so this asserts the DATABASE,
// not a file, and it passes only on a database the migrations have been applied to.
console.log('\n── the worker manual teaches the pattern ──');
const manual = read('db/migrations/069_manual_runway.sql');
ok(/HOLDING PATTERN/.test(manual) && /zee sync/.test(manual), '069 teaches the holding pattern and the go-around');
ok(/IF txt IS NULL OR txt LIKE '%HOLDING PATTERN%' THEN RETURN/.test(manual),
   'guarded on text it writes itself, so a re-run is a no-op rather than a second copy');
ok(/a\.e->>'path' = 'cxell-zee-manual\.md'/.test(manual), 'and it finds the manual BY PATH, never by index');
const stored = await one(
  `SELECT a.e->>'text' AS t FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') AS a(e)
     WHERE h.key='zee-base' AND a.e->>'path'='cxell-zee-manual.md'`);
const m = String(stored?.t || '');
ok(/HOLDING PATTERN, nothing is wrong/.test(m), 'the stored manual really carries it after migrating');
ok(/no human has been asked anything yet/.test(m), 'it says plainly that nothing is in front of a human');
ok(/nothing was rejected, nothing was dropped/.test(m), 'and that nothing was rejected or dropped');
ok(m.indexOf('`zee sync`', m.indexOf('CLEARANCE')) < m.indexOf('`zee land`', m.indexOf('CLEARANCE')),
   'the clearance recovery names sync BEFORE land — the only order that works');
ok(/do NOT raise a `tend` \(nobody is blocked/.test(m),
   'and it heads off the wrong reactions: no tend, no re-push, no queue-jumping');
ok(/or QUEUE behind/.test(m), 'the verb list at the top says `zee land` can queue, so a skimmer sees it too');

// TICKET #3, folded in: the hygiene note is SEEDED now, not hand-typed. Every cxell database is
// fresh and migration-only, so a note that lives in one hand-edited database is a note no cxell zee
// has — and three assertions in land-withdraw could not pass on any of them.
const seeded = await one(
  `SELECT a.e->>'text' AS t FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') AS a(e)
     WHERE h.key='zee-base' AND a.e->>'path'='tend-or-land.md'`);
ok(!!seeded?.t, 'the tend-or-land hygiene note exists on a migrated database (071 seeds it)');
ok(/revoke your tend request/.test(String(seeded?.t || '')),
   'with the human\'s original words kept verbatim — it is their note');
ok(/zee land --withdraw/.test(String(seeded?.t || '')), 'plus the landing half 064 appends');
ok(/HOLDING/.test(String(seeded?.t || '')) && /nobody is blocked/.test(String(seeded?.t || '')),
   'and the holding half: a queued push is not an ask, so there is nothing to keep true');
ok(/IF has_note THEN RETURN/.test(read('db/migrations/071_seed_tend_or_land_note.sql')),
   'and the seed never overwrites a note somebody has already edited');

server.close();
await pool.end().catch(() => {});
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
