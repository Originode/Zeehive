// LAND-RETRY (self-heal) integration test — the message must AGREE with the land_request.
//
// The bug: a landing that SELF-HEALS a concurrent main move (syncs main in, so the retry is a merge
// commit) can have its push EXIT NON-ZERO while the ref actually moves and the gate records the
// landing as 'landed'. `git push` reports that shape whenever the client fails AFTER the ref update
// — a timeout kill, a broken sideband, a hiccup reading the report — and `push.landed` (the exit
// code) cannot tell the two apart. So selfLand fell through to its failure branch and printed
//
//   "Push did not land and the latest land_request is 'landed' ... not a fresh pending hold"
//
// at the very moment the landing WAS on main — a well-formed lie, CLAUDE.md §1's family. A zee that
// reads it re-lands, escalates a phantom, or reports a false failure to a human.
//
// Runs the REAL code path against a throwaway postgres + REAL git repos + the REAL land-gate
// `update` hook. The only seams are the ones a cxell genuinely provides and this box does not:
//   • `docker` — absent here, so selfLand's cxell live-check is false and the catch-up merges main
//     into the worktree directly (the same shape the in-cage self-heal produces). No fake needed.
//   • the tiny HTTP server the git hook curls (which calls the SAME checkPush the route calls).
//   • a `post-receive` hook, used ONLY to force the shape under test: the ref moves, then the push's
//     client exits non-zero. That is exactly "the push reported failure but it DID land" — the ref
//     state, not the exit code, is what the fix must read. (No such hook exists on the real xource;
//     it is a deterministic stand-in for a client-side failure after the ref update.)
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_PORT = 47993;
const API = `http://127.0.0.1:${API_PORT}`;
process.env.ZEEHIVE_API = API;
// Declared BEFORE any import: the modules read it once at load. 'real' is what lets selfLand push
// into this throwaway xource at all (a nested/simulate queenzee refuses at the head of the verb).
process.env.PROVISION_MODE = 'real';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { q, one, pool } = await import('../server/src/db/pool.js');
const { selfLand } = await import('../server/src/queenzee/self.js');
const { checkPush } = await import('../server/src/queenzee/landgate.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};

// ── 1. real git repos: the xource moves while the zee works ───────────────────
const tmp = mkdtempSync(join(tmpdir(), 'land-retry-'));
const src = join(tmp, 'src');     // the xource repo (project.repo_root)
const wt = join(tmp, 'wt');       // the xell's linked worktree
git(tmp, ['init', '-q', '-b', 'main', 'src']);
const cfg = (k, v) => git(src, ['config', k, v]);
cfg('user.email', 'queenzee@zeehive.local'); cfg('user.name', 'Zeehive queenzee');
writeFileSync(join(src, 'a.txt'), 'A\n'); git(src, ['add', '.']); git(src, ['commit', '-qm', 'A (base)']);
const shaA = git(src, ['rev-parse', 'HEAD']);
git(src, ['worktree', 'add', '-q', '-b', 'spinoff/retry', wt, shaA]);
git(wt, ['config', 'user.email', 'xell@xell.zeehive.local']); git(wt, ['config', 'user.name', 'xell']);
writeFileSync(join(wt, 'zee.txt'), 'zee work\n'); git(wt, ['add', '.']); git(wt, ['commit', '-qm', 'Z (zee work)']);

// ── 2. throwaway rows: one project (auto-approve ON), one xell ────────────────
await q(`DELETE FROM project WHERE name='landretrytest'`);
const project = await one(
  `INSERT INTO project (name, repo_root, main_branch, auto_approve_land)
   VALUES ('landretrytest', $1, 'main', true) RETURNING *`, [src]);
const xource = await one(
  `INSERT INTO xource (project_id, ref, xell_id) VALUES ($1, 'main', NULL) RETURNING *`, [project.id]);
const xell = await one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, head_commit, status, self_token_hash)
   VALUES ($1,$2,'retry-slug','spinoff/retry',$3,$4,'working','retryhash-1') RETURNING *`,
  [project.id, xource.id, wt, shaA]);

// ── 3. the REAL update hook, pointed at a checkPush server ────────────────────
const hookPath = join(src, '.git', 'hooks', 'update');
writeFileSync(hookPath, read('hooks/land-gate-update.sh')
  .replaceAll('__API__', API)
  .replaceAll('__PROJECT_ID__', project.id)
  .replaceAll('__PROTECTED_REFS_FILE__', join(tmp, 'no-such-refs-file')) // → falls back to main
  .replaceAll('__MAIN_BRANCH__', 'main'));
chmodSync(hookPath, 0o755);
const POST_RECEIVE = join(src, '.git', 'hooks', 'post-receive');

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

const commit = (repo, file, text, msg) => {
  writeFileSync(join(repo, file), text); git(repo, ['add', '.']); git(repo, ['commit', '-qm', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
};

// ── 4. THE RETRY THAT DID LAND: the push exits non-zero, the ref moved ─────────
// This is the exact self-heal+retry shape: main moves concurrently, selfLand's catch-up MERGES it
// in (the cxell self-heal, one layer down), the gate auto-approves and records 'landed' — and the
// push's client exits non-zero for a reason that has nothing to do with the landing.
console.log('\n── the retry whose push DID land ──');
cfg('receive.denyCurrentBranch', 'ignore'); // let the ref move (this test is about the message)
const shaB = commit(src, 'b.txt', 'B\n', 'B (landed while the zee ran)'); // the concurrent move
// post-receive runs AFTER the ref update: killing receive-pack makes the CLIENT exit non-zero while
// the ref stays moved. Deterministic stand-in for the client-side failure the exit code can't see.
writeFileSync(POST_RECEIVE, '#!/bin/sh\nkill -9 $PPID\n'); chmodSync(POST_RECEIVE, 0o755);

const retry = await selfLand(xell);
const retryRow = await one(`SELECT * FROM land_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xell.id]);
const mainAfter = git(src, ['rev-parse', 'main']);
console.log('  selfLand →', JSON.stringify({ status: retry.status, landed: retry.landed,
  request_status: retryRow?.status, request_new_sha: retryRow?.new_sha?.slice(0, 8), main: mainAfter.slice(0, 8) }));
