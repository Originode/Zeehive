// LAND-LOOP integration test — proves the three fixes against a THROWAWAY postgres + real git repos.
//
// Runs the REAL queenzee code paths (no mocks of the logic under test):
//   • selfLand → collect (no-op: no cxell) → catchUpToXource (REAL rebase onto moved master) →
//     pushToXource (REAL git push through the REAL land-gate `update` hook) → honest status.
//   • decideLandRequest → landApproved (REAL update-ref) → nudgeXellAfterLand (REAL docker-exec
//     command, captured by a fake `docker` on PATH).
//
// The ONLY seams are the two things a cxell genuinely provides and this box does not: `docker`
// (stubbed on PATH — its argv is what we ASSERT on for the nudge) and the queenzee HTTP surface the
// git hook curls (a 30-line server that calls the SAME checkPush the real route calls).
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 47999;
const API = `http://127.0.0.1:${API_PORT}`;
process.env.ZEEHIVE_API = API;

const { q, one, pool } = await import('../server/src/db/pool.js');
const { selfLand } = await import('../server/src/queenzee/self.js');
const { catchUpWorktree } = await import('../server/src/queenzee/xellgit.js');
const { checkPush, decideLandRequest } = await import('../server/src/queenzee/landgate.js');

const REPO_ROOT = process.cwd();
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. real git repos: master moved AFTER the xell branched ───────────────────
const tmp = mkdtempSync(join(tmpdir(), 'land-loop-'));
const src = join(tmp, 'src');     // the xource repo (project.repo_root)
const wt = join(tmp, 'wt');       // the xell's linked worktree
git(tmp, ['init', '-q', '-b', 'main', 'src']);
const cfg = (k, v) => git(src, ['config', k, v]);
cfg('user.email', 'test@zeehive.local'); cfg('user.name', 'test');
cfg('receive.denyCurrentBranch', 'ignore'); // pushing to the checked-out main is fine in this test
writeFileSync(join(src, 'a.txt'), 'A\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'A (base)']);
const shaA = git(src, ['rev-parse', 'HEAD']);
// the xell branches off A, into a linked worktree
git(src, ['worktree', 'add', '-q', '-b', 'spinoff/test', wt, shaA]);
git(wt, ['config', 'user.email', 'zee@zeehive.local']); git(wt, ['config', 'user.name', 'zee']);
// the zee does its work on the branch
writeFileSync(join(wt, 'zee.txt'), 'zee work\n'); git(wt, ['add', '.']); git(wt, ['commit', '-qm', 'Z (zee work)']);
const shaZ = git(wt, ['rev-parse', 'HEAD']);
// MASTER MOVES while the zee worked — the whole bug: a straight push is now a non-fast-forward
writeFileSync(join(src, 'b.txt'), 'B\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'B (landed while zee ran)']);
const shaB = git(src, ['rev-parse', 'HEAD']);
ok(git(wt, ['rev-parse', 'HEAD']) === shaZ, `worktree HEAD is Z (${shaZ.slice(0, 8)}), based on OLD master A (${shaA.slice(0, 8)})`);
ok(git(src, ['rev-parse', 'main']) === shaB, `master moved to B (${shaB.slice(0, 8)}) — Z would be a NON-fast-forward`);
// prove it: Z does not fast-forward main (B is not an ancestor of Z)
const nonFF = spawnSync('git', ['-C', wt, 'merge-base', '--is-ancestor', shaB, shaZ]).status !== 0;
ok(nonFF, 'confirmed: master (B) is NOT an ancestor of the zee commit (Z) — the divergence the bug hit');

// ── 2. seed the throwaway DB ──────────────────────────────────────────────────
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch, auto_approve_land)
   VALUES ('landtest', $1, 'main', false) RETURNING *`, [src]);
const xource = await one(
  `INSERT INTO xource (project_id, ref, xell_id) VALUES ($1, 'main', NULL) RETURNING *`, [project.id]);
const xell = await one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, self_token_hash)
   VALUES ($1,$2,'test-slug','spinoff/test',$3,$4,'working','deadbeefhash') RETURNING *`,
  [project.id, xource.id, wt, shaA]);
// a LIVE CXELLD zee (entrypoint cxell-cli + a live ssh-terminal cxell) — the only kind we nudge
const SID = '11111111-2222-3333-4444-555555555555';
await one(
  `INSERT INTO zee (xell_id, attach_mode, entrypoint, kind, viewer_kind, viewer_url,
                    claude_session_id, model, status)
   VALUES ($1,'headless-spawn','cxell-cli','headless','ssh-terminal','ssh://zee@127.0.0.1:22001',
           $2,'opus','idle') RETURNING id`, [xell.id, SID]);

// ── 3. install the REAL land-gate update hook, pointed at a tiny checkPush server ──
const hookTpl = readFileSync(join(REPO_ROOT, 'hooks', 'land-gate-update.sh'), 'utf8');
const hook = hookTpl
  .replaceAll('__API__', API)
  .replaceAll('__PROJECT_ID__', project.id)
  .replaceAll('__PROTECTED_REFS_FILE__', join(tmp, 'no-such-refs-file')) // → falls back to main
  .replaceAll('__MAIN_BRANCH__', 'main');
const hookPath = join(src, '.git', 'hooks', 'update');
writeFileSync(hookPath, hook); chmodSync(hookPath, 0o755);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/api/land/check')) { res.statusCode = 404; return res.end('{}'); }
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const { project_id, ref, old, new: newSha } = JSON.parse(body || '{}');
      const r = await checkPush({ projectId: project_id, ref, oldSha: old, newSha });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ allow: false, reason: 'gate-error', error: e.message })); }
  });
});
await new Promise((r) => server.listen(API_PORT, '127.0.0.1', r));

