// Local approval receipts for the landing gate — the queenzee's half of
// hooks/land-gate-update.sh's fail-open-with-audit path.
//
// WHY: the hook curls POST /api/land/check with a short deadline and historically FAILED CLOSED
// on timeout. Under load that silently reversed a human approval: the push was declined even
// though a land_request row said 'approved'. Fail-closed is still correct when there is NO
// approval (no approval service = no landing). It is wrong when the approval already exists.
//
// THE PATTERN is the same as protected-refs.js: the hook decides from a LOCAL file when the
// API cannot answer, so an unreachable queenzee cannot undo a recorded human decision. The
// receipt is written the moment a human approves, and cleared when the approval is spent,
// goes stale, or is rejected. Bound to one exact sha — same contract as the gate itself.
//
// Trust model: the receipt lives under the xource's git-common-dir (machine-local, not
// version-controlled), written only by this process. Same trust as zeehive-protected-refs.
//
// The hook itself is also machine-local (installed by scripts/install-land-gate.sh). Shipping
// a new template does nothing until that copy is refreshed — refreshLandGateHookIfStale()
// re-runs the installer when our installed hook predates fail-open-with-audit, so the first
// approve after ship brings the live gate up to date without a manual reinstall.
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanGitEnv } from './git.js';
import { logline } from './logbus.js';
import { resolveBash } from './bash.js';
import { config } from '../config.js';

const HOOK_MARKER = 'ZEEHIVE LANDING GATE';
const HOOK_STALE_NEEDLE = 'fail-open-with-audit';

export function landApprovalsDir(repoRoot) {
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, env: cleanGitEnv() });
  if (r.status !== 0) return null;
  return join(r.stdout.trim(), 'zeehive-land-approvals');
}

export function landApprovalPath(repoRoot, newSha) {
  const dir = landApprovalsDir(repoRoot);
  if (!dir || !newSha) return null;
  return join(dir, String(newSha).trim());
}

/** Write (or overwrite) a receipt for an approved sha. Idempotent. Returns the path or null. */
export function writeLandApproval(repoRoot, {
  projectId, ref, newSha, decidedBy, requestId, decidedAt = null,
} = {}) {
  const path = landApprovalPath(repoRoot, newSha);
  if (!path) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = JSON.stringify({
      project_id: projectId,
      ref,
      new_sha: newSha,
      decided_by: decidedBy || null,
      decided_at: decidedAt || new Date().toISOString(),
      request_id: requestId || null,
    }) + '\n';
    writeFileSync(path, body);
    logline('landgate',
      `approval receipt written for ${String(newSha).slice(0, 8)} `
      + `(by ${decidedBy || 'unknown'}) at ${path}`);
    return path;
  } catch (e) {
    logline('landgate', `could not write approval receipt for ${String(newSha).slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/** Remove a receipt once the approval is spent, stale, or otherwise finished. */
export function clearLandApproval(repoRoot, newSha) {
  const path = landApprovalPath(repoRoot, newSha);
  if (!path || !existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (e) {
    logline('landgate', `could not clear approval receipt for ${String(newSha).slice(0, 8)}: ${e.message}`);
    return false;
  }
}

/** Read a receipt back (for tests / diagnostics). Returns the parsed object or null. */
export function readLandApproval(repoRoot, newSha) {
  const path = landApprovalPath(repoRoot, newSha);
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

/** Append one audit line when the hook (or a test) allows on a receipt. Best-effort. */
export function auditLandApprovalAllow(repoRoot, { newSha, ref, reason } = {}) {
  const dir = landApprovalsDir(repoRoot);
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'audit.log'),
      `${new Date().toISOString()} allow-on-receipt ref=${ref || '?'} sha=${newSha || '?'} reason=${reason || ''}\n`);
  } catch { /* audit must never block a landing */ }
}

/** Path to the installed update hook for this repo (honours core.hooksPath). */
export function installedLandGatePath(repoRoot) {
  const hp = spawnSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, env: cleanGitEnv() });
  if (hp.status === 0 && hp.stdout.trim()) {
    const raw = hp.stdout.trim();
    const abs = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)
      ? raw
      : join(repoRoot, raw);
    return join(abs, 'update');
  }
  const common = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, env: cleanGitEnv() });
  if (common.status !== 0) return null;
  return join(common.stdout.trim(), 'hooks', 'update');
}

/**
 * If our landing-gate hook is installed but predates fail-open-with-audit, re-run the
 * installer so the live copy matches the template in this server's repo. No-op when the
 * hook is absent, foreign, or already current. Never throws — approve must not fail on this.
 */
export function refreshLandGateHookIfStale(repoRoot, {
  projectId, mainBranch = 'main', apiBase = null,
} = {}) {
  if (!repoRoot || !projectId) return { refreshed: false, reason: 'missing-args' };
  try {
    const hookPath = installedLandGatePath(repoRoot);
    if (!hookPath || !existsSync(hookPath)) return { refreshed: false, reason: 'not-installed' };
    const body = readFileSync(hookPath, 'utf8');
    if (!body.includes(HOOK_MARKER)) return { refreshed: false, reason: 'foreign-hook' };
    if (body.includes(HOOK_STALE_NEEDLE)) return { refreshed: false, reason: 'already-current' };

    const script = resolve(config.repoRoot, 'scripts', 'install-land-gate.sh');
    if (!existsSync(script)) return { refreshed: false, reason: 'no-installer' };
    const r = spawnSync(resolveBash(),
      [script, repoRoot, projectId, mainBranch, apiBase || config.apiBase || 'http://localhost:4700'],
      { encoding: 'utf8', timeout: 30000, windowsHide: true, env: cleanGitEnv() });
    if (r.status !== 0) {
      logline('landgate',
        `could not refresh stale land-gate hook at ${hookPath}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
      return { refreshed: false, reason: 'install-failed', detail: (r.stderr || r.stdout || '').trim() };
    }
    logline('landgate',
      `refreshed land-gate hook at ${hookPath} — now carries fail-open-with-audit`);
    return { refreshed: true, path: hookPath };
  } catch (e) {
    logline('landgate', `land-gate hook refresh skipped: ${e.message}`);
    return { refreshed: false, reason: 'error', detail: e.message };
  }
}
