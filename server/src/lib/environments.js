// ENVIRONMENTS — the meta-DB as the source of truth for the env vars git ignores (migration 043).
//
// A project holds named environments (dev / prod / staging …), each a set of KEY=value vars. The
// full value leaves this module through exactly TWO doors: fullVarsFor() (emitXellEnv, into the
// xell's own gitignored .zeehive.env) and exportEnv() (a human's explicit reveal). Everything the
// console lists is masked — same discipline as lib/provider-tokens.js.
//
// Resolution (resolveEnvironmentFor) is the rule the task asked for: an explicit xell.environment_id
// wins; else a xell ON PRODUCTION (see isOnProduction) gets the default PROD environment; else the
// default DEV one. Spinoff/dev xells therefore get dev env, prod xells get prod env, and a xell
// handed the prod db is loaded with the production environment.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool, q, one } from '../db/pool.js';
import { broadcast } from './events.js';

const TIERS = ['dev', 'prod'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// ── masking ───────────────────────────────────────────────────────────────────
// A secret never leaves as its value; a hint (first 3 / last 2 for long values, bullets for short)
// plus its length is enough for a human to recognise "yes that key is set" without exposing it.
// A non-secret var (is_secret=false — ports, hostnames, feature flags) shows in full.
function maskVar(v) {
  const val = String(v.value ?? '');
  const base = { name: v.name, is_secret: v.is_secret, updated_at: v.updated_at };
  if (!v.is_secret) return { ...base, value: val };
  return {
    ...base,
    length: val.length,
    value_hint: val.length > 8 ? `${val.slice(0, 3)}…${val.slice(-2)}` : '•'.repeat(Math.max(val.length, 1)),
  };
}

function validateEnv(body, { partial = false } = {}) {
  const errs = [];
  if (!partial || body.key !== undefined) {
    if (!body.key || !KEY_RE.test(body.key)) {
      errs.push('key is required: lowercase letters/digits/dashes (e.g. "dev", "prod", "staging")');
    }
  }
  if (!partial || body.tier !== undefined) {
    if (!TIERS.includes(body.tier)) errs.push(`tier must be one of: ${TIERS.join(', ')}`);
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// ── environment CRUD (console) ──────────────────────────────────────────────────
export async function listEnvironments(projectId) {
  return q(
    `SELECT e.*,
            (SELECT count(*) FROM environment_var v WHERE v.environment_id = e.id) AS var_count,
            (SELECT count(*) FROM xell x WHERE x.environment_id = e.id AND x.status <> 'retired') AS pinned_xells
       FROM environment e WHERE e.project_id = $1 ORDER BY e.tier, e.created_at`, [projectId]);
}

// unseat the previous default so the partial unique index (one default per project+tier) accepts us
async function setDefaultWithin(client, projectId, tier, keepId) {
  await client.query(
    `UPDATE environment SET is_default=false, updated_at=now()
       WHERE project_id=$1 AND tier=$2 AND id<>$3 AND is_default`, [projectId, tier, keepId]);
}

export async function createEnvironment(projectId, body = {}) {
  const project = await one(`SELECT id FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('project not found');
  validateEnv(body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [env] } = await client.query(
      `INSERT INTO environment (project_id,key,tier,label,description,is_default)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [projectId, body.key, body.tier, body.label || null, body.description || null, !!body.is_default]);
    if (env.is_default) await setDefaultWithin(client, projectId, body.tier, env.id);
    await client.query('COMMIT');
    broadcast('environment', env);
    return env;
  } catch (err) {
    await client.query('ROLLBACK');
    if (/environment_project_id_key_key|duplicate key/.test(err.message)) {
      throw new Error(`an environment keyed "${body.key}" already exists for this project`);
    }
    throw err;
  } finally {
    client.release();
  }
}

const PATCHABLE = ['key', 'tier', 'label', 'description', 'is_default'];

export async function updateEnvironment(envId, body = {}) {
  const env = await one(`SELECT * FROM environment WHERE id=$1`, [envId]);
  if (!env) throw new Error('environment not found');
  validateEnv(body, { partial: true });
  const sets = ['updated_at = now()'], vals = [envId];
  for (const f of PATCHABLE) {
    if (body[f] === undefined) continue;
    vals.push(body[f]);
    sets.push(`${f} = $${vals.length}`);
  }
  if (sets.length === 1) return env;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (body.is_default) await setDefaultWithin(client, env.project_id, body.tier ?? env.tier, envId);
    const { rows: [updated] } = await client.query(
      `UPDATE environment SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    await client.query('COMMIT');
    broadcast('environment', updated);
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteEnvironment(envId, force = false) {
  const env = await one(
    `SELECT e.*, (SELECT count(*) FROM xell x WHERE x.environment_id = e.id AND x.status <> 'retired') AS pinned_xells
       FROM environment e WHERE e.id=$1`, [envId]);
  if (!env) throw new Error('environment not found');
  if (env.is_default && !force) {
    throw new Error(
      `"${env.key}" is the default ${env.tier} environment — xells of that tier resolve to it. `
      + 'Make another the default first, or force-remove (those xells then resolve to nothing until a default exists).');
  }
  // Pinned xells fall back to their tier default automatically (ON DELETE SET NULL) — say so rather
  // than block, mirroring deploy_site's "containers keep running; rows just lose the link".
  await q(`DELETE FROM environment WHERE id=$1`, [envId]);
  broadcast('environment', { id: envId, project_id: env.project_id, deleted: true });
  return { ok: true, deleted: envId, key: env.key, unpinned_xells: Number(env.pinned_xells) };
}

// ── vars (console) ──────────────────────────────────────────────────────────────
export async function listVars(envId) {
  const env = await one(`SELECT * FROM environment WHERE id=$1`, [envId]);
  if (!env) throw new Error('environment not found');
  const vars = await q(
    `SELECT name, value, is_secret, updated_at FROM environment_var
       WHERE environment_id=$1 ORDER BY name`, [envId]);
  return { environment: env, vars: vars.map(maskVar) };
}

export async function setVar(envId, name, { value, is_secret } = {}) {
  const env = await one(`SELECT id FROM environment WHERE id=$1`, [envId]);
  if (!env) throw new Error('environment not found');
  const nm = String(name || '').trim();
  if (!NAME_RE.test(nm)) throw new Error(`"${name}" is not a valid env var name (LETTERS/digits/_ , not starting with a digit)`);
  // is_secret defaults to true (safe-by-default); an existing row keeps its flag unless overridden.
  const row = await one(
    `INSERT INTO environment_var (environment_id,name,value,is_secret)
     VALUES ($1,$2,$3,COALESCE($4,true))
     ON CONFLICT (environment_id,name) DO UPDATE
       SET value=EXCLUDED.value,
           is_secret=COALESCE($4, environment_var.is_secret),
           updated_at=now()
     RETURNING name, value, is_secret, updated_at`,
    [envId, nm, String(value ?? ''), is_secret === undefined ? null : !!is_secret]);
  await q(`UPDATE environment SET updated_at=now() WHERE id=$1`, [envId]);
  broadcast('environment', { id: envId, project_id: undefined, var: nm });
  return maskVar(row);
}

export async function deleteVar(envId, name) {
  const r = await q(`DELETE FROM environment_var WHERE environment_id=$1 AND name=$2`, [envId, name]);
  await q(`UPDATE environment SET updated_at=now() WHERE id=$1`, [envId]);
  return { ok: true, deleted: name };
}

// ── bulk import from a pasted .env blob (the migration path off on-disk files) ──
// Parses KEY=value / `export KEY=value`, strips surrounding quotes and inline `# comments` on
// unquoted values, ignores blanks/comment lines. Every imported var is is_secret=true by default
// (a .env is secrets until proven otherwise); the human flips the obvious flags afterward.
export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if (/^"(.*)"$/.test(val) || /^'(.*)'$/.test(val)) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash);
      val = val.trim();
    }
    out[m[1]] = val;
  }
  return out;
}

