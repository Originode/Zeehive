// The CAGE driver: everything the queenzee does to run a zee's claude CLI INSIDE a per-xell
// zee-agent container (image docker/zeehive/Dockerfile.zee-agent) instead of on the host.
//
// Why: host-side confinement is prompt + regex (hooks/prod-guard.mjs admits it is not
// adversary-proof). The cage makes it structural — the container sees a private clone of the
// xell's branch, a default-DROP firewall allowing only api.anthropic.com, the queenzee API,
// and its OWN stack's host:port pairs (proven 2026-07-19: without the firewall, Docker's
// bridge NAT reaches the prod db on the LAN). No docker socket, no host mounts, non-root.
//
// The clone is a git BUNDLE of the worktree's HEAD — a private object store, deliberately not
// a mount: worktree .git files carry absolute host paths that don't resolve in Linux, and a
// shared object store would leak the xource into the cage. The worktree's generated
// .zeehive.env (gitignored, so absent from the bundle) is copied in separately — it carries
// the xell's ports and DATABASE_URL. Work products stay in the container until collected
// (exportCageDiff) — landing them on the worktree is the human-gated step.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { logline } from './logbus.js';

const IMAGE = 'zeehive/zee-agent';
export const cageName = (slug) => `zee_cage_${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;

// ── SSH attend: a human reaches a caged zee's interactive claude over SSH (the dashboard's
// ssh2→xterm terminal AND Claude Code desktop's "Add SSH host" are the same door). Inbound, so
// the egress firewall neither blocks it nor is loosened. ────────────────────────────────────

// The Zeehive keypair, one for the whole fleet, kept OUTSIDE the repo (never git). The private
// key stays here on the queenzee's host; the public key is authorized inside every cage.
const SSH_DIR = process.env.ZEEHIVE_SSH_DIR || resolve(homedir(), '.zeehive', 'ssh');
const PRIV = join(SSH_DIR, 'cage_id_ed25519');
const PUB = join(SSH_DIR, 'cage_id_ed25519.pub');

export function ensureZeehiveKeypair() {
  if (existsSync(PRIV) && existsSync(PUB)) {
    return { privateKeyPath: PRIV, privateKey: readFileSync(PRIV), publicKey: readFileSync(PUB, 'utf8').trim() };
  }
  mkdirSync(SSH_DIR, { recursive: true });
  const { utils } = createRequire(import.meta.url)('ssh2');
  const kp = utils.generateKeyPairSync('ed25519', { comment: 'zeehive-cage' });
  writeFileSync(PRIV, kp.private, { mode: 0o600 });
  writeFileSync(PUB, kp.public + '\n');
  logline('cage', `generated the Zeehive cage keypair at ${SSH_DIR}`);
  return { privateKeyPath: PRIV, privateKey: Buffer.from(kp.private), publicKey: kp.public.trim() };
}

// Per-cage host SSH port, bound to 127.0.0.1. A pure function of the slug so it survives a
// queenzee restart without being stored; ensureCage scans upward on a collision.
export function cageSshPort(slug) {
  let h = 0;
  for (const c of String(slug)) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return 22000 + (h % 2000);
}

// docker CLI runner. `--context` (not env) so a queenzee env leak can never re-aim a cage;
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

// Create (or recreate) the xell's cage container on its own bridge network. Labeled so
// dockerPs-based monitors can attribute it; NET_ADMIN only for the firewall seal. Publishes an
// SSH port on 127.0.0.1 (the attend door — host-only; the queenzee's ssh2 bridge and a
// same-machine Claude Code desktop both reach it, nothing on the LAN does). Returns the port
// actually bound, scanning upward if the slug-derived one is taken.
export async function ensureCage({ ctx, slug, xellId, network, sshPort }) {
  const name = cageName(slug);
  const net = network || 'zee-cage-net';
  await dk(ctx, ['network', 'create', '--label', 'zeehive.cage=net', net]).catch((e) => {
    if (!/already exists/i.test(e.message)) throw e;
  });
  await dk(ctx, ['rm', '-f', name]).catch(() => {}); // stale cage from a prior run
  let port = sshPort || cageSshPort(slug);
  for (let attempt = 0; attempt < 12; attempt++, port++) {
    try {
      await dk(ctx, ['run', '-d', '--name', name, '--network', net, '--cap-add', 'NET_ADMIN',
        '-p', `127.0.0.1:${port}:22`,
        '--label', 'zeehive.cage=1', '--label', `zeehive.xell=${xellId || ''}`, IMAGE]);
      return { name, sshPort: port };
    } catch (e) {
      if (/port is already allocated|address already in use|bind/i.test(e.message)) {
        await dk(ctx, ['rm', '-f', name]).catch(() => {}); // the failed create left a husk
        continue; // next port
      }
      throw e;
    }
  }
  throw new Error(`could not bind an SSH port for cage ${name} (all candidates in use)`);
}

// Open the cage's SSH door: install the Zeehive public key for `zee`, drop the Claude token into
// /etc/environment so an interactive (PAM) login shell comes up authenticated — a docker-exec -e
// run gets the token directly, an SSH login does not — and start sshd. Root exec; the zee cannot
// undo it. Idempotent.
export async function openCageSsh({ ctx, name, publicKey, token, xellToken }) {
  const env = [];
  if (publicKey) env.push('-e', `CAGE_PUBKEY=${publicKey}`);
  // /etc/environment lines a PAM (SSH) login inherits — the Claude token so interactive `claude`
  // comes up authenticated, AND the per-xell identity token so an attending human's `zee` CLI (and
  // any command in the login shell) can reach the queenzee's /api/xell/self/* verbs. A docker-exec
  // -e run gets these directly; an SSH login does not, so they must land in /etc/environment too.
  const envLines = [];
  if (token) envLines.push(`ANTHROPIC_AUTH_TOKEN=${token}`);
  if (xellToken) envLines.push(`ZEEHIVE_XELL_TOKEN=${xellToken}`);
  if (envLines.length) env.push('-e', `CAGE_ENV=${envLines.join('\n')}`);
  const r = await dk(ctx, ['exec', '-u', '0', ...env, name, 'bash', '/usr/local/bin/cage-sshd.sh']);
  return r.out.trim();
}

// Bundle the worktree's HEAD (its spinoff branch) into the cage as a private clone at
// /work/repo, then copy in the gitignored .zeehive.env projection (ports + DATABASE_URL).
export async function cloneIntoCage({ ctx, name, worktree }) {
  const tmp = mkdtempSync(join(tmpdir(), 'zee-cage-'));
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
    if (branch === 'HEAD') throw new Error(`worktree ${worktree} is on a detached HEAD — nothing to cage`);
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
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Apply the cage egress policy (docker/zeehive/cage-firewall.sh): default ALLOW, DROP only the
// prod DB host:port pairs in blockTcp. The container is the real confinement boundary; this just
// keeps the one thing that matters — the live production database — off-limits (unless the xell
// is prod-bound, in which case the caller leaves its prod DB out of blockTcp). Root exec; the
// zee runs as `zee` and cannot undo it.
export async function sealCage({ ctx, name, blockTcp = [] }) {
  const env = blockTcp.length ? ['-e', `CAGE_BLOCK_TCP=${blockTcp.join(' ')}`] : [];
  const r = await dk(ctx, ['exec', '-u', '0', ...env, name, 'bash', '/usr/local/bin/cage-firewall.sh']);
  return r.out.trim().split('\n');
}

// Provision the boring slow stuff so a FRESH zee starts working immediately instead of burning
// its turn (and your allowance) on `npm ci`: install deps + prebuild the web bundle. The queenzee
// drives it over docker exec, so it costs zero agent tokens. Runs with egress fully open (before
// the prod-db block is applied). Best-effort: a slow/failed warm must NOT fail the dispatch — the
// zee can still install what it needs.
export async function warmCage({ ctx, name }) {
  try {
    const r = await dk(ctx, ['exec', name, 'bash', '-lc',
      'cd /work/repo && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) '
      + '&& (npm run build --workspace web >/dev/null 2>&1 || true) && echo WARM_OK'],
      { timeoutMs: 900000 });
    return { warmed: /WARM_OK/.test(r.out) };
  } catch (e) {
    logline('cage', `${name}: warm (npm/build) incomplete — the zee will install as needed: ${String(e.message).slice(0, 160)}`);
    return { warmed: false, error: e.message };
  }
}

// Run the zee: `claude -p` inside the cage, stream-json events out. Returns { proc, done }
// where done resolves with the final `result` event (or rejects on a transport failure).
// onEvent(obj) fires per parsed NDJSON event — init (session id), assistant turns, result.
//
// --bare: nothing host-side (plugins/MCP/hooks/skills) leaks into the cage, and auth comes
// from CLAUDE_CODE_OAUTH_TOKEN alone (tokenForSpawn — the project's connected token).
// --dangerously-skip-permissions: safe HERE and only here — the cage is the permission
// system, and the CLI requires non-root, which the image guarantees.
export function runZee({ ctx, name, prompt, model, token, xellToken, onEvent }) {
  // BOTH env names, measured on claude 2.1.214 (2026-07-19): --bare skips the OAuth credential
  // chain entirely — CLAUDE_CODE_OAUTH_TOKEN alone yields "Not logged in" without one API call —
  // but honors ANTHROPIC_AUTH_TOKEN (the raw bearer header, which an sk-ant-oat01 token is).
  // Keep the OAuth var too so a future CLI that prefers it keeps working.
  const cmd = ['exec', '-i',
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '-e', `ANTHROPIC_AUTH_TOKEN=${token}`,
    // The per-xell identity token: the caged zee's `zee` CLI (and any /api/xell/self/* call) reads
    // it to prove WHICH xell is calling. Injected alongside the Claude token — same door, and the
    // firewall already allows the queenzee host:port.
    ...(xellToken ? ['-e', `ZEEHIVE_XELL_TOKEN=${xellToken}`] : []),
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
    try { onEvent?.(ev); } catch (e) { logline('cage', `onEvent threw: ${e.message}`); }
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
      else reject(new Error(`caged claude exited ${code} with no result event: ${err.slice(0, 400)}`));
    });
  });
  p.stdin.write(prompt);
  p.stdin.end();
  return { proc: p, done };
}

// Collect the zee's work as a bundle of commits made inside the cage (HEAD relative to the
// clone point). The caller lands it on the worktree via `git pull <bundle>` — through the
// same human-gated landing flow as any zee push. Returns null when the cage made no commits.
export async function exportCageDiff({ ctx, name, toDir }) {
  const probe = await dk(ctx, ['exec', name, 'bash', '-lc',
    'cd /work/repo && git rev-list origin/HEAD..HEAD --count 2>/dev/null || git rev-list HEAD --not --remotes --count']);
  if (Number(probe.out.trim()) === 0) return null;
  await dk(ctx, ['exec', name, 'bash', '-lc',
    'cd /work/repo && git bundle create /tmp/out.bundle $(git symbolic-ref --short HEAD) --not --remotes']);
  const out = join(toDir, `${name}-out.bundle`);
  await dk(ctx, ['cp', `${name}:/tmp/out.bundle`, out]);
  return out;
}

// COLLECT the cage's commits onto its HOST worktree so they can be landed through the normal gate.
// This is the missing piece for a caged zee: its work is committed INSIDE the container, but the
// land gate pushes from the host worktree. exportCageDiff bundles the cage's branch (commits not in
// remotes); we fetch that bundle into the worktree and fast-forward the checked-out branch to the
// cage's HEAD. The push that follows (pushToXource) is what actually trips the land gate — this only
// moves the commits from inside the cage to the worktree they will be pushed from.
//
// Best-effort by contract: a cage with no new commits (already collected, or none made) is a no-op,
// not an error. A worktree that has DIVERGED from the cage (someone moved it) refuses rather than
// force — the caller surfaces that to the zee.
export async function collectCageDiffToWorktree({ ctx = 'default', slug, worktree }) {
  if (!worktree || !existsSync(worktree)) {
    return { collected: false, reason: `no host worktree on disk (${worktree || 'null'})` };
  }
  const name = cageName(slug);
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
    const bundle = await exportCageDiff({ ctx, name, toDir: tmp });
    if (!bundle) return { collected: false, reason: 'the cage has no commits beyond the worktree' };
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    // Fetch the cage branch into a private staging ref (never the checked-out branch directly), then
    // fast-forward the worktree branch to it. --ff-only is the honesty guard: if the worktree moved
    // since caging, we refuse instead of fabricating a merge nobody asked for.
    await git(['fetch', bundle, `${branch}:refs/zeehive/cage-land`]);
    const target = await git(['rev-parse', 'refs/zeehive/cage-land']);
    let ff;
    try { await git(['merge', '--ff-only', target]); ff = true; }
    catch (e) { ff = false; await git(['update-ref', '-d', 'refs/zeehive/cage-land']).catch(() => {});
      throw new Error(`the cage's commits do not fast-forward the worktree branch — it moved since caging (${e.message})`); }
    await git(['update-ref', '-d', 'refs/zeehive/cage-land']).catch(() => {});
    const head = await git(['rev-parse', 'HEAD']);
    return { collected: ff, head, branch };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// NUDGE a caged zee: RESUME its claude session inside the cage so its workflow continues with no
// human re-invocation. A headless caged zee's turn ENDS at `zee land`; nothing tells it the human
// later approved. So when a landing raised by a caged zee lands, the queenzee re-invokes the
// session — `docker exec <cage> claude --bare --resume <sid> -p` — with a short prompt. The prompt
// rides in on stdin (no shell-quoting of model text); the session id is sanitised to a uuid because
// it is interpolated into the command.
//
// Tokens: prefer the ones the cage was SPAWNED with, read back from /etc/environment, so we do NOT
// invalidate a token a `zee … --wait` poll is still holding (re-minting would 401 that poll right
// as it should report success). Fall back to whatever the caller passes. Best-effort: a torn-down
// or unreachable cage rejects, and the caller just logs it.
export async function nudgeCagedZee({ ctx = 'default', name, sessionId, prompt, model, token = null, xellToken = null, timeoutMs = 1200000 } = {}) {
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

export async function removeCage({ ctx, slug }) {
  await dk(ctx, ['rm', '-f', cageName(slug)]).catch(() => {});
}
