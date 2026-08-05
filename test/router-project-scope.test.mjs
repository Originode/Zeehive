// ROUTER LOOKUP IS PROJECT-SCOPED — across TWO projects, against a real database.
//
// Routing is strictly per project: every project has (at most) ONE router, a prompt composed on
// project A goes to A's router, and a project with NO live router is DETECTED and says so ("no live
// ROUTER on this project — deploy one") instead of failing silently or reaching another project's
// router. This file holds that whole sentence true with two projects in play at once, because every
// defect it covers is invisible with one:
//
//   (1) A ROUTER IS A WEARER OF `router` OR OF ANY DESCENDANT OF IT — the regression that motivated
//       this file. liveRouters matched the constant key `router` alone, while isRouterXell walks the
//       parent chain; a project's OWN router persona is necessarily a descendant (project-scoped
//       harnesses carry a project-derived key, `<project>-<label>`), so that project read as "no live
//       router" WITH one live: the composer offered "Deploy router" (a SECOND router — the wearer cap
//       counts one harness row), and every prompt routed on it was refused. On current code the
//       assertions below fail; with the family lookup they pass.
//   (2) ABSENCE IS AN ANSWER — routerStatus carries the same sentence routeRawPrompt throws, so the
//       console's deploy affordance and the refusal cannot drift apart.
//   (3) NO CROSS-PROJECT ROUTING — A's routing request lands on A's router and never B's; a project
//       with no router of its own is refused rather than served by somebody else's.
//   (4) DEPLOY GOES TO THE REQUESTING PROJECT — a deploy asked for project C claims from C's pool
//       only: with C empty and A holding a ready xell, it fails "no ready xell" and A's xell is still
//       ready afterwards. (The spawn itself is NOT exercised here — it wants a container.)
//   (5) A PROJECT MAY BE NAMED — the verbs resolve id-or-name like every other entry point
//       (lib/project-resolve.js). They took a bare uuid, so a caller naming its project got
//       `invalid input syntax for type uuid` instead of the detection in (2).
//
// Needs DATABASE_URL (a db-sandbox works). No agents spawned, no containers touched; the projects
// and harnesses created are removed in the finally.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.PROVISION_MODE = 'simulate';

const { q, one, pool } = await import('../server/src/db/pool.js');
const H = await import('../server/src/lib/harness.js');
const R = await import('../server/src/lib/router.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const throws = async (fn, re, m) => {
  try { await fn(); ok(false, `${m} (did not throw)`); }
  catch (e) { ok(re.test(e.message), `${m}\n      → ${String(e.message).slice(0, 150)}`); }
};

const tag = randomUUID().slice(0, 8);
const P = { A: { name: `zt-rs-a-${tag}` }, B: { name: `zt-rs-b-${tag}` }, C: { name: `zt-rs-c-${tag}` } };
// B's OWN router persona, keyed the way a project-scoped harness is keyed (<project>-<label>), and
// a grandchild of it — so the lookup is proved recursive rather than one level deep.
const keys = { bRouter: `ztrsb-router-${tag}`, bRouter2: `ztrsb-router2-${tag}` };

async function cleanup() {
  for (const k of [keys.bRouter2, keys.bRouter]) await q(`DELETE FROM harness WHERE key=$1`, [k]).catch(() => {});
  for (const p of Object.values(P)) if (p.id) await q(`DELETE FROM project WHERE id=$1`, [p.id]).catch(() => {});
}

