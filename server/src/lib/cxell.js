// The CXELL driver: everything the queenzee does to run a zee's agent CLI (claude, codex, or
// kimi — see cxell-runtimes.js) INSIDE a per-xell zee-agent container (image
// docker/zeehive/Dockerfile.zee-agent) instead of on the host.
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
import { createHash } from 'node:crypto';
import { logline } from './logbus.js';
import { config } from '../config.js';
import { adapterFor, CLAUDE_ADAPTER, AGENT_PROC_PATTERN } from './cxell-runtimes.js';
import { classifyMergeOutput } from '../queenzee/xellgit.js';

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
    let out = '', err = '', buf = '', stdinErr = null;
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
      // A stdin write that broke before the payload was fully delivered (e.g. EPIPE when the
      // container's reader closed early) means the bytes are TRUNCATED — even if the child then
      // exits 0 (base64 -d / cat happily decode a partial stream). Surfacing this is what stops a
      // half-written image attachment from being reported as a clean success. See writeFileIntoCxell.
      if (stdinErr) { reject(new Error(`docker ${args.slice(0, 2).join(' ')} stdin write failed: ${stdinErr.code || stdinErr.message} — payload likely truncated`)); return; }
      if (code === 0) resolve({ code, out, err });
      else reject(new Error(`docker ${args.slice(0, 2).join(' ')} exited ${code}: ${(err || out).slice(0, 400)}`));
    });
    if (input !== undefined) {
      // Catch stdin errors (EPIPE etc.) rather than letting them bubble to an UNCAUGHT exception:
      // a multi-megabyte base64 attachment piped to `docker exec -i` is exactly when a mid-write
      // pipe break happens. `.end(input)` writes the whole buffer and only closes stdin once it has
      // flushed — so the container reader gets every byte on the happy path, and a genuine break is
      // recorded in stdinErr and turned into a rejection on close (above).
      p.stdin.on('error', (e) => { stdinErr = e; });
      p.stdin.end(input);
    } else {
      p.stdin.end();
    }
  });
}