ok(retry.catch_up?.state === 'merged' || retry.healed?.state === 'merged',
   `the concurrent move was merged in (catch_up=${retry.catch_up?.state}, healed=${retry.healed?.state})`);
ok(retryRow?.status === 'landed', `the gate RECORDED the landing as landed (${retryRow?.status})`);
ok(retryRow?.new_sha === mainAfter, 'and the ref genuinely MOVED to that sha — the landing DID land');
// THE ASSERTION THE BUG FAILED: the final message must agree with the land_request it quotes.
ok(retry.status === 'landed' && retry.landed === true,
   `selfLand reports the landing (status=${retry.status}, landed=${retry.landed}) — not a phantom failure`);
ok(/LANDED/.test(retry.message || '') && !/did not land/i.test(retry.message || ''),
   `the message says LANDED and never "did not land": "${String(retry.message || '').slice(0, 90)}…"`);
rmSync(POST_RECEIVE, { force: true });

// ── 5. THE GENUINE FAILURE: gate says landed, the ref did NOT move ─────────────
// The other way a push can exit non-zero after the hook answered: receive.denyCurrentBranch=
// updateInstead refuses the ref update over a dirty xource tree (xource-clean exists for exactly
// this). Here the landing really did NOT happen — the fix must NOT paper over it with a false
// 'LANDED', and must NOT answer a landed row with "Push did not land" either.
console.log('\n── the gate says landed but the ref did NOT move (dirty xource) ──');
cfg('receive.denyCurrentBranch', 'updateInstead');
git(src, ['reset', '--hard', 'main']);
const shaC = commit(src, 'c.txt', 'C\n', 'C (a later concurrent move)');
writeFileSync(join(wt, 'zee.txt'), 'zee work 2\n'); git(wt, ['add', '.']); git(wt, ['commit', '-qm', 'Z2 (more zee work)']);
writeFileSync(join(src, 'a.txt'), 'A\nDIRTY\n');   // the checkout is now not clean

const failed = await selfLand(xell);
const failRow = await one(`SELECT * FROM land_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xell.id]);
const mainAfterFail = git(src, ['rev-parse', 'main']);
console.log('  selfLand →', JSON.stringify({ status: failed.status, landed: failed.landed,
  request_status: failRow?.status, main: mainAfterFail.slice(0, 8) }));
ok(failRow?.status === 'landed', `the gate still RECORDED it as landed (${failRow?.status})`);
ok(mainAfterFail === shaC, 'but main did NOT move — nothing actually landed');
ok(failed.landed === false && failed.status !== 'landed',
   `selfLand does NOT claim the landing (status=${failed.status}, landed=${failed.landed})`);
ok(!/Push did not land/.test(failed.message || ''),
   'and it never answers a landed land_request with "Push did not land"');
ok(/RECORDED|recorded/.test(failed.message || '') && /does NOT contain|did NOT move|not.*on main/i.test(failed.message || ''),
   `instead it names the disagreement (gate recorded it; the ref never moved): "${String(failed.message || '').slice(0, 90)}…"`);

// ── done ──────────────────────────────────────────────────────────────────────
server.close();
await pool.end().catch(() => {});
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
