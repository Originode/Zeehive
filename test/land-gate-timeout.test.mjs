// LAND-GATE TIMEOUT — retry-with-backoff, still fail closed.
//
// The bug: hooks/land-gate-update.sh gave /api/land/check one 10s shot and FAILED CLOSED on
// timeout (curl rc=28). Under load that declined a push whose land_request was already
// approved — the human decision looked reversed. The remedy is retry-with-backoff inside a
// bounded wait so a busy (not gone) queenzee answers before we give up. On genuine exhaustion
// we still decline, with a message that names the attempts and duration so it is not confused
// with a human rejection.
//
// Deliberately NOT fail-open. A path that lets an unreachable gate allow a push turns "can I
// write a local file" / "can I make the API miss for N seconds" into a landgate bypass. The
// manager countermanded that option; a declined push costs one re-push, a bypassed gate costs
// the fleet its only guarantee.
//
// Three cases against a stub HTTP server the REAL hook curls (same shape as land-loop):
//   A. unreachable  → decline, message names attempts + "not a human rejection"
//   B. slow-then-allow → retries, then proceeds on allow:true
//   C. rejected     → decline as a human rejection (unchanged)
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 47996;
const API = `http://127.0.0.1:${API_PORT}`;
process.env.ZEEHIVE_API = API;

const REPO_ROOT = process.cwd();
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};

// Async push: the hook curls back into this process, so a sync push deadlocks against its own gate.
const realPush = (wt) => new Promise((resolve) => {
  const p = spawn('git', ['-C', wt, 'push', '.', 'HEAD:refs/heads/main'], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('error', (e) => resolve({ out: `${out}\n${e.message}`, code: 1 }));
  p.on('close', (code) => resolve({ out, code: code ?? 1 }));
});

const PROJECT_ID = '00000000-0000-4000-8000-000000000099';
const tmp = mkdtempSync(join(tmpdir(), 'land-gate-timeout-'));
const refsFile = join(tmp, 'zeehive-protected-refs');
writeFileSync(refsFile, 'refs/heads/main\n');

function installHook(src) {
  const hookTpl = readFileSync(join(REPO_ROOT, 'hooks', 'land-gate-update.sh'), 'utf8');
  const hook = hookTpl
    .replaceAll('__API__', API)
    .replaceAll('__PROJECT_ID__', PROJECT_ID)
    .replaceAll('__PROTECTED_REFS_FILE__', refsFile)
    .replaceAll('__MAIN_BRANCH__', 'main');
  const hookPath = join(src, '.git', 'hooks', 'update');
  writeFileSync(hookPath, hook); chmodSync(hookPath, 0o755);
  return hookPath;
}

function mkRepo(label) {
  const src = join(tmp, `${label}-src`);
  const wt = join(tmp, `${label}-wt`);
  git(tmp, ['init', '-q', '-b', 'main', `${label}-src`]);
  git(src, ['config', 'user.email', 'queenzee@zeehive.local']);
  git(src, ['config', 'user.name', 'Zeehive queenzee']);
  git(src, ['config', 'receive.denyCurrentBranch', 'ignore']);
  writeFileSync(join(src, 'base.txt'), `${label}\n`);
  git(src, ['add', '.']); git(src, ['commit', '-qm', 'base']);
  const base = git(src, ['rev-parse', 'HEAD']);
  git(src, ['worktree', 'add', '-q', '-b', `spinoff/${label}`, wt, base]);
  git(wt, ['config', 'user.email', 'xell@xell.zeehive.local']);
  git(wt, ['config', 'user.name', 'xell']);
  writeFileSync(join(wt, 'zee.txt'), `${label}-work\n`);
  git(wt, ['add', '.']); git(wt, ['commit', '-qm', `${label} work`]);
  const sha = git(wt, ['rev-parse', 'HEAD']);
  installHook(src);
  return { src, wt, base, sha };
}

// ── mode for the tiny check server ─────────────────────────────────────────────
// 'down'             — nothing listening (connection refused). Fast unreachable.
// 'empty-then-allow' — empty body twice, then allow:true (exercises retry → proceed).
// 'reject'           — immediate allow:false reason=rejected.
let mode = 'down';
let hits = 0;
let server = null;

function startServer() {
  hits = 0;
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/land/check')) {
      res.statusCode = 404; return res.end('{}');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits += 1;
      if (mode === 'empty-then-allow') {
        if (hits <= 2) { res.end(''); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ allow: true, reason: 'approved' }));
        return;
      }
      if (mode === 'reject') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ allow: false, reason: 'rejected' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ allow: false, reason: 'pending' }));
    });
  });
  return new Promise((r) => server.listen(API_PORT, '127.0.0.1', r));
}

