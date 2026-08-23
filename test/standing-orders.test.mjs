// CREW STANDING ORDERS — a manager's short block, appended VERBATIM to every brief it dispatches
// (ticket #74, card c2382392-ce62-47ea-9523-694b2ed4a7d7).
//
// The ticket's story: a manager retyped the same block into every brief — read CLAUDE.md first, get a
// real database, never hand-edit .zeehive.env, land early, watch assertions fail first — and the two
// briefs that LEFT A LINE OUT produced the two workers that reported NOTHING. The fix is to store the
// block ONCE on the manager's own xell row and append it VERBATIM to every brief it dispatches.
//
// What is asserted here, server-side (a CLI check is not a check):
//   1. THE LIB — standingOrdersBlock() builds the clearly-marked SEPARATE block and returns NULL for
//      empty/unset (empty is exactly today, byte-identical); standingOrdersForXell() reads the row;
//      appendStandingOrders() is the ONE place a brief becomes a brief-with-standing-orders;
//   2. THE VERB — selfStandingOrders: a MANAGER sets/reads/clears, the length cap REFUSES a second
//      manual, an empty --set is refused with a pointer to --clear, and a WORKER calling the verb at
//      all (read OR write) is REFUSED by requireManager — the same wall as every crew verb;
//   3. INJECTION — the REAL dispatch paths carry the block: swapBrief appends it to a manager-run
//      swap (a re-dispatch of the same crew) and a HUMAN swap appends NOTHING even when the target
//      has a manager; the append helper itself is byte-exact (verbatim, at the END, after the
//      manager block);
//   4. THE ROUTES — the self verb and the console routes are wired: the console WRITE routes refuse
//      an identified WORKER token (the same partial wall as the conditions routes), refuse a worker
//      TARGET, and read/set/clear a manager xell;
//   5. THE CLI — scripts/zee carries the verb (the drift test asserts the manual half).
//
// It uses the REAL meta-DB (DATABASE_URL, like every integration test here): it mints a throwaway
// project + a manager + a worker, drives the real functions, and deletes what it created in a finally.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

const { q, one, pool } = await import('../server/src/db/pool.js');
const { standingOrdersBlock, standingOrdersForXell, appendStandingOrders, STANDING_ORDERS_MAX } =
  await import('../server/src/lib/standing-orders.js');
const { selfStandingOrders, swapBrief, managerDispatchBrief } = await import('../server/src/queenzee/self.js');

const tag = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, '');
const root = mkdtempSync(join(tmpdir(), `standing-${tag}-`));
const slug = `standing-${tag}`;
let pid = null, mgrId = null, wkrId = null, tgtId = null;
let srv = null;

