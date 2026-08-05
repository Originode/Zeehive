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

// A PAT push that adds or updates `.github/workflows/*` is REFUSED by GitHub unless the token
// carries the `workflow` scope — a Contents:write fine-grained token is NOT enough for a repo
// that has Actions workflows (this one does: `.github/workflows/publish-images.yml`). Git's raw
// sentence ("[remote rejected] … refusing to allow a Personal Access Token to create or update
// workflow … without `workflow` scope") is unhelpful, and worse, it CONTAINS the word "rejected",
// so it used to trip the divergence regex below and tell the human "pull or reconcile first" —
// the exact wrong instruction. Detect it before the divergence check and say what is actually
// fixable: the token's scope, not the branch's state.
const looksLikeWorkflowScope = (err) =>
  /(refusing to allow|create or update workflow|without `?workflow`? scope|workflow scope)/i.test(err || '');
const WORKFLOW_SCOPE_HINT = 'this repo has GitHub Actions workflow files, and the connected token lacks the `workflow` scope — GitHub refuses PAT pushes that touch .github/workflows/. Add the `workflow` scope to the token (Project setup → Tokens) and push again; no local changes are needed';

// ── REPOSITORY RULE VIOLATIONS (rulesets / branch protection) ─────────────────
// The third member of the family above, and the one that actually bit us (2026-08-04: "failed to
// do pull request … it says failed due to repository rule violations"). The credentials are fine,
// the branch is fine — GitHub's own RULES refuse the ref update, and it says so as:
//
//   remote: error: GH013: Repository rule violations found for refs/heads/zeehive/main.
//   remote: - Changes must be made through a pull request.
//    ! [remote rejected] main -> zeehive/main (push declined due to repository rule violations)
//
// Two things had to be fixed. (1) That text contains "rejected", so the divergence regex claimed it
// first and told the human "pull or reconcile first" — a fix for a problem they do not have, the
// exact trap the workflow-scope hint above was written for. (2) The PR path surfaced git's raw last
// 300 characters, which names the rule but never what to DO about it. So: classify the rejection
// FIRST, quote GitHub's own bullet lines back (they are the most accurate statement of the rule
// that exists), and add the one fix that rule actually has.
const looksLikeRuleViolation = (err) =>
  /GH0(?:06|09|13)\b|repository rule violations|push declined|protected branch (?:hook declined|update failed)|cannot update this protected ref|changes must be made through a pull request|push cannot contain secrets|GITHUB PUSH PROTECTION/i.test(err || '');

// Kind ← GitHub's wording, most specific first. `secrets` leads because a push-protection block
// prints a whole box of prose that also mentions branches; `pull-request-required` beats `force`
// because "changes must be made through a pull request" also fails the ref *update*, and the PR
// rule is the one the human has to change.
const RULE_KINDS = [
  { kind: 'secrets',              re: /push cannot contain secrets|GITHUB PUSH PROTECTION|secret scanning|GH009\b/i },
  { kind: 'pull-request-required', re: /changes must be made through a pull request|at least \d+ approving review|review is required|required pull request/i },
  { kind: 'signatures',           re: /signature|signed commits?/i },
  { kind: 'status-checks',        re: /required status check|status checks? (?:have )?(?:not|failed)/i },
  { kind: 'creations',            re: /cannot create ref|creations? (?:are|is) not allowed|creating (?:refs|branches) is not allowed|restrict(?:s|ed)? creations?/i },
  { kind: 'deletions',            re: /cannot delete|deletions? (?:are|is) not allowed/i },
  { kind: 'linear-history',       re: /linear history/i },
  { kind: 'branch-name',          re: /branch name|ref name (?:pattern|must)|does not match the (?:required )?pattern/i },
  { kind: 'file-path',            re: /file path|restricted path|path (?:is |are )?restricted/i },
  { kind: 'file-size',            re: /file size|exceeds .*size limit|GH001\b/i },
  { kind: 'commit-message',       re: /commit message/i },
  { kind: 'author-email',         re: /(?:author|committer) email/i },
  // the generic ref-update refusal — "Cannot update this protected ref" is what a
  // non_fast_forward / update rule prints, and it is the one the PR path can work around
  { kind: 'force',                re: /cannot update this protected ref|force push|non-fast-forward|update(?:s)? (?:are|is) not allowed/i },
];

