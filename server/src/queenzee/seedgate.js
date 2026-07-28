// SEEDING PRODUCTION — the zee asks, a human approves, the QUEENZEE runs the SQL.
//
// The gap this closes (migration 049 carries the full rationale): a ship carries code, schema
// (server/sql/migrations) and one-time data fixes (server/sql/ops), and all three are decided
// BEFORE the containers rebuild. Some shipments only become usable once rows exist in production —
// reference data for a new table, a lookup the new screen reads, the first row of a new feature —
// and that seeding belongs AFTER the ship, or is only discovered once prod is serving the new code.
// The only tool a zee had for it was `zee prod`: bind the whole xell to the live production
// database and hand-run SQL. That is a sledgehammer for one reviewed file, and it grants far more
// than the job needs.
//
// So the division of labour is copied from shipgate.js, exactly:
//   zee      → may only REQUEST, naming files that are ALREADY ON MAIN.
//   human    → approves in the console, with the SQL and any prior runs in view.
//   queenzee → reads each file at the main tip with `git show`, proves the target really is the
//              registry's production database, and runs it. The zee never touches prod.
//
// Two rules make this safe rather than merely convenient:
//   1. ONLY FILES ON MAIN, under server/sql/seeds/ — the same anti-band-aid rule the ship gate
//      enforces for code. A seed that is not landed cannot be approved, so what ran on prod is
//      always readable in the repo afterwards, by sha.
//   2. IDEMPOTENT BY CONTRACT, not by ledger. A migration must run exactly once; a seed is
//      legitimately re-runnable (re-seed after a restore, top up a lookup). So seeds are NOT
//      ledgered — instead every prior run of the same file is surfaced to the human at approval
//      time, and the zee is told to write `ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS` SQL.
import { spawnSync } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { cleanGitEnv, headCommit } from '../lib/git.js';
import { notifySeedRequest } from '../lib/notify.js';
import { prodDb, psql, assertProdDbTarget } from './shipmigrate.js';

// The ONE directory a seed may come from. Hardcoded like SCHEMA_DIR/OPS_DIR in shipmigrate.js: the
// whitelist is what keeps "run this file on prod" from meaning "run ANY file in the repo on prod".
export const SEED_DIR = 'server/sql/seeds';
// Real runs are gated on a human anyway; SEED_MODE=simulate exists to verify ZEEHIVE itself
// end-to-end without a production database in the loop (mirrors SHIP_MODE). Read per call, not
// once at import: a test that flips the mode mid-run must get the mode it set, and nothing here is
// hot enough for one env read to matter.
const seedMode = () => (process.env.SEED_MODE === 'simulate' ? 'simulate' : 'real');
const OPEN = ['pending', 'approved', 'running'];

const gitOk = (repoRoot, args) => spawnSync('git', ['-C', repoRoot, ...args],
  { encoding: 'utf8', timeout: 20000, windowsHide: true, env: cleanGitEnv() });

// Every seed file that exists AT `sha` — read from git, never a working tree, so the list is
// exactly what the landed commit carries.
export function listSeedFiles(repoRoot, sha) {
  const r = gitOk(repoRoot, ['ls-tree', '-r', '--name-only', sha, '--', SEED_DIR]);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.sql')).sort();
}

// The text of one seed file at `sha` (what the human reads before approving, and what actually
// runs). null when the file is not in that commit.
export function seedFileAt(repoRoot, sha, file) {
  const r = gitOk(repoRoot, ['show', `${sha}:${file}`]);
  return r.status === 0 ? r.stdout : null;
}

// Normalize what a zee names: `sql/seeds/x.sql`, `./server/sql/seeds/x.sql` and a bare `x.sql` all
// mean the same file. Backslashes too — a zee on a Windows-shaped path should not be told "no such
// file" over a separator. Returns a repo-relative path under SEED_DIR, or null if it escapes it.
export function normalizeSeedPath(input) {
  const raw = String(input || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!raw || raw.includes('..') || !raw.endsWith('.sql')) return null;
  if (raw.startsWith(`${SEED_DIR}/`)) return raw;
  const parts = raw.split('/');
  const base = parts.pop();
  const dir = parts.join('/');
  // A partial prefix of the seed dir is a shorthand for it ('sql/seeds/x.sql', 'seeds/x.sql');
  // anything else names a file OUTSIDE the whitelist and is refused rather than silently rewritten.
  if (dir && !SEED_DIR.endsWith(`/${dir}`)) return null;
  return `${SEED_DIR}/${base}`;
}

