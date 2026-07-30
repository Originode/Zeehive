// Maintenance — the queenzee's housekeeping (pure script, no AI):
//   1. back up the PRODUCTION application DB → db_snapshot (one row per dump)
//   2. prune finished backups beyond max_backups (delete file + row)
//   3. restore a backup INTO a db container; refresh stale pooled db-isolated xells
// The backup target is the project's PRODUCTION database — the modeled prod db container
// (role='db', tier='prod') on the prod docker context — NOT the zeehive meta DB that this
// orchestrator keeps its own bookkeeping in (config.databaseUrl).
//
// Jobs run ASYNCHRONOUSLY: the heavy docker work is a non-blocking child process (spawn, not
// spawnSync — spawnSync would freeze the whole server event loop for the ~minutes a dump takes).
// A backup row is created 'running' and finalized 'finished'/'failed'; the container doing the
// work is flagged busy_since/busy_op. Both drive live spinners in the UI over SSE.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from '../lib/events.js';
import { logline } from '../lib/logbus.js';
import { resolveSite } from '../lib/sites.js';
import { listContainersDetailed } from '../lib/docker.js';
import { pickDbContainer } from '../lib/xell-db.js';
import { refreshProdDiffAfterRestore } from './proddiff.js';
// The DATA half of a backup's guarantee — pure functions + the catalog SQL, kept out of here so both
// the capture and every reading of it (trend, restore check) are testable with no docker (row-counts.js).
import { ROW_COUNT_SQL, parseRowCounts, parseRowStats, rowTotal, compareBackupCounts } from '../lib/row-counts.js';
// WHEN the next backup is due (a failure shortens the window, it does not consume it) and WHEN a human
// is told the restore point is stale — pure decisions, so the TIMING is asserted by a test (#26).
import { backupDecision, staleAlertDecision } from '../lib/backup-schedule.js';
// What pg_restore actually reported, and whether it FINISHED — its exit code cannot tell you (#30).
import { restoreOutcome, restoreErrorLine } from '../lib/restore-errors.js';
import { checkContainerData } from './datadiff.js';
import { notifyBackupStale, notifyBackupRecovered } from '../lib/notify.js';

const MODE = process.env.MAINTENANCE_MODE === 'real' ? 'real' : 'simulate';
const DEFAULT_MAX_BACKUPS = 14;
const DEFAULT_INTERVAL_SEC = 86400;
const SIM_BACKUP_MS = Number(process.env.SIM_BACKUP_MS) || 5000;
const SIM_RESTORE_MS = Number(process.env.SIM_RESTORE_MS) || 6000;

// Broadcast a progress update for a db operation (backup, restore, duplicate) over SSE
// so the UI can show live progress in the notification pane. Payload is self-describing:
//   op: 'backup' | 'restore' | 'duplicate'
//   id: the primary identifier (snapshot id for backup, container id for restore/duplicate)
//   label: human-readable label for the affected resource
//   msg: the current phase description (e.g. "Dumping database…")
//   pct: estimated percentage complete (0–100)
//   status: 'running' | 'finished' | 'failed'
//   error: error message when failed
function broadcastDbOpProgress({ op, id, project_id, label, msg, pct, status, error }) {
  broadcast('db-op-progress', { op, id, project_id, label, msg, pct, status, error: error || null });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Non-blocking child process → { status, stdout, stderr }. Never rejects (resolves status=-1 on
// spawn/timeout error) so a job's own try/catch owns the outcome. This is what keeps backups
// async: the event loop stays free while docker runs.
function execAsync(cmd, args, { timeout = 600000 } = {}) {
  return new Promise((resolveP) => {
    let out = '', err = '', timedOut = false;
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return resolveP({ status: -1, stdout: '', stderr: String(e?.message || e) }); }
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolveP({ status: -1, stdout: out, stderr: String(e?.message || e), timedOut }); });
    // A SIGKILLed child closes with code null and NOTHING on stderr — which rendered a day of
    // slow-link backup failures as "docker cp failed: " and sent the debugging at the share
    // instead of the wire. Say it was the timeout.
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ status: code, stdout: out, stderr: timedOut ? `killed at the ${Math.round(timeout / 1000)}s timeout${err ? ` · ${err}` : ''}` : err, timedOut });
    });
  });
}

// STREAM one process's stdout straight into another's stdin, so a 1.2 GB dump never lands on the
// queenzee host. This replaces the old "pg_dump to the container's /tmp, then docker cp to the
// host" — over the mardale link that copy leg alone was ~10 minutes for 1.2 GB, and it also
// stranded ~870 MB in the container's writable layer on every failed copy. Here the src's stdout
// (the dump) flows through the queenzee only as bytes-in-transit into the dst's stdin (which
// writes it to the destination host's bind mount). Resolves with BOTH child statuses + the dst's
// captured stdout (used to read back the written size) and stderr from either side. Never rejects.
function execPipe(a, b, { timeout = 1800000 } = {}) {
  return new Promise((resolveP) => {
    let dstOut = '', srcErr = '', dstErr = '', timedOut = false, srcDone = false, dstDone = false;
    let srcStatus = null, dstStatus = null, src, dst;
    const finish = () => {
      if (!srcDone || !dstDone) return;
      clearTimeout(timer);
      resolveP({ srcStatus, dstStatus, dstStdout: dstOut, srcStderr: srcErr, dstStderr: dstErr, timedOut });
    };
    try {
      src = spawn(a.cmd, a.args, { windowsHide: true });
      dst = spawn(b.cmd, b.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolveP({ srcStatus: -1, dstStatus: -1, dstStdout: '', srcStderr: String(e?.message || e), dstStderr: '', timedOut });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { src.kill('SIGKILL'); } catch { /* gone */ }
      try { dst.kill('SIGKILL'); } catch { /* gone */ }
    }, timeout);
    src.stdout.pipe(dst.stdin);
    // if pg_dump dies, tear down the writer so it can't finalize a truncated file as "ok"
    src.stdout.on('error', () => { try { dst.stdin.destroy(); } catch { /* gone */ } });
    dst.stdin.on('error', () => { /* dst exited early; src close will surface the real status */ });
    src.stderr?.on('data', (d) => { srcErr += d; });
    dst.stdout?.on('data', (d) => { dstOut += d; });
    dst.stderr?.on('data', (d) => { dstErr += d; });
    src.on('error', (e) => { srcErr += String(e?.message || e); srcStatus = srcStatus ?? -1; srcDone = true; finish(); });
    dst.on('error', (e) => { dstErr += String(e?.message || e); dstStatus = dstStatus ?? -1; dstDone = true; finish(); });
    src.on('close', (code) => { srcStatus = code; srcDone = true; finish(); });
    dst.on('close', (code) => { dstStatus = code; dstDone = true; finish(); });
  });
}

// A real backup MUST be a valid pg_dump custom-format (-Fc) archive — those begin with the
// 5-byte magic "PGDMP". Anything else means the dump never actually produced the data (an empty
// or truncated file, a plain-text error captured to the path, a simulated placeholder), and
// recording it as a 'finished' backup hands the operator a restore point that would WIPE a real
// database and put ~nothing back.
//
// But "is it a valid archive?" is NOT enough — that is precisely how regression 2 slipped through.
// The 7,643-byte dump of the WRONG database (a dev clone with only the zeehive_migrations ledger)
// IS a valid PGDMP archive; it just contains an empty database. An absolute byte floor calibrated
// for TRUNCATED files (512 B) waves it through. Restoring it with `pg_restore --clean --if-exists`
// would DROP production's objects and put a ledger table back. So the guard now checks two more
// things the archive-magic never could:
//   • RELATIVE SIZE — a valid backup of the same prod DB does not lose ~all of its bytes overnight.
//     Compared against the last good backup; a collapse past MIN_SIZE_RATIO fails loudly.
//   • CONTENT — the dump's TOC must actually contain application tables (not ONLY the migration
//     ledger), and must not have lost a schema the last good backup had. This is what catches
//     "valid archive of the wrong/empty database" that size and magic alone cannot.
const DUMP_MAGIC = 'PGDMP';
// Truncation floor only — a real -Fc archive is never smaller than a full TOC. The wrong-database
// case is caught by the relative + content guards below, NOT by this.
const MIN_REAL_DUMP_BYTES = 512;
// A backup that lost more than this fraction of the last good backup's size is treated as a
// collapse (regression 2 was 1.2 GB → 7.6 KB, a 99.9994% drop). 0.5 tolerates ordinary variation
// and even a halving of the database, while still catching any gross wrong-DB/empty dump.
const MIN_SIZE_RATIO = 0.5;
// Tables that a NON-empty application dump must contain MORE than — a dump whose only table is a
// migration ledger is an empty database wearing a valid archive's clothes (regression 2 exactly).
const LEDGER_TABLES = new Set(['zeehive_migrations', 'schema_migrations']);

// Fast local pre-check: the file exists, is not truncation-tiny, and starts with PGDMP. Kept for
// the local-destination path where the file is on the queenzee host's own filesystem. Throws.
export function assertDumpMagic(path, size) {
  if (size == null) throw new Error('dump file is missing after pg_dump (nothing was written)');
  if (size < MIN_REAL_DUMP_BYTES) {
    throw new Error(`dump is only ${size} bytes — far too small to be a real database dump `
      + `(a valid pg_dump archive is never under ${MIN_REAL_DUMP_BYTES}B). The dump did not capture the data.`);
  }
  let head = '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(DUMP_MAGIC.length);
    readSync(fd, buf, 0, buf.length, 0);
    head = buf.toString('latin1');
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* fd gone */ } }
  if (head !== DUMP_MAGIC) {
    throw new Error(`dump is not a valid pg_dump custom-format archive `
      + `(expected magic "${DUMP_MAGIC}", got ${JSON.stringify(head)}). The file is not a usable backup.`);
  }
}

// RELATIVE SIZE guard. prevSize = size_bytes of the most recent successful backup for this same
// project (null when there is no predecessor). A first-ever backup cannot be compared, so we say
// so out loud (returned note) and lean entirely on the content guard rather than skipping silently.
export function assertDumpSize(size, prevSize) {
  if (size == null) throw new Error('dump size is unknown after the backup ran (nothing was written)');
  if (size < MIN_REAL_DUMP_BYTES) {
    throw new Error(`dump is only ${size} bytes — far too small to be a real database dump. The dump did not capture the data.`);
  }
  if (prevSize == null || prevSize <= 0) {
    return { compared: false, note: 'no previous successful backup to compare size against — relying on the content check' };
  }
  const floor = Math.floor(prevSize * MIN_SIZE_RATIO);
  if (size < floor) {
    const pct = (100 * (1 - size / prevSize)).toFixed(size / prevSize < 0.001 ? 4 : 1);
    throw new Error(`dump is ${size} bytes but the last good backup was ${prevSize} bytes — a ${pct}% collapse `
      + `(below the ${Math.round(MIN_SIZE_RATIO * 100)}% floor). A real backup of the same database does not shrink this much; `
      + `this almost certainly dumped the WRONG or an EMPTY database. Refusing to record it.`);
  }
  return { compared: true, note: null };
}

