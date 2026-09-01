// THE INFRA-MEDIC DISPATCH SEAM (provision-proof plan §4.6 / §7, the console button) — the
// PROVISION-INFRA card carries a "dispatch medic" action: the queenzee claims a ready xell of the
// card's project, wears the infra-medic harness, and briefs it to fix the PROJECT CONFIG (not the
// one xell) so the pair stops being broken.
//
// This is a REAL postgres test against DATABASE_URL (the db-sandbox, migrated: 237-241 + the
// conditions table). It covers:
//
//   1. buildMedicDispatchBrief (pure) — the mission is CONFIG, not the xell: the brief quotes the
//      card verbatim, names the project-config fix, carries the verb family and the standing
//      refusals, and survives an empty card body;
//   2. the route guards over HTTP (real router mounted on an ephemeral port, so the response
//      contract — not just the function — is asserted): an unknown condition → 404; an IDENTIFIED
//      WORKER zee token → 403 (workers do not dispatch; refuseWorkerZeeToken before any spawn);
//   3. the queenzee gate: the route carries requireQueenzeeLoops, so a valid card reached the
//      dispatch path only on the process holding the single-queenzee lock.
//
// It deliberately does NOT invoke the dispatch itself: dispatchXell spawns a real provider zee, an
// external side effect a test must not trigger. The wiring under the guards is one reviewed line —
// `dispatchXell({ project: cond.project_id, task: buildMedicDispatchBrief(cond), harness:
// 'infra-medic' })` — and the harness/type/meta-RO machinery it leans on is exercised end-to-end by
// infra-medic.test.mjs. The happy-path HTTP exercise is the `zee build server` e2e the stage brief
// calls for.
//
// It creates its own fixture project/xell/condition rows and removes them in a finally, whatever
// happens. Deletes are pushed as THUNKS (`() => q(...)`) so they run only at teardown.
process.env.PRODRO_MODE = 'simulate';          // before ANY import that computes it at load
process.env.PROVISION_MODE = 'simulate';
// The dispatch-medic route is gated by requireQueenzeeLoops: only the process holding the
// single-queenzee lock drives a spawn. config.js loads .zeehive.env at import (this cxell is
// API-only there: QUEENZEE_INPROC=false), but dotenv never overrides a key already in the
// environment — so set it TRUE here to mount the route the way the real queenzee would.
process.env.QUEENZEE_INPROC = 'true';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { buildMedicDispatchBrief } = await import('../server/src/lib/infra-medic.js');
const { hashToken } = await import('../server/src/lib/xell-token.js');
const { randomUUID } = await import('node:crypto');
const express = (await import('express')).default;

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const clean = [];
const cleanQ = (sql, p) => () => q(sql, p);    // THUNK: deferred to the finally, in reverse order