// Which production this seeds (spec §5 sites) — named key, else the project's default prod site.
// null only for a pre-sites project, whose prod db row carries site_id IS NULL.
async function resolveSeedSite(projectId, siteKey = null) {
  if (siteKey) {
    const s = await one(
      `SELECT * FROM deploy_site WHERE project_id=$1 AND key=$2 AND tier='prod'`, [projectId, siteKey]);
    if (!s) throw new Error(`no prod deploy site keyed "${siteKey}" for this project`);
    return s;
  }
  return one(
    `SELECT * FROM deploy_site WHERE project_id=$1 AND tier='prod' AND is_default LIMIT 1`, [projectId]);
}

// Has any of these files already been run on this project's production? Surfaced to the human at
// approval time — a seed is allowed to be re-run, but a REPEAT should be a decision, not a surprise.
export async function priorRuns(projectId, files) {
  if (!files.length) return [];
  const rows = await q(
    `SELECT id, files, commit, finished_at, decided_by, xell_slug FROM prod_seed_request
      WHERE project_id=$1 AND status='seeded' AND files ?| $2::text[]
      ORDER BY finished_at DESC LIMIT 10`, [projectId, files]);
  return rows.map((r) => ({
    id: r.id, at: r.finished_at, by: r.decided_by, xell: r.xell_slug,
    commit: r.commit ? String(r.commit).slice(0, 8) : null,
    files: (r.files || []).filter((f) => files.includes(f)),
  }));
}

// IS PRODUCTION ALREADY RUNNING THE CODE THIS SEED BELONGS TO? A seed usually rides BEHIND a ship
// ("some shipments require seeding the database"), and seeding rows for a table prod does not have
// yet just fails — noisily, but it wastes an approval. So the answer travels with the request and
// renders on the card, as information rather than a rule: there are legitimate seeds that precede a
// ship, and a gate that guessed at the order would block them.
//   { shipped: <sha|null>, contains: true|false|null }   null = nothing shipped / cannot tell
export async function shipState(project, commit) {
  const last = await one(
    `SELECT commit FROM ship_request WHERE project_id=$1 AND status='shipped'
      ORDER BY finished_at DESC NULLS LAST LIMIT 1`, [project.id]);
  if (!last?.commit || !commit) return { shipped: last?.commit || null, contains: null };
  const r = gitOk(project.repo_root, ['merge-base', '--is-ancestor', commit, last.commit]);
  return { shipped: last.commit, contains: r.status === 0 ? true : r.status === 1 ? false : null };
}

