// DONE PRECEDENCE + RETRACTION — a truthful signal that never reached a human, and the missing verb.
//
// THE DEFECT (cost this crew ~7 hours): hive-status.js returned occ-doneRequest for status
// 'awaiting-done' BEFORE it considered shipPending / landPending / tend. So a zee that proposed done
// and was then handed more work had every later signal MASKED behind a stale done card — including a
// manager's tend that said "approve the urgent ship" and the ship button itself. A second zee
// independently deduced the trap and deliberately refused to propose done while its ship was
// pending, to avoid masking its own button. A rule a zee must remember and route around is a design
// flaw, not a discipline problem.
//
// THE FIX, in two halves:
//   PRECEDENCE — 'tearing-down' is a FACT (a human confirmed; the queenzee is reaping; nothing the
//     zee wants can change it) and keeps outranking everything. 'awaiting-done' is a REQUEST — the
//     zee ASKING to be finished — which makes it a sibling of land?/ship?/tend?, and the WEAKEST of
//     them: nothing is blocked while it waits, and it is the one ask whose wrong answer is
//     destructive. It now ranks just above plain activity.
//   RETRACTION — `zee done --clear` / retractDone(): the symmetric partner proposeDone never had.
//     It can only undo a PROPOSAL; once a human has confirmed, the decision is theirs.
//
// Part A is pure (no DB): hiveStatus is dependency-free. Part B exercises the real retractDone
// against an isolated throwaway project. Everything it creates is torn down in a finally.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hiveStatus, hiveLabel } from '../server/src/lib/hive-status.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// A xell that proposed done AND is still working — the exact state the manager zee was in.
const awaitingDone = { id: 'x', status: 'awaiting-done', zee_status: 'working' };

console.log('\n── A. a done PROPOSAL must not mask a signal a human has to act on ──');
// Each of these FAILS against the old precedence, which returned occ-doneRequest for all of them.
ok(hiveStatus(awaitingDone, { shipPending: true }) === 'occ-shipRequest',
   'a pending SHIP outranks the proposal — the button a human needs is the one shown');
ok(hiveStatus(awaitingDone, { landPending: true }) === 'occ-landRequest',
   'a held LANDING outranks it');
ok(hiveStatus(awaitingDone, { tendPending: true }) === 'occ-tendRequest',
   'an open TEND outranks it — this is the signal that was invisible for ~7 hours');
ok(hiveStatus(awaitingDone, { seedPending: true }) === 'occ-seedRequest', 'a seed ask outranks it');
ok(hiveStatus(awaitingDone, { prodBindPending: true }) === 'occ-prodRequest', 'a prod-bind ask outranks it');
ok(hiveStatus(awaitingDone, { doneSuggested: true }) === 'occ-doneSuggest',
   'a manager\'s done-suggestion outranks it (it is about the same decision, raised by someone else)');
// Hints too: the manual's own warning is that proposing done "masks your own land? button and
// invites a human to tear you down with work still only on your branch". With this order it cannot.
ok(hiveStatus(awaitingDone, { landHint: true }) === 'occ-landHint',
   'a land HINT outranks it — unlanded work is what a human needs to see BEFORE confirming done');
ok(hiveStatus(awaitingDone, { shipHint: true }) === 'occ-shipHint', 'a ship hint outranks it');

console.log('\n── …but the proposal is still shown when nothing else is waiting ──');
ok(hiveStatus(awaitingDone, {}) === 'occ-doneRequest', 'with no other signal, the hexagon reads done?');
ok(hiveLabel(hiveStatus(awaitingDone, {})) === 'done?', 'and its label is unchanged');
ok(hiveStatus({ id: 'x', status: 'awaiting-done', zee_status: 'idle' }, {}) === 'occ-doneRequest',
   'an idle zee that proposed done still reads done? (it outranks plain activity)');

console.log('\n── tearing-down still outranks EVERYTHING (it is a fact, not a request) ──');
const tearing = { id: 'x', status: 'tearing-down', zee_status: 'working' };
for (const [sig, name] of [[{ shipPending: true }, 'a pending ship'], [{ landPending: true }, 'a held landing'],
                           [{ tendPending: true }, 'an open tend'], [{ landHint: true }, 'a land hint'],
                           [{ doneSuggested: true }, 'a done-suggestion']]) {
  ok(hiveStatus(tearing, sig) === 'occ-done', `${name} does NOT displace tearing-down`);
}
ok(hiveStatus({ id: 'x', status: 'error' }, { tendPending: true }) === 'vac-dirty',
   'and an errored/husk xell still reads dirty (queenzee housekeeping, not a human decision)');
// production is unaffected by any of this
ok(hiveStatus({ id: 'p', is_production: true, status: 'awaiting-done' }, { tendPending: true }) === 'live-protected',
   'production is still production, whatever its row says');

