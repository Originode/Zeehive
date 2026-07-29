// A REFUSED SHIP, END TO END — integration test against a throwaway project in the meta DB.
//
// Reported by an operator: "some ship requests seem to be missing… xells insist they have ship
// requests… but i see zero." Nothing was missing. requestShip REFUSES a ship whose work is not
// landed and writes no ship_request row, so there was nothing to see — while the refusal came back
// to the zee as HTTP 200 `{ok:false}` (the cxell CLI printed it and exited 0) and lived, on the
// queenzee side, only in an in-memory log line. A refusal was indistinguishable from a request.
//
// Stands up an isolated project (own git repo + worktree, own xell row) and drives shipgate.js:
//   1. UNLANDED       → refused, no row written, and the refusal is RECORDED and visible in the
//                       fleet read model the console renders;
//   2. DIRTY worktree → refused, and the reason NAMES the files (the queenzee writes files into a
//                       worktree too, so "3 uncommitted file(s)" was a riddle, not an instruction);
//   3. LANDED + clean → a real ship_request, and the recorded refusal clears itself;
//   4. an OPEN ask    → cannot be dismissed into invisibility (dismiss clears a receipt; Reject
//                       and Defer decide an ask);
//   5. a legacy dismissed-but-open request → restored when the zee asks again, instead of answering
//                       "you already have an open ship request" from behind a filter no human sees.
// Everything it creates is torn down in a finally, whatever happens.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.TKB_NOTIFY = '0';              // no desk pings from a test

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'shipgate-'));
const PID = '00000000-0000-4000-8000-00000000d111';   // fixed ids so cleanup is total even on crash
const XOURCE = '00000000-0000-4000-8000-00000000d222';
const XELL = '00000000-0000-4000-8000-00000000d333';

async function cleanup() {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

await client.connect();
try {
  // DB-only sweep of a previous crashed run (the tmp dir is fresh; do not remove it here).
  await client.query(`DELETE FROM project WHERE id=$1`, [PID]).catch(() => {});
  const { requestShip, dismissShipRequest } = await import('../server/src/queenzee/shipgate.js');
  const { shipRefusalState } = await import('../server/src/lib/status.js');
  const { getFleet } = await import('../server/src/lib/fleet.js');

  // a real xource with a real main, and a real xell worktree on its own branch
  const repo = join(tmp, 'xource'); mkdirSync(repo);
  git(tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@zeehive');
  git(repo, 'config', 'user.name', 'shipgate-test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const wt = join(tmp, 'xell');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/shipgate-test', wt);

  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'shipgate-test',$2,'main')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'main')`, [XOURCE, PID]);
  await client.query(
    `INSERT INTO xell (id, project_id, xource_id, slug, branch, worktree_path, status)
       VALUES ($1,$2,$3,'shipgate-cove','spinoff/shipgate-test',$4,'working')`, [XELL, PID, XOURCE, wt]);

  // ── 1. UNLANDED ──
  console.log('\n── an unlanded ship is refused, and the refusal is visible ──');
  writeFileSync(join(wt, 'b.txt'), 'work\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'unlanded work');
  const r1 = await requestShip({ xellId: XELL, reason: 'ship my unlanded work' });
  ok(r1.ok === false && r1.refused === true, 'the answer is ok:false + refused:true — not a request');
  ok(/not landed on main/.test(r1.reason || ''), 'the reason names the problem');
  ok(/NO request was raised/.test(r1.message || ''), 'and the message says NOTHING is awaiting a human');
  const rows = await client.query(`SELECT 1 FROM ship_request WHERE xell_id=$1`, [XELL]);
  ok(rows.rowCount === 0, 'no ship_request row exists (this is why the console showed zero)');
  const st1 = await shipRefusalState(XELL);
  ok(st1.refused && /not landed/.test(st1.reason || ''), 'the refusal is RECORDED on the xell');
  const f1 = await getFleet(PID);
  ok(f1.ship_refused.length === 1 && f1.ship_refused[0].xell_slug === 'shipgate-cove',
     'and the console read model carries it — "did anyone ask?" is now answerable');
  ok(f1.shipping.length === 0, 'while the approvable-ship list stays empty: evidence, not a decision');

  // ── 2. DIRTY ──
  console.log('\n── a dirty worktree refusal names the files ──');
  git(repo, 'merge', '-q', '--ff-only', 'spinoff/shipgate-test');       // land it
  writeFileSync(join(wt, 'c.txt'), 'uncommitted\n');
  const r2 = await requestShip({ xellId: XELL, reason: 'ship it' });
  ok(r2.ok === false && /c\.txt/.test(r2.reason || ''), 'the refusal says WHICH file is dirty');

  // ── 3. LANDED + CLEAN ──
  console.log('\n── landed and clean: a real request, and the refusal clears ──');
  rmSync(join(wt, 'c.txt'));
  const r3 = await requestShip({ xellId: XELL, reason: 'ship the landed work' });
  ok(r3.ok === true && !!r3.request?.id, 'a ship_request is raised');
  ok((await shipRefusalState(XELL)).refused === false, 'the recorded refusal is cleared by it');
  const f3 = await getFleet(PID);
  ok(f3.ship_refused.length === 0 && f3.shipping.length === 1,
     'the console swaps the refusal note for a real, approvable card');

  // ── 4. an OPEN ask cannot be hidden ──
  console.log('\n── an open ask cannot be dismissed into invisibility ──');
  let threw = null;
  try { await dismissShipRequest(r3.request.id, 'human@test'); } catch (e) { threw = e.message; }
  ok(/still pending/.test(threw || ''), 'dismissing a pending ship is refused, and says what to do instead');

  // ── 5. a legacy dismissed-open request ──
  console.log('\n── a dismissed-but-open request comes back when the zee asks again ──');
  await client.query(`UPDATE ship_request SET dismissed_at=now(), dismissed_by='legacy' WHERE id=$1`,
    [r3.request.id]);
  ok((await getFleet(PID)).shipping.length === 0, 'first: it really is invisible to a human (the ghost state)');
  const r5 = await requestShip({ xellId: XELL, reason: 'asking again' });
  ok(r5.ok === true && r5.restored === true, 'asking again RESTORES it rather than answering into the void');
  ok(/dismissed from the console/.test(r5.note || ''), 'and tells the zee that is what happened');
  ok((await getFleet(PID)).shipping.length === 1, 'the human can see what the zee is waiting on again');
} finally {
  await cleanup();
  await client.end();
  const { pool } = await import('../server/src/db/pool.js');
  await pool.end().catch(() => {});
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall good\n');
process.exit(fail ? 1 : 0);