// Parse `pg_restore --list` text into a compact summary. Each data-bearing line looks like:
//   "215; 1259 16805 TABLE core invoices postgres"
//   "3012; 0 16805 TABLE DATA core invoices postgres"
//   "5; 2615 16800 SCHEMA - core postgres"          ← namespace field is '-', the NAME is the schema
//   "217; 0 0 SEQUENCE OWNED BY core invoices_id_seq postgres"   ← COMPOUND descriptor
// We collect the schema+table for TABLE rows, and the schema set from every entry that carries one.
// COMPOUND descriptors matter: "SEQUENCE OWNED BY", "SEQUENCE SET" and "MATERIALIZED VIEW DATA" put a
// sub-keyword where the schema token would otherwise be. Matching only the short prefix ("SEQUENCE")
// left "OWNED"/"SET"/"DATA" (and, from SCHEMA rows, "-") as bogus schema names — harmless to the
// counts but poisonous to a table/schema PICKER built from this, so the longer forms are matched first.
export function parseDumpToc(listText) {
  const schemas = new Set();
  const tables = [];      // [{ schema, name }] for TABLE rows only
  let entryCount = 0;
  for (const raw of String(listText || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;   // ';' lines are the header/comment block
    // strip the "dumpId; catalogOid oid " prefix, keep the "DESC schema name owner" tail
    const m = /^\d+;\s+\d+\s+\d+\s+(.*)$/.exec(line);
    if (!m) continue;
    entryCount++;
    const rest = m[1];
    // Longer compound descriptors FIRST so "SEQUENCE OWNED BY" doesn't degrade to "SEQUENCE".
    const desc = /^(TABLE DATA|MATERIALIZED VIEW DATA|MATERIALIZED VIEW|SEQUENCE OWNED BY|SEQUENCE SET|TABLE|SEQUENCE|VIEW|INDEX|CONSTRAINT|TYPE|FUNCTION|SCHEMA|DEFAULT|FK CONSTRAINT|TRIGGER)\b/.exec(rest);
    if (!desc) continue;
    const kind = desc[1];
    const tail = rest.slice(kind.length).trim().split(/\s+/);
    // A SCHEMA entry's namespace column is '-'; the schema's own name is the NEXT token.
    if (kind === 'SCHEMA') { if (tail[1]) schemas.add(tail[1]); continue; }
    const schema = tail[0];
    const name = tail[1];
    if (schema && schema !== '-') schemas.add(schema);
    if (kind === 'TABLE' && schema && name) tables.push({ schema, name });
  }
  return { schemas: [...schemas], tables, tableCount: tables.length, entryCount };
}

// ── table-selection arg builders (pure; unit-tested without a database) ─────────
// A selection is an array of 'schema.table' strings. Empty/absent ⇒ [] ⇒ operate on the WHOLE
// database (the default). Callers validate the strings first (validTableSelection below); these just
// shape the argv. Values are passed as discrete argv to `docker exec` (never a shell string), so
// there is no shell to inject into — the validator's job is to reject pg_dump PATTERN metacharacters
// (?, *, etc.) that would silently widen the selection.
export function dumpTableArgs(tables) {
  if (!Array.isArray(tables)) return [];
  // pg_dump -t accepts a schema-qualified pattern directly (core.location), so one flag per table.
  return tables.filter((t) => typeof t === 'string' && t.trim()).flatMap((t) => ['-t', t.trim()]);
}
// pg_restore -t matches by table NAME only; schema is restricted with -n (the two are AND-ed). So we
// emit -n for each distinct schema and -t for each table name. Caveat, noted for the caller: selecting
// two same-named tables in different schemas widens to their cross product — rare, and safe (it only
// restores MORE of the archive the operator already trusts), never wrong data.
export function restoreTableArgs(tables) {
  if (!Array.isArray(tables)) return [];
  const clean = tables.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
  if (!clean.length) return [];
  const schemas = new Set(); const names = [];
  for (const t of clean) {
    const dot = t.indexOf('.');
    if (dot > 0) { schemas.add(t.slice(0, dot)); names.push(t.slice(dot + 1)); }
    else names.push(t);
  }
  const args = [];
  for (const s of schemas) args.push('-n', s);
  for (const n of names) args.push('-t', n);
  return args;
}
// Validate + normalise a table selection from the API. Returns a clean array (possibly empty ⇒ full
// database) or throws with a precise reason. Identifiers only: letters/digits/underscore/$, an
// optional single schema qualifier. No wildcards, quotes, whitespace or shell/pattern metacharacters.
const TABLE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
export function validTableSelection(input, label = 'tables') {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error(`${label} must be an array of "schema.table" strings`);
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') throw new Error(`${label}: every entry must be a string`);
    const t = raw.trim();
    if (!t) continue;
    const parts = t.split('.');
    if (parts.length > 2 || !parts.every((p) => TABLE_IDENT.test(p))) {
      throw new Error(`${label}: "${raw}" is not a valid table name — use schema.table with plain `
        + `identifiers (letters, digits, _ , $), no wildcards or quoting`);
    }
    out.push(t);
  }
  return [...new Set(out)];
}

// Bogus "schema" tokens a PRE-FIX parseDumpToc could record into a backup's toc_summary.schemas.
// The old parser mistook the sub-keyword of a COMPOUND TOC descriptor for a schema name — 'OWNED'
// (SEQUENCE OWNED BY), 'SET' (SEQUENCE SET), 'DATA' (MATERIALIZED VIEW DATA) — and kept the '-'
// namespace placeholder of SCHEMA rows. The fixed parser no longer emits any of these, so a CLEAN
// new dump looks like it "lost" them and the continuity check below would reject EVERY full backup
// ("dump is missing schema(s) [-, OWNED, SET, DATA]"): backups failing again. They were never real
// schemas, so strip them from a recorded ruler before comparing. ('BY' was never emitted — the old
// parser matched the short 'SEQUENCE' prefix, leaving tail[0]='OWNED'/'SET' — but include it for
// safety.) These uppercase words as a real Postgres schema name are astronomically unlikely; even
// then, dropping one only makes the *continuity* check more lenient (never falsely PASS — the
// absolute app-table and size guards still stand).
const LEGACY_TOC_SCHEMA_ARTIFACTS = new Set(['-', 'OWNED', 'BY', 'SET', 'DATA']);

// The real schema set a recorded backup captured. Prefer deriving it from the ruler's TABLE list
// (always real 'schema.table' names — exact, and what post-fix backups record); fall back to its
// recorded schema list with the legacy-parser artifacts above stripped (pre-fix rulers have no
// tables[] field). Returns [] when the ruler carries neither.
function rulerSchemas(prevSummary) {
  if (Array.isArray(prevSummary?.tables) && prevSummary.tables.length) {
    return [...new Set(prevSummary.tables.map((t) => String(t).split('.')[0]).filter(Boolean))];
  }
  if (Array.isArray(prevSummary?.schemas)) {
    return prevSummary.schemas.filter((s) => !LEGACY_TOC_SCHEMA_ARTIFACTS.has(s));
  }
  return [];
}

// CONTENT guard. toc = parseDumpToc(...) of the dump actually written. prevSummary = the
// toc_summary jsonb recorded for the last good backup (null when none/legacy).
//  • absolute: the dump must contain at least one application table that is NOT a migration ledger.
//    A TOC whose only table is zeehive_migrations is an empty database (regression 2 exactly).
//  • relative: every schema the last good backup had must still be present. Losing `core`
//    overnight means the wrong database, not a legitimate change.
export function assertDumpContent(toc, prevSummary) {
  const appTables = (toc.tables || []).filter((t) => !LEDGER_TABLES.has(t.name));
  if (appTables.length === 0) {
    const only = (toc.tables || []).map((t) => `${t.schema}.${t.name}`).join(', ') || '(no tables at all)';
    throw new Error(`dump contains no application tables — only ${only}. `
      + `This is an EMPTY database (its whole TOC is ${toc.entryCount} entr${toc.entryCount === 1 ? 'y' : 'ies'}): `
      + `almost certainly the WRONG container was dumped. Restoring it would WIPE the real database. Refusing to record it.`);
  }
  const prevSchemas = rulerSchemas(prevSummary);
  if (prevSchemas.length) {
    const now = new Set(toc.schemas || []);
    const missing = prevSchemas.filter((s) => !now.has(s));
    if (missing.length) {
      throw new Error(`dump is missing schema(s) [${missing.join(', ')}] that the last good backup contained. `
        + `A backup does not lose whole schemas between runs — this is the wrong database. Refusing to record it.`);
    }
  }
  return { appTableCount: appTables.length, comparedSchemas: prevSchemas.length > 0 };
}

// timestamp key for the dump filename (yyyymmddhhmmss). A short random token is appended
// separately to guarantee a unique filename even for two backups in the same second.
function stamp() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); }

// the folder new dumps go into: per-project override, else the server default (<repo>/db_backups).
// This is a path ON THE DESTINATION CONTEXT'S HOST (backup_ctx) when one is set — e.g.
// /volume3/maki/Backups/Omnibiz/db on ugreen-nas.
function backupDirFor(pool) {
  const d = pool?.backup_dir && String(pool.backup_dir).trim();
  return d || config.backupDir;
}

// A tiny image the destination context uses to WRITE the streamed bytes to its bind mount, and to
// prune/read files there. `alpine` is ~5 MB and universally pullable.
const STREAM_IMAGE = process.env.BACKUP_STREAM_IMAGE || 'alpine';
// The image used to run `pg_restore --list` on the WRITTEN dump for the content check. We prefer
// the SOURCE db container's own image (guaranteed to read an archive it produced), falling back to
// a stock postgres so a private source tag that the destination can't pull still validates.
const PG_TOOLS_IMAGE = process.env.BACKUP_TOOLS_IMAGE || 'postgres:17-alpine';

// Join a dir + filename with '/'. The destination path lives on ANOTHER host (often Linux/NAS);
// node's path.resolve would rewrite it against the queenzee's own OS/cwd. For a local dump we do
// want resolve() (it is a real path on this host); for a remote one we keep it POSIX and literal.
const posixJoin = (dir, file) => `${String(dir).replace(/[/\\]+$/, '')}/${file}`;

// Delete a single file inside `dir` on a remote context via a throwaway container (used to clear a
// truncated partial after a failed stream, and to prune on retention). Never throws.
async function removeRemoteFile(ctx, dir, file) {
  try {
    await execAsync('docker',
      ['--context', ctx, 'run', '--rm', '-v', `${dir}:/out`, STREAM_IMAGE, 'rm', '-f', `/out/${file}`],
      { timeout: 120000 });
  } catch { /* best effort */ }
}