export async function importEnv(envId, text, { is_secret = true } = {}) {
  const env = await one(`SELECT id FROM environment WHERE id=$1`, [envId]);
  if (!env) throw new Error('environment not found');
  const parsed = parseDotenv(text);
  const names = Object.keys(parsed);
  if (!names.length) throw new Error('nothing to import — no KEY=value lines found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of names) {
      await client.query(
        `INSERT INTO environment_var (environment_id,name,value,is_secret)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (environment_id,name) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [envId, name, parsed[name], !!is_secret]);
    }
    await client.query(`UPDATE environment SET updated_at=now() WHERE id=$1`, [envId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  broadcast('environment', { id: envId, imported: names.length });
  return { ok: true, imported: names.length, names };
}

// ── human reveal: the full .env text (the second full-value door) ───────────────
export async function exportEnv(envId) {
  const env = await one(`SELECT * FROM environment WHERE id=$1`, [envId]);
  if (!env) throw new Error('environment not found');
  const vars = await q(
    `SELECT name, value FROM environment_var WHERE environment_id=$1 ORDER BY name`, [envId]);
  const lines = [
    `# ${env.label || env.key} (${env.tier}) — exported from the ZEEHIVE meta-DB.`,
    '# This is the SOURCE OF TRUTH; edit it in the console, not here.',
    ...vars.map((v) => `${v.name}=${v.value}`),
    '',
  ];
  return { key: env.key, tier: env.tier, count: vars.length, text: lines.join('\n') };
}

// ── lint an environment against the repo's declared .env.example ────────────────
// The manifest (016) caches env.example's filename; the example lists the keys the app expects.
// Best-effort — no example, or an unreadable repo, is reported, not thrown.
export async function lintEnv(envId) {
  const env = await one(`SELECT * FROM environment WHERE id=$1`, [envId]);
  if (!env) throw new Error('environment not found');
  const project = await one(`SELECT repo_root, manifest FROM project WHERE id=$1`, [env.project_id]);
  const exampleName = project?.manifest?.env?.example || '.env.example';
  const path = project?.repo_root ? resolve(project.repo_root.replace(/\\/g, '/'), exampleName) : null;
  if (!path || !existsSync(path)) {
    return { ok: false, reason: `no ${exampleName} found in the repo`, example: exampleName };
  }
  let expected = [];
  try { expected = Object.keys(parseDotenv(readFileSync(path, 'utf8'))); }
  catch (e) { return { ok: false, reason: `could not read ${exampleName}: ${e.message}` }; }
  const have = new Set((await q(`SELECT name FROM environment_var WHERE environment_id=$1`, [envId])).map((r) => r.name));
  const missing = expected.filter((k) => !have.has(k));
  const extra = [...have].filter((k) => !expected.includes(k));
  return { ok: true, example: exampleName, expected: expected.length, missing, extra };
}

// key-level diff between two environments (dev vs prod is the common one): which keys only one
// side has. Values are never compared or returned — this is about coverage, not content.
export async function diffEnvironments(aId, bId) {
  const [a, b] = await Promise.all([
    one(`SELECT id, key, tier FROM environment WHERE id=$1`, [aId]),
    one(`SELECT id, key, tier FROM environment WHERE id=$1`, [bId]),
  ]);
  if (!a || !b) throw new Error('environment not found');
  const [av, bv] = await Promise.all([
    q(`SELECT name FROM environment_var WHERE environment_id=$1`, [aId]),
    q(`SELECT name FROM environment_var WHERE environment_id=$1`, [bId]),
  ]);
  const A = new Set(av.map((r) => r.name)), B = new Set(bv.map((r) => r.name));
  return {
    a: { key: a.key, tier: a.tier }, b: { key: b.key, tier: b.tier },
    only_in_a: [...A].filter((k) => !B.has(k)).sort(),
    only_in_b: [...B].filter((k) => !A.has(k)).sort(),
    shared: [...A].filter((k) => B.has(k)).sort(),
  };
}

// ── RESOLUTION — the heart of it ────────────────────────────────────────────────
// WHICH couplings count as "on production" for the purpose of loading an environment. ONE
// definition, used by resolveEnvironmentFor, resolvedEnvView and (as SQL) lib/fleet.js — the three
// places that each carried their own copy of the test until ticket #15 found them disagreeing.
//
// db-prod-readonly is on production. A xell READING the live database talks to the live system, so
// it needs the live system's env vars (API bases, bucket names, service accounts) for anything it
// reads to mean what it says; loading it with dev vars is how a manager zee ended up holding
// production and a dev .env at the same time. Read-only is NOT widened by this: the binding lives in
// DATABASE_URL, which emitXellEnv owns as a RESERVED name — an environment can never set it, so a
// reader keeps the SELECT-only DSN the queenzee minted for it whatever the prod environment says.
//
// db-clone is NOT on production, deliberately: a clone is a throwaway COPY of prod's data sitting in
// the dev cluster. Handing it prod's environment would point a disposable xell at prod's real
// services with a database that only looks like prod.
export function isOnProduction(xell) {
  return xell?.db_coupling === 'db-shared-prod'
      || xell?.db_coupling === 'db-prod-readonly'
      || xell?.is_production === true;
}

// The couplings whose xell CANNOT WRITE the database it is bound to. Exactly one today:
// db-prod-readonly — the SELECT-only role lib/prod-readonly.js mints for a manager zee (ticket #15
// made that binding resolve the PROD environment; it must keep resolving it, for the API bases and
// service accounts its reads need). The distinction matters to the PROJECTION, because the
// environment's own vars may carry database credentials: a write-bound xell owns its database and
// wants them, a reader must never be handed one (writeXellEnv withholds them by name shape, and
// says so in the file). Deliberately NOT a generic "not is_production" test — db-shared-dev,
// db-clone and db-isolated all write their OWN database and are not narrowed by this.
export const READ_ONLY_COUPLINGS = ['db-prod-readonly'];
export function isReadOnlyBinding(xell) {
  return READ_ONLY_COUPLINGS.includes(xell?.db_coupling);
}

// ── WHAT A BINDING MAY NOT BE HANDED: ONE RULE, EVERY CHANNEL ────────────────────────────────────
//
// A project's env reaches a xell through TWO carriers, and BOTH are project-authored:
//   • the environment_var rows merged into .zeehive.env (writeXellEnv — the landed read-only fix)
//   • the manifest's `tiers.spinoff.env` block (spin.env), which writeXellEnv appends to that SAME
//     file AND lib/compose-gen.js bakes into the generated spinoff compose — i.e. into the
//     CONTAINER. A rule enforced on one carrier and not the other is not a rule: the file would
//     say one thing while the container held another.
// The predicates live HERE, beside isReadOnlyBinding, because provision.js and compose-gen.js both
// need them and neither may carry its own copy — two copies of this rule is what let the manifest
// channel drift in the first place.

// The names per-xell wiring OWNS. They are never an environment's or a manifest's to set:
// DATABASE_URL is the line §6.2's guard reads (an environment that declares it must not re-point a
// xell's database), and dotenv is LAST-WINS, so a later duplicate is not a harmless repeat — it is
// an override. provision.js's reserve set extends this with the per-project port names and every
// name already emitted; this is the channel-independent core.
export const RESERVED_ENV_NAMES = new Set([
  'SPINOFF_SLUG', 'DATABASE_URL', 'ZEEHIVE_SITE', 'ZEEHIVE_DOCKER_CONTEXT', 'QUEENZEE_INPROC',
  'ZEEHIVE_META_RO_DSN',
  // The mesh block's two names — reserved even on a mesh-less xell, so a later mesh opt-in can't be
  // pre-poisoned by a stale env var.
  'SPINOFF_MESH_MGMT_URL', 'SPINOFF_MESH_SETUP_KEY',
]);
export function isReservedEnvName(name) {
  return RESERVED_ENV_NAMES.has(String(name ?? '').trim());
}

// IS THIS ENV VAR NAME A DATABASE CREDENTIAL? The guard writeXellEnv asks of every name an
// environment proposes to merge, so a binding that cannot WRITE is never handed a credential that
// can. It has to be a SHAPE and not a list: an environment is each project's own namespace, and the
// next one names its owner password something else — POSTGRES_PASSWORD today, PROD_DB_PASSWORD or a
// bare MONGO_URI tomorrow. A name qualifies when it names a DATABASE **and** names a way IN; either
// half alone is not enough, which is what keeps DB_POOL_MAX, POSTGRES_HOST and API_BASE flowing to a
// reader while the credential does not.
//
//   • NAMES_A_DB     the database's own namespace: POSTGRES*, PGPASSWORD-style libpq names
//                    (LIBPQ_CRED below — concatenated, the one shape with no separator to read),
//                    MYSQL_*/MARIADB_*, MONGO*, REDIS_*, CLICKHOUSE_*, and the generic DB_*/DATABASE_*.
//   • NAMES_A_CRED   a password, a login, or a connection string — the things that let you IN.
//
// DELIBERATELY NOT CAUGHT: SENTRY_DSN, GOOGLE_APPLICATION_CREDENTIALS, AWS_SECRET_ACCESS_KEY and
// every other credential that is not a DATABASE one. A read-only zee still needs the live system's
// service accounts and endpoints for its reads to mean what they say (ticket #15), and a rule that
// swallowed those would trade a credential leak for a broken projection. The trade is only ever
// made for the database the binding says this xell may not write.
//
// It also cannot tell a read-only DATABASE user from the owner — a name is all it has. So it errs
// one way on purpose: on a read-only binding EVERY database credential is withheld, and the file
// NAMES what was withheld (writeXellEnv) so a zee is never silently missing a var.
const NAMES_A_DB = /(^|_)(POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|MARIA|MONGO|MONGODB|REDIS|CLICKHOUSE|DB|DATABASE)(_|$)/i;
const NAMES_A_CRED = /(^|_)(PASSWORD|PASSWD|PWD|PASS|CREDENTIAL|CREDS|USER|USERNAME|LOGIN|ROLE|DSN|URL|URI|CONN|CONNECTION)(_|$)/i;
const LIBPQ_CRED = /^PG(PASSWORD|USER|USERNAME|DATABASE|HOST|PORT|CONNINFO|PASSFILE)$/i;
export function isDatabaseCredentialName(name) {
  const n = String(name ?? '').trim();
  if (!n) return false;
  return LIBPQ_CRED.test(n) || (NAMES_A_DB.test(n) && NAMES_A_CRED.test(n));
}

// THE MANIFEST CHANNEL. What of a `tiers.spinoff.env` block may be projected, and what may not:
//   • a RESERVED name is ignored on EVERY channel ("reserved means reserved") — otherwise the
//     manifest gains a second DATABASE_URL line (dotenv: last wins) and the §6.2 rule it is guarded
//     by is bypassed by declaration;
//   • a database CREDENTIAL is dropped when `keepCredentials` is false. That is true for a
//     read-only binding (isReadOnlyBinding) — the same predicate, the same outcome as the env-var
//     path, so the two channels cannot drift — AND for the GENERATED COMPOSE, which is
//     project-scoped: one file is baked into every xell container of the project, the ordinary
//     spinoff and the read-only-bound manager alike, so nothing a writer needs can be scoped to it
//     and the strictest binding is the one it must hold to. A manifest that declares a database
//     credential there is a config smell, not a feature: credentials belong to the manifest's `db`
//     block (from which the server's DATABASE_URL is built) and to the meta-DB environment.
// Returns { kept: [[k, v]…], withheld: [name…], reserved: [name…] } — the two dropped sets are
// returned NAMED, never silently, because a caller that writes a file has to say what it omitted.
export function splitSpinEnv(spinEnv, { keepCredentials = true, reserved = [] } = {}) {
  const res = new Set([...RESERVED_ENV_NAMES, ...reserved]);
  const kept = [], withheld = [], ignored = [];
  for (const [k, v] of Object.entries(spinEnv || {})) {
    if (res.has(String(k).trim())) { ignored.push(k); continue; }
    if (!keepCredentials && isDatabaseCredentialName(k)) { withheld.push(k); continue; }
    kept.push([k, v]);
  }
  return { kept, withheld, reserved: ignored };
}

// …AND WHAT THE READ MODEL MUST NOT CLAIM IT HAS. `zee env` and the console badge render
// resolvedEnvView, so it has to say what the FILE says: on a read-only binding a database
// credential is withheld by writeXellEnv, and a view that still listed it would tell a manager zee
// it holds POSTGRES_PASSWORD while the file it reads does not carry one. Reserved names stay LISTED
// (the panel labels them as queenzee-owned — the projection is what refuses them, not the picker's
// read model), so this drops exactly what the merge drops.
export function withheldEnvVars(xell, vars) {
  if (!isReadOnlyBinding(xell)) return { vars, withheld: [] };
  const kept = [], withheld = [];
  for (const v of vars) {
    if (!isReservedEnvName(v.name) && isDatabaseCredentialName(v.name)) withheld.push(v.name);
    else kept.push(v);
  }
  return { vars: kept, withheld };
}

// Returns the environment row a xell should get, or null if none is configured. The precedence is
// the task's rule, in order: explicit pin → on-production → dev.
export async function resolveEnvironmentFor(xell) {
  if (xell.environment_id) {
    const pinned = await one(`SELECT * FROM environment WHERE id=$1`, [xell.environment_id]);
    if (pinned) return pinned;   // pin dropped out from under us → fall through to tier default
  }
  const tier = isOnProduction(xell) ? 'prod' : 'dev';
  return one(
    `SELECT * FROM environment WHERE project_id=$1 AND tier=$2 AND is_default LIMIT 1`,
    [xell.project_id, tier]);
}

// Full-value door #2 (deploy): write a project's default environment for `tier` to an on-disk .env,
// making the meta-DB the source and the file a projection — the same inversion .zeehive.env already
// is, now for the prod deploy (ship-prod.sh reads <source>/.env). SAFE BY REFUSAL: an empty
// environment is NEVER written over an existing file — that would blank prod's secrets, so a project
// that hasn't filled its prod environment keeps shipping exactly as before. The current file is
// backed up first. Returns {written,…} or {skipped, reason}.
export async function materializeEnvFile(projectId, tier, destPath) {
  const env = await one(
    `SELECT * FROM environment WHERE project_id=$1 AND tier=$2 AND is_default LIMIT 1`, [projectId, tier]);
  if (!env) return { skipped: true, reason: `no default ${tier} environment configured` };
  const vars = await q(
    `SELECT name, value FROM environment_var WHERE environment_id=$1 ORDER BY name`, [env.id]);
  if (!vars.length) {
    return { skipped: true, environment: env.key,
      reason: `${tier} environment "${env.key}" is empty — on-disk ${destPath} left as the source of truth` };
  }
  const body = [
    `# GENERATED from the ZEEHIVE meta-DB (environment: ${env.key}). Edit it in the console, not here.`,
    ...vars.map((v) => `${v.name}=${v.value}`), '',
  ].join('\n');
  let backup = null;
  if (existsSync(destPath)) {
    backup = `${destPath}.zeehive-bak`;
    try { copyFileSync(destPath, backup); } catch { backup = null; }
  }
  writeFileSync(destPath, body);
  return { written: true, path: destPath, backup, count: vars.length, environment: env.key };
}

// The full-value door #1: the resolved environment's vars for emitXellEnv to write into the xell's
// own gitignored .zeehive.env. Returns [] when no environment resolves, so provisioning is a no-op
// on projects that haven't filled one in.
export async function fullVarsFor(environmentId) {
  if (!environmentId) return [];
  return q(
    `SELECT name, value FROM environment_var WHERE environment_id=$1 ORDER BY name`, [environmentId]);
}

// EXTRACT a xell's CURRENT environment — the full text a human can copy out. Ground truth is the
// xell's own .zeehive.env on disk (what it is ACTUALLY running with — ports + DATABASE_URL + the
// merged env vars); if that file is absent (a pooled xell never emitted, or a torn-down worktree)
// it falls back to the resolved environment's .env text from the meta-DB. Full values — this is a
// human reveal door, like exportEnv. Returns { source, text, path?, environment? }.
export async function extractXellEnv(xellId) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('xell not found');
  if (xell.worktree_path) {
    const path = resolve(xell.worktree_path.replace(/\\/g, '/'), '.zeehive.env');
    if (existsSync(path)) {
      return { source: 'zeehive-env', path, slug: xell.slug, text: readFileSync(path, 'utf8') };
    }
  }
  // No on-disk projection — hand back what it WOULD resolve to from the meta-DB.
  const env = await resolveEnvironmentFor(xell);
  if (!env) return { source: 'none', slug: xell.slug, text: '', note: 'no .zeehive.env on disk and no environment resolves for this xell' };
  const dump = await exportEnv(env.id);
  return { source: 'resolved', slug: xell.slug, environment: env.key, tier: env.tier, text: dump.text, note: 'no .zeehive.env on disk — showing the resolved meta-DB environment' };
}

