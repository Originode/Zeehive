// THE SHARED PACKAGE CACHE — one npm cache for the whole fleet instead of one per xell.
//
// Nothing here is broken today: warmCxell() already runs `npm ci` inside a cxell, and
// start-xell-process.sh runs one on a host worktree at first start. The waste is that each of them
// starts from a COLD cache — a cxell is a fresh container with its own empty `~/.npm`, so every
// xell of every project re-downloads the same tarballs from the registry, every time. Ticket #7 is
// a human noticing that ("so they dont have to install it every time").
//
// The fix is deliberately dull: point npm at a cache that OUTLIVES the container (a docker volume
// for cxells, a directory beside the repos volume for host worktrees). `npm ci` then unpacks from
// local content-addressed storage instead of the network. It is project-agnostic by construction —
// the cache is keyed by package identity, so OmniBiz's dependencies warm Zeehive's and vice versa.
//
// TWO RULES THIS MODULE EXISTS TO KEEP:
//  1. **Best-effort, always.** A cold volume, an unwritable cache, a failed warm — none of it may
//     fail a provision or a dispatch. A zee that installs for itself is slow; a dispatch that dies
//     because a cache was cold is broken. Every entry point here either returns empty args or
//     swallows its own failure.
//  2. **`npm ci`, NEVER `npm install`, on a worktree the pool watches.** install rewrites
//     package-lock.json, the pool reads that as a dirty worktree and reaps the xell — a live
//     provision→build→reap loop (seen 2026-07-20). A worktree with no lockfile is SKIPPED here
//     rather than installed; the lockfile-less fallback stays where it already is, in
//     start-xell-process.sh, at a point where the xell is being used rather than pooled.
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logline } from './logbus.js';

// Where the cache is mounted INSIDE a cxell. Not `~/.npm`: an explicit path plus NPM_CONFIG_CACHE
// is immune to the container's HOME (the zee's shell, an ssh login and a `docker exec` do not
// necessarily agree on it), and it is obvious in `docker inspect` what that mount is for.
export const CXELL_NPM_CACHE_DIR = '/npm-cache';

// The docker volume every cxell shares. `CXELL_NPM_CACHE_VOLUME=off` (or empty) turns the whole
// mechanism off and restores today's per-container cache — the escape hatch if a shared cache ever
// misbehaves on a fleet.
export function npmCacheVolume() {
  const v = (process.env.CXELL_NPM_CACHE_VOLUME ?? 'zeehive_npm_cache').trim();
  return !v || /^(off|none|no|0|false)$/i.test(v) ? null : v;
}

// The `docker run` arguments that mount it. Empty when disabled — the caller splices them in, so
// "off" is literally the absence of a mount, not a flag someone has to honour.
export function cxellCacheRunArgs() {
  const vol = npmCacheVolume();
  return vol ? ['-v', `${vol}:${CXELL_NPM_CACHE_DIR}`, '-e', `NPM_CONFIG_CACHE=${CXELL_NPM_CACHE_DIR}`] : [];
}

// A named volume is created ROOT-owned the first time it is mounted at a path the image does not
// already carry — and npm runs as `zee`, which would then hit EACCES on its own cache. The image
// now ships the directory (Dockerfile.zee-agent) so a fresh volume inherits zee ownership; this
// root exec is belt-and-braces for volumes created before that, and for any fleet where the image
// is older than the queenzee. Non-recursive on purpose: the cache contents are already zee-owned,
// and a recursive chown over a large cache would cost more than the cache saves.
export function cxellCacheFixupCommand(name) {
  if (!npmCacheVolume()) return null;
  return ['exec', '-u', '0', name, 'bash', '-lc',
    `chown zee:zee ${CXELL_NPM_CACHE_DIR} 2>/dev/null; test -w ${CXELL_NPM_CACHE_DIR} && echo CACHE_RW || echo CACHE_RO`];
}

