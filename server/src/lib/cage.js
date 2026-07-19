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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logline } from './logbus.js';

const IMAGE = 'zeehive/zee-agent';
export const cageName = (slug) => `zee_cage_${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;

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
// dockerPs-based monitors can attribute it; NET_ADMIN only for the firewall seal.
export async function ensureCage({ ctx, slug, xellId, network }) {
  const name = cageName(slug);
  const net = network || 'zee-cage-net';
  await dk(ctx, ['network', 'create', '--label', 'zeehive.cage=net', net]).catch((e) => {
    if (!/already exists/i.test(e.message)) throw e;
  });
  await dk(ctx, ['rm', '-f', name]).catch(() => {}); // stale cage from a prior run
  await dk(ctx, ['run', '-d', '--name', name, '--network', net, '--cap-add', 'NET_ADMIN',
    '--label', 'zeehive.cage=1', '--label', `zeehive.xell=${xellId || ''}`, IMAGE]);
  return name;
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

// Seal the egress firewall (docker/zeehive/cage-firewall.sh, baked into the image).
// allowTcp: the xell's OWN containers as "host:port" strings — its db/app tier, wherever
// they run. Everything else on the LAN stays DROPped. Root exec is required for iptables;
// the zee itself runs as `zee` and cannot undo the seal.
export async function sealCage({ ctx, name, queenzee, allowTcp = [], allowDomains }) {
  const env = [];
  if (queenzee) env.push('-e', `CAGE_QUEENZEE=${queenzee}`);
  if (allowTcp.length) env.push('-e', `CAGE_ALLOW_TCP=${allowTcp.join(' ')}`);
  if (allowDomains) env.push('-e', `CAGE_ALLOW_DOMAINS=${allowDomains}`);
  const r = await dk(ctx, ['exec', '-u', '0', ...env, name, 'bash', '/usr/local/bin/cage-firewall.sh']);
  return r.out.trim().split('\n');
}

// Run the zee: `claude -p` inside the cage, stream-json events out. Returns { proc, done }
// where done resolves with the final `result` event (or rejects on a transport failure).
// onEvent(obj) fires per parsed NDJSON event — init (session id), assistant turns, result.
//
// --bare: nothing host-side (plugins/MCP/hooks/skills) leaks into the cage, and auth comes
// from CLAUDE_CODE_OAUTH_TOKEN alone (tokenForSpawn — the project's connected token).
// --dangerously-skip-permissions: safe HERE and only here — the cage is the permission
// system, and the CLI requires non-root, which the image guarantees.
export function runZee({ ctx, name, prompt, model, token, onEvent }) {
  // BOTH env names, measured on claude 2.1.214 (2026-07-19): --bare skips the OAuth credential
  // chain entirely — CLAUDE_CODE_OAUTH_TOKEN alone yields "Not logged in" without one API call —
  // but honors ANTHROPIC_AUTH_TOKEN (the raw bearer header, which an sk-ant-oat01 token is).
  // Keep the OAuth var too so a future CLI that prefers it keeps working.
  const cmd = ['exec', '-i',
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '-e', `ANTHROPIC_AUTH_TOKEN=${token}`,
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

export async function removeCage({ ctx, slug }) {
  await dk(ctx, ['rm', '-f', cageName(slug)]).catch(() => {});
}
