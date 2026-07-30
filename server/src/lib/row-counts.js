// ROW COUNTS — the data half of "is my production data safe?", kept deliberately apart from the
// schema half (queenzee/proddiff.js). TKT-22-4F0E asked two questions in one breath and the console
// answered both with a schema-drift number, which can answer neither.
//
// Everything here is PURE: the catalog SQL is a string, and the two readings over it (trend between
// backups, and a restore against its source) are functions over plain objects. No docker, no db, no
// React — so the rules can be pinned by tests, and the same words appear wherever a human reads them.
//
// WHY ESTIMATES. reltuples is the planner's row estimate, maintained by ANALYZE/autovacuum. An exact
// count(*) over a 600-table, 1.3 GB production database is minutes of I/O, and the dump is the
// product: instrumentation must never cost the backup anything, must never extend the window prod is
// locked for, and must never be able to fail a backup. Estimates are exactly right for the TREND
// (both sides equally stale) and honest for the comparison provided every surface says "estimate" —
// which is why the tolerance below exists and why a shortfall is only ever reported as "worth
// looking at" unless a populated table arrives EMPTY, which no estimate error can explain.

// Per-table estimates for everything a dump would carry data for.
//
//   relkind='r' only — ordinary tables, which includes a partition (data lives in the leaves; a
//     partitioned PARENT reports 0 and would double-count the total).
//   extension-owned relations excluded (pg_depend deptype='e'): CREATE EXTENSION recreates them, and
//     pg_dump does not carry their data, so counting them would report a shortfall on every restore
//     for rows that were never in the archive. Same rule proddiff uses, same reason.
//   system schemas excluded. Engine noise schemas need no special case — they are extension-owned.
//
// -1 is postgres's own "never analyzed"; it is preserved rather than coerced to 0, because "unknown"
// and "empty" are different answers and one of them is an alarm.
// The third field is HOW FAR THE ESTIMATE HAS DECAYED: n_mod_since_analyze, postgres's own count of
// rows inserted/updated/deleted since anyone last analyzed the table. An estimate is only as good as
// its last ANALYZE, and a table that has changed by more than the tolerance since then cannot support
// a "this is short" claim at all. Without this, a bulk delete before a dump would make a perfectly
// faithful restore look like data loss — the one failure this whole feature cannot afford.
// (Found on a live database: public.project est 8 vs exact 6 = 25% "short", entirely because 32 rows
// had moved since the last analyze.)
export const ROW_COUNT_SQL = `SELECT n.nspname||'.'||c.relname||'\x1e'||c.reltuples::bigint
       ||'\x1e'||coalesce(s.n_mod_since_analyze, 0)::bigint
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
 WHERE c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND n.nspname NOT LIKE 'pg_toast%'
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
 ORDER BY 1`;

// Exact counts, for a RESTORED (dev) database only — the one side where exactness is affordable and
// where it matters, because a fresh restore has no statistics at all (pg_restore does not ANALYZE, so
// every reltuples in it reads -1 and an estimate-vs-estimate comparison would compare nothing).
// Built from the table list the reference recorded, so it asks about exactly what should be there.
export function exactCountSql(tables) {
  const parts = (tables || []).filter((t) => /^[A-Za-z_][\w$]*\.[A-Za-z_][\w$]*$/.test(t))
    .map((t) => {
      const [s, n] = t.split('.');
      return `SELECT '${t}'||'\x1e'||count(*)::text FROM "${s}"."${n}"`;
    });
  return parts.length ? parts.join(' UNION ALL ') : null;
}