// Remove a dump's FILE on whichever host it actually lives on: a remote dest_ctx via a throwaway
// container, else the local path. Never throws — a file that is already gone is fine; the row is
// removed either way. Shared by retention housekeeping, single-backup delete, and interrupted-job
// cleanup so all three prune the RIGHT host (deleting the local path for a NAS dump = regression 1).
async function removeDumpFile(snap) {
  if (!snap?.dump_path) return;
  if (snap.dest_ctx) {
    const i = Math.max(snap.dump_path.lastIndexOf('/'), snap.dump_path.lastIndexOf('\\'));
    await removeRemoteFile(snap.dest_ctx, snap.dump_path.slice(0, i), snap.dump_path.slice(i + 1));
  } else {
    try { rmSync(snap.dump_path, { force: true }); } catch { /* file may be gone */ }
  }
}

// Resolve a REGISTRY container ROW to the actually-running container on its context — WITHOUT
// trusting name shape.
//
// The old code did `names.find((n) => n.startsWith(modeledName + '_'))` and took the FIRST match
// `docker ps` returned (newest-first). That is regression 2: two containers matched
// `omnibiz_db_prod_` — the real prod db `omnibiz_db_prod_v184` (port 5432, has schema `core`) and
// a dev clone `omnibiz_db_prod_dev_local_mardale_prod` (port 32768, empty). The clone was newer,
// so it won, and the queenzee cheerfully dumped an empty database over the real one's history.
// "stop with the hard coded naming" — Mark.
//
// RECONCILED with calm-summit-65c3fb: that xell centralized the identity-based DECISION in
// lib/xell-db.js as `pickDbContainer(running, {name, host_port}, registeredElsewhere)` — which
// resolves by the row's published host port (5432 → real prod, 32768 → clone) and excludes any
// running container that is itself another registry row. We IMPORT and use that shared decision
// rather than keep a second copy (my brief: "if a central resolver exists by merge time, import
// and use it"). What stays local here is only the async, CLI-free PLUMBING maintenance needs: we
// read the live container list over the docker HTTP API (listContainersDetailed — same read the
// health monitor uses, keeps the event loop free, and is what let this be unit-tested with no
// daemon), and — unlike the guard's tolerant caller — we treat `ambiguous` OR `unresolved` as a
// hard FAILURE. A backup that cannot positively identify its container must stop, never fall back
// to a logical/first-guess name (that fallback IS regression 2).
//
// Returns { name, image } of the resolved running container. THROWS on an unreachable context or
// an unconfirmable row — a backup must FAIL, never fall through to some other container/volume.
async function resolveRunningContainer(row) {
  const ctx = row?.docker_ctx;
  let list;
  try { list = await listContainersDetailed(ctx); }
  catch (e) { throw new Error(`context '${ctx}' unreachable while resolving '${row?.name}': ${e.message}`); }
  // Adapt listContainersDetailed → pickDbContainer's shape: running only, published host ports.
  const running = list
    .filter((c) => c.state === 'running')
    .map((c) => ({ name: c.name, hostPorts: new Set((c.ports || []).map((p) => p.public).filter((n) => n != null)) }));
  // Exclusion set: the names of every OTHER db container in the registry — so a sibling row's
  // container (the dev clone) can never be picked for this one, exactly as the shared resolver does.
  const others = await q(`SELECT name FROM container WHERE role='db' AND name <> $1`, [row?.name]);
  const registeredElsewhere = new Set(others.map((r) => r.name));
  const pick = pickDbContainer(running, { name: row?.name, host_port: row?.host_port ?? null }, registeredElsewhere);
  if (pick.ambiguous) {
    throw new Error(`cannot identify the container for '${row?.name}' on '${ctx}': ${pick.candidates.length} candidates `
      + `(${pick.candidates.join(', ')}) and none is confirmable. Refusing to guess — record the row's host_port.`);
  }
  if (pick.unresolved) {
    throw new Error(`'${row?.name}' is not running on '${ctx}' as configured (host_port ${row?.host_port ?? 'none'}). `
      + `Running db-ish containers: ${running.map((c) => c.name).join(', ') || 'none'}. Refusing to back up a database I cannot positively identify.`);
  }
  const hit = list.find((c) => c.name === pick.name);
  return { name: pick.name, image: hit?.image || null };
}

// Flag a container busy (op = 'backup' | 'restore') or clear it, and tell the UI so it can spin
// the chip and lock out builds while the work is in flight.
async function setBusy(containerId, op) {
  const row = await one(
    `UPDATE container SET busy_since=now(), busy_op=$2 WHERE id=$1 RETURNING *`, [containerId, op]);
  if (row) broadcast('container', row);
  return row;
}
async function clearBusy(containerId) {
  const row = await one(
    `UPDATE container SET busy_since=NULL, busy_op=NULL WHERE id=$1 RETURNING *`, [containerId]);
  if (row) broadcast('container', row);
  return row;
}

// ── prod is IN USE → no backups ───────────────────────────────────────────────
// A pg_dump is not a free observer: it holds ACCESS SHARE on every table for the whole dump, so
// a ship's migration (ACCESS EXCLUSIVE ALTERs) wedges behind a long dump — and a dump taken
// mid-ship or mid-data-fix preserves a half-finished job as if it were a good restore point.
// So prod is off-limits to backups while EITHER:
//   • the prod deploy lock is held (a ship is deploying, or its verification window is open), or
//   • a live work xell is BOUND to the prod database (db-shared-prod — a human-granted
//     hotfix/data binding; it may write at any moment while it holds that coupling).
// Returns the human-readable reason, or null when prod is free.
export async function prodBusyReason(projectId) {
  const lock = await one(
    `SELECT dl.phase, x.slug FROM deploy_lock dl LEFT JOIN xell x ON x.id = dl.xell_id
      WHERE dl.project_id=$1 AND dl.container='prod'`, [projectId]);
  if (lock) {
    return `the prod deploy lock is held${lock.slug ? ` by ${lock.slug}` : ''}`
      + `${lock.phase ? ` (${lock.phase})` : ''}`;
  }
  // NOT is_production: the production pseudo-xell IS prod — only a work xell pointed at prod
  // (via /xell-prod or --db shared-prod) counts as someone operating on it. And only while a
  // zee is actually IN there (live zee row): a binding whose zee stopped days ago is a parked
  // grant, not an operation — blocking on it would silently stop backups forever (found live on
  // day one: pautang-express held db-shared-prod with a zee stopped since the day before).
  const bound = await one(
    `SELECT x.slug FROM xell x
      WHERE x.project_id=$1 AND x.status <> 'retired' AND NOT x.is_production
        AND x.db_coupling='db-shared-prod'
        AND EXISTS (SELECT 1 FROM zee z WHERE z.xell_id = x.id
                      AND z.status IN ('spawning','online','working','idle'))
      LIMIT 1`, [projectId]);
  if (bound) return `xell ${bound.slug} is bound to the prod database (db-shared-prod) with a live zee`;
  return null;
}

// ── BACKUP ────────────────────────────────────────────────────────────────────
// Kick off an async prod backup: create the 'running' row, flag the prod db container busy, and
// return immediately. The dump/copy runs in the background (runBackupJob) and finalizes the row.
export async function backupProd(projectId) {
  const project = await one(`SELECT * FROM project WHERE id=$1`, [projectId]);
  if (!project) throw new Error('no project');
  // one running backup per project — don't stack dumps of the same DB
  const running = await one(
    `SELECT id FROM db_snapshot WHERE project_id=$1 AND source='prod' AND status='running' LIMIT 1`, [projectId]);
  if (running) throw new Error('a backup is already running');
  // prod in use → refuse (manual click or scheduler alike); the scheduler defers and retries
  const busy = await prodBusyReason(projectId);
  if (busy) {
    throw new Error(`prod backup refused: ${busy} — a dump would contend with live prod work `
      + '(pg_dump locks every table for its duration). It runs automatically once prod is released.');
  }

  const pool = await one(`SELECT backup_dir, backup_ctx, max_backups, backup_tables FROM pool_config WHERE project_id=$1`, [projectId]);
  // The configured default table selection. Empty ⇒ full-database dump (today's behaviour).
  const tables = validTableSelection(pool?.backup_tables, 'backup_tables');
  const dir = backupDirFor(pool);
  const destCtx = (pool?.backup_ctx && String(pool.backup_ctx).trim()) || null;   // NULL ⇒ local host
  const file = `${project.name.toLowerCase()}_prod_${stamp()}_${randomBytes(3).toString('hex')}.dump`;
  // dump_path is the path ON THE DESTINATION: a real host path locally, a POSIX path on the NAS.
  const fullPath = destCtx ? posixJoin(dir, file) : resolve(dir, file);
  if (!destCtx) mkdirSync(dir, { recursive: true });   // remote: the bind mount creates the dir

  // the PRODUCTION db container to dump (modeled; resolved to its live versioned name in the job)
  const dbc = await one(
    `SELECT id, name, docker_ctx, host_port, tier FROM container
       WHERE project_id=$1 AND role='db' AND tier='prod' AND isolation='shared'
       ORDER BY created_at LIMIT 1`, [projectId]);
  const dbName = project.db_name || config.prodDbName || project.name.toLowerCase();
  const dbUser = project.db_user || config.prodDbUser;

  // dest_ctx recorded up front so the UI shows WHERE this dump is going while it runs, and so a
  // restore/prune can always find it. dump_path alone is ambiguous across hosts now.
  const snap = await one(
    `INSERT INTO db_snapshot (project_id, source, dump_path, dest_ctx, status, tables)
       VALUES ($1,'prod',$2,$3,'running',$4) RETURNING *`,
    [projectId, fullPath, destCtx, tables.length ? JSON.stringify(tables) : null]);
  if (dbc) await setBusy(dbc.id, 'backup');
  broadcast('task', { kind: 'db_snapshot', snap });
  logline('maint', `backup started (${MODE}) → ${destCtx ? `[${destCtx}] ` : ''}${fullPath}`
    + `${tables.length ? ` · SCOPED to ${tables.length} table(s): ${tables.join(', ')}` : ''}`);

  // fire-and-forget: the heavy work runs async; the caller gets the running row now
  runBackupJob({ snap, project, dbc, dbName, dbUser, dir, file, fullPath, destCtx, tables,
    keep: pool?.max_backups ?? DEFAULT_MAX_BACKUPS })
    .catch((e) => console.error('[backup]', e.message));
  return snap;
}

