// ADDING A MANAGER ZEE — a HUMAN act, unlimited.
//
// There is no cap and no pool for managers: add as many as you can afford to run. But only a human
// may add one. A manager that could mint managers is a fleet that grows sideways with nobody's
// consent, so `zee dispatch` refuses the role outright (queenzee/self.js) and this path is reachable
// only from the console (POST /api/managers) or an operator's CLI.
//
// What "adding" actually does, in order:
//   1. take a ready xell (provisioning one on demand if the pool is dry) — a manager is a real xell
//      with a real hexagon, not a special case floating outside the honeycomb;
//   2. stamp role='manager' (the 052 guard then forbids it being managed, and the landgate/xellgit
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
import { mintProdReader } from './prod-readonly.js';

// Bind a xell to production READ-ONLY. Used by the manager dispatch path; safe to re-run (the role
// is re-minted with a fresh password, which also re-applies the GRANTs as the schema moves).
export async function bindManagerToProdReadonly(xellId) {
  const xell = await one(`SELECT * FROM xell WHERE id=$1`, [xellId]);
  if (!xell) throw new Error('xell not found');
  const project = await one(`SELECT * FROM project WHERE id=$1`, [xell.project_id]);

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

// Create a manager zee. Everything after the role stamp is the ordinary dispatch path, so a manager
// is observed, built, nudged and reaped exactly like any other xell.
export async function createManagerZee({ project, cwd, task, title, model, mode, runtime, harness,
                                         provider = 'claude', provider_token_id = null } = {}) {
  const brief = String(task || '').trim() || DEFAULT_MANAGER_BRIEF;
  const { dispatchXell } = await import('../queenzee/intake.js');
  const out = await dispatchXell({
    task: brief, project, cwd, title: title || 'manager zee', role: 'manager',
    harness: harness || 'manager',
    ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(runtime ? { runtime } : {}),
    provider, provider_token_id,
  });
  logline('crew', `MANAGER zee added on ${out.slug} — production is readable (read-only), pushing is not`);
  return { ...out, role: 'manager' };
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
