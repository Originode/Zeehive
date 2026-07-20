// The CXELL driver: everything the queenzee does to run a zee's claude CLI INSIDE a per-xell
// zee-agent container (image docker/zeehive/Dockerfile.zee-agent) instead of on the host.
//
// Why: host-side confinement is prompt + regex (hooks/prod-guard.mjs admits it is not
// adversary-proof). The cxell makes it structural — the container sees a private clone of the
// xell's branch, a default-DROP firewall allowing only api.anthropic.com, the queenzee API,
// and its OWN stack's host:port pairs (proven 2026-07-19: without the firewall, Docker's
// bridge NAT reaches the prod db on the LAN). No docker socket, no host mounts, non-root.
//
// The clone is a git BUNDLE of the worktree's HEAD — a private object store, deliberately not
// a mount: worktree .git files carry absolute host paths that don't resolve in Linux, and a
// shared object store would leak the xource into the cxell. The worktree's generated
// .zeehive.env (gitignored, so absent from the bundle) is copied in separately — it carries
// the xell's ports and DATABASE_URL. Pasted prompt-attachments (also gitignored) are copied in
// the same way, so a prompt that hands the zee an image path can actually Read it. Work products
// stay in the container until collected (exportCxellDiff) — landing them is the human-gated step.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { logline } from './logbus.js';
import { config } from '../config.js';

// CXELL_IMAGE override: a bootstrap install (published images, no local build) points this at
// ghcr — matching the CXELL_IMAGE the self-ship scripts already honor for their rebuild.
const IMAGE = process.env.CXELL_IMAGE || 'zeehive/zee-agent';
export const cxellName = (slug) => `cxell_${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;

// ── SSH attend: a human reaches a cxell zee's interactive claude over SSH (the dashboard's
// ssh2→xterm terminal AND Claude Code desktop's "Add SSH host" are the same door). Inbound, so
// the egress firewall neither blocks it nor is loosened. ────────────────────────────────────

// The Zeehive keypair, one for the whole fleet, kept OUTSIDE the repo (never git). The private
// key stays here on the queenzee's host; the public key is authorized inside every cxell.
const SSH_DIR = process.env.ZEEHIVE_SSH_DIR || resolve(homedir(), '.zeehive', 'ssh');
const PRIV = join(SSH_DIR, 'cxell_id_ed25519');
const PUB = join(SSH_DIR, 'cxell_id_ed25519.pub');

export function ensureZeehiveKeypair() {
  if (existsSync(PRIV) && existsSync(PUB)) {
    return { privateKeyPath: PRIV, privateKey: readFileSync(PRIV), publicKey: readFileSync(PUB, 'utf8').trim() };
  }
  mkdirSync(SSH_DIR, { recursive: true });
  const { utils } = createRequire(import.meta.url)('ssh2');
  const kp = utils.generateKeyPairSync('ed25519', { comment: 'zeehive-cxell' });
  writeFileSync(PRIV, kp.private, { mode: 0o600 });
  writeFileSync(PUB, kp.public + '\n');
  logline('cxell', `generated the Zeehive cxell keypair at ${SSH_DIR}`);
  return { privateKeyPath: PRIV, privateKey: Buffer.from(kp.private), publicKey: kp.public.trim() };
}

// Where the QUEENZEE reaches a cxell's sshd. Host mode (default): the published 127.0.0.1 port —
// the queenzee IS the docker host. Network mode (ZEEHIVE_CXELL_SSH=network, the containerized
// queenzee): by container name on 22 over zee-hive-net — a container cannot see the host's
// loopback (seen live 2026-07-20: in-container nudge reported sent, then died in the
// fire-and-forget SSH). The human's 127.0.0.1 viewer door is unaffected either way.
export function cxellSshDest({ slug, sshPort }) {
  return process.env.ZEEHIVE_CXELL_SSH === 'network' && slug
    ? { host: cxellName(slug), port: 22 }
    : { host: '127.0.0.1', port: Number(sshPort) };
}

// Per-cxell host SSH port, bound to 127.0.0.1. A pure function of the slug so it survives a
// queenzee restart without being stored; ensureCxell scans upward on a collision.
export function cxellSshPort(slug) {
  let h = 0;
  for (const c of String(slug)) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return 22000 + (h % 2000);
}

// docker CLI runner. `--context` (not env) so a queenzee env leak can never re-aim a cxell;
// input is piped to stdin; onLine streams stdout lines (for the NDJSON event stream).
function dk(ctx, args, { input, onLine, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const full = [...(ctx && ctx !== 'default' ? ['--context', ctx] : []), ...args];
    const p = spawn('docker', full, { windowsHide: true });
    let out = '', err = '', buf = '';
    const t = timeoutMs ? setTimeout(() => { p.kill(); reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`)); }, timeoutMs) : null;
    p.stdout.on('data', (d) => {
      const s = d.toString();
      if (!onLine) { out += s; return; }
      buf += s;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) onLine(line); }
    });
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => { if (t) clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      if (t) clearTimeout(t);
      if (onLine && buf.trim()) onLine(buf);
      if (code === 0) resolve({ code, out, err });
      else reject(new Error(`docker ${args.slice(0, 2).join(' ')} exited ${code}: ${(err || out).slice(0, 400)}`));
    });
    if (input !== undefined) { p.stdin.write(input); }
    p.stdin.end();
  });
}

