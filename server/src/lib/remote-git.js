// The ONLY module that talks to a git remote over the network — and it only ever READS.
//
// GitHub is inbound transport (Mark, 2026-07-20): New Project can CLONE from a URL, and the
// console's Pull fetches + fast-forwards. NOTHING HERE OR ANYWHERE MAY PUSH — Mark pushes by
// hand. No push function exists in this module on purpose; do not add one. The dev cycle
// (landing, integration, prod builds) works entirely on the local repo and never depends on
// the remote being reachable.
//
// Credentials: a per-project fine-grained READ-ONLY PAT from the provider_token table. It is
// handed to git through a ONE-SHOT in-memory credential helper with the token in the child's
// env — never in argv (visible in `ps`), never written to git config, never part of the
// stored remote URL. The first empty `credential.helper=` clears any configured manager
// (e.g. manager-core) so nothing prompts, caches, or overrides.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { cleanGitEnv } from './git.js';

// One-shot credential injection (see header). GIT_TERMINAL_PROMPT=0 makes an auth failure fail
// fast instead of hanging the server on an invisible username prompt.
function credArgs(token) {
  if (!token) return [];
  return [
    '-c', 'credential.helper=',
    '-c', `credential.helper=!f(){ echo username=x-access-token; echo "password=$GIT_PAT"; };f`,
  ];
}
function credEnv(token) {
  return cleanGitEnv(token ? { GIT_TERMINAL_PROMPT: '0', GIT_PAT: token } : { GIT_TERMINAL_PROMPT: '0' });
}

// Async spawn twin of git.js's gitAsync, with credential env + stderr streaming for clone
// progress. Network git in a single-process orchestrator must never run sync (the 2026-07-19
// event-loop-freeze lesson — and a WAN fetch stalls far longer than any local git call).
function gitNet(args, { cwd, token, timeout = 120000, onStderrLine } = {}) {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, windowsHide: true, env: credEnv(token) });
    let out = '', err = '', buf = '';
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeout);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (onStderrLine) {
        buf += s;
        // git progress uses \r for in-place updates — treat both as line breaks
        const lines = buf.split(/[\r\n]/);
        buf = lines.pop() || '';
        for (const line of lines) if (line.trim()) onStderrLine(line.trim());
      }
    });
    p.on('error', (e) => { clearTimeout(t); resolve({ status: -1, out, err: err + String(e.message) }); });
    p.on('close', (status) => { clearTimeout(t); resolve({ status, out, err }); });
  });
}

const looksLikeAuthFailure = (err) =>
  /authentication failed|could not read Username|terminal prompts disabled|403|invalid credentials|Password authentication is not supported/i.test(err || '');

