// READINESS PREFLIGHT — OPEN WHAT THE QUEENZEE WROTE, BEFORE ANYONE CALLS THIS XELL READY (#53).
//
// The queenzee projects a xell's environment out of meta-DB rows (provision.emitXellEnv) and then
// declares the xell ready. Migrations 078/082 record whether the FILE was written; nothing has ever
// opened what is IN it. Those are two different facts, and the gap is expensive: across one
// manager's crew of thirteen in one night, SEVEN workers independently discovered that the
// DATABASE_URL they had been handed is rejected by the shared dev db ("password authentication
// failed for user zeehive" — ticket #47). Two never worked around it, ran three hours, verified
// nothing and landed nothing. Every projection column was green throughout.
//
// So this module OPENS the DSN — the same string, from the same resolveXellDsn the emitter uses,
// with the role that is in it — runs `SELECT 1`, and stamps the verdict on the xell row where a
// human (console chip) and a zee (`zee status`) both see it.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   • It never WRITES to a database it is checking. `SELECT 1` and nothing else — a preflight that
//     created a temp table to prove writability would be a preflight that can damage what it checks.
//   • It never opens a WRITE bind to PRODUCTION. A xell coupled db-shared-prod holds the prod
//     owner's credential and is reported as SKIPPED, with the reason, rather than probed. A skipped
//     check that says so is information; a silently absent one is not. The READ-ONLY bind
//     (db-prod-readonly) is a different thing and IS probed: its DSN is the SELECT-only role
//     lib/prod-readonly.js minted for this xell, so `SELECT 1` through it cannot damage anything —
//     and it is the only proof there is that the binding the zee was handed actually opens. Not
//     opening it is what left a manager's binding unproven while its recorded verdict described the
//     shared dev db it no longer names.
//   • It never tries to FIX a credential (that is ticket #47 and a human's). Its whole job is to
//     make the fault impossible to miss.
//   • It never throws. A preflight that can fail the caller would be a new way to fail provisioning,
//     which is a worse bug than the one it exists to catch.
//
// Every probe is BOUNDED (PREFLIGHT_TIMEOUT_MS): a preflight that hangs is worse than none, and the
// exact fault it hunts — an unreachable or unauthenticated database — is the one most likely to hang.
import pg from 'pg';
import { q, one } from '../db/pool.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { resolveXellDsn } from './provision.js';
import { PRODRO_MODE } from './prod-readonly.js';
import { DB_CONTENT_SQL, dbContentVerdict } from './row-counts.js';

export const PREFLIGHT_TIMEOUT_MS = 5000;

// `extra` is additive: a caller that must CLASSIFY a failure rather than print it (the
// build-readiness probe, which turns "this db does not open" into a machine verdict) gets the
// structured half of the same fact on the row. The preflight path itself reads ok/detail only.
const pass = (check, detail, extra = {}) => ({ check, ok: true, skipped: false, detail, ...extra });
const fail = (check, detail, extra = {}) => ({ check, ok: false, skipped: false, detail, ...extra });
// A skipped check is `ok` — it asserts nothing, so it must not flip a xell to unusable — but it
// carries WHY, because "production is never opened by a preflight" is an answer, not an absence.
const skip = (check, detail) => ({ check, ok: true, skipped: true, detail });

// The role the DSN would authenticate as, and where it points — for the message, never for a
// decision. Passwords are never echoed: the failure a human needs to read is "user X was rejected
// by host Y", and quoting the secret back at them adds nothing but a leak.
export function dsnIdentity(dsn) {
  try {
    const u = new URL(String(dsn).replace(/^postgres(ql)?:/, 'http:'));
    return { role: decodeURIComponent(u.username || '') || null,
             where: `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || ''}` };
  } catch { return { role: null, where: null }; }
}

