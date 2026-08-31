// PROVISION PROOF — stage 1 (evidence + surfacing, no gating) — docs/provision-proof-kit/
// stage-1-proof-machinery.md + docs/provision-proof-plan.md §4.1/§4.2/§4.4/§4.8.
//
// The burn-in proves a xell's chips BEFORE a zee is handed them: db-open (delegated to the pure
// preflight), app-build:<role> (the SAME build path `zee build` takes), app-serve:<role> (the
// published port answers). This test drives lib/xell-proof.js proveXell with an INJECTED build/
// status/probe stub (the same injection seam lib/build-readiness.js uses), and drives the
// pool-clock queue (queenzee/pool.js maybeRunProofs) with a stubbed prove — so the verdict shapes,
// the NULL-semantics contract, the proven-first ordering, the per-machine cap and the
// build_readiness_record upsert all run without a docker daemon.
//
// Covered here (against a real postgres — DATABASE_URL — for the meta-DB facts; the docker/build
// half is the stub):
//   • proveXell with a green build → ok, every check passes, db-open delegated, app-build +
//     app-serve per role, commit + at stamped, proof_at set on the row
//   • a failed build whose docker tail is address-pool exhaustion → app-build FAILS and the check
//     is classed INFRA (migration 233) — the class rides on the check, never the verdict
//   • simulate mode → a full no-op: a skipped "simulate" check, and NOTHING stamped on the row
//   • NULL semantics contract: proof_at IS NULL = never proven (gates nothing); proof_at NOT NULL
//     AND proof_error IS NULL = proven; and readyXells orders PROVEN first without refusing the rest
//   • the pool backfill pass + per-machine cap: N unproven xells on one machine prove ONE per pass;
//     the next pass proves the rest
//   • build_readiness_record upsert keeps latest-per-pair; buildReadinessRecordFromProof maps the
//     proof verdict to the record vocabulary (ok / missing for INFRA / ok for CODE-only / unknown
//     for unclassified); recordedBuildReadinessForProject reads the record
process.env.PROVISION_MODE = 'real';   // pool.js MODE gates the proof pass on real
process.env.BUILD_MODE = 'real';       // xell-proof.js PROOF_MODE needs both real
process.env.SPINOFF_REGISTRY = '';
// The server modules read these env keys AT MODULE LOAD — config.js's dotenv never overrides an
// already-set key, so the assignments above must land BEFORE the dynamic imports below (the
// static-import + env-in-file pattern would be too late: ESM hoists static imports first).
import { randomUUID } from 'node:crypto';
const { q, one, pool } = await import('../server/src/db/pool.js');
const { proveXell, noteProof, buildReadinessRecordFromProof } = await import('../server/src/lib/xell-proof.js');
const { upsertBuildReadinessRecord, recordedBuildReadinessForProject } = await import('../server/src/lib/build-readiness.js');
const { readyXells } = await import('../server/src/queenzee/intake.js');
const { maybeRunProofs } = await import('../server/src/queenzee/pool.js');

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const CTX_A = `zt-pf-A-${tag}`;
const CTX_B = `zt-pf-B-${tag}`;
const CTX_C = `zt-pf-C-${tag}`;
const CTX_D = `zt-pf-D-${tag}`;

const insProject = async (name, manifest = {}) =>
  (await one(
    `INSERT INTO project (name, repo_root, db_user, db_name, manifest)
     VALUES ($1,$2,'zeehive','zeehive',$3) RETURNING id`,
    [name, `/tmp/pf-${tag}-${name}`, JSON.stringify(manifest)])).id;

const insMachine = async (key, ctx) =>
  (await one(
    `INSERT INTO machine (key, docker_ctx, can_build, enabled) VALUES ($1,$2,true,true) RETURNING id`,
    [key.toLowerCase(), ctx])).id;

// ONE xource per (project_id, ref) — xource_project_id_ref_key is unique — so each project gets
// its xource created once and every xell of that project tracks it.
const xourceByProject = new Map();
const insXource = async (projectId) => {
  if (xourceByProject.has(projectId)) return xourceByProject.get(projectId);
  const id = (await one(`INSERT INTO xource (project_id, ref, read_only) VALUES ($1,'main',true) RETURNING id`, [projectId])).id;
  xourceByProject.set(projectId, id);
  return id;
};

