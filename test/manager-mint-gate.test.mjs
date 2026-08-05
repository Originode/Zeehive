// THE MANAGER-MINT GATE + ONE-SHOT HARNESSES (migration 149), against a real database.
//
// Two operator decisions, one migration, and this is the test that says what they mean:
//
//   "allow routers to mint managers if the task is substantial pending human approval.
//    routers should be one shot and context cleared regularly to reduce token consumption"
//
// (A) THE GATE. A manager has never been something an agent could create — lib/manager-spawn.js says
//     why ("a manager that could mint managers is a fleet that grows sideways with nobody's
//     consent") and `zee dispatch` refuses a manager harness outright. 149 does not weaken that: it
//     adds an ASK. A ROUTER files a request, a HUMAN decides it, and the QUEENZEE mints on approval
//     through the very same createManagerZee the console's own button calls.
//
//     So the load-bearing assertions here are the REFUSALS, not the happy path: a worker cannot ask,
//     a crew-running manager cannot ask, an approval is the only thing that produces a manager, and
//     a rejected/withdrawn request produces nothing at all.
//
// (B) ONE-SHOT. `harness.one_shot` makes every queenzee-started turn a FRESH session instead of a
//     resume, so context (and the bill for re-sending it) does not accumulate. It is a harness
//     setting like enable_reflection, INHERITED down the chain, and ON for `router`. The wearer is
//     told — a fresh session that does not know it is one-shot writes itself notes it will never
//     read — so the persona text and the nudge preamble are asserted too.
//
// Needs DATABASE_URL. It creates a throwaway project + xells and deletes them in the finally; it
// never mints a real manager (the mint path is exercised as far as the queenzee's own dispatch,
// which a test database has no pool for — see the note on the approval case).
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build as esbuild } from 'esbuild';
import { q, one, pool } from '../server/src/db/pool.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const section = (t) => console.log(`\n── ${t} ──`);

const { requestManagerMint, managerMintStatusFor, withdrawManagerMint,
        listManagerMintRequests, decideManagerMint, dismissManagerMint } =
  await import('../server/src/lib/manager-mint.js');
const { selfMintManager } = await import('../server/src/queenzee/self.js');
const { hiveStatus, HIVE_STATUS } = await import('../server/src/lib/hive-status.js');

const tag = `zt-mm-${Math.random().toString(16).slice(2, 8)}`;
let projectId = null;
let xourceId = null;
const madeXells = [];

