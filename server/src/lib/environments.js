// ENVIRONMENTS — the meta-DB as the source of truth for the env vars git ignores (migration 043).
//
// A project holds named environments (dev / prod / staging …), each a set of KEY=value vars. The
// full value leaves this module through exactly TWO doors: fullVarsFor() (emitXellEnv, into the
// xell's own gitignored .zeehive.env) and exportEnv() (a human's explicit reveal). Everything the
// console lists is masked — same discipline as lib/provider-tokens.js.
//
// Resolution (resolveEnvironmentFor) is the rule the task asked for: an explicit xell.environment_id
// wins; else a live-prod (db-shared-prod) or is_production xell gets the default PROD environment;
// else the default DEV one. Spinoff/dev xells therefore get dev env, prod xells get prod env, and a
// xell handed the live prod db is loaded with the production environment.
import { readFileSync, existsSync } from 'node:fs';
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
// Returns the environment row a xell should get, or null if none is configured. The precedence is
// the task's rule, in order: explicit pin → live-prod/production → dev.
export async function resolveEnvironmentFor(xell) {
  if (xell.environment_id) {
    const pinned = await one(`SELECT * FROM environment WHERE id=$1`, [xell.environment_id]);
    if (pinned) return pinned;   // pin dropped out from under us → fall through to tier default
  }
  const wantsProd = xell.db_coupling === 'db-shared-prod' || xell.is_production === true;
  const tier = wantsProd ? 'prod' : 'dev';
  return one(
    `SELECT * FROM environment WHERE project_id=$1 AND tier=$2 AND is_default LIMIT 1`,
    [xell.project_id, tier]);
}

// The full-value door #1: the resolved environment's vars for emitXellEnv to write into the xell's
// own gitignored .zeehive.env. Returns [] when no environment resolves, so provisioning is a no-op
// on projects that haven't filled one in.
export async function fullVarsFor(environmentId) {
  if (!environmentId) return [];
  return q(
    `SELECT name, value FROM environment_var WHERE environment_id=$1 ORDER BY name`, [environmentId]);
}

// Masked view of what a xell resolves to — for the console badge and the `zee env` self verb. Shows
// the environment identity and the var NAMES (values stay in .zeehive.env), never secret values.
export async function resolvedEnvView(xell) {
  const env = await resolveEnvironmentFor(xell);
  if (!env) {
    return { environment: null, pinned: !!xell.environment_id, tier: xell.is_production || xell.db_coupling === 'db-shared-prod' ? 'prod' : 'dev', vars: [] };
  }
  const vars = await q(
    `SELECT name, value, is_secret, updated_at FROM environment_var WHERE environment_id=$1 ORDER BY name`, [env.id]);
  return {
    environment: { id: env.id, key: env.key, label: env.label, tier: env.tier, is_default: env.is_default },
    pinned: !!xell.environment_id,
    reason: xell.environment_id ? 'pinned' : (env.tier === 'prod' ? 'live-prod/production xell → prod env' : 'dev/spinoff xell → dev env'),
    vars: vars.map(maskVar),
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