// CHECK 1 — the DSN the queenzee wrote actually opens, as the role it wrote, and answers SELECT 1.
// This one check is most of the value of the whole preflight.
export async function checkDsnOpens(dsn, { timeout = PREFLIGHT_TIMEOUT_MS } = {}) {
  const { role, where } = dsnIdentity(dsn);
  const who = `role ${role || '(none in dsn)'} at ${where || '(unparseable dsn)'}`;
  const client = new pg.Client({
    connectionString: dsn,
    connectionTimeoutMillis: timeout,
    // The read half of the bound: connectionTimeoutMillis only covers the CONNECT. A database that
    // accepts a socket and then never answers would hang here forever without these two.
    query_timeout: timeout,
    statement_timeout: timeout,
    application_name: 'zeehive-preflight',
  });
  try {
    await client.connect();
    const r = await client.query('SELECT 1 AS one');
    if (r.rows?.[0]?.one !== 1) return fail('db-open', `${who}: opened, but SELECT 1 did not answer 1`);
    return pass('db-open', `${who}: opened and answered SELECT 1`);
  } catch (e) {
    // The driver's own message, with the pg SQLSTATE when there is one (28P01 = the ticket #47
    // credential fault) — a human triaging wants the code, not our paraphrase of it.
    //
    // `code` is the structured half of that same sentence, for a caller that must decide what the
    // failure MEANS rather than show it (build-readiness.js):
    //   • a code → the attempt reached a verdict — 28P01 rejected us, ECONNREFUSED nothing is
    //     listening, ENOTFOUND the name does not resolve. Definitive.
    //   • no code → OUR OWN bound ended it. pg's connectionTimeoutMillis destroys the socket with
    //     a bare `Error('timeout expired')`, and a query_timeout gives no SQLSTATE either: nobody
    //     told us anything, so it is a cannot-tell, never a refusal.
    return fail('db-open', `${who}: ${e.code ? `[${e.code}] ` : ''}${e.message}`,
                { code: e.code || null });
  } finally {
    // end() on a client that never connected rejects; the check's verdict is already decided.
    try { await client.end(); } catch { /* nothing left to close */ }
  }
}

// CHECK 2 — WHAT IS IN IT. db-open proves the BINDING (the DSN opens as the role it names); it says
// nothing about the CONTENT, and the two are different failures an operator must be able to tell
// apart. A worker assigned to exercise role/permission code was handed a throwaway db that opened
// perfectly and had no rows to grant a role on: the clone came out schema-only, the verdict said
// "opened and answered SELECT 1", and the zee burned its turn discovering the emptiness by hand.
// The honest Zeehive half of that is not the missing rows (that is another project's data) — it is
// that the verdict must SAY SO, and name the verb that refills it.
//
// So: one catalog read (lib/row-counts.js › DB_CONTENT_SQL — relation sizes, no table scanned) on the
// SAME DSN, reported as its own named check. The check is `ok` either way and carries `warning: true`
// when the database holds no data, because:
//   • the binding IS proven — nothing about it is broken, and calling it "not ready" would refuse
//     dispatch (readiness_proof='required') to the one zee that can run the remedy;
//   • the remedy is the zee's own verb (`zee db-catchup --restore` for a db-isolated copy), so the
//     zee has to be told, not stopped;
//   • a schema-only database is legitimate for schema work — the wording says what it means for a
//     job that needs rows, and never pretends the two cases are one.
// A probe that cannot run (unreachable, timeout, a role with no rights to read the catalog) returns
// null: an unprobeable database asserts nothing and must never be reported as empty.
export async function checkDbContent(dsn, { coupling = null, timeout = PREFLIGHT_TIMEOUT_MS } = {}) {
  const client = new pg.Client({
    connectionString: dsn,
    connectionTimeoutMillis: timeout,
    query_timeout: timeout,
    statement_timeout: timeout,
    application_name: 'zeehive-preflight',
  });
  let row = null;
  try {
    await client.connect();
    const r = await client.query(DB_CONTENT_SQL);
    row = r.rows?.[0] || null;
  } catch { return null; } finally {
    try { await client.end(); } catch { /* nothing left to close */ }
  }
  if (!row) return null;
  const v = dbContentVerdict(row);
  const count = `${v.tables} application table(s)`;
  if (v.level === 'data') {
    const rows = v.rows != null ? `, ~${v.rows} row(s)` : ', row counts not known (nothing analyzed)';
    return pass('db-data', `the database holds data — ${count}${rows}`);
  }
  const shape = v.level === 'empty'
    ? `the database holds NO application tables at all — ${count}: an empty or never-initialized `
      + 'database, not a copy of anything'
    : `the database is SCHEMA-ONLY — ${count}, and not one of them holds a byte (0 rows)`;
  return {
    ...pass('db-data', `${shape}. This is NOT a refusal: the DSN opened, so the binding is proven — `
      + `this is a fact about the CONTENTS of the database this xell was handed. ${contentRemedy(coupling, v.level)}`),
    warning: true,
  };
}

