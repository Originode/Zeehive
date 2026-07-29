// ADDING A MANAGER ZEE — a HUMAN act, unlimited.
//
// There is no cap and no pool for managers: add as many as you can afford to run. But only a human
// may add one. A manager that could mint managers is a fleet that grows sideways with nobody's
// consent, so `zee dispatch` refuses the type outright (queenzee/self.js) and this path is reachable
// only from the console (POST /api/managers) or an operator's CLI.
//
// What "adding" actually does, in order:
//   1. take a ready xell (provisioning one on demand if the pool is dry) — a manager is a real xell
//      with a real hexagon, not a special case floating outside the honeycomb;
//   2. stamp zee_type='manager' (the 052 guard then forbids it being managed, and landgate/xellgit
//      refuse its pushes forever after);
//   3. bind it to production READ-ONLY: its OWN postgres role, granted SELECT and nothing else;
//   4. cage a zee in it wearing the MANAGER harness (its own manual).
//
// Step 3 FAILS CLOSED. If the read-only role cannot be provisioned, the manager is not created —
// there is no fallback to the owner credential, because "read-only, except when provisioning
// hiccups" is not read-only.
import { q, one } from '../db/pool.js';
import { logline } from './logbus.js';
import { broadcast } from './events.js';
import { attachXellDb } from './xell-db.js';
import { emitXellEnv } from './provision.js';
import { mintProdReader, dropProdReader } from './prod-readonly.js';

// Bind a xell to production READ-ONLY. Used by the manager dispatch path; safe to re-run (the role
// is re-minted with a fresh password, which also re-applies the GRANTs as the schema moves).
export async function bindManagerToProdReadonly(xellId) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('xell not found');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);

  // A project with NO production registered has nothing to read — and that must not make managers
  // impossible there (reading prod is a manager's capability, not its definition). Skip the bind
  // loudly; the manager keeps every other verb. This is the ONLY tolerated absence: if a prod db
  // DOES exist and the reader cannot be minted, we fail closed below.
  const prodDb = await one(
    `SELECT id FROM container WHERE project_id=$1 AND role='db' AND tier='prod' LIMIT 1`, [project.id]);
  if (!prodDb) {
    logline('prod-ro', `${xell.slug}: no production database registered for ${project.name} — the manager `
      + 'is created WITHOUT prod access (nothing to read). Register prod and re-add it to give it one.');
    return { readonly: true, bound: false, reason: 'no prod db registered for this project' };
  }

  // Mint the reader FIRST: if production cannot hand out a SELECT-only role, we must not leave the
  // xell pointing at the prod container at all.
  const reader = await mintProdReader(xell, project);
  const db = await attachXellDb(xellId, { coupling: 'db-prod-readonly' });
  // Re-emit .zeehive.env so the xell's DATABASE_URL is the read-only DSN (provision.js reads
  // prod_ro_dsn for this coupling). Best-effort: a xell whose worktree is not yet on disk still gets
  // the DSN through its binding, and the next emit picks it up.
  await emitXellEnv(xellId).catch((e) => logline('prod-ro', `${xell.slug}: .zeehive.env not re-emitted (${e.message})`));
  const row = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  broadcast('xell', row);
  logline('prod-ro', `${xell.slug} bound to PRODUCTION READ-ONLY as ${reader.role} `
    + `(${reader.container}/${reader.database}${reader.mode === 'simulate' ? ', SIMULATED' : ''})`);
  return { ...db, readonly: true, role: reader.role, mode: reader.mode, address: reader.address };
}

