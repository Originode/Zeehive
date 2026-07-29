// LAND-WITHDRAW integration test — a zee can UN-ASK a landing, and stacking requests is visible.
//
// The gap this covers: every other ask a zee raises can be lowered by the zee that raised it
// (`zee tend --clear`, `zee hint-land --clear`, `zee done --clear`) — a LAND REQUEST could not. A
// zee that asked to land and then thought better of it had exactly one move: push again, leaving a
// second card for the same job. Two held landings from one xell, one obsolete, and only the zee
// knowing which.
//
// Runs the REAL paths against a throwaway postgres + REAL git repos and the REAL land-gate `update`
// hook (the only seam is the tiny HTTP server the hook curls, which calls the same checkPush the
// route calls). No mocks of the logic under test:
//   • selfLand → held → a second selfLand REPORTS the older open request as superseded
//   • selfWithdrawLand → both rows 'withdrawn', out of every OPEN read model, main never moved
//   • withdrawing nothing, withdrawing somebody else's, and withdrawing an APPROVED decision
//   • withdraw → land again = exactly ONE open card
// Plus the static half: the verb reaches a zee (CLI, route, briefing, manual migration).
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_PORT = 47998;
const API = `http://127.0.0.1:${API_PORT}`;
process.env.ZEEHIVE_API = API;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { q, one, pool } = await import('../server/src/db/pool.js');
const { selfLand, selfWithdrawLand, selfStatus } = await import('../server/src/queenzee/self.js');
const { checkPush, withdrawLandRequest, listLandRequests, openLandRequests } =
  await import('../server/src/queenzee/landgate.js');
const { buildLandingPad } = await import('../server/src/queenzee/landingpad.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};

// ── 1. real git repos ─────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'land-withdraw-'));
const src = join(tmp, 'src');
const wt = join(tmp, 'wt');
git(tmp, ['init', '-q', '-b', 'main', 'src']);
const cfg = (k, v) => git(src, ['config', k, v]);
cfg('user.email', 'test@zeehive.local'); cfg('user.name', 'test');
cfg('receive.denyCurrentBranch', 'ignore');
writeFileSync(join(src, 'a.txt'), 'A\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'A (base)']);
const shaA = git(src, ['rev-parse', 'HEAD']);
git(src, ['worktree', 'add', '-q', '-b', 'spinoff/withdraw', wt, shaA]);
git(wt, ['config', 'user.email', 'zee@zeehive.local']); git(wt, ['config', 'user.name', 'zee']);
writeFileSync(join(wt, 'zee.txt'), 'first pass\n'); git(wt, ['add', '.']); git(wt, ['commit', '-qm', 'Z1 (first pass)']);

// ── 2. throwaway rows ─────────────────────────────────────────────────────────
await q(`DELETE FROM project WHERE name='landwithdrawtest'`);
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch, auto_approve_land)
   VALUES ('landwithdrawtest', $1, 'main', false) RETURNING *`, [src]);
const xource = await one(
  `INSERT INTO xource (project_id, ref, xell_id) VALUES ($1, 'main', NULL) RETURNING *`, [project.id]);
const xell = await one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, self_token_hash)
   VALUES ($1,$2,'withdraw-slug','spinoff/withdraw',$3,$4,'working','withdrawhash') RETURNING *`,
  [project.id, xource.id, wt, shaA]);

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

// ── 4. ask once → held ────────────────────────────────────────────────────────
console.log('\n── one landing, held at the gate ──');
const land1 = await selfLand(xell);
ok(land1.status === 'held', `first \`zee land\` is HELD (${land1.status})`);
ok((land1.superseded || []).length === 0, 'and it reports NO superseded requests — this is the only one');
const row1 = await one(`SELECT * FROM land_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xell.id]);
ok(row1?.status === 'pending', `the row is pending (${row1?.status})`);

// ── 5. THE SPAM: land again on a new sha without withdrawing ──────────────────
console.log('\n── a second push while the first is still held (the spam this verb exists for) ──');
writeFileSync(join(wt, 'zee.txt'), 'second pass\n'); git(wt, ['add', '.']); git(wt, ['commit', '-qm', 'Z2 (kept working)']);
const land2 = await selfLand(xell);
ok(land2.status === 'held', `the second \`zee land\` is also HELD (${land2.status})`);
ok((land2.superseded || []).length === 1,
   `and it NAMES the older open request instead of leaving it unmentioned (${(land2.superseded || []).length})`);