// The remedy, by HOW this xell got its database — a remedy that does not exist for the coupling it
// is printed under is worse than none (it sends a zee at a verb that will refuse it).
// db-catchup --restore is the one verb that rebuilds a database from prod's latest snapshot, and it
// is offered for db-isolated only (an isolated db HAS a source snapshot; a clone has none).
export function contentRemedy(coupling, level) {
  const what = level === 'empty' ? 'an empty database' : 'a schema-only database';
  if (coupling === 'db-isolated') {
    return `This xell's db is its own restored copy: run \`zee db-catchup --restore\` to rebuild it `
      + `from the latest prod snapshot (schema AND data — it DISCARDS what is in your database now).`;
  }
  if (coupling === 'db-clone') {
    return 'This xell holds a CLONE cut from the shared dev template, so the emptiness came with the '
      + 'copy: `zee db-catchup --restore` is not offered for a clone (it is for db-isolated) — '
      + '`zee db-catchup` still rolls its SCHEMA forward, and the data gap is the template\'s, which '
      + 'is a human\'s to re-cut: say so with `zee tend --reason "…"`.';
  }
  if (coupling === 'db-shared-dev') {
    return 'This xell is bound to the project\'s SHARED dev database, so this is the shared db\'s '
      + 'state and not a copy of yours: nothing a zee can run refills it (`zee db-catchup` refuses a '
      + 'shared dev db by design). Raise it with `zee tend --reason "…"` — and if your job needs '
      + 'rows, that is your blocker, not your bug.';
  }
  return `If your job needs rows, you were handed ${what} and nothing to work on: raise it with `
    + '`zee tend --reason "…"` — and `zee db-catchup --restore` rebuilds a db-isolated copy from '
    + 'prod\'s latest snapshot.';
}

// Run every readiness check for one xell and return the verdict. Never throws.
export async function preflightXell(xellId, { timeout = PREFLIGHT_TIMEOUT_MS } = {}) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) return { ok: false, error: 'no such xell', checks: [] };
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  // The same rows writeXellEnv reads, so resolveXellDsn answers the same string the zee was handed.
  const containers = await q(
    `SELECT role, host_port, conn_ref, conn_pw, docker_ctx FROM container
      WHERE owner_xell_id=$1 AND role IN ('server','webapp','db')`, [xellId]);

  const checks = [];
  let resolved = null;
  try {
    resolved = await resolveXellDsn(xell, project, containers);
  } catch (e) {
    // Resolution itself failing IS a readiness fault — the zee would be handed no DATABASE_URL and
    // no reason — so it is reported as the check, not swallowed.
    checks.push(fail('db-open', `could not resolve this xell's DSN: ${e.message}`));
  }
  if (resolved) checks.push(...(await dsnCheck(xell, resolved, { timeout })));

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: !failed.length,
    // The failing check, NAMED. "not ready" without which check failed sends a human looking, which
    // is the cost this whole thing exists to remove. More than one → all of them, in order.
    error: failed.length ? failed.map((c) => `${c.check}: ${c.detail}`).join(' · ') : null,
    checks,
  };
}

