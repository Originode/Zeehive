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
import { resolveRealDbContainer, resolveRealDbContainerCached } from '../lib/xell-db.js';
import { cloneInstanceFor, setInstanceProdDiff, syncDbInstances } from '../lib/db-instances.js';
import { dbIdentity } from '../lib/projects.js';

const SAMPLE = 8;          // per kind, per direction — this feeds a tooltip, not an audit
const CONCURRENCY = 3;     // db containers probed at once; the NAS is not a datacentre

// Schemas that are pure ENGINE noise, never application schema. postgis/h3 builds differ between
// hosts even at the same image tag: the NAS build of omnibiz-postgis:18-3.6-h3 pre-installs
// postgis_topology + postgis_tiger_geocoder (bringing tiger/tiger_data/topology, ~39 tables) and
// prod's build does not. Comparing those reports hundreds of phantom differences that no human can
// act on. The application lives everywhere else.
const NOISE_SCHEMAS = ["'pg_catalog'", "'information_schema'", "'tiger'", "'tiger_data'",
                       "'topology'", "'ogr_system_tables'"].join(',');

// Extension-owned objects are engine noise, implied by the extension set and not by anyone's
// migration. pg_depend deptype='e' marks them. This is NOT only ~1400 functions from postgis: an
// extension also owns TABLES (postgis's public.spatial_ref_sys, ~8k rows of SRIDs; h3's lookup
// tables; tiger's), their COLUMNS, and any TRIGGERS it installs. The catalog probes below deliberately
// never compared functions, so those were already out — but the table/column/trigger probes filtered
// by SCHEMA NAME ALONE, so an extension table sitting in a real application schema (public.spatial_ref_sys
// is the classic one) slipped straight through and was scored as drift. The prod postgis build and the
// dev/NAS build install their extensions differently (the NAS image pre-loads postgis_topology + the
// tiger geocoder; a "18-3.6-h3" build carries h3 tables prod's does not), so those extension tables
// legitimately differ host-to-host and produced PHANTOM "missing"/"extra" every tick — including on a
// database freshly and faithfully restored from a prod dump, where an operator rightly expects ZERO
// drift. `NOT_EXT_*` below re-applies the deptype='e' rule the comment above always claimed, this time
// to relations and triggers as well, so only what a MIGRATION owns is measured.
//
// zeehive_migrations is the ship's own ledger (shipmigrate.js) — it lives ONLY in prod, by
// design, so comparing it is comparing the ruler's serial number instead of what it measures.
// Unexcluded, the migration system's own bookkeeping tripped the parity gate it exists to serve,
// for every xell, forever: a chicken-and-egg a zee correctly diagnosed from the outside on day one.
const LEDGER_TABLE = `'zeehive_migrations'`;

// Anti-join to pg_depend: TRUE when the relation (schema.name) is NOT a member of any extension.
// Correlates to information_schema's table_schema/table_name text columns. classid pins the
// dependent object to pg_class so we only ever match relations, never a same-named object of
// another catalog. This is the exact marker CREATE EXTENSION leaves and pg_dump reads to decide an
// object is the extension's to recreate — never the app's to migrate.
const NOT_EXT_REL = `NOT EXISTS (
    SELECT 1 FROM pg_depend d
      JOIN pg_class ec ON ec.oid = d.objid
      JOIN pg_namespace en ON en.oid = ec.relnamespace
     WHERE d.classid = 'pg_class'::regclass AND d.deptype = 'e'
       AND en.nspname = table_schema AND ec.relname = table_name)`;
export const Q = {
  table: `SELECT table_schema||'.'||table_name FROM information_schema.tables
           WHERE table_schema NOT IN (${NOISE_SCHEMAS}) AND table_type='BASE TABLE'
             AND table_name <> ${LEDGER_TABLE} AND ${NOT_EXT_REL}`,
  column: `SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type
             FROM information_schema.columns WHERE table_schema NOT IN (${NOISE_SCHEMAS})
             AND table_name <> ${LEDGER_TABLE} AND ${NOT_EXT_REL}`,
  // Exclude a trigger when EITHER its table is extension-owned OR the trigger itself is (an
  // extension can install triggers on an app table). Same deptype='e' rule, keyed on the two oids
  // already in scope here (c = the table, t = the trigger).
  trigger: `SELECT n.nspname||'.'||c.relname||'.'||t.tgname
              FROM pg_trigger t
              JOIN pg_class c ON c.oid=t.tgrelid
              JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE NOT t.tgisinternal AND n.nspname NOT IN (${NOISE_SCHEMAS})
               AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.deptype='e'
                    AND ((d.classid='pg_class'::regclass   AND d.objid=c.oid)
                      OR (d.classid='pg_trigger'::regclass AND d.objid=t.oid)))`,
};