console.log('\n── the ordering is a total order (no signal combination is ambiguous) ──');
const all = { shipPending: true, landPending: true, seedPending: true, prodBindPending: true,
              tendPending: true, doneSuggested: true, shipHint: true, landHint: true };
ok(hiveStatus(awaitingDone, all) === 'occ-shipRequest', 'everything at once → the most urgent gate wins');

// ── B. RETRACTION, against the real queenzee ─────────────────────────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const client = new pg.Client({ connectionString: url });
const PID = '00000000-0000-4000-8000-00000000e111';
const ids = { xource: '00000000-0000-4000-8000-00000000e222' };
async function cleanup() { try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ } }

try {
  await client.connect();
  await cleanup();
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch) VALUES ($1,'donepr-test','/tmp/donepr','master')`, [PID]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [ids.xource, PID]);
  const mk = async (slug, status) => (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING id`,
    [PID, ids.xource, slug, `spinoff/${slug}`, `/tmp/donepr-${slug}`, status])).rows[0].id;
  const statusOf = async (id) => (await client.query(`SELECT status FROM xell WHERE id=$1`, [id])).rows[0].status;

  const { proposeDone, retractDone } = await import('../server/src/queenzee/tasks.js');

  console.log('\n── B. `zee done --clear` withdraws a proposal ──');
  const a = await mk('donepr-a', 'claimed');
  await proposeDone({ xell_id: a });
  ok(await statusOf(a) === 'awaiting-done', 'propose → awaiting-done');
  ok(hiveStatus({ status: 'awaiting-done', zee_status: 'working' }, { tendPending: true }) !== 'occ-doneRequest',
     '(and with the new precedence a tend raised now would already be visible)');
  const r = await retractDone({ xell_id: a });
  ok(r.ok === true && r.retracted === true, `retract succeeds (${r.message || r.error})`);
  ok(await statusOf(a) === 'claimed', 'the xell is back in the working lifecycle (claimed)');
  ok(hiveStatus({ status: await statusOf(a), zee_status: 'working' }, {}) === 'occ-working',
     'and its hexagon reads working again, not done?');

  console.log('\n── the signal that was masked is restored ──');
  const masked = hiveStatus({ status: 'awaiting-done', zee_status: 'working' }, { tendPending: true });
  const after = hiveStatus({ status: await statusOf(a), zee_status: 'working' }, { tendPending: true });
  ok(after === 'occ-tendRequest', `after retraction a tend shows as tend? (${after})`);
  ok(masked === 'occ-tendRequest',
     'and — the whole point — it was already visible even BEFORE retracting, thanks to the precedence fix');

  console.log('\n── retraction is idempotent-ish and never invents a proposal ──');
  const again = await retractDone({ xell_id: a });
  ok(again.ok === false && /not awaiting done/.test(again.error || ''),
     `retracting twice says precisely why, rather than a bare failure ("${again.error}")`);

  console.log('\n── a proposal a HUMAN already confirmed is NOT a zee\'s to undo ──');
  const b = await mk('donepr-b', 'claimed');
  await proposeDone({ xell_id: b });
  await client.query(`UPDATE xell SET status='tearing-down' WHERE id=$1`, [b]);   // a human confirmed
  const refused = await retractDone({ xell_id: b });
  ok(refused.ok === false && refused.retracted === false, 'retraction is REFUSED once teardown is under way');
  ok(/already CONFIRMED/.test(refused.error || ''), `and says so ("${refused.error}")`);
  ok(await statusOf(b) === 'tearing-down', 'the reap path is untouched — the queenzee still owns it');

  console.log('\n── proposeDone itself is unchanged (it may not resurrect a torn-down xell) ──');
  const stillTearing = await proposeDone({ xell_id: b });
  ok(stillTearing.ok === false && await statusOf(b) === 'tearing-down',
     'proposing done on a tearing-down xell does nothing, as before');

  console.log('\n── the CLI and the API expose it ──');
  const cli = readFileSync(new URL('../scripts/zee', import.meta.url), 'utf8');
  ok(/--clear/.test(cli.slice(cli.indexOf("case 'done'"), cli.indexOf("case 'done'") + 700)),
     '`zee done --clear` is implemented in the CLI');
  ok(/zee done --summary[^\n]*--clear/.test(cli), 'and advertised in the usage text');
  const routes = readFileSync(fileURLToPath(new URL('../server/src/api/routes.js', import.meta.url)), 'utf8');
  const doneRoute = routes.slice(routes.indexOf("'/xell/self/done'"), routes.indexOf("'/xell/self/done'") + 400);
  ok(/clear:\s*!!req\.body\?\.clear/.test(doneRoute), 'the self/done route passes {clear} through');

  console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
} catch (e) {
  console.error('\n✗ threw:', e.stack || e.message);
  fail++;
} finally {
  await cleanup();
  try { await client.end(); } catch { /* */ }
}
process.exit(fail ? 1 : 0);