// The ONE actionable sentence per rule kind. `context` is 'push' (local main → the remote branch)
// or 'pr' (the PR side branch), because the same rule has a different fix in each: a
// pull-request-required rule on the DEFAULT branch is what the PR button is for, while the same
// rule hitting the SIDE branch means the ruleset targets every branch and has to be narrowed.
function ruleFix(kind, { context = 'push', head = null, base = null, unblockUrl = null } = {}) {
  const forPr = context === 'pr';
  switch (kind) {
    case 'secrets':
      return 'GitHub secret-scanning PUSH PROTECTION blocked this — a secret was found in the commits being pushed (see the locations above). '
        + 'Nothing local is broken and nothing was published: rotate the secret, remove it from the commits (it must leave the HISTORY, not just the working tree), and push again'
        + (unblockUrl ? `, or allow this one at ${unblockUrl}` : ' — or allow that specific finding from the URL GitHub printed');
    case 'pull-request-required':
      return forPr
        ? `a repository RULESET requires a pull request on '${head || 'the side branch'}' too — the ruleset targets every branch, not just '${base || 'the default branch'}'. `
          + 'Narrow its target (e.g. to the default branch only), or add a bypass for the token\'s actor in Settings → Rules, then open the PR again'
        : 'a repository RULESET requires changes to go through a PULL REQUEST — a direct push to this branch can never succeed. Use ⇅ PR (push a side branch + open a pull request) instead';
    case 'signatures':
      return 'the ruleset requires VERIFIED (signed) commits, and Zeehive\'s commits are unsigned — configure commit signing on the queenzee, exempt its actor in the ruleset\'s bypass list, or turn that rule off for this branch';
    case 'status-checks':
      return 'the ruleset requires status checks to pass on the ref being updated — this is a merge-time rule and a direct push cannot satisfy it. Open a PR and let the checks run';
    case 'creations':
      return forPr
        ? `the ruleset RESTRICTS branch creation, so the side branch${head ? ` '${head}'` : ''} cannot be created — push to a head branch that already exists (name it in the PR dialog), or add a bypass for the token's actor`
        : 'the ruleset restricts branch creation on this remote — the branch has to exist already, or the token\'s actor needs a bypass';
    case 'deletions':
      return 'the ruleset restricts deletions on this ref — Zeehive never deletes remote refs, so this came from the remote side; check the ruleset in Settings → Rules';
    case 'linear-history':
      return 'the ruleset requires LINEAR history and these commits contain a merge — rebase before pushing, or open a PR and merge with squash/rebase';
    case 'branch-name':
      return `the head branch name does not satisfy the ruleset's naming rule — pick a name that does (the PR dialog lets you type one; the default is 'zeehive/<branch>-<sha>')`;
    case 'file-path':
      return 'the ruleset restricts the FILE PATHS a push may touch, and these commits touch a restricted one (the bullet above names it) — the rule has to be changed or bypassed; there is no local fix';
    case 'file-size':
      return 'a file in these commits exceeds the size the ruleset (or GitHub) allows — remove it from the history (git-lfs, or drop it) and push again';
    case 'commit-message':
      return 'the ruleset enforces a commit-message pattern and one of these commits does not match it — the messages are already history, so either amend/rebase them or bypass the rule';
    case 'author-email':
      return 'the ruleset restricts author/committer email addresses and these commits do not match — set the queenzee\'s git identity to an allowed address, or bypass the rule';
    case 'force':
      return forPr
        ? 'the ruleset refuses to UPDATE this ref (force pushes are blocked) — Zeehive retries a plain fast-forward push and then a fresh sha-suffixed head branch; both were refused, so pick a new head branch name in the PR dialog'
        : 'the ruleset refuses this ref update (force pushes / updates are blocked on this branch) — Zeehive never force-pushes, so this branch simply cannot be updated by a push; use ⇅ PR instead';
    default:
      return 'a repository RULESET refused this push — read the rule GitHub named above, then change it (or add a bypass for the token\'s actor) in the repo\'s Settings → Rules';
  }
}