ok(land2.superseded?.[0]?.new_sha === row1.new_sha, 'the superseded one is exactly the first request');
ok(/withdraw/i.test(land2.message || ''), 'the message tells the zee to WITHDRAW rather than stack more');
ok((await openLandRequests(xell.id)).length === 2, 'two OPEN landings now sit in front of a human — the mess');
const st1 = await selfStatus(xell);
ok(st1.landing?.open === 2 && /OPEN land requests/.test(st1.landing?.note || ''),
   '`zee status` says so too (landing.open = 2 + a note), so the zee can see its own mess');

// ── 6. WITHDRAW — un-ask, and only that ───────────────────────────────────────
console.log('\n── zee land --withdraw ──');
const mainBefore = git(src, ['rev-parse', 'main']);
const headBefore = git(wt, ['rev-parse', 'HEAD']);
const w = await selfWithdrawLand(xell, { reason: 'found a bug; re-landing once it is fixed' });
ok(w.ok && w.status === 'withdrawn', `withdraw succeeded (${w.status})`);
ok(w.withdrawn.length === 2, `both open requests were lowered (${w.withdrawn.length})`);
const rows = await q(`SELECT * FROM land_request WHERE xell_id=$1`, [xell.id]);
ok(rows.every((r) => r.status === 'withdrawn'), 'both rows are status=withdrawn');
ok(rows.every((r) => r.withdrawn_at && /^zee@/.test(r.withdrawn_by || '')),
   'each carries WHO withdrew it and when (a zee, never a decider)');
ok(rows.every((r) => !r.decided_at && !r.decided_by),
   'and NOTHING was decided — a withdrawal is not an approval or a rejection');
ok(rows.every((r) => /found a bug/.test(r.withdraw_reason || '')), 'the zee\'s reason is kept on the row');
ok(git(src, ['rev-parse', 'main']) === mainBefore, 'main did NOT move');
ok(git(wt, ['rev-parse', 'HEAD']) === headBefore, 'and the branch is untouched — the commits are still there');
ok((await openLandRequests(xell.id)).length === 0, 'no open landings remain for this xell');
ok((await listLandRequests(project.id, { open: true })).length === 0,
   'the console\'s OPEN list is empty — the cards left the human\'s screen');
const pad = await buildLandingPad(project.id);
ok(pad.items.filter((i) => i.kind === 'landing').every((i) => i.phase === 'withdrawn'),
   'the landing pad keeps a brief RECEIPT rather than vanishing mid-read (phase=withdrawn)');
const st2 = await selfStatus(xell);
ok(st2.landing?.status === 'withdrawn' && st2.landing?.withdrawn === true && st2.landing?.pending === false,
   '`zee status` reports the landing as withdrawn (and not pending)');

// ── 7. withdrawing nothing, and withdrawing what is not yours ─────────────────
console.log('\n── the refusals ──');
const again = await selfWithdrawLand(xell, {});
ok(again.status === 'nothing-to-withdraw', `a second withdraw is a no-op, not an error (${again.status})`);
let threw = null;
await withdrawLandRequest(rows[0].id, 'zee@withdraw-slug').catch((e) => { threw = e.message; });
ok(/nothing open to withdraw|not pending/i.test(threw || ''), `an already-withdrawn row cannot be withdrawn again (${threw})`);
const foreign = await selfWithdrawLand(xell, { request: '00000000-0000-0000-0000-000000000000' });
ok(foreign.ok === false && foreign.status === 'not-found', 'a request that is not this xell\'s is refused');

// ── 8. an APPROVED landing is a DECISION — not the zee's to retract ───────────
const approved = await one(
  `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, status, decided_at, decided_by)
     VALUES ($1,$2,'refs/heads/main',$3,$4,'approved',now(),'human@test') RETURNING *`,
  [project.id, xell.id, shaA, git(wt, ['rev-parse', 'HEAD'])]);
let threw2 = null;
await withdrawLandRequest(approved.id, 'zee@withdraw-slug').catch((e) => { threw2 = e.message; });
ok(/already APPROVED/i.test(threw2 || ''), `withdrawing an approved landing is REFUSED (${threw2})`);
const wApproved = await selfWithdrawLand(xell, {});
ok(wApproved.status === 'nothing-to-withdraw' && /APPROVED/.test(wApproved.message),
   'and the zee is told why, and pointed at `zee tend` instead');