// PER-TABLE ROW ESTIMATES from the SOURCE, taken next to the dump — the data half of TKT-22-4F0E.
//
// Three rules this obeys, and they are the reason it is shaped like this:
//   1. It NEVER fails a backup. The dump is the product; these counts are instrumentation. Every
//      failure path returns null and logs a line — a snapshot with no counts is a snapshot, and the
//      surfaces read null as "not captured", never as "the database was empty".
//   2. It NEVER extends the window production is locked for. reltuples is a pg_class read: it takes no
//      table locks, touches no heap, and runs AFTER pg_dump has already let go.
//   3. It is never an exact count(*) here. Minutes of I/O on a 1.3 GB production database for a number
//      that only has to be good enough for a trend is not a trade worth making.
async function sourceRowCounts(ctx, container, dbUser, dbName) {
  const r = await execAsync('docker',
    ['--context', ctx, 'exec', container, 'psql', '-U', dbUser, '-d', dbName, '-tAq', '-c', ROW_COUNT_SQL],
    { timeout: 120000 });
  if (r.status !== 0) {
    logline('maint', `row-count probe of ${container}/${dbName} failed (exit ${r.status}) — the BACKUP is `
      + `unaffected, but this dump records no row counts: ${(r.stderr || '').trim().split('\n').pop()?.slice(0, 160)}`);
    return null;
  }
  const counts = parseRowCounts(r.stdout);
  if (!Object.keys(counts).length) return null;
  // …and how far each of those estimates has decayed, from the same read. An estimate without its
  // staleness is a number you cannot argue with later.
  return { counts, stats: parseRowStats(r.stdout) };
}

async function runBackupJob({ snap, project, dbc, dbName, dbUser, dir, file, fullPath, destCtx, tables = [], keep }) {
  let size = null, error = null, tocText = null, tocSummary = null, rowCounts = null, rowStats = null;
  const scoped = Array.isArray(tables) && tables.length > 0;   // a partial, table-scoped dump
  const tArgs = dumpTableArgs(tables);                          // [] for a full-database dump
  try {
    if (MODE === 'real') {
      if (!dbc?.name) throw new Error('no production db container modeled for this project');
      const srcCtx = dbc.docker_ctx || (await resolveSite(project.id, 'prod'))?.docker_ctx || project.docker_ctx_prod;
      // Resolve the source container by IDENTITY (ctx + host_port), never name shape (regression 2).
      const src = await resolveRunningContainer({ ...dbc, docker_ctx: srcCtx });
      const container = src.name;

      broadcastDbOpProgress({
        op: 'backup', id: snap.id, project_id: snap.project_id,
        label: `${project.name} prod`, msg: 'Starting dump…', pct: 5, status: 'running',
      });

      if (destCtx) {
        // ── NETWORK destination: STREAM src → dst, never staging the dump on the queenzee host ──
        // pg_dump writes to stdout; a throwaway container on the destination context reads stdin
        // and writes it to the bind-mounted backup dir, then prints the byte count it wrote.
        broadcastDbOpProgress({
          op: 'backup', id: snap.id, project_id: snap.project_id,
          label: `${project.name} prod`, msg: 'Dumping database to remote host…', pct: 30, status: 'running',
        });
        const writer = `cat > '/out/${file}' && wc -c < '/out/${file}'`;
        const piped = await execPipe(
          { cmd: 'docker', args: ['--context', srcCtx, 'exec', container, 'pg_dump', '-U', dbUser, '-Fc', ...tArgs, '-d', dbName] },
          { cmd: 'docker', args: ['--context', destCtx, 'run', '-i', '--rm', '-v', `${dir}:/out`, STREAM_IMAGE, 'sh', '-c', writer] },
          { timeout: 1800000 });
        if (piped.srcStatus !== 0 || piped.dstStatus !== 0) {
          await removeRemoteFile(destCtx, dir, file);   // never leave a truncated partial behind
          const why = piped.timedOut ? 'timed out' : `pg_dump exit ${piped.srcStatus}, writer exit ${piped.dstStatus}`;
          throw new Error(`streamed backup of ${container}/${dbName} → [${destCtx}] failed (${why}): `
            + `${((piped.srcStderr || piped.dstStderr) || '(no output)').slice(-300)}`);
        }
        size = parseInt(String(piped.dstStdout).trim(), 10);
        if (!Number.isFinite(size)) throw new Error(`destination did not report a written size (got ${JSON.stringify(String(piped.dstStdout).slice(0, 80))})`);
        broadcastDbOpProgress({
          op: 'backup', id: snap.id, project_id: snap.project_id,
          label: `${project.name} prod`, msg: 'Validating dump content…', pct: 65, status: 'running',
        });
        // Content/magic check: run pg_restore --list on the WRITTEN file, on the destination host
        // (local disk read there — the TOC is tiny and comes back over the wire, not the 1.2 GB).
        const toolsImage = src.image || PG_TOOLS_IMAGE;
        const list = await execAsync('docker',
          ['--context', destCtx, 'run', '--rm', '-v', `${dir}:/out`, toolsImage, 'pg_restore', '--list', `/out/${file}`],
          { timeout: 600000 });
        if (list.status !== 0) {
          await removeRemoteFile(destCtx, dir, file);
          throw new Error(`the written dump is not a readable pg_dump archive (pg_restore --list exit ${list.status}): `
            + `${((list.stderr || list.stdout) || '(no output)').slice(-300)}`);
        }
        tocText = list.stdout;
      } else {
        // ── LOCAL destination (backup_ctx NULL): today's behavior — dump to the container's /tmp,
        //    list it there, copy to the host volume, then rm whatever happened. ──
        broadcastDbOpProgress({
          op: 'backup', id: snap.id, project_id: snap.project_id,
          label: `${project.name} prod`, msg: 'Dumping database…', pct: 30, status: 'running',
        });
        const remoteTmp = `/tmp/${file}`;
        const dump = await execAsync('docker',
          ['--context', srcCtx, 'exec', container, 'pg_dump', '-U', dbUser, '-Fc', ...tArgs, '-d', dbName, '-f', remoteTmp],
          { timeout: 1200000 });
        if (dump.status !== 0) {
          await execAsync('docker', ['--context', srcCtx, 'exec', container, 'rm', '-f', remoteTmp], { timeout: 60000 });
          throw new Error(`pg_dump of ${container}/${dbName} failed (exit ${dump.status}): `
            + `${((dump.stderr || dump.stdout) || '(no output)').slice(-300)}`);
        }
        // TOC while the file is still in the container (its own pg_restore reads its own dump).
        const list = await execAsync('docker',
          ['--context', srcCtx, 'exec', container, 'pg_restore', '--list', remoteTmp], { timeout: 300000 });
        const cp = await execAsync('docker', ['--context', srcCtx, 'cp', `${container}:${remoteTmp}`, fullPath], { timeout: 1200000 });
        // rm the in-container dump WHATEVER the cp did — the rm used to run only after a good cp,
        // so every failed copy leaked ~870MB into the container's writable layer (16 dumps / 13GB
        // found in prod's /tmp on 2026-07-17, overlay at 86%).
        await execAsync('docker', ['--context', srcCtx, 'exec', container, 'rm', '-f', remoteTmp], { timeout: 60000 });
        if (cp.status !== 0) {
          throw new Error(`docker cp failed (exit ${cp.status}): `
            + `${((cp.stderr || cp.stdout) || '(no output)').slice(-300)}`);
        }
        try { size = statSync(fullPath).size; } catch { size = null; }
        assertDumpMagic(fullPath, size);
        broadcastDbOpProgress({
          op: 'backup', id: snap.id, project_id: snap.project_id,
          label: `${project.name} prod`, msg: 'Reading table of contents…', pct: 70, status: 'running',
        });
        if (list.status !== 0) {
          throw new Error(`pg_restore --list of the dump failed (exit ${list.status}) — the file is not a usable archive: `
            + `${((list.stderr || list.stdout) || '(no output)').slice(-300)}`);
        }
        tocText = list.stdout;
      }

      broadcastDbOpProgress({
        op: 'backup', id: snap.id, project_id: snap.project_id,
        label: `${project.name} prod`, msg: 'Recording row counts…', pct: 88, status: 'running',
      });
      // The row estimates for what was just dumped — AFTER the dump, so it cannot delay it or hold
      // anything of prod's, and inside the same try only so a probe error is logged like any other
      // (sourceRowCounts itself never throws). Deliberately not gated on `scoped`: a scoped dump's
      // counts still describe the source, and the restore check reads only the tables it holds.
      const probed = await sourceRowCounts(srcCtx, container, dbUser, dbName)
        .catch((e) => { logline('maint', `row-count probe errored (backup unaffected): ${e.message}`); return null; });
      rowCounts = probed?.counts ?? null;
      rowStats = probed?.stats ?? null;

      // ── validation common to both destinations ──────────────────────────────
      broadcastDbOpProgress({
        op: 'backup', id: snap.id, project_id: snap.project_id,
        label: `${project.name} prod`, msg: 'Validating content…', pct: 80, status: 'running',
      });
      const toc = parseDumpToc(tocText);
      // The full-database table list this dump captured, as 'schema.table' strings — feeds the
      // restore picker (exactly what can be restored) and, for a scoped dump, records the selection.
      const tocTables = toc.tables.map((t) => `${t.schema}.${t.name}`);
      tocSummary = { schemas: toc.schemas, table_count: toc.tableCount, tables: tocTables, scoped };
      if (scoped) {
        // A SCOPED dump is smaller and has fewer schemas than a full one BY DESIGN. The size-collapse
        // and schema-continuity guards compare against full backups, so they would falsely reject it —
        // skip them. The floor check (a scoped dump must still capture at least one of its tables)
        // stands in: an empty archive means the selection matched nothing.
        if (toc.tableCount === 0) {
          throw new Error(`scoped backup captured no tables — the selection [${tables.join(', ')}] `
            + `matched nothing in ${dbName}. Nothing was written. Check the table names.`);
        }
        logline('maint', `scoped backup validated → ${size} bytes, ${toc.tableCount} of ${tables.length} selected table(s): [${tocTables.join(', ')}]`);
      } else {
        // Compare against the last GOOD FULL backup of this project (never a scoped one — that would
        // compare a whole DB against a handful of tables): a catastrophic size collapse and a dump
        // that lost the schemas/tables the last one had are BOTH refused (regression 3). This is what
        // turns "valid archive of the wrong/empty database" into a loud FAILURE.
        const prev = await one(
          `SELECT size_bytes, toc_summary FROM db_snapshot
             WHERE project_id=$1 AND source='prod' AND status='finished' AND mode='real' AND id<>$2
               AND tables IS NULL
             ORDER BY taken_at DESC LIMIT 1`, [snap.project_id, snap.id]);
        const sizeVerdict = assertDumpSize(size, prev?.size_bytes ?? null);
        const contentVerdict = assertDumpContent(toc, prev?.toc_summary ?? null);
        logline('maint', `backup validated → ${size} bytes, ${toc.tableCount} table(s), schemas [${toc.schemas.join(', ')}]`
          + `${sizeVerdict.compared ? '' : ` · ${sizeVerdict.note}`}${contentVerdict.comparedSchemas ? ' · schema-continuity ok' : ''}`);
      }
    } else {
      broadcastDbOpProgress({
        op: 'backup', id: snap.id, project_id: snap.project_id,
        label: `${project.name} prod`, msg: 'Simulating backup…', pct: 10, status: 'running',
      });
      await wait(Math.round(SIM_BACKUP_MS * 0.6));   // simulate: hold 'running' briefly so the spinner is visible
      broadcastDbOpProgress({
        op: 'backup', id: snap.id, project_id: snap.project_id,
        label: `${project.name} prod`, msg: 'Writing simulated dump…', pct: 60, status: 'running',
      });
      await wait(Math.round(SIM_BACKUP_MS * 0.4));
      const body = `-- ZEEHIVE simulated backup of ${project.name} PRODUCTION database\n`
        + `-- target: ${dbc?.name || '(prod db container)'} / db=${dbName} user=${dbUser}\n`
        + `-- destination: ${destCtx ? `[${destCtx}] ` : '(local) '}${fullPath}\n`
        + `-- taken ${new Date().toISOString()}\n`;
      if (!destCtx) writeFileSync(fullPath, body);   // remote sim: nothing to write here
      size = Buffer.byteLength(body);
    }
  } catch (e) {
    error = e.message;
  }

  if (error) {
    // Clean up whatever partial exists on whichever host it would be on.
    if (destCtx) { await removeRemoteFile(destCtx, dir, file); }
    else { try { rmSync(fullPath, { force: true }); } catch { /* partial may not exist */ } }
    const row = await one(`UPDATE db_snapshot SET status='failed', error=$2, mode=$3 WHERE id=$1 RETURNING *`,
      [snap.id, String(error).slice(0, 500), MODE]);
    if (dbc) await clearBusy(dbc.id);
    broadcast('task', { kind: 'db_snapshot', snap: row });
    broadcastDbOpProgress({
      op: 'backup', id: snap.id, project_id: snap.project_id,
      label: `${project.name} prod`, msg: 'Backup failed', pct: 0, status: 'failed', error,
    });
    logline('maint', `backup FAILED → ${error}`);
    return;
  }

  const row = await one(
    `UPDATE db_snapshot SET status='finished', size_bytes=$2, mode=$3, toc_summary=$4,
                            row_counts=$5::jsonb, row_total=$6, row_stats=$7::jsonb
      WHERE id=$1 RETURNING *`,
    [snap.id, size, MODE, tocSummary ? JSON.stringify(tocSummary) : null,
     rowCounts ? JSON.stringify(rowCounts) : null, rowCounts ? rowTotal(rowCounts) : null,
     rowStats ? JSON.stringify(rowStats) : null]);
  if (dbc) await clearBusy(dbc.id);
  broadcast('task', { kind: 'db_snapshot', snap: row });
  broadcastDbOpProgress({
    op: 'backup', id: snap.id, project_id: snap.project_id,
    label: `${project.name} prod`, msg: 'Backup complete', pct: 100, status: 'finished',
  });
  logline('maint', `backup finished (${MODE}) → ${destCtx ? `[${destCtx}] ` : ''}${fullPath} (${size ?? '?'} bytes)`);

  // THE TREND, which is the reading nothing in this system could give before: a table that SHRANK
  // since the last good dump. Growth, a new table and a dropped table are all normal and are counted
  // but never dressed as loss; only a real drop — and worst of all a populated table arriving EMPTY —
  // is a finding, and it is said out loud HERE, in the log a human watches, as well as on the panel.
  // Estimates on both sides, equally stale, which is exactly what makes the comparison fair.
  if (rowCounts && !scoped) {
    const prevRows = await one(
      `SELECT row_counts FROM db_snapshot
         WHERE project_id=$1 AND source='prod' AND status='finished' AND mode='real' AND id<>$2
           AND tables IS NULL AND row_counts IS NOT NULL
         ORDER BY taken_at DESC LIMIT 1`, [snap.project_id, snap.id]);
    const trend = compareBackupCounts(prevRows?.row_counts ?? null, rowCounts);
    if (!trend) {
      logline('maint', `row counts recorded for this backup (~${rowTotal(rowCounts).toLocaleString()} rows in `
        + `${Object.keys(rowCounts).length} tables). No earlier backup carries counts yet, so there is nothing to `
        + 'compare against — the NEXT backup gets a trend. (Estimates, and about the DUMP SOURCE, not the archive.)');
    } else if (trend.verdict === 'ok') {
      logline('maint', `row counts steady vs the last backup: ~${trend.total_now.toLocaleString()} rows `
        + `(was ~${trend.total_prev.toLocaleString()}) · ${trend.counts.grew} grew, ${trend.counts.steady} unchanged`
        + `${trend.counts.added ? `, ${trend.counts.added} new table(s)` : ''}`);
    } else {
      logline('maint', `⚠ ${trend.emptied.length} table(s) went EMPTY and ${trend.shrunk.length} SHRANK since the last `
        + `backup — ${trend.worst.map((w) => `${w.table} ${w.prev.toLocaleString()}→${w.now.toLocaleString()}`).join(', ')}`
        + `. These are planner ESTIMATES, so a small drop can be noise — an emptied table is not. Worth a look.`);
    }
  }
  broadcastDbOpProgress({
    op: 'backup', id: snap.id, project_id: snap.project_id,
    label: `${project.name} prod`, msg: 'Housekeeping…', pct: 95, status: 'running',
  });
  await housekeepBackups(snap.project_id, keep);
}

