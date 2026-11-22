// MESH ROUTE SOURCE TELEMETRY — the router's counter (lib/mesh-route-telemetry.js + migration 254)
// and its MANAGER-only read (`zee routes --tally` → GET /api/xell/self/routes/tally; migration 258
// documents it). docs/netbird-mesh-plan.md §3.4, §6 phase 5, §10 follow-up 3.
//
// Phase 5 (stop publishing per-xell ports, delete the allocator) is gated on router `source`
// telemetry showing no `legacy-port` consumers — so this test covers the two halves that keep that
// gate honest: the CLASSIFICATION (pure: payload in, rows out) and the COUNTER (`mesh_route_stat`
// bumped and read back against a real meta-DB), plus static wiring for the two call sites.
//
// It writes counter rows and RESTORES exactly the rows it touched (delta, not a table wipe), so a
// run neither invents legacy-port traffic in the real tally nor disturbs another writer's rows.
//
// RUN:  DATABASE_URL=… node test/mesh-route-telemetry.test.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeSources, tallyFromRows, recordRouteSources, meshRouteTally, SOURCES }
  from '../server/src/lib/mesh-route-telemetry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const LEGACY = { routes: { db: { source: 'legacy-port' }, server: { source: 'legacy-port' },
                           webapp: { source: 'legacy-port' } } };
const MIXED = { routes: { db: { source: 'legacy-port' }, server: { source: 'mesh' },
                          webapp: { source: 'mesh' } } };

// ── 1. the classification is PURE: payload in, rows out ────────────────────────────────────────
section('routeSources — pure classification of a finished answer');
ok(JSON.stringify(routeSources(LEGACY)) === JSON.stringify([
  { target_kind: 'db', source: 'legacy-port' }, { target_kind: 'server', source: 'legacy-port' },
  { target_kind: 'webapp', source: 'legacy-port' }]), 'all-legacy answer → one row per target kind');
ok(JSON.stringify(routeSources(MIXED)) === JSON.stringify([
  { target_kind: 'db', source: 'legacy-port' }, { target_kind: 'server', source: 'mesh' },
  { target_kind: 'webapp', source: 'mesh' }]), 'a dual-stack answer records each kind separately');
ok(routeSources({ routes: { db: { source: 'legacy-port' } } }).length === 1,
   'a role with no container has no answer and records no row');
ok(routeSources({ routes: { server: { source: 'made-up' } } }).length === 0,
   'an unrecognized source is skipped, never counted into a bucket nobody reads');
ok(routeSources(null).length === 0 && routeSources({}).length === 0, 'nothing to classify → no rows');
{
  const before = JSON.stringify(MIXED);
  routeSources(MIXED);
  ok(JSON.stringify(MIXED) === before, 'classification never mutates the answer it describes');
}

// ── 2. the arithmetic is PURE too ─────────────────────────────────────────────────────────────
section('tallyFromRows — the per-day sums, no db');
const rows = [
  { day: '2026-09-12', target_kind: 'server', source: 'mesh', n: '3' },
  { day: '2026-09-12', target_kind: 'server', source: 'legacy-port', n: '2' },
  { day: '2026-09-11', target_kind: 'db', source: 'legacy-port', n: 4 },
];
const t = tallyFromRows(rows);
ok(t.by_source.mesh === 3 && t.by_source['legacy-port'] === 6,
   'by_source totals both worlds under the contract\'s own names');
ok(t.by_kind.server.mesh === 3 && t.by_kind.server['legacy-port'] === 2
   && t.by_kind.db['legacy-port'] === 4 && t.by_kind.webapp.mesh === 0,
   'by_kind keeps the kind×source matrix (absent buckets read 0, not missing)');
ok(t.days[0].n === 3 && typeof t.days[0].n === 'number', 'bigint-as-string from pg lands as a number');
ok(tallyFromRows([]).by_source.mesh === 0 && tallyFromRows([]).by_source['legacy-port'] === 0
   && tallyFromRows(null).days.length === 0, 'an empty window is zeros, never a missing section');
ok(tallyFromRows([{ day: 'd', target_kind: 'nope', source: 'mesh', n: 9 }]).by_source.mesh === 0,
   'a kind outside the contract is ignored (the CHECK constraint is the outer wall)');
ok(SOURCES.length === 2 && SOURCES[1] === 'legacy-port', 'the source vocabulary is exactly §3.4\'s');

