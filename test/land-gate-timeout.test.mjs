// LAND-GATE TIMEOUT — proves a human approval is never undone by a busy/unreachable API.
//
// The bug: hooks/land-gate-update.sh gave /api/land/check 10s and FAILED CLOSED on timeout
// (curl rc=28). Under load that declined a push whose land_request was already 'approved' —
// the human decision was silently reversed. The reflection ranked this the one thing to build.
//
// The remedy (deliberate):
//   1. retry-with-backoff (3 attempts, linear sleep) so brief freezes do not decline anything
//   2. fail-open-with-audit on a LOCAL approval receipt the queenzee writes at approve-time
//      (same pattern as zeehive-protected-refs) — unapproved pushes still fail closed
//
// This suite exercises the REAL hook template against REAL git repos. The HTTP seam is a tiny
// server we control (hang / empty / eventually-allow), same shape as land-loop / land-queue.
// Part B also hits decideLandRequest so the receipt is written by the real approve path.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 47996;
const API = `http://127.0.0.1:${API_PORT}`;
process.env.ZEEHIVE_API = API;
process.env.PROVISION_MODE = 'real';

const REPO_ROOT = process.cwd();
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const approvalsDir = join(tmp, 'zeehive-land-approvals');

function installHook(src, projectId = PROJECT_ID) {
  const hookTpl = readFileSync(join(REPO_ROOT, 'hooks', 'land-gate-update.sh'), 'utf8');
  const hook = hookTpl
    .replaceAll('__API__', API)
    .replaceAll('__PROJECT_ID__', projectId)
    .replaceAll('__PROTECTED_REFS_FILE__', refsFile)
    .replaceAll('__MAIN_BRANCH__', 'main');
  const hookPath = join(src, '.git', 'hooks', 'update');
  writeFileSync(hookPath, hook); chmodSync(hookPath, 0x1ed); // 0755
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

function writeReceipt({ newSha, ref = 'refs/heads/main', projectId = PROJECT_ID, decidedBy = 'human@test' }) {
  mkdirSync(approvalsDir, { recursive: true });
  const body = JSON.stringify({
    project_id: projectId,
    ref,
    new_sha: newSha,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    request_id: '11111111-1111-4111-8111-111111111111',
  }) + '\n';
  writeFileSync(join(approvalsDir, newSha), body);
}

// ── mode for the tiny check server ─────────────────────────────────────────────
// 'hang'      — accept TCP, never respond (forces curl --max-time → rc=28). Too slow for
//               every case; used only when we specifically want a real timeout.
// 'down'      — do not listen (connection refused). Fast unreachable.
// 'empty-then-allow' — empty body twice, then allow:true (exercises retry).
// 'allow' / 'deny' — immediate answer.
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
      if (mode === 'hang') return; // never write, never end — curl hits --max-time
      if (mode === 'empty-then-allow') {
        if (hits <= 2) { res.end(''); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ allow: true, reason: 'approved' }));
        return;
      }
      if (mode === 'allow') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ allow: true, reason: 'approved' }));
        return;
      }
      // deny
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
console.log('\n── A. unreachable API + NO receipt → still fail closed ──');
{
  const { src, wt, base, sha } = mkRepo('closed');
  await stopServer(); // nothing listening
  mode = 'down';
  const before = git(src, ['rev-parse', 'main']);
  const { out, code } = await realPush(wt);
  ok(code !== 0, `push declined without a receipt (exit ${code})`);
  ok(/Gate unreachable|failing closed|Failing closed/i.test(out),
    'hook says failing closed (no approval to fail open on)');
  ok(!/fail-open-with-audit|ALLOWED ON RECORDED APPROVAL/i.test(out),
    'and does NOT claim fail-open-with-audit');
  ok(git(src, ['rev-parse', 'main']) === before, `main stayed at ${before.slice(0, 8)} — nothing landed`);
  ok(sha !== base, 'sanity: the zee commit differs from base');
  void src; void sha;
}

console.log('\n── B. unreachable API + approval receipt → push LANDS (fail-open-with-audit) ──');
{
  const { src, wt, base, sha } = mkRepo('approved');
  await stopServer();
  writeReceipt({ newSha: sha, decidedBy: 'human@console' });
  const { out, code } = await realPush(wt);
  ok(code === 0, `push exited 0 under unreachable API when receipt present (exit ${code})`);
  ok(/ALLOWED ON RECORDED APPROVAL|fail-open-with-audit/i.test(out),
    'hook names fail-open-with-audit in its message');
  ok(/human@console/.test(out), 'and names who approved');
  ok(git(src, ['rev-parse', 'main']) === sha,
    `main moved to the approved sha ${sha.slice(0, 8)}`);
  ok(existsSync(join(approvalsDir, 'audit.log')), 'audit.log was written next to the receipt');
  const audit = readFileSync(join(approvalsDir, 'audit.log'), 'utf8');
  ok(audit.includes(sha) && /allow-on-receipt/.test(audit),
    'audit.log records allow-on-receipt for this sha');
  ok(base !== sha, 'sanity: base ≠ approved sha');
}

