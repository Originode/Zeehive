// THE RUNWAY'S TWO ACCEPTED RACES — ticket #11's code half. Both were named by the runway's own
// author and left, and both are silent in exactly the way the runway exists to prevent.
//
// GAP 1 — A CLEARANCE THAT WAS DELIVERED AND THEN DIED. clearHolder's resume is fire-and-forget:
// `nudged: true` means the exec STARTED. Undeliverable was handled from the start (a tend is raised and
// the tower calls the next holder), but delivered-then-died was not — the receipt truthfully says the
// zee was told, the row leaves the pattern (every queue read filters `cleared_at IS NULL`), and NOTHING
// ever returns to it. The zee waits forever for a clearance it already received and lost. Confirmed by
// investigation in #19, not by inspection: there the nudge was proved slow rather than dead, and the
// report said plainly that the dead case remained unmitigated.
//   THE RULING IMPLEMENTED HERE: re-clear ONCE, then tend. Once because the cheap failure is a lost
//   nudge; a tend rather than a loop because a zee that ignores two clearances is a human's problem.
//   The period is the landing pad's RECEIPT_MIN (5 minutes — the only minute-scale settle window the
//   runway machinery already keeps), overridable with LAND_CLEARANCE_GRACE_MIN, which is what lets this
//   test drive both stages in seconds instead of sleeping through ten minutes.
//
// GAP 2 — A DISMISSED APPROVAL HOLDING THE RUNWAY INVISIBLY. runwayOccupant() ignores `dismissed_at` on
// purpose: dismissing hides a receipt, it does not free a runway. The consequence was an approved
// landing that never lands, hidden, occupying the ref with zees queued behind it and nothing on any
// screen — and the stale sweep cannot rescue it (it only closes PROVEN non-fast-forwards).
//   THE RULING: do NOT let dismissal free the runway — that would let a human hide a landing and
//   silently pass the next one through. Make the occupancy VISIBLE instead.
//
// Everything below runs the REAL code against a throwaway postgres and REAL git repos, with the same
// two seams land-queue.test.mjs uses: the fake `docker` in test/_bin (whose argv+stdin we assert on, so
// "the zee was re-called" is proved by the resume it actually spawned) and no HTTP at all — pushes go
// through checkPush directly, since what is under test is the tower, not the hook.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real mode: this is the live half of the nested-queenzee guard, and the tower only resumes cages when
// it is allowed to touch machines. Set before any import — the modules read it once at load.
process.env.PROVISION_MODE = 'real';
// Both stages of the silence sweep, without waiting for them: 0 minutes means "as soon as the tick sees
// it". The DEFAULT is asserted separately below, because a test that only ever ran at 0 could not tell
// whether the production window was five minutes or none.
process.env.LAND_CLEARANCE_GRACE_MIN = '0';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the fake docker records every resume (argv + the prompt it was fed) — same seam as land-queue
const DOCKER_LOG = join(mkdtempSync(join(tmpdir(), 'silence-log-')), 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;
process.env.PATH = `${join(ROOT, 'test', '_bin')}:${process.env.PATH}`;
const readLog = () => (existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : '');
const resetLog = () => { try { rmSync(DOCKER_LOG); } catch { /* first run */ } };
const invocations = (log) => log.split(/^=== docker /m).slice(1).map((r) => `=== docker ${r}`);
// #19's lesson, applied: wait for the WHOLE invocation (a closed stdin block), not for the argv line.
// The argv is on disk the instant docker starts and the PROMPT only after it has drained stdin, so a
// wait that returns on `--resume` asserts against a half-written log — green on a quiet box, red about
// once in thirty on a loaded one, and reading as a broken protocol rather than a slow spawn.
async function awaitResume(want) {
  const done = () => invocations(readLog()).some((rec) => want.test(rec) && /STDIN<<[\s\S]*>>STDIN/.test(rec));
  for (let i = 0; i < 160 && !done(); i++) await sleep(150);
  return readLog();
}

const { q, one, pool } = await import('../server/src/db/pool.js');
const { checkPush, decideLandRequest, runwayOccupant, holdingQueue, clearRunway, dismissLandRequest,
        sweepSilentClearances, tick } = await import('../server/src/queenzee/landgate.js');
const { buildLandingPad } = await import('../server/src/queenzee/landingpad.js');
const { getFleet } = await import('../server/src/lib/fleet.js');
const { tendState } = await import('../server/src/lib/status.js');

// ── one xource, three xells that all work on it ──────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'land-silence-'));
const src = join(tmp, 'src');
git(tmp, ['init', '-q', '-b', 'main', 'src']);
const cfg = (k, v) => git(src, ['config', k, v]);
cfg('user.email', 'test@zeehive.local'); cfg('user.name', 'test');
cfg('receive.denyCurrentBranch', 'ignore');
writeFileSync(join(src, 'base.txt'), 'base\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'base']);
const base = git(src, ['rev-parse', 'HEAD']);
const wt = {};
for (const name of ['alpha', 'bravo', 'chuck']) {
  wt[name] = join(tmp, `wt-${name}`);
  git(src, ['worktree', 'add', '-q', '-b', `spinoff/${name}`, wt[name], base]);
  git(wt[name], ['config', 'user.email', 'zee@zeehive.local']);
  git(wt[name], ['config', 'user.name', 'zee']);
  writeFileSync(join(wt[name], `${name}.txt`), `${name}\n`);
  git(wt[name], ['add', '.']); git(wt[name], ['commit', '-qm', `${name} work`]);
}
const shaOf = (name) => git(wt[name], ['rev-parse', 'HEAD']);

await q(`DELETE FROM project WHERE name='landsilencetest'`);
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch, auto_approve_land)
   VALUES ('landsilencetest', $1, 'main', false) RETURNING *`, [src]);
const xource = await one(
  `INSERT INTO xource (project_id, ref, xell_id) VALUES ($1,'main',NULL) RETURNING *`, [project.id]);
const mkXell = (slug, branch, path) => one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, self_token_hash)
   VALUES ($1,$2,$3,$4,$5,$6,'working',$7) RETURNING *`,
  [project.id, xource.id, slug, branch, path, base, `hash-${slug}`]);