// Is a cxell zee ACTUALLY working right now? True iff an agent CLI process (claude/codex/kimi —
// whatever runtimes the adapter registry knows) is alive inside its cxell. This is the honest
// liveness signal the monitor needs: it catches both the headless run AND an interactive terminal
// session a human drives over SSH — the latter is an agent the queenzee never spawned, so its own
// process handle can't see it (that's why a busy cxell zee read 'idle'). pgrep exits 1 (→ dk
// rejects) when nothing matches, and a stopped/absent container rejects too; either way there is
// no live agent, so → false. Short timeout: this runs every monitor tick.
export async function cxellZeeActive({ ctx = 'default', slug }) {
  try {
    await dk(ctx, ['exec', cxellName(slug), 'pgrep', '-f', AGENT_PROC_PATTERN], { timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
}

// Does this xell HAVE a live cxell container right now? (Distinct from cxellZeeActive, which asks
// whether an AGENT PROCESS is running: a zee that just called `zee land` is BETWEEN turns, so no
// agent is alive, yet its container is up and its uncollected work lives inside it.) This is the
// signal `zee land` needs to choose the reconcile path: a live cxell is reconciled by delivering the
// xource INTO it (deliverXourceIntoCxell); a xell with no cxell falls back to the host-worktree merge
// (catchUpToXource). Any docker/container error → treat as "no cxell" and fall back.
export async function cxellRunning({ ctx = 'default', slug }) {
  try {
    const r = await dk(ctx, ['inspect', '-f', '{{.State.Running}}', cxellName(slug)], { timeoutMs: 8000 });
    return /true/i.test(r.out.trim());
  } catch {
    return false;
  }
}

// ── DELIVER the xource INTO a live cxell — the mirror image of exportCxellDiff ────────────────────
// The failure class this removes: while a cxell is LIVE, the host worktree must be READ-ONLY for
// catch-up. The old catch-up merged the xource tip INTO the host worktree behind the zee's back
// (catchUpWorktree), which made the cxell→worktree fast-forward impossible FOREVER — and stranded the
// zee's commits. Instead we hand the xource tip to the container, exactly as exportCxellDiff hands the
// cxell's commits OUT: a thin bundle, docker-cp'd in, fetched to refs/remotes/origin/main. The zee
// (or the pure-script sync) then merges origin/main ITSELF, where it can build and test the result.
//
//   git bundle create <tmp>/main.bundle <ref> --not <base>   # queenzee side, thin (only what moved)
//   docker cp <bundle> <cxell>:/tmp/main.bundle              # same door as task.bundle
//   git fetch /tmp/main.bundle <ref>:refs/remotes/origin/main   # inside the cxell
//
// The bundle's boundary (`--not <base>`) must be a commit the cxell ALREADY HAS, or its fetch refuses
// with a missing-prerequisite. The safe boundary is merge-base(<ref>, worktree HEAD): once Change 1
// stops behind-the-zee's-back merges, the worktree HEAD is always a commit the cxell has (the collect
// only ever fast-forwards it TO the cxell's HEAD), so their merge-base is in the cxell too. If a
// legacy divergence still trips the thin fetch, we retry with a FULL bundle (self-contained, always
// fetchable) so recovery never depends on the boundary being present.
export async function deliverXourceIntoCxell({ ctx = 'default', slug, worktree, ref }) {
  if (!worktree || !existsSync(worktree)) return { delivered: false, reason: `no host worktree on disk (${worktree || 'null'})` };
  const name = cxellName(slug);
  const tmp = mkdtempSync(join(tmpdir(), 'zee-deliver-'));
  const git = (args) => new Promise((resolve, reject) => {
    const g = spawn('git', ['-C', worktree, ...args], { windowsHide: true });
    let out = '', err = '';
    g.stdout.on('data', (d) => (out += d.toString()));
    g.stderr.on('data', (d) => (err += d.toString()));
    g.on('error', reject);
    g.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')} exited ${c}: ${err.slice(0, 300)}`))));
  });
  try {
    const tip = await git(['rev-parse', ref]);
    // merge-base(ref, worktree HEAD): a commit on the xource that the cxell also has (see above). Best
    // effort — if it can't be read, we simply send a full bundle.
    let base = null;
    try { base = await git(['merge-base', ref, 'HEAD']); } catch { /* full bundle */ }
    const bundle = join(tmp, 'main.bundle');
    const buildThin = base && base !== tip;
    if (buildThin) await git(['bundle', 'create', bundle, ref, '--not', base]);
    else await git(['bundle', 'create', bundle, ref]);
    await dk(ctx, ['cp', bundle, `${name}:/tmp/main.bundle`]);
    const fetch = async () => dk(ctx, ['exec', name, 'bash', '-lc',
      `cd /work/repo && git fetch -f /tmp/main.bundle '${ref.replace(/'/g, '')}:refs/remotes/origin/main'`], { timeoutMs: 60000 });
    try {
      await fetch();
    } catch (e) {
      // Thin fetch refused (boundary not in the cxell — a legacy divergence). Fall back to a FULL,
      // self-contained bundle so delivery still succeeds; a stranded cxell must always be recoverable.
      if (buildThin) {
        await git(['bundle', 'create', bundle, ref]).catch(() => {});
        await dk(ctx, ['cp', bundle, `${name}:/tmp/main.bundle`]);
        await fetch();
      } else { throw e; }
    }
    await dk(ctx, ['exec', '-u', '0', name, 'rm', '-f', '/tmp/main.bundle']).catch(() => {});
    logline('cxell', `${slug}: delivered ${ref} @ ${String(tip).slice(0, 8)} into the cxell as origin/main`);
    return { delivered: true, ref, tip };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── SYNC a live cxell with its xource — PURE SCRIPT, no model in the loop ─────────────────────────
// Deliver the xource in (above), then MERGE origin/main into the cxell's branch, inside the cxell,
// with the queenzee identity so it never depends on the container's git config. This is the whole
// "reconcile with main on its own" mechanism: after a clean merge the cxell's HEAD descends from the
// current xource, so the eventual cxell→worktree fast-forward succeeds and a push lands.
//
// The division of labour the task requires: this attempt is script-only. Its JUDGMENT call — a real
// CONTENT conflict — is the one thing handed back to the model. We classify the merge output with the
// SAME predicate the host-side catch-up uses (classifyMergeOutput), so a genuine conflict reads
// 'conflict' (the zee's to resolve, in place — MERGE_HEAD is left set) and an operational failure
// reads 'error' (nothing for the zee to fix in code). Returns { state, ... } where state is:
//   'up-to-date' — the cxell already contains the xource tip; nothing to do.
//   'merged'     — merged origin/main in cleanly; head is the new merge commit.
//   'conflict'   — a genuine content conflict; the merge is LEFT in progress for the zee to resolve.
//   'error'      — an operational failure (delivery or a non-conflict merge failure).
const CX_IDENTITY = `-c user.name='Zeehive queenzee' -c user.email=queenzee@zeehive.local`;
export async function syncCxellWithXource({ ctx = 'default', slug, worktree, ref }) {
  const name = cxellName(slug);
  let delivery;
  try {
    delivery = await deliverXourceIntoCxell({ ctx, slug, worktree, ref });
  } catch (e) {
    return { state: 'error', stage: 'deliver', output: String(e.message).slice(-1200) };
  }
  if (!delivery.delivered) return { state: 'error', stage: 'deliver', output: delivery.reason || 'could not deliver the xource into the cxell' };

  // Already contains the tip → a merge would be a no-op; report up-to-date without touching the tree.
  try {
    await dk(ctx, ['exec', name, 'bash', '-lc',
      'cd /work/repo && git merge-base --is-ancestor refs/remotes/origin/main HEAD'], { timeoutMs: 15000 });
    const head = (await dk(ctx, ['exec', name, 'bash', '-lc', 'cd /work/repo && git rev-parse HEAD'], { timeoutMs: 15000 })).out.trim();
    return { state: 'up-to-date', head, tip: delivery.tip, ref };
  } catch { /* not yet an ancestor → merge it */ }

  // MERGE. --no-edit so the script needs no editor; the queenzee identity so the merge commit never
  // depends on the container's (absent) git config. On failure DO NOT abort: leaving MERGE_HEAD set
  // is what lets the zee resolve a genuine conflict in place, then just commit. Capture the FULL merge
  // output (2>&1) and the REAL exit code inline — git writes its "CONFLICT …/Automatic merge failed"
  // lines to stdout, and we must classify on the whole text, not a truncated docker-error slice.
  let out = '', code = 1;
  try {
    const r = await dk(ctx, ['exec', name, 'bash', '-lc',
      `cd /work/repo && git ${CX_IDENTITY} merge --no-edit refs/remotes/origin/main 2>&1; echo "__MERGE_RC__:$?"`],
      { timeoutMs: 180000 });
    out = r.out;
    code = Number((out.match(/__MERGE_RC__:(\d+)/) || [])[1] ?? 1);
  } catch (e) {
    code = 1; out = String(e.message);
  }
  if (code === 0) {
    const head = (await dk(ctx, ['exec', name, 'bash', '-lc', 'cd /work/repo && git rev-parse HEAD'], { timeoutMs: 15000 })).out.trim();
    logline('cxell', `${slug}: merged ${ref} into the cxell cleanly → ${String(head).slice(0, 8)}`);
    return { state: 'merged', head, tip: delivery.tip, ref };
  }
  // Failed. Classify: a real content conflict is the zee's; anything else is operational.
  const cls = classifyMergeOutput(out);
  if (cls.state === 'error') {
    // Not a content conflict → nothing for the zee to resolve. Abort so we don't leave a stuck merge.
    await dk(ctx, ['exec', name, 'bash', '-lc', 'cd /work/repo && git merge --abort'], { timeoutMs: 15000 }).catch(() => {});
  }
  logline('cxell', `${slug}: sync merge of ${ref} → ${cls.state}`);
  return { ...cls, tip: delivery.tip, ref };
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
  // "ahead" is the count of the zee's UNLANDED commits. Measure it against origin/main WHEN THAT REF
  // EXISTS in the cxell (delivered by deliverXourceIntoCxell) — because commits the zee already landed
  // are on main, so counting from the frozen provisioning base kept them showing as unlanded forever
  // (six xells read ↑1–↑4 with every commit already on main). Fall back to the base only until the
  // first sync delivers a live origin/main. The shortstat still measures the working diff vs base.
  const script = [
    'cd /work/repo || exit 3',
    'echo "$(git rev-parse HEAD 2>/dev/null)"',
    'OM="$(git rev-parse --verify -q refs/remotes/origin/main || true)"',
    `if [ -n "$OM" ]; then echo "$(git rev-list --count refs/remotes/origin/main..HEAD 2>/dev/null)"; `
      + `else echo "$(git rev-list --count ${b}..HEAD 2>/dev/null)"; fi`,
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

// The PATCH behind cxellDiff's numbers — the same read, one level deeper, for the console's diff
// viewer. cxellDiff answers "how much", this answers "what": the actual lines, read from inside the
// cage where a cxell zee's work lives until it lands.
//
//   kind 'source' → `git diff <base>`: everything the zee added since it was spun up, committed or
//                   not (a plain diff against a commit spans the working tree, so uncommitted counts).
//   kind 'own'    → `git diff HEAD`: only what is not checkpointed yet.
//
// Untracked files are appended as `--no-index` patches: `git diff` cannot see a file git has never
// been told about, and a zee that has just written five new files and not committed is exactly when
// a human opens this. The whole pipeline is capped with `head -c` INSIDE the container, so a runaway
// diff never crosses the docker boundary; the cap is reported, not hidden. Returns null when the
// cxell is unreachable (the caller then falls back to the host worktree), never throws.
export async function cxellPatch({ ctx = 'default', slug, base, kind = 'source', maxBytes = 4_000_000 }) {
  const b = String(base || '').replace(/[^0-9a-fA-F]/g, '');
  const target = kind === 'own' ? 'HEAD' : b;
  if (!target) return null;
  const name = cxellName(slug);
  const body = [
    'cd /work/repo || exit 3',
    `git --no-pager diff --no-color -M ${target}`,
    "git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do "
      + 'git --no-pager diff --no-color --no-index -- /dev/null "$f"; done',
  ].join('; ');
  let out, head = null;
  try {
    const r = await dk(ctx, ['exec', name, 'bash', '-lc',
      `{ ${body}; } 2>/dev/null | head -c ${Number(maxBytes) || 4_000_000}`], { timeoutMs: 30000 });
    out = r.out;
    const h = await dk(ctx, ['exec', name, 'bash', '-lc', 'cd /work/repo && git rev-parse HEAD'],
      { timeoutMs: 8000 }).catch(() => null);
    head = h ? h.out.trim() : null;
  } catch {
    return null;
  }
  const text = String(out || '');
  return { text, head, capped: text.length >= (Number(maxBytes) || 4_000_000) };
}

// Create (or recreate) the xell's cxell container on its own bridge network. Labeled so
// dockerPs-based monitors can attribute it; NET_ADMIN only for the firewall seal. Publishes an
// SSH port on 127.0.0.1 (the attend door — host-only; the queenzee's ssh2 bridge and a
// same-machine Claude Code desktop both reach it, nothing on the LAN does). Returns the port
// actually bound, scanning upward if the slug-derived one is taken.
export async function ensureCxell({ ctx, slug, xellId, network, sshPort, image }) {
  const name = cxellName(slug);
  const img = image || IMAGE;   // per-project override (e.g. the Android SDK variant); else the base
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
        '--label', 'zeehive.cxell=1', '--label', `zeehive.xell=${xellId || ''}`, img]);
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

// ── The cxell CLI, refreshed from the QUEENZEE's own copy at spawn ───────────────────────────
//
// The `zee` CLI is baked into the zee-agent image (COPY scripts/zee), but an image is a snapshot:
// a fleet still running last month's zee-agent hands every new cxell a CLI OLDER than the queenzee
// that defines its API, and nothing says so until a zee is stranded. That is exactly how the crew
// verbs (zees/dispatch/say/report/inbox/suggest-done) shipped server-side and answered "unknown
// command: dispatch" in every cage — a manager zee that could not dispatch.
//
// So the queenzee installs ITS OWN scripts/zee over the baked one in every cxell it creates. The
// queenzee always runs out of the Zeehive repo (config.repoRoot — the same resolution
// provision.js/machines.js use for their scripts, and Dockerfile.server COPYs scripts/ into the
// image), so the copy it holds is by construction the one that matches its API surface.
export const ZEE_CLI_DEST = '/usr/local/bin/zee';
// The path the queenzee installs FROM. Exported so a test can assert it is the authoritative CLI.
export const zeeCliSourcePath = () => resolve(config.repoRoot, 'scripts', 'zee');

// The exact docker argv sequence installZeeCliIntoCxell runs — pure, so it is assertable without a
// daemon. `docker cp` lands the file as root; the exec then strips any trailing CR (a Windows
// checkout would otherwise leave `#!/usr/bin/env node\r`, which dies as `node\r: No such file or
// directory` — the same belt-and-braces the Dockerfile applies), chmods it executable and pins
// root ownership so the zee cannot rewrite its own CLI.
export function cxellFileInstallCommands({ name, src, dest, tmp }) {
  return [
    ['cp', src, `${name}:${tmp}`],
    ['exec', '-u', '0', name, 'bash', '-lc',
      `sed -i 's/\\r$//' ${tmp} && install -o root -g root -m 0755 ${tmp} ${dest} && rm -f ${tmp}`],
  ];
}
export function zeeCliInstallCommands({ name, src = zeeCliSourcePath() }) {
  return cxellFileInstallCommands({ name, src, dest: ZEE_CLI_DEST, tmp: '/tmp/zee.cli' });
}

// The ATTEND-side twin of the CLI refresh: zee-live.mjs renders the transcript feed a human watches
// in the dashboard terminal, and it is baked into the image exactly like `zee` was — so a fleet on
// an older zee-agent shows an older feed. It matters now that the terminal has ✱/⚒ view chips: the
// chips write /tmp/zee-live-view.json (terminal-bridge.js) and only a renderer that WATCHES that
// file reacts. Without this refresh the buttons would be dead in every cage spawned from a stale
// image — the precise failure mode the CLI install exists to prevent.
export const ZEE_LIVE_DEST = '/usr/local/bin/zee-live.mjs';
export const zeeLiveSourcePath = () => resolve(config.repoRoot, 'docker', 'zeehive', 'zee-live.mjs');
export const zeeLiveInstallCommands = ({ name, src = zeeLiveSourcePath() }) =>
  cxellFileInstallCommands({ name, src, dest: ZEE_LIVE_DEST, tmp: '/tmp/zee-live.mjs' });

export async function installZeeLiveIntoCxell({ ctx = 'default', name }) {
  const src = zeeLiveSourcePath();
  if (!existsSync(src)) return { installed: false, reason: 'source-missing', src };
  try {
    for (const args of zeeLiveInstallCommands({ name, src })) await dk(ctx, args);
    return { installed: true, src };
  } catch (e) {
    // Quieter than the CLI's !!!: a stale feed renderer costs a human a filter button, it does not
    // strand a zee. Still said out loud, never swallowed.
    logline('cxell', `${name}: could not refresh the live-feed renderer from ${src} `
      + `(${String(e.message).slice(0, 160)}) — the terminal's ✱/⚒ chips may do nothing in this cxell`);
    return { installed: false, reason: 'exec-failed', src, error: e.message };
  }
}

// ── Is the IMAGE this cxell booted from actually built from the current code? ─────────────────
//
// The refresh below hides the answer by design: it overwrites /usr/local/bin/zee, so afterwards the
// one file that could testify no longer can. That is not hypothetical — on the cad07a8 ship the
// zee-agent image was never really rebuilt (the build read the pre-landing working tree and hit
// cache on every layer), and the only reason anyone found out was a zee comparing baked-file mtimes
// by hand across two cages. Nothing in the system said a word.
//
// So ASK BEFORE OVERWRITING, while the baked file is still there: sha256 the image's `zee` and
// compare it to the queenzee's own scripts/zee. A mismatch means the image predates this code —
// the fleet image is stale, the spawn-time refresh is the only thing making the cage work, and the
// next capability that is NOT the CLI (cxell-sshd.sh, zee-attach.sh, the agent CLIs, the firewall)
// silently will not be there at all. Cheap: one exec, at spawn, best-effort.
async function bakedZeeCliSha({ ctx, name }) {
  try {
    const r = await dk(ctx, ['exec', '-u', '0', name, 'sha256sum', ZEE_CLI_DEST], { timeoutMs: 20000 });
    const sha = String(r.out || '').trim().split(/\s+/)[0];
    return /^[0-9a-f]{64}$/.test(sha) ? sha : null;
  } catch { return null; }   // no baked copy / no sha256sum — unknown, never fatal
}

// Install (idempotently — it is an overwrite) the queenzee's current `zee` CLI into the cxell.
// Best-effort with a LOUD log, the same stance as the prompt-attachments copy above and the
// cxell-image rebuild in self-ship.sh: the baked CLI is still there, so a failed refresh must not
// sink a cxell spawn — but it must never be silent, because "silent" is this bug's whole story.
export async function installZeeCliIntoCxell({ ctx = 'default', name }) {
  const src = zeeCliSourcePath();
  if (!existsSync(src)) {
    logline('cxell', `${name}: !!! could not refresh the zee CLI — ${src} is missing from the queenzee's `
      + 'repo; the cxell keeps the CLI baked into its image, which may be OLDER than this queenzee');
    return { installed: false, reason: 'source-missing', src };
  }
  // Read the image's verdict FIRST — the install below destroys the evidence.
  const baked = await bakedZeeCliSha({ ctx, name });
  const mine = createHash('sha256').update(readFileSync(src)).digest('hex');
  const staleImage = baked ? baked !== mine : null;
  if (staleImage) {
    logline('cxell', `${name}: !!! STALE CXELL IMAGE — the \`zee\` baked into this container's image `
      + `(sha ${baked.slice(0, 12)}) is NOT this queenzee's scripts/zee (sha ${mine.slice(0, 12)}). The `
      + 'zee-agent image was not rebuilt from the current code. The spawn-time refresh below papers '
      + 'over it FOR THE CLI ONLY — every other baked file (cxell-sshd.sh, zee-attach.sh, the agent '
      + 'CLIs, cxell-firewall.sh) is still the old build and nothing refreshes those. Rebuild the '
      + 'image: git archive <sha> | docker build -f docker/zeehive/Dockerfile.zee-agent -t zeehive/zee-agent -');
  }
  try {
    for (const args of zeeCliInstallCommands({ name, src })) await dk(ctx, args);
    return { installed: true, src, staleImage, bakedSha: baked, sourceSha: mine };
  } catch (e) {
    logline('cxell', `${name}: !!! could not refresh the zee CLI from ${src} (${String(e.message).slice(0, 200)}) — `
      + 'the cxell falls back to the CLI baked into its image, which may be OLDER than this queenzee '
      + 'and may refuse verbs the API supports. Rebuild zeehive/zee-agent.');
    return { installed: false, reason: 'exec-failed', src, error: e.message };
  }
}

// Open the cxell's SSH door: install the Zeehive public key for `zee`, drop the agent CLI's
// credential env into /etc/environment so an interactive (PAM) login shell comes up authenticated
// — a docker-exec -e run gets the env directly, an SSH login does not — and start sshd. Root
// exec; the zee cannot undo it. Idempotent.
export async function openCxellSsh({ ctx, name, publicKey, agentEnv = {}, xellToken, runtimeKey = null }) {
  const env = [];
  if (publicKey) env.push('-e', `CXELL_PUBKEY=${publicKey}`);
  // /etc/environment lines a PAM (SSH) login inherits — the VENDOR's credential env (whatever the
  // runtime adapter says its CLI reads: ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, KIMI_MODEL_*…) so an
  // attending human's interactive agent comes up authenticated on the SAME provider the headless
  // run used, AND the per-xell identity token so that human's `zee` CLI (and any command in the
  // login shell) can reach the queenzee's /api/xell/self/* verbs. A docker-exec -e run gets these
  // directly; an SSH login does not, so they must land in /etc/environment too.
  const envLines = Object.entries(agentEnv)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  // which agent CLI owns this cxell — zee-attach.sh branches its resume/attach flow on it
  if (runtimeKey) envLines.push(`ZEE_RUNTIME=${runtimeKey}`);
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

// Run the zee: the runtime adapter's CLI headless inside the cxell (claude -p / codex exec /
// kimi --print — see cxell-runtimes.js), its output translated to the normalized event stream.
// Returns { proc, done } where done resolves with the final `result` event (or rejects on a
// transport failure). onEvent(obj) fires per normalized event — init (session id), assistant
// turns, result. Bypass/auto mode inside is safe HERE and only here — the cxell is the
// permission system, and every adapter runs its CLI's equivalent of skip-permissions.
export function runZee({ ctx, name, prompt, model, adapter = CLAUDE_ADAPTER, token, xellToken, baseUrl = null, onEvent }) {
  const agentEnv = adapter.env({ token, baseUrl, model });
  const cmd = ['exec', '-i',
    ...Object.entries(agentEnv).filter(([, v]) => v !== null && v !== undefined && v !== '')
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    // The per-xell identity token: the cxell zee's `zee` CLI (and any /api/xell/self/* call) reads
    // it to prove WHICH xell is calling. Injected alongside the vendor credential — same door, and
    // the firewall already allows the queenzee host:port.
    ...(xellToken ? ['-e', `ZEEHIVE_XELL_TOKEN=${xellToken}`] : []),
    '-e', `ZEEHIVE_API=${config.cxellApiBase}`,   // same reason as openCxellSsh's CXELL_ENV line
    name, 'bash', '-lc',
    `cd /work/repo && ${adapter.execCmd({ model })}`];
  const full = [...(ctx && ctx !== 'default' ? ['--context', ctx] : []), ...cmd];
  const p = spawn('docker', full, { windowsHide: true });
  let buf = '', err = '', result = null;
  const emit = (ev) => {
    if (ev?.type === 'result') result = ev;
    try { onEvent?.(ev); } catch (e) { logline('cxell', `onEvent threw: ${e.message}`); }
  };
  const parser = adapter.makeParser(emit);
  const feed = (line) => {
    if (!line.trim()) return;
    try { parser.line(line); } catch (e) { logline('cxell', `${adapter.key} parser threw: ${e.message}`); }
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
      // vendor adapters synthesize an error result here when the CLI died before its own final
      // event (e.g. a bad API key) — that's what turns an auth failure into a READABLE feed
      // event instead of a bare transport error
      try { parser.close(code, err.trim().split('\n').slice(-3).join(' ').slice(0, 400)); }
      catch (e) { logline('cxell', `${adapter.key} parser close threw: ${e.message}`); }
      if (result) resolve({ code, result });
      else reject(new Error(`cxell ${adapter.bin} exited ${code} with no result event: ${err.slice(0, 400)}`));
    });
  });
  p.stdin.write(adapter.stdinPayload ? adapter.stdinPayload(prompt) : prompt);
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
  try {
    const bundle = await exportCxellDiff({ ctx, name, toDir: tmp });
    if (!bundle) return { collected: false, reason: 'the cxell has no commits beyond the worktree' };
    return await reconcileBundleIntoWorktree(worktree, { bundle, slug });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The pure-git core of the collect: fetch the cxell's bundle into a staging ref and fast-forward the
// worktree branch onto it. Factored out of collectCxellDiffToWorktree so it can be exercised WITHOUT
// docker (the bundle is just a file), which is how the stranding-vs-reconcile behaviour is tested.
//
// THE STRANDING FIX (highest-value change): a --ff-only miss used to `update-ref -d` the staging ref
// and throw — which left the cxell's commits reachable from NO ref and NO reflog, i.e. GC-eligible.
// That is how a xell's work got silently destroyed. Now, on a miss, we RENAME the staging ref to a
// durable `refs/zeehive/stranded/<slug>` so the work is anchored, GC-proof and recoverable, and we
// name that ref in the thrown error. A failure is "blocked", never "lost".
export async function reconcileBundleIntoWorktree(worktree, { bundle, slug }) {
  const git = (args) => new Promise((resolve, reject) => {
    const g = spawn('git', ['-C', worktree, ...args], { windowsHide: true });
    let out = '', err = '';
    g.stdout.on('data', (d) => (out += d.toString()));
    g.stderr.on('data', (d) => (err += d.toString()));
    g.on('error', reject);
    g.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`git ${args[0]} exited ${c}: ${err.slice(0, 300)}`))));
  });
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const strandedRef = `refs/zeehive/stranded/${String(slug).replace(/[^A-Za-z0-9._/-]/g, '-')}`;
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
  try {
    await git(['merge', '--ff-only', target]);
  } catch (e) {
    // ff-only MISS. NEVER strand: anchor the collected commits under a durable ref before releasing
    // the staging ref, so the work survives GC and a human (or a later self-heal) can recover it.
    await git(['update-ref', strandedRef, target]).catch(() => {});
    await git(['update-ref', '-d', 'refs/zeehive/cxell-land']).catch(() => {});
    logline('cxell', `${slug}: cxell commits do NOT fast-forward the worktree — anchored at ${strandedRef} @ ${String(target).slice(0, 8)} (NOT stranded)`);
    const err = new Error(
      `the cxell's commits do not fast-forward the worktree branch — it moved since caging. `
      + `Your commits are SAFE and anchored at ${strandedRef} (${String(target).slice(0, 8)}) — nothing was lost. (${e.message})`);
    err.strandedRef = strandedRef;
    err.strandedHead = target;
    throw err;
  }
  await git(['update-ref', '-d', 'refs/zeehive/cxell-land']).catch(() => {});
  const head = await git(['rev-parse', 'HEAD']);
  return { collected: true, head, branch };
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
export async function nudgeCxellZee({ ctx = 'default', name, sessionId, prompt, model, adapter = CLAUDE_ADAPTER, token = null, xellToken = null, timeoutMs = 1200000 } = {}) {
  if (!adapter.resumable) throw new Error(`runtime ${adapter.key} cannot resume a headless session`);
  let vendorTok = token, identTok = xellToken;
  if (!vendorTok || !identTok) {
    try {
      const r = await dk(ctx, ['exec', '-u', '0', name, 'cat', '/etc/environment'], { timeoutMs: 15000 });
      const pick = (k) => (r.out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
      vendorTok = vendorTok || pick(adapter.tokenEnvKey);
      identTok = identTok || pick('ZEEHIVE_XELL_TOKEN');
    } catch { /* fall through with whatever the caller gave us */ }
  }
  const env = Object.entries(adapter.env({ token: vendorTok, model }))
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  if (identTok) env.push('-e', `ZEEHIVE_XELL_TOKEN=${identTok}`);
  // the adapter sanitizes the session id before interpolating it (claude/codex); kimi resumes by
  // workdir (--continue) and ignores the id entirely
  const cmd = ['exec', '-i', ...env, name, 'bash', '-lc',
    `cd /work/repo && ${adapter.execCmd({ model, resumeSid: sessionId || '' })}`];
  return dk(ctx, cmd, { input: adapter.stdinPayload ? adapter.stdinPayload(prompt) : prompt, timeoutMs });
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

// WRITE a file INTO a live cxell's /work/repo — the delivery path for an operator's rich message
// (image attachments + a long-text body handed over as real files the zee can open, rather than
// mashed through the terminal). The write runs as the container's DEFAULT user — the same user the
// repo is cloned as — so whatever lands is readable by the zee. base64 payloads are decoded in the
// container; text payloads are written verbatim. The relative path is confined to the repo (leading
// slashes and any `..`/`.` segments are stripped) so a message can never escape /work/repo. Rejects
// on a docker/transport failure; the caller decides whether that is fatal.
export async function writeFileIntoCxell({ ctx = 'default', slug, relPath, base64 = null, text = null, timeoutMs = 30000 }) {
  const name = cxellName(slug);
  const safe = String(relPath).replace(/\\/g, '/').split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
  if (!safe) throw new Error('empty target path');
  const full = `/work/repo/${safe}`;
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const dir = full.replace(/\/[^/]*$/, '');
  const decode = base64 != null;
  const cmd = ['exec', '-i', name, 'bash', '-lc',
    `mkdir -p ${sq(dir)} && ${decode ? 'base64 -d' : 'cat'} > ${sq(full)}`];
  await dk(ctx, cmd, { input: decode ? String(base64) : String(text ?? ''), timeoutMs });
  return { path: full, rel: safe };
}

export async function removeCxell({ ctx, slug }) {
  await dk(ctx, ['rm', '-f', cxellName(slug)]).catch(() => {});
  // pre-rename containers (zee_cage_<slug>) from the old-vocabulary era — idempotent, so this
  // line retires with the last of them
  await dk(ctx, ['rm', '-f', `zee_cage_${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`]).catch(() => {});
}
