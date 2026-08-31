// RE-PREFLIGHT ON EVERY BINDING CHANGE — stage 2 (docs/provision-proof-kit/stage-2-gates.md §4.5,
// plan §4.5). A xell's proof is recorded against the binding it HAD; the moment a dispatch re-points
// its database, that proof is stale by definition. This test drives the re-preflight against a REAL
// postgres (the stage-2 brief: "drive the REAL SQL against zee db-sandbox --migrate, not a mock"):
//
//   policy × re-preflight verdict     outcome
//   required   preflight FAILS        REFUSED — ok:false, the NAMED check (db-open), the DSN identity
//                                     WITHOUT the secret (preflight's dsnIdentity strips it); the
//                                     verdict lands on the row; a dispatch through this path throws and
//                                     RELEASES the claim (the xell is back to 'ready', not leaked).
//   advisory   preflight FAILS        NOT refused — the spawn proceeds; the verdict is on the row and
//                                     in the zee's briefing (the conditions block, via proofConditionLine).
//   required   preflight OK           NOT refused — a healthy binding is never refused.
//
// Plus the two hard edges:
//   • a project with NO pool_config row reads the DEFAULT advisory (projectReadinessProof) — nothing
//     flips to 'required' by accident;
//   • a healthy briefing stays byte-identical (no per-xell proof section), so the advisory verdict
//     only surfaces when there is something to surface.
//
// PROVISION_MODE=simulate: the re-preflight is the exact code a real dispatch runs (a preflight only
// opens the DSN it is given — no machine is ever touched).
process.env.PROVISION_MODE = 'simulate';
process.env.BUILD_MODE = 'simulate';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

const { q, one, pool } = await import('../server/src/db/pool.js');
const { rePreflightAfterBindingChange, proofConditionLine, projectReadinessProof,
        READINESS_PROOF_DEFAULT } = await import('../server/src/lib/proof-policy.js');
const { briefing, dispatchXell } = await import('../server/src/queenzee/intake.js');

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failures++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const tmp = mkdtempSync(join(tmpdir(), `repreflight-${tag}-`));
let projId = null, xoid = null;

// A DSN that carries a SECRET password and a role that does not exist on the sandbox server — a real,
// immediate credential rejection (the exact shape of the #47/TKT-181 fault this re-preflight exists to
// catch) whose password must NEVER appear in any refusal.
const SECRET = `pw-${tag}`;
const REJECTED = url.replace(/^(postgres(?:ql)?:\/\/)[^@/]*@/, `$1nosuchrole_${tag}:${SECRET}@`);

