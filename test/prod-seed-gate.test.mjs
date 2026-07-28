// PROD SEED GATE — integration test for "seed production, via a request".
//
// Stands up an ISOLATED throwaway project in the real meta DB (its own git repo + worktree, its own
// prod site + prod db container row) and exercises queenzee/seedgate.js end to end with
// SEED_MODE=simulate, so nothing real is written:
//   1. a file that is NOT on main is REFUSED (the anti-band-aid rule, for data);
//   2. a path OUTSIDE server/sql/seeds/ is REFUSED (the whitelist is the whole safety of "approve");
//   3. a landed seed file is HELD as a pending request, and the SQL a human is shown is read at the
//      request's own sha (what you approve is what runs);
//   4. a second request while one is open is refused (one open ask per xell);
//   5. REJECT settles it without running anything;
//   6. APPROVE runs it → status 'seeded', per-file results recorded;
//   7. the prior-run warning fires on the next request for the same file;
//   8. a deploy in flight (prod lock held) makes an approved seed FAIL loudly rather than write
//      data underneath a half-swapped container;
//   9. hive-status projects a pending request onto the operator vocabulary (occ-seedRequest).
// Everything it creates is torn down in a finally, whatever happens.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
process.env.SEED_MODE = 'simulate';        // never touch a real database
process.env.TKB_NOTIFY = '0';              // no desk pings from a test

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const client = new pg.Client({ connectionString: url });
const tmp = mkdtempSync(join(tmpdir(), 'seedgate-'));
const PID = '00000000-0000-4000-8000-00000000c111';    // fixed ids so cleanup is total even on crash
const ids = { xource: '00000000-0000-4000-8000-00000000c222',
  site: '00000000-0000-4000-8000-00000000c333' };

async function cleanup({ files = false } = {}) {
  try { await client.query(`DELETE FROM project WHERE id=$1`, [PID]); } catch { /* */ }
  if (files) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } }
}