// Non-blocking docker exec → stdout. Never rejects: resolves {ok,out} so one unreachable container
// cannot take the tick down. spawn (not spawnSync) — this loop must not freeze the event loop, the
// same reason maintenance.js spawns.
function dockerPsql(ctx, container, sql, dbid, timeout = 30000) {
  return new Promise((resolve) => {
    let out = '', err = '', child;
    const args = ['--context', ctx, 'exec', '-i', container,
      'psql', '-U', dbid.user, '-d', dbid.name,
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
async function fingerprint(ctx, container, dbid) {
  const fp = {};
  for (const [kind, sql] of Object.entries(Q)) {
    const r = await dockerPsql(ctx, container, sql, dbid);
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

// Pure comparison of two fingerprints → the persisted payload shape.
function diffPayload(prodFp, fp) {
  const kinds = {};
  let total = 0;
  for (const kind of Object.keys(Q)) {
    const { missing, extra } = diffSets(prodFp[kind], fp[kind]);
    total += missing.length + extra.length;
    kinds[kind] = {
      missing_count: missing.length, extra_count: extra.length,
      missing: missing.slice(0, SAMPLE), extra: extra.slice(0, SAMPLE),
    };
  }
  return { ok: true, error: null, total, kinds };
}

// Compare one db container against a prod fingerprint and persist the verdict.
async function diffContainer(c, prodFp, dbid) {
  let real;
  try { real = await resolveRealDbContainer(c.docker_ctx, c.name, { row: c }); }
  catch (e) { real = null; }
  const got = real ? await fingerprint(c.docker_ctx, real, dbid)
                    : { error: `could not resolve the real container for ${c.name}` };

  const payload = got.error
    ? { ok: false, error: got.error, total: null, kinds: null }
    : diffPayload(prodFp, got.fp);

  const prev = c.prod_diff?.total;
  const row = await one(
    `UPDATE container SET prod_diff=$2::jsonb, prod_diff_at=now() WHERE id=$1 RETURNING *`,
    [c.id, JSON.stringify(payload)]);
  if (row) broadcast('container', row);
  // container.prod_diff has always described the container's PRIMARY database — now that
  // instances are first-class, mirror the verdict onto that row so the two never disagree.
  await q(
    `UPDATE db_instance SET prod_diff=$2::jsonb, prod_diff_at=now()
      WHERE container_id=$1 AND kind='primary'`, [c.id, JSON.stringify(payload)]);

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

  const dbid = await dbIdentity(projectId);
  let realProd;
  try { realProd = await resolveRealDbContainer(prod.docker_ctx, prod.name, { row: prod }); }
  catch (e) { return { ok: false, error: e.message, total: null }; }
  const got = await fingerprint(prod.docker_ctx, realProd, dbid);
  if (got.error) return { ok: false, error: `prod db unreadable: ${got.error}`, total: null };

  // db-clone: the xell's database is its OWN instance inside the shared dev container. Measure
  // THAT catalog and persist onto ITS db_instance row — never the container row, whose prod_diff
  // chip describes the shared primary database, not any one xell's clone.
  const xell = await one(`SELECT db_coupling FROM xell WHERE id=$1`, [xellId]);
  if (xell?.db_coupling === 'db-clone') {
    const inst = await cloneInstanceFor(xellId);
    if (!inst) return { ok: false, error: 'db-clone coupling but no clone database on record — re-attach it', total: null };
    let realMine;
    try { realMine = await resolveRealDbContainer(mine.docker_ctx, mine.name, { row: mine }); }
    catch (e) { return { ok: false, error: e.message, total: null }; }
    const own = await fingerprint(mine.docker_ctx, realMine, { ...dbid, name: inst.name });
    if (own.error) {
      const payload = { ok: false, error: own.error, total: null, kinds: null };
      await setInstanceProdDiff(inst.id, payload);
      return { ok: false, error: `clone db ${inst.name} unreadable: ${own.error}`, total: null };
    }
    const payload = diffPayload(got.fp, own.fp);
    await setInstanceProdDiff(inst.id, payload);
    return { ...payload, database: inst.name };
  }

  return diffContainer(mine, got.fp, dbid);
}

// On-demand diff of ONE db container against prod — what the chip's "Check diff" context-menu item
// fires, and what a finished restore calls to refresh its own verdict. Measures NOW and persists the
// same payload shape the tick records (diffContainer broadcasts, so the chip repaints live). This
// judges the container's PRIMARY database — exactly what its prod_diff chip describes.
export async function diffOneContainerAgainstProd(containerId) {
  const c = await one(`SELECT * FROM container WHERE id=$1 AND role='db'`, [containerId]);
  if (!c) return { ok: false, error: 'no such db container', total: null };
  // Prod is the ruler: it is measured against nothing and keeps prod_diff NULL.
  if (c.tier === 'prod') return { ok: true, same_db: true, total: 0, kinds: null };

  const prod = await one(
    `SELECT * FROM container WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`, [c.project_id]);
  if (!prod) return { ok: false, error: 'no prod db container to measure against', total: null };
  if (prod.id === c.id) return { ok: true, same_db: true, total: 0, kinds: null };

  const dbid = await dbIdentity(c.project_id);
  let realProd;
  try { realProd = await resolveRealDbContainer(prod.docker_ctx, prod.name, { row: prod }); }
  catch (e) { return { ok: false, error: e.message, total: null }; }
  const got = await fingerprint(prod.docker_ctx, realProd, dbid);
  if (got.error) return { ok: false, error: `prod db unreadable: ${got.error}`, total: null };

  return diffContainer(c, got.fp, dbid);
}

// A restore loads a NEW catalog into a db container, so its prod_diff chip is instantly stale — it
// still describes the pre-restore schema. The 10-minute tick would eventually correct it (and while
// the restore ran it deliberately SKIPPED this container), but until then the chip lies. Called off
// the restore's completion — after busy is cleared, so the tick's skip no longer applies — this
// re-measures the affected database(s) at once, so the drift colour is truthful the moment the
// spinner stops. Restoring PROD is special: prod is the ruler, so a new prod catalog re-bases every
// other db's verdict — re-run the whole tick rather than just this one container.
export async function refreshProdDiffAfterRestore(containerId) {
  const c = await one(`SELECT id, name, tier FROM container WHERE id=$1 AND role='db'`, [containerId]);
  if (!c) return { ok: false, error: 'no such db container' };
  if (c.tier === 'prod') {
    logline('proddiff', `prod db ${c.name} was restored — re-checking drift for every db against the new prod`);
    return prodDiffTick();
  }
  logline('proddiff', `${c.name} was restored — re-checking its schema drift against prod`);
  return diffOneContainerAgainstProd(containerId);
}

export async function prodDiffTick() {
  const projects = await q(`SELECT DISTINCT project_id FROM container WHERE role='db'`);
  let checked = 0, drifted = 0;

  for (const { project_id } of projects) {
    const prod = await one(
      `SELECT * FROM container WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`, [project_id]);
    if (!prod) continue;                                  // no ruler → nothing to measure against

    const dbid = await dbIdentity(project_id);
    let realProd;
    try { realProd = await resolveRealDbContainer(prod.docker_ctx, prod.name, { row: prod }); }
    catch (e) { logline('proddiff', `prod db ${prod.name} unresolvable, skipping drift check — ${e.message}`); continue; }
    const got = await fingerprint(prod.docker_ctx, realProd, dbid);
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
        diffContainer(c, got.fp, dbid).catch((e) => ({ ok: false, error: e.message, total: null }))));
      checked += out.length;
      drifted += out.filter((p) => p.ok && p.total > 0).length;
    }

    // INSTANCES: keep db_instance in line with what pg_database actually reports (discovery —
    // this is what surfaces orphaned clones), then measure each CLONE's catalog against prod.
    // The container pass above already covered every PRIMARY; templates are build artifacts of
    // the dev db and deliberately not measured.
    for (const c of [prod, ...targets]) {
      const real = resolveRealDbContainerCached(c.docker_ctx, c.name);
      const s = await syncDbInstances(c, real, dbid).catch((e) => ({ ok: false, error: e.message }));
      if (!s.ok || c.id === prod.id) continue;     // prod is the ruler — nothing in it is measured
      const clones = await q(`SELECT * FROM db_instance WHERE container_id=$1 AND kind='clone'`, [c.id]);
      for (const inst of clones) {
        const own = await fingerprint(c.docker_ctx, real, { ...dbid, name: inst.name });
        const payload = own.error
          ? { ok: false, error: own.error, total: null, kinds: null }
          : diffPayload(got.fp, own.fp);
        await setInstanceProdDiff(inst.id, payload);
        checked++;
        if (payload.ok && payload.total > 0) drifted++;
      }
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