const stillApproved = await one(`SELECT status FROM land_request WHERE id=$1`, [approved.id]);
ok(stillApproved.status === 'approved', 'the approved row is untouched');
await q(`DELETE FROM land_request WHERE id=$1`, [approved.id]);

// ── 8b. a PR is a DIFFERENT ask — `zee land --withdraw` must not sweep it up ──
const pr = await one(
  `INSERT INTO land_request (project_id, xell_id, ref, old_sha, new_sha, kind)
     VALUES ($1,$2,'refs/heads/spinoff/other',$3,$4,'pull') RETURNING *`,
  [project.id, xell.id, shaA, git(wt, ['rev-parse', 'HEAD'])]);
const wPr = await selfWithdrawLand(xell, {});
ok(wPr.status === 'nothing-to-withdraw', 'an open PR is not counted as a landing to withdraw');
ok((await one(`SELECT status FROM land_request WHERE id=$1`, [pr.id])).status === 'pending',
   'and the PR row is left pending — a landing verb does not retract a pull request');
await q(`DELETE FROM land_request WHERE id=$1`, [pr.id]);

// ── 9. the DISCIPLINE: withdraw, then land again = ONE card ───────────────────
console.log('\n── withdraw-then-land leaves exactly one card ──');
writeFileSync(join(wt, 'zee.txt'), 'third pass (fixed)\n'); git(wt, ['add', '.']); git(wt, ['commit', '-qm', 'Z3 (fixed)']);
const land3 = await selfLand(xell);
ok(land3.status === 'held', `landing again after a withdraw is HELD as normal (${land3.status})`);
ok((land3.superseded || []).length === 0, 'and nothing is superseded — the old asks were withdrawn');
const open = await openLandRequests(xell.id);
ok(open.length === 1, `exactly ONE open landing is in front of a human (${open.length})`);
ok(open[0].new_sha === git(wt, ['rev-parse', 'HEAD']), 'and it is the sha the zee actually means');

// ── 10. the STATIC half: does the verb reach a zee at all? ────────────────────
console.log('\n── the verb reaches a zee (CLI · route · briefing · manual) ──');
const cli = read('scripts/zee');
ok(/--withdraw/.test(cli) && /\/api\/xell\/self\/land\/withdraw/.test(cli),
   'scripts/zee implements `zee land --withdraw` against the self route');
ok(/rest\.includes\('--clear'\)/.test(cli.slice(cli.indexOf("case 'land':"), cli.indexOf("case 'build':"))),
   'and accepts --clear as the same verb (symmetry with tend/hint/done)');
const usage = cli.slice(cli.indexOf('function usage()'), cli.indexOf('switch (cmd)'));
ok(/zee land --withdraw/.test(usage), 'it is advertised in `zee help`');
ok(/never stack land requests|withdraw the previous one/i.test(usage.toLowerCase()),
   'and the usage text carries the anti-spam rule, not just the flag');
const routes = read('server/src/api/routes.js');
ok(/'\/xell\/self\/land\/withdraw'/.test(routes), 'the zee route exists');
ok(/'\/land\/requests\/:id\/withdraw'/.test(routes), 'and an operator route for a card whose zee is gone');
ok(/zee land --withdraw/.test(read('server/src/queenzee/intake.js')),
   'the spawn briefing lists the verb (a zee reads that before anything else)');
const manual = read('db/migrations/062_manual_land_withdraw.sql');
ok(/zee land --withdraw/.test(manual) && /do NOT spam the gate/i.test(manual),
   'the manual migration teaches both the verb AND the one-open-landing discipline');
ok(/harness/.test(manual) && /zee-base/.test(manual), 'and it patches the DB-owned zee-base manual');
// the manual as it actually stands in THIS database (the migration ran here)
const stored = await one(
  `SELECT a.e->>'text' AS t FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') AS a(e)
     WHERE h.key='zee-base' AND a.e->>'path'='cxell-zee-manual.md'`);
ok(/zee land --withdraw/.test(stored?.t || ''), 'and the stored manual really carries it after migrating');
ok(/withdraw the open request first, then land again/i.test(stored?.t || ''),
   'including the withdraw-then-land order a zee is meant to follow');

server.close();
await pool.end().catch(() => {});
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
