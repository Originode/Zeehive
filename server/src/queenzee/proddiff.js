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
// WHAT THIS NUMBER IS NOT — TKT-22-4F0E ("any restore on a dev db from latest prod dump always has
// a big diff from prod db … and im afraid the data might not be fully backed up"). Two questions got
// merged into one chip, and this file can only answer the first:
//   • It compares CATALOG SHAPE ONLY — tables, columns, triggers. It never counts a row, never reads
//     a value, and never opens a dump. So a green 0 is NOT evidence that production's DATA is backed
//     up, and a red 12802 is NOT evidence that any data was lost. Whoever renders this number must
//     say what it covers (`scope`/`data_compared` ride in the payload for exactly that reason), and
//     "is my data there?" needs a row-level comparison — see docs/data-completeness-check.md.
//   • THE RULER IS *LIVE* PROD, BUT A RESTORE IS A POINT-IN-TIME COPY. A db restored from last
//     night's dump is faithful to the dump, not to prod as it is now: every object prod migrated
//     AFTER the dump was taken reads as `missing`. That is real drift in the dangerous direction,
//     correctly reported — and it is why "a fresh restore ALWAYS shows a gap". The cure is a newer
//     dump or a ledger catch-up (`zee db-catchup` / catchup-delta.js), never a suppression here.
//     Measured 2026-07-29 on the live fleet: six Zeehive pool dbs against ONE prod read 0, 1, 1, 13,
//     13 and 4 — and every object in them was a named migration object (`public.project_doc` and its
//     columns, `project_doc.targets`), one and two migrations' worth, missing-only. The 4 was the
//     mirror image: a xell AHEAD of prod on its own unlanded migration, reported as `extra`. Age and
//     authorship, not noise. Full table in docs/data-completeness-check.md.
//   • An EMPTY database is not a drifted one, and must not be dressed as one: 'missing everything,
//     extra nothing' means nothing was ever restored here (or the restore failed). `empty_db` says
//     so, because the alternative is a chip that reads "your restore lost 12,802 objects".
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
// An ON-DEMAND comparison is read by a human who is TRIAGING ("why is this db drifted at all?"),
// not glancing at a chip. 8 names per direction is uselessly short for that — you cannot see that
// every missing object sits in one schema from a sample of 8. This bigger sample is returned to the
// caller only; what gets PERSISTED onto the chip stays SAMPLE-sized (it rides every SSE frame).
const DETAIL_SAMPLE = 60;
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

// The SCOPE every payload declares, so no surface can imply more than was measured. Carried as DATA
// (not left to each renderer's prose) because the console, the /ooney gate and the CLI all read this
// same jsonb, and a caveat that lives in only one of them is a caveat the human never sees.
export const DIFF_SCOPE = 'schema';                            // what it measures
export const DIFF_COVERS = ['table', 'column', 'trigger'];     // and exactly which catalog kinds
export const DIFF_NOT_COVERED = 'row data (no rows are counted or compared — this is not a backup or data-completeness check)';

// Every fingerprint entry starts `schema.object…`, so the schema is everything before the first dot.
const schemaOf = (name) => String(name).split('.')[0] || '?';

// WHERE the differences are, by schema — the one line that usually answers "why is a freshly
// restored db still drifted?". A sample of names cannot show you that all 400 missing objects live
// in ONE schema (an extension's, a schema the dump never captured, a dead one nothing dropped);
// counts per schema can, in a glance, and they are exact rather than sampled. Returned to the
// caller only — never persisted onto the chip, which must stay small enough to ride every SSE frame.
function bySchema(diffs) {
  const acc = new Map();
  for (const { missing, extra } of diffs) {
    for (const x of missing) {
      const s = acc.get(schemaOf(x)) || { schema: schemaOf(x), missing: 0, extra: 0 };
      s.missing++; acc.set(s.schema, s);
    }
    for (const x of extra) {
      const s = acc.get(schemaOf(x)) || { schema: schemaOf(x), missing: 0, extra: 0 };
      s.extra++; acc.set(s.schema, s);
    }
  }
  return [...acc.values()]
    .sort((a, b) => (b.missing + b.extra) - (a.missing + a.extra) || a.schema.localeCompare(b.schema));
}