// Is a cxell zee ACTUALLY working right now? True iff a `claude` process is alive inside its cxell.
// This is the honest liveness signal the monitor needs: it catches both the headless run AND an
// interactive terminal session a human drives over SSH — the latter is a claude the queenzee never
// spawned, so its own process handle can't see it (that's why a busy cxell zee read 'idle'). pgrep
// exits 1 (→ dk rejects) when nothing matches, and a stopped/absent container rejects too; either
// way there is no live agent, so → false. Short timeout: this runs every monitor tick.
export async function cxellZeeActive({ ctx = 'default', slug }) {
  try {
    await dk(ctx, ['exec', cxellName(slug), 'pgrep', '-f', 'claude'], { timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
}

// The live diff of a CXELLD zee's work — read from INSIDE the cxell, where the work actually lives.
// A cxell zee commits and edits in its private clone at /work/repo; the HOST worktree stays frozen
// at the provisioning base until `zee land` collects the commits (collectCxellDiffToWorktree). So a
// host-side `git diff` (worktreeDiff) reads 0/0 for a zee that is BUSY producing work — which is
// exactly why the dashboard's diff hexagon showed 0/0 for every working cxell zee. Read the numbers
// from the cxell instead.
//
// The cxell clone is a bundle of the branch only: it carries the branch history (including `base`,
// the provisioning commit) but NOT the source ref (`master` isn't there). So "what would land" is
// measured against `base` — everything the zee added since it was spun up, committed OR not (a plain
// `git diff <base>` spans working tree vs base, so uncommitted work counts too). `behind` (how far
// the source moved since the fork) isn't knowable in the cxell; the caller fills it in from the host.
//
// One docker exec runs every git query and prints five newline-separated fields (echo "$(...)" keeps
// an empty shortstat as a blank line, so the field positions never shift). Returns null if the cxell
// is unreachable or `base` is unknown, so the caller can fall back to the host worktree.
export async function cxellDiff({ ctx = 'default', slug, base }) {
  if (!base) return null;
  const b = String(base).replace(/[^0-9a-fA-F]/g, '');
  if (!b) return null;
  const script = [
    'cd /work/repo || exit 3',
    'echo "$(git rev-parse HEAD 2>/dev/null)"',
    `echo "$(git rev-list --count ${b}..HEAD 2>/dev/null)"`,
    `echo "$(git diff --shortstat ${b} 2>/dev/null)"`,
    'echo "$(git diff --shortstat HEAD 2>/dev/null)"',
    'echo "$(git status --porcelain 2>/dev/null | wc -l)"',
  ].join('\n');
  let out;
  try {
    const r = await dk(ctx, ['exec', cxellName(slug), 'bash', '-lc', script], { timeoutMs: 8000 });
    out = r.out;
  } catch {
    return null;
  }
  const [head, ahead, src, own, dirty] = String(out).split('\n');
  const num = (s, re) => +((s || '').match(re)?.[1] || 0);
  return {
    head: head?.trim() || null,
    ahead: +String(ahead || '').trim() || 0,
    files: num(src, /(\d+) files? changed/),
    insertions: num(src, /(\d+) insertions?/),
    deletions: num(src, /(\d+) deletions?/),
    dirty: +String(dirty || '').trim() || 0,
    own: {
      files: num(own, /(\d+) files? changed/),
      insertions: num(own, /(\d+) insertions?/),
      deletions: num(own, /(\d+) deletions?/),
    },
  };
}

// Create (or recreate) the xell's cxell container on its own bridge network. Labeled so
// dockerPs-based monitors can attribute it; NET_ADMIN only for the firewall seal. Publishes an
// SSH port on 127.0.0.1 (the attend door — host-only; the queenzee's ssh2 bridge and a
// same-machine Claude Code desktop both reach it, nothing on the LAN does). Returns the port
// actually bound, scanning upward if the slug-derived one is taken.
export async function ensureCxell({ ctx, slug, xellId, network, sshPort }) {
  const name = cxellName(slug);
  const net = network || 'zee-hive-net';
  await dk(ctx, ['network', 'create', '--label', 'zeehive.cxell=net', net]).catch((e) => {
    if (!/already exists/i.test(e.message)) throw e;
  });
  await dk(ctx, ['rm', '-f', name]).catch(() => {}); // stale cxell from a prior run
  let port = sshPort || cxellSshPort(slug);
  for (let attempt = 0; attempt < 12; attempt++, port++) {
    try {
      await dk(ctx, ['run', '-d', '--name', name, '--network', net, '--cap-add', 'NET_ADMIN',
        '-p', `127.0.0.1:${port}:22`,
        '--label', 'zeehive.cxell=1', '--label', `zeehive.xell=${xellId || ''}`, IMAGE]);
      return { name, sshPort: port };
    } catch (e) {
      if (/port is already allocated|address already in use|bind/i.test(e.message)) {
        await dk(ctx, ['rm', '-f', name]).catch(() => {}); // the failed create left a husk
        continue; // next port
      }
      throw e;
    }
  }
  throw new Error(`could not bind an SSH port for cxell ${name} (all candidates in use)`);
}

// Open the cxell's SSH door: install the Zeehive public key for `zee`, drop the Claude token into
// /etc/environment so an interactive (PAM) login shell comes up authenticated — a docker-exec -e
// run gets the token directly, an SSH login does not — and start sshd. Root exec; the zee cannot
// undo it. Idempotent.
export async function openCxellSsh({ ctx, name, publicKey, token, xellToken, baseUrl = null }) {
  const env = [];
  if (publicKey) env.push('-e', `CXELL_PUBKEY=${publicKey}`);
  // /etc/environment lines a PAM (SSH) login inherits — the Claude token so interactive `claude`
  // comes up authenticated, AND the per-xell identity token so an attending human's `zee` CLI (and
  // any command in the login shell) can reach the queenzee's /api/xell/self/* verbs. A docker-exec
  // -e run gets these directly; an SSH login does not, so they must land in /etc/environment too.
  const envLines = [];
  if (token) envLines.push(`ANTHROPIC_AUTH_TOKEN=${token}`);
  // anthropic-compatible vendors (Kimi): the interactive claude in the cxell aims at the same
  // base URL the headless run used, so an attending human continues on the SAME provider
  if (baseUrl) envLines.push(`ANTHROPIC_BASE_URL=${baseUrl}`);
  if (xellToken) envLines.push(`ZEEHIVE_XELL_TOKEN=${xellToken}`);
  // Where the `zee` CLI finds the queenzee. Explicit (not the CLI's baked default) so a
  // containerized queenzee can re-aim every cxell by config alone (CXELL_API_BASE).
  envLines.push(`ZEEHIVE_API=${config.cxellApiBase}`);
  if (envLines.length) env.push('-e', `CXELL_ENV=${envLines.join('\n')}`);
  const r = await dk(ctx, ['exec', '-u', '0', ...env, name, 'bash', '/usr/local/bin/cxell-sshd.sh']);
  return r.out.trim();
}

// Bundle the worktree's HEAD (its spinoff branch) into the cxell as a private clone at
// /work/repo, then copy in the gitignored .zeehive.env projection (ports + DATABASE_URL).
export async function cloneIntoCxell({ ctx, name, worktree }) {
  const tmp = mkdtempSync(join(tmpdir(), 'zee-cxell-'));
  const bundle = join(tmp, 'task.bundle');
  const git = (args) => new Promise((resolve, reject) => {
    const g = spawn('git', ['-C', worktree, ...args], { windowsHide: true });
    let out = '', err = '';
    g.stdout.on('data', (d) => (out += d.toString()));
    g.stderr.on('data', (d) => (err += d.toString()));
    g.on('error', reject);
    g.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`git ${args[0]} exited ${c}: ${err.slice(0, 300)}`))));
  });
  try {
    // Bundle the worktree's BRANCH, not bare HEAD — a HEAD-only bundle clones detached (and
    // git clone exits non-zero on it), and the zee needs a real branch to commit on anyway.
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD') throw new Error(`worktree ${worktree} is on a detached HEAD — nothing to cxell`);
    await git(['bundle', 'create', bundle, branch]);
    await dk(ctx, ['cp', bundle, `${name}:/tmp/task.bundle`]);
    await dk(ctx, ['exec', name, 'bash', '-lc',
      `rm -rf /work/repo && git clone -q -b '${branch.replace(/'/g, '')}' /tmp/task.bundle /work/repo`]);
    await dk(ctx, ['exec', '-u', '0', name, 'rm', '-f', '/tmp/task.bundle']); // docker cp wrote it as root
    const envFile = join(worktree, '.zeehive.env');
    if (existsSync(envFile)) {
      await dk(ctx, ['cp', envFile, `${name}:/tmp/.zeehive.env`]);
      await dk(ctx, ['exec', '-u', '0', name, 'bash', '-lc',
        'mv /tmp/.zeehive.env /work/repo/.zeehive.env && chown zee:zee /work/repo/.zeehive.env']);
    }
    // Pasted prompt-attachments (screenshots the human dropped into the dispatch) live under
    // .zeehive/prompt-attachments/ on the worktree with a `*` .gitignore — so, exactly like
    // .zeehive.env, they are absent from the HEAD bundle and must be copied in separately, or the
    // zee's prompt hands it a path (`.zeehive/prompt-attachments/…`) that resolves to nothing in
    // the cxell. Copy the whole dir (docker cp creates the dest from the source's contents) and
    // hand it to `zee`.
    const attachDir = join(worktree, '.zeehive', 'prompt-attachments');
    if (existsSync(attachDir)) {
      // Best-effort, unlike .zeehive.env: a screenshot that fails to copy must not sink the whole
      // cxell spawn (the zee can still work without it) — same stance as saveDispatchImages.
      try {
        await dk(ctx, ['cp', attachDir, `${name}:/tmp/prompt-attachments`]);
        await dk(ctx, ['exec', '-u', '0', name, 'bash', '-lc',
          'mkdir -p /work/repo/.zeehive && rm -rf /work/repo/.zeehive/prompt-attachments '
          + '&& mv /tmp/prompt-attachments /work/repo/.zeehive/prompt-attachments '
          + '&& chown -R zee:zee /work/repo/.zeehive/prompt-attachments']);
      } catch (e) { logline('cxell', `${name}: could not copy prompt-attachments into cxell: ${e.message}`); }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Apply the cxell egress policy (docker/zeehive/cxell-firewall.sh): default ALLOW, DROP only the
// prod DB host:port pairs in blockTcp. The container is the real confinement boundary; this just
// keeps the one thing that matters — the live production database — off-limits (unless the xell
// is prod-bound, in which case the caller leaves its prod DB out of blockTcp). Root exec; the
// zee runs as `zee` and cannot undo it.
export async function sealCxell({ ctx, name, blockTcp = [] }) {
  const env = blockTcp.length ? ['-e', `CXELL_BLOCK_TCP=${blockTcp.join(' ')}`] : [];
  const r = await dk(ctx, ['exec', '-u', '0', ...env, name, 'bash', '/usr/local/bin/cxell-firewall.sh']);
  return r.out.trim().split('\n');
}

// Provision the boring slow stuff so a FRESH zee starts working immediately instead of burning
// its turn (and your allowance) on `npm ci`: install deps + prebuild the web bundle. The queenzee
// drives it over docker exec, so it costs zero agent tokens. Runs with egress fully open (before
// the prod-db block is applied). Best-effort: a slow/failed warm must NOT fail the dispatch — the
// zee can still install what it needs.
export async function warmCxell({ ctx, name }) {
  try {
    const r = await dk(ctx, ['exec', name, 'bash', '-lc',
      'cd /work/repo && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) '
      + '&& (npm run build --workspace web >/dev/null 2>&1 || true) && echo WARM_OK'],
      { timeoutMs: 900000 });
    return { warmed: /WARM_OK/.test(r.out) };
  } catch (e) {
    logline('cxell', `${name}: warm (npm/build) incomplete — the zee will install as needed: ${String(e.message).slice(0, 160)}`);
    return { warmed: false, error: e.message };
  }
}

// Run the zee: `claude -p` inside the cxell, stream-json events out. Returns { proc, done }
// where done resolves with the final `result` event (or rejects on a transport failure).
// onEvent(obj) fires per parsed NDJSON event — init (session id), assistant turns, result.
//
// --bare: nothing host-side (plugins/MCP/hooks/skills) leaks into the cxell, and auth comes
// from CLAUDE_CODE_OAUTH_TOKEN alone (tokenForSpawn — the project's connected token).
// --dangerously-skip-permissions: safe HERE and only here — the cxell is the permission
// system, and the CLI requires non-root, which the image guarantees.
export function runZee({ ctx, name, prompt, model, token, xellToken, baseUrl = null, onEvent }) {
  // BOTH env names, measured on claude 2.1.214 (2026-07-19): --bare skips the OAuth credential
  // chain entirely — CLAUDE_CODE_OAUTH_TOKEN alone yields "Not logged in" without one API call —
  // but honors ANTHROPIC_AUTH_TOKEN (the raw bearer header, which an sk-ant-oat01 token is).
  // Keep the OAuth var too so a future CLI that prefers it keeps working.
  const cmd = ['exec', '-i',
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '-e', `ANTHROPIC_AUTH_TOKEN=${token}`,
    // The per-xell identity token: the cxell zee's `zee` CLI (and any /api/xell/self/* call) reads
    // it to prove WHICH xell is calling. Injected alongside the Claude token — same door, and the
    // firewall already allows the queenzee host:port.
    ...(xellToken ? ['-e', `ZEEHIVE_XELL_TOKEN=${xellToken}`] : []),
    ...(baseUrl ? ['-e', `ANTHROPIC_BASE_URL=${baseUrl}`] : []),   // Kimi et al: same CLI, different vendor
    '-e', `ZEEHIVE_API=${config.cxellApiBase}`,   // same reason as openCxellSsh's CXELL_ENV line
    name, 'bash', '-lc',
    `cd /work/repo && claude --bare -p --output-format stream-json --verbose --dangerously-skip-permissions${model ? ` --model ${model}` : ''}`];
  const full = [...(ctx && ctx !== 'default' ? ['--context', ctx] : []), ...cmd];
  const p = spawn('docker', full, { windowsHide: true });
  let buf = '', err = '', result = null;
  const feed = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; } // non-JSON noise (e.g. a bash warning)
    if (ev?.type === 'result') result = ev;
    try { onEvent?.(ev); } catch (e) { logline('cxell', `onEvent threw: ${e.message}`); }
  };
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  });
  p.stderr.on('data', (d) => (err += d.toString()));
  const done = new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => {
      if (buf.trim()) feed(buf);
      if (result) resolve({ code, result });
      else reject(new Error(`cxell claude exited ${code} with no result event: ${err.slice(0, 400)}`));
    });
  });
  p.stdin.write(prompt);
  p.stdin.end();
  return { proc: p, done };
}