// ── 4. BUG 1: selfLand catches up + reports an HONEST 'held' with a REAL row ───
console.log('\n── selfLand: catch-up + honest status ──');
const land = await selfLand(xell);
console.log('  selfLand →', JSON.stringify({ ok: land.ok, status: land.status, catch_up: land.catch_up?.state,
  request_status: land.request?.status, request_new_sha: land.request?.new_sha?.slice(0, 8) }));
ok(land.status === 'held', `status is 'held' (was: ${land.status})`);
ok(land.catch_up?.state === 'rebased', `catch-up REBASED the zee commit onto current master (state=${land.catch_up?.state})`);
const wtHeadAfter = git(wt, ['rev-parse', 'HEAD']);
ok(wtHeadAfter !== shaZ, `worktree HEAD is a NEW sha after rebase (${wtHeadAfter.slice(0, 8)}, was ${shaZ.slice(0, 8)})`);
ok(spawnSync('git', ['-C', wt, 'merge-base', '--is-ancestor', shaB, wtHeadAfter]).status === 0,
  'the rebased HEAD now FAST-FORWARDS master (B is its ancestor) — the push can land cleanly');
// the REAL land_request row exists, pending, for exactly the pushed sha
const row = await one(`SELECT * FROM land_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xell.id]);
ok(!!row, 'a land_request row was actually raised (not the fleet-burn-tracker lie)');
ok(row?.status === 'pending', `land_request.status is 'pending' (${row?.status})`);
ok(row?.new_sha === wtHeadAfter, 'land_request.new_sha === the rebased worktree HEAD');
ok(git(src, ['rev-parse', 'main']) === shaB, 'master did NOT move — the push is HELD, not landed');

// ── 5. BUG 2: approve → master moves AND the cxell zee is NUDGED ───────────────
console.log('\n── approval: land + queenzee NUDGE ──');
const DOCKER_LOG = join(tmp, 'docker.log');
process.env.DOCKER_LOG = DOCKER_LOG;                 // fake docker (test/_bin) logs here
process.env.PATH = `${join(REPO_ROOT, 'test', '_bin')}:${process.env.PATH}`;
const decided = await decideLandRequest(row.id, 'approved', 'human@test');
ok(decided?.status === 'landed', `land_request → 'landed' (${decided?.status})`);
ok(git(src, ['rev-parse', 'main']) === wtHeadAfter, 'master NOW moved to the approved sha (queenzee update-ref, no hook re-entrancy)');
// the nudge is fire-and-forget — wait briefly for the fake docker to record the resume
let log = '';
for (let i = 0; i < 25 && !/--resume/.test(log); i++) { await sleep(120); log = existsSync(DOCKER_LOG) ? readFileSync(DOCKER_LOG, 'utf8') : ''; }
ok(/exec/.test(log) && /--resume/.test(log), 'the queenzee ran `docker exec … claude … --resume` to re-invoke the session');
ok(log.includes(SID), `the resume targeted THIS cxell session id (${SID.slice(0, 8)}…)`);
ok(/claude --bare -p/.test(log), 'the nudge runs `claude --bare -p` (headless continuation)');
ok(/landing was APPROVED/.test(log), 'the nudge prompt tells the zee its landing landed and to continue (ship → done)');

// ── 6. catch-up unit cases (no DB) ────────────────────────────────────────────
console.log('\n── catchUpWorktree: the other branches ──');
// up-to-date: a worktree already containing master
const u = catchUpWorktree(wt, 'main'); // wt now == master after the land
ok(u.state === 'up-to-date', `already-current worktree → 'up-to-date' (${u.state})`);
// conflict: two edits to the same line
const src2 = join(tmp, 'src2'), wt2 = join(tmp, 'wt2');
git(tmp, ['init', '-q', '-b', 'main', 'src2']);
git(src2, ['config', 'user.email', 't@t']); git(src2, ['config', 'user.name', 't']);
writeFileSync(join(src2, 'f.txt'), 'base\n'); git(src2, ['add', '.']); git(src2, ['commit', '-qm', 'base']);
git(src2, ['worktree', 'add', '-q', '-b', 'spinoff/c', wt2, 'HEAD']);
git(wt2, ['config', 'user.email', 'z@z']); git(wt2, ['config', 'user.name', 'z']);
writeFileSync(join(wt2, 'f.txt'), 'zee-side\n'); git(wt2, ['add', '.']); git(wt2, ['commit', '-qm', 'zee edit']);
writeFileSync(join(src2, 'f.txt'), 'master-side\n'); git(src2, ['add', '.']); git(src2, ['commit', '-qm', 'master edit']);
const c = catchUpWorktree(wt2, 'main');
ok(c.state === 'conflict', `real conflicting edits → 'conflict' (${c.state}), NOT a silent bad merge`);
ok(spawnSync('git', ['-C', wt2, 'status', '--porcelain']).stdout.toString().indexOf('UU') === -1
   && !existsSync(join(wt2, '.git', 'rebase-merge')) && !existsSync(join(wt2, '.git', 'rebase-apply')),
  'the conflicting rebase was ABORTED — the worktree is left clean, not wedged mid-rebase');

// ── done ──────────────────────────────────────────────────────────────────────
server.close();
await pool.end().catch(() => {});
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