// Pure comparison of two fingerprints → the persisted payload shape. `refFp` is the RULER (prod, or
// whatever db the caller chose to measure against); `fp` is the db being judged. `sample` caps the
// name lists per kind per direction — SAMPLE for anything persisted, DETAIL_SAMPLE for a human
// triaging on demand. `by_schema` only rides the bigger (detail) payloads.
//
// `ref_count`/`mine_count` per kind are the cheap orientation the bare total never gave: "the
// reference has 627 tables, this db has 0" is a different fact from "627 differences", and it is the
// difference between a failed restore and a merely older one (TKT-22-4F0E).
//
// Exported for the tests: it is the one piece of drift logic that needs no docker daemon, so the
// direction of "missing"/"extra", the truncation and the schema rollup can all be pinned here.
export function diffPayload(refFp, fp, sample = SAMPLE) {
  const kinds = {};
  const all = [];
  let total = 0;
  for (const kind of Object.keys(Q)) {
    const { missing, extra } = diffSets(refFp[kind], fp[kind]);
    total += missing.length + extra.length;
    all.push({ missing, extra });
    kinds[kind] = {
      ref_count: refFp[kind].size, mine_count: fp[kind].size,
      missing_count: missing.length, extra_count: extra.length,
      missing: missing.slice(0, sample), extra: extra.slice(0, sample),
    };
  }
  // EMPTY, not drifted: this db has no application tables at all while the reference has some.
  // Reporting that as "N differences" is how a never-restored dev clone came to look like a
  // catastrophic data loss (TKT-22-4F0E — omnibiz_db_prod_dev_local_mardale_prod: 627 tables in prod,
  // 0 here, nothing extra. An empty database, not a drifted one).
  const empty_db = fp.table.size === 0 && refFp.table.size > 0;
  const payload = {
    ok: true, error: null, total,
    scope: DIFF_SCOPE, covers: DIFF_COVERS, data_compared: false, not_covered: DIFF_NOT_COVERED,
    empty_db, kinds,
  };
  if (sample !== SAMPLE) payload.by_schema = bySchema(all);
  return payload;
}

// Read ONE container's catalog fingerprint: resolve its real (versioned) container name, then probe.
// `dbName` overrides the database probed inside it (a CLONE instance rather than the primary).
async function measureContainer(c, dbid, dbName = null) {
  let real;
  try { real = await resolveRealDbContainer(c.docker_ctx, c.name, { row: c }); }
  catch (e) { real = null; }
  if (!real) return { error: `could not resolve the real container for ${c.name}` };
  return fingerprint(c.docker_ctx, real, dbName ? { ...dbid, name: dbName } : dbid);
}

// Compare one db container against a prod fingerprint and persist the verdict.
async function diffContainer(c, prodFp, dbid) {
  const got = await measureContainer(c, dbid);
  const payload = got.error
    ? { ok: false, error: got.error, total: null, kinds: null }
    : diffPayload(prodFp, got.fp);
  return persistVerdict(c, payload);
}

// Write ONE container's drift verdict: the container row (the chip), its primary db_instance row,
// and a log line only when the verdict CHANGED. Split out of diffContainer so an ad-hoc comparison
// against a NON-prod database can reuse the measurement without writing a prod_diff that would be
// a lie (prod_diff means "drift from production", nothing else).
async function persistVerdict(c, payload) {
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
      ? `${c.name} matches prod's SCHEMA (tables, columns, triggers — no rows compared)`
      : payload.empty_db
        // Not drift. Say the thing that is actually true, or the operator debugs a diff that isn't one.
        ? `${c.name} has NO application tables at all (prod has ${payload.kinds.table.ref_count}) — this `
          + 'database was never restored, or its restore failed. That is not schema drift.'
        : `${c.name} has DRIFTED from prod: ${payload.total} SCHEMA difference(s) — `
          + Object.entries(payload.kinds)
              .filter(([, v]) => v.missing_count + v.extra_count)
              .map(([k, v]) => `${k} -${v.missing_count}/+${v.extra_count}`).join(', ')
          + '. Schema+triggers only; nothing here is a statement about row data. A restore is a '
          + 'point-in-time copy, so objects prod migrated after its dump read as missing.');
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