try {
  // ── a real project + xells in the meta-DB (a manager, a worker, a crew target) ──
  pid = (await one(
    `INSERT INTO project (name, repo_root) VALUES ($1,$2) RETURNING id`,
    [slug, root])).id;
  const xoid = (await one(`INSERT INTO xource (project_id, ref) VALUES ($1,'master') RETURNING id`, [pid])).id;
  mgrId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling)
       VALUES ($1,$2,$3,$4,$5,'working',false,'manager','db-isolated') RETURNING id`,
    [pid, xoid, `${slug}-mgr`, `spinoff/${slug}-mgr`, `${root}/mgr`])).id;
  wkrId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling)
       VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated') RETURNING id`,
    [pid, xoid, `${slug}-wkr`, `spinoff/${slug}-wkr`, `${root}/wkr`])).id;
  tgtId = (await one(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled,
                       zee_type, db_coupling, manager_xell_id)
       VALUES ($1,$2,$3,$4,$5,'working',false,'worker','db-isolated',$6) RETURNING id`,
    [pid, xoid, `${slug}-tgt`, `spinoff/${slug}-tgt`, `${root}/tgt`, mgrId])).id;
  const mgrXell = await one(`SELECT * FROM xell WHERE id=$1`, [mgrId]);
  const wkrXell = await one(`SELECT * FROM xell WHERE id=$1`, [wkrId]);

  // ── the pure render: an identifiable block, and NULL for empty/unset ─────────
  console.log('\n── the block is clearly marked, appended, and NULL when empty ──');
  const block = standingOrdersBlock('read CLAUDE.md first\nnever hand-edit .zeehive.env\nland early');
  ok(block.startsWith('## STANDING ORDERS (from your manager — appended to every brief)'),
     'the block has its OWN heading — a worker can tell it from the per-card task');
  ok(block.includes('read CLAUDE.md first') && block.includes('land early'),
     'and every line of the text is carried through verbatim');
  ok(standingOrdersBlock('') === null, 'empty string → null (no empty section)');
  ok(standingOrdersBlock(null) === null, 'null → null');
  ok(standingOrdersBlock(undefined) === null, 'undefined → null');
  ok(typeof STANDING_ORDERS_MAX === 'number' && STANDING_ORDERS_MAX > 0 && STANDING_ORDERS_MAX <= 4000,
     'the length cap is a real bound (SHORT by design — a limit, not a second manual)');

  // ── empty/unset behaves EXACTLY like today ─────────────────────────────────
  console.log('\n── a manager with no standing orders is byte-identical to before ──');
  const noOrders = await standingOrdersForXell(mgrId);
  ok(noOrders === null, 'standingOrdersForXell → null when never set');
  const plain = '# do the thing\n\nyour own words.';
  const appended = await appendStandingOrders(plain, mgrId);
  ok(appended === plain, 'appendStandingOrders with nothing set returns the brief UNCHANGED (byte-identical)');
  const humanAppend = await appendStandingOrders(plain, null);
  ok(humanAppend === plain, 'a dispatch with no manager caller (human/console) appends nothing');

  // ── the verb: a MANAGER sets/reads/clears, and the length cap refuses a manual ──
  console.log('\n── `zee standing-orders`: a manager sets it once, every dispatch carries it ──');
  const text = 'read CLAUDE.md first\nget a db with `zee db-sandbox`\nland early — a human approves';
  const set = await selfStandingOrders(mgrXell, { action: 'set', text });
  ok(set.ok === true && set.length === text.length, 'a manager --set stores the block');
  const read = await selfStandingOrders(mgrXell, { action: 'read' });
  ok(read.ok === true && read.standing_orders === text, 'and --read returns it verbatim');
  ok(read.updated_by === mgrXell.slug, 'and stamps who set it (the manager slug)');

  const tooLong = 'x'.repeat(STANDING_ORDERS_MAX + 1);
  const over = await selfStandingOrders(mgrXell, { action: 'set', text: tooLong });
  ok(over.ok === false && /limited to/.test(over.error || ''),
     `a block over ${STANDING_ORDERS_MAX} chars is REFUSED (a second manual, not a short block)`);
  const empty = await selfStandingOrders(mgrXell, { action: 'set', text: '   ' });
  ok(empty.ok === false && /--clear/.test(empty.error || ''),
     'an empty --set is refused and points at --clear (removal is its own verb)');
  const after = await selfStandingOrders(mgrXell, { action: 'read' });
  ok(after.standing_orders === text, 'and the refused attempts changed nothing (still the original block)');

  // ── THE MANAGER WALL: a WORKER calling the verb at all is REFUSED ───────────
  console.log('\n── the wall: a worker never sets, reads or clears standing orders ──');
  const wSet = await selfStandingOrders(wkrXell, { action: 'set', text: 'a worker tries to set' });
  ok(wSet.ok === false && wSet.status === 'refused', 'a worker --set is REFUSED (requireManager)');
  const wRead = await selfStandingOrders(wkrXell, { action: 'read' });
  ok(wRead.ok === false && wRead.status === 'refused', 'a worker --read is REFUSED too — the verb is manager-only end to end');
  const wClear = await selfStandingOrders(wkrXell, { action: 'clear' });
  ok(wClear.ok === false && wClear.status === 'refused', 'a worker --clear is REFUSED');
  const mgrStill = await selfStandingOrders(mgrXell, { action: 'read' });
  ok(mgrStill.standing_orders === text, 'and the refused worker calls left the manager block untouched');

  // ── INJECTION: appendStandingOrders appends VERBATIM at the END ─────────────
  console.log('\n── injection: the block lands at the END of the brief, verbatim ──');
  const withOrders = await appendStandingOrders(plain, mgrId);
  ok(withOrders.startsWith(plain), 'the per-card brief stays the manager\'s own words (appended, not merged)');
  ok(withOrders.endsWith(text), 'and the brief ENDS with the standing orders, verbatim');
  ok(withOrders.includes('## STANDING ORDERS'), 'the block is identifiably separate (its own heading)');
  const headerPos = withOrders.indexOf('## STANDING ORDERS');
  ok(withOrders.slice(0, headerPos).includes('your own words'),
     'the block sits AFTER the task, never replacing or merging into it');

  // ── INJECTION through the REAL dispatch surface: swapBrief ──────────────────
  // swapBrief is the brief builder selfSwap hands dispatchXell — the same manager-run re-dispatch
  // that must brief an incoming zee with the same crew discipline a fresh dispatch carries. A HUMAN
  // swap (manager: null) has no manager caller and appends NOTHING — even when the target HAS a
  // manager, because standing orders are the DISPATCHING manager's, not the target's.
  console.log('\n── the REAL dispatch surface: a manager-run swap carries the block, a human swap does not ──');
  const built = await swapBrief({
    manager: mgrXell,
    target: await one(`SELECT * FROM xell WHERE id=$1`, [tgtId]),
    harness: { key: 'dev-builder', label: 'Builder' },
    task: 'BUILD the fix the scout scoped.',
  });
  const brief = built.brief;
  ok(brief.startsWith('BUILD the fix the scout scoped.'), 'the manager\'s own --task text leads the brief');
  ok(brief.includes('## STANDING ORDERS') && brief.endsWith(text),
     'a manager-run swap brief ENDS with the manager\'s standing orders, verbatim');

  const humanBuilt = await swapBrief({
    manager: null,
    target: await one(`SELECT * FROM xell WHERE id=$1`, [tgtId]),
    harness: { key: 'dev-builder', label: 'Builder' },
    task: 'BUILD the fix the scout scoped.',
  });
  ok(!humanBuilt.brief.includes('## STANDING ORDERS'),
     'a HUMAN swap (manager: null) appends NO standing orders — even though the target has a manager with them');

  // ── INJECTION through the MANAGER DISPATCH path itself: selfDispatch ────────
  // managerDispatchBrief is the brief selfDispatch hands dispatchXell — the exact task text a
  // dispatched worker is spawned with. The manager's standing orders must be IN it, verbatim, at the
  // END. (swapBrief above proves the swap's re-dispatch; THIS proves the fresh dispatch.)
  console.log('\n── the MANAGER DISPATCH path: the brief selfDispatch hands the spawn carries the block ──');
  const dispatchBrief = await managerDispatchBrief(mgrXell, 'BUILD the fix the scout scoped.', { router: false });
  ok(dispatchBrief.startsWith('BUILD the fix the scout scoped.'), 'the per-card --task text leads the dispatch brief');
  ok(dispatchBrief.includes('## Your manager') && dispatchBrief.includes(mgrXell.slug),
     'and the standard manager block rides along (the worker knows who is watching)');
  ok(dispatchBrief.includes('## STANDING ORDERS') && dispatchBrief.endsWith(text),
     'the dispatch brief ENDS with the manager\'s standing orders, verbatim — this is what a dispatched worker is spawned with');

  const routerBrief = await managerDispatchBrief(mgrXell, 'route this onto a card', { router: true });
  ok(routerBrief.startsWith('route this onto a card'), 'a ROUTER dispatch brief is the bare text (no manager block — 151)');
  ok(routerBrief.includes('## STANDING ORDERS') && routerBrief.endsWith(text),
     'but the router\'s dispatch still carries the standing orders it set (it IS manager-type and this is the same path)');

  const cleared = await selfStandingOrders(mgrXell, { action: 'clear' });
  ok(cleared.ok === true && cleared.standing_orders === null, '--clear empties the block');
  const afterClear = await swapBrief({
    manager: mgrXell,
    target: await one(`SELECT * FROM xell WHERE id=$1`, [tgtId]),
    harness: { key: 'dev-builder', label: 'Builder' },
    task: 'BUILD the fix the scout scoped.',
  });
  ok(!afterClear.brief.includes('## STANDING ORDERS'),
     'after --clear the same manager swap brief has no standing-orders section at all (empty is today)');

  // ── the ROUTES (self + console) ─────────────────────────────────────────────
  console.log('\n── the routes carry the verb, and the console write routes refuse an identified worker ──');
  const { router } = await import('../server/src/api/routes.js');
  const { mintXellToken } = await import('../server/src/lib/xell-token.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  srv = createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${srv.address().port}/api`;
  const mgrToken = await mintXellToken(mgrId);
  const wkrToken = await mintXellToken(wkrId);

  const jget = (path, token) => fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const jpost = (path, body, token) => fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });

  // the self verb over HTTP
  const selfSet = await jpost('/xell/self/standing-orders', { action: 'set', text }, mgrToken);
  const selfSetBody = await selfSet.json().catch(() => ({}));
  ok(selfSet.status === 200 && selfSetBody.ok === true && selfSetBody.length === text.length,
     'POST /xell/self/standing-orders with a MANAGER token sets the block');
  const selfGet = await jget('/xell/self/standing-orders', mgrToken);
  const selfGetBody = await selfGet.json().catch(() => ({}));
  ok(selfGet.status === 200 && selfGetBody.standing_orders === text,
     'GET /xell/self/standing-orders with a MANAGER token reads it back');
  const wkrSelf = await jpost('/xell/self/standing-orders', { action: 'set', text: 'worker tries' }, wkrToken);
  const wkrSelfBody = await wkrSelf.json().catch(() => ({}));
  ok(wkrSelf.status === 403 && wkrSelfBody.status === 'refused',
     'POST /xell/self/standing-orders with a WORKER token → 403 refused (server-side, from the token-resolved xell)');

  // the console read/set/clear routes on a MANAGER xell
  const consGet = await jget(`/xells/${mgrId}/standing-orders`);
  const consGetBody = await consGet.json().catch(() => ({}));
  ok(consGet.status === 200 && consGetBody.standing_orders === text && consGetBody.zee_type === 'manager',
     'GET /xells/:id/standing-orders (console) reads the manager block');
  const consPut = await fetch(`${BASE}/xells/${mgrId}/standing-orders`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'read CLAUDE.md first', actor: 'human@console' }),
  });
  const consPutBody = await consPut.json().catch(() => ({}));
  ok(consPut.status === 200 && consPutBody.ok === true && consPutBody.length === 'read CLAUDE.md first'.length,
     'PUT /xells/:id/standing-orders (console, no token) sets a manager xell\'s block');
  const consDel = await fetch(`${BASE}/xells/${mgrId}/standing-orders`, { method: 'DELETE' });
  const consDelBody = await consDel.json().catch(() => ({}));
  ok(consDel.status === 200 && consDelBody.ok === true && consDelBody.standing_orders === null,
     'DELETE /xells/:id/standing-orders (console) clears it');

  // the console write routes REFUSE an identified worker token (same partial wall as conditions)
  const wkrPut = await fetch(`${BASE}/xells/${mgrId}/standing-orders`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${wkrToken}` },
    body: JSON.stringify({ text: 'a worker edits' }),
  });
  const wkrPutBody = await wkrPut.json().catch(() => ({}));
  ok(wkrPut.status === 403 && wkrPutBody.status === 'refused',
     'PUT /xells/:id/standing-orders with a resolvable WORKER token → 403 refused');

  // the console write routes REFUSE a WORKER TARGET (a worker has no standing orders to author)
  const wkrTgt = await fetch(`${BASE}/xells/${wkrId}/standing-orders`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'a worker target' }),
  });
  const wkrTgtBody = await wkrTgt.json().catch(() => ({}));
  ok(wkrTgt.status === 400 && /worker/.test(wkrTgtBody.error || ''),
     'PUT /xells/:id/standing-orders on a WORKER xell → 400 (only a manager dispatches, so only a manager has them)');

  // ── the CLI carries the verb (the manual half is the drift test's job) ──────
  console.log('\n── the CLI carries the verb ──');
  const { readFileSync } = await import('node:fs');
  const zeeSrc = readFileSync(new URL('../scripts/zee', import.meta.url), 'utf8');
  ok(/case 'standing-orders':/.test(zeeSrc), 'scripts/zee has case \'standing-orders\'');
  ok(/standing-orders \[--set/.test(zeeSrc), 'and its usage text names the verb');
} finally {
  if (srv) srv.close();
  // clean up everything this test created, in a finally, whatever happened
  try { await q(`DELETE FROM xell WHERE id IN ($1,$2,$3)`, [mgrId, wkrId, tgtId]); } catch { }
  try { await q(`DELETE FROM xource WHERE project_id=$1`, [pid]); } catch { }
  try { await q(`DELETE FROM project WHERE id=$1`, [pid]); } catch { }
  try { rmSync(root, { recursive: true, force: true }); } catch { }
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