// git stderr → {kind, bullets, ref, unblock_url, reason} for a rules refusal, or null when the
// failure is not one. The BULLETS are GitHub's own lines: they are quoted verbatim because they
// are the only place the actual rule is named, and a paraphrase would be one GitHub release out
// of date the moment a new rule type ships.
export function describeRuleViolation(err, { context = 'push', head = null, base = null } = {}) {
  const text = String(err || '');
  if (!looksLikeRuleViolation(text)) return null;

  const lines = text.split(/\r?\n/).map((l) => l.replace(/^remote:\s?/, '').replace(/\s+$/, ''));
  const bullets = [];
  const locations = [];
  for (const l of lines) {
    // push protection's "locations:" block names the FILE and COMMIT the secret is in — the single
    // most useful line in the whole message, and the first thing a 300-character tail threw away.
    const loc = /^\s*(?:[-•*]\s+)?path:\s*(\S+)\s*$/i.exec(l);
    if (loc && !locations.includes(loc[1])) { locations.push(loc[1]); continue; }
    const m = /^\s*[-•*]\s+(.+?)\s*$/.exec(l);
    if (!m) continue;
    // strip GitHub's box-drawing padding, and drop the rest of the "locations:" detail
    const b = m[1].replace(/[—–_-]{3,}\s*$/, '').trim();
    if (!b || /^(?:commit|path|locations?)\s*:/i.test(b)) continue;
    if (!bullets.includes(b)) bullets.push(b);
  }
  const ref = (/(?:rule violations found for|update failed for)\s+(refs\/\S+?)\.?\s*$/im.exec(text) || [])[1] || null;
  const unblockUrl = (/(https:\/\/\S*\/security\/secret-scanning\/unblock-secret\/\S+)/i.exec(text) || [])[1] || null;

  const haystack = `${bullets.join('\n')}\n${text}`;
  const kind = (RULE_KINDS.find((k) => k.re.test(haystack)) || {}).kind || 'rules';

  // The whole point of parsing rather than slicing: `err.slice(-300)` on a push-protection block
  // keeps the last line — "(push declined due to repository rule violations)" — and cuts off every
  // line that says WHICH rule and WHERE. That truncation is what the 2026-08-04 report was made of.
  // With no bullets at all we still refuse to lose the text: quote the tail rather than nothing.
  const named = bullets.length
    ? bullets.map((b) => `“${b}”`).join('; ')
    : (ref ? `a rule on ${ref} (GitHub said: ${text.trim().slice(-300)})` : `a repository rule (GitHub said: ${text.trim().slice(-300)})`);
  const where = locations.length ? ` Found in: ${locations.join(', ')}.` : '';
  return {
    kind,
    bullets,
    locations,
    ref,
    unblock_url: unblockUrl,
    reason: `GitHub refused this push by REPOSITORY RULE, not by credentials or divergence — ${named}.${where} ${ruleFix(kind, { context, head, base, unblockUrl })}`,
  };
}

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

  // dirty tree → refuse (same stance as pullFromXource: never merge over uncommitted work).
  // TRACKED changes only: a xource carries its xells' worktrees at .claude/worktrees/, which is
  // untracked and never goes away, so counting untracked files refused every pull on a project
  // that had ever been provisioned (seen live on OmniBiz: "1 uncommitted change(s)" forever).
  // Untracked files are not at risk here — a fast-forward cannot silently clobber one, and git
  // itself aborts the merge if it would need to write over an untracked path.
  const st = await g(['status', '--porcelain', '--untracked-files=no'], { timeout: 30000 });
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
// What RULES does the remote enforce on <branch>? A ruleset is INVISIBLE to git until a push is
// refused by it — `permissions` says the token may write, and then GH013 says the repository will
// not have it. `GET /repos/{o}/{r}/rules/branches/{branch}` lists every ACTIVE rule (repo AND org
// rulesets, plus classic protection surfaced as rules) that applies to a branch, so the console can
// say "direct push is blocked here, use PR" BEFORE a human clicks Push.
//
// Never throws and never fails a caller: a token that cannot read rules (or an older GitHub
// Enterprise without the endpoint) comes back {checked:false, reason} and every consumer degrades
// to exactly the old behaviour — the git-level classification above still catches the refusal.
export async function branchRules({ url, token, branch } = {}) {
  const slug = parseGitHubSlug(url);
  if (!slug) return { checked: false, rules: [], reason: 'remote is not a GitHub URL' };
  if (!branch) return { checked: false, rules: [], reason: 'a branch is required to read its rules' };
  const r = await githubApi(slug, `/repos/${slug.owner}/${slug.repo}/rules/branches/${encodeURIComponent(branch)}`, { token });
  if (!r.ok || !Array.isArray(r.body)) {
    return { checked: false, rules: [], branch, reason: r.error || `unexpected rules response (HTTP ${r.status})` };
  }
  const types = [...new Set(r.body.map((x) => x?.type).filter(Boolean))];
  const rulesets = [...new Set(r.body
    .map((x) => (x?.ruleset_id ? `${x.ruleset_source || 'ruleset'} #${x.ruleset_id}` : null))
    .filter(Boolean))];
  return {
    checked: true,
    branch,
    rules: types,
    rulesets,
    requires_pull_request: types.includes('pull_request'),
    blocks_creation: types.includes('creation'),
    blocks_update: types.includes('update'),
    blocks_force_push: types.includes('non_fast_forward'),
    requires_signatures: types.includes('required_signatures'),
    requires_linear_history: types.includes('required_linear_history'),
    requires_status_checks: types.includes('required_status_checks'),
    reason: null,
  };
}

