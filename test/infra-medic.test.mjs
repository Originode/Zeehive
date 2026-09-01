// THE INFRA-MEDIC SURFACE (provision-proof plan §7, stage 3) — capability gate, gated cards,
// non-secret settings projection, and the meta-RO simulate contract.
//
// This is a REAL postgres test against DATABASE_URL (a clone / the db-sandbox with the full
// schema — it must be migrated first: 237/238/239/240/241). It drives the stage-3 machinery
// through its actual modules, not through the HTTP layer (that half is the e2e exercise against
// `zee build server`):
//
//   1. the harness.capabilities ALLOWLIST trigger (237) — empty default fine, 'infra-troubleshoot'
//      accepted, anything else REFUSED, non-array refused;
//   2. the EFFECTIVE-CHAIN gate (lib/harness-capabilities.js) — a xell wearing a harness that
//      INHERITS the medic counts; a plain worker does not (requireInfra throws 403); a DISABLED
//      ancestor grants nothing;
//   3. the gated cards (lib/infra-medic.js + infra_request) — bootstrap/propose file a PENDING
//      card and perform NOTHING pre-approval; reject performs nothing; APPROVE performs and the row
//      becomes the receipt (applySettingsPatch for propose; a stale bootstrap card whose machine is
//      gone goes to 'failed' with the recorded error); an open card is handed back, not duplicated;
//      the propose whitelist refuses an unknown field at file time;
//   4. the settings projection leaks NO secret column — asserted against the LIVE sandbox schema
//      (the *_hint sibling rule + the code's explicit secret list), never a hardcoded list;
//   5. PRODRO_MODE=simulate mints NOTHING real: mintMetaReader creates no zee_ro_* role on the
//      cluster, stores a DSN that CANNOT authenticate, and dropMetaReader clears it.
//
// It creates its own fixture project/machine/pool_config/container/deploy_site/xell/harness rows
// and removes them in a finally, whatever happens. Deletes are pushed as THUNKS (`() => q(...)`)
// so they run only at teardown — a delete executed at creation time would unbind the very rows the
// rest of the test is referencing.
process.env.PRODRO_MODE = 'simulate';          // before ANY import that computes it at load
process.env.PROVISION_MODE = 'simulate';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { xellCapabilities, hasInfraTroubleshoot, requireInfra, INFRA_CAPABILITY } =
  await import('../server/src/lib/harness-capabilities.js');
const { infraBootstrap, infraPropose, infraSettings, decideInfraRequest } =
  await import('../server/src/lib/infra-medic.js');
const { mintMetaReader, dropMetaReader } = await import('../server/src/lib/prod-readonly.js');
const { randomUUID } = await import('node:crypto');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const clean = [];
const cleanQ = (sql, p) => () => q(sql, p);    // THUNK: deferred to the finally, in reverse order

const insHarness = async (key, { parent = null, capabilities = [], enabled = true } = {}) => {
  const id = (await one(
    `INSERT INTO harness (key, label, bundle, enabled, is_law_core, zee_type, parent_id, capabilities)
       VALUES ($1,$2,$3,$4,false,'worker',$5,$6::jsonb) RETURNING id`,
    [key, key, JSON.stringify({ label: key }), enabled, parent, JSON.stringify(capabilities)])).id;
  clean.push(cleanQ(`DELETE FROM harness WHERE id=$1`, [id]));
  return id;
};