// A ready, PROVEN pooled xell (proof_at stamped, no errors) with an owned db container carrying the
// given conn_ref — exactly the row the re-preflight reads.
const mkXell = async (slug, { coupling = 'db-shared-dev', connRef = null } = {}) => {
  const wt = join(tmp, slug);
  mkdirSync(wt, { recursive: true });
  const x = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling, proof_at, proof_error, preflight_error)
       VALUES ($1,$2,$3,$4,$5,'ready',true,'worker',$6, now(), NULL, NULL) RETURNING *`,
    [projId, xoid, slug, `spinoff/${slug}`, wt, coupling]);
  if (connRef !== null) {
    const c = await one(
      `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                              host_port, conn_ref, owner_xell_id)
         VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,15432,$3,$4) RETURNING id`,
      [projId, `${slug}_db`, connRef, x.id]);
    await q(`INSERT INTO xell_uses_container (xell_id, container_id, relation) VALUES ($1,$2,'owns')`,
            [x.id, c.id]);
  }
  return x;
};
const setPolicy = (p) => q(`UPDATE pool_config SET readiness_proof=$2 WHERE project_id=$1`, [projId, p]);
const row = (id) => one(`SELECT status, preflight_at, preflight_error, preflight_checks FROM xell WHERE id=$1`, [id]);

try {
  projId = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-repreflight-${tag}`, join(tmp, 'repo')])).id;
  xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projId])).id;
  await one(
    `INSERT INTO pool_config (project_id, target_ready, default_source_coupling, default_db_coupling)
     VALUES ($1,0,'sparse-overlay','db-shared-dev') RETURNING project_id`, [projId]);

  // ── the refusal shape: 'required' + a failing NEW binding ───────────────────────
  console.log('\n── under readiness_proof=required, a failed re-preflight is a dispatch REFUSAL ──');
  await setPolicy('required');
  const bad = await mkXell(`badreq-${tag}`, { connRef: REJECTED });
  const rep = await rePreflightAfterBindingChange(bad.id);
  ok(rep.refused === true, 'the re-preflight REFUSES under required');
  ok(rep.verdict.ok === false, '…and the underlying verdict is ok:false (the refusal shape §4.5)');
  ok(/^db-open: /.test(rep.verdict.error || ''), `…naming the failing check (db-open): ${rep.verdict.error}`);
  ok(/db-open/.test(rep.reason), 'the refusal names the check too');
  ok(rep.reason.includes(`nosuchrole_${tag}`),
     '…and the DSN identity — the role that was refused, not the secret');
  ok(!rep.reason.includes(SECRET) && !rep.verdict.error.includes(SECRET),
     '…WITHOUT the password: the secret is never echoed (dsnIdentity strips it)');
  const badRow = await row(bad.id);
  ok(badRow.preflight_error !== null, 'the verdict lands on the row (notePreflight ran)');

  // ── 'advisory' NEVER refuses: same failing binding, spawn proceeds ──────────────
  console.log('\n── under readiness_proof=advisory, the same failure never refuses ──');
  await setPolicy('advisory');
  const badA = await mkXell(`badadv-${tag}`, { connRef: REJECTED });
  const repA = await rePreflightAfterBindingChange(badA.id);
  ok(repA.refused === false, 'advisory never refuses — the spawn proceeds');
  ok(repA.verdict.ok === false, '…but the failure is still recorded, not swallowed');
  ok((await row(badA.id)).preflight_error === repA.verdict.error,
     '…and it is on the row for a human and the briefing to read');

  // ── a healthy binding under 'required' is never refused ─────────────────────────
  console.log('\n── a healthy new binding under required is never refused ──');
  await setPolicy('required');
  const good = await mkXell(`goodreq-${tag}`, { connRef: url });
  const repG = await rePreflightAfterBindingChange(good.id);
  ok(repG.refused === false && repG.verdict.ok === true,
     'a DSN that opens → no refusal, under required or any policy');

  // ── the advisory verdict reaches the ZEE's briefing (the conditions block) ──────
  console.log('\n── under advisory the verdict is in the briefing, not just on the row ──');
  const adv = await mkXell(`brief-${tag}`, { connRef: REJECTED });
  await rePreflightAfterBindingChange(adv.id);           // record the verdict
  const zee = { id: null, name: 'test-zee', viewer_url: null };
  const b = await briefing(adv.id, zee, 'do the thing');
  ok(b.includes('Your own proof state'), 'the briefing carries the per-xell proof section');
  ok(b.includes('database preflight FAILING'), '…naming the failing preflight');
  ok(b.includes(`nosuchrole_${tag}`), '…and the DSN identity (still no secret in the CONDITION line)');
  ok(b.indexOf('Your own proof state') < b.indexOf('## Your task'), '…positioned above the task, like the conditions block');
  // The refusal/condition text must never echo the password — the brief is about the ERROR, not the
  // whole briefing: the binding JSON below legitimately carries the full DSN (the zee needs it to
  // connect). The preflight's own error already stripped the secret (asserted above); the proof
  // condition line renders that error verbatim, so its section holds no password either. Find the
  // per-xell section and confirm the secret is absent BETWEEN the section and the task.
  const section = b.slice(b.indexOf('Your own proof state'), b.indexOf('## Your task'));
  ok(!section.includes(SECRET), '…and the proof-condition SECTION carries no password');
  const bg = await briefing(good.id, zee, 'do the thing');
  ok(!bg.includes('Your own proof state'), 'a healthy xell\'s briefing has no per-xell section (byte-identical)');

  // ── the per-xell line is pure and testable ───────────────────────────────────────
  console.log('\n── proofConditionLine (pure) ──');
  ok(proofConditionLine(null) === null, 'no row → null');
  ok(proofConditionLine({ proof_at: null, proof_error: null, preflight_error: null }) === null,
     'a clean row → null (no section)');
  ok(/database preflight FAILING/.test(
       proofConditionLine({ proof_at: new Date().toISOString(), preflight_error: 'db-open: nope' })),
     'a preflight failure renders the dated line');
  ok(/provision proof FAILED/.test(
       proofConditionLine({ proof_at: new Date().toISOString(), proof_error: 'app-build: nope' })),
     'a proof failure renders too');
  ok(/\[\d\d\d\d-\d\d-\d\d\]/.test(
       proofConditionLine({ proof_at: new Date().toISOString(), proof_error: 'x' })),
     'and the line is dated like the conditions block');

  // ── a project with NO pool_config row reads the DEFAULT advisory ────────────────
  console.log('\n── no pool_config row → the default advisory, never required by accident ──');
  const p2 = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [`zt-repreflight-${tag}-nopc`, join(tmp, 'repo2')])).id;
  ok((await projectReadinessProof(p2)) === READINESS_PROOF_DEFAULT,
     'a project with no pool_config row resolves to the default advisory');
  ok((await projectReadinessProof(projId)) === 'required', 'and the set policy is what resolves');

  // ── the DISPATCH refuses: named dispatch, attach re-points to a dead binding ─────
  console.log('\n── a named dispatch under required refuses when the attach fails re-preflight ──');
  await setPolicy('required');
  const disp = await mkXell(`disp-${tag}`, { coupling: 'db-isolated' });   // proven, ready, no db row yet
  const targetName = `disp-${tag}-target`;
  await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, internal_port,
                            host_port, conn_ref, owner_xell_id)
       VALUES ($1,'db','spinoff','per-xell',$2,'default',5432,15432,$3,$4) RETURNING id`,
    [projId, targetName, REJECTED, disp.id]);
  let threw = null;
  await dispatchXell({ xell_id: disp.id, task: 'build the widget', project: projId,
                       db: 'db-isolated', db_container: targetName })
    .catch((e) => { threw = e; });
  ok(!!threw, 'the dispatch THROWS — it does not spawn a zee into a xell whose new binding is dead');
  ok(/readiness_proof='required'|re-preflight|does not open/.test(threw?.message || ''),
     `…and the refusal names the policy + the failing binding: ${String(threw?.message).slice(0, 140)}…`);
  ok((await row(disp.id)).status === 'ready',
     '…and the claim is RELEASED — the xell is back to ready, not leaked, not spawned');
} finally {
  if (projId) {
    await q(`DELETE FROM zee WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
    await q(`DELETE FROM task WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM xell_uses_container WHERE xell_id IN (SELECT id FROM xell WHERE project_id=$1)`, [projId]);
    await q(`DELETE FROM container WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM xell WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM xource WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [projId]);
    await q(`DELETE FROM project WHERE id=$1`, [projId]);
  }
  rmSync(tmp, { recursive: true, force: true });
  await pool.end();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