// Collect the zee's work as a bundle of commits made inside the cxell (HEAD relative to the
// clone point). The caller lands it on the worktree via `git pull <bundle>` — through the
// same human-gated landing flow as any zee push. Returns null when the cxell made no commits.
export async function exportCxellDiff({ ctx, name, toDir }) {
  const probe = await dk(ctx, ['exec', name, 'bash', '-lc',
    'cd /work/repo && git rev-list origin/HEAD..HEAD --count 2>/dev/null || git rev-list HEAD --not --remotes --count']);
  if (Number(probe.out.trim()) === 0) return null;
  await dk(ctx, ['exec', name, 'bash', '-lc',
    'cd /work/repo && git bundle create /tmp/out.bundle $(git symbolic-ref --short HEAD) --not --remotes']);
  const out = join(toDir, `${name}-out.bundle`);
  await dk(ctx, ['cp', `${name}:/tmp/out.bundle`, out]);
  return out;
}

// COLLECT the cxell's commits onto its HOST worktree so they can be landed through the normal gate.
// This is the missing piece for a cxell zee: its work is committed INSIDE the container, but the
// land gate pushes from the host worktree. exportCxellDiff bundles the cxell's branch (commits not in
// remotes); we fetch that bundle into the worktree and fast-forward the checked-out branch to the
// cxell's HEAD. The push that follows (pushToXource) is what actually trips the land gate — this only
// moves the commits from inside the cxell to the worktree they will be pushed from.
//
// Best-effort by contract: a cxell with no new commits (already collected, or none made) is a no-op,
// not an error. A worktree that has DIVERGED from the cxell (someone moved it) refuses rather than
// force — the caller surfaces that to the zee.
export async function collectCxellDiffToWorktree({ ctx = 'default', slug, worktree }) {
  if (!worktree || !existsSync(worktree)) {
    return { collected: false, reason: `no host worktree on disk (${worktree || 'null'})` };
  }
  const name = cxellName(slug);
  const tmp = mkdtempSync(join(tmpdir(), 'zee-land-'));
  const git = (args) => new Promise((resolve, reject) => {
    const g = spawn('git', ['-C', worktree, ...args], { windowsHide: true });
    let out = '', err = '';
    g.stdout.on('data', (d) => (out += d.toString()));
    g.stderr.on('data', (d) => (err += d.toString()));
    g.on('error', reject);
    g.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`git ${args[0]} exited ${c}: ${err.slice(0, 300)}`))));
  });
  try {
    const bundle = await exportCxellDiff({ ctx, name, toDir: tmp });
    if (!bundle) return { collected: false, reason: 'the cxell has no commits beyond the worktree' };
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    // Fetch the cxell branch into a private staging ref (never the checked-out branch directly), then
    // fast-forward the worktree branch to it. --ff-only is the honesty guard: if the worktree moved
    // since caging, we refuse instead of fabricating a merge nobody asked for.
    await git(['fetch', bundle, `${branch}:refs/zeehive/cxell-land`]);
    const target = await git(['rev-parse', 'refs/zeehive/cxell-land']);
    // Clear host-worktree noise the cxell zee cannot reach so the --ff-only below is not blocked
    // with "refuses to touch <file>". On a Windows checkout mcp/server.js recurs dirty two ways: an
    // exec-bit flip (644↔755) and CRLF↔LF normalization (git status flags it "modified" with an
    // EMPTY content diff). Ignoring file-mode kills the first; the second only clears with a stash.
    // So do both: ignore mode, then park any remaining dirt in a labelled stash — a cxell zee's work
    // is its COMMITS from the cxell, so nothing UNCOMMITTED in the host worktree is ever its to lose.
    // Both are safe and self-healing — the whole point is that `zee land` never needs a human.
    await git(['config', 'core.fileMode', 'false']).catch(() => {});
    const dirty = await git(['status', '--porcelain']).catch(() => '');
    if (dirty.trim()) {
      await git(['stash', 'push', '--include-untracked', '-m',
        'zee-land: stray host-worktree changes parked before collect']).catch(() => {});
    }
    let ff;
    try { await git(['merge', '--ff-only', target]); ff = true; }
    catch (e) { ff = false; await git(['update-ref', '-d', 'refs/zeehive/cxell-land']).catch(() => {});
      throw new Error(`the cxell's commits do not fast-forward the worktree branch — it moved since caging (${e.message})`); }
    await git(['update-ref', '-d', 'refs/zeehive/cxell-land']).catch(() => {});
    const head = await git(['rev-parse', 'HEAD']);
    return { collected: ff, head, branch };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// NUDGE a cxell zee: RESUME its claude session inside the cxell so its workflow continues with no
// human re-invocation. A headless cxell zee's turn ENDS at `zee land`; nothing tells it the human
// later approved. So when a landing raised by a cxell zee lands, the queenzee re-invokes the
// session — `docker exec <cxell> claude --bare --resume <sid> -p` — with a short prompt. The prompt
// rides in on stdin (no shell-quoting of model text); the session id is sanitised to a uuid because
// it is interpolated into the command.
//
// Tokens: prefer the ones the cxell was SPAWNED with, read back from /etc/environment, so we do NOT
// invalidate a token a `zee … --wait` poll is still holding (re-minting would 401 that poll right
// as it should report success). Fall back to whatever the caller passes. Best-effort: a torn-down
// or unreachable cxell rejects, and the caller just logs it.
export async function nudgeCxellZee({ ctx = 'default', name, sessionId, prompt, model, token = null, xellToken = null, timeoutMs = 1200000 } = {}) {
  let claudeTok = token, identTok = xellToken;
  if (!claudeTok || !identTok) {
    try {
      const r = await dk(ctx, ['exec', '-u', '0', name, 'cat', '/etc/environment'], { timeoutMs: 15000 });
      const pick = (k) => (r.out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
      claudeTok = claudeTok || pick('ANTHROPIC_AUTH_TOKEN');
      identTok = identTok || pick('ZEEHIVE_XELL_TOKEN');
    } catch { /* fall through with whatever the caller gave us */ }
  }
  const env = [];
  if (claudeTok) env.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${claudeTok}`, '-e', `ANTHROPIC_AUTH_TOKEN=${claudeTok}`);
  if (identTok) env.push('-e', `ZEEHIVE_XELL_TOKEN=${identTok}`);
  const sid = String(sessionId || '').replace(/[^0-9a-fA-F-]/g, ''); // uuid only — it is interpolated
  const resume = sid ? ` --resume ${sid}` : '';
  const cmd = ['exec', '-i', ...env, name, 'bash', '-lc',
    `cd /work/repo && claude --bare -p --output-format stream-json --verbose --dangerously-skip-permissions${resume}${model ? ` --model ${model}` : ''}`];
  return dk(ctx, cmd, { input: prompt, timeoutMs });
}

// Run ONE command inside a cxell zee over the SAME inbound SSH door the browser terminal uses (the
// fleet key, the host-published port). This reaches what a docker-exec cannot: the human's-eye-view
// of the cxell — the tmux session and the live interactive claude running in it. Resolves
// { code, out, err }; rejects on a transport failure or timeout. Pure ssh2 (like terminal-bridge),
// so it behaves the same on the Windows host as anywhere.
function sshExecInCxell({ sshPort, slug, cmd, timeoutMs = 20000 }) {
  const { privateKey } = ensureZeehiveKeypair();
  const { Client } = createRequire(import.meta.url)('ssh2');
  const dest = cxellSshDest({ slug, sshPort });
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; try { conn.end(); } catch {} fn(arg); };
    const t = setTimeout(() => done(reject, new Error(`ssh to ${dest.host}:${dest.port} timed out after ${timeoutMs}ms`)), timeoutMs);
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(t); return done(reject, err); }
        let out = '', errOut = '';
        stream.on('data', (d) => (out += d.toString()));
        stream.stderr.on('data', (d) => (errOut += d.toString()));
        stream.on('close', (code) => { clearTimeout(t); done(resolve, { code, out, err: errOut }); });
      });
    });
    conn.on('error', (e) => { clearTimeout(t); done(reject, new Error(`ssh error: ${e.message}`)); });
    conn.connect({ ...dest, username: 'zee', privateKey, readyTimeout: 8000 });
  });
}

// TYPE literal text into a cxell zee's LIVE interactive claude — the exact session a human watches
// in the dashboard terminal — by sending keystrokes to its tmux session over SSH, as if the operator
// typed them there. This is what a "nudge" should be: poke the running agent IN PLACE so its reply
// lands where the operator is looking. Contrast nudgeCxellZee, which forks a SECOND `claude --resume
// -p` whose output goes to a queenzee log nobody reads (hence "nudge does not work").
//
// If no interactive session is up yet, one is started with the SAME `zee-attach.sh` command the
// terminal bridge uses (attach-or-create, detached) and we give the TUI a beat to come alive before
// typing, so the keystrokes are not swallowed by a still-loading prompt. `-l` makes tmux send the
// text LITERALLY (so "status?" can never be read as a key name); a separate Enter submits it.
// Best-effort by contract — rejects if the cxell/SSH is unreachable; the caller just logs it.
export async function sendKeysToCxellZee({ sshPort, slug, text, sessionId, session = 'zee', enter = true, timeoutMs = 30000 }) {
  if (!sshPort && !slug) throw new Error('no SSH port or slug for this cxell');
  const sid = String(sessionId || '').replace(/[^0-9a-fA-F-]/g, ''); // uuid only — shell-interpolated
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;         // safe single-quote for bash
  const sh = [
    // Attach-or-create the interactive session; only sleep when we actually just started it, so an
    // already-open terminal (the common case) receives the keys with no added latency.
    `if tmux has-session -t ${session} 2>/dev/null; then :; ` +
      `else tmux new-session -d -s ${session} -x 200 -y 50 -c /work/repo 'zee-attach.sh ${sid}'; sleep 6; fi`,
    // wheel-scroll needs tmux mouse mode (alt-screen has no xterm scrollback); idempotent
    `tmux set -g mouse on 2>/dev/null || true`,
    `tmux send-keys -t ${session} -l ${sq(text)}`,
    ...(enter ? ['sleep 0.2', `tmux send-keys -t ${session} Enter`] : []),
    'echo __ZEE_KEYS_SENT__',
  ].join('; ');
  const r = await sshExecInCxell({ sshPort, slug, cmd: sh, timeoutMs });
  if (!/__ZEE_KEYS_SENT__/.test(r.out)) {
    throw new Error(`send-keys did not confirm (exit ${r.code}): ${(r.err || r.out || '').slice(0, 200)}`);
  }
  return { sent: true, text };
}

export async function removeCxell({ ctx, slug }) {
  await dk(ctx, ['rm', '-f', cxellName(slug)]).catch(() => {});
  // pre-rename containers (zee_cage_<slug>) from the old-vocabulary era — idempotent, so this
  // line retires with the last of them
  await dk(ctx, ['rm', '-f', `zee_cage_${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`]).catch(() => {});
}