const insProject = async (name) => {
  const id = (await one(
    `INSERT INTO project (name, repo_root, main_branch, db_user, db_name, manifest)
       VALUES ($1,$2,'main','postgres','postgres','{}') RETURNING id`,
    [name, `/tmp/im-${tag}-${name}`])).id;
  clean.push(cleanQ(`DELETE FROM project WHERE id=$1`, [id]));
  return id;
};
const xourceCache = new Map();                 // one xource per project: (project_id, ref) is unique
const insXell = async (projectId, slug, harnessId) => {
  let xo = xourceCache.get(projectId);
  if (!xo) {
    xo = (await one(
      `INSERT INTO xource (project_id, ref, head_commit) VALUES ($1,'main','deadbeef') RETURNING id`,
      [projectId])).id;
    xourceCache.set(projectId, xo);
    clean.push(cleanQ(`DELETE FROM xource WHERE id=$1`, [xo]));
  }
  const x = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, status, zee_type, harness_id)
       VALUES ($1,$2,$3,'spinoff/'||$3,'ready','worker',$4) RETURNING *`,
    [projectId, xo, slug, harnessId]);
  clean.push(cleanQ(`DELETE FROM xell WHERE id=$1`, [x.id]));
  return x;
};

try {
  // ── 1. the capability allowlist trigger ────────────────────────────────────
  console.log('\n── harness.capabilities is an ALLOWLIST (237): empty default fine, one legal value ──');
  let triggerErr = null;
  try { await q(`UPDATE harness SET capabilities='["banana"]'::jsonb WHERE key='infra-medic'`); }
  catch (e) { triggerErr = e; }
  ok(!!triggerErr && /unknown capability/.test(triggerErr.message),
     `an unknown capability is REFUSED by the trigger${triggerErr ? ` [${triggerErr.message.split('\n')[0].trim()}]` : ' — NO ERROR'}`);

  triggerErr = null;
  try { await q(`UPDATE harness SET capabilities='{"nope":1}'::jsonb WHERE key='infra-medic'`); }
  catch (e) { triggerErr = e; }
  ok(!!triggerErr && /must be a jsonb array/.test(triggerErr.message),
     `a non-array capabilities is REFUSED${triggerErr ? ` [${triggerErr.message.split('\n')[0].trim()}]` : ' — NO ERROR'}`);

  const h = await one(`SELECT capabilities FROM harness WHERE key='infra-medic'`);
  ok(JSON.stringify(h?.capabilities) === JSON.stringify(['infra-troubleshoot']),
     `the accepted value is intact after two refusals [${JSON.stringify(h?.capabilities)}]`);

  const h2 = await one(`SELECT capabilities FROM harness WHERE key='zee-base'`);
  ok(JSON.stringify(h2?.capabilities) === '[]', `an untouched harness still defaults to [] [${JSON.stringify(h2?.capabilities)}]`);

  // ── 2. the effective-chain gate ────────────────────────────────────────────
  console.log('\n── the gate walks the EFFECTIVE chain (inheritance counts, disabled grants nothing) ──');
  const medP = await insHarness(`im-medp-${tag}`, { capabilities: [INFRA_CAPABILITY] });
  const medC = await insHarness(`im-medc-${tag}`, { parent: medP });          // inherits
  const plainH = await insHarness(`im-plain-${tag}`);                          // no capability

  const p2 = await insProject(`im-p-${tag}`);
  const medicX = await insXell(p2, `im-medic-${tag}`, medC);
  const workerX = await insXell(p2, `im-worker-${tag}`, plainH);
  const bareX = await insXell(p2, `im-bare-${tag}`, null);

  const inherited = await xellCapabilities(medicX.id);
  ok(inherited.includes(INFRA_CAPABILITY),
     `a xell wearing a harness that INHERITS the medic counts [${JSON.stringify(inherited)}]`);
  ok(!(await hasInfraTroubleshoot(workerX.id)), 'a plain worker carries no capability');
  ok(!(await hasInfraTroubleshoot(bareX.id)), 'a harness-less xell carries no capability');

  let gateErr = null;
  try { await requireInfra(workerX); } catch (e) { gateErr = e; }
  ok(!!gateErr && gateErr.status === 403,
     `requireInfra REFUSES the plain worker with 403${gateErr ? ` [${gateErr.message.split('\n')[0].trim()}]` : ' — NO ERROR'}`);

  await q(`UPDATE harness SET enabled=false WHERE id=$1`, [medP]);
  ok(!(await hasInfraTroubleshoot(medicX.id)), 'a DISABLED ancestor grants nothing');
  await q(`UPDATE harness SET enabled=true WHERE id=$1`, [medP]);
  ok(await hasInfraTroubleshoot(medicX.id), 're-enabled, the inherited grant is back');

  // ── 3. the gated cards ─────────────────────────────────────────────────────
  console.log('\n── gated verbs FILE a pending card and perform NOTHING until a human decides ──');
  const p3 = await insProject(`im-c-${tag}`);
  const m3 = (await one(`INSERT INTO machine (key, docker_ctx, can_build, enabled) VALUES ($1,'local',true,true) RETURNING id`,
    [`im-m-${tag}`])).id;
  clean.push(cleanQ(`DELETE FROM machine WHERE id=$1`, [m3]));
  const pc3 = (await one(
    `INSERT INTO pool_config (project_id, default_db_coupling, target_ready) VALUES ($1,'db-isolated',0) RETURNING *`,
    [p3])).project_id;                            // pool_config is keyed by project_id, not id
  clean.push(cleanQ(`DELETE FROM pool_config WHERE project_id=$1`, [pc3]));
  const medic3 = await insXell(p3, `im-cmedic-${tag}`, medC);

  const card = await infraBootstrap(medic3, { machineId: m3, reason: 'needs a dev build' });
  ok(card.card?.kind === 'bootstrap' && card.card?.status === 'pending' && card.card?.payload?.machine_id === m3,
     'bootstrap files a PENDING card carrying the machine id');
  const actionsBefore = await q(`SELECT count(*)::int AS n FROM build_bootstrap_action`);
  ok(actionsBefore[0].n === 0, `nothing performed pre-approval (build_bootstrap_action = ${actionsBefore[0].n})`);

  const dup = await infraBootstrap(medic3, { machineId: m3 });
  ok(dup.existing === true && dup.card.id === card.card.id,
     'an open card is handed back, never duplicated');

  const reject = await decideInfraRequest(card.card.id, 'reject', 'human@test');
  ok(reject.status === 'rejected' && (await q(`SELECT count(*)::int AS n FROM build_bootstrap_action`))[0].n === 0,
     'REJECT performs nothing and the row records the decision');

  const pCard = await infraPropose(medic3, { change: JSON.stringify({ pool_config: { target_ready: 4 } }), reason: 'raise the pool target' });
  ok(pCard.card?.kind === 'propose' && pCard.card?.status === 'pending',
     'propose files a PENDING settings card');
  const cfgBefore = await one(`SELECT target_ready FROM pool_config WHERE project_id=$1`, [pc3]);
  ok(cfgBefore.target_ready === 0, 'the settings change is NOT applied before approval');

  let badPatch = null;
  try { await infraPropose(medic3, { change: { pool_config: { invented_knob: 1 } }, reason: 'x' }); } catch (e) { badPatch = e; }
  ok(!!badPatch && /not on the whitelist/.test(badPatch.message),
     `a field off the whitelist is refused at file time${badPatch ? ` [${badPatch.message.split('\n')[0].trim()}]` : ' — NO ERROR'}`);

  const approved = await decideInfraRequest(pCard.card.id, 'approve', 'human@test');
  ok(approved.status === 'completed' && Array.isArray(approved.result?.applied),
     'APPROVE performs and the receipt records what changed');
  const cfgAfter = await one(`SELECT target_ready FROM pool_config WHERE project_id=$1`, [pc3]);
  ok(cfgAfter.target_ready === 4, `pool_config.target_ready applied (0 → ${cfgAfter.target_ready})`);
  const lastChange = approved.result?.applied?.[0];
  ok(lastChange?.field === 'pool_config.target_ready' && lastChange?.by === 'human@test',
     `the receipt names the field and who approved [${lastChange?.field} by ${lastChange?.by}]`);

  // A bootstrap card whose machine is GONE by decision time → the queenzee performs (attempts),
  // fails closed, and the row records the failure as the receipt.
  const staleMachineId = randomUUID();
  const stale = await one(
    `INSERT INTO infra_request (project_id, xell_id, kind, payload, reason)
     VALUES ($1,$2,'bootstrap',$3::jsonb,'stale machine') RETURNING *`,
    [p3, medic3.id, JSON.stringify({ machine_id: staleMachineId })]);
  clean.push(cleanQ(`DELETE FROM infra_request WHERE id=$1`, [stale.id]));
  const staleDecided = await decideInfraRequest(stale.id, 'approve', 'human@test');
  ok(staleDecided.status === 'failed' && /machine not found/.test(staleDecided.result?.error || ''),
     `approve of a stale bootstrap card fails CLOSED and records the error [${(staleDecided.result?.error || '').split('\n')[0].trim()}]`);

  let alreadyDecided = null;
  try { await decideInfraRequest(pCard.card.id, 'reject', 'human@test'); } catch (e) { alreadyDecided = e; }
  ok(!!alreadyDecided && /already completed/.test(alreadyDecided.message),
     'a decided card cannot be decided twice');

  // ── 4. the settings projection leaks no secret column ─────────────────────
  console.log('\n── `zee infra settings` projects NO secret column (asserted against the live schema) ──');
  const c4 = (await one(
    `INSERT INTO container (project_id, role, tier, isolation, name, docker_ctx, health)
     VALUES ($1,'db','dev','shared',$2,'local','up') RETURNING id`,
    [p3, `im_db_${tag}`])).id;
  clean.push(cleanQ(`DELETE FROM container WHERE id=$1`, [c4]));
  await one(
    `INSERT INTO deploy_site (project_id, key, tier, docker_ctx) VALUES ($1, $2, 'dev','local') RETURNING id`,
    [p3, `im-site-${tag}`]);
  clean.push(cleanQ(`DELETE FROM deploy_site WHERE project_id=$1`, [p3]));

  const settings = await infraSettings(medic3);
  ok(settings.project?.id === p3 && settings.pool_config && settings.machines?.length === 1
     && settings.containers?.length === 1 && settings.deploy_sites?.length === 1,
     'the projection carries every section');

  // The secret set, computed from the LIVE schema: any column with a `*_hint` sibling is a secret
  // (its raw value is never read out); plus the code's explicit no-hint credentials. Kept as DATA,
  // exactly like lib/prod-readonly.js's SECRET_COLUMNS, so a secret column added later fails this
  // test instead of silently leaking.
  const cols = await q(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' ORDER BY table_name`);
  const byTable = {};
  for (const c of cols) (byTable[c.table_name] = byTable[c.table_name] || []).push(c.column_name);
  const secrets = new Set();
  for (const [t, cs] of Object.entries(byTable)) {
    const csSet = new Set(cs);
    for (const col of cs) if (csSet.has(`${col}_hint`)) secrets.add(`${t}.${col}`);
  }
  for (const [t, list] of Object.entries({
    provider_token: ['token'], environment_var: ['value'],
    xell: ['prod_ro_dsn', 'meta_ro_dsn'],
  })) for (const col of list) secrets.add(`${t}.${col}`);

  const flatKeys = [];
  const walk = (obj) => {
    if (Array.isArray(obj)) return obj.forEach(walk);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) { flatKeys.push(k); walk(v); }
    }
  };
  walk(settings);
  const leaked = [...secrets].filter((s) => {
    const [t, col] = s.split('.');
    return ['project', 'pool_config', 'machine', 'machine_pool', 'container', 'deploy_site'].includes(t)
      && flatKeys.includes(col);
  });
  ok(leaked.length === 0, `no secret column appears in the projection [secrets checked: ${secrets.size}]`
     + (leaked.length ? ` — LEAKED: ${leaked.join(', ')}` : ''));
  ok(!JSON.stringify(settings).includes('prod_ro_dsn') && !JSON.stringify(settings).includes('meta_ro_dsn'),
     'the projection names neither the prod reader nor the meta reader DSN columns');

  // ── 5. PRODRO_MODE=simulate mints nothing real ─────────────────────────────
  console.log('\n── PRODRO_MODE=simulate: the meta-RO bind mints NOTHING and a DSN that cannot authenticate ──');
  const p5 = await insProject(`im-ro-${tag}`);
  const roX = await insXell(p5, `im-rox-${tag}`, medC);
  const role = `zee_ro_${roX.slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;

  const minted = await mintMetaReader(roX);
  ok(minted.mode === 'simulate' && minted.dsn && minted.dsn.startsWith('postgresql://'),
     'simulate returns a DSN-shaped value and says SIMULATE');
  const roles = await q(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1`, [role]);
  ok(roles[0].n === 0, `no zee_ro_* role was created on the cluster (pg_roles count = ${roles[0].n})`);

  const stored = await one(`SELECT meta_ro_dsn FROM xell WHERE id=$1`, [roX.id]);
  ok(stored?.meta_ro_dsn === minted.dsn, 'the (simulate) DSN is stored on the xell row');

  const { Client } = await import('pg');
  const dial = new Client({ connectionString: minted.dsn, connectionTimeoutMillis: 3000 });
  let authErr = null;
  try { await dial.connect(); await dial.end(); } catch (e) { authErr = e; try { await dial.end(); } catch { /* */ } }
  ok(!!authErr, `the simulate DSN cannot authenticate (a role that was never created)${authErr ? ` [${authErr.message.split('\n')[0].trim().slice(0, 80)}]` : ' — IT CONNECTED'}`);

  const dropped = await dropMetaReader(roX);
  ok(dropped.dropped === true && (await one(`SELECT meta_ro_dsn FROM xell WHERE id=$1`, [roX.id]))?.meta_ro_dsn === null,
     'dropMetaReader clears the stored DSN (simulate drops nothing real, like mint creates nothing)');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  for (const fn of clean.reverse()) { try { await fn(); } catch { /* */ } }
  await pool.end().catch(() => {});
}
process.exit(fail ? 1 : 0);