// ── the zee's verb: ASK to seed production ───────────────────────────────────
// Records a request only. Refused (loudly, with the reason the zee can act on) when the named
// files are not on main — because the queenzee runs them FROM main, so an unlanded seed is not
// merely unwise, it is unrunnable.
export async function requestProdSeed({ xellId, zeeId = null, files = [], reason = null, site = null }) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('unknown xell');
  if (xell.is_production) throw new Error('production cannot file a seed request against itself');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  const main = project.main_branch || 'main';

  const existing = await one(
    `SELECT * FROM prod_seed_request WHERE xell_id=$1 AND status = ANY($2)`, [xellId, OPEN]);
  if (existing) {
    return { ok: true, request: existing, note: 'you already have an open prod-seed request — a human '
      + 'must decide it before you can file another' };
  }

  // WHAT gets read: the same ref a ship builds from (ship_ref, else main). No fetch here — a seed
  // is decided against what the xource ALREADY has, and a request that silently re-pointed at a
  // freshly fetched remote tip would show the human one sha and run another.
  const ref = project.ship_ref || main;
  const commit = headCommit(project.repo_root, ref);
  if (!commit) return { ok: false, reason: `"${ref}" does not resolve in ${project.repo_root}`, request: null };

  const asked = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!asked.length) {
    const avail = listSeedFiles(project.repo_root, commit);
    return { ok: false, request: null,
      reason: `name at least one seed file (--file ${SEED_DIR}/<name>.sql). On ${ref} right now: `
        + (avail.length ? avail.join(', ') : `nothing in ${SEED_DIR}/ yet — write one, land it, then ask`) };
  }

  const wanted = [];
  for (const f of asked) {
    const rel = normalizeSeedPath(f);
    if (!rel) {
      return { ok: false, request: null,
        reason: `"${f}" is not a seed file: a prod seed may only run *.sql from ${SEED_DIR}/ — that `
          + 'whitelist is what keeps an approval from meaning "run any file in the repo on production"' };
    }
    if (!wanted.includes(rel)) wanted.push(rel);
  }

  // The anti-band-aid rule, for data: the file must be ON MAIN, because that is where the queenzee
  // reads it from. Unlanded seed → land it first (`zee land`), then ask.
  const onMain = new Set(listSeedFiles(project.repo_root, commit));
  const missing = wanted.filter((f) => !onMain.has(f));
  if (missing.length) {
    const reasonText = `${missing.join(', ')} — not on ${ref} (@ ${commit.slice(0, 8)}). The queenzee runs `
      + 'a seed FROM the xource at main, never from your worktree, so an unlanded seed cannot run: '
      + 'commit it and `zee land` first, then ask again.';
    logline('seed', `REFUSED seed request from ${xell.slug}: ${reasonText}`);
    return { ok: false, reason: reasonText, request: null };
  }

  let seedSite;
  try { seedSite = await resolveSeedSite(project.id, site); }
  catch (e) { return { ok: false, reason: e.message, request: null }; }

  const row = await one(
    `INSERT INTO prod_seed_request (project_id, xell_id, xell_slug, zee_id, site_id, files, commit, reason)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
    [project.id, xellId, xell.slug, zeeId, seedSite?.id || null, JSON.stringify(wanted), commit, reason]);
  broadcast('seed', row);
  broadcast('xell', { id: xellId });
  const prior = await priorRuns(project.id, wanted);
  const ship = await shipState(project, commit);
  logline('seed', `HELD seed request from ${xell.slug} @ ${commit.slice(0, 8)} — ${wanted.length} file(s): `
    + `${wanted.map((f) => f.replace(`${SEED_DIR}/`, '')).join(', ')}${prior.length ? ` (⚠ ${prior.length} prior run(s) of these files)` : ''}`);
  notifySeedRequest({ project, xell, request: row });
  return {
    ok: true, request: row, prior, ship,
    note: ship.contains === false
      ? 'NB: production is not yet running this commit — if these rows depend on a table this ship has '
        + 'not delivered, the seed will fail. Ship first, then have the seed approved.'
      : undefined,
    message: 'Prod seed REQUESTED — a human must approve it in the ZEEHIVE console, and then the '
      + 'QUEENZEE runs the SQL against production (you never touch prod). Seeds are NOT ledgered: '
      + 'write them idempotent (ON CONFLICT DO NOTHING / WHERE NOT EXISTS) so a re-run is harmless.',
  };
}

// What the zee sees with `zee seed --status`: its latest request and where it got to.
export async function seedStatusFor(xellId) {
  return one(
    `SELECT * FROM prod_seed_request WHERE xell_id=$1 ORDER BY requested_at DESC LIMIT 1`, [xellId]);
}

// ── the human side ───────────────────────────────────────────────────────────
export async function listProdSeedRequests(projectId, { open = true } = {}) {
  const where = open
    ? `AND (psr.status = ANY($2) OR (psr.status IN ('seeded','failed')
             AND psr.finished_at > now() - interval '15 minutes'))`
    : '';
  const args = open ? [projectId, OPEN] : [projectId];
  return q(
    `SELECT psr.*, x.slug AS live_xell_slug FROM prod_seed_request psr
       LEFT JOIN xell x ON x.id = psr.xell_id
      WHERE psr.project_id=$1 AND psr.dismissed_at IS NULL ${where}
      ORDER BY psr.requested_at DESC LIMIT 50`, args);
}

// The SQL a human is being asked to approve — read at the request's OWN sha, so what is displayed
// is byte-for-byte what will run.
export async function seedRequestSql(id) {
  const row = await one(`SELECT * FROM prod_seed_request WHERE id=$1`, [id]);
  if (!row) throw new Error('no such seed request');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [row.project_id]);
  const files = (row.files || []).map((f) => ({
    file: f, sql: seedFileAt(project.repo_root, row.commit, f),
  }));
  return { id: row.id, commit: row.commit, files,
    prior: await priorRuns(row.project_id, row.files || []),
    ship: await shipState(project, row.commit) };
}

// "Seen it — stop showing me." View-only, like the landing/ship equivalents: it never changes what
// happened, it just stops the receipt rendering.
export async function dismissSeedRequest(id, by = 'human@console') {
  const row = await one(
    `UPDATE prod_seed_request SET dismissed_at=now(), dismissed_by=$2 WHERE id=$1 RETURNING *`, [id, by]);
  if (!row) throw new Error('no such seed request');
  broadcast('seed', row);
  return row;
}

// APPROVE or REJECT. Approving runs the seed inline (a seed is seconds of psql, not a 45-minute
// build) and returns the finished row, so the console reports the real outcome from one click.
export async function decideProdSeed(id, decision, by = 'human@console') {
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad decision: ${decision}`);
  const row = await one(
    `UPDATE prod_seed_request SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`, [id, decision, by]);
  if (!row) throw new Error('no such pending seed request (already decided?)');
  broadcast('seed', row);
  if (decision === 'rejected') {
    logline('seed', `seed request from ${row.xell_slug || row.xell_id} REJECTED by ${by}`);
    broadcast('xell', { id: row.xell_id });
    return row;
  }
  logline('seed', `seed APPROVED by ${by} for ${row.xell_slug || row.xell_id} — running on production`);
  return runSeed(row.id);
}