// psql -tA output (one `name\x1erows` per line) → { 'schema.table': rows }. Tolerant of blank lines
// and of a name that somehow carries no count (skipped rather than recorded as 0).
export function parseRowCounts(out) {
  const counts = {};
  for (const line of String(out || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    // name \x1e count [\x1e mod_since_analyze] — field 1 only, so the estimate probe (three fields)
    // and the exact-count probe (two) share one parser and neither can poison the other.
    const parts = s.split('\x1e');
    if (parts.length < 2 || !parts[0]) continue;
    const n = Number(parts[1].trim());
    if (!Number.isFinite(n)) continue;
    counts[parts[0]] = n;
  }
  return counts;
}

// The staleness map from the same output: { 'schema.table': rows changed since the last ANALYZE }.
// Absent for the exact-count probe, which has no third field and needs none.
export function parseRowStats(out) {
  const stats = {};
  for (const line of String(out || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const parts = s.split('\x1e');
    if (parts.length < 3 || !parts[0]) continue;
    const n = Number(parts[2].trim());
    if (Number.isFinite(n)) stats[parts[0]] = n;
  }
  return stats;
}

// Can this reference estimate support a "short by N" claim? Only if the table has not moved by more
// than the tolerance since anyone measured it. Conservative on purpose: when the estimate cannot be
// trusted the finding becomes UNKNOWN, never a pass — "could not be judged" is a different sentence
// from "fine", and the report prints it as such.
export function referenceIsStale(refCount, modSinceAnalyze) {
  if (modSinceAnalyze == null) return false;                 // no statistics recorded → assume usable
  const noise = Math.max(SMALL_TABLE, Math.abs(refCount) * SHORTFALL_TOLERANCE);
  return modSinceAnalyze >= noise;
}

// Sum of the KNOWN estimates (-1 = never analyzed is not a row count and is not summed).
export function rowTotal(counts) {
  let t = 0;
  for (const n of Object.values(counts || {})) if (n > 0) t += n;
  return t;
}

// How far a count may sit under its reference before it is worth a human's attention. Two estimates
// of the same table taken a day apart legitimately differ; an exact count compared against an
// estimate legitimately differs. 10% is deliberately loose — the finding this is here to catch is a
// table that lost most or all of its rows, not one that lost 3.
export const SHORTFALL_TOLERANCE = 0.1;
// Below this many rows, a percentage means nothing (3 → 2 is not a 33% data loss event).
const SMALL_TABLE = 20;

// ── reading 1: the TREND between two backups ────────────────────────────────────────────────────
// The alarm nothing in the system could raise before: a table that SHRANK since the last good dump.
// Growth is normal, a new table is normal, and a table that DISAPPEARED is schema drift (proddiff's
// question, not this one) — so those are counted but never dressed as data loss. Only a real drop in
// a table that both dumps carried is a finding, and `emptied` (had rows, now has none) leads it,
// because that is the shape of a truncation or a load that silently did nothing.
export function compareBackupCounts(prev, now) {
  if (!prev || !now) return null;
  const shrunk = [], emptied = [];
  let grew = 0, added = 0, removed = 0, steady = 0;
  for (const [t, n] of Object.entries(now)) {
    if (!(t in prev)) { added++; continue; }
    const p = prev[t];
    if (p < 0 || n < 0) continue;                       // unknown on either side → no reading
    if (n > p) { grew++; continue; }
    if (n === p) { steady++; continue; }
    if (n === 0 && p > 0) emptied.push({ table: t, prev: p, now: n });
    else if (p >= SMALL_TABLE && n < p * (1 - SHORTFALL_TOLERANCE)) shrunk.push({ table: t, prev: p, now: n });
    else steady++;                                      // a small wobble in a small table
  }
  for (const t of Object.keys(prev)) if (!(t in now)) removed++;
  const worst = [...emptied, ...shrunk].sort((a, b) => (b.prev - b.now) - (a.prev - a.now));
  return {
    total_prev: rowTotal(prev), total_now: rowTotal(now),
    emptied, shrunk, worst: worst.slice(0, 8),
    counts: { grew, steady, added, removed, shrunk: shrunk.length, emptied: emptied.length },
    // The one-line verdict a chip can paint. 'lost' is the only alarming one, and it is about THIS
    // pair of backups — not about production, which nothing here has any right to judge.
    verdict: emptied.length ? 'emptied' : shrunk.length ? 'shrunk' : 'ok',
  };
}

// ── reading 2: a RESTORE against the backup it came from ────────────────────────────────────────
// `ref` = the source snapshot's recorded estimates; `got` = exact counts from the restored database.
// Per table, one of:
//   missing      — the table is not in the restored db at all. That is SCHEMA, not data: say so and
//                  send the human to Check diff rather than reporting it as lost rows.
//   empty        — the reference had rows and this table has none. The loud one; no estimate error
//                  explains "many" becoming "zero".
//   short        — materially under the reference, beyond the tolerance an estimate deserves.
//   ok           — within tolerance, or more than the reference (a restore of a dump taken while
//                  rows were still arriving, or a db that has been written to since).
//   no-reference — the source never analyzed that table, so there is nothing to compare against.
//                  Reported as unknown, never as a pass.
// `refStats` = rows-changed-since-ANALYZE per table, recorded beside the reference counts. Optional:
// an older snapshot has none, and then the comparison behaves exactly as it did before.
export function compareRestoreCounts(ref, got, refStats = null) {
  if (!ref || !got) return null;
  const rows = [];
  for (const [t, r] of Object.entries(ref)) {
    const g = got[t];
    if (g === undefined) { rows.push({ table: t, ref: r, got: null, state: 'missing' }); continue; }
    if (r < 0) { rows.push({ table: t, ref: r, got: g, state: 'no-reference' }); continue; }
    // EMPTY is still EMPTY however stale the estimate is: no amount of statistical decay turns "the
    // reference had rows" into "this table has none of them". That claim survives everything.
    if (r > 0 && g === 0) { rows.push({ table: t, ref: r, got: g, state: 'empty' }); continue; }
    if (r >= SMALL_TABLE && g < r * (1 - SHORTFALL_TOLERANCE)) {
      const mod = refStats ? refStats[t] : null;
      if (referenceIsStale(r, mod)) {
        // The estimate moved more than the tolerance since it was measured, so a shortfall inside that
        // movement says nothing. Reported as UNVERIFIABLE, with the number that made it so.
        rows.push({ table: t, ref: r, got: g, state: 'stale-reference', mod_since_analyze: mod });
      } else {
        rows.push({ table: t, ref: r, got: g, state: 'short' });
      }
      continue;
    }
    rows.push({ table: t, ref: r, got: g, state: 'ok' });
  }
  const by = (s) => rows.filter((x) => x.state === s);
  const empty = by('empty'), short = by('short'), missing = by('missing');
  const stale = by('stale-reference');
  const unknown = [...by('no-reference'), ...stale];
  const extra = Object.keys(got).filter((t) => !(t in ref));
  return {
    checked: rows.length,
    ok_count: by('ok').length,
    empty, short, missing, unknown, stale, extra,
    ref_total: rowTotal(ref),
    got_total: rowTotal(got),
    // 'incomplete' is the only verdict that says data did not arrive, and it takes an EMPTY or SHORT
    // table to earn it. A table missing from the catalog is schema drift; an unanalyzed reference is
    // unknown. Neither is allowed to turn into a data-loss claim, and neither is allowed to pass as
    // one either — 'unverified' says exactly that.
    verdict: (empty.length || short.length) ? 'incomplete'
      : (missing.length || unknown.length) ? 'unverified' : 'complete',
  };
}
