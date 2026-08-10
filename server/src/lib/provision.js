// Deterministic xell provisioning. Materializes a xell + its container stack in the
// meta-DB. In 'real' mode it also runs scripts/provision-xell.sh (git worktree +
// spin-env up on ugreen-nas); in 'simulate' mode it only records the modeled state
// (correctly-computed ports/names) with NO live side effects on the dev NAS.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pool, q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { headCommit, cleanGitEnv } from './git.js';
import { resolveSite } from './sites.js';
import { namingFor, serverRoleIsProcess } from './manifest.js';
import { resolveBash } from './bash.js';
import { pickDevMachine, machineForCtx, sharedDevDb, defaultBuildCtxFor, queenzeeHostCtx,
         implicitPoolMachine, liveXellCount } from './machines.js';
import { dbIdentity } from './projects.js';
import { derivedTcpDsn } from './xell-db.js';
import { resolveEnvironmentFor, fullVarsFor, isOnProduction } from './environments.js';
import { warmWorktree } from './npm-cache.js';
import { normalizeSpawnPrep, prewarmsCage, templateHash } from './spawn-prep.js';
import { ensureCxell, cloneIntoCxell, warmCxell, preppedImageIfPresent, ensurePreppedImage, cxellName } from './cxell.js';
import { deviceConfig } from './devices.js';
import { logline, activity } from './logbus.js';
import { raiseEnvAlert, clearEnvAlert } from './status.js';
import { processRoleReachableHost, processRolePublishedUrl } from '../queenzee/containers.js';

// Same switch every other real-side-effect module reads (intake, pool, xell-db, machines): 'real'
// touches machines, anything else models. The fleet-wide .zeehive.env reconcile below obeys it.
const PROVISION_MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* noop */ } };

const ADJ = ['swift', 'calm', 'bright', 'bold', 'keen', 'lively', 'nimble', 'quiet', 'sunny', 'wise'];
const NOUN = ['harbor', 'meadow', 'summit', 'delta', 'ember', 'grove', 'atlas', 'cove', 'ridge', 'vale'];

// WHY a provision failed, in one line a human can act on.
//
// This used to be `stderr.slice(-500)` — the LAST 500 characters. git writes checkout progress to
// stderr ("Updating files: 97% (3089/3184)…"), and on a big repo that progress is several
// THOUSAND characters, so the tail was always the progress bar and the real error was always cut
// off the front. Every failure read as `provision-xell.sh failed: ng files: 92% … done.` — which
// looks like success. That is why 396 orphaned worktrees (139GB) and a wedged docker engine went
// unnoticed for three hours on 2026-07-22; the actual cause was one line the log never showed:
// "❌ /repos/omnibiz/.env not found".
//
// So: drop the progress meters, then prefer the LAST real line — scripts print their complaint
// last. Fall back to the raw tail only if filtering leaves nothing.
export function provisionFailureReason(r) {
  const raw = `${r.stderr || ''}\n${r.stdout || ''}`;
  const lines = raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(Updating files|Checking out files|Receiving objects|Resolving deltas|remote: (Counting|Compressing) objects|Cloning into|Preparing worktree)/i.test(l))
    .filter((l) => !/^[\s.]*\d{1,3}% \(\d+\/\d+\)/.test(l));
  if (!lines.length) return (r.stderr || '(no output)').trim().slice(-300);
  return lines.slice(-3).join(' | ').slice(0, 600);
}

// Mirror of spin-env.sh: slot = (first 4 hex of md5(slug)) % slot_mod. Bases/mod come from the
// project row (port_server_base/port_web_base/port_slot_mod); the numeric defaults keep the
// OmniBiz-era values for callers that don't pass a project.
export function computePorts(slug, project = {}) {
  const mod = Number(project.port_slot_mod) || 90;
  const hex = crypto.createHash('md5').update(slug).digest('hex').slice(0, 4);
  const slot = parseInt(hex, 16) % mod;
  return {
    slot,
    serverPort: (Number(project.port_server_base) || 3100) + slot,
    webPort: (Number(project.port_web_base) || 5200) + slot,
  };
}

// The harness-free projection (spec §3.4): a generated, gitignored env file in the worktree so
// `docker compose --env-file .env --env-file .zeehive.env -f <spinoff compose> up` works with
// ZEEHIVE stopped. Parameters ONLY — never secrets (those stay in the main checkout's .env).
// Pure projection of meta-DB truth: regenerable at any time, meaningless to hand-edit.
// Two postgres URLs meaning the same database? Compared on host:port+dbname, not string equality
// — localhost spellings differ but the port+db pair is what actually collides.
function sameDatabase(a, b) {
  const parse = (s) => { try { return new URL(String(s).replace(/^postgres(ql)?:/, 'http:')); } catch { return null; } };
  const ua = parse(a), ub = parse(b);
  if (!ua || !ub) return String(a) === String(b);
  const host = (u) => (['localhost', '127.0.0.1', '::1'].includes(u.hostname) ? 'localhost' : u.hostname);
  return host(ua) === host(ub) && ua.port === ub.port && ua.pathname === ub.pathname;
}

