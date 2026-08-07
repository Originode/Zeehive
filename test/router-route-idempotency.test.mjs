// ROUTER ROUTE IDEMPOTENCY — one routing request per human action (the double-deploy fix, 150).
//
// THE DEFECT: a single "Route via router" action in the console could produce TWO 🧭 ROUTING
// REQUEST messages for the same prompt. The composer is fire-and-forget (App.jsx runDispatch
// closes the modal and reports through a toast), so a double-click on the submit button — or
// Cmd+Enter landing in the same tick as a click — fired onDispatch TWICE for ONE action. Each
// POST /api/router/route inserted its own zee_message row, the router read two messages as two
// prompts, and it dispatched a worker for each: one action, two deployments, then a "stand down"
// spent telling the duplicate to stop.
//
// THE FIX, and what this file holds true:
//
//   (1) A composer that sends a `client_request_id` (one per composition, stable across a
//       double-submit) can never enqueue the same routing request twice. The FIRST call records
//       the key in router_route_dedup; a SECOND call naming the same key for the same project is
//       REFUSED LOUDLY (named reason — never silently dropped), and the message count stays at
//       ONE for that prompt.
//   (2) The dedup is a UNIQUE index, so two CONCURRENT calls with the same key cannot both slip
//       through — postgres lets exactly one win, and the loser's message row is rolled back.
//   (3) A DIFFERENT key is a genuinely different human action and routes normally.
//   (4) A caller with NO key (a CLI, a script, an MCP client) is untouched — the route behaves
//       exactly as it always did.
//   (5) The wearer cap (assignHarness) is now ATOMIC: two concurrent assigns of a limit-1 harness
//       on the same project cannot both succeed. This is the deploy-side of the same double-deploy
//       — the limit check and the harness write run in one transaction with a row lock, so the
//       second assign counts the first's wearer and refuses.
//
// Needs DATABASE_URL (a db-sandbox works). No agents spawned, no containers touched; everything
// created is removed in the finally.
import { randomUUID } from 'node:crypto';

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
const P = { name: `zt-rrid-${tag}` };
const BY = 'zt-route-idempotency';

async function cleanup() {
  if (P.id) await q(`DELETE FROM project WHERE id=$1`, [P.id]).catch(() => {});
}

async function mkXell(slug, type = 'manager', status = 'working') {
  return one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7) RETURNING *`,
    [P.id, P.xource, slug, `spinoff/${slug}`, `/tmp/${slug}`, status, type]);
}
const msgCount = async (xellId) =>
  (await one(`SELECT count(*)::int AS n FROM zee_message WHERE to_xell_id=$1 AND kind='directive'`, [xellId])).n;

try {
  await cleanup();
  P.id = (await one(`INSERT INTO project (name, repo_root, main_branch) VALUES ($1,$2,'master') RETURNING id`,
    [P.name, `/tmp/${P.name}`])).id;
  await q(`INSERT INTO pool_config (project_id) VALUES ($1)`, [P.id]);
  P.xource = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [P.id])).id;
  const router = await mkXell(`zt-rrid-router-${tag}`);
  await H.assignHarness(router.id, 'router');
  const st = await R.routerStatus(P.id);
  ok(st.present === true, 'the fixture router is live');

  // ── 1. the SAME client_request_id is refused loudly, and only ONE message is enqueued ──
  console.log('\n── a double-submit (same client_request_id) enqueues ONE routing request ──');
  const key = `req-${tag}`;
  const first = await R.routeRawPrompt({ project: P.id, prompt: 'make the header sticky', by: BY,
                                         client_request_id: key });
  ok(first.ok === true && first.message_id, 'the FIRST route with a key is accepted');
  await throws(() => R.routeRawPrompt({ project: P.id, prompt: 'make the header sticky', by: BY,
                                        client_request_id: key }),
    /already enqueued|double-submit/i,
    'the SECOND route with the SAME key is refused LOUDLY (named reason)');
  const n = await msgCount(router.id);
  ok(n === 1, `exactly ONE routing request reaches the router (got ${n})`);

  // ── 2. concurrent same-key routes: exactly one wins ──
  console.log('\n── two CONCURRENT same-key routes: the UNIQUE index lets exactly one through ──');
  const key2 = `req-race-${tag}`;
  const racer = async () => {
    try { return await R.routeRawPrompt({ project: P.id, prompt: 'concurrent prompt', by: BY, client_request_id: key2 }); }
    catch (e) { return { refused: e.message }; }
  };
  const [r1, r2] = await Promise.all([racer(), racer()]);
  const okCount = [r1, r2].filter((r) => r.ok === true).length;
  const refCount = [r1, r2].filter((r) => r.refused).length;
  ok(okCount === 1 && refCount === 1,
     `concurrent same-key: one accepted, one refused (${okCount} ok / ${refCount} refused)`);
  const n2 = await msgCount(router.id);
  ok(n2 === 2, `the concurrent race added exactly ONE more message (got ${n2})`);

  // ── 3. a DIFFERENT key is a different action and routes normally ──
  console.log('\n── a fresh key (a genuine second prompt) is NOT a duplicate ──');
  const second = await R.routeRawPrompt({ project: P.id, prompt: 'ship it', by: BY,
                                          client_request_id: `req-2-${tag}` });
  ok(second.ok === true, 'a fresh key routes normally');
  ok((await msgCount(router.id)) === 3, 'three distinct actions → three messages');

  // ── 4. no key (CLI/script caller) is untouched ──
  console.log('\n── a caller with no client_request_id behaves exactly as before ──');
  const nokey = await R.routeRawPrompt({ project: P.id, prompt: 'no key route', by: BY });
  ok(nokey.ok === true, 'no-key route is accepted');
  ok((await msgCount(router.id)) === 4, '…and enqueues its message like always');

  // ── 5. the wearer cap is atomic under concurrency (the deploy-side of the same bug) ──
  console.log('\n── assignHarness: two concurrent assigns of a limit-1 harness cannot both succeed ──');
  await q(`UPDATE xell SET harness_id=NULL WHERE project_id=$1`, [P.id]);
  const x1 = await mkXell(`zt-rrid-a-${tag}`);
  const x2 = await mkXell(`zt-rrid-b-${tag}`);
  const results = await Promise.allSettled([
    H.assignHarness(x1.id, 'router'),
    H.assignHarness(x2.id, 'router'),
  ]);
  const okN = results.filter((r) => r.status === 'fulfilled').length;
  const refN = results.filter((r) => r.status === 'rejected').length;
  ok(okN === 1 && refN === 1, `exactly one assign wins, one is refused (${okN} ok / ${refN} refused)`);
  const wearers = await q(
    `SELECT slug FROM xell
      WHERE harness_id=(SELECT id FROM harness WHERE key='router')
        AND project_id=$1 AND status NOT IN ('retired','tearing-down','husk')`, [P.id]);
  ok(wearers.length === 1, `at most ONE live router wearer (got ${wearers.length})`);
  if (wearers.length > 1) {
    ok(false, `the cap was violated: ${wearers.map((w) => w.slug).join(', ')} all wear the limit-1 harness`);
  }
} finally {
  await cleanup();
  await pool.end();
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nall good');
process.exit(fail ? 1 : 0);
