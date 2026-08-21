// SHIP-WITHDRAW integration test — a zee can UN-ASK a ship request before the deploy starts.
//
// The gap this covers (from the post-ship reflection of design-split-api-gateway…): a zee raised a
// ship, immediately learned the deploy was bigger than described (it would carry other xells'
// migrations), and could not un-ask it — `zee land --withdraw` exists, `zee ship` had no
// counterpart. Every other ask a zee raises can be lowered by the zee that raised it; a ship
// request could only be decided by a human (Approve/Reject/Defer).
//
// Runs the REAL paths against a throwaway postgres + a real git repo (the only seam is a direct
// call into shipgate/self, exactly like land-withdraw.test.mjs):
//   • requestShip → pending → selfWithdrawShip → row 'withdrawn', out of every OPEN read model,
//     nothing deployed, nothing decided, and the withdrawal is in the ship ledger
//   • an APPROVED-but-not-started ship is still withdrawable (approval only queues the deploy;
//     an auto-approve project flips a fresh ask to approved in milliseconds) — the human's approval
//     stays on the row, the withdrawal is added beside it
//   • a SHIPPING ship (the deploy has started) is REFUSED, with a message that says why
//   • a ship whose prod lock is taken (the race window before status flips) is REFUSED
//   • terminal ships (shipped), foreign requests and "nothing to withdraw" are all handled
// Plus the static half: the verb reaches a zee (CLI, route, briefing, manual migration).
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required — run this against a throwaway db (zee db-sandbox --migrate)'); process.exit(2); }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'ship-withdraw-'));
const PID = '00000000-0000-4000-8000-00000000e111';   // fixed ids so cleanup is total even on crash
const XOURCE = '00000000-0000-4000-8000-00000000e222';
const XELL = '00000000-0000-4000-8000-00000000e333';

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