// One sentence for "your Push will be refused before you click it", or null when nothing in the
// branch's rules stops a plain push. Kept next to branchRules so the console never has to know
// GitHub's rule-type spellings.
export function pushRuleBlock(rules, branch = 'the default branch') {
  if (!rules?.checked) return null;
  if (rules.requires_pull_request) {
    return `a repository RULESET requires changes to ${branch} to go through a PULL REQUEST — a direct Push will be refused by GitHub (GH013). Use ⇅ PR instead`;
  }
  if (rules.blocks_update) return `a repository RULESET blocks updates to ${branch} — a direct Push will be refused (GH013). Use ⇅ PR instead`;
  if (rules.requires_signatures) return `a repository RULESET requires signed commits on ${branch}, and Zeehive's commits are unsigned — a Push will be refused (GH013)`;
  return null;
}

export async function remoteAccess({ url, token, withRules = true } = {}) {
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
  const defaultBranch = r.body?.default_branch || null;

  // Rules are read only when a push is otherwise possible — a read-only token shows no outbound
  // buttons at all, so there is nothing for the warning to be about (and no reason to spend the
  // call). can_push stays TRUE: the token's permission is a fact, a ruleset is a separate one, and
  // a rule may still have a bypass for this actor that the endpoint cannot tell us about.
  let rules = null, push_rule_block = null;
  if (withRules && can_push && defaultBranch) {
    rules = await branchRules({ url, token, branch: defaultBranch });
    push_rule_block = pushRuleBlock(rules, defaultBranch);
  }

  return {
    provider: 'github',
    owner: slug.owner, repo: slug.repo,
    default_branch: defaultBranch,
    archived,
    can_push,
    rules,
    push_rule_block,
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
    // workflow-scope and RULE VIOLATIONS BEFORE the divergence check: both of git's rejection
    // sentences contain "rejected", which nonff would misread as a divergence — the wrong
    // instruction entirely (a ruleset refusal is not fixed by pulling, ever).
    const rules = looksLikeWorkflowScope(err) ? null : describeRuleViolation(err, { context: 'push', head: branch });
    return {
      pushed: false,
      state: looksLikeWorkflowScope(err) ? 'refused-workflow-scope'
        : rules ? 'refused-rules'
        : looksLikeAuthFailure(err) ? 'refused-auth'
        : nonff ? 'refused-diverged'
        : 'error',
      ...(rules ? { rule: rules.kind, rule_bullets: rules.bullets, ...(rules.locations.length ? { rule_locations: rules.locations } : {}), ...(rules.unblock_url ? { unblock_url: rules.unblock_url } : {}) } : {}),
      reason: looksLikeWorkflowScope(err) ? WORKFLOW_SCOPE_HINT
        : rules ? rules.reason
        : looksLikeAuthFailure(err)
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
//
// When a RULESET blocks the force update of the head ref, the refresh degrades instead of failing:
// plain fast-forward push → a fresh sha-suffixed head (a create). Every other rule violation is
// reported with the rule GitHub named and the one fix it has (describeRuleViolation), never as a
// divergence — the returned `head`/`tried` say which branch actually got pushed.
// SQUASHED SNAPSHOT — the head a PR gets when the blocked thing is in the INTERMEDIATE commits.
//
// Push protection (and file-size, and commit-message rules) scans every commit in the push RANGE,
// not the tip. That is the case we hit on 2026-08-04: an invented DeepSeek-shaped fixture was added
// and later removed, so `master`'s TREE is clean and its HISTORY is not — and sanitising the tip
// could not unblock the push. The remaining choices were a human clicking secret-scanning's unblock
// URL, or rewriting master. This is the third: build ONE commit whose tree is today's tree and whose
// parent is the REMOTE's base tip, and open the PR from that.
//
// It is not a bypass. It is GitHub's own remediation — "remove the secret from the commits" —
// performed on the commits being pushed: the squashed commit's content simply does not contain it.
// The final review diff is identical, because the tree is identical.
//
// Mechanically it is `git commit-tree`: no checkout, no branch move, no rewrite, nothing added to
// the object store but one dangling commit. The local repo is untouched, which is the whole point —
// the alternative on the table was rewriting the project's main branch.
async function squashedSnapshot(g, { branch, baseBranch, token, message }) {
  // the base commit must exist locally to be a parent — fetch it (never merged, never checked out)
  const fetched = await g([...credArgs(token), 'fetch', 'origin', baseBranch], { token, timeout: 5 * 60 * 1000 });
  if (fetched.status !== 0) {
    return { ok: false, reason: `could not fetch the base branch '${baseBranch}' to squash onto: ${(fetched.err || '').trim().slice(-200)}` };
  }
  const baseSha = (await g(['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}`], { timeout: 15000 }));
  if (baseSha.status !== 0) return { ok: false, reason: `the remote base '${baseBranch}' did not resolve after fetch` };
  const tree = await g(['rev-parse', `refs/heads/${branch}^{tree}`], { timeout: 15000 });
  if (tree.status !== 0) return { ok: false, reason: `could not read the tree of local '${branch}'` };

  const parent = baseSha.out.trim();
  // already identical? then there is nothing to open a PR for, and commit-tree would make an empty one
  const baseTree = await g(['rev-parse', `${parent}^{tree}`], { timeout: 15000 });
  if (baseTree.status === 0 && baseTree.out.trim() === tree.out.trim()) {
    return { ok: false, empty: true, reason: `local '${branch}' and origin/${baseBranch} already have the same content — nothing to open a PR for` };
  }

  // the repo's own identity first (the honest one); a checkout with none configured would fail
  // "unable to auto-detect email address", so fall back to a named Zeehive identity rather than
  // dying on a git-config detail nobody set on purpose
  const build = (idArgs) => g([...idArgs, 'commit-tree', tree.out.trim(), '-p', parent, '-m', message], { timeout: 30000 });
  let ct = await build([]);
  if (ct.status !== 0) ct = await build(['-c', 'user.name=Zeehive', '-c', 'user.email=zeehive@localhost']);
  if (ct.status !== 0) return { ok: false, reason: `could not build the squashed commit: ${(ct.err || '').trim().slice(-200)}` };
  return { ok: true, sha: ct.out.trim(), parent, tree: tree.out.trim() };
}

export async function openPullRequest({ repoRoot, remoteUrl, token, branch = 'main', headBranch, base, title, body, squash = false } = {}) {
  if (!repoRoot || !remoteUrl) return { opened: false, reason: 'repoRoot and remoteUrl are required' };
  if (!token) return { opened: false, reason: 'a GitHub token with write access is required to open a PR' };
  const slug = parseGitHubSlug(remoteUrl);
  if (!slug) return { opened: false, reason: 'remote is not a GitHub URL — PRs are GitHub-only' };
  const g = (args, opts = {}) => gitNet(['-C', repoRoot, ...args], opts);

  const local = await g(['rev-parse', '--verify', `refs/heads/${branch}`], { timeout: 15000 });
  if (local.status !== 0) return { opened: false, reason: `local branch '${branch}' does not exist in the checkout` };
  const sha = local.out.trim();

  // default base = the remote's default branch (from the access probe); default head name carries
  // the short sha so repeat opens are idempotent-ish and collisions are unlikely. withRules:false —
  // the rules probe is for the console's PRE-flight warning, and a PR open learns what it needs
  // from the refusal itself (below), so it must not pay for a second API call here.
  const access = await remoteAccess({ url: remoteUrl, token, withRules: false });
  const baseBranch = String(base || '').trim() || access.default_branch || branch;
  const wanted = String(headBranch || '').trim()
    || (squash ? `zeehive/${branch}-squash-${sha.slice(0, 8)}` : `zeehive/${branch}-${sha.slice(0, 8)}`);
  if (wanted === baseBranch) return { opened: false, reason: `head branch '${wanted}' equals base '${baseBranch}' — pick a different branch name` };

  const cur0 = await g(['remote', 'get-url', 'origin'], { timeout: 15000 });
  if (cur0.status !== 0) await g(['remote', 'add', 'origin', remoteUrl], { timeout: 15000 });
  else if (cur0.out.trim() !== remoteUrl) await g(['remote', 'set-url', 'origin', remoteUrl], { timeout: 15000 });

  // What the head branch is built FROM: local <branch> normally, or a one-commit SQUASHED SNAPSHOT
  // of its tree on top of the remote base (see squashedSnapshot — the answer to a rule that scans
  // the commits rather than the ref). Local refs are untouched either way.
  const prTitleEarly = String(title || '').trim() || `Zeehive: ${branch} → ${baseBranch}`;
  let squashed = null;
  if (squash) {
    squashed = await squashedSnapshot(g, { branch, baseBranch, token, message: prTitleEarly });
    if (!squashed.ok) return { opened: false, squashed: false, reason: squashed.reason, ...(squashed.empty ? { state: 'up-to-date' } : {}) };
  }
  const source = squashed ? squashed.sha : `refs/heads/${branch}`;

  // + on the head ref only: refresh THIS PR branch on a re-run; base/main are out of reach here.
  const pushHead = (name, { force }) =>
    g([...credArgs(token), 'push', 'origin', `${force ? '+' : ''}${source}:refs/heads/${name}`],
      { token, timeout: 5 * 60 * 1000 });

  // A ruleset that blocks force pushes / ref updates ("Cannot update this protected ref") kills the
  // refresh-in-place `+`, which is a convenience, not the point of the button. So when — and ONLY
  // when — the refusal is that rule, fall back the safe way: the same head as a plain
  // fast-forward-only push (a brand-new branch, or a head we are simply ahead of), and then a fresh
  // sha-suffixed head, which is a CREATE and cannot rewrite anything. Never a force retry, never a
  // touch of base/main, and the sha suffix keeps a re-run of the same commit landing on one branch.
  let head = wanted;
  let pushRes = await pushHead(head, { force: true });
  const tried = [head];
  if (pushRes.status !== 0) {
    const first = (pushRes.err || '').trim();
    const v = looksLikeWorkflowScope(first) || looksLikeAuthFailure(first)
      ? null : describeRuleViolation(first, { context: 'pr', head, base: baseBranch });
    if (v && v.kind === 'force') {
      const plain = await pushHead(head, { force: false });
      if (plain.status === 0) pushRes = plain;
      else {
        const alt = `${head}-${sha.slice(0, 8)}`;
        if (!tried.includes(alt)) {
          tried.push(alt);
          const fresh = await pushHead(alt, { force: false });
          if (fresh.status === 0) { pushRes = fresh; head = alt; }
        }
      }
    }
  }

  if (pushRes.status !== 0) {
    const err = (pushRes.err || '').trim();
    const rules = looksLikeWorkflowScope(err) ? null : describeRuleViolation(err, { context: 'pr', head, base: baseBranch });
    return {
      opened: false,
      head, tried,
      ...(rules ? { state: 'refused-rules', rule: rules.kind, rule_bullets: rules.bullets, ...(rules.locations.length ? { rule_locations: rules.locations } : {}), ...(rules.unblock_url ? { unblock_url: rules.unblock_url } : {}) } : {}),
      reason: looksLikeWorkflowScope(err)
        ? WORKFLOW_SCOPE_HINT
        : rules
          ? `${rules.reason}${tried.length > 1 ? ` (tried head branches: ${tried.join(', ')})` : ''}`
          : looksLikeAuthFailure(err)
            ? 'authentication failed — the connected GitHub token cannot write to this repo'
            : `could not push PR branch: ${err.slice(-300)}`,
    };
  }

  // what the PR reports about ITS OWN shape: a squashed head is a different object from local
  // <branch>, and a reviewer reading 'opened from master' must not be told that when the commit
  // they will see is a snapshot built on the base tip.
  const squashInfo = squashed
    ? { squashed: true, squash_sha: squashed.sha, squash_parent: squashed.parent }
    : { squashed: false };
  const prTitle = prTitleEarly;
  const r = await githubApi(slug, `/repos/${slug.owner}/${slug.repo}/pulls`, {
    token, method: 'POST',
    body: {
      title: prTitle, head, base: baseBranch,
      // A squashed head must SAY it is one, in the PR itself. The review diff is identical to the
      // branch's, but the commit list is not, and a reviewer who assumes they are seeing every
      // commit is being misled by omission.
      body: String(body || 'Opened from the Zeehive console.')
        + (squashed
          ? `\n\n_Squashed snapshot: one commit carrying the current tree of \`${branch}\`, on top of \`${baseBranch}\` (${squashed.parent.slice(0, 8)}). `
            + 'The diff is identical to the branch; the intermediate commits are not included. '
            + 'Zeehive opens a PR this way when a repository rule scans the commits rather than the ref (e.g. secret-scanning push protection over a string that was added and later removed)._'
          : ''),
    },
  });
  if (!r.ok) {
    // a PR for this head↔base may already be open — surface that as success-ish, not an error.
    const already = r.status === 422 && /already exists|pull request already/i.test(r.error || '');
    if (already) {
      const ex = await githubApi(slug, `/repos/${slug.owner}/${slug.repo}/pulls?head=${slug.owner}:${head}&base=${baseBranch}&state=open`, { token });
      const url = ex.ok && Array.isArray(ex.body) && ex.body[0]?.html_url;
      if (url) return { opened: true, state: 'existing', url, head, tried, base: baseBranch, number: ex.body[0].number, ...squashInfo };
    }
    return { opened: false, reason: r.status === 403
      ? 'the GitHub token cannot open pull requests here (needs "Pull requests: write")'
      : `could not open PR: ${r.error}`, head };
  }
  return { opened: true, state: 'opened', url: r.body?.html_url || null, number: r.body?.number || null, head, tried, base: baseBranch, ...squashInfo };
}

// MERGE a pull request on the remote (GitHub REST `PUT /pulls/{number}/merge`). Human-gated, exactly
// like open — a read-only PAT (or branch protection the token can't satisfy) is refused LOUDLY as
// {merged:false, reason}, never forced. `method` is GitHub's merge strategy: 'merge' (default),
// 'squash' or 'rebase'. A PR that isn't mergeable yet (GitHub still computing, or a conflict) comes
// back 405 → {state:'not-mergeable'}; a head that moved since we read it comes back 409 →
// {state:'conflict'}. Nothing here touches the local checkout — the merge happens entirely on GitHub.
export async function mergePullRequest({ remoteUrl, token, number, method = 'merge', title, message } = {}) {
  if (!remoteUrl || !number) return { merged: false, state: 'error', reason: 'remoteUrl and a PR number are required to merge' };
  if (!token) return { merged: false, state: 'error', reason: 'a GitHub token with write access is required to merge' };
  const slug = parseGitHubSlug(remoteUrl);
  if (!slug) return { merged: false, state: 'error', reason: 'remote is not a GitHub URL — PRs are GitHub-only' };
  const merge_method = new Set(['merge', 'squash', 'rebase']).has(method) ? method : 'merge';

  const r = await githubApi(slug, `/repos/${slug.owner}/${slug.repo}/pulls/${number}/merge`, {
    token, method: 'PUT',
    body: {
      merge_method,
      ...(title ? { commit_title: String(title) } : {}),
      ...(message ? { commit_message: String(message) } : {}),
    },
  });
  if (!r.ok) {
    // 405 = "not mergeable" (conflict / checks / mergeability still computing); 409 = head moved.
    const state = r.status === 405 ? 'not-mergeable' : r.status === 409 ? 'conflict' : r.status === 403 ? 'refused' : 'error';
    return {
      merged: false, number, state,
      reason: state === 'not-mergeable' ? `pull request #${number} is not mergeable yet: ${r.error}`
        : state === 'conflict' ? `PR #${number} head moved since it was read — re-open and retry: ${r.error}`
        : state === 'refused' ? 'the GitHub token cannot merge here (needs write access; branch protection may require a review/checks)'
        : `could not merge PR #${number}: ${r.error}`,
    };
  }
  // GitHub returns {merged:true, sha, message} on success.
  return { merged: !!r.body?.merged, number, state: 'merged', sha: r.body?.sha || null, method: merge_method };
}
