// Prod-diff — routine schema+trigger drift detection for every db container, against the
// project's PRODUCTION database.
//
// WHY THIS EXISTS: OmniBiz has no migration runner and no schema_migrations ledger, so you cannot
// ask a database what it is missing — the only way to know is to diff it against another one. That
// gap let production run DEPLOYED code against objects that did not exist (KitchenClaimModel.js
// with no erp_restaurant.kitchen_claim table) and nothing noticed until a human diffed it by hand.
// This turns that hand-diff into a loop and a colour on the chip.
//
// PROD IS THE RULER. It is compared against nothing and keeps prod_diff NULL. Every other db
// container (shared dev, per-xell isolated) is measured against it.
//
// "missing" = prod has it, this db does not. This is the DANGEROUS direction for a db that runs
//             prod code, and the one worth a red chip.
// "extra"   = this db has it, prod does not — usually unshipped work, sometimes dead legacy.
//
// READ-ONLY. Catalog SELECTs over `docker exec psql`. It never writes to any application db.
import { spawn } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { resolveRealDbContainer } from '../lib/xell-db.js';
import { config } from '../config.js';

const SAMPLE = 8;          // per kind, per direction — this feeds a tooltip, not an audit
const CONCURRENCY = 3;     // db containers probed at once; the NAS is not a datacentre

// Schemas that are pure ENGINE noise, never application schema. postgis/h3 builds differ between
// hosts even at the same image tag: the NAS build of omnibiz-postgis:18-3.6-h3 pre-installs
// postgis_topology + postgis_tiger_geocoder (bringing tiger/tiger_data/topology, ~39 tables) and
// prod's build does not. Comparing those reports hundreds of phantom differences that no human can
// act on. The application lives everywhere else.
const NOISE_SCHEMAS = ["'pg_catalog'", "'information_schema'", "'tiger'", "'tiger_data'",
                       "'topology'", "'ogr_system_tables'"].join(',');

// Extension-owned functions are engine noise too (~1400 of them from postgis alone) and are
// implied by the extension set, not by anyone's migration. pg_depend deptype='e' marks them.
// zeehive_migrations is the ship's own ledger (shipmigrate.js) — it lives ONLY in prod, by
// design, so comparing it is comparing the ruler's serial number instead of what it measures.
// Unexcluded, the migration system's own bookkeeping tripped the parity gate it exists to serve,
// for every xell, forever: a chicken-and-egg a zee correctly diagnosed from the outside on day one.
const LEDGER_TABLE = `'zeehive_migrations'`;
const Q = {
  table: `SELECT table_schema||'.'||table_name FROM information_schema.tables
           WHERE table_schema NOT IN (${NOISE_SCHEMAS}) AND table_type='BASE TABLE'
             AND table_name <> ${LEDGER_TABLE}`,
  column: `SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type
             FROM information_schema.columns WHERE table_schema NOT IN (${NOISE_SCHEMAS})
             AND table_name <> ${LEDGER_TABLE}`,
  trigger: `SELECT n.nspname||'.'||c.relname||'.'||t.tgname
              FROM pg_trigger t
              JOIN pg_class c ON c.oid=t.tgrelid
              JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE NOT t.tgisinternal AND n.nspname NOT IN (${NOISE_SCHEMAS})`,
};

