// DATA-DIFF — "is the data actually there?", which is the question TKT-22-4F0E was really asking and
// the one nothing in this system could answer. It is a SEPARATE module from proddiff.js on purpose:
// merging the two readings into one number is the defect the ticket found.
//
//   proddiff  → does this database have prod's SHAPE?    tables, columns, triggers. No rows.
//   datadiff  → did this database's ROWS arrive?          row counts. No catalog opinions.
//
// WHAT IT COMPARES, and why not the obvious thing. It grades a restored database against the row
// counts recorded FOR THE SNAPSHOT IT WAS RESTORED FROM (maintenance.js records both). Grading it
// against LIVE production instead would reproduce the exact bug this ticket unpicked: prod keeps
// moving, so any append-heavy table is permanently "short" and the check would cry wolf forever.
//
// The reference side is planner ESTIMATES (reltuples — see lib/row-counts.js for why an exact count on
// production is not on the table), the measured side is EXACT counts of a dev database. That asymmetry
// is deliberate and it is stated in every verdict: a few percent is noise, a populated table arriving
// EMPTY is not, and a table that is absent altogether is schema drift and gets sent back to Check diff.
//
// PRODUCTION IS NEVER MEASURED HERE. Counting 600 tables on live prod is the P3 that was deliberately
// not built; asking for it is refused with the reason rather than quietly costing prod an hour of I/O.
// READ-ONLY throughout: SELECT count(*) over `docker exec psql`, nothing else.
import { spawn } from 'node:child_process';
import { q, one } from '../db/pool.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { resolveRealDbContainer } from '../lib/xell-db.js';
import { dbIdentity } from '../lib/projects.js';
import { ROW_COUNT_SQL, exactCountSql, parseRowCounts, compareRestoreCounts, SHORTFALL_TOLERANCE } from '../lib/row-counts.js';

// count(*) over a whole dev database is real work — minutes on a big one. Generous, and bounded.
const COUNT_TIMEOUT_MS = Number(process.env.DATADIFF_TIMEOUT_MS) || 600000;

