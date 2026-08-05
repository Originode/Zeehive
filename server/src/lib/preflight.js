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
//   • It never opens PRODUCTION. A xell coupled db-shared-prod / db-prod-readonly is reported as
//     SKIPPED, with the reason, rather than probed. A skipped check that says so is information; a
//     silently absent one is not.
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

export const PREFLIGHT_TIMEOUT_MS = 5000;

const pass = (check, detail) => ({ check, ok: true, skipped: false, detail });
const fail = (check, detail) => ({ check, ok: false, skipped: false, detail });
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
    return fail('db-open', `${who}: ${e.code ? `[${e.code}] ` : ''}${e.message}`);
  } finally {
    // end() on a client that never connected rejects; the check's verdict is already decided.
    try { await client.end(); } catch { /* nothing left to close */ }
  }
}

// Run every readiness check for one xell and return the verdict. Never throws.
export async function preflightXell(xellId, { timeout = PREFLIGHT_TIMEOUT_MS } = {}) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) return { ok: false, error: 'no such xell', checks: [] };
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);
  // The same rows writeXellEnv reads, so resolveXellDsn answers the same string the zee was handed.
  const containers = await q(
    `SELECT role, host_port, conn_ref, docker_ctx FROM container
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
  if (resolved) checks.push(await dsnCheck(xell, resolved, { timeout }));

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: !failed.length,
    // The failing check, NAMED. "not ready" without which check failed sends a human looking, which
    // is the cost this whole thing exists to remove. More than one → all of them, in order.
    error: failed.length ? failed.map((c) => `${c.check}: ${c.detail}`).join(' · ') : null,
    checks,
  };
}

// The db-open check, plus the two states where opening is the WRONG thing to do.
async function dsnCheck(xell, { dsn, source, binding_is_prod: bindingIsProd }, { timeout }) {
  if (bindingIsProd) {
    return skip('db-open', `binding is production (${xell.db_coupling}) — a preflight never opens `
      + 'the live database; a human granted this bind and only they may exercise it');
  }
  if (!dsn) {
    // Not a fault by itself: a compose-runner xell on the shared dev db legitimately gets no
    // DATABASE_URL (its stack resolves the db by network alias), and a pooled xell may have no db
    // row yet. Reported as skipped-with-a-reason so the absence is visible rather than invented as
    // either a pass or a failure.
    return skip('db-open', `no DATABASE_URL is projected for this xell (coupling ${xell.db_coupling || 'none'})`);
  }
  const r = await checkDsnOpens(dsn, { timeout });
  return { ...r, detail: `${r.detail} (dsn source: ${source || 'unknown'})` };
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
  if (!verdict.ok) {
    const x = await one(`SELECT slug FROM xell WHERE id=$1`, [xellId]).catch(() => null);
    logline('preflight', `${x?.slug || xellId}: NOT READY — ${verdict.error}`);
  }
  return verdict;
}