// Execute an approved seed against production. Every refusal lands as status='failed' with the
// reason on the row, because a seed that silently did nothing is the failure mode this whole gate
// exists to prevent (HANDOFF: the ops/ fix that "shipped" and left prod still broken).
export async function runSeed(id) {
  const row = await one(
    `UPDATE prod_seed_request SET status='running' WHERE id=$1 AND status IN ('approved','running')
       RETURNING *`, [id]);
  if (!row) throw new Error('no such approved seed request');
  broadcast('seed', row);
  const project = await one(`SELECT * FROM project WHERE id=$1`, [row.project_id]);
  const site = row.site_id ? await one(`SELECT * FROM deploy_site WHERE id=$1`, [row.site_id]) : null;

  const fail = async (error, applied = []) => {
    logline('seed', `seed FAILED for ${row.xell_slug || row.xell_id}: ${error}`);
    const done = await one(
      `UPDATE prod_seed_request SET status='failed', finished_at=now(), result=$2::jsonb
         WHERE id=$1 RETURNING *`, [id, JSON.stringify({ ok: false, error, applied, mode: seedMode() })]);
    broadcast('seed', done);
    broadcast('xell', { id: row.xell_id });
    return done;
  };

  // A deploy in flight owns production. Refuse rather than write data underneath a half-swapped
  // container — the human simply approves again once the ship finishes.
  const lock = await one(
    `SELECT dl.*, x.slug FROM deploy_lock dl LEFT JOIN xell x ON x.id = dl.xell_id
      WHERE dl.project_id=$1`, [project.id]);
  if (lock) {
    return fail(`production is held by a deploy right now (${lock.slug || lock.container}, phase `
      + `${lock.phase || '?'}) — nothing was run. Approve the seed again once the ship finishes.`);
  }

  let db;
  try { db = await prodDb(project, site); }
  catch (e) { return fail(e.message); }
  if (!db) return fail('no prod db container in the inventory for this project/site');

  if (seedMode() === 'simulate') {
    const applied = (row.files || []).map((f) => ({ file: f, ok: true, simulated: true }));
    logline('seed', `[simulate] would run ${applied.length} seed file(s) on ${db.container}/${db.name}`);
    const done = await one(
      `UPDATE prod_seed_request SET status='seeded', finished_at=now(), result=$2::jsonb
         WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ ok: true, applied, mode: seedMode(), database: `${db.container}/${db.name}` })]);
    broadcast('seed', done);
    broadcast('xell', { id: row.xell_id });
    return done;
  }

  // PROVE the target is really the registry's production database before writing a row into it —
  // the same guard that stopped a ship migrating a 7.7MB dev clone (shipmigrate.decideProdDbTarget).
  const guard = await assertProdDbTarget(db);
  if (!guard.ok) return fail(guard.error);

  const applied = [];
  for (const f of (row.files || [])) {
    const sql = seedFileAt(project.repo_root, row.commit, f);
    if (sql == null) return fail(`cannot read ${f} at ${String(row.commit).slice(0, 8)}`, applied);
    // One transaction per file: a seed either lands whole or not at all, and the first failure
    // stops the run rather than leaving a half-seeded production.
    const r = await psql(db, ['--single-transaction'], sql);
    if (!r.ok) {
      applied.push({ file: f, ok: false, error: (r.err || '').trim().split('\n').pop()?.slice(0, 300) });
      return fail(`${f}: ${(r.err || '').trim().split('\n').pop()?.slice(0, 300)}`, applied);
    }
    applied.push({ file: f, ok: true, out: (r.out || '').trim().split('\n').slice(-5).join('\n').slice(0, 500) });
    logline('seed', `seeded ${f} @ ${String(row.commit).slice(0, 8)} → ${db.container}/${db.name}`);
  }

  const done = await one(
    `UPDATE prod_seed_request SET status='seeded', finished_at=now(), result=$2::jsonb
       WHERE id=$1 RETURNING *`,
    [id, JSON.stringify({ ok: true, applied, mode: seedMode(), database: `${db.container}/${db.name}` })]);
  broadcast('seed', done);
  broadcast('xell', { id: row.xell_id });
  logline('seed', `SEEDED production for ${row.xell_slug || row.xell_id} — ${applied.length} file(s) on `
    + `${db.container}/${db.name}`);
  return done;
}