// The db-open check (and, when it opens, the db-data content profile beside it), plus the two states
// where opening is the WRONG thing to do. Returns an ARRAY of checks.
async function dsnCheck(xell, { dsn, source, binding_is_prod: bindingIsProd }, { timeout }) {
  const roReader = xell.db_coupling === 'db-prod-readonly';
  if (bindingIsProd && !roReader) {
    return [skip('db-open', `binding is production (${xell.db_coupling}) — a preflight never opens `
      + 'the live database; a human granted this bind and only they may exercise it')];
  }
  if (roReader && PRODRO_MODE === 'simulate') {
    // The read-only DSN IS probed (below) because it is a minted SELECT-only role, not the owner's
    // credential. In PRODRO_MODE=simulate that role was never created and the DSN it stored here is
    // a deliberate fake — so probing it would report a credential fault the binding does not have.
    // It is the SAME concession every other prod-touching path makes in simulate, and it says so.
    return [skip('db-open', 'the read-only production reader is SIMULATED (PRODRO_MODE=simulate): no '
      + 'role was minted on the cluster, so there is nothing to open — the binding is unproven, not failed')];
  }
  if (!dsn) {
    // Not a fault by itself: a pooled xell may have no db row yet, and a db-shared-dev xell with
    // NO shared dev db linked has nothing to project. (A db-shared-dev xell WITH its shared dev db
    // linked now DOES get a DATABASE_URL — resolveXellDsn emits the used container's conn_ref for
    // every runner type — so this branch is the genuinely db-less states only.) Reported as
    // skipped-with-a-reason so the absence is visible rather than invented as either a pass or a
    // failure.
    return [skip('db-open', `no DATABASE_URL is projected for this xell (coupling ${xell.db_coupling || 'none'})`)];
  }
  const r = await checkDsnOpens(dsn, { timeout });
  const opened = { ...r, detail: `${r.detail} (dsn source: ${source || 'unknown'})` };
  // Only after it OPENED: probing the contents of a database we could not open would be a second
  // failure dressed as a finding (and a listing of what the DSN failed to reach). A skipped open
  // (production, untargeted-projection) is not an open either — nothing is dialled twice.
  if (!r.ok || r.skipped) return [opened];
  const content = await checkDbContent(dsn, { coupling: xell.db_coupling, timeout });
  return content ? [opened, content] : [opened];
}

// Stamp the verdict on the xell row. Never throws, and never lets bookkeeping about a check become a
// second way for the check to fail — the same rule provision.noteEnvProjection follows. Broadcasts
// only when the ERROR STATE changes, so a fleet-wide sweep of healthy xells is silent on the stream.
export async function notePreflight(xellId, verdict) {
  try {
    const prev = await one(`SELECT preflight_error FROM xell WHERE id=$1`, [xellId]);
    if (!prev) return verdict;
    const row = await one(
      `UPDATE xell SET preflight_at = now(), preflight_error = $2, preflight_checks = $3::jsonb
        WHERE id=$1 RETURNING *`,
      [xellId, verdict.error || null, JSON.stringify(verdict.checks || [])]);
    if (row && (prev.preflight_error || null) !== (verdict.error || null)) broadcast('xell', row);
  } catch { /* the check itself matters more than the note about it */ }
  return verdict;
}

// Run the preflight AND record it — what every caller wants. Never throws: a xell whose preflight
// could not run is reported, not a provision that failed.
export async function runPreflight(xellId, { timeout = PREFLIGHT_TIMEOUT_MS } = {}) {
  let verdict;
  try {
    verdict = await preflightXell(xellId, { timeout });
  } catch (e) {
    verdict = { ok: false, error: `preflight: ${e.message}`, checks: [] };
  }
  await notePreflight(xellId, verdict);
  const warns = (verdict.checks || []).filter((c) => c.warning);
  if (!verdict.ok || warns.length) {
    const x = await one(`SELECT slug FROM xell WHERE id=$1`, [xellId]).catch(() => null);
    const who = x?.slug || xellId;
    if (!verdict.ok) logline('preflight', `${who}: NOT READY — ${verdict.error}`);
    // A warning is not a failure, so it must not wear the NOT READY line — but a database that
    // opened and holds nothing is exactly the state nobody must have to discover by hand, so it is
    // written where the queenzee log keeps it. Said once per preflight, never as a "pass".
    if (warns.length) logline('preflight', `${who}: WARNING — ${warns.map((c) => `${c.check}: ${c.detail}`).join(' · ')}`);
  }
  return verdict;
}
