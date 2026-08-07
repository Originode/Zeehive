// THE ROUTER ZEE + ROUTER/LIMIT POLICIES (migration 139) — against a real database.
//
// What ships in 139, and what this file holds true:
//
//   (1) harness.model_policy gains `limit` — max LIVE xells wearing a harness PER PROJECT,
//       normalized like every other knob, merged MIN-WINS down the parent chain (a child cannot
//       widen a cap), and ENFORCED at assign time (assignHarness), which every persona-granting
//       path funnels through. Excluding the target xell itself, so re-assigning/swapping the same
//       persona on the same xell is never refused by its own presence.
//   (2) harness.router_policy — the routing knobs (provider_weights, provider_schedule,
//       max_concurrent, default_mode, rewrite, max_task_chars, fallback_provider), normalized
//       defensively (lib/router-policy.js) and merged leaf-wins.
//   (3) the `router` harness row — zee_type MANAGER (that is the safety story: no land, no ship,
//       prod read-only, `zee sync` allowed — all structural, none of it prose), parent `manager`,
//       shipped with limit 1 so "the router" is singular.
//   (4) the read model + verbs (lib/router.js): routerStatus (present/at_limit/deployable, the
//       live router's provider+model for the swap UI), deployRouter refusing at the limit, and
//       routeRawPrompt refusing with no live router / recording a 🧭 ROUTING REQUEST (kind
//       'directive', policy snapshot embedded) when one is live.
//
// Needs DATABASE_URL (a db-sandbox works). No agents spawned, no containers touched; everything
// created is removed in the finally.
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const { normalizePolicy, mergePolicies, effectiveModelPolicy } = await import('../server/src/lib/model-policy.js');
const { normalizeRouterPolicy, mergeRouterPolicies, providerInSchedule, effectiveRouterPolicy } =
  await import('../server/src/lib/router-policy.js');
const H = await import('../server/src/lib/harness.js');
const R = await import('../server/src/lib/router.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const throws = async (fn, re, m) => {
  try { await fn(); ok(false, `${m} (did not throw)`); }
  catch (e) { ok(re.test(e.message), `${m}\n      → ${String(e.message).slice(0, 150)}`); }
};

const tag = randomUUID().slice(0, 8);
const P = { name: `zt-router-${tag}` };
const keys = { child: `zt-router-child-${tag}` };

// The router's knobs are OPERATOR-EDITABLE (that is the feature), so this db's row may carry any
// values by the time this test runs. Pin the seeded shape for the duration and RESTORE the
// operator's own values in the finally — a test that asserted the seed against a tuned fleet
// would read as a regression that is really a knob.
let savedRouterPolicy = null;
async function pinRouterPolicy() {
  const r = await one(`SELECT router_policy FROM harness WHERE key='router'`);
  savedRouterPolicy = r ? JSON.stringify(r.router_policy ?? {}) : null;
  if (r) {
    await q(`UPDATE harness SET router_policy='{"rewrite":"concise","default_mode":5,"max_task_chars":4000}'::jsonb
              WHERE key='router'`);
  }
}

async function cleanup() {
  await q(`DELETE FROM harness WHERE key=$1`, [keys.child]).catch(() => {});
  if (P.id) await q(`DELETE FROM project WHERE id=$1`, [P.id]).catch(() => {});
  if (savedRouterPolicy != null) {
    await q(`UPDATE harness SET router_policy=$1::jsonb WHERE key='router'`, [savedRouterPolicy]).catch(() => {});
  }
}