try {
  await client.connect();
  await cleanup();

  // ── a real git repo with a LANDED seed file on master, and an unlanded one only on the branch ──
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  mkdirSync(join(repo, 'server', 'sql', 'seeds'), { recursive: true });
  writeFileSync(join(repo, 'server/sql/seeds/2026-07-28-lookups.sql'),
    "INSERT INTO lookup (k) VALUES ('a') ON CONFLICT DO NOTHING;\n");
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'landed seed');
  const head = git(repo, 'rev-parse', 'HEAD');

  const wt = join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'spinoff/seedy', wt, 'master');
  // an UNLANDED seed: committed on the branch only, so it is not readable at master's tip
  writeFileSync(join(wt, 'server/sql/seeds/9999-not-landed.sql'), 'SELECT 1;\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'unlanded seed');

  // ── the isolated project: prod site + a prod db row that LOOKS addressable (simulate never
  //    inspects docker, but prodDb() must resolve a row at all) ──
  await client.query(
    `INSERT INTO project (id, name, repo_root, main_branch, db_name, db_user)
       VALUES ($1,'seedgate-test',$2,'master','seedtest','postgres')`, [PID, repo]);
  await client.query(`INSERT INTO xource (id, project_id, ref) VALUES ($1,$2,'master')`, [ids.xource, PID]);
  await client.query(
    `INSERT INTO deploy_site (id, project_id, key, tier, is_default) VALUES ($1,$2,'local','prod',true)`,
    [ids.site, PID]);
  await client.query(
    `INSERT INTO container (project_id, role, tier, isolation, name, site_id, health, conn_ref)
       VALUES ($1,'db','prod','shared','seedtest_db_prod',$2,'up','postgresql://postgres@seedtest-db:5432/seedtest')`,
    [PID, ids.site]);
  const xellId = (await client.query(
    `INSERT INTO xell (project_id, xource_id, slug, branch, worktree_path, status, is_pooled)
       VALUES ($1,$2,'seedy','spinoff/seedy',$3,'working',false) RETURNING id`,
    [PID, ids.xource, wt])).rows[0].id;

  const { requestProdSeed, decideProdSeed, normalizeSeedPath, priorRuns } =
    await import('../server/src/queenzee/seedgate.js');
  const { hiveStatus } = await import('../server/src/lib/hive-status.js');
  const row = async (id) => (await client.query(`SELECT * FROM prod_seed_request WHERE id=$1`, [id])).rows[0];

  // ── 0. path normalization (pure) ──
  ok(normalizeSeedPath('x.sql') === 'server/sql/seeds/x.sql', 'a bare name resolves into the seed dir');
  ok(normalizeSeedPath('seeds/x.sql') === 'server/sql/seeds/x.sql', 'a partial prefix is shorthand for the seed dir');
  ok(normalizeSeedPath('server/sql/migrations/x.sql') === null, 'a path OUTSIDE the seed dir is refused');
  ok(normalizeSeedPath('../../etc/x.sql') === null, 'traversal is refused');
  ok(normalizeSeedPath('server/sql/seeds/x.txt') === null, 'a non-.sql file is refused');

  // ── 1. UNLANDED seed is refused ──
  const unlanded = await requestProdSeed({ xellId, files: ['9999-not-landed.sql'], reason: 'nope' });
  ok(unlanded.ok === false && /not on master/.test(unlanded.reason || ''),
     `an unlanded seed file is refused: "${(unlanded.reason || '').slice(0, 60)}…"`);

  // ── 2. a file outside the whitelist is refused ──
  const outside = await requestProdSeed({ xellId, files: ['server/sql/migrations/001.sql'], reason: 'nope' });
  ok(outside.ok === false && /may only run \*\.sql from/.test(outside.reason || ''),
     'a file outside server/sql/seeds/ is refused');

  // ── 3. the landed file is HELD as a pending request, at master's tip ──
  const asked = await requestProdSeed({ xellId, files: ['2026-07-28-lookups.sql'], reason: 'lookup rows the new screen reads' });
  ok(asked.ok === true && asked.request?.status === 'pending', 'a landed seed file is HELD pending a human');
  ok(asked.request?.commit === head, "the request records master's tip as the sha it will run from");
  ok(asked.request?.files?.[0] === 'server/sql/seeds/2026-07-28-lookups.sql', 'the file is stored repo-relative');
  ok(asked.request?.xell_slug === 'seedy', 'the asking xell is stamped on the row (it outlives the xell)');

  // the SQL a human is shown is read at the request's own sha
  const { seedRequestSql } = await import('../server/src/queenzee/seedgate.js');
  const shown = await seedRequestSql(asked.request.id);
  ok(/ON CONFLICT DO NOTHING/.test(shown.files?.[0]?.sql || ''), 'the console is shown the exact SQL at that sha');

  // ── 4. one open ask per xell ──
  const again = await requestProdSeed({ xellId, files: ['2026-07-28-lookups.sql'], reason: 'again' });
  ok(again.request?.id === asked.request.id && /already have an open/.test(again.note || ''),
     'a second request while one is open returns the SAME open request');

  // ── 9. hive status projects it onto the operator vocabulary ──
  ok(hiveStatus({ status: 'working', zee_status: 'working' }, { seedPending: true }) === 'occ-seedRequest',
     'a pending seed shows as occ-seedRequest on the hexagon (above plain "working")');
  ok(hiveStatus({ status: 'working' }, { prodBindPending: true }) === 'occ-prodRequest',
     'a pending prod-bind shows as occ-prodRequest');
  ok(hiveStatus({ status: 'working' }, { seedPending: true, landPending: true }) === 'occ-landRequest',
     'a held landing still outranks a seed ask');

  // ── 5. REJECT settles it, running nothing ──
  const rejected = await decideProdSeed(asked.request.id, 'rejected', 'test@seed');
  ok(rejected.status === 'rejected' && rejected.result == null, 'reject settles the request without running anything');

  // ── 6. APPROVE runs it (simulate) ──
  const second = await requestProdSeed({ xellId, files: ['2026-07-28-lookups.sql'], reason: 'take two' });
  ok(second.ok === true, 'a fresh request can be filed once the first is decided');
  const seeded = await decideProdSeed(second.request.id, 'approved', 'test@seed');
  ok(seeded.status === 'seeded', `approving RUNS it → status ${seeded.status}`);
  ok(seeded.result?.applied?.length === 1 && seeded.result.applied[0].ok === true,
     'the per-file outcome is recorded on the row');
  ok(!!seeded.finished_at && seeded.decided_by === 'test@seed', 'who decided it and when it finished are recorded');

  // ── 7. the prior-run warning ──
  const prior = await priorRuns(PID, ['server/sql/seeds/2026-07-28-lookups.sql']);
  ok(prior.length === 1 && prior[0].by === 'test@seed',
     'a repeat of the same file surfaces its prior run (seeds are not ledgered — a repeat must be a decision)');

  // ── 8. a deploy in flight blocks the run ──
  await client.query(
    `INSERT INTO deploy_lock (project_id, xell_id, container, phase) VALUES ($1,$2,'prod','deploying')`,
    [PID, xellId]);
  const third = await requestProdSeed({ xellId, files: ['2026-07-28-lookups.sql'], reason: 'during a ship' });
  const blocked = await decideProdSeed(third.request.id, 'approved', 'test@seed');
  ok(blocked.status === 'failed' && /held by a deploy/.test(blocked.result?.error || ''),
     'an approved seed FAILS LOUDLY while a deploy holds production, rather than writing underneath it');
  await client.query(`DELETE FROM deploy_lock WHERE project_id=$1`, [PID]);

  // ── 8b. REAL mode against a target that cannot be PROVEN to be prod → refuse, don't guess ──
  // The one thing worse than a failed seed is a seed that ran somewhere else and reported success
  // (2026-07-23: a prod ship migrated a 7.7MB dev clone). With SEED_MODE=real and no reachable
  // docker/target, the run must end 'failed' with the refusal on the row — never 'seeded'.
  process.env.SEED_MODE = 'real';
  const real = await requestProdSeed({ xellId, files: ['2026-07-28-lookups.sql'], reason: 'for real' });
  const refused = await decideProdSeed(real.request.id, 'approved', 'test@seed');
  ok(refused.status === 'failed' && !!refused.result?.error,
     `a real run whose target cannot be PROVEN to be production refuses: "${(refused.result?.error || '').slice(0, 70)}…"`);
  process.env.SEED_MODE = 'simulate';

  // ── 9b. "is prod already running this code?" rides with the request ──
  // A seed usually follows a ship. The answer is reported, never enforced: a seed that precedes its
  // ship is legitimate, so this is a warning on the card, not a refusal.
  const { shipState } = await import('../server/src/queenzee/seedgate.js');
  const noShip = await shipState({ id: PID, repo_root: repo }, head);
  ok(noShip.shipped === null && noShip.contains === null, 'nothing shipped yet → "cannot tell", not a refusal');
  await client.query(
    `INSERT INTO ship_request (project_id, xell_id, commit, reason, targets, status, finished_at,
                               decided_at, decided_by)
       VALUES ($1,$2,$3,'code','{server}','shipped', now(), now(), 'test@seed')`, [PID, xellId, head]);
  const shipped = await shipState({ id: PID, repo_root: repo }, head);
  ok(shipped.contains === true, 'once the seed\'s commit is shipped, the card says prod is running it');

  // ── 10. THE CONSOLE SEES IT. The whole reason `zee prod` was a dead end for so long is that the
  // request existed only in the queenzee log: no hexagon status, no card, no panel. So assert the
  // read model a human actually looks at — the fleet payload — carries both asks. ──
  await client.query(
    `INSERT INTO prod_bind_request (project_id, xell_id, reason) VALUES ($1,$2,'need the live db')`,
    [PID, xellId]);
  const { getFleet } = await import('../server/src/lib/fleet.js');
  const fleet = await getFleet(PID);
  const card = (fleet.xells || []).find((x) => x.id === xellId);
  ok(!!card && card.hive_status === 'occ-prodRequest',
     `the asking xell's hexagon reads prod? (${card?.hive_status})`);
  ok((fleet.prod_bind || []).some((r) => r.xell_id === xellId && r.xell_slug === 'seedy'),
     'the fleet payload carries the pending prod-bind request for the console to render');
  ok((fleet.prod_seed || []).some((r) => r.status === 'seeded'),
     'and the just-finished seed receipt rides along (15-minute window, like a ship)');

  // and the receipt outlives the xell that asked (ON DELETE SET NULL, not CASCADE)
  await client.query(`DELETE FROM xell WHERE id=$1`, [xellId]);
  const survivor = await row(second.request.id);
  ok(!!survivor && survivor.xell_id === null && survivor.xell_slug === 'seedy',
     'the receipt of what ran on production survives the xell being reaped');

} finally {
  await cleanup({ files: true });
  await client.end();
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