async function mkProject(p) {
  p.id = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [p.name, `/tmp/${p.name}`])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [p.id]);
  p.xource = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [p.id])).id;
  return p;
}
const mkXell = (p, slug, { type = 'manager', status = 'working' } = {}) => one(
  `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [p.id, p.xource, slug, `spinoff/${slug}`, `/tmp/${slug}`, status, status === 'ready', type]);

try {
  await cleanup();

  const router = await one(`SELECT * FROM harness WHERE key='router'`);
  ok(!!router, 'the `router` harness is seeded (if this fails, your db is behind the ledger — 139)');

  // ── fixtures: three projects. A runs the SYSTEM-WIDE router persona, B its OWN (a descendant),
  //    C has none at all. ────────────────────────────────────────────────────────────────────────
  await mkProject(P.A); await mkProject(P.B); await mkProject(P.C);
  const xa = await mkXell(P.A, `zt-rs-a1-${tag}`);
  const xb = await mkXell(P.B, `zt-rs-b1-${tag}`);
  await H.assignHarness(xa.id, 'router');
  await q(`INSERT INTO harness (key,label,zee_type,parent_id,project_id) VALUES ($1,$2,'manager',$3,$4)`,
    [keys.bRouter, 'ZT B Router', router.id, P.B.id]);
  const bRouter = await one(`SELECT * FROM harness WHERE key=$1`, [keys.bRouter]);
  await q(`INSERT INTO harness (key,label,zee_type,parent_id,project_id) VALUES ($1,$2,'manager',$3,$4)`,
    [keys.bRouter2, 'ZT B Router v2', bRouter.id, P.B.id]);
  await H.assignHarness(xb.id, keys.bRouter2);   // a GRANDCHILD of `router`

  // ── 1. every project sees its OWN router, and only its own ──
  console.log('\n── liveRouters is scoped to the project AND covers the whole `router` family ──');
  const [sa, sb, sc] = await Promise.all([R.routerStatus(P.A.id), R.routerStatus(P.B.id), R.routerStatus(P.C.id)]);
  ok(sa.present === true && sa.routers.length === 1 && sa.routers[0].slug === xa.slug,
     `A: its own router is found (${sa.routers.map((r) => r.slug).join(', ') || 'none'})`);
  ok(sb.present === true && sb.routers.length === 1 && sb.routers[0].slug === xb.slug,
     `B: a wearer of B's OWN router persona (a descendant of \`router\`) IS a live router (${sb.routers.map((r) => r.slug).join(', ') || 'none'})`);
  ok(!sa.routers.some((r) => r.slug === xb.slug) && !sb.routers.some((r) => r.slug === xa.slug),
     'neither project sees the other\'s router');
  ok(sc.present === false && sc.routers.length === 0, 'C: no router, and none borrowed from A or B');
  ok(await R.isRouterXell(await one(`SELECT * FROM xell WHERE id=$1`, [xb.id])) === true
     && sb.present === true,
     'isRouterXell and liveRouters agree about the same xell (they must never disagree)');

  // ── 2. absence is an explicit answer, in the same words the refusal uses ──
  console.log('\n── a project with no live router is DETECTED and says so ──');
  ok(sc.reason === R.NO_LIVE_ROUTER && /deploy one/i.test(sc.reason || ''),
     `C's status carries the deploy sentence\n      → ${String(sc.reason || '(none)').slice(0, 120)}`);
  ok(sc.deployable === true && sc.at_limit === false, 'C: deployable — the composer shows "Deploy router"');
  ok(sa.reason === null && sb.reason === null, 'a project WITH a router carries no such reason');
  await throws(() => R.routeRawPrompt({ project: P.C.id, prompt: 'do a thing' }), /no live ROUTER/i,
     'routing on C is refused with the same sentence — never handed to A\'s or B\'s router');
  ok(sb.at_limit === true && sb.deployable === false,
     'B is AT the limit through its own persona — the composer offers no second router (one per project)');
  await throws(() => R.deployRouter({ project: P.B.id }), new RegExp(xb.slug),
     'deploying a second router into B is refused, naming B\'s live router');

  // ── 3. a routing request never crosses projects ──
  console.log('\n── routeRawPrompt hands the prompt to THIS project\'s router ──');
  // A refusal here is the FAILURE under test (a project whose router is its own persona could not be
  // routed to at all), so it is reported as one rather than left to abort the file.
  const route = async (p, prompt) => {
    try { return await R.routeRawPrompt({ project: p.id, prompt, by: 'zt-test' }); }
    catch (e) { ok(false, `${p.name}: routing was refused\n      → ${String(e.message).slice(0, 150)}`); return null; }
  };
  const ra = await route(P.A, `A prompt ${tag}`);
  const rb = await route(P.B, `B prompt ${tag}`);
  ok(ra?.router?.slug === xa.slug && rb?.router?.slug === xb.slug, 'each request names its own project\'s router');
  const ma = ra ? await one(`SELECT * FROM zee_message WHERE id=$1`, [ra.message_id]) : null;
  const mb = rb ? await one(`SELECT * FROM zee_message WHERE id=$1`, [rb.message_id]) : null;
  ok(ma?.to_xell_id === xa.id && String(ma?.project_id) === String(P.A.id),
     'A\'s 🧭 ROUTING REQUEST is stored to A\'s router, on A\'s project');
  ok(mb?.to_xell_id === xb.id && String(mb?.project_id) === String(P.B.id),
     'B\'s is stored to B\'s router, on B\'s project');
  ok(!(await q(`SELECT id FROM zee_message WHERE to_xell_id=$1 AND body LIKE $2`, [xa.id, `%B prompt ${tag}%`])).length,
     'B\'s prompt never reached A\'s router');

  // ── 3b. the project may be NAMED, like everywhere else in the API ──
  console.log('\n── the verbs take a project id OR a name (lib/project-resolve.js) ──');
  // Same reason as `route` above: a throw here IS the failure under test (a named project used to
  // die on the uuid cast), so it is reported, not allowed to abort the file.
  const statusOf = async (project, label) => {
    try { return await R.routerStatus(project); }
    catch (e) { ok(false, `${label}: routerStatus refused\n      → ${String(e.message).slice(0, 150)}`); return null; }
  };
  const byName = await statusOf(P.C.name, 'C by name');
  ok(byName?.present === false && byName?.reason === R.NO_LIVE_ROUTER,
     'a project addressed by NAME gets the detection, not `invalid input syntax for type uuid`');
  const namedA = await statusOf(P.A.name, 'A by name');
  ok(namedA?.routers[0]?.slug === xa.slug, 'and by name it is still THAT project\'s router');
  const rn = await route({ id: P.B.name, name: P.B.name }, `named prompt ${tag}`);
  ok(rn?.router?.slug === xb.slug
     && String((await one(`SELECT project_id FROM zee_message WHERE id=$1`, [rn.message_id]))?.project_id) === String(P.B.id),
     'a routing request by name is stored against the resolved project');
  await throws(() => R.routerStatus(`zt-no-such-project-${tag}`), /no project named/i,
     'an unknown project refuses by name, listing the projects that exist');
  await throws(() => R.routerStatus(null), /project required/i, 'no project at all is still refused');

  // ── 4. a gone wearer frees the detection (the descendant path obeys the same "live" set) ──
  console.log('\n── a retired router is not a live router ──');
  await q(`UPDATE xell SET status='retired' WHERE id=$1`, [xb.id]);
  const sbGone = await R.routerStatus(P.B.id);
  ok(sbGone.present === false && sbGone.reason === R.NO_LIVE_ROUTER && sbGone.deployable === true,
     'B is back to "no live ROUTER — deploy one" once its router is retired');
  await q(`UPDATE xell SET status='working' WHERE id=$1`, [xb.id]);

  // ── 5. a deploy claims from the REQUESTING project's pool ──
  console.log('\n── deployRouter deploys into the requesting project ──');
  const ready = await mkXell(P.A, `zt-rs-a-ready-${tag}`, { type: 'worker', status: 'ready' });
  await throws(() => R.deployRouter({ project: P.C.id }), /no ready xell/i,
     'a deploy for C finds nothing in C\'s pool — it does not reach into A\'s');
  ok((await one(`SELECT status FROM xell WHERE id=$1`, [ready.id]))?.status === 'ready',
     'A\'s ready xell was never claimed by another project\'s router deploy');
  // ── 6. the composer says which of the three states it is in (source-read: no browser here) ──
  console.log('\n── the console composer: loading / errored / no-router are three different things ──');
  const disp = readFileSync('web/src/Dispatch.jsx', 'utf8');
  ok(/setRouterSt\(null\); setRouterErr\(null\); setRouterLoading\(true\);/.test(disp),
     'switching project drops the previous project\'s status before asking (no stale router banner)');
  ok(/data-testid="dispatch-router-unknown"/.test(disp) && /routerErr/.test(disp),
     'a FAILED status call is shown, not silently turned into "this fleet has no router"');
  ok(/data-testid="dispatch-router-loading"/.test(disp),
     'the in-flight moment is visible while the answer is fetched');
  ok(/disabled=\{routerLoading \|\| \(routerGate && !liveRouter\)\}/.test(disp),
     'and it DECIDES nothing: submit is disabled until the router answer is in');
  ok(/data-testid="dispatch-router-missing"/.test(disp) && /routerSt\.reason/.test(disp),
     'the no-router banner carries the server\'s own sentence (NO_LIVE_ROUTER) beside the Deploy button');
} finally {
  await cleanup();
  await pool.end();
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);