// ── THE COMPENSATING ACTION for a bind that is no longer wanted ──────────────────────────────────
//
// bindManagerToProdReadonly mints a real credential on a real cluster and re-points the xell at
// production. Everything AFTER it in the dispatch can still fail — the cage build most of all — and
// until now nothing undid it: the `zee_ro_<slug>` role stayed on the production cluster and the xell
// row stayed `db-prod-readonly`, both waiting on a teardown that only happens when the xell is
// reaped. A credential nobody is using, on production, for an agent that never started, is exactly
// the thing the reaper exists to prevent — it should not depend on the reaper running.
//
// So: drop the reader and put the xell back on the shared dev database. Deliberately best-effort and
// NEVER throws — this runs on a path that is already failing, and a compensating action that raises
// its own error just replaces one bad outcome with a more confusing one. The revert target is
// `db-shared-dev` rather than "whatever it was before": the xell is released back to the pool from
// here, where the next dispatch attaches whatever that task needs, and the ONE property that must
// hold is that a xell with no zee on it is not left pointing at production.
export async function unbindManagerFromProdReadonly(xellId, reason = 'the dispatch failed') {
  try {
    const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
    if (!xell) return { unbound: false, reason: 'no xell' };
    if (xell.db_coupling !== 'db-prod-readonly') return { unbound: false, reason: 'not bound read-only' };
    const dropped = await dropProdReader(xell);          // never throws; clears prod_ro_dsn
    // Re-attach through the ordinary path so the container LINK is rebuilt too. It can legitimately
    // fail (a project with no dev db registered throws), and the invariant must not depend on it —
    // so fall back to writing the row directly. What has to hold when this returns is narrow and
    // absolute: this xell is not coupled to production and holds no production DSN.
    const db = await attachXellDb(xellId, { coupling: 'db-shared-dev' }).catch((e) => ({ error: e.message }));
    if (db?.error) {
      await q(`DELETE FROM xell_uses_container uc USING container c
                WHERE uc.container_id=c.id AND uc.xell_id=$1 AND c.role='db' AND c.tier='prod'`, [xellId]);
      await q(`UPDATE xell SET db_coupling='db-shared-dev'::db_coupling, prod_ro_dsn=NULL WHERE id=$1`, [xellId]);
    }
    await emitXellEnv(xellId).catch(() => {});
    const row = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
    if (row) broadcast('xell', row);
    logline('prod-ro', `${xell.slug}: UNBOUND from production read-only (${reason}) — `
      + `${dropped.dropped ? `role ${dropped.role} dropped` : `role NOT dropped (${dropped.reason || dropped.error || '?'})`}`
      + `, db back to shared dev${db?.error ? ` (re-attach failed: ${db.error} — coupling cleared directly)` : ''}`);
    return { unbound: true, dropped: !!dropped.dropped, role: dropped.role || null };
  } catch (e) {
    // Never let the compensation itself sink the caller's own error reporting.
    logline('prod-ro', `could not unbind ${String(xellId).slice(0, 8)} from production read-only: ${e.message}`);
    return { unbound: false, error: e.message };
  }
}

// Create a manager zee. Everything after the type stamp is the ordinary dispatch path, so a manager
// is observed, built, nudged and reaped exactly like any other xell.
export async function createManagerZee({ project, cwd, task, title, model, mode, runtime, harness,
                                         provider = 'claude', provider_token_id = null } = {}) {
  const brief = String(task || '').trim() || DEFAULT_MANAGER_BRIEF;
  const { dispatchXell } = await import('../queenzee/intake.js');
  const out = await dispatchXell({
    task: brief, project, cwd, title: title || 'manager zee', zee_type: 'manager',
    harness: harness || 'manager',
    ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(runtime ? { runtime } : {}),
    provider, provider_token_id,
  });
  logline('crew', `MANAGER zee added on ${out.slug} — production is readable (read-only), pushing is not`);
  return { ...out, zee_type: 'manager' };
}

// What a manager is told when a human adds one without typing a brief. Deliberately a JOB, not a
// greeting: an agent with no task idles, and an idle manager is the most expensive kind.
export const DEFAULT_MANAGER_BRIEF = [
  'You are the MANAGER zee for this project. Nobody has handed you a specific programme yet, so start',
  'by building the picture, then propose one:',
  '',
  '1. Read the repo manual/handover (CLAUDE.md / AGENTS.md / HANDOFF.md / README.md) so you know what',
  '   this project is and how it is worked on.',
  '2. Look at the fleet you are responsible for: `zee zees` (your crew — probably empty) and your own',
  '   `zee status`.',
  '3. Read PRODUCTION (you hold it read-only) for the state of the real thing where that is relevant.',
  '4. Write down the 3–5 pieces of work you believe matter most, in priority order, with the reason.',
  '5. Raise them with a human — `zee tend --reason "…"` — and say which one you propose to dispatch',
  '   first. Do NOT start a crew of your own accord on an empty mandate.',
  '',
  'Then run the crew: dispatch one well-briefed worker at a time, watch them, answer them, read their',
  'post-ship reflections, and suggest done when their work is landed.',
].join('\n');