const mkZee = (xellId, sid, port) => one(
  `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, viewer_kind, viewer_url,
                    claude_session_id, model, status)
   VALUES ($1,'headless-spawn','cxell-cli','headless','ssh-terminal',$3,$2,'opus','idle') RETURNING id`,
  [xellId, sid, `ssh://zee@127.0.0.1:${port}`]);
const SID = { alpha: 'aaaa1111-2222-3333-4444-555555555555',
              bravo: 'bbbb1111-2222-3333-4444-555555555555',
              chuck: 'cccc1111-2222-3333-4444-555555555555' };
const xell = {};
let port = 22201;
for (const name of ['alpha', 'bravo', 'chuck']) {
  xell[name] = await mkXell(`sil-${name}`, `spinoff/${name}`, wt[name]);
  await mkZee(xell[name].id, SID[name], port++);
}
const push = (name) => checkPush({ projectId: project.id, ref: 'refs/heads/main',
  oldSha: base, newSha: shaOf(name) });
const rowOf = (id) => one(`SELECT * FROM land_request WHERE id=$1`, [id]);

try {
  // ── GAP 1 ───────────────────────────────────────────────────────────────────
  // alpha takes the runway, bravo holds behind it, alpha's landing is withdrawn → bravo is CLEARED.
  // Then bravo simply never comes back: the exact state a lost resume leaves behind.
  console.log('\n── a holder is cleared, and its zee never comes back ──');
  const a1 = await push('alpha');
  ok(a1.reason === 'pending', `alpha is on the runway (${a1.reason})`);
  const b1 = await push('bravo');
  ok(b1.reason === 'holding' && b1.position === 1, `bravo holds at #${b1.position}`);

  resetLog();
  await one(`UPDATE land_request SET status='withdrawn', withdrawn_at=now(), withdrawn_by='test'
               WHERE id=$1 RETURNING id`, [a1.request.id]);
  const freed = await clearRunway(project.id, 'refs/heads/main', { reason: 'the test freed it' });
  ok(freed.cleared?.[0]?.cleared === true, 'the tower cleared bravo out of the pattern');
  const clearedB = await rowOf(b1.request.id);
  ok(!!clearedB.cleared_at && clearedB.status === 'holding' && !clearedB.decided_at,
     'its row carries a clearance receipt and still no decider — being called is not being decided');
  ok(!clearedB.recleared_at && !clearedB.silence_tended_at,
     'and nothing has been re-called or tended yet');
  const firstLog = await awaitResume(/--resume/);
  ok(/runway is CLEAR/.test(firstLog), 'the zee got the go-around (this is the nudge that gets lost)');

  console.log('\n── the tick RE-CALLS it, exactly once ──');
  resetLog();
  const sweep1 = await sweepSilentClearances();
  ok(sweep1.recalled === 1 && sweep1.tended === 0,
     `the first sweep re-calls and does not tend (${JSON.stringify(sweep1)})`);
  const recalled = await rowOf(b1.request.id);
  ok(!!recalled.recleared_at, 'the row records the ONE re-clearance as a fact, not in memory');
  ok(!recalled.silence_tended_at, 'no human has been raised yet — the cheap failure is a lost nudge');
  ok(recalled.status === 'holding' && !recalled.decided_at && !recalled.decided_by,
     'and a re-call decides nothing: still holding, still no decider');
  ok(/re-called ONCE/.test(String(recalled.note || '')),
     `the receipt stops claiming it was merely nudged: "${String(recalled.note || '').slice(0, 80)}…"`);
  const recallLog = await awaitResume(/--resume/);
  ok(/RE-CALL/.test(recallLog) || /never came back/.test(recallLog),
     'the zee was resumed AGAIN, and the prompt says it is a re-call');
  ok(/zee sync/.test(recallLog) && recallLog.indexOf('zee sync') < recallLog.lastIndexOf('zee land'),
     'with the same go-around, in order: sync, then land');
  ok(!/runway is CLEAR — you are next/.test(recallLog),
     'and it does NOT claim the runway is free — by now the next holder has probably taken it');
  ok(/HOLDING PATTERN/.test(recallLog),
     'it says a fresh push may hold again, which is the honest outcome after a delay');
  ok(/LAST automatic call/.test(recallLog), 'and that this is the last automatic call');

  console.log('\n── still silent → a HUMAN, and never a third call ──');
  resetLog();
  const sweep2 = await sweepSilentClearances();
  ok(sweep2.tended === 1 && sweep2.recalled === 0,
     `the second sweep tends and does NOT re-call again (${JSON.stringify(sweep2)})`);
  const tended = await rowOf(b1.request.id);
  ok(!!tended.silence_tended_at, 'the row records that a human was raised');
  const tend = await tendState(xell.bravo.id);
  ok(tend?.open === true, 'and the xell really carries an open tend');
  ok(/cleared to land/i.test(tend?.reason || '') && /re-called once/i.test(tend?.reason || ''),
     `the tend says what happened, in one line: "${String(tend?.reason || '').slice(0, 90)}…"`);
  ok(/unlanded/.test(tend?.reason || ''), 'and why it matters — there are commits nobody can land');
  ok(readLog() === '' || !/--resume/.test(readLog()), 'no third resume was spawned');
  const sweep3 = await sweepSilentClearances();
  ok(sweep3.recalled === 0 && sweep3.tended === 0 && sweep3.checked === 0,
     'and the row is out of the sweep for good — a tend is not repeated every 10 seconds');

  console.log('\n── a holder that DID come back is never touched ──');
  const c1 = await push('chuck');
  ok(c1.reason === 'pending', 'chuck takes the free runway with a fresh request');
  const chuckRow = await one(
    `SELECT * FROM land_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xell.chuck.id]);
  // give chuck a cleared holding row that PRE-DATES its fresh push: it was called, and it answered
  const answered = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, status,
        holding_since, cleared_at, cleared_by, clear_reason, requested_at)
       VALUES ($1,$2,'refs/heads/main',$3,$4,'[]'::jsonb,'holding',
               now() - interval '20 minutes', now() - interval '19 minutes', 'queenzee@runway',
               'the runway is clear', now() - interval '20 minutes') RETURNING *`,
    [project.id, xell.chuck.id, base, `${'c'.repeat(39)}1`]);
  const sweep4 = await sweepSilentClearances();
  const answeredAfter = await rowOf(answered.id);
  ok(!answeredAfter.recleared_at && !answeredAfter.silence_tended_at,
     'a cleared holder that pushed again afterwards is left alone — it answered the call');
  ok(sweep4.recalled === 0, `so the sweep finds nothing to do (${JSON.stringify(sweep4)})`);
  ok(new Date(chuckRow.requested_at) > new Date(answered.cleared_at),
     '(the new request really is younger than the clearance — that is what "came back" means)');

  console.log('\n── a RETIRED xell is not re-called and not tended ──');
  const deadHold = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, status,
        holding_since, cleared_at, cleared_by, clear_reason)
       VALUES ($1,$2,'refs/heads/main',$3,$4,'[]'::jsonb,'holding',
               now() - interval '30 minutes', now() - interval '29 minutes', 'queenzee@runway',
               'the runway is clear') RETURNING *`,
    [project.id, xell.alpha.id, base, `${'d'.repeat(39)}2`]);
  await q(`UPDATE xell SET status='retired' WHERE id=$1`, [xell.alpha.id]);
  const sweep5 = await sweepSilentClearances();
  const deadAfter = await rowOf(deadHold.id);
  ok(!deadAfter.recleared_at && !deadAfter.silence_tended_at && sweep5.checked === 0,
     'a reaped zee is neither called nor made a human\'s problem — there is nobody to come back');
  await q(`UPDATE xell SET status='working' WHERE id=$1`, [xell.alpha.id]);

  console.log('\n── the DEFAULT window is the landing pad\'s, not zero ──');
  const { RECEIPT_MIN } = await import('../server/src/queenzee/landingpad.js');
  ok(RECEIPT_MIN === 5, `RECEIPT_MIN is the pad's settle window (${RECEIPT_MIN} minutes)`);
  const src2 = readFileSync(join(ROOT, 'server/src/queenzee/landgate.js'), 'utf8');
  ok(/LAND_CLEARANCE_GRACE_MIN[\s\S]{0,120}RECEIPT_MIN/.test(src2),
     'and the grace period defaults to it rather than to a new constant nobody can find');
  // with the real window, a clearance seconds old is NOT silent — this is the guard against a sweep
  // that re-calls a zee which is simply still syncing
  const fresh = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, status,
        holding_since, cleared_at, cleared_by, clear_reason)
       VALUES ($1,$2,'refs/heads/main',$3,$4,'[]'::jsonb,'holding',now(),now(),'queenzee@runway','clear')
       RETURNING *`, [project.id, xell.bravo.id, base, `${'e'.repeat(39)}3`]);
  const sweep6 = await sweepSilentClearances({ graceMin: RECEIPT_MIN });
  const freshAfter = await rowOf(fresh.id);
  ok(!freshAfter.recleared_at && sweep6.checked === 0,
     'a zee cleared one second ago is still syncing, not silent — the window protects it');

  console.log('\n── the tick runs it (the sweep is not orphaned code) ──');
  const ticked = await tick();
  ok('recalled' in ticked && 'silence_tended' in ticked,
     `tick() reports the silence sweep (${JSON.stringify(ticked).slice(0, 120)}…)`);

  // ── GAP 2 ───────────────────────────────────────────────────────────────────
  console.log('\n── a DISMISSED approval still holds the runway (and dismissal must not free it) ──');
  // THE WEDGE, built as the row it really is: a landing a human APPROVED that has not landed. That state
  // is not exotic — landApproved leaves a row approved whenever the pad has it queued behind a ship
  // that is building, whenever update-ref keeps failing, and (always) in a nested queenzee that is only
  // modelling the fleet. It is inserted directly rather than driven through decideLandRequest because in
  // a REAL-mode queenzee an approval on a fast-forwardable sha lands within the same breath (its own
  // setImmediate continuation), and racing that would test the landing path, not this gap. Nothing
  // below calls tick() again: the tick would eventually close a row like this as stale, which is the
  // ticket's own point — the wedge lasts exactly as long as the row stays landable, and what was broken
  // in the meantime was that nobody could SEE it.
  // chuck's real pending request, approved by hand: the same row a human would have clicked, moved into
  // the state the click leaves behind when the landing does not immediately spend itself.
  const wedge = await one(
    `UPDATE land_request SET status='approved', decided_at=now() - interval '40 minutes',
        decided_by='human@test' WHERE id=$1 RETURNING *`, [chuckRow.id]);
  const heldBehind = await one(
    `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, commits, status, holding_since,
        behind_request_id)
       VALUES ($1,$2,'refs/heads/main',$3,$4,'[]'::jsonb,'holding',now(),$5) RETURNING *`,
    [project.id, xell.bravo.id, base, `${'f'.repeat(39)}4`, wedge.id]);
  ok((await runwayOccupant(project.id, 'refs/heads/main'))?.id === wedge.id,
     'the approved landing owns the runway (oldest open landing on the ref)');
  ok((await holdingQueue(project.id, 'refs/heads/main')).some((h) => h.id === heldBehind.id),
     'and a zee is queued behind it');

  await dismissLandRequest(wedge.id, 'human@test');
  const dismissed = await rowOf(wedge.id);
  ok(!!dismissed.dismissed_at && dismissed.status === 'approved',
     'dismissing it hides a RECEIPT — the status is untouched, so the queenzee still owes it a landing');
  const occ = await runwayOccupant(project.id, 'refs/heads/main');
  ok(occ?.id === wedge.id,
     'and it STILL occupies the runway: hiding a landing must never silently pass the next one through');
  ok((await holdingQueue(project.id, 'refs/heads/main')).some((h) => h.id === heldBehind.id),
     'the holder is still holding — the queue did not quietly advance');

  console.log('\n── …and now it is VISIBLE, on the panel that shows the runway ──');
  const pad = await buildLandingPad(project.id);
  const padRow = pad.items.find((it) => it.id === wedge.id);
  ok(!!padRow, 'the landing pad lists the dismissed-but-open landing (it used to filter it out entirely)');
  ok(padRow.dismissed_at && padRow.dismissed_by === 'human@test',
     'with who hid it, so the row can explain why it is still on screen');
  ok(padRow.holders === 1, `and how many zees are queued behind it (${padRow.holders})`);
  ok(padRow.phase === 'queued' || padRow.phase === 'processing',
     `still shown as runway work, not as a receipt (${padRow.phase})`);

  const fleet = await getFleet(project.id);
  const landingRow = (fleet.landing || []).find((r) => r.id === wedge.id);
  ok(!!landingRow, 'the fleet payload still carries it (the console reads occupancy from here)');
  ok(landingRow.runway_occupant === true && landingRow.holders === 1,
     'flagged as the runway OCCUPANT with its holder count — what un-hides the card in the console');
  const behindRow = (fleet.landing || []).find((r) => r.id === heldBehind.id);
  ok(!behindRow, 'a holding row is still not a card (the queue is information, not a decision)');

  console.log('\n── a receipt with nobody behind it stays hidden — dismissal still works ──');
  await q(`UPDATE land_request SET status='withdrawn', withdrawn_at=now(), withdrawn_by='test'
             WHERE id=$1`, [heldBehind.id]);
  const fleet2 = await getFleet(project.id);
  const lonely = (fleet2.landing || []).find((r) => r.id === wedge.id);
  ok(lonely && lonely.holders === 0 && lonely.runway_occupant === true,
     'with the queue gone the same landing reports 0 holders — so the console hides it again');
  // the console's rule, asserted where it lives
  const landingSrc = readFileSync(join(ROOT, 'web/src/Landing.jsx'), 'utf8');
  ok(/export const holdsRunway = \(r\) => !!r\?\.runway_occupant && \(r\?\.holders \|\| 0\) > 0;/.test(landingSrc),
     'holdsRunway is the one rule: occupant AND somebody waiting');
  const appSrc = readFileSync(join(ROOT, 'web/src/App.jsx'), 'utf8');
  ok(/const visible = \(rs\) => \(rs \|\| \[\]\)\.filter\(\(r\) => holdsRunway\(r\) \|\| \(!dismissed\[r\.id\] && !r\.dismissed_at\)\)/.test(appSrc),
     'and dismissal cannot hide a card that holds the runway with zees behind it');
  ok(/w\.blocked > 0 && `⛔ holds the runway/.test(appSrc),
     'the "waiting on you" bar names it, because it IS waiting on a human');
  ok(/data-testid="land-blocker"/.test(landingSrc) && /HOLDS the runway/.test(landingSrc),
     'and the card says why it came back after being dismissed');

  console.log('\n── nothing here moved the gate ──');
  const gate = readFileSync(join(ROOT, 'server/src/queenzee/landgate.js'), 'utf8');
  ok(!/UPDATE land_request SET status='approved'/.test(gate.split('sweepSilentClearances')[1] || ''),
     'the silence sweep never approves anything');
  const swept = await rowOf(b1.request.id);
  ok(swept.status === 'holding' && !swept.decided_by && !swept.landed_at,
     'the re-called row is still an ask nobody decided — no decider, no landing');
  ok(git(src, ['rev-parse', 'main']) === base,
     'and main never moved: every push in this test is still waiting on a human');
} catch (e) {
  console.error('\n✗ threw:', e?.stack || e?.message || e);
  fail++;
} finally {
  await q(`DELETE FROM project WHERE name='landsilencetest'`).catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} FAILED` : '\n✓ a lost clearance is re-called once then tended, and a hidden blocker is visible');
process.exit(fail ? 1 : 0);