try {
  await cleanup();
  await pinRouterPolicy();

  // ── 0. the migration is in the schema, and the router harness is what 139 says ──
  console.log('\n── migration 139 is applied ──');
  const col = await q(`SELECT column_name FROM information_schema.columns
                        WHERE table_name='harness' AND column_name='router_policy'`);
  ok(col.length === 1, 'harness.router_policy exists (if this fails, your db is behind the ledger)');
  const router = await one(`SELECT h.*, p.key AS parent_key FROM harness h
                              LEFT JOIN harness p ON p.id=h.parent_id WHERE h.key='router'`);
  ok(!!router, 'the `router` harness is seeded');
  ok(router?.zee_type === 'manager', 'it is MANAGER-type — no land, no ship, prod read-only, all structural');
  ok(router?.parent_key === 'manager', 'it inherits the manager manual (parent `manager`)');
  ok(router?.model_policy?.limit === 1, 'its model_policy carries limit 1 — "the router" is singular');
  const bundle = typeof router?.bundle === 'string' ? JSON.parse(router.bundle) : (router?.bundle || {});
  ok(/ROUTING REQUEST/.test(bundle.personality || ''), 'its persona teaches the 🧭 ROUTING REQUEST intake');
  ok(/zee work --new/.test(bundle.personality || '') && /zee assign/.test(bundle.personality || ''),
     '…and deploying workers onto CARDS with `zee work --new` + `zee assign` (151 — a router routes onto the board)');
  ok(/do not manage the zees you route/.test(bundle.personality || ''),
     '…and that it does NOT manage the zees it deploys (151)');
  ok(/zee sync/.test(bundle.personality || ''), '…and keeping its worktree current with `zee sync`');

  // ── 1. the `limit` knob normalizes and merges min-wins ──
  console.log('\n── model_policy.limit: normalize + min-wins merge ──');
  ok(normalizePolicy({ limit: 3 }).limit === 3, 'limit 3 survives normalization');
  ok(normalizePolicy({ limit: '2' }).limit === 2, 'a string limit is coerced');
  ok(normalizePolicy({ limit: -1 }).limit === null, 'a negative limit degrades to unset');
  ok(!('limit' in normalizePolicy({})), 'an absent limit stays absent (sparse policy)');
  ok(mergePolicies([{ limit: 5 }, { limit: 2 }]).limit === 2, 'child narrows the cap (5→2 = 2)');
  ok(mergePolicies([{ limit: 1 }, { limit: 9 }]).limit === 1, 'child cannot WIDEN it (1 stays 1) — min-wins');
  ok(mergePolicies([{}, { limit: 4 }]).limit === 4, 'a cap introduced anywhere in the chain binds');
  ok(mergePolicies([{}, {}]).limit === null, 'no cap anywhere = unlimited');

  // ── 2. router_policy normalization + merge ──
  console.log('\n── router_policy: defensive normalize, leaf-wins merge, schedule windows ──');
  const rp = normalizeRouterPolicy({
    provider_weights: { claude: 2, kimi: '1', junk: -4 },
    provider_schedule: { claude: { days: [1, 2, 9], hours: [9, 17] }, kimi: { hours: [22, 6] }, bad: {} },
    max_concurrent: '3', default_mode: 7, rewrite: 'CONCISE', max_task_chars: 0, fallback_provider: ' claude ',
  });
  ok(rp.provider_weights.claude === 2 && rp.provider_weights.kimi === 1 && !('junk' in rp.provider_weights),
     'weights: numbers coerced, negatives dropped');
  ok(JSON.stringify(rp.provider_schedule.claude.days) === '[1,2]' && !('bad' in rp.provider_schedule),
     'schedule: out-of-range days dropped, empty windows dropped');
  ok(rp.max_concurrent === 3 && rp.default_mode === null && rp.rewrite === 'concise' && rp.max_task_chars === null,
     'scalars: coerced, out-of-range degrades to unset, style lowercased');
  ok(rp.fallback_provider === 'claude', 'fallback provider is trimmed');
  const merged = mergeRouterPolicies([{ provider_weights: { claude: 1 }, rewrite: 'structured' },
                                      { provider_weights: { kimi: 3 } }]);
  ok(merged.provider_weights.claude === 1 && merged.provider_weights.kimi === 3 && merged.rewrite === 'structured',
     'merge: per-provider leaf-wins for the maps, leaf-wins scalars');
  const schedPol = { provider_schedule: { claude: { hours: [9, 17] }, kimi: { hours: [22, 6] } } };
  const at = (h) => new Date(Date.UTC(2026, 0, 5, h, 0, 0));    // a Monday
  ok(providerInSchedule(schedPol, 'claude', at(12)) && !providerInSchedule(schedPol, 'claude', at(20)),
     'a plain window admits inside, refuses outside');
  ok(providerInSchedule(schedPol, 'kimi', at(23)) && providerInSchedule(schedPol, 'kimi', at(3))
     && !providerInSchedule(schedPol, 'kimi', at(12)),
     'a window may wrap midnight (22–6)');
  ok(providerInSchedule(schedPol, 'codex', at(12)), 'no entry = always available');
  const eff = await effectiveRouterPolicy(router);
  ok(eff.rewrite === 'concise' && eff.default_mode === 5, 'the seeded router policy resolves effectively (concise, mode 5)');

  // ── 3. fixtures: a project with three xells ──
  P.id = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [P.name, `/tmp/${P.name}`])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [P.id]);
  P.xource = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [P.id])).id;
  const mkXell = (slug, type = 'manager', status = 'working') => one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING *`,
    [P.id, P.xource, slug, `spinoff/${slug}`, `/tmp/${slug}`, status, type]);
  const x1 = await mkXell(`zt-r1-${tag}`);
  const x2 = await mkXell(`zt-r2-${tag}`);

  // ── 4. the read model BEFORE any router exists ──
  console.log('\n── routerStatus: absent → deployable, dispatch gated ──');
  let st = await R.routerStatus(P.id);
  ok(st.present === false && st.deployable === true && st.limit === 1,
     `no live router: present=false, deployable=true, limit=${st.limit}`);
  ok(st.harness?.key === 'router', 'the status names the harness (the console gates only when it exists)');
  await throws(() => R.routeRawPrompt({ project: P.id, prompt: 'do a thing' }), /no live ROUTER/i,
     'routing a raw prompt with no live router is refused, naming the fix');

  // ── 5. the wearer cap, enforced at assign ──
  console.log('\n── assignHarness enforces model_policy.limit per project ──');
  await H.assignHarness(x1.id, 'router');
  ok((await one(`SELECT harness_id FROM xell WHERE id=$1`, [x1.id]))?.harness_id === router.id,
     'the FIRST wearer is assigned (under the limit)');
  await throws(() => H.assignHarness(x2.id, 'router'), /limited to 1 live xell/i,
     'the SECOND wearer is refused, naming the limit and who wears it');
  await H.assignHarness(x1.id, 'router');
  ok(true, 're-assigning the SAME xell is not refused by its own presence (swap/redeploy path)');
  // a GONE wearer frees the slot
  await q(`UPDATE xell SET status='retired' WHERE id=$1`, [x1.id]);
  await H.assignHarness(x2.id, 'router');
  ok(true, 'a retired wearer frees the slot — the cap counts LIVE xells only');
  await q(`UPDATE xell SET harness_id=NULL WHERE id=$1`, [x2.id]);
  await q(`UPDATE xell SET status='working' WHERE id=$1`, [x1.id]);
  await H.assignHarness(x1.id, 'router');

  // ── 6. the read model WITH a live router, and the deploy refusal ──
  console.log('\n── routerStatus with a live router · deployRouter refuses at the limit ──');
  st = await R.routerStatus(P.id);
  ok(st.present === true && st.at_limit === true && st.deployable === false,
     'a live wearer: present=true, at_limit=true, deployable=false');
  ok(st.routers[0]?.slug === x1.slug, 'the status names the live router xell (the redeploy/swap UI reads this)');
  ok(st.policy?.rewrite === 'concise', 'the effective router policy rides the status (the knobs the console shows)');
  await throws(() => R.deployRouter({ project: P.id }), /limited to 1|redeploy or swap/i,
     'deploying a SECOND router is refused before any xell is claimed');

  // ── 7. routing a raw prompt to the live router ──
  console.log('\n── routeRawPrompt records a 🧭 ROUTING REQUEST with the policy snapshot ──');
  const routed = await R.routeRawPrompt({ project: P.id, prompt: 'make the header sticky on scroll',
                                          harness_hint: 'dev-builder', by: 'zt-test' });
  ok(routed.ok === true && routed.router?.slug === x1.slug, 'the request is accepted and names the router');
  const msg = await one(`SELECT * FROM zee_message WHERE id=$1`, [routed.message_id]);
  ok(msg?.kind === 'directive' && msg?.to_xell_id === x1.id, 'stored as a directive TO the router (audit trail)');
  ok(/ROUTING REQUEST/.test(msg?.body || '') && /make the header sticky/.test(msg?.body || ''),
     'the body carries the marker and the RAW prompt verbatim');
  ok(/"rewrite":\s*"concise"/.test(msg?.body || ''), '…and the effective policy snapshot (obey NOW, not at brief time)');
  ok(/dev-builder/.test(msg?.body || '') && /HINT, not a decision/.test(msg?.body || ''),
     '…and the persona-button hint, marked as a hint');
  ok(routed.delivered === false, 'with no live cage the delivery is honestly "not delivered" (inbox pickup)');

  // ── 7b. the ship door closes for a router (land is already closed for every manager) ──
  console.log('\n── a router may not ship (a plain manager may ask; a router may not) ──');
  const S = await import('../server/src/queenzee/self.js');
  ok(await R.isRouterXell(await one(`SELECT * FROM xell WHERE id=$1`, [x1.id])) === true,
     'isRouterXell recognises the wearer');
  const shipTry = await S.selfShip(await one(`SELECT * FROM xell WHERE id=$1`, [x1.id]), { reason: 'zt' });
  ok(shipTry?.ok === false && /ROUTER zee routes prompts/.test(shipTry?.error || ''),
     `\`zee ship\` from a router is refused by name\n      → ${String(shipTry?.error || '').slice(0, 120)}`);
  // land: routers are manager-type, and the manager refusal already covers them — assert it holds.
  const landTry = await S.selfLand(await one(`SELECT * FROM xell WHERE id=$1`, [x1.id]));
  ok(landTry?.ok === false && /MANAGER zee has zero push/.test(landTry?.error || ''),
     'land is refused too (the manager wall, inherited structurally)');

  // ── 8. a child of router inherits the cap and the knobs ──
  console.log('\n── inheritance: a router child cannot widen the cap ──');
  await q(`INSERT INTO harness (key, label, zee_type, parent_id, model_policy, router_policy)
           VALUES ($1,'ZT Router Child','manager',$2,'{"limit": 5}'::jsonb,'{"rewrite":"verbatim"}'::jsonb)`,
    [keys.child, router.id]);
  const child = await one(`SELECT * FROM harness WHERE key=$1`, [keys.child]);
  const childPol = await effectiveModelPolicy(child);
  ok(childPol.limit === 1, `a child declaring limit 5 under router's 1 is still capped at 1 (got ${childPol.limit})`);
  const childRp = await effectiveRouterPolicy(child);
  ok(childRp.rewrite === 'verbatim' && childRp.default_mode === 5,
     'router_policy inherits leaf-wins: child overrides rewrite, keeps the parent default_mode');
} finally {
  await cleanup();
  await pool.end();
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);