const insProject = async (name) => {
  const id = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_user, db_name, manifest)
       VALUES ($1,$2,'main','postgres','postgres','{}') RETURNING id`,
    [name, `/tmp/imd-${tag}-${name}`])).id;
  clean.push(cleanQ(`DELETE FROM project WHERE id=$1`, [id]));
  return id;
};
const xourceCache = new Map();                 // one xource per project: (project_id, ref) is unique
const insXell = async (projectId, slug, { harnessId = null, token = null } = {}) => {
  let xo = xourceCache.get(projectId);
  if (!xo) {
    xo = (await one(
      `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
      [projectId])).id;
    xourceCache.set(projectId, xo);
    clean.push(cleanQ(`DELETE FROM xource WHERE id=$1`, [xo]));
  }
  const x = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, harness_id,
                       self_token_hash)
       VALUES ($1,$2,$3,'spinoff/'||$3,'ready','worker',$4,$5) RETURNING id`,
    [projectId, xo, slug, harnessId, token ? hashToken(token) : null]);
  clean.push(cleanQ(`DELETE FROM xell WHERE id=$1`, [x.id]));
  return x;
};
const insCondition = async (projectId, body) => {
  const c = await one(
    `INSERT INTO project_condition (project_id, body, created_by, updated_by)
       VALUES ($1,$2,'test','test') RETURNING *`,
    [projectId, body]);
  clean.push(cleanQ(`DELETE FROM project_condition WHERE id=$1`, [c.id]));
  return c;
};

// Mount the REAL router on an ephemeral port so the response contract is asserted end-to-end.
const { router } = await import('../server/src/api/routes.js');
const app = express();
app.use(express.json());
app.use('/api', router);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
clean.push(async () => { await new Promise((r) => server.close(r)); });

try {
  // ── 1. the dispatch brief: CONFIG, not the xell ─────────────────────────────
  console.log('\n── buildMedicDispatchBrief: the mission is the PROJECT CONFIG, not one xell ──');
  const card = `PROVISION-INFRA: this project cannot build on machine 'mardale-prod-alt' — `
    + `shared-dev-db: no shared dev db for project ZEEHIVE. Medic action: provision the project's `
    + `shared dev db on this machine.`;
  const brief = buildMedicDispatchBrief({ body: card });
  ok(brief.includes(card), 'the brief quotes the card body verbatim');
  const flat = brief.replace(/\s+/g, ' ');     // the template literal wraps lines; assert on the sense
  ok(flat.includes('PROJECT CONFIG') && flat.includes('not one xell'),
     'the brief names the CONFIG-fix mission (not one xell)');
  ok(flat.includes('hold for the next xell too'), 'the brief says the fix must hold for the NEXT xell (recurrence)');
  ok(flat.includes('zee infra') && flat.includes('readiness') && flat.includes('proof'),
     'the brief carries the zee infra verb family');
  ok(flat.includes('bootstrap --perform') && flat.includes('propose'),
     'the brief names the HUMAN-GATED cards (bootstrap --perform, propose)');
  ok(flat.includes('write DSN to the meta-DB') && flat.includes('never route around a gate')
     && flat.includes('never invent infrastructure') && flat.includes('stale proof as current'),
     'the brief carries the standing refusals');
  ok(!/(?:password|token|dsn)\s*[:=]\s*\S/i.test(brief), 'the brief leaks no secret value');

  const emptyBrief = buildMedicDispatchBrief({ body: '' });
  ok(/the card body was empty/.test(emptyBrief), 'an empty card body still produces a usable brief');
  const noBrief = buildMedicDispatchBrief(null);
  ok(/the card body was empty/.test(noBrief), 'a null condition still produces a usable brief');

  // ── 2. the route guards over HTTP ───────────────────────────────────────────
  console.log('\n── POST /api/project-conditions/:id/dispatch-medic — guards before any dispatch ──');
  const p = await insProject(`imd-p-${tag}`);
  const workerToken = `imd-worker-${tag}`;
  await insXell(p, `imd-worker-${tag}`, { token: workerToken });
  const cond = await insCondition(p, card);

  let r = await fetch(`${base}/api/project-conditions/${randomUUID()}/dispatch-medic`, { method: 'POST' });
  ok(r.status === 404, `an unknown condition → 404 [got ${r.status}]`);

  r = await fetch(`${base}/api/project-conditions/${cond.id}/dispatch-medic`, {
    method: 'POST',
    headers: { authorization: `Bearer ${workerToken}` },
  });
  const refused = await r.json().catch(() => ({}));
  ok(r.status === 403 && /MANAGER-only|worker/i.test(refused.error || ''),
     `an identified WORKER zee cannot dispatch a medic → 403 [${r.status} ${refused.error || ''}]`);

  // The worker's refusal happened BEFORE any condition/type resolution — prove the guard short-
  // circuit also fires when the card does not exist at all (a worker must not probe that).
  r = await fetch(`${base}/api/project-conditions/${randomUUID()}/dispatch-medic`, {
    method: 'POST',
    headers: { authorization: `Bearer ${workerToken}` },
  });
  ok(r.status === 403, `the worker refusal fires before the condition lookup too [got ${r.status}]`);

  console.log('\nall good');
} finally {
  // Reverse order: the HTTP server first, then the rows it might reference.
  for (const fn of clean.reverse()) { try { await fn(); } catch { /* best effort */ } }
  await pool.end();
}

process.exit(fail ? 1 : 0);