// WHICH DATABASE THIS XELL IS MEANT TO TALK TO — the one rule, in one place.
//
// Extracted out of writeXellEnv unchanged, because a second reader needs the SAME answer: the
// readiness preflight (lib/preflight.js) opens the DSN the queenzee wrote and reports whether it
// actually answers. A preflight that recomputed the binding its own way would be checking a
// different string from the one the zee is handed, which is the class of bug it exists to catch.
// `containers` is the xell's own server/webapp/db rows (role + conn_ref), as writeXellEnv reads them.
//
// Answers { dsn, source, binding_is_prod }: `source` names WHICH rule produced the DSN, so a caller
// can say where the string came from without re-deriving it.
//
// HARD GUARD (spec §6.2) lives in writeXellEnv, not here: never EMIT the managing instance's
// meta-DB — two queenzees reconciling one meta-DB reap each other's xells; that failure class has
// destroyed live work before, so it is a refusal, not a warning. This function only resolves.
//
// FIRST, before the xell's own db container: PRODUCTION, when the COUPLING says the xell holds
// it. A xell on prod is an ordinary pooled spinoff — owned db container and all — that was THEN
// re-pointed (attachXellDb links the prod container and flips the coupling together), so taking
// the owned container first meant the file quietly named the throwaway spinoff database while
// the binding advertised production (ticket #15). The binding is what the zee was TOLD it has,
// so the binding wins. Emitted at all because a cxell zee has no docker and reaches postgres
// over TCP.
//
// The two prod couplings are the same link and DIFFERENT credentials, and that distinction is a
// safety boundary, not a detail:
//   • db-shared-prod  — a full human-granted bind: the prod container's own conn_ref.
//   • db-prod-readonly — the manager binding: ONLY the SELECT-only DSN lib/prod-readonly.js
//     minted for this xell. Never the prod owner's connection string — following the binding
//     must never widen a reader into a writer — and never its own clone either. If the reader
//     was not minted (or was dropped) while the xell is still LINKED to prod, we emit no
//     DATABASE_URL at all: no database is a fixable state, the wrong database is a silent one.
// A coupling with NO prod db linked (a project with no production registered — bindManagerTo-
// ProdReadonly skips the bind there) is not "on prod" in any usable sense, so it falls through
// to the ordinary resolution below and keeps whatever database it really has.
export async function resolveXellDsn(xell, project, containers = []) {
  const xellId = xell.id;
  let dbUrl = null;
  let source = null;
  let bindingIsProd = false;                 // linked to prod → the owned container is NOT a fallback
  if (xell.db_coupling === 'db-shared-prod' || xell.db_coupling === 'db-prod-readonly') {
    const linkedProd = await one(
      `SELECT c.conn_ref, c.host AS host, c.host_port
         FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
        WHERE uc.xell_id=$1 AND c.role='db' AND c.tier='prod' LIMIT 1`, [xellId]);
    bindingIsProd = !!linkedProd || !!xell.prod_ro_dsn;
    // db-shared-prod with a conn_ref-less prod row falls back to the row's PUBLISHED ADDRESS
    // (host:host_port). This is the omnibiz bug: its prod db records no conn_ref (only host +
    // host_port, on another machine's docker context), so the projection emitted NO DATABASE_URL,
    // the binding's psql said `docker exec` — impossible in a cage — and a prod-bound cxell zee
    // concluded the online production db was unreachable. The address was reachable over TCP all
    // along; the file just never said so. db-prod-readonly is deliberately NOT widened: the minted
    // SELECT-only DSN or nothing — following the binding must never turn a reader into a writer.
    dbUrl = xell.db_coupling === 'db-prod-readonly'
      ? (xell.prod_ro_dsn || null)
      : (linkedProd?.conn_ref
        || derivedTcpDsn(linkedProd, await dbIdentity(xell.project_id))
        || xell.prod_ro_dsn || null);
    if (dbUrl) source = xell.db_coupling === 'db-prod-readonly' ? 'prod-readonly-dsn' : 'prod-linked';
    if (bindingIsProd && !dbUrl) {
      logline('prod-ro', `${xell.slug}: coupled ${xell.db_coupling} but no usable production DSN `
        + '(no minted reader / the prod container row records no conn_ref and publishes no '
        + 'host:host_port) — .zeehive.env is emitted with NO DATABASE_URL rather than a database '
        + 'the binding does not mean');
    }
  }
  // …else the xell's OWN db container, when it has one.
  if (!dbUrl && !bindingIsProd) {
    dbUrl = containers.find((c) => c.role === 'db')?.conn_ref || null;
    if (dbUrl) source = 'own-db-container';
  }
  // db-clone: no owned db container, but its OWN database (db_instance row) inside the shared
  // dev postgres — the shared container's conn_ref with the database name swapped for the
  // clone's. The bare conn_ref must never be emitted for a clone xell: it names the SHARED db.
  if (!dbUrl && xell.db_coupling === 'db-clone') {
    const inst = await one(
      `SELECT di.name, c.conn_ref FROM db_instance di JOIN container c ON c.id = di.container_id
        WHERE di.owner_xell_id=$1 AND di.kind='clone' AND c.conn_ref IS NOT NULL LIMIT 1`, [xellId]);
    if (inst?.conn_ref) {
      try {
        const u = new URL(String(inst.conn_ref).replace(/^postgres(ql)?:/, 'http:'));
        u.pathname = `/${inst.name}`;
        dbUrl = String(u).replace(/^http:/, 'postgresql:');
        source = 'clone-instance';
      } catch { /* unparseable conn_ref — emit nothing rather than the shared db */ }
    }
  }
  // db-shared-dev on a PROCESS-runner project: the xell's server is a bare process, so unlike a
  // compose stack there is no network alias handing it a database — the projection must carry
  // the shared dev db's conn_ref outright. Scoped to process runners so compose projects keep
  // their env exactly as it was. The §6.2 guard still applies unchanged.
  const spin = project?.manifest?.tiers?.spinoff || {};
  const spinRunner = spin.runner || null;
  if (!dbUrl && xell.db_coupling === 'db-shared-dev' && spinRunner === 'process') {
    const used = await one(
      `SELECT c.conn_ref FROM xell_uses_container xuc JOIN container c ON c.id = xuc.container_id
        WHERE xuc.xell_id=$1 AND xuc.relation='uses' AND c.role='db' AND c.conn_ref IS NOT NULL LIMIT 1`,
      [xellId]);
    if (used?.conn_ref) { dbUrl = used.conn_ref; source = 'shared-dev-container'; }
  }
  // conn_refs are stored passwordless ("parameters, not secrets") — fine for docker-exec psql,
  // fatal for a bare process that must SCRAM-authenticate over TCP. The manifest's db block may
  // carry the committed dev credential (the same one the compose files already commit); inject
  // it for process xells when the ref has none. Anything genuinely secret stays out of manifests.
  const manifestDb = project?.manifest?.db || {};
  if (dbUrl && spinRunner === 'process' && manifestDb.password) {
    try {
      const u = new URL(String(dbUrl).replace(/^postgres(ql)?:/, 'http:'));
      if (!u.password) {
        if (!u.username && manifestDb.user) u.username = manifestDb.user;
        u.password = manifestDb.password;
        dbUrl = String(u).replace(/^http:/, 'postgresql:');
      }
    } catch { /* unparseable ref — emit as-is and let the guard/consumer complain */ }
  }
  return { dsn: dbUrl, source, binding_is_prod: bindingIsProd };
}

