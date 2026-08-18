// The CXELL driver: everything the queenzee does to run a zee's agent CLI (claude, codex, or
// kimi — see cxell-runtimes.js) INSIDE a per-xell zee-agent container (image
// docker/zeehive/Dockerfile.zee-agent) instead of on the host.
//
// Why: host-side confinement is prompt + regex (hooks/prod-guard.mjs admits it is not
// adversary-proof). The cxell makes it structural — the container sees a private clone of the
// xell's branch, no docker socket, no host mounts, non-root, and an egress policy that DROPS the
// fleet's live production databases (proven 2026-07-19: without it, Docker's bridge NAT reaches
// the prod db on the LAN). The egress list is deliberately NOT a per-vendor allow-list: which AI
// provider a zee runs on is decided at dispatch, and a cage that only let one vendor's API
// through would silently be a claude-only cage — see docker/zeehive/cxell-firewall.sh.
//
// The clone is a git BUNDLE of the worktree's HEAD — a private object store, deliberately not
// a mount: worktree .git files carry absolute host paths that don't resolve in Linux, and a
// shared object store would leak the xource into the cxell. The worktree's generated
// .zeehive.env (gitignored, so absent from the bundle) is copied in separately — it carries
// the xell's ports and DATABASE_URL. Pasted prompt-attachments (also gitignored) are copied in
// the same way, so a prompt that hands the zee an image path can actually Read it. Work products
// stay in the container until collected (exportCxellDiff) — landing them is the human-gated step.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { logline } from './logbus.js';
import { config } from '../config.js';
import { adapterFor, CLAUDE_ADAPTER, AUTH_MARKERS, SEED_MARKERS, AGENT_PROC_PATTERN,
         HEADLESS_PROC_PATTERN, resultFrom, TURN_HOOK_MARKERS } from './cxell-runtimes.js';
import { credentialVendorMismatch, scrubEnvValue } from './provider-tokens.js';
import { gatewayEnv } from './gateway.js';
import { cxellCacheRunArgs, cxellCacheFixupCommand, CXELL_NPM_CACHE_DIR } from './npm-cache.js';
import { prepUserScript, prepRootScript, parsePrepSteps, summarizePrepSteps,
         hasAptStep, normalizeSpawnPrep, preppedImageTag, preppedDockerfile,
         templateHash, bakesImage } from './spawn-prep.js';
import { classifyMergeOutput } from '../queenzee/xellgit.js';

// CXELL_IMAGE override: a bootstrap install (published images, no local build) points this at
// ghcr — matching the CXELL_IMAGE the self-ship scripts already honor for their rebuild.
const IMAGE = process.env.CXELL_IMAGE || 'zeehive/zee-agent';

// Same switch every other real-side-effect module reads (intake, pool, xell-db, machines, harness,
// and the .zeehive.env reconcile in provision.js): 'real' touches machines, anything else models.
// The fleet-wide attend-path sweep below obeys it — see refreshZeeLiveInLiveCxells.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';
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

// What the child SAID, for a message a human reads — BOTH streams, always. Never `err || out`: that
// expression is stderr ALONE whenever the child wrote any (npm always does), and it is how warmCxell
// lost a WARM_CI_FAILED marker that was sitting on stdout the whole time and reported a broken
// lockfile as a network hiccup. A verdict must survive being put in an error message.
function dkSaid({ out, err }, cap = 400) {
  const parts = [];
  const e = String(err || '').trim(), o = String(out || '').trim();
  if (e) parts.push(`stderr: ${e.slice(0, cap)}`);
  if (o) parts.push(`stdout: ${o.slice(0, cap)}`);
  return parts.length ? parts.join(' | ') : 'no output on either stream';
}

// docker CLI runner. `--context` (not env) so a queenzee env leak can never re-aim a cxell;
// input is piped to stdin; onLine streams stdout lines (for the NDJSON event stream).
//
// A NON-ZERO EXIT REJECTS, and that stays the default: for nearly every call here the exit code IS
// the answer (pgrep finds no agent, inspect finds no container, a port is already allocated), and
// the callers are written around the rejection. What the rejection now CARRIES is the fix: both
// streams in the message (dkSaid) and the raw `{ code, out, err }` on `err.dk`, so an exec's own
// statement of what it did can no longer be destroyed by the way its failure is reported.
//
// AN EXEC THAT STATES ITS OWN OUTCOME ON STDOUT DOES NOT COME THROUGH HERE — it uses dkVerdict
// (below). Three separate callers lost their verdict to this function's contract in one day: one
// rejected before the verdict was read (writeFileIntoCxellIfChanged, a healthy SAME recorded as a
// fleet-wide error), one read `String(result)` and got '[object Object]' (writeGeneratedDocIntoCxell,
// every written doc reported skipped), and one read the rejection MESSAGE and saw stderr only
// (warmCxell, lock drift reported as a network hiccup). dkVerdict is the one door for that shape.
// A truncated stdin still rejects either way (below): a payload we could not deliver is not an
// outcome to interpret.
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
      if (code === 0) { resolve({ code, out, err }); return; }
      // Both streams in the message, and the streams themselves on the Error: an exec that FAILED may
      // still have said what it did, and dkVerdict reads `err.dk` rather than re-running anything.
      const e = new Error(`docker ${args.slice(0, 2).join(' ')} exited ${code}: ${dkSaid({ out, err })}`);
      e.dk = { code, out, err };
      reject(e);
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