const insXell = async (projectId, slug, { ready = true, proof_at = null, proof_error = null, ready_at = new Date() } = {}) =>
  (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, db_coupling, proof_at, proof_error, proof_checks, proof_commit, ready_at, worktree_path)
     VALUES ($1,$2,$3,'spinoff/' || $4,$5,'db-shared-dev',$6,$7,'[]'::jsonb,$8,$9,$10) RETURNING id`,
    [projectId, await insXource(projectId), slug, `pf-${tag}`, ready ? 'ready' : 'claimed',
     proof_at, proof_error, null, ready_at, `/tmp/pf-wt-${tag}-${slug}`])).id;

const insContainer = async (projectId, xellId, { role, ctx, port, imageTag = 'img:latest', health = 'down' }) =>
  (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, image_tag, host, host_port, url, health, owner_xell_id)
     VALUES ($1,$2,'dev','per-xell',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [projectId, role, `pf_${tag}_${role}_${port}`, ctx, imageTag, ctx, port, `http://${ctx}:${port}`, health, xellId])).id;

// ── the injected build/status/probe stub ────────────────────────────────────
// proveXell's deps seam. `phase` flips to 'up' when a build is kicked; the pre-check sees
// 'unbuilt' so it kicks one, waitForSettle then sees the built stack.
const makeStatus = ({ health = 'up', error = null, head = '0123456789abcdef' } = {}) => ({
  xell: { id: 'x', slug: 's' },
  head,
  building: false,
  settled: true,
  all_serving_head: health === 'up' && !error,
  containers: [
    { role: 'server', health, last_build_error: error,
      last_build_error_class: error ? 'INFRA' : null, published_health: health === 'up' ? 'up' : 'down',
      last_build_commit: head, hot_build: false, docker_ctx: CTX_A, image_tag: 'img:latest',
      host: CTX_A, host_port: 4800, url: `http://${CTX_A}:4800` },
    { role: 'webapp', health, last_build_error: error,
      last_build_error_class: error ? 'INFRA' : null, published_health: health === 'up' ? 'up' : 'down',
      last_build_commit: head, hot_build: false, docker_ctx: CTX_A, image_tag: 'img:latest',
      host: CTX_A, host_port: 5300, url: `http://${CTX_A}:5300` },
  ],
});
const greenDeps = ({ build } = {}) => {
  const buildCalls = [];
  const status = async () => makeStatus({ health: 'up' });
  return {
    buildCalls,
    deps: {
      preflight: async () => ({ ok: true, error: null,
        checks: [{ check: 'db-open', ok: true, skipped: false, detail: 'stub opened the projected dsn' }] }),
      build: async (x, o) => { buildCalls.push(o?.role || 'all'); return build?.() || [{ status: 'building' }]; },
      status,
      probe: async () => 'up',
      commitOf: () => '0123456789abcdef',
    },
  };
};

const created = [];
const track = (p) => { created.push(p); return p; };
const pids = [];
const mids = [];
const xids = [];
const cids = [];