await client.connect();
try {
  await client.query(`DELETE FROM project WHERE id=$1`, [PID]).catch(() => {});
  const { requestShip, withdrawShipRequest, listShipRequests, shipStatus } =
    await import('../server/src/queenzee/shipgate.js');
  const { selfWithdrawShip, selfStatus } = await import('../server/src/queenzee/self.js');
  const { buildLandingPad } = await import('../server/src/queenzee/landingpad.js');

  // a real xource with a real main, and a real xell worktree on its own branch — LANDED
  const repo = join(tmp, 'xource'); mkdirSync(repo);
  git(tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@zeehive');
  git(repo, 'config', 'user.name', 'ship-withdraw-test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const wt = join(tmp, 'xell');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/ship-withdraw-test', wt);
  writeFileSync(join(wt, 'b.txt'), 'work\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'landed work');
  git(repo, 'merge', '-q', '--ff-only', 'spinoff/ship-withdraw-test');   // land it so requestShip passes

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'ship-withdraw-test',$2,'main')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'main')`, [XOURCE, PID]);
  await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status)
       VALUES ($1,$2,$3,'ship-withdraw-cove','spinoff/ship-withdraw-test',$4,'working')`, [XELL, PID, XOURCE, wt]);
  const xell = (await client.query(`SELECT * FROM xell WHERE id=$1`, [XELL])).rows[0];

  // ── 1. ask once → pending ───────────────────────────────────────────────────
  console.log('\n── one ship request, pending in front of a human ──');
  const r1 = await requestShip({ xellId: XELL, reason: 'ship the landed work' });
  ok(r1.ok === true && !!r1.request?.id, 'a ship_request is raised');
  const row1 = await client.query(`SELECT * FROM ship_request WHERE id=$1`, [r1.request.id]);
  ok(row1.rows[0]?.status === 'pending', `the row is pending (${row1.rows[0]?.status})`);
  ok((await listShipRequests(PID, { open: true })).length === 1, 'one OPEN ship sits in front of a human');

  // ── 2. WITHDRAW — un-ask, and only that ─────────────────────────────────────
  console.log('\n── zee ship --withdraw ──');
  const w = await selfWithdrawShip(xell, { reason: 'the deploy would carry other xells\' migrations' });
  ok(w.ok && w.status === 'withdrawn', `withdraw succeeded (${w.status})`);
  ok(w.withdrawn.length === 1, 'the one open request was lowered');
  const wr = await client.query(`SELECT * FROM ship_request WHERE id=$1`, [r1.request.id]);
  ok(wr.rows[0].status === 'withdrawn', 'the row is status=withdrawn');
  ok(wr.rows[0].withdrawn_at && /^zee@/.test(wr.rows[0].withdrawn_by || ''),
     'it carries WHO withdrew it and when (a zee, never a decider)');
  ok(!wr.rows[0].decided_at && !wr.rows[0].decided_by,
     'and NOTHING was decided — a withdrawal is not an approval or a rejection');
  ok(/other xells' migrations/.test(wr.rows[0].withdraw_reason || ''), "the zee's reason is kept on the row");
  ok((await listShipRequests(PID, { open: true })).length === 0,
     'the console\'s OPEN list is empty — the card left the human\'s screen');
  const pad = await buildLandingPad(PID);
  ok(pad.items.filter((i) => i.kind === 'shipment').every((i) => i.phase === 'withdrawn'),
     'the landing pad keeps a brief RECEIPT rather than vanishing mid-read (phase=withdrawn)');
  const st2 = await selfStatus(xell);
  ok(st2.ship?.status === 'withdrawn' && st2.ship?.withdrawn === true && st2.ship?.pending === false,
     '`zee status` reports the ship as withdrawn (and not pending)');

  // ── 3. withdrawing nothing / a foreign request ──────────────────────────────
  console.log('\n── the refusals ──');
  const again = await selfWithdrawShip(xell, {});
  ok(again.status === 'nothing-to-withdraw', `a second withdraw is a no-op, not an error (${again.status})`);
  let threw = null;
  await withdrawShipRequest(r1.request.id, 'zee@ship-withdraw-cove').catch((e) => { threw = e.message; });
  ok(/nothing open to withdraw/.test(threw || ''), `an already-withdrawn row cannot be withdrawn again (${threw})`);
  const foreign = await selfWithdrawShip(xell, { request: '00000000-0000-0000-0000-000000000000' });
  ok(foreign.ok === false && foreign.status === 'not-found', 'a request that is not this xell\'s is refused');

  // ── 4. an APPROVED ship is still withdrawable BEFORE it starts ──────────────
  // Approval only QUEUES the deploy (the landing pad FIFO / the prod lock can hold it for a long
  // while), and an auto-approve project flips a fresh ask to approved within milliseconds — the
  // very shape of "immediately learned it was wrong". The human's approval stays on the row.
  console.log('\n── an APPROVED-but-not-started ship is still withdrawable ──');
  const r4 = await requestShip({ xellId: XELL, reason: 'ship it again' });
  const approved = await client.query(
    `UPDATE ship_request SET status='approved', decided_at=now(), decided_by='human@test'
       WHERE id=$1 RETURNING *`, [r4.request.id]);
  ok(approved.rows[0].status === 'approved', 'a human approves it — now status=approved');
  const w4 = await selfWithdrawShip(xell, { reason: 'learned the deploy was bigger than described' });
  ok(w4.ok && w4.status === 'withdrawn', `an approved-but-not-started ship IS withdrawable (${w4.status})`);
  const wr4 = await client.query(`SELECT * FROM ship_request WHERE id=$1`, [r4.request.id]);
  ok(wr4.rows[0].status === 'withdrawn', 'the approved row is now withdrawn');
  ok(wr4.rows[0].decided_by === 'human@test' && wr4.rows[0].withdrawn_by === 'zee@ship-withdraw-cove',
     'and it carries BOTH the human\'s approval and the zee\'s withdrawal — the honest audit of "approved, then un-asked"');

  // ── 5. the in-flight ship is REFUSED — the deploy has STARTED ───────────────
  console.log('\n── a SHIPPING ship (deploy running) refuses withdraw ──');
  const r5 = await requestShip({ xellId: XELL, reason: 'ship it a third time' });
  await client.query(
    `UPDATE ship_request SET status='shipping', started_at=now() WHERE id=$1`, [r5.request.id]);
  const w5 = await selfWithdrawShip(xell, {});
  ok(w5.ok === false && w5.status === 'started', `withdraw is refused once the deploy has started (${w5.status})`);
  ok(/STARTED|started/.test(w5.error || w5.message || ''), 'the message says WHY — the deploy is running');
  ok(/zee tend/.test(w5.error || w5.message || ''), 'and what to do instead (raise a tend so a human sees prod is mid-deploy)');
  let threw5 = null;
  await withdrawShipRequest(r5.request.id, 'zee@ship-withdraw-cove').catch((e) => { threw5 = e.message; });
  ok(/STARTED|started/.test(threw5 || ''), 'the direct gate also refuses (no race window)');
  const stillShipping = await client.query(`SELECT status FROM ship_request WHERE id=$1`, [r5.request.id]);
  ok(stillShipping.rows[0].status === 'shipping', 'the shipping row is untouched');

  // ── 5b. the lock-taken race window is refused too ───────────────────────────
  const r5b = await requestShip({ xellId: XELL, reason: 'ship it a fourth time' });
  await client.query(
    `INSERT INTO deploy_lock (project_id, container, xell_id, phase, task, ship_id)
       VALUES ($1,'prod',$2,'shipping','ship withdraw race test',$3)`,
    [PID, XELL, r5b.request.id]);
  let threw5b = null;
  await withdrawShipRequest(r5b.request.id, 'zee@ship-withdraw-cove').catch((e) => { threw5b = e.message; });
  ok(/STARTED|started/.test(threw5b || ''), `a ship whose prod lock is taken is refused too (${threw5b})`);
  await client.query(`DELETE FROM deploy_lock WHERE ship_id=$1`, [r5b.request.id]);
  await client.query(`DELETE FROM ship_request WHERE id=$1`, [r5b.request.id]);

  // ── 6. a terminal ship (shipped) is history — refused ───────────────────────
  console.log('\n── a SHIPPED ship is history ──');
  const r6 = await requestShip({ xellId: XELL, reason: 'ship it a fifth time' });
  await client.query(
    `UPDATE ship_request SET status='shipped', decided_at=now(), decided_by='human@test', finished_at=now()
       WHERE id=$1`, [r6.request.id]);
  const w6 = await selfWithdrawShip(xell, {});
  ok(w6.status === 'nothing-to-withdraw' && /'shipped'/.test(w6.message || ''),
     `a shipped ship is nothing to withdraw (${w6.status})`);
  await client.query(`DELETE FROM ship_request WHERE id=$1`, [r6.request.id]);

  // ── 7. the STATIC half: does the verb reach a zee at all? ───────────────────
  console.log('\n── the verb reaches a zee (CLI · route · briefing · manual) ──');
  const cli = read('scripts/zee');
  ok(/--withdraw/.test(cli) && /\/api\/xell\/self\/ship\/withdraw/.test(cli),
     'scripts/zee implements `zee ship --withdraw` against the self route');
  ok(/rest\.includes\('--clear'\)/.test(cli.slice(cli.indexOf("case 'ship':"), cli.indexOf('case \'hint-land\':'))),
     'and accepts --clear as the same verb (symmetry with land/tend/hint/done)');
  const usage = cli.slice(cli.indexOf('function usage()'), cli.indexOf('switch (cmd)'));
  ok(/zee ship --withdraw/.test(usage), 'it is advertised in `zee help`');
  ok(/REFUSED once the deploy has started/i.test(usage), 'and the usage text carries the in-flight refusal, not just the flag');
  const routes = read('server/src/api/routes.js');
  ok(/'\/xell\/self\/ship\/withdraw'/.test(routes), 'the zee route exists');
  ok(/zee ship --withdraw/.test(read('server/src/queenzee/intake.js')),
     'the spawn briefing lists the verb (a zee reads that before anything else)');
  const manual = read('db/migrations/223_manual_ship_withdraw.sql');
  ok(/zee ship --withdraw/.test(manual) && /deploy has\s*STARTED/.test(manual),
     'the manual migration teaches both the verb AND the in-flight boundary');
  ok(/harness_memory_get/.test(manual) && /harness_memory_put/.test(manual) && /zee-base/.test(manual),
     'and it patches the DB-owned zee-base manual through the 076 helper, never a hand-rolled jsonb');
  // the manual as it actually stands in THIS database (the migration ran here)
  const stored = await client.query(
    `SELECT a.e->>'text' AS t FROM harness h, LATERAL jsonb_array_elements(h.bundle->'memory') AS a(e)
       WHERE h.key='zee-base' AND a.e->>'path'='cxell-zee-manual.md'`);
  ok(/zee ship --withdraw/.test(stored.rows[0]?.t || ''), 'and the stored manual really carries it after migrating');
  ok(/REFUSED once the deploy has\s*STARTED/i.test(stored.rows[0]?.t || ''),
     'including the boundary a zee is meant to know — the deploy-started refusal');
} finally {
  await cleanup();
  await client.end();
  const { pool } = await import('../server/src/db/pool.js');
  await pool.end().catch(() => {});
}

console.log(`\n${fail === 0 ? 'ALL PASSED ✓' : `${fail} FAILURE(S) ✗`}`);
process.exit(fail === 0 ? 0 : 1);