// ── dkVerdict — the ONE runner for an exec whose SCRIPT SAYS WHAT IT DID ──────────────────────────
//
// Some of the execs here are not "run a command and check it worked": the script INSIDE the cage
// makes the decision (did the bytes change? is the path tracked? did `npm ci` refuse the lockfile?)
// and prints its verdict on stdout. For those, the container's statement is the outcome and the exit
// code is diagnosis — and getting that backwards shipped three separate bugs in ONE DAY, all three
// found only in production, each by a different zee:
//
//   • writeFileIntoCxellIfChanged — dk rejected on the non-zero exit before the verdict was read, so
//     the healthy no-op SAME became env_cxell_error on every unchanged xell in the fleet (45d3ebe);
//   • writeGeneratedDocIntoCxell — read `String(result)` where dk resolves an OBJECT, so the verdict
//     was the literal '[object Object]' and every doc the cage really wrote reported skipped (7339182);
//   • warmCxell — read the REJECTION message, which was stderr alone, so the WARM_CI_FAILED marker on
//     stdout never reached the classifier and lock drift was reported as a network hiccup (28fa29f).
//
// One shape, three ways to lose the same value. So the shape gets one door, and the door cannot be
// walked through wrongly: this helper NEVER lets the exit code decide, ALWAYS reads stdout, and hands
// back the verdict as a STRING (never an object to stringify by accident). The caller declares the
// markers its script prints — required, not optional, because that declaration is what a guard test
// can enumerate, and an undeclared marker is a fourth instance waiting to happen.
//
// Resolves { verdict, verdicts, code, out, err }:
//   verdict  — the LAST declared marker on stdout (a script prints its decision last), or null;
//   verdicts — every declared marker seen, in order, for a script that prints more than one
//              (warmCxell's WARM_LOCK_DIRTY rides alongside its WARM_OK / WARM_CI_FAILED).
// It rejects ONLY when the exec never ran at all — spawn failure, timeout, truncated stdin. There is
// no verdict to read then, and "we could not ask" is not an outcome to interpret.
//
// WHAT IT DELIBERATELY DOES NOT DO: decide what a MISSING verdict means. That is caller policy and it
// differs — the env write throws (it must never guess at file contents), the doc injector reports
// `skipped:'unknown'`, the warm classifies and carries on. Centralising that would have been the same
// mistake in a new place.
async function dkVerdict(ctx, args, { markers, label = null, ...opts } = {}) {
  const want = (Array.isArray(markers) ? markers : []).filter(Boolean);
  if (!want.length) throw new Error('dkVerdict: the caller must declare the markers its script prints');
  let r;
  try {
    r = await dk(ctx, args, opts);
  } catch (e) {
    // `e.dk` is set only for an exec that RAN and exited non-zero — the case whose stdout we must
    // still read. Anything else (spawn, timeout, truncated payload) has no verdict in it: rethrow.
    if (!e?.dk) throw e;
    r = e.dk;
  }
  const verdicts = [];
  for (const line of String(r.out || '').split('\n')) {
    for (const m of want) {
      // whole-token match, so WARM_OK is never found inside a longer marker or a path
      if (new RegExp(`(^|[^A-Za-z0-9_])${m}([^A-Za-z0-9_]|$)`).test(line)) verdicts.push(m);
    }
  }
  const verdict = verdicts.length ? verdicts[verdicts.length - 1] : null;
  // TRUSTED, NEVER HIDDEN. Believing the verdict over the exit code must not mean swallowing the
  // disagreement — that is the same bug facing the other way, and it would hide on the success path
  // where nobody looks. One line, from one place, for every caller of this shape.
  if (verdict && r.code !== 0) {
    logline('cxell', `${label || `docker ${args.slice(0, 2).join(' ')}`}: reported ${verdict} but the exec `
      + `exited ${r.code} — trusting the verdict (it is the container's own statement of what happened) `
      + `and saying so rather than hiding it: ${dkSaid(r, 120)}`);
  }
  return { ...r, verdict, verdicts };
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

// Is the QUEENZEE'S OWN headless turn in flight in this cxell right now? The narrower sibling of
// cxellZeeActive, which also matches the interactive `claude --resume` zee-attach.sh leaves sitting in
// the pane — an agent nobody is driving. The distinction decides whether it is safe to START a turn
// (fleet PLAY asks this before resuming a zee: two headless runs on one session double-drive it),
// where the broad probe would answer "busy" for every cage anyone has ever opened a terminal on.
// pgrep exits 1 → dk rejects → false, the same contract as cxellZeeActive.
export async function cxellHeadlessActive({ ctx = 'default', slug }) {
  try {
    await dk(ctx, ['exec', cxellName(slug), 'pgrep', '-f', HEADLESS_PROC_PATTERN], { timeoutMs: 8000 });
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

// ── AFTER THE MACHINE COMES BACK: read a cage's state, start it, re-open its door ────────────────
//
// A cxell is created with `docker run -d` and NO restart policy (cxellRunArgs), and its CMD is
// `sleep infinity` — everything that makes it a cage (sshd, the egress seal) is a root EXEC done
// once at spawn. So a host reboot leaves every live xell's cage EXITED, with its work, its branch,
// its /etc/environment and its agent session all intact on the container's own filesystem and
// nothing at all running. Until queenzee/cxell-recover.js, nothing in the fleet started them again.
//
// THE RESTART POLICY IS DELIBERATELY NOT THE FIX. `--restart unless-stopped` would bring the cage
// back the moment dockerd starts — WITHOUT its firewall seal, because iptables rules live in the
// container's network namespace and die with it. A cage that is up and unsealed can reach the
// fleet's live production databases, and it looks perfectly healthy while it does. Starting the
// cage and re-sealing it are therefore ONE act, performed by the queenzee (cxell-recover.js), and
// these three primitives are its steps.

// The container's docker state, as its own word: running | exited | created | paused | restarting |
// dead — or 'missing' when the daemon ANSWERED and has no such container, or 'unknown' when we could
// not ask at all. That last distinction is the containers.js doctrine and it is load-bearing here: a
// daemon that is still starting must never be read as "the fleet's cages are gone", because the
// recovery's answer to 'missing' (report a cage that cannot be restarted) is very different from its
// answer to 'unknown' (say nothing, try again next tick).
export async function cxellState({ ctx = 'default', slug }) {
  try {
    const r = await dk(ctx, ['inspect', '-f', '{{.State.Status}}', cxellName(slug)], { timeoutMs: 15000 });
    const state = String(r.out || '').trim().toLowerCase();
    return { state: state || 'unknown', missing: false, error: state ? null : 'docker inspect printed no state' };
  } catch (e) {
    const said = String(e?.dk ? dkSaid(e.dk, 200) : e.message || '');
    if (/no such (object|container)/i.test(said)) return { state: 'missing', missing: true, error: null };
    return { state: 'unknown', missing: false, error: said.slice(0, 300) };
  }
}

// Start a cage that exists and is stopped. Idempotent by docker's own contract (starting a running
// container is a no-op), and it keeps everything the container already has — its filesystem, its
// published SSH port, its labels, its network. It does NOT recreate anything: a recreate would
// destroy work that has not been collected yet, which is exactly what must never happen here.
export async function startCxell({ ctx = 'default', slug, timeoutMs = 60000 }) {
  const name = cxellName(slug);
  const r = await dk(ctx, ['start', name], { timeoutMs });
  return { started: true, name, out: String(r.out || '').trim() };
}

// Stop a cage again — the UNDO of startCxell, with two callers, both in queenzee/cxell-recover.js:
// a restart whose egress RE-SEAL failed, and the first half of a human's forced restart of a cage
// that docker calls running while nothing inside it answers. A running cage with no iptables rules can reach
// the fleet's live production databases, which is strictly more exposed than the stopped cage the
// recovery found, so the honest move is to put it back where it was and try the whole sequence again
// next tick. It stops a container; it removes nothing, so the zee's work is untouched.
export async function stopCxell({ ctx = 'default', slug, timeoutMs = 60000 }) {
  const name = cxellName(slug);
  const r = await dk(ctx, ['stop', name], { timeoutMs });
  return { stopped: true, name, out: String(r.out || '').trim() };
}

// Re-run cxell-sshd.sh to bring the attend door back up after a restart: sshd is a process, so it
// died with the container even though its host keys, its config and the zee's authorized_keys did
// not. The script is idempotent and re-reads what is already on disk.
//
// ⚠ NO ENV IS PASSED, and that is not an oversight. cxell-sshd.sh OVERWRITES /etc/environment
// whenever CXELL_ENV is set, and openCxellSsh always sets it (it appends ZEEHIVE_API
// unconditionally) — so calling openCxellSsh with no credentials to re-open a door would replace a
// live cage's provider token and identity token with a one-line file, and the zee would come back
// unable to authenticate to anything. The restart path has nothing new to write: every line is
// already in the container's own /etc/environment.
export async function restartCxellSshd({ ctx = 'default', slug, timeoutMs = 60000 }) {
  const name = cxellName(slug);
  const r = await dk(ctx, ['exec', '-u', '0', name, 'bash', '/usr/local/bin/cxell-sshd.sh'], { timeoutMs });
  return String(r.out || '').trim();
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
// CONTENT conflict — is the one thing handed back to the model, so a genuine conflict reads 'conflict'
// (the zee's to resolve, in place — MERGE_HEAD is left set) and an operational failure reads 'error'
// (nothing for the zee to fix in code). Returns { state, ... } where state is:
//   'up-to-date' — the cxell already contains the xource tip; nothing to do.
//   'merged'     — merged origin/main in cleanly; head is the new merge commit.
//   'conflict'   — a merge is in progress in the cxell for the zee to resolve (a content conflict this
//                  sync hit, or one an EARLIER sync left and the zee has not concluded).
//   'error'      — an operational failure (delivery, or a merge that could not start).
//   'unknown'    — the cxell did not say what its merge did. The tree is left EXACTLY as it is.
//
// ⚠ THE DATA-LOSS RULE THIS FUNCTION IS BUILT AROUND. `git merge --abort` throws away a working tree
// and an index, so it may only ever run when we KNOW there is nothing of the zee's in them. A caged
// zee resolving a conflict by hand has its whole resolution in exactly those two places, and nothing
// of it is committed until it says so — `merge --abort` deletes it with no way back (verified: a
// staged resolution reverts to the pre-merge blob and `git status` goes clean). So the abort is gated
// on the SCRIPT'S OWN STATEMENT of what it just did, never on a classified message, and every path
// where the outcome is not known leaves the tree untouched. See the abort below for the one path that
// survives, and dk-verdict-contract.test.mjs / cxell-sync-abort-safety.test.mjs for the fence.
const CX_IDENTITY = `-c user.name='Zeehive queenzee' -c user.email=queenzee@zeehive.local`;

// The merge, as a script that SAYS WHAT IT DID on stdout — the shape dkVerdict exists for (see there:
// three callers lost the same value in one day by deciding from something other than the verdict).
// Exported with a repoDir like warmInstallScript so a test can run the real thing against a real
// throwaway repo, which is the only way to prove the four git states below are told apart.
//
// It answers with exactly one marker, and each one is a FACT the script observed, not an inference:
//   MERGE_HELD    — a merge was ALREADY in progress before we touched anything, so we ran no merge at
//                   all. This is the zee mid-resolution (git refuses with "You have not concluded your
//                   merge", whose text classifies as an operational error — which is precisely how an
//                   abort used to eat the resolution).
//   MERGE_OK      — merged cleanly.
//   MERGE_CONFLICT— unmerged paths in the index: a real content conflict, the zee's to resolve.
//   MERGE_STOPPED — the merge WE started is in progress with NO unmerged path (e.g. a hook declined
//                   the merge commit): nothing to resolve, and nothing of the zee's inside it.
//   MERGE_FAILED  — the merge never started (bad ref, unreadable object, local changes in the way),
//                   so there is no merge in progress and nothing to abort.
// `2>&1` keeps git's own lines (including "CONFLICT …") on stdout, where the verdict is read from and
// where they can be reported to the zee verbatim.
export function syncMergeScript(repoDir = '/work/repo') {
  return [
    `cd ${repoDir} || { echo "cannot enter ${repoDir}"; echo MERGE_FAILED; exit 0; }`,
    // NEVER start a merge on top of one we did not start, and never touch it. A zee halfway through a
    // resolution has staged files and no commit; git would refuse anyway, and the refusal is what used
    // to be classified as operational and aborted.
    'if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then',
    '  echo "a merge was already in progress in this cxell — left untouched:"',
    '  git status --porcelain | head -40',
    '  echo MERGE_HELD; exit 0',
    'fi',
    `git ${CX_IDENTITY} merge --no-edit refs/remotes/origin/main 2>&1; rc=$?`,
    'if [ "$rc" = 0 ]; then echo MERGE_OK',
    'elif [ -n "$(git ls-files --unmerged)" ]; then echo MERGE_CONFLICT',
    'elif git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then echo MERGE_STOPPED',
    'else echo MERGE_FAILED; fi',
  ].join('\n');
}
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

  // MERGE, through dkVerdict — the ONE runner for an exec whose script states its own outcome. It
  // reads the verdict off STDOUT whatever the exec exited with, so the classification can never again
  // come from a REJECTION MESSAGE: that message is built for a human (both streams, each capped at 400
  // chars), and reading a merge's state out of it made a truncated conflict look operational — which
  // ran `git merge --abort` on a tree that had a conflict in it.
  let r = null, failure = null;
  try {
    r = await dkVerdict(ctx, ['exec', name, 'bash', '-lc', syncMergeScript()], {
      markers: ['MERGE_OK', 'MERGE_CONFLICT', 'MERGE_STOPPED', 'MERGE_FAILED', 'MERGE_HELD'],
      label: `${slug}: sync merge of ${ref}`, timeoutMs: 180000,
    });
  } catch (e) { failure = e; }

  // UNKNOWN — either the exec never ran (spawn failure, timeout: the merge may still be running in
  // there) or it ran and did not state an outcome we declared. Both mean we do not know what is in
  // that tree, so we DO NOT TOUCH IT and we say so loudly: a zee can resolve a conflict it was told
  // about, and cannot recover work an abort deleted.
  if (failure || !r.verdict) {
    const said = failure ? String(failure.message) : dkSaid(r, 1200);
    logline('cxell', `${slug}: sync merge of ${ref} → UNKNOWN — the cxell did not report what the merge did, `
      + `so its tree was LEFT EXACTLY AS IT IS (no abort, no reset). A human should look inside `
      + `/work/repo (\`git status\`): ${said.slice(0, 300)}`);
    return { state: 'unknown', stage: 'merge', output: said.slice(-1200), tip: delivery.tip, ref };
  }

  if (r.verdict === 'MERGE_OK') {
    const head = (await dk(ctx, ['exec', name, 'bash', '-lc', 'cd /work/repo && git rev-parse HEAD'], { timeoutMs: 15000 })).out.trim();
    logline('cxell', `${slug}: merged ${ref} into the cxell cleanly → ${String(head).slice(0, 8)}`);
    return { state: 'merged', head, tip: delivery.tip, ref };
  }
  const out = String(r.out || '');
  // A merge in progress is the zee's, whether this sync made it (MERGE_CONFLICT: unmerged paths) or an
  // earlier one did and the zee is mid-resolution (MERGE_HELD: we ran no merge at all). Left in place,
  // reported as theirs.
  if (r.verdict === 'MERGE_CONFLICT' || r.verdict === 'MERGE_HELD') {
    const held = r.verdict === 'MERGE_HELD';
    logline('cxell', `${slug}: sync merge of ${ref} → conflict`
      + (held ? ' — a merge was ALREADY in progress in the cxell, so nothing was merged and nothing touched'
              : ' — left in progress in the cxell for the zee to resolve'));
    return { state: 'conflict', held, output: out.slice(-1200), tip: delivery.tip, ref };
  }
  if (r.verdict === 'MERGE_STOPPED') {
    // THE ONLY ABORT LEFT, and the only one that can be safe: the script itself observed that (a) no
    // merge was in progress before it ran, (b) the merge it started is in progress, and (c) there are
    // ZERO unmerged paths — so there is no conflict resolution to destroy and the merge being undone is
    // one the queenzee made seconds ago (a declined pre-merge-commit hook, say). Nothing else aborts.
    await dk(ctx, ['exec', name, 'bash', '-lc', 'cd /work/repo && git merge --abort'], { timeoutMs: 15000 }).catch(() => {});
    logline('cxell', `${slug}: sync merge of ${ref} → error (the merge stopped with no conflicted file — `
      + `nothing for the zee to resolve, so the merge WE started was aborted)`);
    return { state: 'error', stage: 'merge', output: out.slice(-1200), tip: delivery.tip, ref };
  }
  // MERGE_FAILED — the merge never started, so there is nothing in progress and nothing to abort. What
  // KIND of failure it was still comes from git's own words, with the SAME predicate the host-side
  // catch-up uses (classifyMergeOutput): "local changes would be overwritten by merge" is the zee's to
  // sort out, an unreadable object or a bad ref is not. Reading that from the script's captured stdout
  // is safe; reading it from a rejection message was not.
  const cls = classifyMergeOutput(out);
  logline('cxell', `${slug}: sync merge of ${ref} → ${cls.state} (the merge did not start; nothing in `
    + `progress, so nothing was aborted)`);
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
// Run ONE shell command inside a cxell container and return the raw { code, out, err }.
// The generic escape hatch for a one-off read the rest of cxell.js does not wrap (today: the
// conversation-archive path reading the zee's own session transcript, lib/conversations.js).
// `cmd` runs under `bash -lc` as the container's default user, exactly like the execs above.
export async function execInCxell({ ctx = 'default', slug, cmd, input = undefined, timeoutMs = 20000 } = {}) {
  return dk(ctx, ['exec', cxellName(slug), 'bash', '-lc', cmd], { input, timeoutMs });
}

// Read a LIVE cage's /etc/environment — the credential projection openCxellSsh wrote at spawn. The
// injection path (lib/credential-inject.js) reads it so it can rewrite ONLY the credential lines and
// leave every other line (ZEEHIVE_XELL_TOKEN, ZEEHIVE_API, ZEE_RUNTIME, PATH, …) intact.
export async function readCxellEnvironment({ ctx = 'default', slug, timeoutMs = 20000 } = {}) {
  const r = await execInCxell({ ctx, slug, cmd: 'cat /etc/environment 2>/dev/null || true', timeoutMs });
  return r.out;
}

// Write a LIVE cage's /etc/environment as ROOT — the other half of the injection path. `text` is the
// full new file bytes (the pure rewriteCageEnv result). The write is ATOMIC (finding [4] of the
// credential-injection review): the payload goes to a temp file in /etc first, then `mv` renames it
// over /etc/environment. A plain `cat > /etc/environment` truncates before writing, so a dead exec
// mid-write could strand a cage with an EMPTY file — no ZEEHIVE_XELL_TOKEN, no ZEEHIVE_API, and the
// zee's `zee` CLI would refuse everything. With a rename, the old file stays fully intact until the
// new one is complete. /etc/environment is root-owned and root-only (0600 — the spawn's
// cxell-sshd.sh writes it `chmod 600`), so the exec runs as uid 0 and the temp file is mode-fixed
// to 0600 (mktemp makes 0600, then `chmod` re-asserts it before the rename) — an injection must
// NEVER widen the file from root-only to world-readable. Resolves { ok, path } and rejects only if
// the exec never ran at all.
export async function writeCxellEnvironment({ ctx = 'default', slug, text, timeoutMs = 30000 } = {}) {
  const script = [
    'set -e',
    'tmp="$(mktemp /etc/environment.XXXXXX)"',
    'cat > "$tmp"',
    'chmod 0600 "$tmp"',
    'mv -f "$tmp" /etc/environment',
    'echo WROTE',
  ].join('\n');
  const r = await dkVerdict(ctx, ['exec', '-u', '0', '-i', cxellName(slug), 'bash', '-lc', script],
                            { markers: ['WROTE'], input: String(text ?? ''), timeoutMs });
  return { ok: r.verdict === 'WROTE', path: '/etc/environment' };
}

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
// The `docker run` argv for a cxell, as data — pure, so a test can assert what a cage is created
// with (the shared npm cache mount included) without a daemon, the same way the file-install
// commands are asserted.
export function cxellRunArgs({ name, net, port, img, xellId, prep = null }) {
  return ['run', '-d', '--name', name, '--network', net, '--cap-add', 'NET_ADMIN',
    '-p', `127.0.0.1:${port}:22`,
    // ONE npm cache for the whole fleet: without it every cxell re-downloads the same tarballs
    // into its own empty ~/.npm, which is the repetition ticket #7 is about. Empty when disabled.
    // The project's SPAWN TEMPLATE (migration 121) decides the mode, and whether an apt archive
    // cache is mounted alongside — the second one only where the template installs packages, so a
    // cage that never runs apt is unchanged.
    ...cxellCacheRunArgs({ npm: prep?.cache?.npm, apt: prep?.cache?.apt, aptCache: hasAptStep(prep) }),
    '--label', 'zeehive.cxell=1', '--label', `zeehive.xell=${xellId || ''}`, img];
}

// ── THE PREPPED CXELL IMAGE (spawn template `when: image|provision`) ───────────────────────────
//
// The apt half of a project's prep, baked into an image ONCE instead of installed into every cage.
// Two entry points, and which one you call is the whole point of the feature:
//
//   ensurePreppedImage() BUILDS if it is missing — called from the POOL, on the pool's clock, where
//                        a two-minute apt run costs a human nothing.
//   preppedImageIfPresent() NEVER builds — called from DISPATCH, which must not wait for apt. A
//                        missing image there is not an error: the cage falls back to the base image
//                        and the root prep installs the packages the old way. Slower, never wrong.
//
// BUILD_MODE=simulate (every nested queenzee, including the one a zee runs in its own xell) skips
// the build entirely: this writes a real image to a real daemon, and a subject under test does not.
const IMAGE_MODE = () => (process.env.BUILD_MODE === 'simulate' ? 'simulate' : 'real');

export async function preppedImageIfPresent({ ctx = 'default', baseImage, prep }) {
  const tag = preppedImageTag(baseImage || IMAGE, prep);
  if (!tag) return null;
  try {
    await dk(ctx, ['image', 'inspect', tag], { timeoutMs: 20000 });
    return tag;
  } catch {
    return null;   // not built yet (or a daemon that cannot answer) — the caller falls back
  }
}

export async function ensurePreppedImage({ ctx = 'default', baseImage, prep, label = '' }) {
  const base = baseImage || IMAGE;
  const tag = preppedImageTag(base, prep);
  if (!tag) return { tag: null, reason: 'the template installs no packages — the base image is the prepped image' };
  if (IMAGE_MODE() === 'simulate') return { tag: null, reason: 'BUILD_MODE=simulate — no image is built' };
  const have = await preppedImageIfPresent({ ctx, baseImage: base, prep });
  if (have) return { tag: have, built: false };
  const dockerfile = preppedDockerfile(base, prep);
  const started = Date.now();
  try {
    // `docker build -` reads the Dockerfile from stdin with NO context — which is exactly right
    // here: nothing is COPYed in, the whole recipe is FROM + one RUN.
    await dk(ctx, ['build', '-t', tag, '-'], { input: dockerfile, timeoutMs: 1800000 });
  } catch (e) {
    // Never fatal: a fleet with no prepped image installs at dispatch, like it always did.
    logline('pool', `${label || 'cxell'}: could not bake the prepped image ${tag} (${String(e.message).slice(0, 200)}) — `
      + 'cages fall back to the base image and install their packages at dispatch');
    return { tag: null, error: e.message };
  }
  logline('pool', `${label || 'cxell'}: baked ${tag} in ${Math.round((Date.now() - started) / 1000)}s — `
    + 'every cage of this template now starts with its packages already installed');
  return { tag, built: true };
}

// `reuse` keeps an EXISTING cage instead of recreating it — the dispatch half of a pre-warmed cage
// (`when: 'provision'`), where the container was created and installed hours ago by provisioning.
// It is honoured only when the cage is RUNNING and on the image we want; anything else (stopped,
// stale image, unreadable) falls through to the recreate below, which is today's behaviour.
export async function ensureCxell({ ctx, slug, xellId, network, sshPort, image, prep = null, reuse = false }) {
  const name = cxellName(slug);
  const img = image || IMAGE;   // per-project override (e.g. the Android SDK variant); else the base
  const net = network || 'zee-hive-net';
  if (reuse) {
    // One inspect answers all three questions: is it running, is it the image we want, and which
    // host port is its ssh already published on (we must return the port it HAS, not the port we
    // would have picked — the attend door is already bound to it).
    const kept = await dk(ctx, ['inspect', '-f',
      '{{.State.Running}} {{.Config.Image}} {{(index (index .NetworkSettings.Ports "22/tcp") 0).HostPort}}', name],
      { timeoutMs: 20000 }).catch(() => null);
    const [running, onImage, port] = String(kept?.out || '').trim().split(/\s+/);
    if (running === 'true' && onImage === img && Number(port) > 0) {
      logline('cxell', `${name}: reusing the cage provisioning already prepared (image ${img}, ssh :${port}) — `
        + 'nothing to install at dispatch');
      return { name, sshPort: Number(port), reused: true };
    }
    if (kept) {
      logline('cxell', `${name}: a pre-warmed cage exists but cannot be reused (running=${running}, image=${onImage}) — `
        + 'rebuilding it, which is exactly what a dispatch has always done');
    }
  }
  await dk(ctx, ['network', 'create', '--label', 'zeehive.cxell=net', net]).catch((e) => {
    if (!/already exists/i.test(e.message)) throw e;
  });
  await dk(ctx, ['rm', '-f', name]).catch(() => {}); // stale cxell from a prior run
  let port = sshPort || cxellSshPort(slug);
  for (let attempt = 0; attempt < 12; attempt++, port++) {
    try {
      await dk(ctx, cxellRunArgs({ name, net, port, img, xellId, prep }));
      // A fresh named volume is root-owned; npm runs as `zee`. Fix it (cheap, idempotent) and SAY
      // when the cache came up read-only, because that turns every `npm ci` in this cage into a
      // failure a human would otherwise have to guess at. Best-effort: never fails the create.
      const fixup = cxellCacheFixupCommand(name, { npm: prep?.cache?.npm });
      if (fixup) {
        // The fixup SAYS whether the cache came out writable (CACHE_RW / CACHE_RO on stdout), so it is
        // a verdict exec and goes through dkVerdict. It used to read the marker out of a REJECTION —
        // `.catch((e) => ({ out: `CACHE_ERR ${e.message}` }))` — which threw the cage's own CACHE_RW
        // away whenever the exec exited non-zero and logged a FALSE "cache is NOT writable" instead.
        // Same class as the SAME-recorded-as-an-error bug, in a logline rather than a db column.
        const r = await dkVerdict(ctx, fixup, { markers: ['CACHE_RW', 'CACHE_RO'], label: `${name}: npm cache` })
          .catch((e) => ({ verdict: null, code: null, out: '', err: e.message }));   // exec never ran
        if (r.verdict !== 'CACHE_RW') {
          logline('cxell', `${name}: shared npm cache is NOT writable (${dkSaid(r, 120)}) — npm in this cage falls back to its own cache; set CXELL_NPM_CACHE_VOLUME=off if this persists`);
        }
      }
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

// The THIRD baked attend-path file, refreshed for the same reason as the two above: zee-attach.sh is
// what a human's terminal actually runs, and it is now also what DRAINS the talk queue (a message
// sent to a mid-turn zee). Left to the image, that drainer would exist only in cages spawned after
// the next zee-agent rebuild — and the queue would silently fill in every cxell alive today, which
// is a worse failure than the one it fixes. installZeeCliIntoCxell's own comment names this file as
// the next capability that would "silently not be there at all"; this is that comment being acted on.
export const ZEE_ATTACH_DEST = '/usr/local/bin/zee-attach.sh';
export const zeeAttachSourcePath = () => resolve(config.repoRoot, 'docker', 'zeehive', 'zee-attach.sh');
export const zeeAttachInstallCommands = ({ name, src = zeeAttachSourcePath() }) =>
  cxellFileInstallCommands({ name, src, dest: ZEE_ATTACH_DEST, tmp: '/tmp/zee-attach.sh' });

export async function installZeeAttachIntoCxell({ ctx = 'default', name }) {
  const src = zeeAttachSourcePath();
  if (!existsSync(src)) return { installed: false, reason: 'source-missing', src };
  try {
    for (const args of zeeAttachInstallCommands({ name, src })) await dk(ctx, args);
    return { installed: true, src };
  } catch (e) {
    logline('cxell', `${name}: could not refresh the attach script from ${src} `
      + `(${String(e.message).slice(0, 160)}) — a message sent to this zee MID-TURN may sit in `
      + `${CXELL_TALK_DIR} undelivered`);
    return { installed: false, reason: 'exec-failed', src, error: e.message };
  }
}

// Refresh the renderer into cxells that ALREADY EXIST — not just the ones we are about to spawn.
//
// The spawn-time install above only ever helped the next cage. Every cxell created before it
// shipped kept the renderer baked into its image, so the terminal's ✱/⚒ chips wrote a view file
// that nothing in there was watching: the chip lit up "hidden" and the feed went on showing
// thinking. A toggle that confidently reports a state it did not apply is worse than one that
// looks inert — which is exactly how this reached a human as "the buttons dont work".
//
// Run at BOOT, which is also the moment after a ship (the queenzee restarts into the new code) —
// so a shipped attend-path change reaches the RUNNING fleet instead of waiting for it to recycle.
// It touches only /usr/local/bin inside cxells the queenzee owns, cannot affect a zee's work, and
// every failure is per-cxell and logged rather than thrown: one unreachable cage must not stop the
// sweep, and the sweep must never delay boot.
//
// AND IT OBEYS PROVISION_MODE, for the same reason the harness re-injection and the .zeehive.env
// reconcile do: the caller (index.js) resolves these container names out of FLEET ROWS, and a
// nested queenzee's fleet rows are the REAL fleet's — a xell's database is a clone of the meta-DB.
// So in simulate this boot sweep would `docker cp` + `docker exec -u 0` into every OTHER zee's live
// cage, installing whatever /usr/local/bin files happen to be in the running zee's own worktree.
// Report-only there; unchanged in real mode.
export async function refreshZeeLiveInLiveCxells(listLiveCxells, { mode = PROVISION_MODE } = {}) {
  let ok = 0;
  const failed = [];
  let cxells = [];
  try { cxells = await listLiveCxells(); } catch (e) {
    logline('cxell', `live-feed renderer sweep skipped — could not list cxells (${String(e.message).slice(0, 120)})`);
    return { swept: 0, ok: 0, failed: [] };
  }
  if (mode !== 'real') {
    // Say what it would have done, always — "nothing to sweep" and "not allowed to sweep" must not
    // look the same in the log.
    if (cxells.length) {
      logline('cxell', `attend path NOT refreshed in ${cxells.length} running cxell(s) — PROVISION_MODE=`
        + 'simulate: this queenzee models the fleet, it does not install files into its cages. Would '
        + `have refreshed: ${cxells.map((c) => c.name).slice(0, 8).join(', ')}`);
    }
    return { swept: cxells.length, ok: 0, failed: [], dry_run: true };
  }
  for (const { ctx = 'default', name } of cxells) {
    // BOTH attend-path files, for one reason: they are two halves of the same pane. The renderer
    // draws the feed; the attach script decides when the feed hands the pane over — and now drains
    // the talk queue at that exact moment. A sweep that refreshed only one of them would leave a
    // cage that queues messages nothing ever types in.
    const r = await installZeeLiveIntoCxell({ ctx, name });
    const a = await installZeeAttachIntoCxell({ ctx, name });
    if (r.installed && a.installed) ok++; else failed.push(name);
  }
  if (cxells.length) {
    logline('cxell', `attend path (live-feed renderer + attach script) refreshed in ${ok}/${cxells.length} running cxell(s)`
      + (failed.length ? ` — not reachable: ${failed.slice(0, 5).join(', ')}` : '')
      + ' (one mid-turn picks it up on its NEXT feed / attach)');
  }
  return { swept: cxells.length, ok, failed };
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

// PER-ACTOR GIT IDENTITY (TKT-159-3139). The zee-agent image bakes a SHARED git identity
// (user.name 'zee' / zee@zeehive.local), so every in-cxell commit is unattributable. At spawn we
// override it with the per-xell scheme: the AUTHOR names the acting zee (its slug) and the
// COMMITTER names the door that wrote it (in-cage git = the xell door; the console terminal sets
// its own console-door committer via terminal-bridge; queenzee merges keep the queenzee door via
// -c in xellgit.js/cxell.js).
//
// git config user.name/user.email set BOTH the author and committer of a commit, so the global
// config here is the DOOR identity (user.name 'xell'), and the zee's authorship rides in
// GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL (which git prioritises over the config — set in the headless
// exec env by runZee's caller and in /etc/environment by openCxellSsh, so a console-terminal
// shell also authors as the slug). A commit therefore reads author=<slug>, committer=xell — the
// door. Best-effort by contract: a failure to configure identity must never sink a spawn (the
// baked shared identity is a safe fallback, and the ledgers still record what happened).
export async function configureCxellGitIdentity({ ctx = 'default', slug, timeoutMs = 20000 } = {}) {
  const name = cxellName(slug);
  const safeSlug = String(slug || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  const email = `${safeSlug}@xell.zeehive.local`;
  try {
    const r = await dk(ctx, ['exec', name, 'bash', '-lc',
      `git config --global user.name 'xell' && git config --global user.email '${email}'`
      + ` && echo IDENTITY_OK`], { timeoutMs });
    return { ok: /IDENTITY_OK/.test(r.out || ''), slug: safeSlug, email };
  } catch (e) {
    logline('cxell', `${name}: could not configure per-xell git identity (${String(e.message).slice(0, 200)}) — `
      + 'in-cxell commits keep the baked shared identity until a rebuild fixes it');
    return { ok: false, slug: safeSlug, email };
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
  // Every value is scrubbed of newlines (finding [9] of the credential-injection review): a label
  // or token containing \n would write extra lines into /etc/environment and re-write the cage's
  // env. Strip, never emit — the injection rewrite runs the same scrub.
  const envLines = Object.entries(agentEnv)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${scrubEnvValue(v)}`);
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

// ── INSTALL THE DISPATCHED PROVIDER'S CREDENTIAL INTO THE CAGE ────────────────────────────────────
//
// A cxell is provider-AGNOSTIC by construction: the image carries every vendor CLI, nothing about a
// provider is baked into it or into the xell, and the credential arrives at dispatch time as the
// runtime adapter's env (docker exec -e for the headless run, /etc/environment for an attending
// human's shell). For claude, kimi and deepseek that environment IS the login and there is nothing
// to do here.
//
// `codex` breaks that assumption, and it broke it as an AUTH ERROR — which is why this function
// exists rather than a comment. With OPENAI_API_KEY alone, `codex exec` sends no Authorization
// header at all and every turn dies `401 … Missing bearer or basic authentication in header`: a
// perfectly good key, reported to the human as an invalid one, on every OpenAI zee in the fleet.
// Its adapter therefore declares authSetupCmd() (see lib/cxell-runtimes.js for the measurements),
// and this runs it INSIDE the cage with the same credential env before the agent ever starts.
//
// Three properties this deliberately keeps:
//   • the token is never on a command line — the setup command reads it from the env this exec
//     carries, so it stays out of `ps`, out of the docker argv and out of every log;
//   • the CONTAINER states the outcome (AUTH_MARKERS via dkVerdict), never the exit code;
//   • no verdict at all is a FAILURE here, not a shrug. The whole point is to know, before a turn
//     starts, that the agent can authenticate — guessing would restore the exact silence this fixes.
//
// Returns { required, ok, verdict, said } and never throws: the caller decides what a failure means
// (spawn refuses the dispatch; the nudge path logs and carries on with whatever is already in the
// cage). `required:false` means the adapter needs no setup — the ordinary case.
export async function prepareCxellAuth({ ctx = 'default', name, adapter = CLAUDE_ADAPTER,
                                         token = null, baseUrl = null, model = null } = {}) {
  // The token is offered to the adapter because a vendor can have MORE THAN ONE credential shape:
  // grok's `xai-…` API key needs no install (the env is the login) while a device-auth SEAT session
  // is a file that must be written into the cage. The adapter decides; an adapter that always needs
  // its door (codex) ignores the argument, and a shape that needs nothing costs no exec at all.
  const cmd = adapter?.authSetupCmd?.({ token });
  if (!cmd) return { required: false, ok: true };
  if (!token) {
    return { required: true, ok: false,
             said: `no ${adapter.provider} token to install — the ${adapter.bin} CLI cannot authenticate without one` };
  }
  // Same guarded door as the run itself — installing another vendor's key into the cage would
  // write a 401 into ~/.codex/auth.json and call it AUTH_OK on the next rotation.
  let env;
  try { env = credentialEnvFor(adapter, { token, baseUrl, model }).flatMap(([k, v]) => ['-e', `${k}=${v}`]); }
  catch (e) { return { required: true, ok: false, verdict: null, said: String(e.message).slice(0, 400) }; }
  let r;
  try {
    r = await dkVerdict(ctx, ['exec', ...env, name, 'bash', '-lc', cmd],
                        { markers: AUTH_MARKERS, label: `${name}: ${adapter.key} auth`, timeoutMs: 60000 });
  } catch (e) {
    // the exec never ran (no such container, docker gone, timeout) — there is no verdict to read
    return { required: true, ok: false, verdict: null, said: String(e.message).slice(0, 300) };
  }
  const ok = r.verdict === 'AUTH_OK';
  return { required: true, ok, verdict: r.verdict,
           said: ok ? null : (dkSaid(r, 300) || 'the cage printed no AUTH_OK/AUTH_FAILED verdict') };
}

// ── PRE-ANSWER THE RUNTIME'S FIRST-RUN PROMPTS ───────────────────────────────────────────────────
//
// The twin of prepareCxellAuth, for the gate that comes AFTER authentication: the vendor's own
// first-run questions (claude's onboarding/theme/trust/bypass, codex's "do you trust the contents of
// this directory?"). It is invisible on the headless path — every adapter runs its CLI
// non-interactively — and lands entirely on the HUMAN who attends the cage, because zee-attach.sh
// hands the pane straight to `claude --resume` / `codex resume` / `kimi --continue`.
//
// The cage used to be pre-answered for claude ALONE (cxell-claude-seed.mjs, baked into the image),
// which made it a claude cage wearing another vendor's CLI. Now each adapter declares its own
// firstRunSeedCmd() — measured per vendor, see lib/cxell-runtimes.js — and this runs whichever one
// the dispatched runtime brings.
//
// NOT FATAL, deliberately, and this is the difference from the auth install: a cage whose seed
// failed still works headless, and the whole cost is a prompt in front of a human who can answer
// it. So it reports and logs, and the dispatch carries on.
export async function seedCxellFirstRun({ ctx = 'default', name, adapter = CLAUDE_ADAPTER } = {}) {
  const cmd = adapter?.firstRunSeedCmd?.();
  if (!cmd) return { required: false, ok: true };
  let r;
  try {
    r = await dkVerdict(ctx, ['exec', name, 'bash', '-lc', cmd],
                        { markers: SEED_MARKERS, label: `${name}: ${adapter.key} first-run seed`, timeoutMs: 60000 });
  } catch (e) {
    return { required: true, ok: false, verdict: null, said: String(e.message).slice(0, 300) };
  }
  const ok = r.verdict === 'SEED_OK';
  return { required: true, ok, verdict: r.verdict,
           said: ok ? null : (dkSaid(r, 300) || 'the cage printed no SEED_OK/SEED_FAILED verdict') };
}

// ── INSTALL THE CAGE'S OWN TURN-BOUNDARY HOOKS ───────────────────────────────────────────────────
//
// The third member of the same family (prepareCxellAuth, seedCxellFirstRun), and the one that closes
// a gap rather than answering a prompt: an INTERACTIVE turn — a human or a manager typing into the
// session in the cage's pane — is a turn the queenzee does not start and no loop of its can observe
// (queenzee/reaper.js, KNOWN GAP). The vendor's own turn hooks can see it, and the cage already holds
// the `zee` CLI and its identity token, so it reports itself: `zee turn --start` / `--end`.
//
// Per-vendor and MEASURED (lib/cxell-runtimes.js turnHookCmd): claude declares the command, codex and
// kimi declare nothing and are untouched. NOT FATAL, exactly like the first-run seed: a cage whose
// hooks did not install works in every other respect, and the cost is the gap it had before.
export async function installTurnHooksIntoCxell({ ctx = 'default', name, adapter = CLAUDE_ADAPTER } = {}) {
  const cmd = adapter?.turnHookCmd?.();
  if (!cmd) return { required: false, ok: true };
  let r;
  try {
    r = await dkVerdict(ctx, ['exec', name, 'bash', '-lc', cmd],
                        { markers: TURN_HOOK_MARKERS, label: `${name}: ${adapter.key} turn hooks`, timeoutMs: 60000 });
  } catch (e) {
    return { required: true, ok: false, verdict: null, said: String(e.message).slice(0, 300) };
  }
  const ok = r.verdict === 'TURNHOOK_OK';
  return { required: true, ok, verdict: r.verdict,
           said: ok ? null : (dkSaid(r, 300) || 'the cage printed no TURNHOOK_OK/TURNHOOK_FAILED verdict') };
}

// Bundle the worktree's HEAD (its spinoff branch) into the cxell as a private clone at
// /work/repo, then copy in the gitignored .zeehive.env projection (ports + DATABASE_URL).
export async function cloneIntoCxell({ ctx, name, worktree }) {
  let updated = false;   // did the checkout survive (fetch+reset) rather than being re-cloned?
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
    // UPDATE IN PLACE when the cage already holds this branch, instead of `rm -rf` + clone.
    //
    // The wipe is right for a fresh cage and WRONG for a pre-warmed one: provisioning may have spent
    // two minutes installing node_modules into that tree, and node_modules is untracked, so a
    // re-clone throws away the entire point of `when: 'provision'`. Fetching the bundle and
    // `reset --hard`ing onto it lands the same commit, byte for byte, and leaves untracked
    // installed output alone. `git clean` still removes untracked JUNK (so the zee starts on the
    // same pristine tree it always did) — with node_modules excluded by name, because a project that
    // does not gitignore it would otherwise have it deleted here.
    //
    // Which path ran is a VERDICT, not a guess: CLONE_UPDATED vs CLONE_FRESH on stdout, so "why did
    // my prepped cage reinstall?" is answerable from the log.
    const b = branch.replace(/'/g, '');
    const r = await dkVerdict(ctx, ['exec', name, 'bash', '-lc',
      `if [ -d /work/repo/.git ] && [ "$(git -C /work/repo rev-parse --abbrev-ref HEAD 2>/dev/null)" = '${b}' ]; then `
      + `git -C /work/repo fetch -q /tmp/task.bundle '${b}' && git -C /work/repo reset -q --hard FETCH_HEAD `
      + '&& git -C /work/repo clean -qfd -e node_modules && echo CLONE_UPDATED; '
      + `else rm -rf /work/repo && git clone -q -b '${b}' /tmp/task.bundle /work/repo && echo CLONE_FRESH; fi`],
      { markers: CLONE_MARKERS, label: `${name}: clone`, timeoutMs: 300000 });
    if (!r.verdicts.length) {
      // Neither path reported success — the tree is in an unknown state and everything downstream
      // (the warm, the harness files, the zee itself) assumes /work/repo is a checkout. Fail here
      // rather than hand a zee half a repository.
      throw new Error(`clone into ${name} reported nothing (exit ${r.code}): ${dkSaid(r, 300)}`);
    }
    updated = r.verdicts.includes('CLONE_UPDATED');
    if (updated) {
      logline('cxell', `${name}: updated the existing checkout in place (fetch + reset --hard) — `
        + 'anything provisioning already installed survives');
    }
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
      // cxell spawn (the zee can still work without it) — same stance as saveDispatchAttachments.
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
  // Which path ran, for a caller that cares whether an installed node_modules survived.
  return { updated };
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
// The warm's install step, as a shell script — pure, so what runs in a cage is assertable without
// a daemon (ticket #14).
//
// `npm ci` NEVER falls back to `npm install` on a worktree that HAS a lockfile. That fallback used
// to be unconditional, and it runs in /work/repo — the tree the zee lands from. `npm install`
// rewrites package-lock.json, so any lock drift at dispatch handed the zee a dirty tree before it
// had done anything, and from there into an accidental lockfile change in somebody's landing,
// attributed to a zee that never touched dependencies. This repo already paid for that exact
// mechanism once on the HOST side (start-xell-process.sh: install rewrote the lock, the pool read
// the worktree as dirty and reaped the xell — a live provision→build→reap loop).
//
// So a failing `ci` in a fresh cage is now the SIGNAL, not something to paper over: the warm fails,
// says why, and the tree is left exactly as the clone left it. A worktree with genuinely NO lockfile
// still installs — `npm ci` requires one, and there is no lock to damage.
// Every marker warmInstallScript prints on stdout, declared here so the exec that runs it can name
// them (dkVerdict requires that) and so a guard test can check no marker is left undeclared. Order is
// not significance: warmCxell reads the SET, because WARM_LOCK_DIRTY rides alongside whichever of the
// other three the run produced.
export const WARM_MARKERS = ['WARM_OK', 'WARM_CI_FAILED', 'WARM_INSTALL_FAILED', 'WARM_LOCK_DIRTY'];

// The two ways a branch gets into a cage: a fresh clone, or a fetch+reset onto a checkout that is
// already there (which is what preserves a pre-warmed cage's node_modules). Declared here for the
// same reason WARM_MARKERS is: the exec that runs the script has to name what it prints.
export const CLONE_MARKERS = ['CLONE_FRESH', 'CLONE_UPDATED'];

export function warmInstallScript(repoDir = '/work/repo', prep = null) {
  // GENERATED FROM THE PROJECT'S SPAWN TEMPLATE (migration 121, lib/spawn-prep.js) instead of being
  // hard-coded here. With no template — every project until a human edits one — prepUserScript
  // emits this same script, marker for marker: npm ci (never install, when a lockfile exists), the
  // web prebuild, the lockstate proof, WARM_OK. What the template adds is the ability to say "this
  // project also needs psql / build tools / one more npm script", and how npm should cache.
  return prepUserScript(prep || normalizeSpawnPrep(null), repoDir);
}

// The ROOT half of the warm: apt packages (and anything a human marked root) from the spawn
// template, run in their own `docker exec -u 0` BEFORE the user half — because apt needs uid 0 and
// npm must NOT have it (root-owned files under /work/repo are files the zee cannot commit). Returns
// { ran:false } when the template asks for nothing root, which is every project today: no exec
// happens at all, so the default spawn path is untouched.
export async function prepRootCxell({ ctx, name, prep, aptBaked = false }) {
  const script = prepRootScript(prep, { aptCache: hasAptStep(prep), aptBaked });
  if (!script) return { ran: false, steps: [] };
  try {
    const r = await dkVerdict(ctx, ['exec', '-u', '0', name, 'bash', '-lc', script],
                              { markers: ['PREP_ROOT_DONE'], label: `${name}: prep (root)`, timeoutMs: 900000 });
    const steps = parsePrepSteps(r.out);
    const failed = steps.filter((x) => !x.ok);
    // Rule 1: a package that would not install is a SLOWER zee, never a failed dispatch. Said out
    // loud with the step name, because "psql is missing again" is otherwise unattributable.
    if (failed.length) {
      logline('cxell', `${name}: prep step(s) FAILED — ${failed.map((x) => x.key).join(', ')}; `
        + 'the zee starts without them (add them by hand, or fix the project spawn template)');
    }
    // NO verdict means the script never got to its end — a cage that is not there, a docker hop that
    // died. dkVerdict RESOLVES for an exec that ran and exited non-zero, so without this the failure
    // would come back as a quiet { ok:false } with nothing in it, and the reason a project's packages
    // are missing would exist nowhere. Still not fatal (rule 1): the zee starts, one tool short.
    if (!r.verdicts.includes('PREP_ROOT_DONE')) {
      const said = dkSaid(r, 200);
      logline('cxell', `${name}: root prep did not finish (exit ${r.code}) — the zee starts without `
        + `whatever the spawn template installs: ${said}`);
      return { ran: true, ok: false, steps, error: said };
    }
    return { ran: true, ok: true, steps };
  } catch (e) {
    logline('cxell', `${name}: root prep did not run (${String(e.message).slice(0, 160)}) — `
      + 'the zee starts without whatever the template installs');
    return { ran: true, ok: false, steps: [], error: e.message };
  }
}

// `stage` says WHICH clock this warm is running on, and it changes two things:
//   'dispatch'  (default, today) — install, and REUSE what provisioning already installed if the
//               marker in the cage still matches this lockfile and template.
//   'provision' — the pool's clock, on a cage nobody has claimed: install and WRITE that marker.
// `aptBaked` says the cage's image already carries the packages, so the root half is skipped.
export async function warmCxell({ ctx, name, prep = null, stage = 'dispatch', aptBaked = false }) {
  const template = prep && prep.steps ? prep : normalizeSpawnPrep(null);
  const hash = templateHash(template);
  // The ROOT half first (apt packages from the spawn template), while egress is still open — the
  // firewall is sealed after the warm. A no-op for a project that installs no packages, and for one
  // whose packages are already in the image.
  const root = await prepRootCxell({ ctx, name, prep: template, aptBaked });
  let r;
  try {
    // `npm ci` here reads the SHARED cache volume mounted by ensureCxell, so this is an unpack from
    // local content-addressed storage rather than a registry download — the same work, without the
    // network. It reports the cache it used so a slow warm can be told apart from a cold cache.
    //
    // THE SCRIPT'S MARKERS DECIDE THE OUTCOME, NOT THE EXEC'S EXIT STATUS — hence dkVerdict (see
    // there). Through plain dk a failing `npm ci` REJECTED, and dk's rejection message used to be
    // `(err || out)`: stderr ALONE whenever the child wrote any, which npm always does. Every marker
    // this script prints goes to STDOUT, so the drift branch below could never be true — a broken
    // lockfile was reported as "warm incomplete — the zee will install as needed", which is the one
    // thing that will NOT fix it. Ticket #14.
    r = await dkVerdict(ctx, ['exec', name, 'bash', '-lc',
                              // reuse only on the dispatch side; the provision side is what CREATES
                              // the thing to reuse, and re-running it there is the job, not waste.
                              prepUserScript(template, '/work/repo',
                                             { hash, reuse: stage === 'dispatch', mark: true })],
                        { markers: WARM_MARKERS, label: `${name}: warm`, timeoutMs: 900000 });
  } catch (e) {
    // No verdict at all because the exec never ran (no such container, docker gone, timeout).
    // Nothing to classify: the zee simply starts cold.
    logline('cxell', `${name}: warm (npm/build) incomplete — the zee will install as needed: ${String(e.message).slice(0, 160)}`);
    return { warmed: false, error: e.message, steps: root.steps };
  }
  const sharedCache = new RegExp(`npm cache: ${CXELL_NPM_CACHE_DIR}`).test(r.out);
  const lockDirty = r.verdicts.includes('WARM_LOCK_DIRTY');
  // PER-STEP TIMINGS, root half + user half. Without them a slow spawn is one number and "which
  // step costs the minute" is a guess — this is the evidence a human tunes the template from.
  const steps = [...root.steps, ...parsePrepSteps(r.out)];
  const reused = steps.filter((x) => x.status === 'reused').length;
  if (steps.length) {
    logline('cxell', `${name}: prep — ${summarizePrepSteps(steps, template)}`
      + (reused ? ' — provisioning had already done this work; the dispatch installed nothing' : ''));
  }
  if (lockDirty) {
    // Should be unreachable now that nothing in the warm writes the lock. Loud anyway: a dirty
    // lockfile at dispatch is a change the zee did not make and would land without noticing.
    logline('cxell', `${name}: !!! the warm left package-lock.json MODIFIED — the zee starts on a dirty tree it did not dirty; `
      + 'do not let it land that file without deciding to');
  }
  // WARM_OK anywhere in the markers wins, whatever else the script printed and whatever the exec
  // exited with. (The "trusted but said out loud" line for a non-zero exit is dkVerdict's job now —
  // it was written by hand here and in writeFileIntoCxellIfChanged, which is two copies of one rule.)
  if (r.verdicts.includes('WARM_OK')) return { warmed: true, sharedCache, lockDirty, steps };

  // Failed, and the script said which failure it was. Lock drift is a repo problem a human or the
  // zee must fix deliberately, and it reads nothing like a registry timeout — so it gets its own
  // line. npm's own explanation is on stderr; both streams are searched for it.
  const said = `${r.out}\n${r.err}`;
  // The HEAD of the output, like dk's own rejection message: npm puts the code and the explanation
  // first ("code EUSAGE", "can only install packages when…", "Missing: x from lock file") and the
  // path of its debug log — which nobody can read from outside the cage — last.
  const error = `warm exited ${r.code}: ${(r.err || r.out).trim().slice(0, 400)}`;
  const drift = r.verdicts.includes('WARM_CI_FAILED')
    && /can only install packages when your package\.json and package-lock\.json|EUSAGE|Missing:|Invalid: lock/i.test(said);
  if (drift) {
    logline('cxell', `${name}: warm FAILED — package-lock.json disagrees with package.json at this commit, so \`npm ci\` `
      + 'cannot run. The lockfile was NOT rewritten (that used to happen silently and land in the zee\'s branch). '
      + 'The zee starts without node_modules; fixing the lock is a deliberate commit, not a side effect.');
  } else {
    logline('cxell', `${name}: warm (npm/build) incomplete — the zee will install as needed: ${error.slice(0, 160)}`);
  }
  return { warmed: false, sharedCache, lockDirty, error, lockDrift: drift, steps };
}

// ── THE ONE DOOR A CREDENTIAL LEAVES BY ──────────────────────────────────────────────────────────
//
// Every path that puts a vendor key into a cage builds it the same way — `adapter.env({token,…})`
// → `docker exec -e` — so this is the single place to ask the question the fleet learned to ask the
// expensive way: is the token we are about to send unmistakably ANOTHER vendor's?
//
// Ten DeepSeek zees died on "401 … Your api key: ****CAAA is invalid" (2026-08-01 → 08-03) with a
// CLAUDE OAuth token in ANTHROPIC_AUTH_TOKEN against api.deepseek.com. decideRuntimePairing now
// stops the dispatch that CHOSE that pairing; this stops the credential itself, on every path,
// including the two the pairing never sees: nudgeCxellZee's fallback (which reads the token back out
// of the cage's /etc/environment under a key the claude and deepseek adapters SHARE, so it cannot
// tell whose it is) and any adapter added later.
//
// It refuses only what it can NAME — lib/provider-tokens.js attributes a token by the vendor's own
// `signature` prefix, else by a shape that exactly one vendor accepts, and answers null for anything
// else. So an unrecognised or ambiguous token (a DeepSeek or OpenAI key, a format that changed
// upstream) still goes to the vendor to answer for: this must cost a missed catch, never a refused
// dispatch. The error is the sentence a human can act on, and it carries the MASKED token so it can
// be matched to the account in Project setup; the token itself never reaches a log or a message.
function credentialEnvFor(adapter, { token, baseUrl = null, model = null } = {}) {
  const bad = credentialVendorMismatch({ provider: adapter?.provider, token });
  if (bad) {
    throw new Error(`refusing to start the ${adapter.bin} CLI with a ${bad.from} credential: ${bad.sentence}`);
  }
  return Object.entries(adapter.env({ token, baseUrl, model }))
    .filter(([, v]) => v !== null && v !== undefined && v !== '');
}

// Run the zee: the runtime adapter's CLI headless inside the cxell (claude -p / codex exec /
// kimi --print — see cxell-runtimes.js), its output translated to the normalized event stream.
// Returns { proc, done } where done resolves with the final `result` event (or rejects on a
// transport failure). onEvent(obj) fires per normalized event — init (session id), assistant
// turns, result. Bypass/auto mode inside is safe HERE and only here — the cxell is the
// permission system, and every adapter runs its CLI's equivalent of skip-permissions.
export function runZee({ ctx, name, prompt, model, adapter = CLAUDE_ADAPTER, token, xellToken, baseUrl = null, extraEnv = {}, onEvent }) {
  // The credential goes through the ONE guarded door (credentialEnvFor): a token that is plainly
  // another vendor's throws HERE, before docker is spawned, so the dispatch fails with a sentence
  // naming both vendors instead of the cage burning a turn on the vendor's own "invalid api key".
  const agentEnv = [
    ...Object.entries(extraEnv || {}).filter(([, v]) => v !== null && v !== undefined && v !== ''),
    ...credentialEnvFor(adapter, { token, baseUrl, model }),
    // THE LLM GATEWAY — point the provider base-urls at the queenzee gateway carrying this xell's
    // identity in the PATH (/x/<xellToken>/<provider>/...), so EVERY AI call this headless spawn
    // makes (claude -p / codex exec / kimi -p / grok -p) crosses the gateway and is recorded.
    // Added AFTER credentialEnvFor so it OVERRIDES the adapter's own base URL (the deepseek
    // adapter sets ANTHROPIC_BASE_URL unconditionally; the gateway must win). When the gateway is
    // off (GATEWAY_PORT === PORT), gatewayEnv returns {} and the adapter's real URLs are kept.
    // Without the xell identity token the gateway would 401 every call, so the env is only added
    // when one is present — a caller with no token keeps the adapter's direct URLs.
    ...(xellToken ? Object.entries(gatewayEnv({ xellToken, provider: adapter.provider }))
      .filter(([, v]) => v !== null && v !== undefined && v !== '') : []),
  ];
  const cmd = ['exec', '-i',
    ...agentEnv.flatMap(([k, v]) => ['-e', `${k}=${v}`]),
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

// A git index.lock older than this is STALE — no live git op holds one this long (a lock lives for
// the duration of a single index-touching command: merge/stash/commit/…, seconds at most). A
// crashed or killed process leaves one behind forever, and every later index-touching command then
// dies with "Unable to create '.../index.lock': File exists". The 5-minute margin is generous
// enough that a genuinely live op is never mistaken for a stale lock.
const STALE_INDEX_LOCK_MS = 5 * 60 * 1000;

// If a STALE index.lock exists in the worktree admin dir (for a linked worktree that is
// <repo>/.git/worktrees/<name>, which is exactly where every `git -C <worktree>` index-touching
// command looks for it), remove it and log the FULL path so `zee ops --alerts` finally names the
// file. Returns true when a lock was removed. A FRESH lock is NEVER deleted — a live git process
// may be holding it; the caller then fails exactly as today.
function clearStaleIndexLock(adminDir, slug) {
  const lockPath = join(adminDir, 'index.lock');
  let st;
  try { st = statSync(lockPath); } catch { return false; }
  if (Date.now() - st.mtimeMs < STALE_INDEX_LOCK_MS) return false;
  try {
    rmSync(lockPath, { force: true });
    logline('cxell', `${slug}: cleared a STALE index.lock at ${lockPath} `
      + `(${Math.round((Date.now() - st.mtimeMs) / 1000)}s old) so the collect could retry`);
    return true;
  } catch {
    return false;
  }
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
// force — the caller surfaces that to the zee. The pure-git core below (reconcileBundleIntoWorktree)
// also self-heals a STALE index.lock in the worktree admin dir (TKT-86-B3B2), so a crashed git
// process no longer takes the collect step — and with it the zee — out of service.
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
  const git = (args) => {
    const run = (a) => new Promise((resolve, reject) => {
      const g = spawn('git', ['-C', worktree, ...a], { windowsHide: true });
      let out = '', err = '';
      g.stdout.on('data', (d) => (out += d.toString()));
      g.stderr.on('data', (d) => (err += d.toString()));
      g.on('error', reject);
      g.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`git ${a[0]} exited ${c}: ${err.slice(0, 300)}`))));
    });
    return run(args).catch(async (e) => {
      // SELF-HEAL the collect path (TKT-86-B3B2): a STALE index.lock in the worktree admin dir makes
      // every index-touching git op above die with "File exists", which a caged zee can neither see
      // nor delete — previously one crashed git process took the zee fully out of service (every
      // `zee build`/`zee land` failed at collect). Resolve where that lock lives
      // (`git rev-parse --absolute-git-dir` — for a linked worktree that is <repo>/.git/worktrees/<name>),
      // and if it is STALE (present + mtime older than STALE_INDEX_LOCK_MS — no live op), clear it,
      // log the path, and retry the failed op ONCE. A FRESH lock is never deleted; then we fail
      // exactly as today.
      let admin = null;
      try { admin = await run(['rev-parse', '--absolute-git-dir']); } catch { /* keep e */ }
      if (admin && clearStaleIndexLock(admin, slug)) {
        return run(args);
      }
      throw e;
    });
  };
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
      // Since every provider's key rides under its OWN namespaced var (ZEE_PROVIDER_<KEY>_TOKEN),
      // read THAT first — it attributes the token to a vendor. adapter.tokenEnvKey is the OLD
      // fallback for a cage spawned before the namespaced set existed, and it is exactly the key
      // claude and deepseek SHARE, so a token read back under it cannot be attributed (the reason
      // this guard is the last line — see the credentialEnvFor call below).
      vendorTok = vendorTok
        || pick(`ZEE_PROVIDER_${String(adapter.provider).toUpperCase()}_TOKEN`)
        || pick(adapter.tokenEnvKey);
      identTok = identTok || pick('ZEEHIVE_XELL_TOKEN');
    } catch { /* fall through with whatever the caller gave us */ }
  }
  // Re-install the credential for a CLI that does not read it from the environment (codex). The
  // spawn already did this, so it is normally a no-op rewrite of the same file — but a cage that
  // was created before this existed, or one whose account token has since been rotated, would
  // otherwise resume straight into a 401 that reads like a bad key. Best-effort by contract: if it
  // fails we still resume with whatever the cage already holds, and SAY so rather than fail the
  // continuation a human is waiting on.
  if (adapter.authSetupCmd?.() && vendorTok) {
    const auth = await prepareCxellAuth({ ctx, name, adapter, token: vendorTok, model });
    if (!auth.ok) {
      logline('cxell', `${name}: could not refresh the ${adapter.provider} credential before resuming `
        + `(${auth.said}) — resuming on whatever is already in the cage; an auth error on this turn is `
        + 'this, not a bad key');
    }
  }
  // GUARDED, and this path is why the guard exists at all: the fallback above reads the token back
  // out of the cage by `adapter.tokenEnvKey`, which is ANTHROPIC_AUTH_TOKEN for the claude AND the
  // deepseek adapter — so a cage that was spawned on one of them and is being resumed on the other
  // (a re-crewed cage, a cage older than the pairing fix, a project whose account was removed so
  // tokenForSpawn returned null) hands over a token nobody can attribute. Refusing here turns that
  // into a named sentence in the nudge log instead of a resume that dies on the vendor's 401.
  //
  // THE LLM GATEWAY — the resume exec must cross the gateway too, so the resumed claude --resume
  // (codex exec resume / kimi -c / grok -r) records a row attributed to this xell. Same shape as
  // runZee: the provider base-urls carry /x/<identTok>/<provider> in the PATH, added AFTER
  // credentialEnvFor so the gateway overrides the adapter's own base URL. Empty when the gateway
  // is off (GATEWAY_PORT === PORT) — the adapter's real URLs then stay. Only added when the xell
  // identity token is known — without it the gateway would 401 the resume (the adapter's direct
  // URLs are kept).
  const env = [
    ...credentialEnvFor(adapter, { token: vendorTok, model }),
    ...(identTok ? Object.entries(gatewayEnv({ xellToken: identTok, provider: adapter.provider }))
      .filter(([, v]) => v !== null && v !== undefined && v !== '') : []),
  ].flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  if (identTok) env.push('-e', `ZEEHIVE_XELL_TOKEN=${identTok}`);
  // the adapter sanitizes the session id before interpolating it (claude/codex); kimi resumes by
  // workdir (--continue) and ignores the id entirely
  const cmd = ['exec', '-i', ...env, name, 'bash', '-lc',
    `cd /work/repo && ${adapter.execCmd({ model, resumeSid: sessionId || '' })}`];
  const r = await dk(ctx, cmd, { input: adapter.stdinPayload ? adapter.stdinPayload(prompt) : prompt, timeoutMs });
  // …and hand back the turn's own FINAL RESULT EVENT, not just its exit code: what it burned
  // (usageFrom) and whether it died (resumeTurnDeath) are both read off this one object, parsed once
  // by the adapter that produced it (lib/cxell-runtimes.js resultFrom).
  return { ...r, result: resultFrom(adapter, r) };
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

// ── TALKING TO A ZEE, INCLUDING ONE THAT IS MID-TURN ─────────────────────────────────────────────
//
// A cxell's pane has two owners, and only one of them can hear you:
//
//   • BETWEEN TURNS the interactive session (`claude --resume`) holds it. Keystrokes land in the
//     zee's prompt box — this is the conversation the dashboard terminal, the 📨 message button and
//     a manager's `zee say` were built on, and it works.
//   • DURING a headless turn the pane is zee-attach.sh's LIVE FEED, which is READ-ONLY by
//     construction: it renders the transcript and reads nothing from the terminal. Every keystroke
//     sent there — typed by a human in the browser, or send-keys'd by the queenzee — is swallowed.
//
// Nothing said so. A human opening a busy zee's terminal (a MANAGER most of all, whose entire job
// is conversation) found a terminal that ignored them, and the console cheerfully reported "typed
// into its live session" for a message that reached nobody.
//
// So a message to a busy zee is QUEUED instead of dropped: written as a file in the cage's talk
// queue, which zee-attach.sh DRAINS into the interactive session the moment the turn ends (and at
// the start of any attach). The human is told which of the two happened, in those words. The queue
// lives in /tmp — it is in-flight conversation, not work product: a cxell restart is a new pane
// with a new session, and re-typing a message from a dead session is worse than losing it.
export const CXELL_TALK_DIR = '/tmp/zee-talk';
// The pgrep the queue decision turns on. TWO questions, because either one means the pane cannot
// hear a keystroke: is the headless turn still running, and is a feed renderer holding the pane
// (it outlives the turn by a beat while the last transcript lines drain).
const PANE_IS_FEED_SH = (sq) =>
  `pgrep -f ${sq(HEADLESS_PROC_PATTERN)} >/dev/null 2>&1 || pgrep -f 'node .*zee-live[.]mjs' >/dev/null 2>&1`;

// The exact remote command behind "say this to the zee" — PURE, so the whole decision is testable
// without a container. Nothing is interpolated unquoted: the message goes through single-quote
// escaping and the session id is reduced to a uuid.
export function cxellTalkCommand({ text, session = 'zee', sessionId = '', enter = true } = {}) {
  const sid = String(sessionId || '').replace(/[^0-9a-fA-F-]/g, ''); // uuid only — shell-interpolated
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;         // safe single-quote for bash
  return [
    // Attach-or-create the session that OWNS the pane. It is what a human attaches to, and — because
    // it runs zee-attach.sh — it is also what drains the queue when the turn ends, so creating it
    // here is what makes a queued message eventually arrive with nobody watching.
    `if tmux has-session -t ${session} 2>/dev/null; then started=0; ` +
      `else tmux new-session -d -s ${session} -x 200 -y 50 -c /work/repo 'zee-attach.sh ${sid}'; started=1; fi`,
    // wheel-scroll needs tmux mouse mode (alt-screen has no xterm scrollback); idempotent
    `tmux set -g mouse on 2>/dev/null || true`,
    // The fork: QUEUE while the feed owns the pane, TYPE when the interactive session does.
    `if ${PANE_IS_FEED_SH(sq)}; then `
      // Written to a .part and renamed: the drainer reads whole files only, so it can never type
      // half a message that was still being written.
      + `mkdir -p ${CXELL_TALK_DIR} && f=${CXELL_TALK_DIR}/$(date +%s%N) `
      + `&& printf '%s' ${sq(text)} > "$f.part" && mv -f "$f.part" "$f.msg" `
      + `&& echo __ZEE_TALK_QUEUED__ || echo __ZEE_TALK_FAILED__; `
    + `else `
      // Only sleep when WE just started the session, so an already-open terminal (the common case)
      // receives the keys with no added latency.
      + `[ "$started" = 1 ] && sleep 6; `
      // `-l` sends the text LITERALLY (so "status?" can never be read as a key name); Enter submits.
      + `tmux send-keys -t ${session} -l ${sq(text)}; `
      + (enter ? `sleep 0.2; tmux send-keys -t ${session} Enter; ` : '')
      + `echo __ZEE_KEYS_SENT__; `
    + `fi`,
  ].join('; ');
}

// TYPE literal text into a cxell zee's LIVE interactive claude — the exact session a human watches
// in the dashboard terminal — by sending keystrokes to its tmux session over SSH, as if the operator
// typed them there. This is what a "nudge" should be: poke the running agent IN PLACE so its reply
// lands where the operator is looking. Contrast nudgeCxellZee, which forks a SECOND `claude --resume
// -p` whose output goes to a queenzee log nobody reads (hence "nudge does not work").
//
// Resolves { sent:true, delivery:'typed'|'queued' } — 'queued' meaning the zee was MID-TURN and the
// message waits in the cage for zee-attach.sh to type it in when the turn ends. Callers must pass
// that word on rather than reporting a plain success: "delivered" and "will be delivered" are
// different promises, and only one of them was true before this existed.
// Best-effort by contract — rejects if the cxell/SSH is unreachable; the caller just logs it.
export async function sendKeysToCxellZee({ sshPort, slug, text, sessionId, session = 'zee', enter = true, timeoutMs = 30000 }) {
  if (!sshPort && !slug) throw new Error('no SSH port or slug for this cxell');
  const sh = cxellTalkCommand({ text, session, sessionId, enter });
  // This reads markers off a script's stdout, like the dkVerdict sites — but through sshExecInCxell, a
  // different transport, and it is DELIBERATELY not routed through dkVerdict. The bug dkVerdict exists
  // to prevent is a verdict destroyed by a non-zero exit; sshExecInCxell resolves { code, out, err } on
  // ANY exit code and never rejects on one, so there is no rejection here to lose a marker in — the
  // property, not a second helper, is what makes it safe, and dk-verdict-contract.test.mjs asserts that
  // property at source so it cannot be quietly changed. Teaching dkVerdict a second transport to reach
  // one call site would add the shape it guards against (two runners with the same job) for no defect.
  const r = await sshExecInCxell({ sshPort, slug, cmd: sh, timeoutMs });
  if (/__ZEE_TALK_QUEUED__/.test(r.out)) return { sent: true, text, delivery: 'queued' };
  if (!/__ZEE_KEYS_SENT__/.test(r.out)) {
    throw new Error(`send-keys did not confirm (exit ${r.code}): ${(r.err || r.out || '').slice(0, 200)}`);
  }
  return { sent: true, text, delivery: 'typed' };
}

// ── INTERRUPT: STOP a zee mid-turn (the fleet PAUSE button) ───────────────────────────────────────
//
// Every other verb here starts or continues a turn. This one ENDS one, on purpose, while it is still
// running — the fan-out behind the console's pause button (lib/fleet-pause.js).
//
// It is a SIGINT to the headless run inside the cage, i.e. exactly the Ctrl-C a human would type, and
// that choice is the whole design:
//   • the transcript JSONL is appended as the turn goes, so the session is intact and RESUMABLE the
//     moment the operator presses play (nudgeCxellZee --resume picks it up mid-conversation);
//   • nothing in the workspace is touched — no commits, no branch, no gate, no request. A paused zee
//     loses the rest of its turn and nothing else.
// TERM is the escalation for a run that ignores the interrupt, and a run that survives BOTH is
// reported as stuck rather than papered over: "paused" that left a zee working is the one outcome
// this must never claim (an operator who thinks the fleet is stopped will do things that assume it).
//
// HEADLESS_PROC_PATTERN, not AGENT_PROC_PATTERN: the headless run is the queenzee's turn, which is
// what a pause means. A human's own interactive `claude --resume` in the pane is THEIR session — a
// pause must not kill the terminal somebody is typing in. The BRACKETS in that pattern are load-
// bearing here for a second reason on top of the one documented at its definition: this string is
// interpolated into the shell command, so a pattern that could match its own `bash -lc` wrapper would
// have pkill SIGINT the wrapper — killing the probe and leaving the agent running, which reads as a
// successful pause. `[-]p` cannot match the literal text `[-]p`, so it cannot see itself.
// EXPORTED for the same reason WARM_MARKERS is: the verdict-contract guard drives every marker-based
// exec through a shim and needs the set the script declares (test/dk-verdict-contract.test.mjs).
export const INTERRUPT_MARKERS = ['__ZEE_INT_IDLE__', '__ZEE_INT_SIGINT__', '__ZEE_INT_SIGTERM__', '__ZEE_INT_STUCK__'];

// The exact remote command behind "stop this zee now" — PURE, so the whole escalation is testable
// without a container (the same contract as cxellTalkCommand).
export function cxellInterruptCommand({ pattern = HEADLESS_PROC_PATTERN, graceMs = 4000 } = {}) {
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const p = sq(pattern);
  const tries = Math.max(1, Math.ceil(graceMs / 500));
  return [
    // Nothing running is a legitimate, common answer (a zee between turns) — not a failure.
    `if ! pgrep -f ${p} >/dev/null 2>&1; then echo __ZEE_INT_IDLE__; exit 0; fi`,
    `pkill -INT -f ${p} 2>/dev/null || true`,
    `for i in $(seq 1 ${tries}); do pgrep -f ${p} >/dev/null 2>&1 || { echo __ZEE_INT_SIGINT__; exit 0; }; sleep 0.5; done`,
    `pkill -TERM -f ${p} 2>/dev/null || true`,
    `for i in $(seq 1 4); do pgrep -f ${p} >/dev/null 2>&1 || { echo __ZEE_INT_SIGTERM__; exit 0; }; sleep 0.5; done`,
    `echo __ZEE_INT_STUCK__`,
  ].join('; ');
}

// A cage that is not there. `docker exec` on a removed or stopped container exits non-zero with the
// daemon's own words and no verdict on stdout — and that is NOT the same failure as "we could not tell
// whether the zee stopped". There is provably no turn running in a container that does not exist, so it
// belongs with IDLE. Classifying it as unreachable instead would make every pause on a fleet carrying
// one stale zee row cry "⚠ NOT confirmed stopped", and a warning that fires on a healthy fleet is a
// warning nobody reads the day it matters.
const CAGE_GONE = /no such container|is not running|no such object|container .* is not running/i;

// Interrupt the headless turn running in ONE cxell. Resolves
// { stopped, how: 'sigint'|'sigterm'|'stuck'|null, idle, gone? } — `idle:true` meaning there was no
// turn to stop, which is a success for a pause (the zee is already not working) and is counted
// separately so the receipt can say how many zees were actually mid-turn. Rejects only when the cage
// could not be reached in a way we cannot interpret; the caller reports that per xell rather than
// failing the whole pause.
export async function interruptCxellZee({ ctx = 'default', slug, name = null, graceMs = 4000, timeoutMs = 30000 } = {}) {
  const cname = name || cxellName(slug);
  const r = await dkVerdict(ctx, ['exec', cname, 'bash', '-lc', cxellInterruptCommand({ graceMs })],
    { markers: INTERRUPT_MARKERS, label: `${slug || cname}: interrupt`, timeoutMs });
  switch (r.verdict) {
    case '__ZEE_INT_IDLE__':    return { stopped: true,  idle: true,  how: null,       verdict: r.verdict };
    case '__ZEE_INT_SIGINT__':  return { stopped: true,  idle: false, how: 'sigint',   verdict: r.verdict };
    case '__ZEE_INT_SIGTERM__': return { stopped: true,  idle: false, how: 'sigterm',  verdict: r.verdict };
    case '__ZEE_INT_STUCK__':   return { stopped: false, idle: false, how: 'stuck',    verdict: r.verdict };
    default:
      // No marker at all: the exec ran but said nothing we declared. Do NOT read that as stopped —
      // unless the daemon says the container is gone, which is its own answer (above).
      if (CAGE_GONE.test(`${r.err || ''} ${r.out || ''}`)) {
        return { stopped: true, idle: true, gone: true, how: null, verdict: null };
      }
      throw new Error(`interrupt gave no verdict (exit ${r.code}): ${(r.err || r.out || '').slice(0, 160) || 'no output'}`);
  }
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

// Write a file into a cxell's /work/repo ONLY IF the bytes there differ — the delivery path for a
// PROJECTION the meta-DB owns and re-computes (today: .zeehive.env, see lib/provision.js
// refreshLiveCxellEnv), as opposed to a message, which is new every time.
//
// The comparison happens INSIDE the cage, in the same exec that would do the writing, because the
// copy that matters is the one the zee reads and nothing on the host can tell you what that is. A
// re-emit whose text is unchanged must therefore write NOTHING here: a file changing under a working
// zee is otherwise indistinguishable from the zee having changed it (the rule
// reinjectHarnessIntoLiveXells earned), and mtime is all a zee has to go on.
//
// Truncate-in-place (`cat "$tmp" > "$P"`) rather than `mv`: the target is an existing file the zee
// owns, and moving a root-or-mktemp-owned temp file over it would hand the zee a file it cannot
// write. The payload is buffered first so the decision cannot half-happen. Resolves
// { changed, path } — changed:false meaning the cage already held exactly these bytes.
export async function writeFileIntoCxellIfChanged({ ctx = 'default', slug, relPath, text, timeoutMs = 30000 }) {
  const name = cxellName(slug);
  const safe = String(relPath).replace(/\\/g, '/').split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
  if (!safe) throw new Error('empty target path');
  const full = `/work/repo/${safe}`;
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  // ONE exit path, and no early `exit` in the SAME branch. The first version exited the moment the
  // comparison matched — immediately after `cat` drained stdin — and production answered with exit 1
  // and a perfectly good SAME on stdout, while the WROTE branch (which does more work before
  // finishing) exited 0. That smells like the shell exiting out from under the CLI's stdin copy, and
  // it is not worth proving: a single exit that always falls off the end removes the difference,
  // and the verdict below no longer depends on the exit code either way.
  const script = [
    'set -e',
    `P=${sq(full)}`,
    'tmp="$(mktemp)"',
    'cat > "$tmp"',
    'V=WROTE',
    // sha256sum (coreutils, same package as the base64/mktemp already relied on here) rather than
    // cmp/diff: a byte-exact comparison with no diffutils dependency on the agent image.
    'if [ -f "$P" ] && [ "$(sha256sum < "$tmp" | cut -d" " -f1)" = "$(sha256sum < "$P" | cut -d" " -f1)" ]; then',
    '  V=SAME',
    'else',
    '  mkdir -p "$(dirname "$P")"',
    '  cat "$tmp" > "$P"',
    'fi',
    'rm -f "$tmp"',
    'echo "$V"',
  ].join('\n');
  // THE CONTAINER SAYS WHAT IT DID, and that outranks its exit status — which is why this goes
  // through dkVerdict and not dk. dk used to reject on a non-zero exit before the verdict was ever
  // read, so `docker exec` returning 1 alongside SAME — the healthy no-op — was recorded as "the cage
  // is stale" on every unchanged xell in the fleet. A false failure on the success path is worse than
  // the silence this mechanism replaced, and it flew a broken badge in the console to prove it.
  const r = await dkVerdict(ctx, ['exec', '-i', name, 'bash', '-lc', script],
                            { markers: ['SAME', 'WROTE'], label: `${name}: ${safe}`,
                              input: String(text ?? ''), timeoutMs });
  if (!r.verdict) {
    // The ONE real failure: no verdict. Then we do not know what is in the file, and guessing
    // "unchanged" is the lie this helper exists to avoid. The exit code and BOTH streams ride along —
    // they are diagnosis now, rather than the thing that decided the outcome.
    throw new Error(`the cxell did not report what it did with ${safe} (exit ${r.code}, `
      + `${dkSaid(r, 200)})`);
  }
  return { changed: r.verdict === 'WROTE', path: full, rel: safe, exit_code: r.code };
}

// Write a GENERATED file into a cxell — but never over a git-TRACKED path.
//
// This is the injector for the project entry-point docs (lib/project-docs.js): markdown the meta-DB
// owns and the queenzee materializes into a xell, exactly like the harness files. The difference is
// WHERE they land — a repo-relative path like AGENTS.md, which the project itself may already have
// committed. Writing over that would replace the project's own instructions with an operator's, dirty
// the worktree of every xell, and put a file nobody wrote into a landing diff for a human to approve.
//
// So git decides, inside the cage, in the same exec that would do the writing: tracked → nothing is
// written and the caller is told why; untracked → written AND added to .git/info/exclude, so the
// artefact can never travel into a commit either. The payload is buffered to a temp file first so the
// decision cannot half-happen (and so a skip does not break the pipe mid-write).
export async function writeGeneratedDocIntoCxell({ ctx = 'default', slug, relPath, text, timeoutMs = 30000 }) {
  const name = cxellName(slug);
  const safe = String(relPath).replace(/\\/g, '/').split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
  if (!safe) throw new Error('empty target path');
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const script = [
    'set -e',
    'cd /work/repo',
    `P=${sq(safe)}`,
    'tmp="$(mktemp)"',
    'cat > "$tmp"',
    'if git ls-files --error-unmatch -- "$P" >/dev/null 2>&1; then rm -f "$tmp"; echo TRACKED; exit 0; fi',
    'mkdir -p "$(dirname "$P")"',
    'mv "$tmp" "$P"',
    'if [ -d .git ]; then grep -qxF "$P" .git/info/exclude 2>/dev/null || echo "$P" >> .git/info/exclude; fi',
    'echo WROTE',
  ].join('\n');
  // Through dkVerdict, like every other exec that states its own outcome. This site is where the
  // verdict was read as `String(await dk(...))` — '[object Object]', matching nothing — so every doc
  // the container really DID write was reported as skipped: the write worked and the report lied. The
  // helper hands back a STRING there is no object to stringify by accident.
  const r = await dkVerdict(ctx, ['exec', '-i', name, 'bash', '-lc', script],
                            { markers: ['WROTE', 'TRACKED'], label: `${name}: ${safe}`,
                              input: String(text ?? ''), timeoutMs });
  if (r.verdict === 'TRACKED') {
    return { written: false, skipped: 'tracked', rel: safe,
      reason: `${safe} is tracked by git in this xell — the project's own committed copy is left alone` };
  }
  if (r.verdict === 'WROTE') return { written: true, rel: safe, path: `/work/repo/${safe}` };
  // No verdict AND a failed exec: the container never got to speak (no such container, the script died
  // before its echo). This site still REJECTS on that, exactly as it did when dk did the rejecting —
  // a caller of the doc injector treats a broken exec as a broken exec, not as a skip.
  if (r.code !== 0) throw new Error(`docker exec exited ${r.code}: ${dkSaid(r)}`);
  // ANYTHING ELSE IS LOUD. An unrecognised verdict used to be indistinguishable from a deliberate
  // skip — that silence is what let the parse bug survive a ship. The raw output rides back so the log
  // names what actually came out of the container.
  return { written: false, skipped: 'unknown', rel: safe,
    reason: `${safe}: the injector could not read the container's answer `
      + `(got ${JSON.stringify(String(r.out || '').trim().slice(0, 60))})` };
}

export async function removeCxell({ ctx, slug }) {
  await dk(ctx, ['rm', '-f', cxellName(slug)]).catch(() => {});
  // pre-rename containers (zee_cage_<slug>) from the old-vocabulary era — idempotent, so this
  // line retires with the last of them
  await dk(ctx, ['rm', '-f', `zee_cage_${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`]).catch(() => {});
}
