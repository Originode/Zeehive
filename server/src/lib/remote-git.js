// The ONLY module that talks to a git remote over the network.
//
// GitHub is inbound transport by DEFAULT (Mark, 2026-07-20): New Project can CLONE from a URL,
// and the console's Pull fetches + fast-forwards. That default stands — with a Contents:Read-only
// PAT nothing here can push, and the dev cycle (landing, integration, prod builds) never depends
// on the remote being reachable.
//
// OUTBOUND is now OPT-IN and HUMAN-GATED (Mark, 2026-07-22): when a project's GitHub PAT actually
// carries write access, the console MAY offer a Push (local main → the remote's branch) and/or a
// PR (push a side branch + open a pull request). Both are surfaced only after `remoteAccess()`
// confirms the token's scope against the GitHub API, and both fire only from a human's click in
// the console behind a confirm dialog — a zee can never reach them, and a read-only token never
// sees the buttons. A push is fast-forward-only (never --force): a diverged remote fails loud,
// exactly like the ff-only Pull refuses a diverged local.
//
// Credentials: a per-project fine-grained PAT from the provider_token table. It is handed to git
// through a ONE-SHOT in-memory credential helper with the token in the child's env — never in
// argv (visible in `ps`), never written to git config, never part of the stored remote URL. The
// first empty `credential.helper=` clears any configured manager (e.g. manager-core) so nothing
// prompts, caches, or overrides. The same token authenticates the REST calls (access probe, PR
// open) via an Authorization header — never logged, never returned to the client.
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

// ── clone progress, parsed ────────────────────────────────────────────────────
// git --progress narrates four phases on stderr, each counting 0→100% on its own. A bar that
// just mirrored the last percentage would race to 100 four times, so the phases are laid end to
// end on ONE 0-100 scale, weighted by how long each actually takes on a big repo. Receiving is
// the network and dominates; counting/compressing happen on GitHub's side and are over quickly.
const CLONE_PHASES = [
  { re: /^remote:\s*Counting objects:\s+(\d+)%/,    key: 'counting',    label: 'counting objects',   from: 0,  to: 5 },
  { re: /^remote:\s*Compressing objects:\s+(\d+)%/, key: 'compressing', label: 'compressing',        from: 5,  to: 10 },
  { re: /^Receiving objects:\s+(\d+)%/,             key: 'receiving',   label: 'receiving objects',  from: 10, to: 80 },
  { re: /^Resolving deltas:\s+(\d+)%/,              key: 'resolving',   label: 'resolving deltas',   from: 80, to: 92 },
  // "Updating files" on modern git, "Checking out files" before 2.29 — both mean checkout.
  { re: /^(?:Updating|Checking out) files:\s+(\d+)%/, key: 'checkout',  label: 'checking out',       from: 92, to: 100 },
];

// One stderr line → {phase,label,pct,overall,detail}, or null when the line carries no percentage
// (banners like "Cloning into '…'" and warnings stay in the log rail where they belong).
export function parseGitProgress(line) {
  for (const p of CLONE_PHASES) {
    const m = p.re.exec(line);
    if (!m) continue;
    const pct = Math.max(0, Math.min(100, Number(m[1])));
    // the tail git appends to receiving lines: ", 12.34 MiB | 2.11 MiB/s" — minus the ", done."
    // it adds on the last frame of a phase, which is already said by the bar reaching the end.
    const raw = (/,\s*([\d.]+\s*[KMGT]?i?B[^)]*)$/.exec(line) || [])[1] || null;
    const detail = raw ? raw.replace(/,\s*done\.?\s*$/i, '').trim() : null;
    return {
      phase: p.key,
      label: p.label,
      pct,
      overall: Math.round(p.from + ((p.to - p.from) * pct) / 100),
      detail: detail || null,
    };
  }
  return null;
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

// ── OUTBOUND (opt-in, human-gated) — GitHub REST + push/PR ────────────────────
// Only github.com and GitHub Enterprise https remotes get an API base; everything else returns
// null and the outbound features simply never light up. github.com → api.github.com; an
// enterprise host <h> → https://<h>/api/v3 (its documented REST root).
export function parseGitHubSlug(url) {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  if (!m) return null;
  const [, host, owner, repo] = m;
  const h = host.toLowerCase();
  const apiBase = (h === 'github.com' || h === 'www.github.com')
    ? 'https://api.github.com'
    : `https://${host}/api/v3`;
  return { host, owner, repo, apiBase };
}