// Prune FINISHED prod backups beyond `keep`, newest-first: delete the dump file AND its row.
// (running/failed rows are never counted or pruned here.)
export async function housekeepBackups(projectId, keep = DEFAULT_MAX_BACKUPS) {
  const extra = await q(
    `SELECT id, dump_path, dest_ctx FROM db_snapshot
       WHERE project_id=$1 AND source='prod' AND status='finished'
       ORDER BY taken_at DESC OFFSET $2`, [projectId, Math.max(0, keep)]);
  for (const s of extra) {
    // Prune on the SAME host the dump lives on — deleting the local path for a NAS dump would
    // delete nothing (and quietly grow the NAS forever); this is regression 1's mirror image.
    await removeDumpFile(s);
    await q(`DELETE FROM db_snapshot WHERE id=$1`, [s.id]);
  }
  if (extra.length) {
    broadcast('task', { kind: 'db_snapshot_pruned', count: extra.length });
    logline('maint', `housekeeping removed ${extra.length} old backup(s) (keep ${keep})`);
  }
  return extra.length;
}

// Delete ONE backup on demand (the trash button in the backups modal), independent of retention:
// remove its dump file on whichever host it lives on, then its row. Refuses a still-running backup
// — that dump is mid-write, and "delete" is not "cancel"; wait for it to finish (or fail) first. A
// finished OR failed row is fine to drop (a failed one may have left a partial file — clean it up).
export async function deleteBackup(snapshotId) {
  const snap = await one(
    `SELECT id, project_id, dump_path, dest_ctx, status FROM db_snapshot WHERE id=$1`, [snapshotId]);
  if (!snap) throw new Error('backup not found');
  if (snap.status === 'running') {
    throw new Error('this backup is still running — wait for it to finish before deleting it');
  }
  await removeDumpFile(snap);
  await q(`DELETE FROM db_snapshot WHERE id=$1`, [snap.id]);
  broadcast('task', { kind: 'db_snapshot_deleted', id: snap.id, project_id: snap.project_id });
  logline('maint', `backup deleted → ${snap.dest_ctx ? `[${snap.dest_ctx}] ` : ''}${snap.dump_path || '(no file)'}`);
  return { ok: true, id: snap.id };
}

// Update a project's backup settings (folder / interval / retention), then apply housekeeping
// immediately so lowering max_backups takes effect at once.
export async function setBackupConfig({ project, backup_dir, backup_ctx, backup_interval_sec, max_backups, backup_tables }) {
  const proj = project || (await one(`SELECT id FROM project ORDER BY created_at LIMIT 1`))?.id;
  if (!proj) throw new Error('no project');
  const interval = Number(backup_interval_sec);
  const maxB = Number(max_backups);
  if (!Number.isInteger(interval) || interval < 60) throw new Error('backup_interval_sec must be an integer ≥ 60');
  if (!Number.isInteger(maxB) || maxB < 1 || maxB > 1000) throw new Error('max_backups must be an integer 1–1000');
  // The default table selection for this project's backups. [] ⇒ full-database dump (stored as NULL).
  const tables = validTableSelection(backup_tables, 'backup_tables');
  const dir = backup_dir && String(backup_dir).trim() ? String(backup_dir).trim() : null;
  const ctx = backup_ctx && String(backup_ctx).trim() ? String(backup_ctx).trim() : null;
  // A network destination is a docker CONTEXT + a directory on that context's host. A context
  // with no directory has nowhere to write — refuse it up front rather than at 3am mid-backup.
  if (ctx && !dir) throw new Error('a backup context needs a backup location (the directory on that context\'s host to write dumps into)');
  // Prove the context is REACHABLE now, so a typo/dead host is caught at Save — not discovered
  // four days later as a silent local fallback (regression 1). NULL context skips this (local).
  if (ctx) {
    try { await listContainersDetailed(ctx, 8000); }
    catch (e) { throw new Error(`backup context '${ctx}' is not reachable: ${e.message}. Fix the context or clear it to back up locally.`); }
  }

  const row = await one(
    `UPDATE pool_config SET backup_dir=$2, backup_ctx=$3, backup_interval_sec=$4, max_backups=$5, backup_tables=$6
       WHERE project_id=$1
       RETURNING backup_dir, backup_ctx, backup_interval_sec, max_backups, backup_tables`,
    [proj, dir, ctx, interval, maxB, tables.length ? JSON.stringify(tables) : null]);
  if (!row) throw new Error('no pool_config for project');

  broadcast('project', { id: proj, backup: row });
  logline('maint', `backup config → ${row.backup_ctx ? `[${row.backup_ctx}] ` : ''}dir=${row.backup_dir || '(default)'} every ${row.backup_interval_sec}s keep ${row.max_backups}`
    + `${tables.length ? ` · scoped to ${tables.length} table(s)` : ' · full database'}`);
  await housekeepBackups(proj, row.max_backups);
  return row;
}

// Reveal a backup in the host's file manager (Explorer / Finder / xdg). Looked up by id so
// only paths we actually recorded can be opened — no arbitrary path is ever passed through.
export async function revealBackup(snapshotId) {
  const snap = await one(`SELECT dump_path FROM db_snapshot WHERE id=$1`, [snapshotId]);
  if (!snap?.dump_path) throw new Error('backup not found');
  const path = resolve(snap.dump_path);
  if (process.platform === 'win32') {
    spawn('explorer.exe', [`/select,${path}`], { windowsHide: true }).on('error', () => {});
  } else if (process.platform === 'darwin') {
    spawn('open', ['-R', path]).on('error', () => {});
  } else {
    spawn('xdg-open', [dirname(path)]).on('error', () => {});
  }
  return { ok: true, path };
}