// The HOST-side twin: where a worktree's own `npm ci` should cache. Only when the queenzee has a
// repos volume (the container era) — that directory is shared by every project's worktrees, which
// is exactly the scope we want. With no reposDir (the host era) this returns null and npm keeps its
// own default, i.e. today's behaviour, unchanged.
export function hostNpmCacheDir() {
  const explicit = (process.env.ZEEHIVE_NPM_CACHE || '').trim();
  if (explicit) return /^(off|none|no|0|false)$/i.test(explicit) ? null : explicit;
  return config.reposDir ? resolve(config.reposDir, '.npm-cache').replace(/\\/g, '/') : null;
}

// Environment for any npm the queenzee spawns on the host (the process-role starter, the warm
// below). Merges rather than replaces, so a caller's env survives.
export function npmCacheEnv(base = {}) {
  const dir = hostNpmCacheDir();
  if (!dir) return base;
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { return base; }
  return { ...base, NPM_CONFIG_CACHE: dir };
}

// Is this worktree one we may warm? A lockfile is the whole condition: `npm ci` REQUIRES one, and
// the alternative (`npm install`) is the reap loop. No package.json → nothing to do at all.
export function warmableWorktree(worktree) {
  const wt = String(worktree || '').replace(/\\/g, '/');
  if (!wt || !existsSync(wt)) return { warmable: false, reason: 'no worktree' };
  if (!existsSync(resolve(wt, 'package.json'))) return { warmable: false, reason: 'not a node project' };
  if (!existsSync(resolve(wt, 'package-lock.json'))) {
    return { warmable: false, reason: 'no package-lock.json — `npm install` would rewrite the lock and the pool would reap this xell' };
  }
  if (existsSync(resolve(wt, 'node_modules'))) return { warmable: false, reason: 'node_modules already present' };
  return { warmable: true, reason: null };
}

// The argv, as data, so a test can assert "ci, never install" without running npm.
export const WARM_ARGS = ['ci', '--no-audit', '--no-fund'];

// WARM A POOLED XELL'S WORKTREE, on the pool's clock instead of the zee's.
//
// A pooled xell sits `ready` for minutes or hours before anyone claims it; doing its `npm ci` then
// costs nobody anything, fills the shared cache for every xell that follows, and means the first
// build of a process-runner role is not also a cold install. Fire-and-forget: the caller does not
// await it, and every failure is a logline, never a throw.
export function warmWorktree(worktree, { slug = '', timeoutMs = 900000 } = {}) {
  const wt = String(worktree || '').replace(/\\/g, '/');
  const { warmable, reason } = warmableWorktree(wt);
  if (!warmable) {
    logline('pool', `${slug || wt}: worktree warm skipped — ${reason}`);
    return Promise.resolve({ warmed: false, skipped: true, reason });
  }
  const started = Date.now();
  return new Promise((res) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; res(r); } };
    let p;
    try {
      p = spawn('npm', WARM_ARGS, { cwd: wt, env: npmCacheEnv({ ...process.env }), windowsHide: true, shell: process.platform === 'win32' });
    } catch (e) {
      logline('pool', `${slug || wt}: worktree warm could not start (${e.message}) — the zee will install as needed`);
      return finish({ warmed: false, error: e.message });
    }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } }, timeoutMs);
    let err = '';
    p.stderr?.on('data', (d) => { err = (err + d).slice(-800); });
    p.on('error', (e) => {
      clearTimeout(timer);
      logline('pool', `${slug || wt}: worktree warm failed to spawn npm (${e.message}) — the zee will install as needed`);
      finish({ warmed: false, error: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      if (code === 0) {
        logline('pool', `${slug || wt}: worktree warmed in ${secs}s (npm ci, shared cache ${hostNpmCacheDir() || 'default'}) — the zee starts with node_modules`);
        finish({ warmed: true, seconds: secs });
      } else {
        logline('pool', `${slug || wt}: worktree warm incomplete after ${secs}s (npm ci exit ${code}) — NOT fatal, the zee will install as needed: ${err.trim().slice(-200)}`);
        finish({ warmed: false, code, seconds: secs });
      }
    });
  });
}