// What's at the other end of this URL? Read-only ls-remote: default branch (via --symref HEAD)
// and the branch list. Never touches the local repo. auth_required=true when an anonymous try
// smells like a credential wall (a private repo probed without a token).
export async function probeRemote(url, { token } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return { reachable: false, auth_required: false, default_branch: null, branches: [], error: 'only http(s) remote URLs are supported' };
  }
  const r = await gitNet([...credArgs(token), 'ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], { token, timeout: 30000 });
  if (r.status !== 0) {
    return {
      reachable: false,
      auth_required: looksLikeAuthFailure(r.err),
      default_branch: null,
      branches: [],
      error: (r.err || 'unreachable').trim().slice(-300),
    };
  }
  let default_branch = null;
  const branches = [];
  for (const line of r.out.split('\n')) {
    const sym = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
    if (sym) { default_branch = sym[1]; continue; }
    const br = line.match(/^[0-9a-f]{40}\s+refs\/heads\/(\S+)$/);
    if (br) branches.push(br[1]);
  }
  return { reachable: true, auth_required: false, default_branch, branches, error: null };
}

// Clone a remote into a fresh directory. Refuses to touch an existing non-empty dest (never
// overwrite something on disk we didn't make); removes the half-clone if the clone dies so a
// retry doesn't hit its own debris. Progress lines (git writes them to stderr) stream to
// onProgress for the console's SSE log.
export async function cloneFromRemote({ url, dest, branch, token, onProgress } = {}) {
  if (!url || !dest) return { cloned: false, reason: 'url and dest are required' };
  const existed = existsSync(dest);
  if (existed) {
    let entries = [];
    try { entries = readdirSync(dest); } catch { /* unreadable counts as occupied */ entries = ['?']; }
    if (entries.length > 0) return { cloned: false, reason: `destination ${dest} already exists and is not empty` };
  }
  const args = [
    ...credArgs(token), 'clone', '--progress',
    ...(branch ? ['--branch', branch] : []),
    url, dest,
  ];
  const r = await gitNet(args, { token, timeout: 15 * 60 * 1000, onStderrLine: onProgress });
  if (r.status !== 0) {
    // remove only what the clone itself created — an empty pre-existing dir stays
    if (!existed) { try { await rm(dest, { recursive: true, force: true }); } catch { /* best effort */ } }
    return {
      cloned: false,
      reason: looksLikeAuthFailure(r.err)
        ? 'authentication failed — a private repo needs a read-only GitHub token (Project setup → Tokens)'
        : (r.err || 'clone failed').trim().slice(-300),
    };
  }
  return { cloned: true, reason: null };
}

// Fetch + FAST-FORWARD-ONLY merge of origin/<branch> into the repo_root checkout. The landing
// gate is a receive-side `update` hook — it fires only on push, so a fetch+merge here never
// trips it (and must never become a push/update-ref, which would either trip the gate or
// desync the working tree). Refusals return {pulled:false, reason} — the console shows the
// reason, it is not an error. "Local ahead of origin" is the NORMAL state (landings outrun the
// hand-pushed mirror) and reads as up-to-date.
export async function pullRemote({ repoRoot, branch = 'main', remoteUrl, token } = {}) {
  if (!repoRoot || !remoteUrl) return { pulled: false, state: 'error', reason: 'repoRoot and remoteUrl are required' };
  const g = (args, opts = {}) => gitNet(['-C', repoRoot, ...args], opts);

  // the checkout must actually be on the branch we're fast-forwarding, or the merge would land
  // somewhere else entirely (e.g. a detached ship checkout)
  const cur = await g(['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 15000 });
  const current = cur.status === 0 ? cur.out.trim() : null;
  if (current !== branch) {
    return { pulled: false, state: 'refused', reason: `checkout is on '${current || 'unknown'}', not '${branch}' — pull only fast-forwards the checked-out main` };
  }

  // dirty tree → refuse (same stance as pullFromXource: never merge over uncommitted work)
  const st = await g(['status', '--porcelain'], { timeout: 30000 });
  const dirty = st.status === 0 ? st.out.split('\n').filter(Boolean).length : -1;
  if (dirty !== 0) {
    return { pulled: false, state: 'refused', reason: dirty > 0 ? `${dirty} uncommitted change(s) in the checkout — commit or stash first` : 'could not read working-tree status' };
  }

  // keep `origin` pointed at the recorded remote (credential-free URL — the token never lands here)
  const cur0 = await g(['remote', 'get-url', 'origin'], { timeout: 15000 });
  if (cur0.status !== 0) await g(['remote', 'add', 'origin', remoteUrl], { timeout: 15000 });
  else if (cur0.out.trim() !== remoteUrl) await g(['remote', 'set-url', 'origin', remoteUrl], { timeout: 15000 });

  const before = (await g(['rev-parse', 'HEAD'], { timeout: 15000 })).out.trim();

  const fr = await g([...credArgs(token), 'fetch', 'origin', branch], { token, timeout: 5 * 60 * 1000 });
  if (fr.status !== 0) {
    return {
      pulled: false, state: 'error',
      reason: looksLikeAuthFailure(fr.err)
        ? 'authentication failed — connect a read-only GitHub token in Project setup → Tokens'
        : `fetch failed: ${(fr.err || '').trim().slice(-300)}`,
    };
  }

  const mr = await g(['merge', '--ff-only', `origin/${branch}`], { timeout: 60000 });
  if (mr.status !== 0) {
    return {
      pulled: false, state: 'refused-diverged',
      reason: `local ${branch} and origin/${branch} have both moved — Zeehive never merges or pushes; reconcile by hand`,
    };
  }

  const after = (await g(['rev-parse', 'HEAD'], { timeout: 15000 })).out.trim();
  if (after === before) return { pulled: true, state: 'up-to-date', from: before, to: after, commits: 0 };
  const rc = await g(['rev-list', '--count', `${before}..${after}`], { timeout: 30000 });
  return {
    pulled: true, state: 'fast-forwarded', from: before, to: after,
    commits: rc.status === 0 ? (+rc.out.trim() || 0) : null,
  };
}