// ── RESTORE ───────────────────────────────────────────────────────────────────
// Kick off an async restore of a backup INTO a db container. Flags the container busy and returns
// immediately; the copy + pg_restore run in the background (runRestoreJob). Restoring over the
// PRODUCTION database is allowed but GATED: `confirmProd` must be set (the console makes the human
// type the prod db name), and prod must not be mid-ship / bound to a live zee.
export async function restoreBackup({ snapshot, container, confirmProd = false, tables = null }) {
  const snap = await one(`SELECT * FROM db_snapshot WHERE id=$1`, [snapshot]);
  if (!snap?.dump_path) throw new Error('backup not found');
  if (snap.status && snap.status !== 'finished') throw new Error('backup is not finished yet');
  // Optional per-restore table selection: restore ONLY these tables out of the archive. Empty/absent
  // ⇒ restore the whole dump (today's behaviour). Validated the same way the backup selection is.
  const pick = validTableSelection(tables, 'tables');
  // The archive can only yield what it captured. A scoped dump records its tables; refuse a pick that
  // asks for a table the dump does not contain rather than silently restoring nothing for it.
  const have = Array.isArray(snap.toc_summary?.tables) ? new Set(snap.toc_summary.tables) : null;
  if (pick.length && have) {
    const missing = pick.filter((t) => !have.has(t));
    if (missing.length === pick.length) {
      throw new Error(`none of the selected table(s) [${pick.join(', ')}] are in this backup `
        + `(it contains ${have.size} table(s)). Pick from the tables this dump captured.`);
    }
  }
  // A simulated backup is a ~150-byte placeholder, NOT the data — restoring it would overwrite a
  // real database with nothing. Refuse it (the UI disables the button too; this is the backstop).
  if (snap.mode === 'simulate') {
    throw new Error('this is a SIMULATED backup (a placeholder, not real data) — it cannot be restored over a database');
  }
  const c = await one(`SELECT * FROM container WHERE id=$1`, [container]);
  if (!c) throw new Error('container not found');
  if (c.role !== 'db') throw new Error(`target is not a db container (role=${c.role})`);
  // Restoring OVER production overwrites live data — irreversible. Two backstops behind the UI's
  // typed confirmation: the caller MUST pass confirmProd, and prod must be free (the same window
  // that blocks a backup — a ship deploying, or a live zee bound to prod — would be clobbered).
  if (c.tier === 'prod') {
    if (!confirmProd) {
      throw new Error('restoring over the PRODUCTION database requires explicit human confirmation');
    }
    const busy = await prodBusyReason(c.project_id);
    if (busy) {
      throw new Error(`refusing to restore over prod: ${busy} — a restore would clobber live prod work. `
        + 'Try again once prod is released.');
    }
  }
  if (c.busy_since) throw new Error('this container is busy (a backup/restore is already running)');

  const proj = await one(`SELECT name, db_name, db_user FROM project WHERE id=$1`, [c.project_id]);
  const dbName = proj?.db_name || config.prodDbName || proj?.name?.toLowerCase() || 'postgres';
  const dbUser = proj?.db_user || config.prodDbUser;

  await setBusy(c.id, 'restore');
  logline('maint', `restore started → ${c.name} from ${snap.dest_ctx ? `[${snap.dest_ctx}] ` : ''}${snap.dump_path} (${MODE})`
    + `${pick.length ? ` · ONLY ${pick.length} table(s): ${pick.join(', ')}` : ''}`);
  runRestoreJob({ snap, c, dbName, dbUser, tables: pick }).catch((e) => console.error('[restore]', e.message));
  return { ok: true, status: 'started', container: c.name };
}

// Remember what a database was loaded FROM (and clear any stale data-check verdict, which described
// the previous contents). `snapshotId` null = a live pipe with no snapshot in the middle
// ("Duplicate prod"), which the note then names. Never throws: bookkeeping must not fail a restore.
async function noteRestoredFrom(containerId, snapshotId, note = null, report = null) {
  try {
    const row = await one(
      `UPDATE container SET restored_from=$2, restored_at=now(), restored_note=$3,
                            restore_report=$4::jsonb, data_check=NULL, data_check_at=NULL
        WHERE id=$1 RETURNING *`,
      [containerId, snapshotId, note, report ? JSON.stringify(report) : null]);
    if (row) broadcast('container', row);
  } catch (e) {
    logline('maint', `could not record what ${containerId} was restored from: ${e.message}`);
  }
}

async function runRestoreJob({ snap, c, dbName, dbUser, tables = [] }) {
  let restored = false, report = null;
  const tArgs = restoreTableArgs(tables);   // [] ⇒ restore the whole archive
  const opLabel = c.name || c.id;
  const progressBase = { op: 'restore', id: c.id, project_id: c.project_id, label: opLabel };
  try {
    if (MODE === 'real') {
      const ctx = c.docker_ctx;
      const t = await resolveRunningContainer({ ...c });   // identity resolution (ctx + host_port)
      const target = t.name;
      broadcastDbOpProgress({ ...progressBase, msg: 'Starting restore…', pct: 5, status: 'running' });
      if (snap.dest_ctx) {
        // The dump lives on ANOTHER host (the NAS). Stream it straight into the target's pg_restore
        // stdin — same "never stage 1.2 GB on the queenzee host" principle as the backup. A reader
        // container on the destination cats the file; pg_restore reads the archive from stdin.
        broadcastDbOpProgress({ ...progressBase, msg: 'Reading backup archive…', pct: 15, status: 'running' });
        const i = Math.max(snap.dump_path.lastIndexOf('/'), snap.dump_path.lastIndexOf('\\'));
        const dir = snap.dump_path.slice(0, i), file = snap.dump_path.slice(i + 1);
        const piped = await execPipe(
          { cmd: 'docker', args: ['--context', snap.dest_ctx, 'run', '-i', '--rm', '-v', `${dir}:/out`, STREAM_IMAGE, 'cat', `/out/${file}`] },
          { cmd: 'docker', args: ['--context', ctx, 'exec', '-i', target, 'pg_restore', '-U', dbUser, '--clean', '--if-exists', '--no-owner', ...tArgs, '-d', dbName] },
          { timeout: 1800000 });
        // The READER is unconditional: if cat/the mount failed, no archive reached pg_restore at all.
        if (piped.srcStatus !== 0) {
          throw new Error(`streamed restore into ${target}/${dbName} from [${snap.dest_ctx}] failed to read the `
            + `archive (reader exit ${piped.srcStatus}): ${((piped.srcStderr || piped.dstStderr) || '').slice(-300)}`);
        }
        // pg_restore EXITS 1 WHEN IT MERELY IGNORED ERRORS (verified against a real restore), so exit
        // code alone cannot tell "never finished" from "finished with holes". Its own tally can. #30.
        report = restoreOutcome({ status: piped.dstStatus, stderr: piped.dstStderr });
        if (!report.ok) {
          throw new Error(`streamed restore into ${target}/${dbName} from [${snap.dest_ctx}] failed: `
            + `${report.reason}: ${((piped.dstStderr || piped.srcStderr) || '').slice(-300)}`);
        }
      } else {
        const remoteTmp = `/tmp/restore_${randomBytes(3).toString('hex')}.dump`;
        const cp = await execAsync('docker', ['--context', ctx, 'cp', resolve(snap.dump_path), `${target}:${remoteTmp}`], { timeout: 1200000 });
        if (cp.status !== 0) throw new Error(`docker cp into ${target} failed: ${(cp.stderr || '').slice(-300)}`);
        broadcastDbOpProgress({ ...progressBase, msg: 'Restoring database…', pct: 40, status: 'running' });
        const rest = await execAsync('docker',
          ['--context', ctx, 'exec', target, 'pg_restore', '-U', dbUser, '--clean', '--if-exists', '--no-owner', ...tArgs, '-d', dbName, remoteTmp],
          { timeout: 1800000 });
        await execAsync('docker', ['--context', ctx, 'exec', target, 'rm', '-f', remoteTmp], { timeout: 60000 });
        report = restoreOutcome({ status: rest.status, stderr: rest.stderr });
        if (!report.ok) {
          throw new Error(`pg_restore into ${target}/${dbName} failed: ${report.reason}: ${(rest.stderr || '').slice(-300)}`);
        }
      }
    } else {
      broadcastDbOpProgress({ ...progressBase, msg: 'Simulating restore…', pct: 30, status: 'running' });
      await wait(Math.round(SIM_RESTORE_MS * 0.7));   // simulate: show progress stepping
      broadcastDbOpProgress({ ...progressBase, msg: 'Restoring database…', pct: 65, status: 'running' });
      await wait(Math.round(SIM_RESTORE_MS * 0.3));
    }
    broadcastDbOpProgress({ ...progressBase, msg: 'Finalizing restore…', pct: 85, status: 'running' });
    // WHAT pg_restore SAID. A clean restore logs the plain line it always did; one that ignored errors
    // says so, with the first cause named — that is the half of #30 the row comparison cannot answer,
    // because a table can pass its counts and still have lost its indexes, its constraints or a trigger.
    const trouble = restoreErrorLine(report);
    logline('maint', trouble
      ? `restore finished → ${c.name}, BUT ${trouble}`
      : `restore finished → ${c.name}`);
    restored = true;
    // WHICH DUMP THIS DATABASE NOW IS. Recorded, not inferred: the data check compares a restored db
    // against the counts of ITS OWN source, and "probably the newest snapshot at the time" is exactly
    // the kind of guess this ticket exists to stop. A table-scoped restore says so, because then only
    // those tables came from this archive and a whole-db comparison would be meaningless.
    await noteRestoredFrom(c.id, snap.id,
      tables.length ? `restored ${tables.length} table(s) only: ${tables.join(', ')}` : null,
      report ? { ...report, at: new Date().toISOString(), snapshot_id: snap.id, scoped: tables.length > 0 } : null);
  } catch (e) {
    logline('maint', `restore FAILED → ${c.name}: ${e.message}`);
    broadcastDbOpProgress({ ...progressBase, msg: 'Restore failed', pct: 0, status: 'failed', error: e.message });
  } finally {
    await clearBusy(c.id);
  }
  if (restored) {
    broadcastDbOpProgress({ ...progressBase, msg: 'Restore complete', pct: 100, status: 'finished' });
  }
  // The catalog just changed under this db, so its prod_diff chip is stale. Re-measure it against
  // prod now that busy is cleared (the drift tick skips a mid-restore container, so it would not
  // have refreshed this on its own for up to 10 minutes). Best-effort and fire-and-forget: a failed
  // diff must never turn a SUCCESSFUL restore into a failure, and the human need not wait on it.
  if (restored) {
    refreshProdDiffAfterRestore(c.id)
      .catch((e) => logline('proddiff', `post-restore drift refresh for ${c.name} failed: ${e.message}`));
    // …and GRADE IT, without anyone asking (#30). A restore finishing is the one instant when the
    // source snapshot, the target database and the reason for both are all known at once — and the
    // whole point of this ticket family is that the failure is silent, which a check nobody runs also
    // is. A SCOPED restore is graded only over the tables it actually loaded: comparing the whole
    // database against the whole reference would report every untouched table as missing, which is the
    // false alarm that teaches a human to ignore the real one.
    gradeRestore(c, tables)
      .catch((e) => logline('datadiff', `post-restore data check for ${c.name} failed: ${e.message}`));
  }
}