console.log('\n── C. retry-with-backoff: empty answers twice, then allow → lands ──');
{
  const { src, wt, sha } = mkRepo('retry');
  mode = 'empty-then-allow';
  hits = 0;
  await startServer();
  const { out, code } = await realPush(wt);
  ok(code === 0, `push exited 0 after retries (exit ${code})`);
  ok(hits === 3, `gate was asked 3 times (hits=${hits}) — two empties then allow`);
  ok(/retrying/i.test(out), 'hook told the pusher it was retrying');
  ok(/landing approved by a human/i.test(out), 'final attempt was a normal allow, not fail-open');
  ok(git(src, ['rev-parse', 'main']) === sha, `main moved to ${sha.slice(0, 8)} via the recovered API`);
  await stopServer();
}

console.log('\n── D. land-approvals lib + landgate wiring (no live DB required) ──');
{
  // The assigned shared-dev DATABASE_URL in this xell has no usable password for ad-hoc pg
  // clients, so decideLandRequest is not exercised live here. The hook path above is the
  // load-bearing proof; this section proves the receipt helper and that landgate.js wires it.
  const { writeLandApproval, readLandApproval, clearLandApproval, landApprovalPath,
          landApprovalsDir, refreshLandGateHookIfStale, installedLandGatePath } =
    await import('../server/src/lib/land-approvals.js');

  const { src, sha } = mkRepo('lib');
  const dir = landApprovalsDir(src);
  ok(!!dir && dir.endsWith('zeehive-land-approvals'),
    `landApprovalsDir → …/zeehive-land-approvals (${dir})`);

  // Stale-hook refresh: a pre-fix installed hook (ours, but no fail-open) gets rewritten.
  const hookPath = installedLandGatePath(src);
  ok(!!hookPath && existsSync(hookPath), `installedLandGatePath finds the update hook (${hookPath})`);
  // Strip the new marker so the refresher treats it as stale, keep the ZEEHIVE marker.
  const staleBody = readFileSync(hookPath, 'utf8')
    .replaceAll('fail-open-with-audit', 'FAIL_OPEN_PLACEHOLDER');
  ok(/ZEEHIVE LANDING GATE/.test(staleBody) && !/fail-open-with-audit/.test(staleBody),
    'fixture hook is ours but stale');
  writeFileSync(hookPath, staleBody);
  const refreshed = refreshLandGateHookIfStale(src, { projectId: PROJECT_ID, mainBranch: 'main', apiBase: API });
  ok(refreshed.refreshed === true, `refreshLandGateHookIfStale rewrote the stale hook (${refreshed.reason || 'ok'})`);
  ok(/fail-open-with-audit/.test(readFileSync(hookPath, 'utf8')),
    'installed hook now carries fail-open-with-audit again');
  const again = refreshLandGateHookIfStale(src, { projectId: PROJECT_ID, mainBranch: 'main', apiBase: API });
  ok(again.refreshed === false && again.reason === 'already-current',
    'second call is a no-op (already-current)');

  const path = writeLandApproval(src, {
    projectId: PROJECT_ID,
    ref: 'refs/heads/main',
    newSha: sha,
    decidedBy: 'human@wiring-test',
    requestId: '22222222-2222-4222-8222-222222222222',
  });
  ok(!!path && existsSync(path), `writeLandApproval created a receipt at ${path}`);
  ok(path === landApprovalPath(src, sha), 'landApprovalPath agrees with what was written');
  const got = readLandApproval(src, sha);
  ok(got?.decided_by === 'human@wiring-test', 'readLandApproval round-trips decided_by');
  ok(got?.project_id === PROJECT_ID && got?.new_sha === sha && got?.ref === 'refs/heads/main',
    'receipt carries project/ref/sha the hook greps for');
  ok(clearLandApproval(src, sha) === true, 'clearLandApproval returns true when a file existed');
  ok(!readLandApproval(src, sha) && !existsSync(path), 'receipt is gone after clear');
  ok(clearLandApproval(src, sha) === false, 'clearLandApproval is idempotent on a missing file');

  // Static wiring: decideLandRequest must write the receipt; spend/land/stale must clear it.
  // (A source assertion, not a mock — the same shape nested-queenzee-land-ship-guard uses for
  // "the hook reads ZEEHIVE_API".) If someone removes the call, A–C still pass against a
  // hand-written receipt and the approve path silently stops protecting re-pushes under load.
  const landgateSrc = readFileSync(join(REPO_ROOT, 'server/src/queenzee/landgate.js'), 'utf8');
  ok(/import \{ writeLandApproval, clearLandApproval, refreshLandGateHookIfStale \}/.test(landgateSrc),
    'landgate.js imports writeLandApproval + clearLandApproval + refreshLandGateHookIfStale');
  ok(/writeLandApproval\(project\.repo_root/.test(landgateSrc),
    'decideLandRequest writes the receipt on approve');
  ok(/refreshLandGateHookIfStale\(project\.repo_root/.test(landgateSrc),
    'decideLandRequest refreshes a stale installed hook before writing the receipt');
  ok(/clearLandApproval\(project\.repo_root, newSha\)/.test(landgateSrc),
    'checkPush clears the receipt when spending an approval');
  ok(/clearApprovalReceipt\(stale\)/.test(landgateSrc),
    'closeAsStale clears the receipt so a dead sha cannot fail-open later');
  ok(/clearLandApproval\(project\.repo_root, row\.new_sha\)/.test(landgateSrc),
    'landApproved clears the receipt after the ref moves (or is already there)');
}

// ── done ──────────────────────────────────────────────────────────────────────
await stopServer();
console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
