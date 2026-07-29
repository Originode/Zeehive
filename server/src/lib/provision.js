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
import { namingFor } from './manifest.js';
import { resolveBash } from './bash.js';
import { pickDevMachine, machineForCtx, sharedDevDb, defaultBuildCtxFor } from './machines.js';
import { dbIdentity } from './projects.js';
import { resolveEnvironmentFor, fullVarsFor } from './environments.js';
import { warmWorktree } from './npm-cache.js';
import { logline } from './logbus.js';

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

  // DATABASE_URL — the one database this xell's zee is meant to talk to, in binding order. HARD
  // GUARD (spec §6.2, below): never emit the managing instance's meta-DB — two queenzees
  // reconciling one meta-DB reap each other's xells; that failure class has destroyed live work
  // before, so it is a refusal, not a warning.
  //
  // FIRST, before the xell's own db container: a xell bound to production READ-ONLY. Its
  // DATABASE_URL is the SELECT-only DSN the queenzee minted for it (lib/prod-readonly.js) — never
  // the prod owner's connection string, and never its OWN db container either. That precedence is
  // the point: a manager is an ordinary pooled spinoff (owned db container and all) that is THEN
  // bound read-only, so taking the owned container first
  // meant the manager's .zeehive.env quietly pointed at its throwaway spinoff database while its
  // binding advertised production (ticket #15). The binding is what the zee was told it has, so the
  // binding wins. Emitted at all because a cxell zee has no docker and reaches postgres over TCP.
  // Falls through when no DSN was minted (a project with no prod db registered — bindManagerToProd-
  // Readonly skips the bind there): a xell then keeps whatever database it really has, rather than
  // being left with none. The §6.2 refusal below still applies to this DSN like any other.
  let dbUrl = (xell.db_coupling === 'db-prod-readonly' && xell.prod_ro_dsn) ? xell.prod_ro_dsn : null;
  // …else the xell's OWN db container, when it has one.
  if (!dbUrl) dbUrl = cs.find((c) => c.role === 'db')?.conn_ref || null;
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
      } catch { /* unparseable conn_ref — emit nothing rather than the shared db */ }
    }
  }
  // db-shared-dev on a PROCESS-runner project: the xell's server is a bare process, so unlike a
  // compose stack there is no network alias handing it a database — the projection must carry
  // the shared dev db's conn_ref outright. Scoped to process runners so compose projects keep
  // their env exactly as it was. The §6.2 guard below still applies unchanged.
  const spinRunner = spin.runner || null;
  if (!dbUrl && xell.db_coupling === 'db-shared-dev' && spinRunner === 'process') {
    const used = await one(
      `SELECT c.conn_ref FROM xell_uses_container xuc JOIN container c ON c.id = xuc.container_id
        WHERE xuc.xell_id=$1 AND xuc.relation='uses' AND c.role='db' AND c.conn_ref IS NOT NULL LIMIT 1`,
      [xellId]);
    if (used?.conn_ref) dbUrl = used.conn_ref;
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

  // Environment vars — the meta-DB source of truth for the untracked .env (migration 043).
  // Resolved by tier: a xell ON PRODUCTION (environments.isOnProduction — writing it, reading it
  // read-only, or being it) gets the project's default PROD environment, else the default DEV one;
  // an explicit xell.environment_id overrides. Merged AFTER the per-xell truth above (ports/DATABASE_URL/site/slug) and BEFORE the manifest safety
  // defaults below, and it can never override either: any name already emitted (or declared in
  // spin.env) is skipped, so an environment can't redirect DATABASE_URL past the §6.2 guard nor
  // undo BUILD_MODE=simulate. Best-effort — a projection failure must not sink provisioning.
  try {
    const env = await resolveEnvironmentFor(xell);
    const envVars = await fullVarsFor(env?.id);
    if (env && envVars.length) {
      // Reserve, UNCONDITIONALLY, the structural keys emitXellEnv owns — not just the ones already
      // emitted. A db-less xell emits no DATABASE_URL line, so a dynamic-only reserve would let an
      // environment introduce its own DATABASE_URL and slip past the §6.2 guard; these names are
      // never an environment's to set, present in the file or not.
      const reserved = new Set([
        'SPINOFF_SLUG', 'DATABASE_URL', 'ZEEHIVE_SITE', 'ZEEHIVE_DOCKER_CONTEXT', serverEnv, webEnv,
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
  if (dryRun) return { ok: true, path, slug: xell.slug, changed, dry_run: true };    // report, write nothing
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
  return { ok: true, path, slug: xell.slug, changed };
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
export async function emitXellEnv(xellId, { dryRun = false } = {}) {
  try {
    const r = await writeXellEnv(xellId, { dryRun });
    if (!dryRun) await noteEnvProjection(xellId, null);
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
// second way for the write to fail. Broadcasts only when the error STATE changes, so a fleet-wide
// reconcile of healthy xells is silent on the event stream.
async function noteEnvProjection(xellId, error = null) {
  try {
    const prev = await one(`SELECT env_projection_error FROM xell WHERE id=$1`, [xellId]);
    if (!prev) return;
    const row = await one(
      `UPDATE xell
          SET env_projection_error = $2,
              env_projected_at = CASE WHEN $2::text IS NULL THEN now() ELSE env_projected_at END
        WHERE id=$1 RETURNING *`, [xellId, error || null]);
    if (row && (prev.env_projection_error || null) !== (error || null)) broadcast('xell', row);
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
export async function reconcileXellEnvs({ reason = 'boot', mode = PROVISION_MODE } = {}) {
  const dryRun = mode !== 'real';
  const xells = await q(
    `SELECT x.id, x.slug, x.worktree_path,
            EXISTS(SELECT 1 FROM zee z WHERE z.xell_id = x.id AND z.decommissioned_at IS NULL
                     AND z.status IN ('spawning','online','working','idle')) AS live
       FROM xell x
      WHERE x.status NOT IN ('retired','tearing-down','husk') AND x.worktree_path IS NOT NULL
      ORDER BY x.created_at`);
  let checked = 0, rewritten = 0, failed = 0, skipped = 0;
  const broken = [], stale = [];
  for (const x of xells) {
    if (!existsSync(x.worktree_path)) { skipped++; continue; }   // pooled/torn-down: nothing on disk
    checked++;
    try {
      const r = await emitXellEnv(x.id, { dryRun });
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
    }
  }
  // ONE summary line, always — a reconcile that found nothing must still say it ran, or "no news"
  // and "never ran" look identical (the lesson logHarnessSummary is built on).
  logline('env', `.zeehive.env reconcile (${reason}${dryRun ? ', SIMULATE — nothing written' : ''}): `
    + `${checked} checked, ${rewritten} ${dryRun ? 'STALE (would be rewritten)' : 'rewritten'}`
    + `${stale.length ? ` [${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', …' : ''}]` : ''}`
    + `, ${failed} FAILED${broken.length ? ` [${broken.slice(0, 3).join('; ')}]` : ''}`
    + `, ${skipped} skipped (no worktree on disk)`);
  if (failed) {
    console.error(`[env] ${failed} xell(s) are running on a .zeehive.env that could not be `
      + `reconciled with the meta-DB: ${broken.join('; ')}`);
  }
  return { checked, rewritten, failed, skipped, broken, stale, dry_run: dryRun };
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
  const machine = machineCtx ? await machineForCtx(machineCtx) : await pickDevMachine(projectId);
  if (machineCtx && !machine) throw new Error(`no machine row for docker context '${machineCtx}'`);
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
  const coupling = dbCoupling || cfg.default_db_coupling;
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
      const { rows: [c] } = await client.query(
        `INSERT INTO container (project_id,role,tier,isolation,name,image_tag,docker_ctx,build_ctx,host,host_port,internal_port,url,compose_project,compose_file,owner_xell_id,site_id,health)
         VALUES ($1,$2,'spinoff','per-xell',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [projectId, role, nm.container, isProc ? null : nm.image,
         isProc ? null : devCtx, isProc ? null : defaultBuildCtx, devHost, hostPort, intPort, curl,
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
    // the harness-free projection rides every REAL provision; failure is logged, never fatal
    // (the xell works without it — the file only serves ZEEHIVE-less compose runs)
    if (mode === 'real') {
      await emitXellEnv(xell.id).catch((e) => console.error(`[provision] .zeehive.env: ${e.message}`));
      // WARM THE WORKTREE ON THE POOL'S CLOCK, not the zee's. A pooled xell sits `ready` for
      // minutes or hours; doing its `npm ci` now costs nobody anything, fills the SHARED package
      // cache for every xell that follows, and means the first build of a process role is not also
      // a cold install. Deliberately NOT awaited and never fatal — a provision that failed because
      // a cache was cold would be a far worse bug than the one this fixes. `npm ci` only: a
      // worktree with no lockfile is skipped rather than `npm install`ed, because install rewrites
      // the lock and the pool reaps a dirty worktree (the 2026-07-20 provision→build→reap loop).
      warmWorktree(worktree, { slug }).catch((e) => logline('pool', `${slug}: worktree warm errored (ignored): ${e.message}`));
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