// Grade a finished restore against the counts recorded for ITS OWN source snapshot. Fire-and-forget by
// construction: it runs after busy is cleared, it is awaited by nobody, and every failure is logged and
// swallowed — the same rule the backup counts follow, for the same reason. It never touches production
// (checkContainerData refuses a prod subject outright) and it never compares against live prod.
//
// WHAT A CLEAN RESULT DOES: one quiet line, and nothing else. No ping, no chip alarm, no dialog. The
// pool refreshes databases all day; a green announcement on every one of them is precisely how the one
// line that matters becomes invisible. The verdict is still PERSISTED, so a human who opens the chip
// sees it without re-counting anything — quiet is not the same as unrecorded.
async function gradeRestore(c, tables = []) {
  const r = await checkContainerData(c.id, { only: tables.length ? tables : null });
  if (!r?.ok) {
    // Not an alarm: "no reference counts on that snapshot" is the ordinary answer for any dump taken
    // before row counts existed, and for a live 'Duplicate prod' pipe there is no snapshot at all.
    logline('datadiff', `${c.name}: rows not graded after the restore — ${r?.error || 'unknown reason'}`);
    return r;
  }
  if (r.verdict === 'incomplete') {
    logline('datadiff', `⚠ ${c.name}: the restore is MISSING DATA — ${r.empty.length} table(s) empty and `
      + `${r.short.length} short of what its backup recorded: `
      + `${[...r.empty, ...r.short].slice(0, 5).map((x) => `${x.table} ${x.ref}→${x.got}`).join(', ')}`
      + `. Graded automatically the moment the restore finished; nobody had to ask.`);
  } else if (r.verdict === 'unverified') {
    logline('datadiff', `${c.name}: ${r.ok_count}/${r.checked} table(s) verified after the restore; `
      + `${r.missing.length} absent and ${r.unknown.length} with no reference count (not graded either way)`);
  } else {
    // The quiet case, said once and small.
    logline('datadiff', `${c.name}: rows check out after the restore (${r.ok_count}/${r.checked} tables)`);
  }
  return r;
}

// ── DUPLICATE PROD → a dev db (backup + restore, fused into one action) ─────────
// Make a dev database an exact copy of LIVE PRODUCTION in one go — what you'd otherwise do by
// taking a fresh prod backup and then restoring it here, done as a single streamed pipe:
//   pg_dump (prod) → pg_restore (dev)
// with NO dump file staged on any host (the dump is only bytes-in-transit through the queenzee,
// exactly like the network backup/restore path). A dev db is a throwaway copy; a KEPT artifact is
// what the backups panel is for, so this deliberately writes no db_snapshot row. Same guards as a
// prod backup — prod must be FREE (a pg_dump holds ACCESS SHARE on every table for its whole
// duration, so it must not contend with a live ship/hotfix) — and it REFUSES to target production
// itself (overwriting prod is the gated "Restore backup over prod" flow, never this).
export async function duplicateProdInto({ container }) {
  const c = await one(`SELECT * FROM container WHERE id=$1`, [container]);
  if (!c) throw new Error('container not found');
  if (c.role !== 'db') throw new Error(`target is not a db container (role=${c.role})`);
  if (c.tier === 'prod') {
    throw new Error('the target IS production — duplicate copies prod INTO another db, never over prod itself');
  }
  if (c.busy_since) throw new Error('this container is busy (a backup/restore is already running)');

  const project = await one(`SELECT * FROM project WHERE id=$1`, [c.project_id]);
  if (!project) throw new Error('no project');

  // The PRODUCTION db container to dump (modeled; resolved to its live versioned name in the job).
  const prodDbc = await one(
    `SELECT id, name, docker_ctx, host_port, tier, busy_since FROM container
       WHERE project_id=$1 AND role='db' AND tier='prod' AND isolation='shared'
       ORDER BY created_at LIMIT 1`, [c.project_id]);
  if (!prodDbc && MODE === 'real') {
    throw new Error('no production db container is modeled for this project — nothing to duplicate from');
  }
  if (prodDbc && prodDbc.id === c.id) {
    throw new Error('source and target are the same database — that IS production, nothing to duplicate');
  }
  if (prodDbc?.busy_since) throw new Error('the production database is busy (a backup/restore is already running)');

  // Don't dump prod while it's mid-ship or bound to a live zee — the same window that blocks a
  // scheduled backup. A dump would contend with live prod work.
  const busy = await prodBusyReason(c.project_id);
  if (busy) {
    throw new Error(`prod duplicate refused: ${busy} — a dump would contend with live prod work `
      + '(pg_dump locks every table for its duration). Try again once prod is released.');
  }

  // Prod and its dev copies share the project's db name/user (same database, different servers).
  const dbName = project.db_name || config.prodDbName || project.name.toLowerCase();
  const dbUser = project.db_user || config.prodDbUser;

  // Both endpoints spin while the copy runs: prod is being READ (busy_op='backup'), the target is
  // being OVERWRITTEN (busy_op='restore'). The chips spin and lock out builds for the duration, and
  // flagging prod busy serializes this against a concurrent scheduled backup of the same database.
  await setBusy(c.id, 'restore');
  if (prodDbc) await setBusy(prodDbc.id, 'backup');
  logline('maint', `duplicate prod → ${c.name} (${MODE})`);
  runDuplicateJob({ project, prodDbc, target: c, dbName, dbUser })
    .catch((e) => console.error('[duplicate]', e.message));
  return { ok: true, status: 'started', container: c.name };
}

async function runDuplicateJob({ project, prodDbc, target, dbName, dbUser }) {
  let restored = false, report = null;
  const progressBase = { op: 'duplicate', id: target.id, project_id: target.project_id, label: `${target.name} ← prod` };
  try {
    if (MODE === 'real') {
      // Resolve BOTH endpoints by IDENTITY (ctx + host_port), never name shape — the same rule the
      // backup/restore jobs follow, so a dev clone can never be mistaken for real prod (regression 2).
      const srcCtx = prodDbc.docker_ctx || (await resolveSite(project.id, 'prod'))?.docker_ctx || project.docker_ctx_prod;
      const src = await resolveRunningContainer({ ...prodDbc, docker_ctx: srcCtx });
      const dstCtx = target.docker_ctx;
      const dst = await resolveRunningContainer({ ...target });
      broadcastDbOpProgress({ ...progressBase, msg: 'Dumping production…', pct: 20, status: 'running' });
      // Stream pg_dump (prod) straight into pg_restore (dev). --clean --if-exists --no-owner mirror
      // the restore job: drop-and-recreate every object, ignore prod's role grants on the dev server.
      const piped = await execPipe(
        { cmd: 'docker', args: ['--context', srcCtx, 'exec', src.name, 'pg_dump', '-U', dbUser, '-Fc', '-d', dbName] },
        { cmd: 'docker', args: ['--context', dstCtx, 'exec', '-i', dst.name, 'pg_restore', '-U', dbUser, '--clean', '--if-exists', '--no-owner', '-d', dbName] },
        { timeout: 1800000 });
      // The SOURCE side is unconditional: a failed pg_dump means nothing reached the target.
      if (piped.srcStatus !== 0 || piped.timedOut) {
        const why = piped.timedOut ? 'timed out' : `pg_dump exit ${piped.srcStatus}`;
        throw new Error(`duplicate prod → ${target.name} failed (${why}): `
          + `${((piped.srcStderr || piped.dstStderr) || '(no output)').slice(-300)}`);
      }
      // …and the target side reads pg_restore's OWN tally rather than its exit code, which is 1 for a
      // restore that merely ignored errors (#30). A duplicate that landed with holes is still a
      // duplicate, and saying "failed" about it loses both the data and the reason.
      report = restoreOutcome({ status: piped.dstStatus, stderr: piped.dstStderr });
      if (!report.ok) {
        throw new Error(`duplicate prod → ${target.name} failed: ${report.reason}: `
          + `${((piped.dstStderr || piped.srcStderr) || '(no output)').slice(-300)}`);
      }
      broadcastDbOpProgress({ ...progressBase, msg: 'Copy complete, validating…', pct: 85, status: 'running' });
    } else {
      broadcastDbOpProgress({ ...progressBase, msg: 'Simulating duplicate…', pct: 35, status: 'running' });
      await wait(Math.round(SIM_RESTORE_MS * 0.6));
      broadcastDbOpProgress({ ...progressBase, msg: 'Piping production to target…', pct: 70, status: 'running' });
      await wait(Math.round(SIM_RESTORE_MS * 0.4));
    }
    const trouble = restoreErrorLine(report);
    logline('maint', trouble ? `duplicate finished → ${target.name}, BUT ${trouble}`
                             : `duplicate finished → ${target.name}`);
    restored = true;
    // No snapshot in the middle — this WAS live prod, piped. Record that rather than leaving a stale
    // "restored from last night's dump" behind it: the data check needs to know it has no recorded
    // reference for this db and must say so instead of grading it against the wrong dump.
    // No snapshot in the middle, so there is nothing to GRADE against — but the tally still applies,
    // and it is the only signal this path has. Recorded for exactly that reason.
    await noteRestoredFrom(target.id, null,
      'duplicated LIVE production (a direct pg_dump → pg_restore pipe; no snapshot, so no recorded row counts)',
      report ? { ...report, at: new Date().toISOString(), snapshot_id: null, scoped: false } : null);
  } catch (e) {
    logline('maint', `duplicate FAILED → ${target.name}: ${e.message}`);
    broadcastDbOpProgress({ ...progressBase, msg: 'Duplicate failed', pct: 0, status: 'failed', error: e.message });
  } finally {
    await clearBusy(target.id);
    if (prodDbc) await clearBusy(prodDbc.id);
  }
  if (restored) {
    broadcastDbOpProgress({ ...progressBase, msg: 'Duplicate complete', pct: 100, status: 'finished' });
  }
  // The target's catalog just changed — its prod_diff chip is stale. Re-measure now that busy is
  // cleared (a fresh copy of prod SHOULD read as in-sync). Best-effort and fire-and-forget: a failed
  // diff must never turn a SUCCESSFUL duplicate into a failure.
  if (restored) {
    refreshProdDiffAfterRestore(target.id)
      .catch((e) => logline('proddiff', `post-duplicate drift refresh for ${target.name} failed: ${e.message}`));
  }
}