try {
  // ── fixtures ────────────────────────────────────────────────────────────────
  const projId = track(await insProject(`pf-green-${tag}`));
  pids.push(projId);
  const mA = track(await insMachine(`pf-a-${tag}`, CTX_A)); mids.push(mA);
  const xGreen = track(await insXell(projId, `pf-green-xell-${tag}`)); xids.push(xGreen);
  cids.push(await insContainer(projId, xGreen, { role: 'server', ctx: CTX_A, port: 4800 }));
  cids.push(await insContainer(projId, xGreen, { role: 'webapp', ctx: CTX_A, port: 5300 }));

  console.log('\n── 1. proveXell: a green burn-in → ok, every check passes, verdict stamped ──');
  {
    const { buildCalls, deps } = greenDeps();
    const v = await proveXell(xGreen, { mode: 'real', deps });
    ok(v.ok === true, `ok true [error=${v.error}]`);
    ok(v.error === null, 'no error');
    ok(v.commit === '0123456789abcdef', `commit recorded [${v.commit}]`);
    ok(v.at, 'at timestamp present');
    ok(v.checks.some((c) => c.check === 'db-open' && c.ok), 'db-open delegated to preflight and passed');
    ok(v.checks.some((c) => c.check === 'app-build:server' && c.ok && !c.skipped), 'app-build:server passed');
    ok(v.checks.some((c) => c.check === 'app-build:webapp' && c.ok && !c.skipped), 'app-build:webapp passed');
    ok(v.checks.some((c) => c.check === 'app-serve:server' && c.ok), 'app-serve:server passed (published port)');
    ok(v.checks.some((c) => c.check === 'app-serve:webapp' && c.ok), 'app-serve:webapp passed (published port)');
    const row = await one(`SELECT proof_at, proof_error, proof_checks, proof_commit FROM xell WHERE id=$1`, [xGreen]);
    ok(!!row.proof_at, 'proof_at stamped on the row');
    ok(row.proof_error === null, 'proof_error NULL (proven)');
    ok(Array.isArray(row.proof_checks) && row.proof_checks.length >= 5, `proof_checks recorded [${row.proof_checks?.length}]`);
    ok(row.proof_commit === '0123456789abcdef', 'proof_commit recorded');
    // green stack → no build kick needed (already up+serving → passes on existing evidence)
    ok(buildCalls.length === 0, `already-proven stack: no redundant rebuild [${buildCalls.length} kick]`);
  }

  console.log('\n── 2. proveXell: address-pool exhaustion → app-build FAILS, classed INFRA ──');
  {
    const dep = {
      preflight: async () => ({ ok: true, error: null,
        checks: [{ check: 'db-open', ok: true, skipped: false, detail: 'stub opened' }] }),
      build: async () => [{ status: 'building' }],
      status: async () => makeStatus({ health: 'down',
        error: 'all predefined address pools have been fully subnetted' }),
      probe: async () => 'down',
      commitOf: () => null,
    };
    const xInfra = track(await insXell(projId, `pf-infra-xell-${tag}`)); xids.push(xInfra);
    cids.push(await insContainer(projId, xInfra, { role: 'server', ctx: CTX_A, port: 4801 }));
    cids.push(await insContainer(projId, xInfra, { role: 'webapp', ctx: CTX_A, port: 5301 }));
    const v = await proveXell(xInfra, { mode: 'real', deps: dep });
    ok(v.ok === false, 'verdict not ok');
    const b = v.checks.find((c) => c.check === 'app-build:server');
    ok(b && b.ok === false, 'app-build:server fails');
    ok(b?.class === 'INFRA', `failure classed INFRA (not the zee's code) [${b?.class}]`);
    ok(/address pools/.test(b?.detail || ''), `detail carries the docker line [${b?.detail}]`);
    ok(v.error && /app-build:server/.test(v.error), `verdict error NAMES the failing check [${v.error}]`);
    const row = await one(`SELECT proof_error FROM xell WHERE id=$1`, [xInfra]);
    ok(/app-build:server/.test(row.proof_error || ''), 'proof_error stamped with the NAMED failing check');
  }

  console.log('\n── 3. proveXell: simulate mode is a full no-op (nothing stamped) ──');
  {
    const xSim = track(await insXell(projId, `pf-sim-xell-${tag}`)); xids.push(xSim);
    cids.push(await insContainer(projId, xSim, { role: 'server', ctx: CTX_A, port: 4802 }));
    const before = await one(`SELECT proof_at FROM xell WHERE id=$1`, [xSim]);
    const v = await proveXell(xSim, { mode: 'simulate' });
    ok(v.ok === true, 'simulate verdict is ok (skipped, not failed)');
    ok(v.checks.length === 1 && v.checks[0].check === 'simulate' && v.checks[0].skipped, 'single skipped simulate check');
    const after = await one(`SELECT proof_at, proof_error FROM xell WHERE id=$1`, [xSim]);
    ok(after.proof_at === null && after.proof_error === null, 'nothing stamped in simulate mode');
    ok(before.proof_at === null, 'row untouched before/after');
  }

  console.log('\n── 4. NULL semantics: proven sorts first, never-proven and failed still claimable ──');
  {
    const pOrder = track(await insProject(`pf-order-${tag}`)); pids.push(pOrder);
    const xProven = track(await insXell(pOrder, `pf-proven-${tag}`,
      { proof_at: new Date(Date.now() - 3000), proof_error: null, ready_at: new Date(Date.now() - 3000) })); xids.push(xProven);
    const xUnproven = track(await insXell(pOrder, `pf-unproven-${tag}`,
      { proof_at: null, ready_at: new Date(Date.now() - 2000) })); xids.push(xUnproven);
    const xFailed = track(await insXell(pOrder, `pf-failed-${tag}`,
      { proof_at: new Date(Date.now() - 1000), proof_error: 'app-build:server: broke', ready_at: new Date(Date.now() - 1000) })); xids.push(xFailed);
    const list = await readyXells(pOrder, { zeeType: 'worker' });
    const order = list.map((x) => x.slug);
    ok(order[0] === `pf-proven-${tag}`, `proven xell sorts FIRST [${order.join(', ')}]`);
    ok(order.includes(`pf-unproven-${tag}`), 'never-proven (proof_at IS NULL) still claimable — gates nothing');
    ok(order.includes(`pf-failed-${tag}`), 'proof-failed still claimable under advisory — gates nothing');
    // The contract, asserted on rows: proven = proof_at NOT NULL AND proof_error IS NULL.
    const provenRow = await one(`SELECT proof_at IS NOT NULL AND proof_error IS NULL AS proven FROM xell WHERE id=$1`, [xProven]);
    const unprovenRow = await one(`SELECT proof_at IS NOT NULL AND proof_error IS NULL AS proven FROM xell WHERE id=$1`, [xUnproven]);
    const failedRow = await one(`SELECT proof_at IS NOT NULL AND proof_error IS NULL AS proven FROM xell WHERE id=$1`, [xFailed]);
    ok(provenRow.proven === true, 'contract: proven xell reads proven');
    ok(unprovenRow.proven === false, 'contract: never-proven reads not proven');
    ok(failedRow.proven === false, 'contract: proof-failed reads not proven');
  }

  console.log('\n── 5. pool backfill + per-machine cap: one proof per machine per pass ──');
  {
    // Dedicated machine contexts (CTX_C / CTX_D) so NO xell from the earlier sections shares this
    // machine — the global backfill scan (status='ready' AND proof_at IS NULL) would otherwise
    // occupy the cap with a leftover unproven xell before this section's own xells get a turn.
    const pCap = track(await insProject(`pf-cap-${tag}`)); pids.push(pCap);
    const mC = track(await insMachine(`pf-c-${tag}`, CTX_C)); mids.push(mC);
    const mD = track(await insMachine(`pf-d-${tag}`, CTX_D)); mids.push(mD);
    // Two unproven xells on machine C, one on machine D — C's two share the cap.
    const xC1 = track(await insXell(pCap, `pf-cap-c1-${tag}`, { ready_at: new Date(Date.now() - 5000) })); xids.push(xC1);
    const xC2 = track(await insXell(pCap, `pf-cap-c2-${tag}`, { ready_at: new Date(Date.now() - 4000) })); xids.push(xC2);
    const xD1 = track(await insXell(pCap, `pf-cap-d1-${tag}`, { ready_at: new Date(Date.now() - 3000) })); xids.push(xD1);
    cids.push(await insContainer(pCap, xC1, { role: 'server', ctx: CTX_C, port: 4810 }));
    cids.push(await insContainer(pCap, xC2, { role: 'server', ctx: CTX_C, port: 4811 }));
    cids.push(await insContainer(pCap, xD1, { role: 'server', ctx: CTX_D, port: 4812 }));

    const calls = [];
    const stubProve = async (id) => {
      calls.push(id);
      await noteProof(id, { ok: true, error: null, checks: [], commit: '0123' });
      await new Promise((r) => setTimeout(r, 10));   // hold the machine busy past the pass loop
    };

    await maybeRunProofs({ prove: stubProve, rerecord: false });
    const pass1C = calls.filter((id) => id === xC1 || id === xC2);
    const pass1D = calls.filter((id) => id === xD1);
    ok(pass1C.length === 1, `one proof on machine C in pass 1 [${pass1C.length}] — the cap held`);
    ok(pass1D.length === 1, `one proof on machine D in pass 1 [${pass1D.length}]`);

    await new Promise((r) => setTimeout(r, 30));      // let pass-1 proves finish + clear the machine
    await maybeRunProofs({ prove: stubProve, rerecord: false });
    const pass2C = calls.filter((id) => id === xC1 || id === xC2);
    ok(pass2C.length === 2, `pass 2 drains machine C's remaining xell [${pass2C.length} total]`);
  }

  console.log('\n── 6. build_readiness_record: latest-per-pair + verdict mapping + recorded read ──');
  {
    const pRec = track(await insProject(`pf-rec-${tag}`)); pids.push(pRec);
    const mRec = track(await insMachine(`pf-rec-${tag}`, `zt-pf-rec-${tag}`)); mids.push(mRec);
    await upsertBuildReadinessRecord(mRec, pRec, { status: 'ok', checks: [{ check: 'a', ok: true, skipped: false, detail: 'd' }] });
    await upsertBuildReadinessRecord(mRec, pRec, { status: 'missing', error: 'app-build:server: exhausted', checks: [] });
    const rows = await q(
      `SELECT * FROM build_readiness_record WHERE machine_id=$1 AND project_id=$2`, [mRec, pRec]);
    ok(rows.length === 1, 'one row per (machine, project) pair');
    ok(rows[0].status === 'missing', `latest verdict wins [${rows[0].status}]`);
    ok(/exhausted/.test(rows[0].error || ''), 'error recorded');

    const rec = await recordedBuildReadinessForProject(pRec);
    const mine = rec.find((r) => r.machine_id === mRec);
    ok(mine?.status === 'missing', `recorded read model carries the record [${mine?.status}]`);
    ok(mine?.recorded === true, 'recorded flag true');
    ok(Array.isArray(mine?.checks), 'checks array present');

    ok(buildReadinessRecordFromProof({ ok: true, checks: [] }).status === 'ok', 'green verdict → ok');
    const infra = buildReadinessRecordFromProof({ ok: false, error: 'x',
      checks: [{ check: 'app-build:server', ok: false, skipped: false, detail: 'pool', class: 'INFRA' }] });
    ok(infra.status === 'missing', 'INFRA verdict → missing (the pair is the fault, §4.6)');
    const code = buildReadinessRecordFromProof({ ok: false, error: 'x',
      checks: [{ check: 'app-build:server', ok: false, skipped: false, detail: 'tsc', class: 'CODE' }] });
    ok(code.status === 'ok', 'CODE-only verdict → ok (the machine CAN build; the code is the project fact)');
    const unk = buildReadinessRecordFromProof({ ok: false, error: 'x',
      checks: [{ check: 'app-build:server', ok: false, skipped: false, detail: 'timeout', class: null }] });
    ok(unk.status === 'unknown', 'unclassified verdict → unknown (never green)');
  }

} finally {
  // Tear down in dependency order: containers → xells → projects → machines.
  for (const id of cids) await q(`DELETE FROM container WHERE id=$1`, [id]).catch(() => {});
  for (const id of xids) {
    await q(`DELETE FROM xell WHERE id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM xource WHERE xell_id=$1`, [id]).catch(() => {});
  }
  for (const id of xids) await q(`DELETE FROM xource WHERE project_id IN (SELECT project_id FROM xell WHERE id=$1)`, [id]).catch(() => {});
  for (const id of pids) {
    await q(`DELETE FROM xource WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM container WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM pool_config WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM xell WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM build_readiness_record WHERE project_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM project WHERE id=$1`, [id]).catch(() => {});
  }
  for (const id of mids) {
    await q(`DELETE FROM machine_pool WHERE machine_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM build_readiness_record WHERE machine_id=$1`, [id]).catch(() => {});
    await q(`DELETE FROM machine WHERE id=$1`, [id]).catch(() => {});
  }
  await pool.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