// Same non-blocking shape proddiff uses: never rejects, so one unreachable container cannot take a
// caller down. spawn (not spawnSync) — this must not freeze the event loop for the duration.
function dockerPsql(ctx, container, sql, dbid, timeout) {
  return new Promise((resolve) => {
    let out = '', err = '', child;
    const args = ['--context', ctx, 'exec', '-i', container,
      'psql', '-U', dbid.user, '-d', dbid.name, '-tAq', '-c', sql];
    try { child = spawn('docker', args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, out: '', err: String(e?.message || e) }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: '', err: String(e?.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
  });
}

const fail = (error, extra = {}) => ({ ok: false, error, verdict: null, ...extra });

// Check ONE db container's row counts against the backup it was restored from.
// Returns the report and (unless `persist` is false) writes it onto container.data_check — a column of
// its own, never prod_diff: two questions, two verdicts, so neither can be read as the other.
export async function checkContainerData(containerId, { persist = true } = {}) {
  const c = await one(`SELECT * FROM container WHERE id=$1 AND role='db'`, [containerId]);
  if (!c) return fail('no such db container');
  // Refusal with a reason, not a silent skip: this is the P3 that was deliberately not built.
  if (c.tier === 'prod') {
    return fail('production is never row-counted on demand — an exact count over every table is hours of '
      + 'I/O on the live database. Production is the REFERENCE here: what gets checked is a database '
      + 'restored FROM it.');
  }
  if (c.busy_since) return fail(`this database is busy (${c.busy_op || 'working'}) — a count taken mid-restore is half a database`);

  if (!c.restored_from) {
    return fail(c.restored_note
      // "Duplicate prod" pipes live prod with no snapshot in the middle, so there are no recorded
      // counts to grade against. Say which situation this is rather than grading against the wrong dump.
      ? `no recorded row counts to compare against — ${c.restored_note}`
      : 'this database has no recorded source backup, so there is nothing to compare its rows against. '
        + 'Restore a backup into it (the restore records which one), then run this check.',
      { needs_restore: true });
  }
  const snap = await one(`SELECT id, taken_at, dump_path, row_counts, row_total, toc_summary, tables FROM db_snapshot WHERE id=$1`,
    [c.restored_from]);
  if (!snap) return fail('the backup this database was restored from has been deleted — nothing to compare against');
  if (!snap.row_counts) {
    return fail('the backup this database was restored from carries no row counts (it predates them, or its '
      + 'count probe failed). Take a fresh backup and restore that to get a comparable reference.',
      { snapshot: { id: snap.id, taken_at: snap.taken_at } });
  }

  const dbid = await dbIdentity(c.project_id);
  let real;
  try { real = await resolveRealDbContainer(c.docker_ctx, c.name, { row: c }); }
  catch (e) { return fail(e.message); }

  // WHICH OF THE REFERENCE'S TABLES ARE EVEN HERE — asked FIRST, and this ordering is not cosmetic.
  // Counting a list that names one absent table makes the whole UNION fail, so a single missing table
  // used to turn a legitimate finding ("the backup has a table this database does not") into a psql
  // parse error with a caret in it, and the `missing` verdict the comparison supports could never
  // actually be produced. Found by running the thing end-to-end, which is the only way that shows up.
  // So: read the catalog (the same cheap estimate probe), count only what exists, and let
  // compareRestoreCounts report the rest as MISSING — which is schema drift, and says so.
  const present = await dockerPsql(c.docker_ctx, real, ROW_COUNT_SQL, dbid, 120000);
  if (!present.ok) {
    return fail(`could not read the table list in ${c.name}: `
      + `${(present.err || 'psql failed').trim().split('\n').filter(Boolean)[0]?.slice(0, 200)}`);
  }
  const here = new Set(Object.keys(parseRowCounts(present.out)));
  const countable = Object.keys(snap.row_counts).filter((t) => here.has(t));

  // Nothing the backup carries exists here at all: that is an EMPTY (or wrong) database, not a row
  // shortfall, and pretending to count it would say "every table is missing" in 600 lines.
  if (!countable.length) {
    return fail(`none of the ${Object.keys(snap.row_counts).length} table(s) this backup recorded exist in `
      + `${c.name} — this database is empty, or it is not the database that was restored. That is a SCHEMA `
      + `finding, not a row shortfall: run "Check diff" first.`, { empty_db: true });
  }

  const sql = exactCountSql(countable);
  if (!sql) return fail('the reference records no countable tables');
  const r = await dockerPsql(c.docker_ctx, real, sql, dbid, COUNT_TIMEOUT_MS);
  if (!r.ok) {
    const why = (r.err || 'psql failed').trim().split('\n').filter(Boolean)[0]?.slice(0, 200);
    return fail(`could not count rows in ${c.name}: ${why}`);
  }

  const got = parseRowCounts(r.out);
  const cmp = compareRestoreCounts(snap.row_counts, got);
  const report = {
    ok: true, error: null,
    ...cmp,
    scope: 'data',
    covers: 'row counts per table',
    not_covered: 'the CONTENTS of a row. Equal counts do not prove equal data, and nothing here reads a value.',
    reference: {
      kind: 'snapshot', id: snap.id, taken_at: snap.taken_at,
      estimated: true, tolerance: SHORTFALL_TOLERANCE,
      note: 'the reference is the planner\'s row ESTIMATE from the source at dump time; this side is an exact count',
    },
    restored_note: c.restored_note || null,
    checked_at: new Date().toISOString(),
  };

  if (persist) {
    const row = await one(
      `UPDATE container SET data_check=$2::jsonb, data_check_at=now() WHERE id=$1 RETURNING *`,
      [c.id, JSON.stringify(report)]);
    if (row) broadcast('container', row);
  }
  logline('datadiff', report.verdict === 'complete'
    ? `${c.name}: every table it was restored with has the rows its backup recorded `
      + `(${report.ok_count}/${report.checked} tables, ~${report.got_total.toLocaleString()} rows counted)`
    : report.verdict === 'incomplete'
      ? `⚠ ${c.name}: ${report.empty.length} table(s) are EMPTY and ${report.short.length} short of what the `
        + `backup recorded — ${[...report.empty, ...report.short].slice(0, 5).map((x) => `${x.table} ${x.ref}→${x.got}`).join(', ')}`
      : `${c.name}: rows could not be fully verified — ${report.missing.length} table(s) absent, `
        + `${report.unknown.length} with no reference count. ${report.ok_count}/${report.checked} verified.`);
  return report;
}

// Which databases CAN be data-checked, and what each one would be checked against. The console reads
// this to decide whether to offer the menu item at all, instead of offering it and then explaining.
export async function dataCheckReadiness(containerId) {
  const c = await one(`SELECT * FROM container WHERE id=$1 AND role='db'`, [containerId]);
  if (!c) return { ok: false, error: 'no such db container' };
  if (c.tier === 'prod') return { ok: true, ready: false, reason: 'production is the reference, never the subject' };
  if (!c.restored_from) {
    return { ok: true, ready: false,
      reason: c.restored_note || 'no recorded source backup — restore one into this database first' };
  }
  const snap = await one(`SELECT id, taken_at, row_total, row_counts IS NOT NULL AS has_counts FROM db_snapshot WHERE id=$1`,
    [c.restored_from]);
  if (!snap) return { ok: true, ready: false, reason: 'the source backup has been deleted' };
  if (!snap.has_counts) return { ok: true, ready: false, reason: 'the source backup carries no row counts (it predates them)' };
  return { ok: true, ready: true, snapshot: { id: snap.id, taken_at: snap.taken_at, row_total: snap.row_total } };
}