// The db containers this one can be MEASURED AGAINST — what the chip's "Check diff" submenu lists.
// Every other db container in the same project, PRODUCTION FIRST (it is the default reference and
// the only one whose verdict is a fact about drift-from-prod), then by tier and name. `is_prod` and
// `writes_chip` say, per candidate, what picking it means: only prod repaints the drift mark.
export async function diffCandidates(containerId) {
  const c = await one(`SELECT * FROM container WHERE id=$1 AND role='db'`, [containerId]);
  if (!c) return { ok: false, error: 'no such db container', candidates: [] };
  // The same columns a chip renders from (fleet.js's inventory shape), so the picker can draw the
  // REAL ContainerChip for each candidate instead of a second, drifting rendering of a container.
  const rows = await q(
    `SELECT c.id, c.role, c.name, c.tier, c.isolation, c.docker_ctx, c.health,
            c.host, c.host_port, c.conn_ref,
            c.busy_since, c.busy_op, c.prod_diff, c.prod_diff_at,
            (SELECT ox.slug FROM xell ox WHERE ox.id = c.owner_xell_id) AS owner_slug
       FROM container c
      WHERE c.project_id=$1 AND c.role='db' AND c.id<>$2
      ORDER BY (c.tier='prod') DESC, c.tier, c.name`, [c.project_id, c.id]);
  return {
    ok: true,
    container: { id: c.id, name: c.name, tier: c.tier },
    candidates: rows.map((r) => ({ ...r, is_prod: r.tier === 'prod', writes_chip: r.tier === 'prod' })),
  };
}

// On-demand diff of ONE db container against a REFERENCE database — what the chip's "Check diff"
// context-menu item fires, and what a finished restore calls to refresh its own verdict. Measures
// NOW and returns the payload the tick records, plus the triage extras a human asked for it needs
// (a DETAIL_SAMPLE-long name list and the by_schema rollup). This judges the container's PRIMARY
// database — exactly what its prod_diff chip describes.
//
// `againstId` = null → PRODUCTION, the default and the only reference the chip's colour may come
// from: prod_diff means "drift from production", so a comparison against any OTHER db is REPORTED
// and never PERSISTED. That is the whole point of the picker — "is this db drifted, or is EVERY db
// drifted the same way?" is answered by measuring dev against dev, and answering it must not
// overwrite the one verdict the fleet's drift colours are built on.
export async function diffOneContainerAgainstProd(containerId, againstId = null) {
  const c = await one(`SELECT * FROM container WHERE id=$1 AND role='db'`, [containerId]);
  if (!c) return { ok: false, error: 'no such db container', total: null };

  const ref = againstId
    ? await one(`SELECT * FROM container WHERE id=$1 AND role='db'`, [againstId])
    : await one(`SELECT * FROM container WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`,
                [c.project_id]);
  if (!ref) {
    return againstId
      ? { ok: false, error: 'no such reference db container', total: null }
      : { ok: false, error: 'no prod db container to measure against', total: null };
  }
  if (ref.project_id !== c.project_id) {
    return { ok: false, error: 'the reference db belongs to another project', total: null };
  }
  const reference = { id: ref.id, name: ref.name, tier: ref.tier, is_prod: ref.tier === 'prod' };

  // Prod is the ruler: by DEFAULT it is measured against nothing and keeps prod_diff NULL. An
  // EXPLICIT reference is a human asking a different question ("what does prod lack that this dev
  // db has?"), which is answered — but still never written to prod's own chip (see persist below).
  if (!againstId && c.tier === 'prod') return { ok: true, same_db: true, total: 0, kinds: null, reference };
  if (ref.id === c.id) return { ok: true, same_db: true, total: 0, kinds: null, reference };

  const dbid = await dbIdentity(c.project_id);
  const refFp = await measureContainer(ref, dbid);
  if (refFp.error) {
    return { ok: false, total: null, reference,
             error: `${reference.is_prod ? 'prod db' : `reference db ${ref.name}`} unreadable: ${refFp.error}` };
  }

  // Only a comparison against PRODUCTION is a prod_diff verdict, and prod itself never carries one.
  const persist = reference.is_prod && c.tier !== 'prod';
  const own = await measureContainer(c, dbid);
  if (own.error) {
    const payload = { ok: false, error: own.error, total: null, kinds: null };
    if (persist) await persistVerdict(c, payload);
    return { ...payload, reference };
  }
  if (persist) await persistVerdict(c, diffPayload(refFp.fp, own.fp));
  return { ...diffPayload(refFp.fp, own.fp, DETAIL_SAMPLE), reference, persisted: persist };
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