const mkXell = async (slug, { zeeType = 'worker', harnessKey = null } = {}) => {
  const h = harnessKey ? await one(`SELECT id FROM harness WHERE key=$1`, [harnessKey]) : null;
  const row = await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled, zee_type, harness_id)
     VALUES ($1,$2,$3,$4,$5,'claimed',false,$6,$7) RETURNING *`,
    [projectId, xourceId, slug, `spinoff/${slug}`, `/tmp/${slug}`, zeeType, h?.id || null]);
  madeXells.push(row.id);
  return row;
};

try {
  section('149 is in the ledger');
  const applied = await q(`SELECT filename FROM schema_migrations WHERE filename LIKE '149\\_%'`);
  ok(applied.length === 1, '149 has been applied (if this fails: npm run db:migrate)');
  const col = await q(`SELECT column_name FROM information_schema.columns
                        WHERE table_name='harness' AND column_name='one_shot'`);
  ok(col.length === 1, 'harness.one_shot exists');
  const tbl = await q(`SELECT to_regclass('public.manager_mint_request') AS t`);
  ok(tbl[0]?.t, 'manager_mint_request exists');

  projectId = (await one(`INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
                         [tag, `/tmp/${tag}`])).id;
  xourceId = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [projectId])).id;

  const router = await mkXell(`${tag}-router`, { zeeType: 'manager', harnessKey: 'router' });
  const manager = await mkXell(`${tag}-manager`, { zeeType: 'manager', harnessKey: 'manager' });
  const worker = await mkXell(`${tag}-worker`, { zeeType: 'worker', harnessKey: 'dev-builder' });

  // ── (A) who may ask ──
  section('only a ROUTER may ask — and it is an ask, never a mint');
  const asWorker = await selfMintManager(worker, { reason: 'I would like a crew' });
  ok(asWorker.ok === false && /MANAGER verb/.test(asWorker.error || ''),
     'a WORKER is refused, and told what a manager verb is');
  const asManager = await selfMintManager(manager, { reason: 'I would like a peer' });
  ok(asManager.ok === false && /ROUTER/.test(asManager.error || '') && /zee assign/.test(asManager.error || ''),
     'a crew-running MANAGER is refused, and pointed at the hands it already has (`zee assign`)');

  const noReason = await selfMintManager(router, { reason: '   ' });
  ok(noReason.ok === false && /--reason/.test(noReason.error || ''),
     'a router with no reason is refused — the reason IS the ask a human reads');

  const asked = await selfMintManager(router, {
    reason: 'four independent strands, each needing its own branch and review; the first three block the fourth',
    task: 'Run the migration-hygiene programme: …',
  });
  ok(asked.ok === true && asked.request?.status === 'pending', 'a ROUTER may ask, and the row is PENDING');
  ok(/human must approve/i.test(asked.message || ''), '…and is told a human decides it');
  const noManagerYet = await q(
    `SELECT count(*)::int AS n FROM xell WHERE project_id=$1 AND zee_type='manager'`, [projectId]);
  ok(noManagerYet[0].n === 2, 'asking created NO manager (the two are the fixtures) — the ask is not the mint');

  section('one open ask per router, withdrawable, and visible to a human');
  const again = await selfMintManager(router, { reason: 'the same programme, asked twice' });
  ok(again.request?.id === asked.request.id && /already have an open/.test(again.note || ''),
     'a second ask returns the SAME open request instead of stacking a card');
  const open = await listManagerMintRequests(projectId);
  ok(open.length === 1 && open[0].live_xell_slug === router.slug,
     'the console read model shows it, naming the router that asked');
  const sig = { managerMintPending: true };
  ok(hiveStatus({ status: 'claimed' }, sig) === 'occ-mintRequest'
     && HIVE_STATUS['occ-mintRequest'].label === 'manager?',
     "the hexagon reads `manager?` while it waits");
  ok(hiveStatus({ status: 'claimed' }, { managerMintPending: true, landPending: true }) === 'occ-landRequest',
     '…and a BLOCKING gate still outranks it (a router keeps routing while it waits)');

  const withdrawn = await withdrawManagerMint({ xellId: router.id, reason: 'sized it down to one worker' });
  ok(withdrawn.withdrawn === true, 'the router can UN-ASK (nothing minted, nothing rejected)');
  ok((await managerMintStatusFor(router.id))?.status === 'withdrawn', '…and its own status says so');
  ok((await listManagerMintRequests(projectId)).length === 0, 'the card leaves the human’s screen');

  // ── the human's decision ──
  section('a human decides — and a rejection produces nothing');
  const second = await selfMintManager(router, { reason: 'a genuine programme: three strands, one crew' });
  const rejected = await decideManagerMint(second.request.id, 'rejected', 'zz-test@console',
                                           { note: 'dispatch a worker' });
  ok(rejected.status === 'rejected' && rejected.decided_by === 'zz-test@console',
     'reject closes the row and records who decided it');
  ok((await q(`SELECT count(*)::int AS n FROM xell WHERE project_id=$1 AND zee_type='manager'`,
              [projectId]))[0].n === 2, 'and no manager was created');
  const redecide = await decideManagerMint(second.request.id, 'approved', 'zz-test@console').catch((e) => e.message);
  ok(typeof redecide === 'string' && /already decided/.test(redecide),
     'a decided request cannot be decided twice');

  section('approval is the ONLY path to a manager, and it runs the queenzee’s own mint');
  // The approval path calls createManagerZee → dispatchXell, which needs a real pool/worktree this
  // test database does not have. What matters here is the CONTRACT, so it is asserted at the seam:
  // the request lands on 'failed' with the reason (never silently on 'created'), the row keeps the
  // receipt, and — the load-bearing part — a manager only ever comes from this human-owned call.
  const third = await selfMintManager(router, { reason: 'the third ask, approved by a human' });
  const decided = await decideManagerMint(third.request.id, 'approved', 'zz-test@console');
  ok(['created', 'failed'].includes(decided.status),
     `approval RAN the mint (status=${decided.status}) rather than leaving the row pending`);
  if (decided.status === 'failed') {
    ok(!!decided.result?.error, '…and a mint that could not complete says why on the row (never a silent success)');
  } else {
    ok(!!decided.created_xell_id, '…and a completed mint records the xell it produced');
  }
  const mintCall = readFileSync(join(ROOT, 'server/src/lib/manager-mint.js'), 'utf8');
  ok(/createManagerZee/.test(mintCall) && /manager-spawn/.test(mintCall),
     'the approve path calls createManagerZee — the same function the console button calls');
  // …and no SELF verb (the surface a caged agent can reach) calls it. Comments may name it — this
  // looks for the call and the import, which are the two ways code could actually reach the mint.
  const selfSrc = readFileSync(join(ROOT, 'server/src/queenzee/self.js'), 'utf8');
  ok(!/createManagerZee\s*\(/.test(selfSrc) && !/import\s*\{[^}]*createManagerZee/.test(selfSrc),
     'and NO self verb reaches the mint directly (an agent cannot create a manager)');

  // ── (B) one-shot ──
  section('one-shot: the router runs a FRESH session every turn');
  const routerH = await one(`SELECT key, one_shot FROM harness WHERE key='router' AND project_id IS NULL`);
  ok(routerH?.one_shot === true, 'the router harness is one_shot');
  const base = await one(`SELECT key, one_shot FROM harness WHERE key='manager' AND project_id IS NULL`);
  ok(base?.one_shot === false, '…and its parent is NOT (the setting is the persona’s, not the type’s)');
  const nudge = readFileSync(join(ROOT, 'server/src/queenzee/nudge.js'), 'utf8');
  ok(/harnessIsOneShot/.test(nudge) && /sessionId: oneShot \? null :/.test(nudge),
     'the resume path passes NO session id for a one-shot wearer');
  ok(/while \(cur && hops/.test(nudge.slice(nudge.indexOf('async function harnessIsOneShot'))),
     '…and it walks the parent chain, so a project’s own router persona inherits the economics');
  ok(/!oneShot && adapter\.needsSid/.test(nudge),
     'the "no session id to resume" refusal does not fire for a wearer that is not meant to resume');
  ok(/FRESH SESSION/.test(nudge) && /PERSONA\.md/.test(nudge),
     'the fresh turn carries a re-orientation preamble naming the persona files already in the cage');
  const persona = (await one(`SELECT bundle->>'personality' AS p FROM harness WHERE key='router'`))?.p || '';
  ok(/You are ONE-SHOT/.test(persona), 'the router persona tells its wearer it is one-shot');
  ok(/zee mint-manager/.test(persona), '…and that it may ASK for a manager');
  const manual = (await one(`SELECT harness_memory_get('manager','memory/manager-zee-manual.md') AS t`))?.t || '';
  ok(/zee mint-manager/.test(manual),
     'the manager manual documents the verb (house rule 8 — cxell-cli-drift enforces it)');
  // ── the human's side actually DRAWS ──
  // A gate a human cannot see is a gate nobody can answer, and the static greps above prove the
  // props are passed, not that the card renders. Same esbuild+SSR seam test/fleet-pause.test.mjs
  // uses for its control.
  section('the console card renders — reason, programme and both buttons');
  const outDir = mkdtempSync(join(ROOT, '.mintrender-'));
  try {
    const bundle = join(outDir, 'bundle.mjs');
    await esbuild({
      stdin: { contents: "export { default as ManagerMintPanel } from './web/src/ManagerMint.jsx';\n",
               resolveDir: ROOT, sourcefile: 'render-entry.js', loader: 'js' },
      bundle: true, format: 'esm', outfile: bundle, jsx: 'automatic', logLevel: 'silent',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    });
    const { ManagerMintPanel } = await import(pathToFileURL(bundle).href);
    const html = renderToStaticMarkup(React.createElement(ManagerMintPanel, {
      requests: [{ id: 'r1', status: 'pending', live_xell_slug: 'router-zee-1',
                   reason: 'three strands, two block the third', task: 'the programme',
                   harness_key: 'manager', requested_at: new Date(0).toISOString() }],
      onDone: () => {},
    }));
    ok(/awaiting you/.test(html), 'a pending ask draws as something awaiting a human');
    ok(/three strands, two block the third/.test(html), '…with the router\u2019s reason on it');
    ok(/the programme/.test(html), '…and the programme the manager would be briefed with');
    ok(/Reject/.test(html) && /Approve &amp; mint/.test(html), '…and both decisions as buttons');
    const receipt = renderToStaticMarkup(React.createElement(ManagerMintPanel, {
      requests: [{ id: 'r2', status: 'created', created_slug: 'manager-zee-9',
                   requested_at: new Date(0).toISOString() }], onDone: () => {},
    }));
    ok(/manager-zee-9/.test(receipt) && !/Approve/.test(receipt),
       'a completed mint reads as a receipt naming the xell, with no buttons left');
    ok(renderToStaticMarkup(React.createElement(ManagerMintPanel, { requests: [] })) === '',
       'and nothing at all is drawn when there is nothing to decide');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
} catch (e) {
  console.error('\n✗ FAIL — the test threw:', e.stack || e.message);
  fail++;
} finally {
  // Clean up EVERYTHING this test created, whatever happened (house rule 1).
  try {
    if (projectId) {
      await q(`DELETE FROM manager_mint_request WHERE project_id=$1`, [projectId]);
      await q(`DELETE FROM xell WHERE project_id=$1`, [projectId]);
      await q(`DELETE FROM xource WHERE project_id=$1`, [projectId]);
      await q(`DELETE FROM project WHERE id=$1`, [projectId]);
    }
  } catch (e) { console.error('cleanup:', e.message); }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n✗ ${fail} check(s) failed\n` : '\nAll checks passed\n');
process.exit(fail ? 1 : 0);