// Masked view of what a xell resolves to — for the console badge and the `zee env` self verb. Shows
// the environment identity and the var NAMES (values stay in .zeehive.env), never secret values.
export async function resolvedEnvView(xell) {
  const env = await resolveEnvironmentFor(xell);
  if (!env) {
    return { environment: null, pinned: !!xell.environment_id, tier: isOnProduction(xell) ? 'prod' : 'dev', vars: [] };
  }
  const vars = await q(
    `SELECT name, value, is_secret, updated_at FROM environment_var WHERE environment_id=$1 ORDER BY name`, [env.id]);
  // The read model agrees with the FILE, not just with the meta-DB: on a read-only binding the
  // credentials writeXellEnv withheld are not listed as vars of this environment (see
  // withheldEnvVars — same predicate, so the two cannot drift). They are NAMED in `withheld`
  // rather than dropped silently: the whole guard is built on a missing var being distinguishable
  // from one that was never configured.
  const { vars: visible, withheld } = withheldEnvVars(xell, vars);
  return {
    environment: { id: env.id, key: env.key, label: env.label, tier: env.tier, is_default: env.is_default },
    pinned: !!xell.environment_id,
    reason: xell.environment_id ? 'pinned' : (env.tier === 'prod' ? 'production xell (live or read-only) → prod env' : 'dev/spinoff xell → dev env'),
    vars: visible.map(maskVar),
    ...(withheld.length ? {
      withheld,
      withheld_reason: `this xell's binding (${xell.db_coupling}) is READ-ONLY, so a database `
        + 'credential is not projected into it — the same names are absent from its .zeehive.env '
        + 'and from the generated spinoff compose. Its database access is the per-xell DATABASE_URL.',
    } : {}),
  };
}

// Pin (or unpin, environmentId=null) a specific environment onto a xell, then re-emit its
// .zeehive.env so the change lands immediately. The environment must belong to the xell's project.
export async function setXellEnvironment(xellId, environmentId) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('xell not found');
  if (environmentId) {
    const env = await one(`SELECT id FROM environment WHERE id=$1 AND project_id=$2`, [environmentId, xell.project_id]);
    if (!env) throw new Error('environment not found for this project');
  }
  const updated = await one(
    `UPDATE xell SET environment_id=$2 WHERE id=$1 RETURNING *`, [xellId, environmentId || null]);
  broadcast('xell', updated);
  // Re-project .zeehive.env (best-effort — a pooled xell with no worktree yet simply has none to write).
  const { emitXellEnv } = await import('./provision.js');
  const emit = await emitXellEnv(xellId).catch((e) => ({ error: e.message }));
  return { ok: true, environment_id: environmentId || null, emit };
}