// ── 3. static wiring: the two call sites and the migration ─────────────────────────────────────
section('wiring (static) — recorder, manager read, migrations');
const self = read('server/src/queenzee/self.js');
ok(/import \{ recordRouteSources, meshRouteTally \} from '\.\.\/lib\/mesh-route-telemetry\.js'/.test(self),
   'self.js imports the recorder and the tally');
ok(/const payload = deriveXellRoutes\(\{[\s\S]{0,2500}?await recordRouteSources\(payload\)[\s\S]{0,200}?return payload;/.test(self),
   'selfRoutes records the answer it just derived and returns it unchanged');
ok(/export async function selfRouteTally\(xell[\s\S]{0,200}?requireManager\(xell, 'routes --tally'\)/.test(self),
   'selfRouteTally is MANAGER-only — the tally is fleet-wide');
const api = read('server/src/api/routes.js');
ok(/router\.get\('\/xell\/self\/routes\/tally'[\s\S]{0,300}?selfRouteTally\(x/.test(api),
   'the tally is mounted on a route of its own, over GET');
// The seam is NOT `zee ops`: TKT-42 pins that digest against growth
// (test/delivery-telemetry.test.mjs), so the read had to land somewhere else.
const ops = read('server/src/lib/ops-review.js');
ok(!/meshRouteTally|mesh_routes/.test(ops),
   '`zee ops` is untouched — TKT-42: that digest must not grow');
const cli = read('scripts/zee');
ok(/rest\.includes\('--tally'\)[\s\S]{0,400}?\/api\/xell\/self\/routes\/tally/.test(cli),
   'the CLI routes `zee routes --tally` at the manager endpoint');
const mig = read('db/migrations/254_mesh_route_source_telemetry.sql');
ok(/CREATE TABLE IF NOT EXISTS mesh_route_stat/.test(mig), 'migration 254 creates mesh_route_stat');
ok(/PRIMARY KEY \(day, target_kind, source\)/.test(mig),
   'the counter is keyed per (day, kind, source) — what the UPSERT increments');
ok(/CHECK \(source IN \('mesh','legacy-port'\)\)/.test(mig)
   && /CHECK \(target_kind IN \('db','server','webapp'\)\)/.test(mig),
   'and the two vocabularies are constrained in the schema, not only in JS');
// House rule 8: the CLI advertises the flag, so the manual that governs it must brief it — and the
// audience is the MANAGER, because the tally is fleet-wide. Guarded append, exactly once.
const doc = read('db/migrations/258_manager_manual_zee_routes_tally.sql');
ok(/harness_memory_put\('manager', 'memory\/manager-zee-manual\.md'/.test(doc)
   && /LIKE '%zee routes --tally%'/.test(doc),
   'migration 258 documents `zee routes --tally` in the manager manual, guarded against a re-run');
ok(/--tally/.test(cli) && /--tally/.test(read('db/migrations/258_manager_manual_zee_routes_tally.sql')),
   'usage text and manual agree that the flag exists');

// ── 4. the counter, against a real meta-DB ─────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('\nDATABASE_URL required for the counter half (mesh_route_stat lives in the meta-DB)');
  process.exit(2);
}
const { q, pool } = await import('../server/src/db/pool.js');
const key = (r) => `${r.day}|${r.target_kind}|${r.source}`;
const snapshots = new Map();
let restored = false;
async function snapshot() {
  const all = await q(`SELECT day::text AS day, target_kind, source, n::int AS n, last_at::text AS last_at
                         FROM mesh_route_stat`);
  for (const r of all) snapshots.set(key(r), r);
  return all;
}
// Restore ONLY the rows this run touched: put back the old n/last_at where the key existed, drop
// the row where it did not. A whole-table wipe would race every other writer of the real tally.
async function restore() {
  if (restored) return; restored = true;
  const now = await q(`SELECT day::text AS day, target_kind, source FROM mesh_route_stat`);
  for (const r of now) {
    const before = snapshots.get(key(r));
    if (before) {
      await q(`UPDATE mesh_route_stat SET n=$4, last_at=$5::timestamptz
                WHERE day=$1::date AND target_kind=$2 AND source=$3`,
        [r.day, r.target_kind, r.source, before.n, before.last_at]);
    } else {
      await q(`DELETE FROM mesh_route_stat WHERE day=$1::date AND target_kind=$2 AND source=$3`,
        [r.day, r.target_kind, r.source]);
    }
  }
}
try {
  let exists;
  try { exists = await q(`SELECT to_regclass('mesh_route_stat') AS t`); }
  catch (e) {
    console.error(`\ncould not reach the meta-DB (${e.message}) — this half needs one with db:migrate applied`);
    process.exit(2);
  }
  ok(exists[0]?.t === 'mesh_route_stat',
     'mesh_route_stat is in the schema (if this fails your db is behind the ledger — npm run db:migrate)');
  if (exists[0]?.t !== 'mesh_route_stat') {
    console.log('\n  → this database is BEHIND the migration ledger (254 is not applied). Run:  npm run db:migrate');
    throw new Error('mesh_route_stat is not in this database');
  }

  await snapshot();
  const bump = (kind, source) => {
    const k = `${new Date().toISOString().slice(0, 10)}|${kind}|${source}`;
    return (snapshots.get(k)?.n || 0) + 0;   // today's pre-run count for that bucket
  };
  const n0 = { serverLegacy: bump('server', 'legacy-port'), serverMesh: bump('server', 'mesh'),
               dbLegacy: bump('db', 'legacy-port'), webappMesh: bump('webapp', 'mesh') };

  section('recordRouteSources — one bump per answered role, per day');
  ok(await recordRouteSources(LEGACY) === 3, 'an all-legacy answer records its three roles');
  ok(await recordRouteSources(MIXED) === 3, 'a dual-stack answer records all three too');
  ok(await recordRouteSources({ routes: { server: { source: 'nonsense' } } }) === 0,
     'nothing recognizable writes nothing');
  ok(await recordRouteSources({ routes: { server: { source: 'mesh' } } }) === 1,
     'and a single-role answer writes one row');

  section('meshRouteTally — the per-day tally, read back');
  const tally = await meshRouteTally({ days: 1 });
  ok(tally.error === null, `the read answers without error (${tally.error || 'ok'})`);
  ok(tally.window_days === 1, 'window_days is echoed');
  // This run made 4 legacy bumps (LEGACY's three roles + MIXED's db) and 3 mesh ones (MIXED's
  // server/webapp + the single-role answer) — asserted as DELTAS against whatever the day already
  // held, so an existing real tally is measured, never invented and never overwritten by the test.
  const today = new Date().toISOString().slice(0, 10);
  const heldToday = (source) => [...snapshots.values()]
    .filter((r) => r.day === today && r.source === source).reduce((a, r) => a + r.n, 0);
  ok(tally.by_source['legacy-port'] === heldToday('legacy-port') + 4,
     `legacy-port total rose by exactly the 4 legacy bumps this run made `
     + `(${tally.by_source['legacy-port']} vs ${heldToday('legacy-port')} before)`);
  ok(tally.by_source.mesh === heldToday('mesh') + 3,
     `mesh total rose by exactly the 3 mesh bumps `
     + `(${tally.by_source.mesh} vs ${heldToday('mesh')} before)`);
  ok(tally.by_kind.server['legacy-port'] === n0.serverLegacy + 1
     && tally.by_kind.webapp.mesh === n0.webappMesh + 1,
     'the kind×source matrix moved in the buckets the answers named');
  const todayRows = tally.days.filter((r) => r.day === today);
  ok(todayRows.length > 0 && todayRows.every((r) => r.source in tally.by_source),
     `the day bucket is the UTC date (${today}) and only known sources appear`);

  section('the window bounds the tally — and never widens it');
  const oldDay = await q(`INSERT INTO mesh_route_stat (day, target_kind, source, n, first_at, last_at)
                          VALUES ((now() AT TIME ZONE 'UTC')::date - 30, 'webapp', 'mesh', 7, now(), now())
                          ON CONFLICT (day, target_kind, source) DO UPDATE SET n = 999
                          RETURNING day::text AS day`);
  const narrow = await meshRouteTally({ days: 1 });
  ok(!narrow.days.some((r) => r.day === oldDay[0].day), 'a 30-day-old row is outside a 1-day window');
  ok(narrow.by_kind.webapp.mesh < 999, 'and it is excluded from the sums, not silently added');
  const clamped = await meshRouteTally({ days: 99999 });
  ok(clamped.window_days === 90 && clamped.error === null,
     `an absurd window clamps at 90 days (got ${clamped.window_days})`);
  const zero = await meshRouteTally({ days: 0 });
  ok(zero.window_days === 14, 'a zero/absent window falls back to the default, never to "everything"');
} finally {
  await restore().catch((e) => console.error(`  ! could not restore mesh_route_stat (${e.message})`));
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