// Non-blocking docker exec → stdout. Never rejects: resolves {ok,out} so one unreachable container
// cannot take the tick down. spawn (not spawnSync) — this loop must not freeze the event loop, the
// same reason maintenance.js spawns.
function dockerPsql(ctx, container, sql, timeout = 30000) {
  return new Promise((resolve) => {
    let out = '', err = '', child;
    const args = ['--context', ctx, 'exec', '-i', container,
      'psql', '-U', config.prodDbUser || 'postgres', '-d', config.prodDbName || 'omnibiz',
      '-tAF', '\x1f', '-c', sql];
    try { child = spawn('docker', args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, out: '', err: String(e?.message || e) }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: '', err: String(e?.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
  });
}

const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

// One catalog fingerprint per kind → { table:Set, column:Set, trigger:Set }, or null if the db
// could not be read at all (down, restoring, wrong creds).
async function fingerprint(ctx, container) {
  const fp = {};
  for (const [kind, sql] of Object.entries(Q)) {
    const r = await dockerPsql(ctx, container, sql);
    if (!r.ok) return { error: (r.err || 'psql failed').trim().split('\n').pop().slice(0, 160) };
    fp[kind] = new Set(lines(r.out));
  }
  return { fp };
}

function diffSets(prodSet, devSet) {
  const missing = [...prodSet].filter((x) => !devSet.has(x)).sort();
  const extra = [...devSet].filter((x) => !prodSet.has(x)).sort();
  return { missing, extra };
}

// Compare one db container against a prod fingerprint and persist the verdict.
async function diffContainer(c, prodFp) {
  const real = resolveRealDbContainer(c.docker_ctx, c.name);
  const got = await fingerprint(c.docker_ctx, real);

  let payload;
  if (got.error) {
    payload = { ok: false, error: got.error, total: null, kinds: null };
  } else {
    const kinds = {};
    let total = 0;
    for (const kind of Object.keys(Q)) {
      const { missing, extra } = diffSets(prodFp[kind], got.fp[kind]);
      total += missing.length + extra.length;
      kinds[kind] = {
        missing_count: missing.length, extra_count: extra.length,
        missing: missing.slice(0, SAMPLE), extra: extra.slice(0, SAMPLE),
      };
    }
    payload = { ok: true, error: null, total, kinds };
  }

  const prev = c.prod_diff?.total;
  const row = await one(
    `UPDATE container SET prod_diff=$2::jsonb, prod_diff_at=now() WHERE id=$1 RETURNING *`,
    [c.id, JSON.stringify(payload)]);
  if (row) broadcast('container', row);

  // Only log on a CHANGE. This runs on a loop; logging every tick would bury the terminal in
  // "still in sync" and make the one line that matters invisible.
  if (payload.ok && prev !== payload.total) {
    logline('proddiff', payload.total === 0
      ? `${c.name} is IN SYNC with prod`
      : `${c.name} has DRIFTED from prod: ${payload.total} difference(s) — `
        + Object.entries(payload.kinds)
            .filter(([, v]) => v.missing_count + v.extra_count)
            .map(([k, v]) => `${k} -${v.missing_count}/+${v.extra_count}`).join(', '));
  } else if (!payload.ok && c.prod_diff?.ok !== false) {
    logline('proddiff', `${c.name}: could not compare against prod — ${payload.error}`);
  }
  return payload;
}

// On-demand diff of ONE xell's database against prod — the /ooney gate calls this so its verdict
// is measured NOW, not read from whatever the last 10-minute tick happened to record. Returns the
// same payload shape diffContainer persists. `same_db: true` when the xell's database IS the prod
// container (db-shared-prod): identical by identity, nothing to measure.
export async function diffXellDbAgainstProd(projectId, xellId) {
  const prod = await one(
    `SELECT * FROM container WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`, [projectId]);
  if (!prod) return { ok: false, error: 'no prod db container in the inventory', total: null };

  const mine = await one(
    `SELECT c.* FROM container c JOIN xell_uses_container uc ON uc.container_id=c.id
      WHERE uc.xell_id=$1 AND c.role='db' LIMIT 1`, [xellId]);
  if (!mine) return { ok: false, error: 'this xell has no database container linked', total: null };
  if (mine.id === prod.id) return { ok: true, same_db: true, total: 0, kinds: null };

  const realProd = resolveRealDbContainer(prod.docker_ctx, prod.name);
  const got = await fingerprint(prod.docker_ctx, realProd);
  if (got.error) return { ok: false, error: `prod db unreadable: ${got.error}`, total: null };

  return diffContainer(mine, got.fp);
}

export async function prodDiffTick() {
  const projects = await q(`SELECT DISTINCT project_id FROM container WHERE role='db'`);
  let checked = 0, drifted = 0;

  for (const { project_id } of projects) {
    const prod = await one(
      `SELECT * FROM container WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`, [project_id]);
    if (!prod) continue;                                  // no ruler → nothing to measure against

    const realProd = resolveRealDbContainer(prod.docker_ctx, prod.name);
    const got = await fingerprint(prod.docker_ctx, realProd);
    if (got.error) {                                      // the RULER is unreadable — measure nothing
      logline('proddiff', `prod db ${prod.name} unreadable, skipping drift check — ${got.error}`);
      continue;
    }

    // Every db EXCEPT prod itself. A container mid-restore is skipped: it is half a database by
    // definition and would report enormous, meaningless drift.
    const targets = await q(
      `SELECT * FROM container
        WHERE project_id=$1 AND role='db' AND id<>$2 AND busy_op IS DISTINCT FROM 'restore'
              AND restoring_since IS NULL`,
      [project_id, prod.id]);

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      const out = await Promise.all(batch.map((c) =>
        diffContainer(c, got.fp).catch((e) => ({ ok: false, error: e.message, total: null }))));
      checked += out.length;
      drifted += out.filter((p) => p.ok && p.total > 0).length;
    }
  }
  return { checked, drifted };
}

export function startProdDiff() {
  if (process.env.PRODDIFF_ENABLED === 'false') {
    console.log('[queenzee] prod schema-drift check DISABLED (PRODDIFF_ENABLED=false)');
    return null;
  }
  // Slow by design: schema does not change by the second, and each tick is 3 catalog queries per
  // db container over the network to two NASes. Default 10 min.
  const interval = Number(process.env.PRODDIFF_INTERVAL_MS) || 600000;
  console.log(`[queenzee] prod schema-drift check started (${interval}ms)`);
  const tick = () => prodDiffTick().catch((e) => console.error('[proddiff]', e.message));
  setTimeout(tick, 15000);        // let the API settle before hitting docker on two contexts
  return setInterval(tick, interval);
}