// Write a xell's .zeehive.env. Throws on refusal/failure; the wrapper below records the outcome.
// The two "there is nothing on disk to write to" throws are marked `no_worktree`: they are the
// ordinary state of a pooled xell, not a projection failure worth flagging to a human.
async function writeXellEnv(xellId, { dryRun = false } = {}) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell?.worktree_path) throw Object.assign(new Error('xell has no worktree'), { no_worktree: true });
  if (!existsSync(xell.worktree_path)) {
    throw Object.assign(new Error(`worktree does not exist: ${xell.worktree_path}`), { no_worktree: true });
  }
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  const site = await resolveSite(xell.project_id, 'dev');
  const cs = await q(
    `SELECT role, host_port, conn_ref, docker_ctx FROM container
      WHERE owner_xell_id=$1 AND role IN ('server','webapp','db')`, [xellId]);
  const portOf = (role) => cs.find((c) => c.role === role)?.host_port ?? '';
  // The context the xell's stack ACTUALLY runs on — machines made this per-xell, so the site's
  // default is only the fallback for rows that predate context stamping.
  const xellCtx = cs.find((c) => c.role === 'server')?.docker_ctx || null;

  const spin = project?.manifest?.tiers?.spinoff || {};
  const serverEnv = spin.ports?.server?.env || 'SPINOFF_SERVER_PORT';
  const webEnv = spin.ports?.webapp?.env || 'SPINOFF_WEB_PORT';
  const lines = [
    '# .zeehive.env — GENERATED by ZEEHIVE from the meta-DB. Do not edit; regenerate via the console.',
    `SPINOFF_SLUG=${xell.slug}`,
    `${serverEnv}=${portOf('server')}`,
    `${webEnv}=${portOf('webapp')}`,
    `ZEEHIVE_SITE=${site?.key || 'dev'}`,
    `ZEEHIVE_DOCKER_CONTEXT=${xellCtx || site?.docker_ctx || config.dockerCtx}`,
  ];

  // DATABASE_URL — the one database this xell's zee is meant to talk to (resolveXellDsn above).
  const { dsn: dbUrl } = await resolveXellDsn(xell, project, cs);
  if (dbUrl) {
    if (sameDatabase(dbUrl, config.databaseUrl)) {
      // §6.2, and the ONE exemption — the minted READ-ONLY reader.
      //
      // What the refusal protects against is a nested queenzee OPERATING on the managing instance's
      // meta-DB: two reconcilers on one meta-DB reap each other's xells, and that has destroyed live
      // work. Every part of that needs WRITE access — DELETE, UPDATE, the reaper. A db-prod-readonly
      // xell holds a role minted by lib/prod-readonly.js: NOSUPERUSER, no write grant of any kind,
      // `default_transaction_read_only = on`. It cannot reap anything; the worst it can do is crash
      // its own nested server on the first INSERT.
      //
      // It has to be exempt, because when ZEEHIVE orchestrates ITSELF the production database IS the
      // managing instance's meta-DB: refusing here would refuse the ENTIRE projection (ports, site,
      // env vars — the file is written at the end) for every manager zee on this project, and the
      // manager would keep pointing at its own throwaway spinoff db while its binding said
      // production. That is ticket #15 again, with a scarier log line.
      //
      // The exemption is deliberately as narrow as it can be: this exact xell must be coupled
      // read-only AND the URL must be the DSN the queenzee itself minted for it. An owner credential,
      // an owned db container, a clone — anything else that resolves to the meta-DB is still refused.
      const readerBinding = xell.db_coupling === 'db-prod-readonly' && dbUrl === xell.prod_ro_dsn;
      if (!readerBinding) {
        throw new Error(`REFUSING to emit .zeehive.env: the xell's DATABASE_URL resolves to the `
          + `managing instance's own meta-DB (${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')}) — `
          + 'a nested queenzee on the real meta-DB reaps live xells. Re-point the xell db first.');
      }
      logline('prod-ro', `${xell.slug}: DATABASE_URL is the managing instance's own meta-DB, emitted `
        + 'because this xell holds it READ-ONLY (SELECT-only role) — the §6.2 reap risk needs writes');
    }
    lines.push(`DATABASE_URL=${dbUrl}`);
  }

  // QUEENZEE_INPROC=false — API-only when this xell shares THE queenzee's meta-DB (TKT-136-FE32).
  //
  // index.js takes advisory lock 715533001 on whatever DATABASE_URL it opens. A spinoff whose
  // DATABASE_URL is the same meta-DB THE live queenzee already holds that lock on waits 90s and
  // restart-loops, while `zee build server --wait` may still report UP. The flag (config.js /
  // index.js) starts the server without the lock and without any loop — every route still serves.
  //
  // WHEN we project it (both signals mean the same physical fact — "this xell's db IS the
  // managing meta-DB"):
  //   • db_coupling === 'db-shared-dev' — the shared-dev coupling for process-runner Zeehive
  //     xells (resolveXellDsn source 'shared-dev-container'). sameDatabase() alone is not enough
  //     here: the published host:port (10.x:32768) and the queenzee's in-network DSN (meta-db:5432)
  //     name the same postgres with different host strings, so the §6.2 helper returns false while
  //     the lock still collides.
  //   • sameDatabase(dbUrl, config.databaseUrl) — covers the db-prod-readonly exemption (and any
  //     future path) that emits the managing meta-DB DSN under a different coupling name.
  //
  // WHAT we deliberately leave alone: a xell on its OWN db (clone / isolated / owned container)
  // keeps the default (inproc=true) so a nested queenzee on a private meta still takes the lock
  // and runs loops under the §6.2 simulate safety flags. THE real queenzee has no .zeehive.env
  // and stays default-true.
  //
  // Both eras read this projection: start-xell-process.sh unsets every key the file owns so
  // dotenv re-reads it (process runner); compose spinoffs that load the worktree projection get
  // the same value. A structural key — reserved below so an environment cannot flip it back.
  if (xell.db_coupling === 'db-shared-dev'
      || (dbUrl && sameDatabase(dbUrl, config.databaseUrl))) {
    lines.push('# —— QUEENZEE_INPROC=false: shared meta-DB → API-only (no lock 715533001, no loops; TKT-136) ——');
    lines.push('QUEENZEE_INPROC=false');
  }

  // Environment vars — the meta-DB source of truth for the untracked .env (migration 043).
  // Resolved by tier: a xell ON PRODUCTION (environments.isOnProduction — writing it, reading it
  // read-only, or being it) gets the project's default PROD environment, else the default DEV one;
  // an explicit xell.environment_id overrides. Merged AFTER the per-xell truth above (ports/DATABASE_URL/site/slug) and BEFORE the manifest safety
  // defaults below, and it can never override either: any name already emitted (or declared in
  // spin.env) is skipped, so an environment can't redirect DATABASE_URL past the §6.2 guard nor
  // undo BUILD_MODE=simulate. Best-effort — a projection failure must not sink provisioning.
  //
  // The resolution is STATED in the file even when it contributes nothing. A project whose
  // environments are empty (Zeehive's own dev AND prod are, today: 0 vars each) merges correctly
  // and writes zero lines — which reads exactly like ticket #15 did, "my binding says prod and my
  // .zeehive.env clearly does not". One comment line naming the environment, its tier and its var
  // count is the difference between "the merge is broken" and "the environment is empty", and it
  // costs nothing: a comment is not a variable, so nothing consumes it and no rule bends for it.
  try {
    const env = await resolveEnvironmentFor(xell);
    const envVars = await fullVarsFor(env?.id);
    if (!env) {
      lines.push(`# —— environment: none configured for this project at tier `
        + `${isOnProduction(xell) ? 'prod' : 'dev'} (nothing to merge) ——`);
    } else if (!envVars.length) {
      lines.push(`# —— environment: ${env.key} (${env.tier}) — resolved, but it holds 0 vars in the `
        + 'meta-DB, so nothing was merged ——');
    }
    if (env && envVars.length) {
      // Reserve, UNCONDITIONALLY, the structural keys emitXellEnv owns — not just the ones already
      // emitted. A db-less xell emits no DATABASE_URL line, so a dynamic-only reserve would let an
      // environment introduce its own DATABASE_URL and slip past the §6.2 guard; these names are
      // never an environment's to set, present in the file or not.
      const reserved = new Set([
        'SPINOFF_SLUG', 'DATABASE_URL', 'ZEEHIVE_SITE', 'ZEEHIVE_DOCKER_CONTEXT', 'QUEENZEE_INPROC',
        serverEnv, webEnv,
        ...lines.filter((l) => /^[A-Za-z_]/.test(l)).map((l) => l.split('=')[0]),
      ]);
      for (const k of Object.keys(spin.env || {})) reserved.add(k);
      lines.push(`# —— environment: ${env.key} (${env.tier}) — ${envVars.length} var(s) from the meta-DB ——`);
      for (const { name, value } of envVars) {
        if (reserved.has(name)) continue;   // never fight per-xell wiring or the manifest defaults
        lines.push(`${name}=${value}`);
      }
    }
  } catch (e) {
    console.error(`[provision] ${xell.slug}: environment merge skipped — ${e.message}`);
  }

  // Manifest-declared extra env for spinoffs — for Zeehive itself these are the §6.2 safety
  // defaults (BUILD_MODE=simulate, POOL_TARGET_READY=0, …) that keep a nested queenzee inert.
  for (const [k, v] of Object.entries(spin.env || {})) lines.push(`${k}=${v}`);
  lines.push('');

  const wt = xell.worktree_path.replace(/\\/g, '/');
  const path = `${wt}/.zeehive.env`;
  const text = lines.join('\n');
  // A projection identical to what is already on disk is a NO-OP, not a write. The reconcile below
  // runs over the whole fleet, and a queenzee that rewrites an unchanged file under every working
  // zee is indistinguishable (mtime, watchers, "did I do that?") from the zee having edited it —
  // the same rule reinjectHarnessIntoLiveXells holds for harness files.
  let changed = true;
  try { changed = readFileSync(path, 'utf8') !== text; } catch { changed = true; }   // unreadable/absent → write
  // The zee in the cage reads a COPY of this file, not this file (refreshLiveCxellEnv below). That
  // copy does its OWN comparison, so it runs whether or not the HOST file moved — see the comment
  // there for why keying it off `changed` would leave the affected zees unreachable forever.
  if (dryRun) {                                                                      // report, write nothing
    return { ok: true, path, slug: xell.slug, changed, dry_run: true,
             cxell: await refreshLiveCxellEnv(xell, text, { dryRun: true }) };
  }
  if (changed) writeFileSync(path, text);

  // Keep the projection out of git's sight WITHOUT touching the project's committed .gitignore:
  // the repo-local exclude file (info/exclude, shared across this repo's worktrees) exists for
  // exactly this class of machine-local artifact. Skipping this made land-xell.sh count every
  // fresh xell as dirty and the pool decommissioned them in a loop (2026-07-17). Best-effort —
  // land-xell.sh also excludes it explicitly as defense in depth.
  try {
    const r = spawnSync('git', ['-C', wt, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const excl = r.status === 0 ? r.stdout.trim() : null;
    if (excl) {
      const cur = existsSync(excl) ? readFileSync(excl, 'utf8') : '';
      if (!cur.split(/\r?\n/).includes('.zeehive.env')) {
        mkdirSync(dirname(excl), { recursive: true });
        writeFileSync(excl, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}.zeehive.env\n`);
      }
    }
  } catch { /* exclusion is a nicety; the projection itself matters more */ }
  return { ok: true, path, slug: xell.slug, changed,
           cxell: await refreshLiveCxellEnv(xell, text, { dryRun: false }) };
}

// ── …AND THE COPY THE ZEE ACTUALLY READS ─────────────────────────────────────────────────────────
//
// Everything above lands in the HOST worktree. A cxell zee never reads that file: it reads a COPY,
// `docker cp`d into /work/repo at spawn (lib/cxell.js cloneIntoCxell, beside the git bundle). So
// every re-emit — ticket #15's rule fix, a prod bind, a db-clone, a rename, an environment pin, the
// boot reconcile — was invisible to the only reader that matters: the zee already in the cage,
// working from the values it was born with. A manager bound to production read-only was TOLD it
// holds production while its file named its own throwaway spinoff db, and the fix that shipped
// could not reach it. Fixing the projection and fixing the host file are both necessary and neither
// is sufficient.
//
// So the projection is pushed into the LIVE cxell too, through the mechanism the harness layer
// already uses (reinjectHarnessIntoLiveXells → a docker exec write into cxell_<slug>), under the
// same three rules:
//
//   • IT COMPARES THE COPY IT IS REPLACING, in the cage, in the same exec (writeFileIntoCxellIf-
//     Changed). Identical bytes write nothing, here as on the host: a file changing under a working
//     zee is otherwise indistinguishable from the zee having changed it.
//     The comparison is against the CAGE's copy deliberately, NOT the host `changed` flag above.
//     Keying off the host would be the whole bug again: once the boot reconcile has repaired the
//     host file, host-changed is false at every subsequent emit while the zee's copy stays stale
//     forever — which is the exact state of every xell that was already running when that reconcile
//     shipped.
//   • EVERY WRITE IS LOGGED, saying the queenzee did it, and that whatever already sourced the file
//     keeps the old values until it re-reads or rebuilds.
//   • IT OBEYS PROVISION_MODE, for the reason the harness path documents at length: the exec targets
//     a container named from a fleet row, and a xell's db is a CLONE of the meta-DB, so a NESTED
//     queenzee's fleet rows are the REAL fleet's. In simulate it REPORTS the cxell it would have
//     refreshed and execs nothing.
//
// It never widens a binding: the text is the projection computed above, from this meta-DB, through
// the §6.2 guard. This decides WHERE the projection lands, never WHAT it says.
//
// Never throws — a xell whose file is correct on disk must not fail its emit because its cage is
// unreachable. The outcome is returned, logged, and (in emitXellEnv) recorded on the xell row.
async function refreshLiveCxellEnv(xell, text, { dryRun }) {
  try {
    // Lazily imported: intake.js imports THIS module, so a static import would close a cycle — the
    // same reason lib/harness.js reaches for reinjectHarnessIntoXell this way.
    const { injectXellEnvIntoCxell } = await import('../queenzee/intake.js');
    return await injectXellEnvIntoCxell({ xellId: xell.id, slug: xell.slug, text, dryRun });
  } catch (e) {
    return { live: null, refreshed: false, error: `cxell env refresh unavailable: ${e.message}` };
  }
}

// Emit a xell's .zeehive.env AND record what happened on the xell row. Same signature, same throws,
// same result (plus `changed`) — every existing caller is unaffected.
//
// The bookkeeping is the point: until now the ONLY trace of a failed projection was a log line, and
// every caller after provisioning re-emits best-effort (bindManagerToProdReadonly, dbclone, rename,
// an environment pin). So a manager could be bound to production, be told it holds production, and
// keep a file pointing at its own throwaway spinoff db, with nothing a human could look at (ticket
// #15). env_projected_at / env_projection_error (migration 078) are that read model; fleet.js
// selects x.*, so the console's env chip carries them for free.
// PREPARE A POOLED XELL'S CAGE, on the pool's clock (spawn template `when: 'provision'`).
//
// Everything a dispatch would do to make the cage USABLE — create it (on the prepped image, baking
// it first if the pool has not yet), clone the branch in, run the prep — happens here instead, hours
// before anyone claims the xell. Dispatch then reuses the container, updates the checkout in place
// and finds the marker still valid, so it installs nothing.
//
// What it deliberately does NOT do: mint the identity token, inject the harness, open the attend
// door, seal the firewall or start the agent. Those are per-DISPATCH facts (which zee, which
// harness, which provider credential) and they are cheap; the expensive, zee-independent part is
// what moves. The cage is left UNSEALED — same as a cage between create and seal today — and it
// holds no credential and no token until a dispatch puts one in it.
//
// Never throws (the caller does not await it, and a provision must not die of a slow mirror).
export async function prewarmCage({ slug, worktree, project, prep }) {
  const ctx = 'default';
  const name = cxellName(slug);
  const baseImage = deviceConfig(project).cxellImage || undefined;
  try {
    // Bake the apt half here if it is not baked yet — the pool's clock is exactly where that
    // belongs, and it makes the FIRST prewarm of a new template pay for every one after it.
    const baked = await ensurePreppedImage({ ctx, baseImage, prep, label: slug });
    const image = baked.tag || baseImage;
    const created = await ensureCxell({ ctx, slug, xellId: null, image, prep, reuse: true });
    await cloneIntoCxell({ ctx, name: created.name, worktree });
    const warm = await warmCxell({ ctx, name: created.name, prep, stage: 'provision', aptBaked: !!baked.tag });
    logline('pool', `${slug}: cage prepped at provision time (${image || 'base image'}${baked.tag ? ', packages baked in' : ''}) — `
      + `${warm.warmed ? 'a dispatch here will install nothing' : 'prep incomplete, a dispatch will install as usual'}`);
    return { ...warm, image, template: templateHash(prep) };
  } catch (e) {
    logline('pool', `${slug}: cage prewarm did not finish (${String(e.message).slice(0, 200)}) — `
      + 'nothing is broken; its dispatch installs the way it always has');
    return { warmed: false, error: e.message };
  }
}

export async function emitXellEnv(xellId, { dryRun = false } = {}) {
  try {
    const r = await writeXellEnv(xellId, { dryRun });
    if (!dryRun) await noteEnvProjection(xellId, null, r.cxell);
    return r;
  } catch (e) {
    // A pooled xell with no worktree on disk yet has nothing to project — that is its normal state,
    // not a fault, and flagging it would bury the failures that ARE faults. A dry run DOES record a
    // failure: it wrote no file, but "this projection cannot be computed" is true either way, and
    // the note lands in this queenzee's OWN meta-DB, which is not a side effect on the fleet.
    if (!e?.no_worktree) await noteEnvProjection(xellId, e.message);
    throw e;
  }
}

// Stamp the outcome of a projection. Never throws: bookkeeping about a write must not become a
// second way for the write to fail. Broadcasts only when an error STATE changes, so a fleet-wide
// reconcile of healthy xells is silent on the event stream.
//
// TWO outcomes, TWO columns, deliberately not folded into one (migration 082 beside 078):
// env_projection_error says the HOST file is not what the meta-DB says it should be;
// env_cxell_error says the host file is fine but the LIVE CXELL's copy — the bytes the zee is
// actually reading — could not be refreshed. They need different remedies (re-point the xell vs. an
// unreachable container), and conflating them would have made every host-side xell in the fleet
// look broken the moment it had no cage. `cxell` null means the refresh was not evaluated at all
// (a throw before it ran): leave both cage columns exactly as they were rather than inventing news.
async function noteEnvProjection(xellId, error = null, cxell = null) {
  // A cage refresh only FAILED if we got far enough to try and could not; "no live cxell zee" is the
  // normal state of a host-side xell, and it clears any stale failure rather than asserting one.
  const cxellError = cxell ? (cxell.error || null) : undefined;
  const cxellOk = !!cxell && !cxell.error && cxell.refreshed;
  try {
    const prev = await one(`SELECT env_projection_error, env_cxell_error FROM xell WHERE id=$1`, [xellId]);
    if (!prev) return;
    const row = await one(
      `UPDATE xell
          SET env_projection_error = $2,
              env_projected_at = CASE WHEN $2::text IS NULL THEN now() ELSE env_projected_at END,
              env_cxell_error = CASE WHEN $3::bool THEN $4::text ELSE env_cxell_error END,
              env_cxell_refreshed_at = CASE WHEN $5::bool THEN now() ELSE env_cxell_refreshed_at END
        WHERE id=$1 RETURNING *`,
      [xellId, error || null, cxellError !== undefined, cxellError, cxellOk]);
    if (row && ((prev.env_projection_error || null) !== (error || null)
                || (cxellError !== undefined && (prev.env_cxell_error || null) !== cxellError))) {
      broadcast('xell', row);
    }
  } catch { /* the projection itself matters more than the note about it */ }
}

// ── THE FLEET-WIDE CATCH-UP (ticket #15 follow-up) ───────────────────────────────────────────────
//
// .zeehive.env is a FILE, written from the meta-DB at provision time. Fix the RULE that computes it
// — which is what ticket #15 did — and every xell provisioned before the fix keeps its wrong file
// forever: its binding says production read-only, its file says its own throwaway spinoff database,
// and nothing tells anyone. A human had to remember to re-bind each manager by hand.
//
// WHEN this runs: at queenzee BOOT, over every non-retired xell (index.js, beside the other boot
// reconciles). Deliberately not a periodic tick — every path that CHANGES a xell's binding already
// re-emits (bind/unbind, the db-clone watch, rename, an environment pin), so the only way a
// correctly-emitted file goes stale is that the PROJECTION RULE changed, and a rule change arrives
// as new code, which restarts the queenzee. A loop re-walking every worktree on a timer would be
// scanning for a condition that can only appear at a deploy.
//
// WHAT it writes: only what is provably stale. emitXellEnv compares the computed text with the file
// and no-ops when they are identical, so a healthy fleet is read-only here. A rewrite UNDER A LIVE
// ZEE is logged as such — a file changing under a working zee is otherwise indistinguishable from
// the zee having changed it (the rule reinjectHarnessIntoLiveXells earned).
//
// WHAT it never does: widen a binding. It recomputes from the meta-DB through the same emitXellEnv
// every other caller uses — §6.2 guard, reserved names and all. It cannot invent access a xell's
// row does not already carry.
//
// AND IT OBEYS PROVISION_MODE. Writing into worktrees is a real side effect on real machines, so a
// queenzee running with PROVISION_MODE=simulate — every NESTED queenzee a zee runs inside its own
// xell, by manifest default — only REPORTS what is stale and writes nothing. That is not caution
// for its own sake: a xell's database is a CLONE of the meta-DB, so a nested queenzee's fleet rows
// are the REAL fleet's rows, worktree paths and all. Unguarded, the first zee to run the server in
// its own xell would have reconciled every other zee's .zeehive.env from a snapshot of the meta-DB.
//
// AND A FAILURE ON A LIVE XELL RAISES A CARD (ticket #44). The §6.2 refusal below is CORRECT and is
// not touched here — but a guard that refuses to write a dangerous file has protected the FILE, not
// the xell, which keeps running on the dangerous file it already has. That is the whole class: the
// refusal is safe, the OUTCOME is a live zee holding a full-write DSN to the fleet's own meta-DB,
// and the only trace was one line in a boot digest that scrolls while the state persists across
// boots. So every failed reconcile on a LIVE xell appends an 'env-alert' (lib/status.raiseEnvAlert)
// the console renders as a tend-like card, carrying this reason VERBATIM. Repeated, never
// deduplicated; cleared only by a reconcile that succeeds; and best-effort in every direction, since
// the reconcile is the product and the card is instrumentation.
export async function reconcileXellEnvs({ reason = 'boot', mode = PROVISION_MODE } = {}) {
  const dryRun = mode !== 'real';
  const xells = await q(
    `SELECT x.id, x.slug, x.worktree_path,
            (SELECT z.id FROM zee z WHERE z.xell_id = x.id AND z.decommissioned_at IS NULL
                AND z.status IN ('spawning','online','working','idle')
              ORDER BY z.created_at DESC LIMIT 1) AS live_zee_id,
            EXISTS(SELECT 1 FROM zee z WHERE z.xell_id = x.id AND z.decommissioned_at IS NULL
                     AND z.status IN ('spawning','online','working','idle')) AS live
       FROM xell x
      WHERE x.status NOT IN ('retired','tearing-down','husk') AND x.worktree_path IS NOT NULL
      ORDER BY x.created_at`);
  let checked = 0, rewritten = 0, failed = 0, skipped = 0;
  const broken = [], stale = [], alerted = [];
  // The CAGE half, counted separately: a xell's host file and the copy its zee reads are two
  // different files with two different failure modes (emitXellEnv → refreshLiveCxellEnv), and a
  // sweep that reported only the host would say "0 rewritten" on the very fleet it just repaired.
  let cxellRefreshed = 0, cxellFailed = 0, cxellWould = 0;
  const cxellBroken = [], cxellStale = [];
  for (const x of xells) {
    if (!existsSync(x.worktree_path)) { skipped++; continue; }   // pooled/torn-down: nothing on disk
    checked++;
    try {
      const r = await emitXellEnv(x.id, { dryRun });
      // Accounted for BEFORE the unchanged-host early-out below: the cage copy is compared in the
      // cage, so it can be stale while the host file is already correct.
      if (r.cxell?.error) { cxellFailed++; cxellBroken.push(`${x.slug} (${r.cxell.error})`); }
      else if (r.cxell?.would_refresh) { cxellWould++; cxellStale.push(x.slug); }
      else if (r.cxell?.changed) { cxellRefreshed++; cxellStale.push(x.slug); }
      // The projection SUCCEEDED, so any card this xell was carrying is answered: the DSN it
      // alerted about no longer resolves to the meta-DB (or whatever else failed is fixed). Lowered
      // even in simulate — a dry run that computed the file cleanly proves the cause is gone just as
      // well as a write does, and it is the only lowering path there is (the zee cannot clear it).
      // A no-op when nothing is open, so a clean fleet writes no events at all.
      await clearEnvAlert(x.id, { zeeId: x.live_zee_id }).catch(() => { /* instrumentation */ });
      if (!r.changed) continue;
      rewritten++;
      stale.push(x.slug);
      logline('env', `${x.slug}: .zeehive.env is STALE — ${dryRun ? 'NOT rewritten (PROVISION_MODE=simulate: this queenzee models the fleet, it does not touch it)' : 'rewritten from the meta-DB'}`
        + (!dryRun && x.live
          ? ' WHILE A ZEE IS WORKING IN IT. The QUEENZEE wrote that file, not the zee; its app tier '
            + 'still runs on the old values until its next build.'
          : ''));
    } catch (e) {
      failed++;
      broken.push(`${x.slug} (${e.message})`);
      // LOUD, both ways: the queenzee log a human reads in the console, and stdout (the docker log).
      // This is the exact failure that used to disappear into a `.catch(() => {})`.
      logline('env', `${x.slug}: .zeehive.env could NOT be reconciled — ${e.message}. That xell is `
        + 'still running on whatever its file already said.');
      console.error(`[env] ${x.slug}: .zeehive.env projection FAILED — ${e.message}`);
      // …and, for a LIVE xell, a card a human actually meets (ticket #44). The log line above is
      // the record; this is the notification. LIVE is the whole condition — a retired, reaped or
      // never-claimed xell is running nothing, so its stale file endangers nobody and a card on it
      // would be noise a human learns to skim past. Same liveness rule the board and the crew
      // highlight use (a zee row that is not decommissioned and is spawning/online/working/idle).
      //
      // Raised in SIMULATE too, on purpose: the refusal is computed identically in both modes, and
      // the dangerous state it reports is a fact about the xell, not about whether this queenzee
      // would have written a file. (A nested queenzee raises it in its own clone meta-DB, where it
      // is visible in that zee's own console and reaches nothing real.)
      //
      // Best-effort, and that is a hard requirement: the reconcile is the product, the card is
      // instrumentation. A card that cannot be written must not fail a reconcile or a boot.
      if (x.live) {
        const raised = await raiseEnvAlert(x.id, e.message, { zeeId: x.live_zee_id })
          .then(() => true).catch(() => false);
        if (raised) alerted.push(x.slug);
      }
    }
  }
  // ONE summary line, always — a reconcile that found nothing must still say it ran, or "no news"
  // and "never ran" look identical (the lesson logHarnessSummary is built on).
  logline('env', `.zeehive.env reconcile (${reason}${dryRun ? ', SIMULATE — nothing written' : ''}): `
    + `${checked} checked, ${rewritten} ${dryRun ? 'STALE (would be rewritten)' : 'rewritten'}`
    + `${stale.length ? ` [${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', …' : ''}]` : ''}`
    + `, ${failed} FAILED${broken.length ? ` [${broken.slice(0, 3).join('; ')}]` : ''}`
    + `, ${skipped} skipped (no worktree on disk)`
    // The cage half on the SAME line: the host worktree and the copy a zee reads are the two halves
    // of one answer to "is the fleet running on what the meta-DB says?", and split across two lines
    // one of them is the one that scrolls away.
    + ` · live cxells: ${dryRun ? `${cxellWould} would be refreshed` : `${cxellRefreshed} refreshed`}`
    + `${cxellStale.length ? ` [${cxellStale.slice(0, 5).join(', ')}${cxellStale.length > 5 ? ', …' : ''}]` : ''}`
    + `, ${cxellFailed} UNREACHABLE${cxellBroken.length ? ` [${cxellBroken.slice(0, 3).join('; ')}]` : ''}`
    // "24 clean, 1 FAILED" is the digest a human has to PARSE. This clause says where the answer
    // already is — on the hive, as a card — so the boot line stops being the thing anyone must read.
    + (alerted.length
      ? ` · ⚠ ${alerted.length} LIVE xell(s) raised an env card in the console [${alerted.slice(0, 3).join(', ')}]`
      : '')
    // A failure on a xell with NO live zee is the same refusal with nobody in the room. Said plainly
    // rather than silently omitted, so "why is there no card?" has an answer in the same line.
    + (failed > alerted.length
      ? ` · ${failed - alerted.length} failure(s) on xells with no live zee (no card raised — nothing is running on them)`
      : ''));
  if (failed) {
    console.error(`[env] ${failed} xell(s) are running on a .zeehive.env that could not be `
      + `reconciled with the meta-DB: ${broken.join('; ')}`);
  }
  if (cxellFailed) {
    console.error(`[env] ${cxellFailed} LIVE cxell(s) could not be handed the refreshed .zeehive.env — `
      + `those zees are still reading their old copy: ${cxellBroken.join('; ')}`);
  }
  if (alerted.length) {
    console.error(`[env] ${alerted.length} LIVE xell(s) are running on an unreconcilable .zeehive.env `
      + `and now carry a card in the console: ${alerted.join(', ')}`);
  }
  return { checked, rewritten, failed, skipped, broken, stale, alerted, dry_run: dryRun,
           cxell_refreshed: cxellRefreshed, cxell_failed: cxellFailed, cxell_would_refresh: cxellWould,
           cxell_broken: cxellBroken, cxell_stale: cxellStale };
}

// ── bootstrap prerequisites (spec §4.2/§4.3) ──────────────────────────────────
// The manifest's `tiers.spinoff.requires` names the external networks/volumes a spinoff needs
// BEFORE it can come up. Verified here so a missing prerequisite is a clear one-line bootstrap
// error at provision time instead of a crash-loop discovered from container logs. Network entries
// may be strings or {name, aliases:[...]}; a declared alias that resolves to nothing is the known
// "db recreated by docker run drops the compose alias → the whole fleet crash-loops" failure, so
// it fails provision loudly. Volumes are DATA — verified, NEVER auto-created.
export function verifyRequires(ctx, requires = {}) {
  const dk = (args) => spawnSync('docker', ['--context', ctx, ...args],
    { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const nets = (requires.networks || []).map((n) =>
    typeof n === 'string' ? { name: n, aliases: [] } : { name: n.name, aliases: n.aliases || [] });
  for (const n of nets) {
    const r = dk(['network', 'inspect', n.name, '--format',
      '{{range $id, $c := .Containers}}{{$c.Name}} {{end}}']);
    if (r.status !== 0) {
      throw new Error(`required network "${n.name}" does not exist on ${ctx} — bring up the `
        + `canonical dev stack first (it creates it); see the project's bootstrap doc`);
    }
    if (n.aliases.length) {
      const attached = (r.stdout || '').trim().split(/\s+/).filter(Boolean);
      const found = new Set();
      if (attached.length) {
        const ins = dk(['inspect', ...attached, '--format',
          `{{json (index .NetworkSettings.Networks "${n.name}").Aliases}}`]);
        for (const line of (ins.stdout || '').split('\n')) {
          try { for (const a of JSON.parse(line) || []) found.add(a); } catch { /* null/garbage line */ }
        }
      }
      const missing = n.aliases.filter((a) => !found.has(a));
      if (missing.length) {
        throw new Error(`network "${n.name}" on ${ctx} is missing required alias(es): `
          + `${missing.join(', ')} — a container was recreated without them (a bare docker run `
          + `drops compose aliases); re-create it via compose before provisioning`);
      }
    }
  }
  for (const v of requires.volumes || []) {
    const r = dk(['volume', 'inspect', v]);
    if (r.status !== 0) {
      throw new Error(`required external volume "${v}" does not exist on ${ctx} — it is DATA and `
        + `is never auto-created; see the project's bootstrap doc`);
    }
  }
  return { ok: true };
}

export async function makeSlug(projectId) {
  for (let i = 0; i < 50; i++) {
    const a = ADJ[crypto.randomInt(ADJ.length)];
    const n = NOUN[crypto.randomInt(NOUN.length)];
    const suffix = crypto.randomBytes(3).toString('hex');
    const slug = `${a}-${n}-${suffix}`;
    const clash = await one(`SELECT 1 FROM xell WHERE project_id=$1 AND slug=$2`, [projectId, slug]);
    if (!clash) return slug;
  }
  throw new Error('could not allocate a unique slug');
}

// Provision one pooled (empty, ready) xell for a project. machineCtx (optional) pins the target
// machine — the pool maintainer passes it when filling per-machine targets; omitted, the
// highest-priority machine with room is chosen (or legacy site placement when no machines exist).
export async function provisionXell({ projectId, mode = 'simulate', sourceCoupling, dbCoupling, machineCtx }) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  const xource = await one(`SELECT * FROM xource WHERE project_id=$1 AND ref=$2`, [projectId, project.main_branch]);
  const cfg = await one(`SELECT * FROM pool_config WHERE project_id=$1`, [projectId]);
  const slug = await makeSlug(projectId);
  const branch = `spinoff/${slug}`;
  const worktree = `${project.repo_root.replace(/\\/g, '/')}/.claude/worktrees/${slug}`;
  const ports = computePorts(slug, project);

  // WHERE this xell's app tier runs. Machine-aware when machine rows exist (highest dev_priority
  // with room under max_xells — spec: "if local priority is higher, dev xells get spawned there
  // first"); legacy otherwise: the project's default dev site → deprecated project columns →
  // global env default (see lib/sites.js).
  //
  // EXCEPT a process-runner project: its xell lives on the queenzee host by construction
  // (worktree on the host fs, server/webapp as local processes, the cage on the queenzee's own
  // daemon), so the one docker-placed piece it has — the per-xell db container — must run there
  // too. A remote machine at top dev_priority used to steer that container onto a daemon the
  // local processes cannot reach over zee-hive-net (same-daemon network, container-name DSN).
  // Pin to the queenzee-host machine row, or none — the dev-site/config fallbacks below then
  // keep legacy placement exactly as before machines existed.
  // (docs/process-machine-pooling-decision-record.md)
  const isProcess = serverRoleIsProcess(project.manifest);
  const coupling = dbCoupling || cfg.default_db_coupling;
  let machine = isProcess
    ? await machineForCtx(queenzeeHostCtx())
    : (machineCtx ? await machineForCtx(machineCtx) : await pickDevMachine(projectId));
  if (!isProcess && machineCtx && !machine) throw new Error(`no machine row for docker context '${machineCtx}'`);
  // MACHINE-AWARE BY DEFAULT (docs/default-machine-pooling-decision-record.md): a compose
  // project with no explicit dev machine still places on the machine the POOL defaults to —
  // the one holding its shared dev db — so a dispatch-time fresh spawn lands where the warm
  // pool lives, not wherever the legacy site fallback points. Respect the machine-wide cap:
  // an implicit default never overfills a host (null falls through to legacy placement).
  if (!machine && !machineCtx && !isProcess) {
    const im = await implicitPoolMachine(projectId, { isProcess: false, coupling });
    if (im && (await liveXellCount(im.docker_ctx)) < im.max_xells) machine = im;
  }
  const devSite = await resolveSite(projectId, 'dev');
  const devCtx = machine?.docker_ctx || devSite?.docker_ctx || config.dockerCtx;
  const devHost = machine?.host_ip || (machine ? null : devSite?.host) || project.dev_host_ip || config.devHostIp;
  const devSiteId = devSite?.id || null;
  // A machine row with no host_ip used to produce literal "http://null:PORT" URLs — a URL the
  // health prober can never answer. localhost is always true for same-machine process roles and
  // harmless as a fallback elsewhere.
  const urlHost = devHost || 'localhost';
  const url = `http://${urlHost}:${ports.webPort}`;

  // A xell's app tier must never reach across docker contexts for its database, so a machine
  // without this project's own shared dev db cannot host xells that need one. Refused HERE, by
  // name, with the fix — not discovered as a crash-looping stack after provisioning. Only for
  // projects that HAVE a shared dev db somewhere: one with none at all (Zeehive itself) never
  // linked one before machines existed either, and must keep provisioning exactly as it did.
  if (machine && ['db-shared-dev', 'db-clone'].includes(coupling)) {
    const anywhere = await one(
      `SELECT 1 FROM container WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared' LIMIT 1`,
      [projectId]);
    if (anywhere && !(await sharedDevDb(projectId, devCtx))) {
      throw new Error(`machine '${machine.key}' has no shared dev db for ${project.name} — `
        + `provision one there first (console → container matrix → ${machine.key} column → provision dev db), `
        + `or set its pool/priority to 0`);
    }
  }

  // the xell branches off the CURRENT xource tip — capture it (cheap, both modes)
  let head = headCommit(project.repo_root, project.main_branch);
  let health = 'unknown';
  if (mode === 'real') {
    // PROVISION_APP_TIER=false → create only the isolated worktree (no spin-env / NAS
    // containers). A gentle on-ramp: code isolation now, app tier when you want it.
    const appTier = process.env.PROVISION_APP_TIER !== 'false';
    // manifest-declared bootstrap prerequisites fail FAST with a named step, not a crash-loop
    const requires = project.manifest?.tiers?.spinoff?.requires;
    if (appTier && requires) verifyRequires(devCtx, requires);
    const script = resolve(config.repoRoot, 'scripts', 'provision-xell.sh');
    // Pass the project's source branch — the script used to hardcode 'main', which silently
    // ignored main_branch and broke every project that isn't on main.
    const r = spawnSync(resolveBash(), [script, slug, project.repo_root.replace(/\\/g, '/'), project.main_branch], {
      encoding: 'utf8', timeout: 600000,
      env: cleanGitEnv({ SPINOFF_DOCKER_CONTEXT: devCtx, DEV_HOST_IP: devHost,
             PROVISION_APP_TIER: appTier ? 'true' : 'false' }),
    });
    if (r.status !== 0) throw new Error(`provision-xell.sh failed: ${provisionFailureReason(r)}`);
    health = appTier ? 'up' : 'down'; // worktree exists; containers only up if the app tier ran
  }

  const client = await pool.connect();
  let createdDbContainer = null;   // a docker-run per-xell db to tear down if the tx fails
  try {
    await client.query('BEGIN');
    const { rows: [xell] } = await client.query(
      `INSERT INTO xell (project_id,xource_id,slug,branch,worktree_path,git_dir,head_commit,
          source_coupling,db_coupling,status,is_pooled,ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',true,now()) RETURNING *`,
      [projectId, xource.id, slug, branch, worktree,
       `${worktree}/.git`, head,
       sourceCoupling || cfg.default_source_coupling, dbCoupling || cfg.default_db_coupling]);

    // per-xell containers: its own server + webapp
    // Names/images/compose-project come from the project's naming templates (manifest-backed,
    // defaults derived from the project name — see lib/manifest.js). Never hardcoded per project.
    // WHERE these images compile. Machine-aware first: a machine that can build compiles its own
    // (NULL); one that can't (the NAS) points at the best build-capable machine — but only when a
    // registry exists to hand the image over, else fall back to building on the run host rather
    // than fail every provision. Legacy (no machines): pool_config.default_build_ctx, already
    // registry-validated when it was set.
    let defaultBuildCtx = machine
      ? await defaultBuildCtxFor(machine)
      : (cfg.default_build_ctx && cfg.default_build_ctx !== devCtx ? cfg.default_build_ctx : null);
    if (defaultBuildCtx && defaultBuildCtx !== devCtx
        && !((project.registry && project.registry.trim()) || config.registry)) {
      console.error(`[provision] ${slug}: build host ${defaultBuildCtx} needs a registry to hand `
        + `images to ${devCtx} but none is configured — building on the run host instead`);
      defaultBuildCtx = null;
    }
    if (defaultBuildCtx === devCtx) defaultBuildCtx = null;
    // runner: process (spec §6.1) — the role is a bare process in the worktree, not a container:
    // no docker context, no compose, no image. Its row exists for ports/URL/health; the health
    // monitor probes rows with docker_ctx NULL by URL, so the modeling IS the wiring. Declared
    // per-role in the manifest, with the spinoff tier's runner as the fallback.
    const spinTier = project.manifest?.tiers?.spinoff || {};
    const runnerOf = (role) => project.manifest?.roles?.[role]?.runner || spinTier.runner || null;
    const mk = async (role, hostPort, intPort, curl) => {
      const nm = namingFor(project, role, slug);
      const isProc = runnerOf(role) === 'process';
      // Process roles share the queenzee's network namespace — stamp the host a cxell already
      // reaches the queenzee on (CXELL_API_BASE), not the dev machine's ip (TKT-136 defect #2).
      const roleHost = isProc ? processRoleReachableHost() : devHost;
      const roleUrl = isProc ? processRolePublishedUrl(hostPort) : curl;
      const { rows: [c] } = await client.query(
        `INSERT INTO container (project_id,role,tier,isolation,name,image_tag,docker_ctx,build_ctx,host,host_port,internal_port,url,compose_project,compose_file,owner_xell_id,site_id,health)
         VALUES ($1,$2,'spinoff','per-xell',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [projectId, role, nm.container, isProc ? null : nm.image,
         isProc ? null : devCtx, isProc ? null : defaultBuildCtx, roleHost, hostPort, intPort, roleUrl,
         isProc ? null : nm.composeProject, isProc ? null : project.compose_spinoff,
         xell.id, devSiteId, isProc ? 'down' : health]);
      await client.query(`INSERT INTO xell_uses_container (xell_id,container_id,relation) VALUES ($1,$2,'owns')`, [xell.id, c.id]);
    };
    await mk('server', ports.serverPort, 3000, `http://${urlHost}:${ports.serverPort}`);
    await mk('webapp', ports.webPort, 5173, url);

    // Per-xell OWN database container (spec §6.1: a Zeehive xell gets its own meta-DB container,
    // slot-ported, provisioned BY ZEEHIVE). Scoped to db-isolated coupling on a PROCESS-runner
    // spinoff tier: a compose project's isolated db comes up with its compose stack, but a
    // process xell has no compose — the queenzee must run the one docker-backed role itself.
    // Identity comes from the manifest's db block (the committed dev credential); the container
    // is named by the manifest's naming template (zeehive_db_spin_{slug}).
    if (coupling === 'db-isolated' && (spinTier.runner || null) === 'process') {
      const nmDb = namingFor(project, 'db', slug);
      const mdb = project.manifest?.db || {};
      const dbName = mdb.name || project.db_name || 'app';
      const dbUser = mdb.user || project.db_user || 'postgres';
      const dbPass = mdb.password || 'dev';
      const dbPort = (Number(spinTier.ports?.db?.base) || 5500) + ports.slot;
      const dbImage = project.manifest?.roles?.db?.image || 'postgres:17-alpine';
      if (mode === 'real') {
        const run = spawnSync('docker',
          ['--context', devCtx, 'run', '-d', '--name', nmDb.container, '--restart', 'unless-stopped',
           // on the cxell network: the queenzee container and every cxell resolve it BY NAME —
           // the published host port below is the HUMAN's door (psql from the host)
           '--network', 'zee-hive-net',
           '-p', `${dbPort}:5432`,
           '-e', `POSTGRES_USER=${dbUser}`, '-e', `POSTGRES_PASSWORD=${dbPass}`, '-e', `POSTGRES_DB=${dbName}`,
           '--label', `zeehive.project=${project.name}`, '--label', 'zeehive.role=db',
           '--label', `zeehive.slug=${slug}`, dbImage],
          { encoding: 'utf8', timeout: 120000, windowsHide: true, env: cleanGitEnv() });
        if (run.status !== 0) {
          throw new Error(`per-xell db container ${nmDb.container} failed: ${(run.stderr || '').slice(-300)}`);
        }
        createdDbContainer = { ctx: devCtx, name: nmDb.container };   // for cleanup if the tx dies

        // Start the xell's db as a COPY OF PROD, not a blank slate (Mark, 2026-07-20: "the first
        // dev db always empty/drifted from prod" — an empty spin db breaks the promise the
        // db-isolated label makes, and prod-shaped data is the point of an own db). Streamed
        // live — pg_dump | psql through the docker CLI — so it needs no backup file and stays
        // transactionally consistent; cross-context sources work the same way. Best-effort with
        // a LOUD failure: a xell on an empty db beats no xell, but the gap must never be silent.
        const prodDb = await one(
          `SELECT name, docker_ctx FROM container
            WHERE project_id=$1 AND role='db' AND tier='prod' AND isolation='shared'
            ORDER BY (docker_ctx = $2) DESC NULLS LAST LIMIT 1`, [projectId, devCtx]);
        if (prodDb) {
          let up = false;
          for (let i = 0; i < 20 && !up; i++) {
            up = spawnSync('docker', ['--context', devCtx, 'exec', nmDb.container, 'pg_isready', '-U', dbUser],
              { encoding: 'utf8', timeout: 10000, windowsHide: true }).status === 0;
            if (!up) sleepSync(1000);
          }
          const src = await dbIdentity(projectId);
          const srcCtx = prodDb.docker_ctx || 'default';
          const pipe = `docker --context ${srcCtx} exec ${prodDb.name} pg_dump -U ${src.user} -d ${src.name} --no-owner --no-privileges`
            + ` | docker --context ${devCtx} exec -i ${nmDb.container} psql -q -v ON_ERROR_STOP=0 -U ${dbUser} -d ${dbName}`;
          const cp = up && spawnSync(resolveBash(), ['-c', pipe],
            { encoding: 'utf8', timeout: 600000, windowsHide: true, env: cleanGitEnv() });
          if (cp && cp.status === 0) {
            console.log(`[provision] ${slug}: per-xell db seeded from prod (${prodDb.name} → ${nmDb.container})`);
          } else {
            console.error(`[provision] ${slug}: !!! per-xell db is EMPTY — prod seed failed `
              + `(${!up ? 'db never became ready' : (cp.stderr || '').trim().slice(-200)})`);
          }
        }
      }
      // conn_ref stays passwordless (parameters, not secrets) — emitXellEnv injects the
      // manifest's committed dev credential for process xells. The HOST in it depends on where
      // the consumers run: a containerized queenzee's process xells and its cxells resolve the
      // db by CONTAINER NAME over zee-hive-net (localhost:<published port> is the container's
      // own empty loopback — seen live: the first in-container process start died on connect
      // and its port never answered); the host era keeps the published-port form.
      const inContainer = existsSync('/.dockerenv');
      const connRef = inContainer
        ? `postgresql://${dbUser}@${nmDb.container}:5432/${dbName}`
        : `postgresql://${dbUser}@${urlHost}:${dbPort}/${dbName}`;
      const { rows: [dbc] } = await client.query(
        `INSERT INTO container (project_id,role,tier,isolation,name,image_tag,docker_ctx,host,host_port,internal_port,conn_ref,owner_xell_id,site_id,health)
         VALUES ($1,'db','spinoff','per-xell',$2,$3,$4,$5,$6,5432,$7,$8,$9,$10) RETURNING id`,
        [projectId, nmDb.container, dbImage, devCtx, devHost, dbPort, connRef,
         xell.id, devSiteId, mode === 'real' ? 'up' : 'unknown']);
      await client.query(`INSERT INTO xell_uses_container (xell_id,container_id,relation) VALUES ($1,$2,'owns')`, [xell.id, dbc.id]);
    }

    // db coupling: link the shared dev db it USES (db-shared-dev default). db-clone lives in the
    // SAME container — the clone database itself is cut lazily (at dispatch, or by the
    // schema-work watch), never for a pristine pooled xell.
    if (['db-shared-dev', 'db-clone'].includes(dbCoupling || cfg.default_db_coupling)) {
      // THIS machine's dev db — never another context's (cross-context db traffic is forbidden).
      // Ordered so an exact docker_ctx match wins; the ctx-less fallback only serves legacy rows
      // from before contexts were stamped.
      const shared = await client.query(
        `SELECT id FROM container WHERE project_id=$1 AND role='db' AND tier='dev' AND isolation='shared'
            AND (docker_ctx = $2 OR docker_ctx IS NULL)
          ORDER BY (docker_ctx = $2) DESC NULLS LAST LIMIT 1`, [projectId, devCtx]);
      if (shared.rows[0]) {
        await client.query(`INSERT INTO xell_uses_container (xell_id,container_id,relation) VALUES ($1,$2,'uses') ON CONFLICT DO NOTHING`, [xell.id, shared.rows[0].id]);
      }
    }
    await client.query('COMMIT');
    broadcast('xell', xell);
    // the honeycomb's queenzee→xell line: the queenzee just provisioned this xell
    activity('q2x', xell.id, 'provision');
    // the harness-free projection rides every REAL provision; failure is logged, never fatal
    // (the xell works without it — the file only serves ZEEHIVE-less compose runs)
    if (mode === 'real') {
      await emitXellEnv(xell.id).catch((e) => console.error(`[provision] .zeehive.env: ${e.message}`));
      // …and OPEN what was just written, before anyone treats this xell as ready (#53). Writing a
      // DATABASE_URL and that DATABASE_URL answering are two different facts, and the gap is what
      // let seven zees in one night be handed a credential the shared dev db rejects (#47).
      // Awaited, because the verdict is only worth having before the pool hands the xell out — and
      // safe to await because every probe is bounded (PREFLIGHT_TIMEOUT_MS) and runPreflight never
      // throws. Imported dynamically: preflight.js reads resolveXellDsn from here, and this is how
      // the repo already breaks that cycle (environments.js → provision.js).
      const { runPreflight } = await import('./preflight.js');
      await runPreflight(xell.id);
      // WARM THE WORKTREE ON THE POOL'S CLOCK, not the zee's. A pooled xell sits `ready` for
      // minutes or hours; doing its `npm ci` now costs nobody anything, fills the SHARED package
      // cache for every xell that follows, and means the first build of a process role is not also
      // a cold install. Deliberately NOT awaited and never fatal — a provision that failed because
      // a cache was cold would be a far worse bug than the one this fixes. `npm ci` only: a
      // worktree with no lockfile is skipped rather than `npm install`ed, because install rewrites
      // the lock and the pool reaps a dirty worktree (the 2026-07-20 provision→build→reap loop).
      // …with the PROJECT'S SPAWN TEMPLATE (migration 121) deciding whether that install happens at
      // all and with which npm flags (--prefer-offline off a warm shared cache is most of what makes
      // a spawn fast). A NULL template is the built-in default, i.e. exactly this call before 121.
      const prep = normalizeSpawnPrep(cfg?.spawn_prep ?? null);
      warmWorktree(worktree, { slug, prep })
        .catch((e) => logline('pool', `${slug}: worktree warm errored (ignored): ${e.message}`));
      // …and, when the template says `when: 'provision'`, PREPARE THE CAGE ITSELF here rather than
      // at dispatch. This is the whole point of that setting: the container is created, the branch
      // is cloned into it and everything is installed while the xell sits in the pool, so a human
      // waiting for a zee is not also waiting for npm. Fire-and-forget and never fatal, exactly like
      // the worktree warm — a provision that died because a package mirror was slow would be a far
      // worse bug than the one this fixes.
      if (prewarmsCage(prep)) {
        prewarmCage({ slug, worktree, project, prep })
          .catch((e) => logline('pool', `${slug}: cage prewarm errored (ignored): ${e.message}`));
      }
    }
    return { ...xell, ports, url, mode };
  } catch (err) {
    await client.query('ROLLBACK');
    // the rollback erased the row that owned it — remove the physical container too
    if (createdDbContainer) {
      spawnSync('docker', ['--context', createdDbContainer.ctx, 'rm', '-f', createdDbContainer.name],
        { encoding: 'utf8', timeout: 30000, windowsHide: true });
    }
    throw err;
  } finally {
    client.release();
  }
}