// One authenticated REST call. The token rides the Authorization header (never argv, never a log).
// Returns {ok, status, body, error} — network failure is status 0, not a throw, so callers branch
// instead of unwinding. 15s cap: a hung api.github.com must not wedge the single-process server.
async function githubApi(slug, path, { token, method = 'GET', body } = {}) {
  if (!slug) return { ok: false, status: 0, body: null, error: 'not a recognised GitHub URL' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`${slug.apiBase}${path}`, {
      method,
      signal: ctl.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zeehive',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* empty/non-json body */ }
    return { ok: res.ok, status: res.status, body: payload, error: res.ok ? null : (payload?.message || `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e?.name === 'AbortError' ? 'GitHub API timed out' : String(e?.message || e) };
  } finally { clearTimeout(t); }
}

// What can THIS token actually do to THIS repo? Reads the repo's effective `permissions` block
// (GitHub computes it for the authenticated token), so a Contents:Read-only PAT reports can_push
// false and the console never shows the outbound buttons. can_pr additionally needs the pull
// requests to be openable at all — a fork/archived repo can be pushable-to yet PR-flow differs —
// so it is gated on write AND the repo not being archived. Never throws; a probe that can't reach
// GitHub returns can_push/can_pr false with a reason the console can show.
export async function remoteAccess({ url, token } = {}) {
  const slug = parseGitHubSlug(url);
  if (!slug) return { provider: null, can_push: false, can_pr: false, reason: 'remote is not a GitHub URL — push/PR are GitHub-only' };
  if (!token) return { provider: 'github', can_push: false, can_pr: false, reason: 'no GitHub token connected — outbound needs a PAT with write access' };
  const r = await githubApi(slug, `/repos/${slug.owner}/${slug.repo}`, { token });
  if (!r.ok) {
    return { provider: 'github', can_push: false, can_pr: false,
      reason: r.status === 401 || r.status === 403
        ? 'the connected GitHub token is not authorised for this repo'
        : `could not read repo permissions: ${r.error}` };
  }
  const perms = r.body?.permissions || {};
  const archived = !!r.body?.archived;
  const can_push = !!(perms.push || perms.maintain || perms.admin) && !archived;
  return {
    provider: 'github',
    owner: slug.owner, repo: slug.repo,
    default_branch: r.body?.default_branch || null,
    archived,
    can_push,
    // opening a PR needs a branch pushed first, so write access is the floor; the pull-request
    // API itself is refused loudly at open-time if a fine-grained token lacks "Pull requests: write".
    can_pr: can_push,
    reason: can_push ? null
      : archived ? 'repository is archived — read-only'
      : 'the connected GitHub token has read-only access (Contents: write is needed to push)',
  };
}

// PUSH local <branch> to the remote's same branch. Fast-forward ONLY — no --force, ever — so a
// remote that moved ahead is REFUSED (non-fast-forward), matching the ff-only Pull. Keeps origin
// pointed at the credential-free remote URL (token never lands in git config), then pushes with
// the one-shot credential helper. Refusals come back {pushed:false, reason}; the console shows it.
export async function pushRemote({ repoRoot, branch = 'main', remoteUrl, token } = {}) {
  if (!repoRoot || !remoteUrl) return { pushed: false, state: 'error', reason: 'repoRoot and remoteUrl are required' };
  if (!token) return { pushed: false, state: 'error', reason: 'a GitHub token with write access is required to push' };
  const g = (args, opts = {}) => gitNet(['-C', repoRoot, ...args], opts);

  // push what the checkout has for <branch>, whatever it is checked out as — resolve the ref so a
  // detached ship checkout can't quietly push the wrong tip.
  const local = await g(['rev-parse', '--verify', `refs/heads/${branch}`], { timeout: 15000 });
  if (local.status !== 0) return { pushed: false, state: 'refused', reason: `local branch '${branch}' does not exist in the checkout` };
  const sha = local.out.trim();

  const cur0 = await g(['remote', 'get-url', 'origin'], { timeout: 15000 });
  if (cur0.status !== 0) await g(['remote', 'add', 'origin', remoteUrl], { timeout: 15000 });
  else if (cur0.out.trim() !== remoteUrl) await g(['remote', 'set-url', 'origin', remoteUrl], { timeout: 15000 });

  // no leading '+' → non-fast-forward is rejected by the remote (loud), never force-pushed.
  const pr = await g([...credArgs(token), 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { token, timeout: 5 * 60 * 1000 });
  if (pr.status !== 0) {
    const err = (pr.err || '').trim();
    const nonff = /non-fast-forward|fetch first|rejected|failed to push/i.test(err);
    return {
      pushed: false,
      state: looksLikeAuthFailure(err) ? 'refused-auth' : nonff ? 'refused-diverged' : 'error',
      reason: looksLikeAuthFailure(err)
        ? 'authentication failed — the connected GitHub token cannot write to this repo'
        : nonff
          ? `remote ${branch} has commits local ${branch} does not — Zeehive only fast-forwards; pull or reconcile first`
          : `push failed: ${err.slice(-300)}`,
    };
  }
  const upToDate = /up-to-date|Everything up-to-date/i.test(pr.err || '');
  return { pushed: true, state: upToDate ? 'up-to-date' : 'pushed', branch, sha };
}

// Open a PULL REQUEST: push the local <branch> tip to a NEW head branch on the remote, then create
// the PR against <base> (the repo default branch) via REST. The head branch is force-updatable
// (a re-run of the same request refreshes it), but MAIN is never touched. Returns {opened, url,...}
// or {opened:false, reason}. A fine-grained token missing "Pull requests: write" fails at the REST
// step with GitHub's own 403 message surfaced.
export async function openPullRequest({ repoRoot, remoteUrl, token, branch = 'main', headBranch, base, title, body } = {}) {
  if (!repoRoot || !remoteUrl) return { opened: false, reason: 'repoRoot and remoteUrl are required' };
  if (!token) return { opened: false, reason: 'a GitHub token with write access is required to open a PR' };
  const slug = parseGitHubSlug(remoteUrl);
  if (!slug) return { opened: false, reason: 'remote is not a GitHub URL — PRs are GitHub-only' };
  const g = (args, opts = {}) => gitNet(['-C', repoRoot, ...args], opts);

  const local = await g(['rev-parse', '--verify', `refs/heads/${branch}`], { timeout: 15000 });
  if (local.status !== 0) return { opened: false, reason: `local branch '${branch}' does not exist in the checkout` };
  const sha = local.out.trim();

  // default base = the remote's default branch (from the access probe); default head name carries
  // the short sha so repeat opens are idempotent-ish and collisions are unlikely.
  const access = await remoteAccess({ url: remoteUrl, token });
  const baseBranch = String(base || '').trim() || access.default_branch || branch;
  const head = String(headBranch || '').trim() || `zeehive/${branch}-${sha.slice(0, 8)}`;
  if (head === baseBranch) return { opened: false, reason: `head branch '${head}' equals base '${baseBranch}' — pick a different branch name` };

  const cur0 = await g(['remote', 'get-url', 'origin'], { timeout: 15000 });
  if (cur0.status !== 0) await g(['remote', 'add', 'origin', remoteUrl], { timeout: 15000 });
  else if (cur0.out.trim() !== remoteUrl) await g(['remote', 'set-url', 'origin', remoteUrl], { timeout: 15000 });

  // + on the head ref only: refresh THIS PR branch on a re-run; base/main are out of reach here.
  const pushRes = await g([...credArgs(token), 'push', 'origin', `+refs/heads/${branch}:refs/heads/${head}`], { token, timeout: 5 * 60 * 1000 });
  if (pushRes.status !== 0) {
    const err = (pushRes.err || '').trim();
    return { opened: false, reason: looksLikeAuthFailure(err)
      ? 'authentication failed — the connected GitHub token cannot write to this repo'
      : `could not push PR branch: ${err.slice(-300)}` };
  }

  const prTitle = String(title || '').trim() || `Zeehive: ${branch} → ${baseBranch}`;
  const r = await githubApi(slug, `/repos/${slug.owner}/${slug.repo}/pulls`, {
    token, method: 'POST',
    body: { title: prTitle, head, base: baseBranch, body: String(body || 'Opened from the Zeehive console.') },
  });
  if (!r.ok) {
    // a PR for this head↔base may already be open — surface that as success-ish, not an error.
    const already = r.status === 422 && /already exists|pull request already/i.test(r.error || '');
    if (already) {
      const ex = await githubApi(slug, `/repos/${slug.owner}/${slug.repo}/pulls?head=${slug.owner}:${head}&base=${baseBranch}&state=open`, { token });
      const url = ex.ok && Array.isArray(ex.body) && ex.body[0]?.html_url;
      if (url) return { opened: true, state: 'existing', url, head, base: baseBranch, number: ex.body[0].number };
    }
    return { opened: false, reason: r.status === 403
      ? 'the GitHub token cannot open pull requests here (needs "Pull requests: write")'
      : `could not open PR: ${r.error}`, head };
  }
  return { opened: true, state: 'opened', url: r.body?.html_url || null, number: r.body?.number || null, head, base: baseBranch };
}