// On startup no job from a previous process can still be running: mark any 'running' backup failed
// (drop its partial file) and clear every busy container, so nothing is stuck spinning forever.
export async function reconcileInterruptedJobs() {
  const snaps = await q(
    `UPDATE db_snapshot SET status='failed', error=COALESCE(error,'interrupted by server restart')
       WHERE status='running' RETURNING id, dump_path, dest_ctx`);
  for (const s of snaps) {
    if (!s.dump_path) continue;
    if (s.dest_ctx) {
      const i = Math.max(s.dump_path.lastIndexOf('/'), s.dump_path.lastIndexOf('\\'));
      await removeRemoteFile(s.dest_ctx, s.dump_path.slice(0, i), s.dump_path.slice(i + 1));
    } else {
      try { rmSync(s.dump_path, { force: true }); } catch { /* gone */ }
    }
  }
  const cons = await q(`UPDATE container SET busy_since=NULL, busy_op=NULL WHERE busy_since IS NOT NULL RETURNING id`);
  if (snaps.length || cons.length) {
    logline('maint', `startup: cleared ${snaps.length} interrupted backup(s) + ${cons.length} busy container(s)`);
  }
  return { backups: snaps.length, containers: cons.length };
}

// Is a fresh prod backup due for this project, and WHY — ticket #26.
//
// It used to be one question ("is the newest attempt, of any status, older than the policy interval?")
// and that let a FAILED attempt SATISFY its window: one failure pushed the next good dump out by a full
// interval, two in a row cost a day with no restore point, silently. Now a failure schedules a RETRY
// interval instead (lib/backup-schedule.js: 10 min, doubling per consecutive failure, capped at the
// policy interval so it can only ever be sooner than the old behaviour, never later).
//
// The FAILURE STREAK is read from the ledger rather than held in memory: the incident that produced
// this ticket was a server restart, and state that forgets across a restart is state that forgets
// exactly when it matters. Returns the whole decision so the caller can log the reason it acted on.
export async function backupDue(projectId, now = Date.now()) {
  const cfg = await one(`SELECT backup_interval_sec FROM pool_config WHERE project_id=$1`, [projectId]);
  const interval = cfg?.backup_interval_sec ?? DEFAULT_INTERVAL_SEC;
  const lastAttempt = await one(
    `SELECT id, taken_at, status FROM db_snapshot WHERE project_id=$1 AND source='prod'
      ORDER BY taken_at DESC LIMIT 1`, [projectId]);
  const lastGood = await one(
    `SELECT id, taken_at FROM db_snapshot WHERE project_id=$1 AND source='prod' AND status='finished'
      ORDER BY taken_at DESC LIMIT 1`, [projectId]);
  // Consecutive failures SINCE the last success — the backoff's exponent. Counted in SQL so a restart
  // cannot reset it back to "first retry" and start the 10-minute cadence over.
  const streak = await one(
    `SELECT count(*)::int AS n FROM db_snapshot
      WHERE project_id=$1 AND source='prod' AND status='failed'
        AND ($2::timestamptz IS NULL OR taken_at > $2::timestamptz)`,
    [projectId, lastGood?.taken_at ?? null]);

  return backupDecision({ lastAttempt, lastGood, failStreak: streak?.n ?? 0, intervalSec: interval, now });
}

// Tell a human that PRODUCTION'S RESTORE POINT IS STALE, at most once per policy interval, and tell
// them once when it recovers. All decisions are in lib/backup-schedule.js (pure, and tested with
// explicit clocks); this is only the plumbing plus the persistence of "who has been told".
//
// BEST-EFFORT, ABSOLUTELY: it is called from the tick, never from a backup job, every failure is
// swallowed, and it writes nothing except its own alert bookkeeping. A notifier that can fail a backup
// is worse than no notifier — the dump is the product.
// Exported for the test: the once-per-interval bound and the recovery ping live in pool_config, not in
// the pure decision, so the BOOKKEEPING has to be exercised against a real database or the storm control
// for the alert itself is unproven.
export async function checkBackupFreshness(projectId, now = Date.now()) {
  try {
    const cfg = await one(
      `SELECT backup_interval_sec, backup_alerted_at, backup_alert_open FROM pool_config WHERE project_id=$1`,
      [projectId]);
    const interval = cfg?.backup_interval_sec ?? DEFAULT_INTERVAL_SEC;
    const lastGood = await one(
      `SELECT id, taken_at FROM db_snapshot WHERE project_id=$1 AND source='prod' AND status='finished'
        ORDER BY taken_at DESC LIMIT 1`, [projectId]);
    const d = staleAlertDecision({
      lastGood, intervalSec: interval,
      alertedAt: cfg?.backup_alerted_at ?? null, alertOpen: !!cfg?.backup_alert_open, now });
    if (!d.fire && !d.clear) return d;

    const project = await one(`SELECT id, name FROM project WHERE id=$1`, [projectId]);
    if (d.fire) {
      const streak = await one(
        `SELECT count(*)::int AS n FROM db_snapshot
          WHERE project_id=$1 AND source='prod' AND status='failed' AND taken_at > $2::timestamptz`,
        [projectId, lastGood.taken_at]);
      logline('maint', `⚠ ${project?.name || projectId}: PROD RESTORE POINT IS STALE — ${d.reason}. `
        + 'Telling a human off-screen (a stale restore point is not visible to anyone who is not looking '
        + 'at the panel, which is how this went unnoticed for 27 hours).');
      notifyBackupStale({
        project, ageHours: Math.round(d.ageSec / 3600), thresholdHours: Math.round(d.thresholdSec / 3600),
        lastGoodAt: lastGood.taken_at, failStreak: streak?.n ?? 0 });
      await q(`UPDATE pool_config SET backup_alerted_at=now(), backup_alert_open=true WHERE project_id=$1`, [projectId]);
    } else {
      logline('maint', `${project?.name || projectId}: ${d.reason}`);
      notifyBackupRecovered({ project, ageMinutes: Math.round(d.ageSec / 60) });
      await q(`UPDATE pool_config SET backup_alert_open=false WHERE project_id=$1`, [projectId]);
    }
    return d;
  } catch (e) {
    // Never propagates: this runs beside the backup decision, and an alerting bug must not be able to
    // stop backups from being taken.
    logline('maint', `backup-freshness check failed (backups unaffected): ${e.message}`);
    return null;
  }
}

// Refresh pooled db-isolated xells that have gone stale, from the latest FINISHED prod snapshot.
export async function refreshStaleXellDbs(projectId) {
  const cfg = await one(`SELECT refresh_interval_sec FROM pool_config WHERE project_id=$1`, [projectId]);
  const snap = await one(
    `SELECT * FROM db_snapshot WHERE project_id=$1 AND status='finished' ORDER BY taken_at DESC LIMIT 1`, [projectId]);
  if (!snap) return [];
  const stale = await q(
    `SELECT * FROM xell
       WHERE project_id=$1 AND is_pooled AND db_coupling='db-isolated' AND status='ready'
         AND (ready_at IS NULL OR ready_at < now() - ($2 || ' seconds')::interval)`,
    [projectId, cfg?.refresh_interval_sec ?? 3600]);

  const done = [];
  for (const xell of stale) {
    const ref = await one(
      `INSERT INTO db_refresh (xell_id, snapshot_id, method, started_at, status)
       VALUES ($1,$2,$3, now(),'running') RETURNING *`,
      [xell.id, snap.id, MODE === 'real' ? 'pg_restore' : 'simulate']);
    // spin this xell's own db container (if it has one) for the duration of the refresh
    const dbc = await one(
      `SELECT c.id FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
        WHERE uc.xell_id=$1 AND c.role='db' LIMIT 1`, [xell.id]);
    if (dbc) await setBusy(dbc.id, 'restore');
    // real mode would pg_restore snap.dump_path into this xell's per-slug postgres here
    if (dbc) await clearBusy(dbc.id);
    const fin = await one(
      `UPDATE db_refresh SET finished_at=now(), status='finished' WHERE id=$1 RETURNING *`, [ref.id]);
    await q(`UPDATE xell SET last_synced_commit=head_commit, ready_at=now() WHERE id=$1`, [xell.id]);
    done.push(fin);
  }
  if (done.length) logline('maint', `refreshed ${done.length} isolated xell DB(s) from ${snap.dump_path}`);
  return done;
}

export function startMaintenance() {
  reconcileInterruptedJobs().catch((e) => console.error('[maintenance] reconcile', e.message));
  if (process.env.MAINTENANCE_ENABLED !== 'true') {
    console.log('[queenzee] maintenance scheduler idle (set MAINTENANCE_ENABLED=true to arm)');
    return null;
  }
  console.log(`[queenzee] maintenance scheduler armed (mode=${MODE}, tick=${config.maintTickMs}ms)`);
  // Deferral memory: reason we last logged per project, so a held lock logs ONCE when the
  // deferral starts and once when prod frees up — not every 60s tick in between.
  const deferred = new Map();
  // What we last SAID about a retry, per project, so a 10-minute retry window does not print a line
  // every 60-second tick. Log noise is the same disease as alert noise, one screen down.
  const saidRetry = new Map();
  const tick = async () => {
    try {
      const projects = await q(`SELECT id FROM project`);
      for (const p of projects) {
        const d = await backupDue(p.id);
        if (d.due) {
          const busy = await prodBusyReason(p.id);
          if (busy) {
            if (deferred.get(p.id) !== busy) {
              deferred.set(p.id, busy);
              logline('maint', `prod backup DEFERRED — ${busy}. It runs on the first tick after prod is released.`);
            }
          } else {
            if (deferred.delete(p.id)) logline('maint', 'prod is free again — running the deferred backup now');
            // A RETRY says so, and says which attempt it is: the whole point of #26 is that a failure
            // brings the next attempt forward, and that has to be visible when it happens.
            if (d.kind === 'retry') logline('maint', `prod backup RETRY — ${d.reason}`);
            saidRetry.delete(p.id);
            await backupProd(p.id).catch((e) => {   // starts an async job; may no-op if one runs
              if (!/already running/.test(e.message)) throw e;
            });
          }
        } else if (d.kind === 'retry' && saidRetry.get(p.id) !== d.dueAt) {
          // Not due YET, but a retry is scheduled — say it ONCE per schedule, so an operator watching
          // the terminal can see the backoff working instead of silence.
          saidRetry.set(p.id, d.dueAt);
          logline('maint', `prod backup will RETRY in ${Math.ceil(d.waitSec / 60)} min — ${d.reason}`);
        }
        // Alerting runs on EVERY tick, not only when a backup is due: the whole failure was that
        // nothing spoke while nothing was happening. It never throws and never touches the dump.
        await checkBackupFreshness(p.id);
        await refreshStaleXellDbs(p.id);
      }
    } catch (e) { console.error('[maintenance]', e.message); }
  };
  // Short tick; each project backs up only when its interval has elapsed (backupDue).
  return setInterval(tick, config.maintTickMs);
}