function stopServer() {
  return new Promise((r) => { if (!server) return r(); server.close(() => r()); server = null; });
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── A. unreachable API → FAIL CLOSED, message names attempts (not a human rejection) ──');
{
  const { src, wt } = mkRepo('closed');
  await stopServer();
  const before = git(src, ['rev-parse', 'main']);
  const { out, code } = await realPush(wt);
  ok(code !== 0, `push declined when gate unreachable (exit ${code})`);
  ok(/Gate did not answer|not a human rejection/i.test(out),
    'decline names "gate did not answer" / "not a human rejection"');
  ok(/Tried 3 times/i.test(out), 'and names how many attempts');
  ok(/Re-run the SAME push/i.test(out), 'and tells the zee to re-run the same push');
  ok(!/REJECTED this exact commit/i.test(out), 'and is NOT the human-rejection wording');
  ok(!/fail-open|ALLOWED ON RECORDED|approval receipt/i.test(out),
    'and contains no fail-open / receipt language');
  ok(git(src, ['rev-parse', 'main']) === before, `main stayed put — nothing landed`);
}

console.log('\n── B. slow-then-allow: empty ×2, then allow → retries and LANDS ──');
{
  const { src, wt, sha } = mkRepo('retry');
  mode = 'empty-then-allow';
  hits = 0;
  await startServer();
  const { out, code } = await realPush(wt);
  ok(code === 0, `push exited 0 after retries (exit ${code})`);
  ok(hits === 3, `gate was asked 3 times (hits=${hits}) — two empties then allow`);
  ok(/retrying/i.test(out), 'hook told the pusher it was retrying');
  ok(/landing approved by a human/i.test(out), 'final attempt followed the gate\'s real allow');
  ok(git(src, ['rev-parse', 'main']) === sha, `main moved to ${sha.slice(0, 8)} via the recovered API`);
  await stopServer();
}

console.log('\n── C. rejected → decline as a human rejection (unchanged) ──');
{
  const { src, wt } = mkRepo('reject');
  mode = 'reject';
  hits = 0;
  await startServer();
  const before = git(src, ['rev-parse', 'main']);
  const { out, code } = await realPush(wt);
  ok(code !== 0, `push declined on rejection (exit ${code})`);
  ok(/REJECTED this exact commit/i.test(out), 'uses the human-rejection wording');
  ok(!/Gate did not answer|not a human rejection/i.test(out),
    'and does NOT use the unreachable-gate wording');
  ok(hits === 1, `asked once (hits=${hits}) — a real answer needs no retry`);
  ok(git(src, ['rev-parse', 'main']) === before, 'main stayed put');
  await stopServer();
}

console.log('\n── D. no fail-open residue in the tree ──');
{
  const hook = readFileSync(join(REPO_ROOT, 'hooks', 'land-gate-update.sh'), 'utf8');
  ok(/MAX_ATTEMPTS=3/.test(hook), 'hook still retries (MAX_ATTEMPTS=3)');
  ok(/not a human rejection/.test(hook), 'exhaustion message distinguishes from rejection');
  ok(!/fail-open-with-audit|allow_on_receipt|zeehive-land-approvals|APPROVALS_DIR|RECEIPT=/.test(hook),
    'hook has no fail-open / receipt path');
  ok(!existsSync(join(REPO_ROOT, 'server/src/lib/land-approvals.js')),
    'server/src/lib/land-approvals.js is gone');
  const landgate = readFileSync(join(REPO_ROOT, 'server/src/queenzee/landgate.js'), 'utf8');
  ok(!/land-approvals|writeLandApproval|clearLandApproval|refreshLandGateHookIfStale/.test(landgate),
    'landgate.js imports none of the deleted receipt helpers');
}

await stopServer();
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
